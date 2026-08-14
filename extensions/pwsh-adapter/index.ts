import {
  createBashToolDefinition,
  type ExtensionAPI,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import {
  type ChildProcess,
  spawn,
  spawnSync,
} from "node:child_process";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";

const UTF8_PRELUDE = `
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
`;

const PWSH_EXECUTABLE = "pwsh.exe";
const WINDOWS_POWERSHELL_EXECUTABLE = "powershell.exe";
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const EXIT_CLOSE_GRACE_MS = 100;
const TASKKILL_TIMEOUT_MS = 1_000;
const POST_KILL_GRACE_MS = 100;

export interface PowerShellRuntime {
  file: string;
  kind: "powershell-7" | "windows-powershell";
  version: string;
  label: string;
}

type PowerShellProbe = (file: string) => string | null;

function parseVersion(version: string): [major: number, minor: number] | null {
  const match = /^(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0)];
}

function isAtLeast(version: string, major: number, minor = 0): boolean {
  const parsed = parseVersion(version);
  return !!parsed && (parsed[0] > major || (parsed[0] === major && parsed[1] >= minor));
}

function probePowerShell(file: string): string | null {
  const result = spawnSync(
    file,
    [
      "-NoProfile",
      "-NonInteractive",
      "-NoLogo",
      "-Command",
      "[Console]::Out.Write($PSVersionTable.PSVersion.ToString())",
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) return null;
  const version = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return parseVersion(version) ? version : null;
}

export function selectPowerShellRuntime(
  probe: PowerShellProbe = probePowerShell,
): PowerShellRuntime {
  const pwshVersion = probe(PWSH_EXECUTABLE);
  if (pwshVersion && isAtLeast(pwshVersion, 7)) {
    return {
      file: PWSH_EXECUTABLE,
      kind: "powershell-7",
      version: pwshVersion,
      label: `PowerShell ${pwshVersion}`,
    };
  }

  const windowsPowerShellVersion = probe(WINDOWS_POWERSHELL_EXECUTABLE);
  if (windowsPowerShellVersion && isAtLeast(windowsPowerShellVersion, 5, 1)) {
    return {
      file: WINDOWS_POWERSHELL_EXECUTABLE,
      kind: "windows-powershell",
      version: windowsPowerShellVersion,
      label: `Windows PowerShell ${windowsPowerShellVersion}`,
    };
  }

  const detected = [
    pwshVersion && `${PWSH_EXECUTABLE} ${pwshVersion}`,
    windowsPowerShellVersion && `${WINDOWS_POWERSHELL_EXECUTABLE} ${windowsPowerShellVersion}`,
  ].filter(Boolean);
  throw new Error(
    "No supported PowerShell runtime was found. Install PowerShell 7 or enable Windows PowerShell 5.1." +
      (detected.length ? ` Detected: ${detected.join(", ")}.` : ""),
  );
}

function resolveTimeoutMs(timeout?: number): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}

function workingDirectoryError(cwd: string): Error {
  return new Error(
    `Working directory does not exist: ${cwd}\nCannot execute PowerShell commands.`,
  );
}

async function assertWorkingDirectory(cwd: string): Promise<void> {
  try {
    await fsAccess(cwd, constants.F_OK);
  } catch {
    throw workingDirectoryError(cwd);
  }
}

type SpawnProcess = typeof spawn;
type KillProcess = (
  pid: number,
  signal?: NodeJS.Signals | number,
) => boolean;

export interface PowerShellProcessOptions {
  spawn?: SpawnProcess;
  kill?: KillProcess;
  exitCloseGraceMs?: number;
  taskkillTimeoutMs?: number;
  postKillGraceMs?: number;
}

function waitForTaskkill(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      // Keep the once(error) listener installed after a timeout so a late spawn
      // error cannot become an unhandled EventEmitter error.
    };

    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(success);
    };

    const onError = () => finish(false);
    const onExit = (code: number | null) => finish(code === 0);
    const onClose = (code: number | null) => finish(code === 0);

    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    timeoutHandle = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false);
    }, timeoutMs);
  });
}

