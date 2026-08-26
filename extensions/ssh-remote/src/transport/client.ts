import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SshCompletionFrameFilter,
  type SshRunCompletion,
} from "./completion.ts";

export type SshTransportPreference = "auto" | "openssh" | "ssh2";
export type SshTransportKind = Exclude<SshTransportPreference, "auto">;

export interface SshClientOptions {
  target: string;
  /** Explicit destination port parsed from the unified SSH target syntax. */
  port?: number;
  configFile?: string;
  executable?: string;
  connectTimeoutSeconds?: number;
  batchMode?: boolean;
  /** Internal OpenSSH policy. true manages a ControlMaster; false forces one connection per process. */
  multiplex?: boolean;
  /** Internal ControlMaster socket path shared with background OpenSSH launches. */
  controlPath?: string;
  /**
   * Internal: run ssh through `sshpass -e` with this password so hosts
   * that require password auth work non-interactively. The sshpass PTY is
   * raw and `-T` keeps the remote side PTY-free, so binary stdin/stdout
   * round-trips intact. Never set from user configuration.
   */
  sshpassPassword?: string;
}

export interface SshRunOptions {
  input?: string | Buffer;
  signal?: AbortSignal;
  timeoutSeconds?: number;
  /** Keep stdout/stderr in the returned result. Disable for long streaming commands. */
  captureOutput?: boolean;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
  /** Internal remote-command completion frame used to bound inherited-stdio hangs. */
  completion?: SshRunCompletion;
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

export interface SshDisposeOptions {
  /** Keep already-running multiplexed background channels alive while stopping new reuse. */
  preserveBackgroundSessions?: boolean;
}

export interface SshBackgroundLease {
  release(): void | Promise<void>;
}

export type SshDisconnectListener = (error: Error) => void;

export interface SshRemoteClient extends SshExecutor {
  readonly options: Readonly<SshClientOptions>;
  /** Effective foreground transport. Optional for third-party/test implementations. */
  readonly transport?: SshTransportKind;
  /** Whether foreground commands share one authenticated SSH transport. */
  readonly reusesConnection?: boolean;
  /** Set when auto mode had to switch away from its preferred transport. */
  readonly fallbackReason?: string;
  /** Non-fatal OpenSSH options or identities that ssh2 could not reproduce. */
  readonly compatibilityWarnings?: readonly string[];
  /** Listen for an established persistent transport closing unexpectedly. */
  onDisconnect?(listener: SshDisconnectListener): () => void;
  /** Keep a managed ControlMaster available until one background task finishes. */
  acquireBackgroundLease?(): SshBackgroundLease | undefined;
  dispose(options?: SshDisposeOptions): void | Promise<void>;
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
  return typeof executable === "string" && /(^|[\\/])ssh\.exe$/i.test(executable);
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

/**
 * Parse and validate an SSH destination port (parsed from the unified
 * target syntax). Returns undefined for unset/empty values.
 */
export function parseSshPort(
  value: unknown,
  description = "SSH port",
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = typeof value === "string" ? value.trim() : String(value);
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${description} must be an integer from 1 to 65535`);
  }
  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${description} must be an integer from 1 to 65535`);
  }
  return port;
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

  const port = parseSshPort(options.port);

