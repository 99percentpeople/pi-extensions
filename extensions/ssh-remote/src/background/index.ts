import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { RemoteAdapter, RemoteWorkspace } from "../adapters/types.ts";
import {
  UNIX_BACKGROUND_SIGNALS,
  UNIX_TERMINATING_SIGNALS,
  WINDOWS_BACKGROUND_SIGNALS,
  validateControlToken,
  type BackgroundSignal,
  type BackgroundTaskControl,
} from "./control.ts";
import {
  buildUnixBackgroundProbeCommand,
  buildUnixBackgroundShellCommand,
  buildUnixBackgroundSignalCommand,
} from "./unix.ts";
import {
  buildWindowsBackgroundProbeCommand,
  buildWindowsBackgroundShellCommand,
  buildWindowsBackgroundSignalCommand,
} from "./windows.ts";
import {
  buildOpenSshLaunch,
  controlErrorDetail,
  runControlProcess,
  runSignalControl,
  SshSignalControlError,
} from "./transport.ts";
import type {
  SpawnFunction,
  SshBackgroundLease,
  SshClientOptions,
} from "../transport/client.ts";

export type {
  BackgroundControlOptions,
  BackgroundSignal,
  BackgroundTaskControl,
  BackgroundTransportExitDisposition,
} from "./control.ts";
export {
  UNIX_BACKGROUND_SIGNALS,
  UNIX_TERMINATING_SIGNALS,
  WINDOWS_BACKGROUND_SIGNALS,
} from "./control.ts";
export {
  buildUnixBackgroundProbeCommand,
  buildUnixBackgroundShellCommand,
  buildUnixBackgroundSignalCommand,
} from "./unix.ts";
export {
  buildWindowsBackgroundProbeCommand,
  buildWindowsBackgroundShellCommand,
  buildWindowsBackgroundSignalCommand,
} from "./windows.ts";

export interface BackgroundShellLaunch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  initialStdin?: string;
  /** Adapter-owned lifecycle and signaling independent of the local ssh process. */
  control: BackgroundTaskControl;
  taskEnvironment?: string;
}

export interface BackgroundShellResolverContext {
  cwd: string;
  projectTrusted: boolean;
}

export type BackgroundShellResolver = (
  command: string,
  interactive: boolean,
  context?: BackgroundShellResolverContext,
) => BackgroundShellLaunch;

export interface SshBackgroundResolverOptions {
  ssh: SshClientOptions;
  adapter: RemoteAdapter;
  workspace: RemoteWorkspace;
  localCwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam for the short-lived SSH signal control process. */
  spawnControl?: SpawnFunction;
  /** Test seam for deterministic remote control paths. */
  createControlToken?: () => string;
  /** Keep the launch-time ControlMaster alive until this task settles. */
  acquireControlLease?: () => SshBackgroundLease | undefined;
}

