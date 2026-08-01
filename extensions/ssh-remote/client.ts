import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
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

export function buildSshArguments(
  options: SshClientOptions,
  allocatePty = false,
): string[] {
  if (!options.target || options.target.startsWith("-") || /[\s\0\r\n]/.test(options.target)) {
    throw new Error(`Invalid SSH target: ${JSON.stringify(options.target)}`);
  }
  const connectTimeout = options.connectTimeoutSeconds ?? 10;
  if (!Number.isInteger(connectTimeout) || connectTimeout < 1 || connectTimeout > 600) {
    throw new Error("SSH connect timeout must be an integer from 1 to 600 seconds");
  }

  const args: string[] = [];
  if (options.configFile) args.push("-F", options.configFile);
  args.push(
    "-o",
    `BatchMode=${options.batchMode === false ? "no" : "yes"}`,
    "-o",
    `ConnectTimeout=${connectTimeout}`,
    allocatePty ? "-tt" : "-T",
    options.target,
  );
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

  async run(command: string, options: SshRunOptions = {}): Promise<SshRunResult> {
    if (this.disposed) throw new Error("SSH client is closed");
    if (options.signal?.aborted) throw new Error("aborted");

    const executable = this.options.executable ?? "ssh";
    const args = [...buildSshArguments(this.options), command];
    const hasInput = options.input !== undefined;
    const child = this.spawnFn(executable, args, {
      env: process.env,
      stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.children.add(child);

    return new Promise<SshRunResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let forceKillHandle: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let settled = false;
      let terminationRequested = false;

      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (forceKillHandle) clearTimeout(forceKillHandle);
        options.signal?.removeEventListener("abort", onAbort);
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
        if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
          onAbort();
          finishReject(new Error("SSH timeout must be a positive number of seconds"));
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

      if (hasInput) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(options.input);
      }
    });
  }

  async runChecked(command: string, options?: SshRunOptions): Promise<SshRunResult> {
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