  const args: string[] = [];
  if (options.configFile) args.push("-F", options.configFile);
  if (port !== undefined) args.push("-p", String(port));
  if (options.multiplex === true) {
    if (!options.controlPath) {
      throw new Error("OpenSSH multiplexing requires a control path");
    }
    args.push(
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPersist=10m",
      "-S",
      options.controlPath,
    );
  } else if (options.multiplex === false) {
    // Native Windows OpenSSH does not support ControlMaster. Command-line
    // values also prevent an incompatible setting inherited from ssh_config.
    args.push("-o", "ControlMaster=no", "-o", "ControlPath=none");
  }
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

function buildSshControlChannelArguments(
  options: SshClientOptions,
  allocatePty: boolean,
  redirectStdin: boolean,
): string[] {
  if (options.multiplex !== true || !options.controlPath) {
    throw new Error("OpenSSH control channel requires a managed control path");
  }
  const args = buildSshArguments(
    { ...options, multiplex: undefined },
    allocatePty,
    redirectStdin,
  );
  const target = args.pop()!;
  args.push(
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPersist=no",
    "-S",
    options.controlPath,
    target,
  );
  return args;
}

export function buildSshControlMasterArguments(
  options: SshClientOptions,
): string[] {
  if (options.multiplex !== true || !options.controlPath) {
    throw new Error("OpenSSH ControlMaster requires a managed control path");
  }
  const args = buildSshArguments(
    { ...options, multiplex: undefined },
    false,
    true,
  );
  const target = args.pop()!;
  // `-M` alone already enables ControlMaster=yes. Passing both `-M` and
  // `-o ControlMaster=yes` makes OpenSSH treat them like repeated `-M`
  // flags, which requires interactive confirmation for every mux session.
  // Without an askpass helper that permission is denied, each command falls
  // back to a direct connection, and stderr gains the misleading
  // `Master refused session request: Permission denied` line.
  args.push(
    "-o",
    "ControlPersist=no",
    "-S",
    options.controlPath,
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=3",
    "-M",
    "-N",
    target,
  );
  return args;
}

export class OpenSshClient implements SshRemoteClient {
  readonly options: Readonly<SshClientOptions>;
  readonly transport = "openssh" as const;
  readonly reusesConnection: boolean;
  private readonly spawnFn: SpawnFunction;
  private readonly children = new Set<ChildProcess>();
  private readonly controlDirectory?: string;
  private readonly disconnectListeners = new Set<SshDisconnectListener>();
  private controlMaster?: ChildProcess;
  private controlMasterPromise?: Promise<void>;
  private controlMasterReady = false;
  private controlClosing = false;
  private backgroundLeaseCount = 0;
  private pendingControlClose: "stop" | "exit" | undefined;
  private controlClosePromise: Promise<void> | undefined;
  private controlClosed = false;
  private disposed = false;

  constructor(options: SshClientOptions, spawnFn: SpawnFunction = spawn) {
    let controlDirectory: string | undefined;
    let controlPath = options.controlPath;
    if (options.multiplex === true && !controlPath) {
      controlDirectory = mkdtempSync(join(tmpdir(), "pi-ssh-control-"));
      controlPath = join(controlDirectory, "mux");
    }
    this.options = { ...options, controlPath };
    this.reusesConnection = options.multiplex === true;
    this.controlDirectory = controlDirectory;
    this.spawnFn = spawnFn;
  }

  onDisconnect(listener: SshDisconnectListener): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private notifyDisconnect(error: Error): void {
    for (const listener of [...this.disconnectListeners]) {
      try {
        listener(error);
      } catch {
        // One consumer must not prevent other connection observers.
      }
    }
  }

  private ensureControlMaster(): Promise<void> {
    if (this.options.multiplex !== true) return Promise.resolve();
    if (this.controlMasterReady && this.controlMaster) return Promise.resolve();
    if (this.controlMasterPromise) return this.controlMasterPromise;
    if (this.disposed || this.controlClosed) {
      return Promise.reject(new Error("SSH client is closed"));
    }

    const pending = this.startControlMaster();
    const tracked = pending.finally(() => {
      if (this.controlMasterPromise === tracked) {
        this.controlMasterPromise = undefined;
      }
    });
    void tracked.catch(() => {});
    this.controlMasterPromise = tracked;
    return tracked;
  }