/** Create a bg:register shell resolver backed by the system OpenSSH client. */
export function createSshBackgroundShellResolver(
  options: SshBackgroundResolverOptions,
): BackgroundShellResolver {
  return (command, interactive, context) => {
    const requestedCwd = context?.cwd ?? options.localCwd;
    const remoteCwd = options.adapter.mapCwd(
      requestedCwd,
      options.localCwd,
      options.workspace,
    );
    const token = validateControlToken(
      options.createControlToken?.() ?? randomBytes(16).toString("hex"),
    );
    const env = { ...(options.env ?? process.env) };
    const remoteCommand = options.adapter.platform === "windows"
      ? buildWindowsBackgroundShellCommand(
        command,
        remoteCwd,
        options.adapter.shell,
        token,
        interactive,
        env,
      )
      : buildUnixBackgroundShellCommand(
        options.adapter.buildShellCommand(
          command,
          remoteCwd,
          env,
          interactive,
        ),
        token,
      );

    // Native Windows OpenSSH requires -n for pipe launches to avoid its stdio
    // deadlock. The control advertises that stdin is unavailable so bg_send
    // does not report a misleading successful write; PTY launches keep stdin.
    const windowsClient = typeof options.ssh.executable === "string"
      && /(^|[\\/])ssh\.exe$/i.test(options.ssh.executable);
    const launch = buildOpenSshLaunch(
      options.ssh,
      remoteCommand,
      interactive,
      !interactive && windowsClient,
      env,
    );
    const spawnControl = options.spawnControl ?? spawn;
    const lease = options.acquireControlLease?.();
    const controlOptions: SshClientOptions[] = [];
    if (options.ssh.multiplex === true && options.ssh.controlPath) {
      controlOptions.push(options.ssh);
    }
    controlOptions.push({
      ...options.ssh,
      multiplex: false,
      controlPath: undefined,
      sshpassPassword: undefined,
    });

    let activeControlOperations = 0;
    let disposeRequested = false;
    let leaseReleased = false;
    const releaseLeaseIfIdle = async (): Promise<void> => {
      if (!disposeRequested || activeControlOperations > 0 || leaseReleased) return;
      leaseReleased = true;
      await lease?.release();
    };
    const withControlOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
      activeControlOperations += 1;
      try {
        return await operation();
      } finally {
        activeControlOperations = Math.max(0, activeControlOperations - 1);
        await releaseLeaseIfIdle();
      }
    };

    const runRemoteSignal = async (
      signal: BackgroundSignal,
      abortSignal?: AbortSignal,
    ): Promise<void> => withControlOperation(async () => {
      const controlCommand = options.adapter.platform === "windows"
        ? buildWindowsBackgroundSignalCommand(token, signal, options.adapter.shell)
        : buildUnixBackgroundSignalCommand(token, signal);
      for (let index = 0; index < controlOptions.length; index++) {
        const controlLaunch = buildOpenSshLaunch(
          controlOptions[index],
          controlCommand,
          false,
          true,
          env,
        );
        try {
          await runSignalControl(
            controlLaunch,
            signal,
            options.localCwd,
            spawnControl,
            options.ssh.connectTimeoutSeconds ?? 10,
            abortSignal,
          );
          return;
        } catch (error) {
          const canRetryDirect = index + 1 < controlOptions.length
            && error instanceof SshSignalControlError
            && error.exitCode === 255;
          if (!canRetryDirect) throw error;
        }
      }
    });

    const probeRemote = async (
      abortSignal?: AbortSignal,
    ): Promise<"running" | "finished" | "unknown"> => withControlOperation(async () => {
      const controlCommand = options.adapter.platform === "windows"
        ? buildWindowsBackgroundProbeCommand(token, options.adapter.shell)
        : buildUnixBackgroundProbeCommand(token);
      for (let index = 0; index < controlOptions.length; index++) {
        const controlLaunch = buildOpenSshLaunch(
          controlOptions[index],
          controlCommand,
          false,
          true,
          env,
        );
        const result = await runControlProcess(
          controlLaunch,
          "status",
          options.localCwd,
          spawnControl,
          options.ssh.connectTimeoutSeconds ?? 10,
          abortSignal,
        );
        if (result.exitCode === 0) {
          const status = result.stdout
            .split(/\r?\n/)
            .findLast((line) => line.startsWith("PI_SSH_BG_STATUS="))
            ?.slice("PI_SSH_BG_STATUS=".length);
          if (status === "running" || status === "finished") return status;
          throw new Error(
            `Remote background status returned an invalid response: ${JSON.stringify(result.stdout)}`,
          );
        }
        const detail = controlErrorDetail(result.exitCode, result.stderr);
        const error = new SshSignalControlError(
          `Remote background status failed (${result.exitCode ?? result.closeSignal ?? "unknown"})${detail ? `: ${detail}` : ""}`,
          result.exitCode,
        );
        const canRetryDirect = index + 1 < controlOptions.length
          && result.exitCode === 255;
        if (!canRetryDirect) throw error;
      }
      return "unknown";
    });

    const control: BackgroundTaskControl = {
      supportedSignals: options.adapter.platform === "windows"
        ? WINDOWS_BACKGROUND_SIGNALS
        : UNIX_BACKGROUND_SIGNALS,
      terminatingSignals: options.adapter.platform === "windows"
        ? WINDOWS_BACKGROUND_SIGNALS
        : UNIX_TERMINATING_SIGNALS,
      signalTarget: options.adapter.platform === "windows"
        ? "process tree"
        : "process group",
      stdinAvailable: !windowsClient || interactive,
      sendSignal: (signal, controlOptions) =>
        runRemoteSignal(signal, controlOptions?.abortSignal),
      probe: (controlOptions) => probeRemote(controlOptions?.abortSignal),
      onTransportExit: async (event, controlOptions) => {
        // OpenSSH propagates a remote command's normal exit code. Only a local
        // signal or ssh's reserved 255 transport failure needs reconciliation.
        if (event.signal === null && event.exitCode !== 255) {
          return { state: "finished" };
        }
        const abortSignal = controlOptions?.abortSignal;
        try {
          let state = await probeRemote(abortSignal);
          if (state === "finished") return { state: "finished" };

          try {
            await runRemoteSignal("SIGTERM", abortSignal);
          } catch (error) {
            state = await probeRemote(abortSignal);
            if (state !== "finished") throw error;
          }
          state = await probeRemote(abortSignal);
          if (state === "finished") {
            return { state: "stopped", signal: "SSH transport exit" };
          }

          await runRemoteSignal("SIGKILL", abortSignal);
          state = await probeRemote(abortSignal);
          return state === "finished"
            ? { state: "stopped", signal: "SSH transport exit" }
            : {
                state: "disconnected",
                error: "SSH transport exited while the remote process still reports running",
              };
        } catch (error) {
          return {
            state: "disconnected",
            error: `SSH transport exited and remote cleanup could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
      dispose: async () => {
        disposeRequested = true;
        await releaseLeaseIfIdle();
      },
    };

    return {
      ...launch,
      control,
      // Background Tasks honors this launch cwd. It keeps the local
      // OpenSSH process out of a remote-only path while the command itself
      // changes to the mapped remote directory.
      cwd: options.localCwd,
      // Captured immutably by background-tasks so later host/cwd switches do
      // not make an existing task look as if it moved with the Pi workspace.
      taskEnvironment: `SSH ${options.ssh.target}:${remoteCwd}`,
    };
  };
}
