import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SshClientOptions {
  target: string;
  configFile?: string;
  executable?: string;
  connectTimeoutSeconds?: number;
  batchMode?: boolean;
}

export interface SshRunOptions {
  input?: string | Buffer;
  signal?: AbortSignal;
  timeoutSeconds?: number;
  /** Keep stdout/stderr in the returned result. Disable for long streaming commands. */
  captureOutput?: boolean;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
}

export interface SshRunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

export interface SshExecutor {
  run(command: string, options?: SshRunOptions): Promise<SshRunResult>;
  runChecked(command: string, options?: SshRunOptions): Promise<SshRunResult>;
}

export interface SshRemoteClient extends SshExecutor {
  readonly options: Readonly<SshClientOptions>;
  dispose(): void;
}

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

function boundedErrorText(buffer: Buffer): string {
  const text = buffer.toString("utf8").trim();
  if (text.length <= 4_000) return text;
  return `${text.slice(0, 4_000)}…`;
}

/**
 * Windows OpenSSH's ssh.exe can wedge after the remote command finishes when
 * it is spawned with piped stdio (the client never exits, or blocks relaying
 * output). Two workarounds are applied for the Windows client:
 * - commands without stdin input add `-n`, redirecting stdin from NUL (the
 *   remote side still sees an immediate EOF, matching the closed-pipe
 *   behavior used elsewhere);
 * - commands with stdin input (file writes) get their content from a local
 *   temp file handle instead of an anonymous pipe.
 */
function isWindowsSshExecutable(executable: string | undefined): boolean {
  return executable === "ssh.exe";
}

let stdinTempCounter = 0;

function createStdinTempFile(content: string | Buffer): {
  fd: number;
  path: string;
} {
  const path = join(
    tmpdir(),
    `pi-ssh-stdin-${process.pid}-${stdinTempCounter++}.tmp`,
  );
  writeFileSync(path, content);
  return { fd: openSync(path, "r"), path };
}

function createTempFile(): { fd: number; path: string } {
  const path = join(
    tmpdir(),
    `pi-ssh-stdio-${process.pid}-${stdinTempCounter++}.tmp`,
  );
  return { fd: openSync(path, "w+"), path };
}

export function buildSshArguments(
  options: SshClientOptions,
  allocatePty = false,
  redirectStdin = false,
): string[] {
  if (
    !options.target ||
    options.target.startsWith("-") ||
    /[\s\0\r\n]/.test(options.target)
  ) {
    throw new Error(`Invalid SSH target: ${JSON.stringify(options.target)}`);
  }
  const connectTimeout = options.connectTimeoutSeconds ?? 10;
  if (
    !Number.isInteger(connectTimeout) ||
    connectTimeout < 1 ||
    connectTimeout > 600
  ) {
    throw new Error(
      "SSH connect timeout must be an integer from 1 to 600 seconds",
    );
  }

  const args: string[] = [];
  if (options.configFile) args.push("-F", options.configFile);
  args.push(
    "-o",
    `BatchMode=${options.batchMode === false ? "no" : "yes"}`,
    "-o",
    `ConnectTimeout=${connectTimeout}`,
    allocatePty ? "-tt" : "-T",
  );
  if (redirectStdin) args.push("-n");
  args.push(options.target);
  return args;
}

export class OpenSshClient implements SshRemoteClient {
  readonly options: Readonly<SshClientOptions>;
  private readonly spawnFn: SpawnFunction;
  private readonly children = new Set<ChildProcess>();
  private disposed = false;

  constructor(options: SshClientOptions, spawnFn: SpawnFunction = spawn) {
    this.options = { ...options };
    this.spawnFn = spawnFn;
  }