  private startControlMaster(): Promise<void> {
    const sshProgram = this.options.executable ?? "ssh";
    const sshpassMode = !!this.options.sshpassPassword;
    const effectiveOptions = sshpassMode
      ? { ...this.options, batchMode: false }
      : this.options;
    const executable = sshpassMode ? "sshpass" : sshProgram;
    const args = [
      ...(sshpassMode
        ? ["-e", sshProgram, "-o", "NumberOfPasswordPrompts=1"]
        : []),
      ...buildSshControlMasterArguments(effectiveOptions),
    ];
    const env = sshpassMode
      ? { ...process.env, SSHPASS: this.options.sshpassPassword }
      : process.env;
    const controlPath = this.options.controlPath!;

    return new Promise<void>((resolve, reject) => {
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      let child: ChildProcess | undefined;
      let watcher: FSWatcher | undefined;
      let setupTimeout: ReturnType<typeof setTimeout> | undefined;
      let setupSettled = false;
      let ready = false;
      let disconnectEmitted = false;

      const detail = (): string => Buffer.concat(stderr).toString("utf8").trim();
      const cleanupSetup = () => {
        if (setupTimeout) clearTimeout(setupTimeout);
        setupTimeout = undefined;
        try {
          watcher?.close();
        } catch {}
        watcher = undefined;
      };
      const rejectSetup = (error: Error) => {
        if (setupSettled) return;
        setupSettled = true;
        cleanupSetup();
        if (child && this.controlMaster === child) {
          this.controlMaster = undefined;
          this.controlMasterReady = false;
        }
        reject(error);
      };
      const resolveSetup = () => {
        if (setupSettled || !child) return;
        setupSettled = true;
        ready = true;
        this.controlMasterReady = true;
        cleanupSetup();
        resolve();
      };
      const inspectControlPath = () => {
        if (existsSync(controlPath)) resolveSetup();
      };
      const emitDisconnect = (error: Error) => {
        if (disconnectEmitted || this.disposed || this.controlClosing) return;
        disconnectEmitted = true;
        this.notifyDisconnect(error);
      };

      try {
        watcher = watch(dirname(controlPath), inspectControlPath);
        watcher.once("error", (error) => {
          if (!ready) rejectSetup(error);
        });
        child = this.spawnFn(executable, args, {
          env,
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        });
        this.controlMaster = child;
        this.controlMasterReady = false;
      } catch (error) {
        rejectSetup(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      child.stderr?.on("data", (chunk: Buffer | string) => {
        if (stderrBytes >= 4_000) return;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const retained = data.subarray(0, 4_000 - stderrBytes);
        if (retained.length > 0) stderr.push(retained);
        stderrBytes += retained.length;
      });
      child.once("error", (error) => {
        if (!ready) {
          rejectSetup(error);
          return;
        }
        emitDisconnect(error);
      });
      child.once("close", (code, signal) => {
        if (this.controlMaster === child) {
          this.controlMaster = undefined;
          this.controlMasterReady = false;
        }
        const suffix = detail();
        const error = new Error(
          `OpenSSH ControlMaster closed (${code ?? signal ?? "unknown"})${suffix ? `: ${suffix}` : ""}`,
        );
        if (!ready) {
          rejectSetup(error);
          return;
        }
        emitDisconnect(error);
      });

      const timeoutMs = (this.options.connectTimeoutSeconds ?? 10) * 1_000 + 5_000;
      setupTimeout = setTimeout(() => {
        rejectSetup(new Error(
          `OpenSSH ControlMaster setup timed out after ${Math.ceil(timeoutMs / 1_000)} seconds`,
        ));
        try {
          child?.kill("SIGKILL");
        } catch {}
      }, timeoutMs);
      setupTimeout.unref?.();
      inspectControlPath();
    });
  }

  acquireBackgroundLease(): SshBackgroundLease | undefined {
    if (
      this.disposed
      || this.options.multiplex !== true
      || !this.options.controlPath
      || this.controlClosed
    ) {
      return undefined;
    }
    this.backgroundLeaseCount += 1;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.backgroundLeaseCount = Math.max(0, this.backgroundLeaseCount - 1);
        if (this.backgroundLeaseCount === 0 && this.pendingControlClose) {
          await this.closeControl(this.pendingControlClose);
        }
      },
    };
  }