async function terminateProcessTree(
  pid: number | undefined,
  spawnProcess: SpawnProcess,
  killProcess: KillProcess,
  taskkillTimeoutMs: number,
): Promise<void> {
  if (!pid) return;

  let treeKilled = false;
  try {
    const taskkill = spawnProcess(
      "taskkill",
      ["/F", "/T", "/PID", String(pid)],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    treeKilled = await waitForTaskkill(taskkill, taskkillTimeoutMs);
  } catch {}

  if (!treeKilled) {
    try {
      killProcess(pid, "SIGTERM");
    } catch {}
  }
}

export function createPwshBashOperations(
  runtime: PowerShellRuntime,
  options: PowerShellProcessOptions = {},
): BashOperations {
  const spawnProcess = options.spawn ?? spawn;
  const killProcess = options.kill ?? process.kill.bind(process);
  const exitCloseGraceMs = options.exitCloseGraceMs ?? EXIT_CLOSE_GRACE_MS;
  const taskkillTimeoutMs = options.taskkillTimeoutMs ?? TASKKILL_TIMEOUT_MS;
  const postKillGraceMs = options.postKillGraceMs ?? POST_KILL_GRACE_MS;

  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) throw new Error("aborted");
      await assertWorkingDirectory(cwd);
      if (signal?.aborted) throw new Error("aborted");

      return new Promise((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        let terminationStarted = false;
        let observedExitCode: number | null = null;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let exitCloseHandle: ReturnType<typeof setTimeout> | undefined;
        let terminationDeadlineHandle: ReturnType<typeof setTimeout> | undefined;
        let postKillHandle: ReturnType<typeof setTimeout> | undefined;

        const child = spawnProcess(
          runtime.file,
          [
            "-NoProfile",
            "-NonInteractive",
            "-NoLogo",
            "-Command",
            `${UTF8_PRELUDE}\n${command}`,
          ],
          {
            cwd,
            env: {
              ...process.env,
              ...env,
              PYTHONUTF8: "1",
              PYTHONIOENCODING: "utf-8",
            },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );

        const cleanup = () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (exitCloseHandle) clearTimeout(exitCloseHandle);
          if (terminationDeadlineHandle) clearTimeout(terminationDeadlineHandle);
          if (postKillHandle) clearTimeout(postKillHandle);
          signal?.removeEventListener("abort", onAbort);
          // Keep the once(error) listener installed so a late spawn error after
          // forced finalization cannot become an unhandled EventEmitter error.
          child.removeListener("exit", onExit);
          child.removeListener("close", onClose);
          child.stdout?.removeListener("data", onData);
          child.stderr?.removeListener("data", onData);
        };

        const finish = (
          exitCode: number | null,
          spawnError?: NodeJS.ErrnoException,
        ) => {
          if (settled) return;
          settled = true;
          cleanup();
          child.stdout?.destroy();
          child.stderr?.destroy();

          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }

          if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
            return;
          }

          if (spawnError) {
            if (spawnError.code === "ENOENT") {
              reject(
                new Error(
                  `${runtime.label} executable \`${runtime.file}\` was not found.`,
                ),
              );
              return;
            }
            reject(spawnError);
            return;
          }

          resolve({ exitCode });
        };

        const beginTermination = () => {
          if (settled || terminationStarted) return;
          terminationStarted = true;

          terminationDeadlineHandle = setTimeout(
            () => finish(child.exitCode ?? observedExitCode),
            taskkillTimeoutMs + postKillGraceMs,
          );

          void terminateProcessTree(
            child.pid,
            spawnProcess,
            killProcess,
            taskkillTimeoutMs,
          ).finally(() => {
            if (settled) return;
            postKillHandle = setTimeout(
              () => finish(child.exitCode ?? observedExitCode),
              postKillGraceMs,
            );
          });
        };

        const onAbort = () => beginTermination();
        const onError = (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            finish(child.exitCode ?? observedExitCode, error);
            return;
          }

          // uv_spawn reports ENOENT for both a missing executable and a cwd
          // deleted between the preflight check and spawn. Recheck cwd before
          // deciding which user-facing error to return.
          void fsAccess(cwd, constants.F_OK).then(
            () => finish(child.exitCode ?? observedExitCode, error),
            () => finish(
              child.exitCode ?? observedExitCode,
              workingDirectoryError(cwd),
            ),
          );
        };
        const onExit = (exitCode: number | null) => {
          observedExitCode = exitCode;
          exitCloseHandle ??= setTimeout(
            () => finish(observedExitCode),
            exitCloseGraceMs,
          );
        };
        const onClose = (exitCode: number | null) => {
          finish(exitCode ?? observedExitCode);
        };

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.once("error", onError);
        child.once("exit", onExit);
        child.once("close", onClose);

        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            beginTermination();
          }, timeoutMs);
        }

        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