  async run(
    command: string,
    options: SshRunOptions = {},
  ): Promise<SshRunResult> {
    if (this.disposed) throw new Error("SSH client is closed");
    if (options.signal?.aborted) throw new Error("aborted");

    const executable = this.options.executable ?? "ssh";
    const hasInput = options.input !== undefined;
    const windowsClient = isWindowsSshExecutable(this.options.executable);
    const args = [
      ...buildSshArguments(
        this.options,
        false,
        windowsClient && !hasInput,
      ),
      command,
    ];
    // Windows OpenSSH's ssh.exe can wedge when spawned with anonymous pipes:
    // the client stops exiting once the remote command produces output, and
    // piped stdin can hang it entirely. For the Windows client, drive stdio
    // through local temp files instead: stdin from a file handle (or -n when
    // there is no input), stdout/stderr into files that are polled for
    // streaming and drained on completion. The remote side still sees normal
    // pipes and an immediate stdin EOF, matching the Linux client behavior.
    let stdinFd: number | undefined;
    let stdinTempFile: string | undefined;
    let stdoutFd: number | undefined;
    let stdoutTempFile: string | undefined;
    let stderrFd: number | undefined;
    let stderrTempFile: string | undefined;
    if (windowsClient) {
      if (options.input !== undefined) {
        const temp = createStdinTempFile(options.input);
        stdinFd = temp.fd;
        stdinTempFile = temp.path;
      }
      const out = createTempFile();
      stdoutFd = out.fd;
      stdoutTempFile = out.path;
      const err = createTempFile();
      stderrFd = err.fd;
      stderrTempFile = err.path;
    }
    const child = this.spawnFn(executable, args, {
      env: process.env,
      stdio: windowsClient
        ? [stdinFd ?? "ignore", stdoutFd!, stderrFd!]
        : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.children.add(child);

    return new Promise<SshRunResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const offsets = { out: 0, err: 0 };
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let forceKillHandle: ReturnType<typeof setTimeout> | undefined;
      let pollHandle: ReturnType<typeof setInterval> | undefined;
      let timedOut = false;
      let settled = false;
      let terminationRequested = false;

      const readTemp = (
        fd: number,
        offset: number,
      ): { data: Buffer; next: number } => {
        try {
          const size = fstatSync(fd).size;
          if (size <= offset) return { data: Buffer.alloc(0), next: offset };
          const data = Buffer.allocUnsafe(size - offset);
          readSync(fd, data, 0, data.length, offset);
          return { data, next: size };
        } catch {
          return { data: Buffer.alloc(0), next: offset };
        }
      };
      const drainTemp = () => {
        if (stdoutFd !== undefined) {
          const { data, next } = readTemp(stdoutFd, offsets.out);
          offsets.out = next;
          if (data.length > 0) {
            if (options.captureOutput !== false) stdout.push(data);
            options.onStdout?.(data);
          }
        }
        if (stderrFd !== undefined) {
          const { data, next } = readTemp(stderrFd, offsets.err);
          offsets.err = next;
          if (data.length > 0) {
            if (options.captureOutput !== false) stderr.push(data);
            options.onStderr?.(data);
          }
        }
      };

      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (forceKillHandle) clearTimeout(forceKillHandle);
        if (pollHandle) clearInterval(pollHandle);
        options.signal?.removeEventListener("abort", onAbort);
        for (const fd of [stdinFd, stdoutFd, stderrFd]) {
          if (fd !== undefined) {
            try {
              closeSync(fd);
            } catch {}
          }
        }
        for (const file of [stdinTempFile, stdoutTempFile, stderrTempFile]) {
          if (file !== undefined) {
            try {
              rmSync(file, { force: true });
            } catch {}
          }
        }
        this.children.delete(child);
      };
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        if (terminationRequested) return;
        terminationRequested = true;
        try {
          child.kill("SIGTERM");
        } catch {}
        forceKillHandle = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 1_000);
        forceKillHandle.unref?.();
      };

      if (windowsClient) {
        pollHandle = setInterval(drainTemp, 120);
        pollHandle.unref?.();
      }

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (options.captureOutput !== false) stdout.push(data);
        options.onStdout?.(data);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (options.captureOutput !== false) stderr.push(data);
        options.onStderr?.(data);
      });

      child.once("error", (error) => finishReject(error));
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        if (windowsClient) drainTemp();
        cleanup();
        if (options.signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        if (timedOut) {
          reject(new Error(`timeout:${options.timeoutSeconds}`));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode,
        });
      });

      if (options.timeoutSeconds !== undefined) {
        if (
          !Number.isFinite(options.timeoutSeconds) ||
          options.timeoutSeconds <= 0
        ) {
          onAbort();
          finishReject(
            new Error("SSH timeout must be a positive number of seconds"),
          );
          return;
        }
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          onAbort();
        }, options.timeoutSeconds * 1_000);
      }

      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (options.signal?.aborted) onAbort();

      child.stdin?.on("error", () => {});
      child.stdin?.end(hasInput ? options.input : undefined);
    });
  }

  async runChecked(
    command: string,
    options?: SshRunOptions,
  ): Promise<SshRunResult> {
    const result = await this.run(command, options);
    if (result.exitCode === 0) return result;
    const detail = boundedErrorText(result.stderr);
    throw new Error(
      `SSH command failed (${result.exitCode ?? "signal"})${detail ? `: ${detail}` : ""}`,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of this.children) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    this.children.clear();
  }
}