  async run(
    command: string,
    options: SshRunOptions = {},
  ): Promise<SshRunResult> {
    if (this.disposed) throw new Error("SSH client is closed");
    if (options.signal?.aborted) throw new Error("aborted");
    if (
      options.timeoutSeconds !== undefined
      && (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0)
    ) {
      throw new Error("SSH timeout must be a positive number of seconds");
    }
    const completionFilter = options.completion
      ? new SshCompletionFrameFilter(options.completion)
      : undefined;

    if (this.options.multiplex === true) {
      await this.ensureControlMaster();
      if (this.disposed) throw new Error("SSH client is closed");
      if (options.signal?.aborted) throw new Error("aborted");
    }

    const sshProgram = this.options.executable ?? "ssh";
    const hasInput = options.input !== undefined;
    const windowsClient = isWindowsSshExecutable(this.options.executable);
    // Password authentication is needed only while establishing a dedicated
    // ControlMaster. Multiplexed command channels reuse that authenticated
    // transport and therefore invoke plain OpenSSH in BatchMode.
    const sshpassMode = this.options.multiplex !== true
      && !!this.options.sshpassPassword;
    const effectiveOptions = sshpassMode
      ? { ...this.options, batchMode: false }
      : this.options;
    const executable = sshpassMode ? "sshpass" : sshProgram;
    const sshArguments = this.options.multiplex === true
      ? buildSshControlChannelArguments(
          this.options,
          false,
          windowsClient && !hasInput,
        )
      : buildSshArguments(
          effectiveOptions,
          false,
          windowsClient && !hasInput,
        );
    const args = [
      ...(sshpassMode
        ? ["-e", sshProgram, "-o", "NumberOfPasswordPrompts=1"]
        : []),
      ...sshArguments,
      command,
    ];
    const env = sshpassMode
      ? { ...process.env, SSHPASS: this.options.sshpassPassword }
      : process.env;
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
    const cleanupStdioFiles = () => {
      for (const fd of [stdinFd, stdoutFd, stderrFd]) {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {}
        }
      }
      stdinFd = undefined;
      stdoutFd = undefined;
      stderrFd = undefined;
      for (const file of [stdinTempFile, stdoutTempFile, stderrTempFile]) {
        if (file !== undefined) {
          try {
            rmSync(file, { force: true });
          } catch {}
        }
      }
      stdinTempFile = undefined;
      stdoutTempFile = undefined;
      stderrTempFile = undefined;
    };
    try {
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
    } catch (error) {
      cleanupStdioFiles();
      throw error;
    }
    let child: ChildProcess;
    try {
      child = this.spawnFn(executable, args, {
        env,
        stdio: windowsClient
          ? [stdinFd ?? "ignore", stdoutFd!, stderrFd!]
          : ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      cleanupStdioFiles();
      throw error;
    }
    this.children.add(child);

    return new Promise<SshRunResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const offsets = { out: 0, err: 0 };
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let forceKillHandle: ReturnType<typeof setTimeout> | undefined;
      let completionHandle: ReturnType<typeof setTimeout> | undefined;
      let pollHandle: ReturnType<typeof setInterval> | undefined;
      let timedOut = false;
      let settled = false;
      let terminationRequested = false;
      let completionMatched = false;
      let completionExitCode: number | null = null;

      const emitStdout = (data: Buffer): void => {
        if (data.length === 0) return;
        if (options.captureOutput !== false) stdout.push(data);
        options.onStdout?.(data);
      };
      const emitStderr = (data: Buffer): void => {
        if (data.length === 0) return;
        if (options.captureOutput !== false) stderr.push(data);
        options.onStderr?.(data);
      };
      const processStderr = (data: Buffer): void => {
        if (!completionFilter) {
          emitStderr(data);
          return;
        }
        const filtered = completionFilter.push(data);
        emitStderr(filtered.data);
        if (filtered.completion) {
          requestCompletion(filtered.completion.exitCode);
        }
      };
      const flushCompletion = (discardPartialFrame = false): void => {
        if (completionFilter) {
          emitStderr(completionFilter.flush(discardPartialFrame));
        }
      };

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
            emitStdout(data);
          }
        }
        if (stderrFd !== undefined) {
          const { data, next } = readTemp(stderrFd, offsets.err);
          offsets.err = next;
          if (data.length > 0) {
            processStderr(data);
          }
        }
      };

      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (forceKillHandle) clearTimeout(forceKillHandle);
        if (completionHandle) clearTimeout(completionHandle);
        if (pollHandle) clearInterval(pollHandle);
        options.signal?.removeEventListener("abort", onAbort);
        cleanupStdioFiles();
        this.children.delete(child);
      };
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        flushCompletion(true);
        cleanup();
        reject(error);
      };
      const finishResolve = (exitCode: number | null) => {
        if (settled) return;
        if (windowsClient) drainTemp();
        flushCompletion();
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
      };
      const hardKill = () => {
        try {
          child.kill("SIGKILL");
        } catch {}
        if (process.platform === "win32" && child.pid) {
          try {
            const killer = spawn(
              "taskkill",
              ["/PID", String(child.pid), "/T", "/F"],
              { stdio: "ignore", windowsHide: true },
            );
            killer.unref();
          } catch {}
        }
      };
      function requestCompletion(exitCode: number | null): void {
        if (settled || completionMatched || !options.completion) return;
        completionMatched = true;
        completionExitCode = exitCode;
        completionHandle = setTimeout(() => {
          if (settled || options.signal?.aborted || timedOut) return;
          terminationRequested = true;
          try {
            child.kill("SIGTERM");
          } catch {}
          forceKillHandle = setTimeout(() => {
            hardKill();
            finishResolve(completionExitCode);
          }, 1_000);
          forceKillHandle.unref?.();
        }, options.completion.graceMs);
        completionHandle.unref?.();
      }
      const onAbort = () => {
        if (terminationRequested) return;
        terminationRequested = true;
        try {
          child.kill("SIGTERM");
        } catch {}
        forceKillHandle = setTimeout(() => {
          hardKill();
          finishReject(
            options.signal?.aborted
              ? new Error("aborted")
              : timedOut
                ? new Error(`timeout:${options.timeoutSeconds}`)
                : new Error("SSH command cancellation did not close the process"),
          );
        }, 1_000);
        forceKillHandle.unref?.();
      };

      if (windowsClient) {
        pollHandle = setInterval(drainTemp, 120);
        pollHandle.unref?.();
      }

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        emitStdout(data);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        processStderr(data);
      });

      child.once("error", (error) => finishReject(error));
      child.once("close", (exitCode) => {
        finishResolve(
          completionMatched ? completionExitCode ?? exitCode : exitCode,
        );
      });

      if (options.timeoutSeconds !== undefined) {
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

  private closeControl(mode: "stop" | "exit"): Promise<void> {
    if (this.controlClosed) return Promise.resolve();
    if (this.controlClosePromise) return this.controlClosePromise;

    const pending = (async () => {
      this.controlClosing = true;
      const controlPath = this.options.controlPath;
      if (
        this.options.multiplex === true
        && controlPath
        && this.controlMaster
        && this.controlMasterReady
      ) {
        const executable = this.options.executable ?? "ssh";
        const port = parseSshPort(this.options.port);
        const args: string[] = [];
        if (this.options.configFile) args.push("-F", this.options.configFile);
        if (port !== undefined) args.push("-p", String(port));
        args.push(
          "-o",
          `BatchMode=${this.options.batchMode === false ? "no" : "yes"}`,
          "-S",
          controlPath,
          "-O",
          mode,
          this.options.target,
        );
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          try {
            const child = this.spawnFn(executable, args, {
              env: process.env,
              stdio: "ignore",
              windowsHide: true,
            });
            const timeout = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {}
              finish();
            }, 1_500);
            timeout.unref?.();
            child.once("error", () => {
              clearTimeout(timeout);
              finish();
            });
            child.once("close", () => {
              clearTimeout(timeout);
              finish();
            });
          } catch {
            finish();
          }
        });
      }

      const master = this.controlMaster;
      this.controlMaster = undefined;
      this.controlMasterReady = false;
      if (master) {
        try {
          master.kill("SIGTERM");
        } catch {}
      }

      if (this.controlDirectory) {
        try {
          rmSync(this.controlDirectory, { recursive: true, force: true });
        } catch {}
      }
      this.controlClosed = true;
      this.pendingControlClose = undefined;
    })();
    const tracked = pending.finally(() => {
      if (this.controlClosePromise === tracked) this.controlClosePromise = undefined;
    });
    this.controlClosePromise = tracked;
    return tracked;
  }

  async dispose(options: SshDisposeOptions = {}): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnectListeners.clear();
    for (const child of this.children) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    this.children.clear();

    const requestedMode = options.preserveBackgroundSessions ? "stop" : "exit";
    this.pendingControlClose = this.pendingControlClose === "exit"
      || requestedMode === "exit"
      ? "exit"
      : "stop";
    if (this.backgroundLeaseCount > 0) return;
    await this.closeControl(this.pendingControlClose);
  }
}