export function createPowerShellBashToolDefinition(
  runtime: PowerShellRuntime,
  cwd: string,
  operations: BashOperations = createPwshBashOperations(runtime),
): ReturnType<typeof createBashToolDefinition> {
  const original = createBashToolDefinition(cwd, { operations });
  return {
    ...original,
    description: original.description.replace(
      "Execute a bash command in the current working directory.",
      `Execute a command in the current working directory through ${runtime.label}. The tool is named bash for compatibility.`,
    ),
    promptSnippet: `Execute ${runtime.label} commands on Windows`,
    promptGuidelines: [
      ...(original.promptGuidelines ?? []),
      `This tool runs through ${runtime.label} (${runtime.file}), despite being named bash.`,
      runtime.kind === "powershell-7"
        ? "Use PowerShell 7 syntax."
        : "Use Windows PowerShell 5.1 syntax and avoid PowerShell 7-only features.",
      "Do not rely on GNU bash-only features unless explicitly invoking bash yourself.",
    ],
  };
}

export function createBgShellResolver(runtime: PowerShellRuntime) {
  return (command: string, interactive: boolean) => ({
    file: runtime.file,
    args: [
      "-NoProfile",
      ...(interactive ? [] : ["-NonInteractive"]),
      "-NoLogo",
      "-Command",
      `${UTF8_PRELUDE}\n${command}`,
    ],
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });
}

export default function (pi: ExtensionAPI) {
  // This package is Windows-only. Keep accidental local loads on Unix as a no-op.
  if (process.platform !== "win32") return;

  const runtime = selectPowerShellRuntime();
  const pwshOps = createPwshBashOperations(runtime);
  const bgShell = createBgShellResolver(runtime);
  const registerBackgroundBackend = (): void => {
    pi.events.emit("bg:register", {
      id: "pwsh-adapter",
      priority: 10,
      resolveShell: bgShell,
    });
  };

  // Bash delegation protocol: another extension (for example ssh-remote) can
  // claim the bash tool for the current session by emitting "bash:delegate"
  // with a resolver that returns its BashOperations (or undefined to fall
  // back to the local PowerShell backend). The resolver is consulted on every
  // execution, so the claim can follow session state without re-registration
  // races.
  let bashDelegate: (() => BashOperations | undefined) | undefined;
  pi.events.on("bash:delegate", (data: unknown) => {
    bashDelegate = (data as { resolveOperations?: () => BashOperations | undefined })
      ?.resolveOperations;
  });

  // Adapt background-tasks to use the selected PowerShell instead of /bin/sh.
  registerBackgroundBackend();

  // Re-register on session start in case Background Tasks loaded after us.
  // Named provider replacement is idempotent and SSH routing uses priority.
  pi.on("session_start", async (_event, ctx) => {
    registerBackgroundBackend();
    ctx.ui.notify(
      `bash tool loaded through ${runtime.label} (${runtime.file}). background-tasks adapted.`,
      "info",
    );
  });

  const bashTemplate = createPowerShellBashToolDefinition(
    runtime,
    process.cwd(),
    pwshOps,
  );
  pi.registerTool({
    ...bashTemplate,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const delegated = bashDelegate?.();
      if (delegated) {
        return createBashToolDefinition(ctx.cwd, { operations: delegated }).execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          ctx,
        );
      }
      return createPowerShellBashToolDefinition(
        runtime,
        ctx.cwd,
        pwshOps,
      ).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  // Intercept user-entered ! and !! commands with the same backend, honoring
  // the bash delegation protocol so remote sessions stay remote.
  pi.on("user_bash", () => {
    const delegated = bashDelegate?.();
    return { operations: delegated ?? pwshOps };
  });
}
