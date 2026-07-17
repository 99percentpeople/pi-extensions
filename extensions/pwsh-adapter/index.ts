import type { ExtensionAPI, BashOperations } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

function createBashSchema(runtime: PowerShellRuntime) {
  return Type.Object({
    command: Type.String({
      description: `Command to execute with ${runtime.label}, not GNU bash.`,
    }),
    timeout: Type.Optional(
      Type.Number({
        description: "Timeout in seconds. Omit or set 0 for no timeout.",
        minimum: 0,
        maximum: 3600,
      }),
    ),
  });
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

        if (timeout && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid);
          }, timeout * 1000);
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
  // This package is Windows-only. Keep accidental local loads on Unix as a no-op.
  if (process.platform !== "win32") return;

  const runtime = selectPowerShellRuntime();
  const bashSchema = createBashSchema(runtime);
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

  pi.registerTool({
    name: "bash",
    label: "bash",
    description:
      `Execute a shell command in the current working directory through ${runtime.label}. The tool is named bash for compatibility.`,
    promptSnippet:
      `Run shell commands with ${runtime.label} on Windows.`,
    promptGuidelines: [
      `This tool runs through ${runtime.label} (${runtime.file}), despite being named bash.`,
      runtime.kind === "powershell-7"
        ? "Use PowerShell 7 syntax."
        : "Use Windows PowerShell 5.1 syntax and avoid PowerShell 7-only features.",
      "Do not rely on GNU bash-only features unless explicitly invoking bash yourself.",
    ],
    parameters: bashSchema,

    async execute(_toolCallId, { command, timeout }, signal, onUpdate, ctx) {
      let output = "";

      if (onUpdate) {
        onUpdate({ content: [], details: undefined });
      }

      const result = await pwshOps.exec(command, ctx.cwd, {
        timeout,
        signal,
        onData(data) {
          output += data.toString("utf8");

          onUpdate?.({
            content: [{ type: "text", text: output || "(no output yet)" }],
            details: { progress: "running" },
          });
        },
      });

      if (result.exitCode !== 0 && result.exitCode !== null) {
        throw new Error(
          `${output || "(no output)"}\n\nCommand exited with code ${result.exitCode}`,
        );
      }

      return {
        content: [{ type: "text", text: output || "(no output)" }],
        details: { exitCode: result.exitCode },
      };
    },
  });

  // 关键：拦截用户手动输入的 ! 和 !!
  pi.on("user_bash", () => {
    return { operations: pwshOps };
  });
}
