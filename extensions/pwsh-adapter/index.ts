import { registerExtensionSettings } from "@99percentpeople/pi-shared-settings";
import {
  createBashToolDefinition,
  type ExtensionAPI,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import {
  spawn,
  spawnSync,
  type SpawnOptions,
  type ChildProcess,
} from "node:child_process";

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

function killProcessTree(pid?: number) {
  if (!pid) return;

  try {
    spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

function createPwshBashOperations(runtime: PowerShellRuntime): BashOperations {
  return {
    exec(command, cwd, { onData, signal, timeout, env }) {
      return new Promise((resolve, reject) => {
        const timeoutMs = resolveTimeoutMs(timeout);
        let timedOut = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        const child = spawn(
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
          signal?.removeEventListener("abort", onAbort);
        };

        const onAbort = () => {
          killProcessTree(child.pid);
        };

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid);
          }, timeoutMs);
        }

        if (signal?.aborted) {
          onAbort();
        } else {
          signal?.addEventListener("abort", onAbort, { once: true });
        }

        child.on("error", (error: NodeJS.ErrnoException) => {
          cleanup();

          if (error.code === "ENOENT") {
            reject(
              new Error(
                `${runtime.label} executable \`${runtime.file}\` was not found.`,
              ),
            );
            return;
          }

          reject(error);
        });

        child.on("close", (exitCode) => {
          cleanup();

          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }

          if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
            return;
          }

          resolve({ exitCode });
        });
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

/**
 * Wrapper around spawn that intercepts shell invocations from background-tasks.
 * When bg_start calls `spawn('/bin/sh', ['-c', cmd], opts)`,
 * this rewrites it to the selected PowerShell executable.
 */
function createBgSpawnWrapper(runtime: PowerShellRuntime) {
  const SHELLS = new Set(["/bin/sh", "/bin/bash", "/usr/bin/sh", "/usr/bin/bash", "sh", "bash"]);

  return function pwshSpawn(
    command: string,
    args?: readonly string[],
    options?: SpawnOptions,
  ): ChildProcess {
    if (SHELLS.has(command) && args?.[0] === "-c" && args.length >= 2) {
      // Rewrite: /bin/sh -c <cmd>  →  PowerShell -Command <cmd>
      const userCommand = args.slice(1).join(" ");
      return spawn(
        runtime.file,
        ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", `${UTF8_PRELUDE}\n${userCommand}`],
        { ...options, windowsHide: true },
      );
    }
    // Fallback: pass through unchanged
    return spawn(command, args as string[], options ?? {});
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
  registerExtensionSettings(pi, {
    namespace: "pwsh-adapter",
    title: "PowerShell Adapter",
    settings: () => [],
  });

  // This package is Windows-only. Keep accidental local loads on Unix as a no-op.
  if (process.platform !== "win32") return;

  const runtime = selectPowerShellRuntime();
  const pwshOps = createPwshBashOperations(runtime);
  const bgSpawn = createBgSpawnWrapper(runtime);
  const bgShell = createBgShellResolver(runtime);

  // Adapt background-tasks to use the selected PowerShell instead of /bin/sh.
  pi.events.emit("bg:register", { spawn: bgSpawn, resolveShell: bgShell });

  // Re-register on session start in case bg extension loads after us
  pi.on("session_start", async (_event, ctx) => {
    pi.events.emit("bg:register", { spawn: bgSpawn, resolveShell: bgShell });
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
      return createPowerShellBashToolDefinition(
        runtime,
        ctx.cwd,
        pwshOps,
      ).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  // Intercept user-entered ! and !! commands with the same PowerShell backend.
  pi.on("user_bash", () => {
    return { operations: pwshOps };
  });
}
