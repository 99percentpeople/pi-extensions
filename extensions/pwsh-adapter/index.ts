import type { ExtensionAPI, BashOperations } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";

const bashSchema = Type.Object({
  command: Type.String({
    description:
      "Command to execute. On this Windows environment, it is interpreted by PowerShell 7 pwsh, not GNU bash.",
  }),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds. Omit or set 0 for no timeout.",
      minimum: 0,
      maximum: 3600,
    }),
  ),
});

const UTF8_PRELUDE = `
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
`;

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

function createPwshBashOperations(): BashOperations {
  return {
    exec(command, cwd, { onData, signal, timeout, env }) {
      return new Promise((resolve, reject) => {
        let timedOut = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        const child = spawn(
          "pwsh",
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
                "`pwsh` was not found. Please install PowerShell 7 or make sure pwsh is available in PATH.",
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
 * this rewrites it to `spawn('pwsh', ['-Command', UTF8_PRELUDE + cmd], opts)`.
 */
function createBgSpawnWrapper() {
  const SHELLS = new Set(["/bin/sh", "/bin/bash", "/usr/bin/sh", "/usr/bin/bash", "sh", "bash"]);

  return function pwshSpawn(
    command: string,
    args?: readonly string[],
    options?: SpawnOptions,
  ): ChildProcess {
    if (SHELLS.has(command) && args?.[0] === "-c" && args.length >= 2) {
      // Rewrite: /bin/sh -c <cmd>  →  pwsh -Command <cmd>
      const userCommand = args.slice(1).join(" ");
      return spawn(
        "pwsh",
        ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", `${UTF8_PRELUDE}\n${userCommand}`],
        { ...options, windowsHide: true },
      );
    }
    // Fallback: pass through unchanged
    return spawn(command, args as string[], options ?? {});
  };
}

function createBgShellResolver() {
  return (command: string, interactive: boolean) => ({
    file: "pwsh",
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

  const pwshOps = createPwshBashOperations();
  const bgSpawn = createBgSpawnWrapper();
  const bgShell = createBgShellResolver();

  // Adapt background-tasks extension to use pwsh instead of /bin/sh
  pi.events.emit("bg:register", { spawn: bgSpawn, resolveShell: bgShell });

  // Re-register on session start in case bg extension loads after us
  pi.on("session_start", async (_event, ctx) => {
    pi.events.emit("bg:register", { spawn: bgSpawn, resolveShell: bgShell });
    ctx.ui.notify(
      "bash tool loaded. AI bash calls and user !/!! commands now run through pwsh. background-tasks adapted.",
      "info",
    );
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description:
      "Execute a shell command in the current working directory. This tool is named bash for compatibility, but on Windows it runs commands through PowerShell 7 pwsh.",
    promptSnippet:
      "Run shell commands. On Windows, use PowerShell/pwsh syntax rather than GNU bash syntax.",
    promptGuidelines: [
      "This tool is named bash for compatibility, but it runs through PowerShell 7 pwsh on Windows.",
      "Use PowerShell syntax when appropriate: Get-ChildItem, Select-String, Where-Object, $env:NAME, and ; for command separation.",
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
