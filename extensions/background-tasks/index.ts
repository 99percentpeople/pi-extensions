/**
 * Background Tasks Extension for Pi
 *
 * 5 tools, clear responsibilities:
 *   bg_start  - Start a background task
 *   bg_status - Check status / list tasks / read output
 *   bg_send   - Interact via stdin (text, control chars, raw bytes)
 *   bg_stop   - Force kill unresponsive processes
 *
 * Features:
 *   - Automatic completion notifications (no polling required)
 *   - Auto-throttle via AbortController
 *   - Widget with real-time refresh (100ms)
 *   - Extensible spawn backend via pi.events
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/background-tasks/
 *   Or: pi -e ./background-tasks/
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, type Component } from "@earendil-works/pi-tui";

// ── Types ──────────────────────────────────────────────────────────────

interface BgTask {
  id: string;
  name: string;
  command: string;
  process: ChildProcess | null;
  status: "running" | "completed" | "failed" | "stopped";
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  endedAt: number | null;
  stdoutFile: string;
  stderrFile: string;
  stdoutLines: number;
  stderrLines: number;
  wait: number;
  nextCheckAt: number;
  done: AbortController;
  latestLog: LatestLog | null;
  stdoutPending: string;
  stderrPending: string;
  completionNotified: boolean;
  requestedStopSignal: "SIGTERM" | "SIGKILL" | null;
}

interface LatestLog {
  stream: "stdout" | "stderr";
  text: string;
  at: number;
}

// ── Execution Backend ─────────────────────────────────────────────────

let spawnFn: typeof spawn = spawn;

// ── Helpers ────────────────────────────────────────────────────────────

let taskDir: string;
const tasks = new Map<string, BgTask>();

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

async function ensureTaskDir(): Promise<string> {
  if (!taskDir) {
    taskDir = join(tmpdir(), "pi-bg-tasks", process.pid.toString());
    await mkdir(taskDir, { recursive: true });
  }
  return taskDir;
}

async function appendToFile(filePath: string, data: Buffer | string): Promise<void> {
  try { await appendFile(filePath, data); }
  catch { await writeFile(filePath, data); }
}

async function readTail(filePath: string, lines: number): Promise<string> {
  try { return (await readFile(filePath, "utf-8")).split("\n").slice(-lines).join("\n"); }
  catch { return ""; }
}

async function readRange(filePath: string, fromLine: number, maxLines: number): Promise<string> {
  try { return (await readFile(filePath, "utf-8")).split("\n").slice(fromLine, fromLine + maxLines).join("\n"); }
  catch { return ""; }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

const MAX_STORED_LOG_CHARS = 500;
const MAX_DISPLAY_LOG_CHARS = 240;

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function updateLatestLog(task: BgTask, stream: "stdout" | "stderr", data: Buffer): void {
  const pendingKey = stream === "stdout" ? "stdoutPending" : "stderrPending";
  const combined = task[pendingKey] + data.toString("utf-8");
  const lines = combined.split(/\r\n|[\r\n]/);
  const endsWithLineBreak = /[\r\n]$/.test(combined);
  task[pendingKey] = endsWithLineBreak ? "" : (lines.pop() ?? "");

  const latestCompleteLine = lines.filter((line) => line.length > 0).at(-1);
  const latestText = task[pendingKey] || latestCompleteLine;
  if (!latestText) return;

  task.latestLog = {
    stream,
    text: truncateText(latestText, MAX_STORED_LOG_CHARS),
    at: Date.now(),
  };
}

function formatLatestLog(latestLog: LatestLog | null): string {
  if (!latestLog) return "(no output yet)";
  return `[${latestLog.stream}] ${truncateText(latestLog.text, MAX_DISPLAY_LOG_CHARS)}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("bg_status cancelled");
}

async function waitUntilAllowed(
  remainingMs: number,
  doneSignals: AbortSignal[],
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  if (remainingMs <= 0) return;

  const combined = AbortSignal.any([
    AbortSignal.timeout(Math.ceil(remainingMs)),
    ...doneSignals,
    ...(signal ? [signal] : []),
  ]);
  if (!combined.aborted) {
    await new Promise<void>((resolve) => combined.addEventListener("abort", () => resolve(), { once: true }));
  }
  throwIfAborted(signal);
}

async function waitForTaskEnd(task: BgTask, timeoutMs: number): Promise<void> {
  if (task.status !== "running" || task.done.signal.aborted) return;
  await waitUntilAllowed(timeoutMs, [task.done.signal], undefined);
}

async function sendTaskSignal(task: BgTask, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  const child = task.process;
  const pid = child?.pid;
  if (!child || !pid) throw new Error(`Task "${task.name}" process is unavailable.`);

  task.requestedStopSignal = signal;
  try {
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        const args = ["/T", "/PID", String(pid)];
        if (signal === "SIGKILL") args.unshift("/F");
        const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
        killer.once("error", reject);
        killer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`taskkill exited with code ${code}`)));
      });
      return;
    }

    try {
      process.kill(-pid, signal);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "ESRCH" || !child.kill(signal)) throw error;
    }
  } catch (error) {
    task.requestedStopSignal = null;
    throw error;
  }
}



// ── Widget ─────────────────────────────────────────────────────────────

const WIDGET_KEY = "bg-tasks-widget";
let uiCtx: ExtensionContext | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

function getRunningTasks(): BgTask[] {
  return Array.from(tasks.values()).filter((t) => t.status === "running");
}

function stopRefreshTimer() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function startRefreshTimer() {
  stopRefreshTimer();
  refreshTimer = setInterval(() => {
    if (getRunningTasks().length === 0) stopRefreshTimer();
    updateWidget();
  }, 100);
}

function updateWidget() {
  if (!uiCtx?.hasUI) return;
  const running = getRunningTasks();
  if (running.length === 0) {
    stopRefreshTimer();
    uiCtx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }
  uiCtx.ui.setWidget(
    WIDGET_KEY,
    (_tui, theme) => {
      const now = Date.now();
      const lines = running.map((t) => {
        const dur = formatDuration(now - t.startedAt);
        return `  ${theme.bold(theme.fg("accent", t.name))} ${theme.fg("dim", `(${t.id})`)} ${theme.fg("muted", dur)} ${theme.fg("dim", `stdout:${t.stdoutLines} stderr:${t.stderrLines}`)}`;
      });
      const header = theme.fg("warning", `${running.length} background task${running.length > 1 ? "s" : ""}`);
      return new Text([header, ...lines].join("\n"), 0, 0);
    },
    { placement: "belowEditor" },
  );
  if (!refreshTimer) startRefreshTimer();
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  ensureTaskDir();

  pi.events.on("bg:register", (data: unknown) => {
    const ops = data as { spawn?: typeof spawn };
    if (ops.spawn) spawnFn = ops.spawn;
  });

  pi.on("session_start", async (_event, ctx) => { shuttingDown = false; uiCtx = ctx; });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName.startsWith("bg_")) { uiCtx = ctx; updateWidget(); }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    stopRefreshTimer();
    if (ctx?.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    uiCtx = null;
    await Promise.all(Array.from(tasks.values()).map(async (task) => {
      if (!task.process || task.status !== "running") return;
      task.completionNotified = true;
      try {
        await sendTaskSignal(task, "SIGTERM");
        await waitForTaskEnd(task, 3000);
        if (task.status === "running") {
          await sendTaskSignal(task, "SIGKILL");
          await waitForTaskEnd(task, 1000);
        }
      } catch {
        task.process?.kill("SIGKILL");
      }
    }));
  });

  // ── bg_start ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_start",
    label: "BG Start",
    description: "Start a background task. The command runs asynchronously in a shell.",
    promptSnippet: "Start a long-running command in the background",
    promptGuidelines: [
      "Use bg_start to run long commands (builds, servers, tests) in the background so you can do other work while waiting.",
      "After bg_start, do not poll bg_status. Background task completion or failure is delivered automatically; continue other useful work or finish the response.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "A short descriptive name for the task" }),
      command: Type.String({ description: "The shell command to run" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current)" })),
      wait: Type.Optional(Type.Number({ description: "Minimum seconds between status checks (default: 5)", minimum: 1, maximum: 3600 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
      const dir = await ensureTaskDir();
      const id = generateId();
      const stdoutFile = join(dir, `${id}.stdout`);
      const stderrFile = join(dir, `${id}.stderr`);

      const child = spawnFn(process.env.SHELL || "/bin/sh", ["-c", params.command], {
        cwd: params.cwd || ctx.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        detached: process.platform !== "win32",
      });

      const task: BgTask = {
        id, name: params.name, command: params.command,
        process: child, status: "running",
        exitCode: null, signal: null,
        startedAt: Date.now(), endedAt: null,
        stdoutFile, stderrFile, stdoutLines: 0, stderrLines: 0,
        wait: params.wait ?? 5, nextCheckAt: Date.now() + (params.wait ?? 5) * 1000,
        done: new AbortController(),
        latestLog: null, stdoutPending: "", stderrPending: "",
        completionNotified: false, requestedStopSignal: null,
      };
      tasks.set(id, task);

      child.stdout?.on("data", (d: Buffer) => {
        task.stdoutLines += d.toString().split("\n").length - 1;
        updateLatestLog(task, "stdout", d);
        appendToFile(stdoutFile, d).catch(() => {});
      });
      child.stderr?.on("data", (d: Buffer) => {
        task.stderrLines += d.toString().split("\n").length - 1;
        updateLatestLog(task, "stderr", d);
        appendToFile(stderrFile, d).catch(() => {});
      });
      let spawnError: Error | null = null;
      child.on("error", (err) => {
        spawnError = err;
        const errorLine = `[error: ${err.message}]`;
        updateLatestLog(task, "stderr", Buffer.from(`${errorLine}\n`));
        appendToFile(stderrFile, `\n${errorLine}\n`).catch(() => {});
      });
      child.on("close", (code, signal) => {
        task.endedAt = Date.now();
        task.exitCode = code;
        task.signal = signal ?? task.requestedStopSignal;
        task.process = null;
        task.status = task.requestedStopSignal
          ? "stopped"
          : spawnError
            ? "failed"
            : signal === "SIGTERM" || signal === "SIGKILL"
              ? "stopped"
              : code === 0 ? "completed" : "failed";
        task.done.abort();
        updateWidget();

        if (task.completionNotified || shuttingDown) return;
        task.completionNotified = true;
        const duration = formatDuration(task.endedAt - task.startedAt);
        const exit = task.exitCode !== null ? ` Exit code: ${task.exitCode}.` : "";
        const stopped = task.signal ? ` Signal: ${task.signal}.` : "";
        try {
          pi.sendMessage({
            customType: "background-task-complete",
            content: `Background task "${task.name}" (${task.id}) ${task.status} after ${duration}.${exit}${stopped}\nLatest log: ${formatLatestLog(task.latestLog)}\nDo not call bg_status unless the user explicitly asks for more details.`,
            display: true,
            details: {
              id: task.id,
              name: task.name,
              status: task.status,
              exitCode: task.exitCode,
              signal: task.signal,
              latestLog: task.latestLog,
            },
          }, { deliverAs: "followUp", triggerTurn: true });
        } catch {
          // The extension runtime may already be shutting down or reloading.
        }
      });

      uiCtx = ctx;
      updateWidget();

      return {
        content: [{ type: "text", text: `Background task started:\n  ID:      ${id}\n  Name:    ${params.name}\n  Command: ${params.command}\n  PID:     ${child.pid}\nCompletion notification: automatic; do not poll bg_status.` }],
        details: { id, name: params.name, command: params.command, pid: child.pid, wait: task.wait },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const name = args.name ? theme.fg("accent", args.name) : theme.fg("toolOutput", "...");
      const cmd = args.command
        ? theme.fg("muted", `$ ${args.command}`)
        : theme.fg("toolOutput", "...");
      const wait = args.wait ? theme.fg("dim", ` (wait ${args.wait}s)`) : "";
      text.setText(theme.fg("toolTitle", theme.bold(`bg_start `)) + name + ` ${cmd}` + wait);
      return text;
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Starting..."), 0, 0);
      const d = result.details as { id?: string; name?: string; pid?: number } | undefined;
      if (!d) return new Text(theme.fg("success", "Done"), 0, 0);
      const lines = [
        theme.fg("accent", d.name ?? "") + theme.fg("dim", ` ${d.id ?? ""} pid=${d.pid ?? ""}`),
      ];
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ── bg_status ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_status",
    label: "BG Status",
    description: "Inspect a background task snapshot or list tasks. Completion notifications are automatic; this is not a polling tool.",
    promptSnippet: "Inspect background tasks only when status details are needed",
    promptGuidelines: [
      "Do not poll bg_status after bg_start; completion and failure notifications arrive automatically.",
      "Use bg_status only when the user explicitly asks for current task details, when recovering missing context, or when diagnosing a suspected notification failure.",
      "Use bg_status without id only when a task ID is unknown and a task list is specifically needed.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Task ID. If omitted, lists all tasks." })),
    }),

    executionMode: "sequential",

    async execute(_toolCallId, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!params.id) {
        const entries = Array.from(tasks.values());
        if (entries.length === 0) return { content: [{ type: "text", text: "No background tasks." }], details: { tasks: [] } };
        const running = entries.filter((task) => task.status === "running");
        const remaining = Math.max(0, ...running.map((task) => task.nextCheckAt - Date.now()));
        await waitUntilAllowed(remaining, running.map((task) => task.done.signal), signal);
        const nextCheckBase = Date.now();
        for (const task of running) {
          if (task.status === "running") task.nextCheckAt = nextCheckBase + task.wait * 1000;
        }
        const lines = entries.map((t) => {
          const dur = t.endedAt ? formatDuration(t.endedAt - t.startedAt) : formatDuration(Date.now() - t.startedAt);
          const exit = t.exitCode !== null ? ` exit=${t.exitCode}` : "";
          return `[${t.id}] "${t.name}" ${t.status} (${dur})${exit}\n  Latest log: ${formatLatestLog(t.latestLog)}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { tasks: entries.map((t) => ({ id: t.id, name: t.name, status: t.status, latestLog: t.latestLog })) },
        };
      }

      const task = tasks.get(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };

      // Throttle
      if (task.status === "running" && task.nextCheckAt > 0) {
        const remaining = task.nextCheckAt - Date.now();
        if (remaining > 0) {
          await waitUntilAllowed(remaining, [task.done.signal], signal);
        }
      }
      if (task.status === "running") task.nextCheckAt = Date.now() + task.wait * 1000;

      const duration = task.endedAt ? formatDuration(task.endedAt - task.startedAt) : formatDuration(Date.now() - task.startedAt);
      const parts: string[] = [
        `Task: ${task.name} (${task.id})`,
        `  Status:    ${task.status}`, `  Command:   ${task.command}`, `  Duration:  ${duration}`,
      ];
      if (task.exitCode !== null) parts.push(`  Exit code: ${task.exitCode}`);
      if (task.signal) parts.push(`  Signal:    ${task.signal}`);
      if (task.process?.pid) parts.push(`  PID:       ${task.process.pid}`);
      parts.push(
        `  Stdout:    ${task.stdoutLines} lines`,
        `  Stderr:    ${task.stderrLines} lines`,
        `  Latest log: ${formatLatestLog(task.latestLog)}`,
      );
      if (task.status === "running") parts.push("  Completion notification: automatic; do not poll bg_status.");

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: { id: task.id, name: task.name, status: task.status, exitCode: task.exitCode, signal: task.signal, pid: task.process?.pid, stdoutLines: task.stdoutLines, stderrLines: task.stderrLines, wait: task.wait, latestLog: task.latestLog },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const t = args.id ? tasks.get(args.id) : undefined;
      const label = t ? theme.fg("accent", t.name) : args.id ? theme.fg("muted", args.id) : theme.fg("toolOutput", "all");
      text.setText(theme.fg("toolTitle", theme.bold("bg_status ")) + label);
      return text;
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Checking..."), 0, 0);
      const content = result.content[0]?.type === "text" ? result.content[0].text : "";
      const lines = content.split("\n").map(l => {
        if (l.includes("Status:")) {
          if (l.includes("running")) return l.replace("running", theme.fg("success", "running"));
          if (l.includes("completed")) return l.replace("completed", theme.fg("accent", "completed"));
          if (l.includes("failed")) return l.replace("failed", theme.fg("error", "failed"));
          if (l.includes("stopped")) return l.replace("stopped", theme.fg("warning", "stopped"));
        }
        return theme.fg("toolOutput", l) || l;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ── bg_logs ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_logs",
    label: "BG Logs",
    description: "Read stdout/stderr output from a background task.",
    promptSnippet: "Read stdout/stderr output from a background task",
    promptGuidelines: [
      "Use bg_logs to read the output of a background task.",
      "Use bg_logs with tail=N to read the last N lines of output.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
      tail: Type.Optional(Type.Number({ description: "Read last N lines (default: 100)" })),
      stream: Type.Optional(StringEnum(["stdout", "stderr", "both"] as const, { description: "Which stream (default: 'both')" })),
      from_line: Type.Optional(Type.Number({ description: "Start from this line (0-indexed). Overrides tail." })),
      max_lines: Type.Optional(Type.Number({ description: "Max lines with from_line (default: 500)" })),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
      const task = tasks.get(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };

      const stream = params.stream || "both";
      const maxLines = params.max_lines || 500;
      const lines = params.tail || 100;
      let stdout = "", stderr = "";

      if (stream === "stdout" || stream === "both")
        stdout = params.from_line !== undefined ? await readRange(task.stdoutFile, params.from_line, maxLines) : await readTail(task.stdoutFile, lines);
      if (stream === "stderr" || stream === "both")
        stderr = params.from_line !== undefined ? await readRange(task.stderrFile, params.from_line, maxLines) : await readTail(task.stderrFile, lines);

      const parts: string[] = [];
      if (stream === "both") {
        if (stdout) parts.push(`── stdout ──\n${stdout}`);
        if (stderr) parts.push(`── stderr ──\n${stderr}`);
        if (!stdout && !stderr) parts.push("(no output yet)");
      } else {
        parts.push(stream === "stdout" ? stdout || "(no stdout)" : stderr || "(no stderr)");
      }

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        details: { id: task.id, name: task.name, status: task.status, stdoutLines: task.stdoutLines, stderrLines: task.stderrLines },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const t = tasks.get(args.id);
      const name = t ? theme.fg("accent", t.name) : theme.fg("muted", args.id);
      const extras: string[] = [];
      if (args.tail) extras.push(`tail=${args.tail}`);
      if (args.stream && args.stream !== "both") extras.push(args.stream);
      const extra = extras.length ? theme.fg("dim", ` ${extras.join(" ")}`) : "";
      text.setText(theme.fg("toolTitle", theme.bold("bg_logs ")) + name + extra);
      return text;
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);
      const content = result.content[0]?.type === "text" ? result.content[0].text : "";
      const lines = content.split("\n").map(l => {
        if (l.startsWith("── ") || l.startsWith("-- ")) return theme.fg("accent", l) || l;
        if (l === "(no output yet)" || l === "(no stdout)" || l === "(no stderr)") return theme.fg("muted", l) || l;
        return theme.fg("toolOutput", l) || l;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ── bg_send ────────────────────────────────────────────────────────

  const CTRL: Record<string, Buffer> = {
    "ctrl+c": Buffer.from([0x03]), "ctrl+d": Buffer.from([0x04]),
    "ctrl+z": Buffer.from([0x1a]), "ctrl+l": Buffer.from([0x0c]),
    "ctrl+\\": Buffer.from([0x1c]), "ctrl+u": Buffer.from([0x15]),
    "ctrl+k": Buffer.from([0x0b]), "ctrl+a": Buffer.from([0x01]),
    "ctrl+e": Buffer.from([0x05]), "eof": Buffer.from([0x04]),
    "escape": Buffer.from([0x1b]), "tab": Buffer.from([0x09]),
    "backspace": Buffer.from([0x7f]),
  };

  pi.registerTool({
    name: "bg_send",
    label: "BG Send",
    description: "Send input to a running background task's stdin. Supports control characters and raw mode.",
    promptSnippet: "Send text or control characters to a background task's stdin",
    promptGuidelines: [
      "Use bg_send to interact with a running background task that expects stdin input.",
      "Use bg_send with text='ctrl+c' to send Ctrl+C, text='eof' to close stdin.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
      text: Type.String({ description: "Text to send. Keywords: ctrl+c, ctrl+d, eof, escape, tab, backspace" }),
      raw: Type.Optional(Type.Boolean({ description: "Send raw bytes without newline (default: false)" })),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
      const task = tasks.get(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };
      if (task.status !== "running") return { content: [{ type: "text", text: `Task "${task.name}" is not running.` }], details: {} };
      if (!task.process) return { content: [{ type: "text", text: `Task "${task.name}" stdin unavailable.` }], details: {} };

      const keyword = params.text.toLowerCase().trim();
      const data = CTRL[keyword] || (params.raw ? Buffer.from(params.text, "utf-8") : Buffer.from(params.text + "\n", "utf-8"));
      const desc = CTRL[keyword] ? keyword : params.raw ? `raw(${params.text})` : JSON.stringify(params.text);

      try {
        task.process.stdin?.write(data);
        return { content: [{ type: "text", text: `Sent to "${task.name}": ${desc} (${data.length} bytes)` }], details: { id: task.id, name: task.name, bytes: data.length, keyword } };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
      }
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const t = tasks.get(args.id);
      const name = t ? theme.fg("accent", t.name) : theme.fg("muted", args.id);
      const input = args.text ? theme.fg("dim", ` → ${args.text}`) : "";
      text.setText(theme.fg("toolTitle", theme.bold("bg_send ")) + name + input);
      return text;
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Sending..."), 0, 0);
      const content = result.content[0]?.type === "text" ? result.content[0].text : "";
      return new Text(theme.fg("toolOutput", content) || content, 0, 0);
    },
  });

  // ── bg_stop ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_stop",
    label: "BG Stop",
    description: "Force stop a background task that is not responding. SIGTERM by default, SIGKILL with force=true.",
    promptSnippet: "Force stop an unresponsive background task",
    promptGuidelines: [
      "Use bg_stop when a background task is stuck or unresponsive and needs to be killed.",
      "Use bg_stop with force=true to send SIGKILL immediately.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
      force: Type.Optional(Type.Boolean({ description: "Send SIGKILL instead of SIGTERM (default: false)" })),
      tail_lines: Type.Optional(Type.Number({ description: "Return last N lines of output (default: 30)" })),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
      const task = tasks.get(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };
      if (task.status !== "running") return { content: [{ type: "text", text: `Task "${task.name}" is already ${task.status}.` }], details: {} };

      const signal = params.force ? "SIGKILL" : "SIGTERM";
      task.completionNotified = true;
      try {
        await sendTaskSignal(task, signal);
      }
      catch (err) {
        task.completionNotified = false;
        return { content: [{ type: "text", text: `Failed to send ${signal}: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
      }

      await waitForTaskEnd(task, params.force ? 500 : 2500);

      const tail = params.tail_lines || 30;
      const stdout = await readTail(task.stdoutFile, tail);
      const stderr = await readTail(task.stderrFile, tail);
      const action = task.status === "running" ? `Sent ${signal} to` : "Stopped";
      const parts = [`${action} "${task.name}". Status: ${task.status}`];
      if (stdout) parts.push(`\n── stdout (last ${tail}) ──\n${stdout}`);
      if (stderr) parts.push(`\n── stderr (last ${tail}) ──\n${stderr}`);

      return { content: [{ type: "text", text: parts.join("\n") }], details: { id: task.id, name: task.name, status: task.status, signal } };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const t = tasks.get(args.id);
      const name = t ? theme.fg("accent", t.name) : theme.fg("muted", args.id);
      const sig = args.force ? theme.fg("error", " SIGKILL") : "";
      text.setText(theme.fg("toolTitle", theme.bold("bg_stop ")) + name + sig);
      return text;
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Stopping..."), 0, 0);
      const content = result.content[0]?.type === "text" ? result.content[0].text : "";
      const lines = content.split("\n").map(l => {
        if (l.includes("SIGKILL")) return theme.fg("error", l) || l;
        if (l.includes("SIGTERM")) return theme.fg("warning", l) || l;
        if (l.startsWith("── ") || l.startsWith("-- ")) return theme.fg("accent", l) || l;
        return theme.fg("toolOutput", l) || l;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ── /kill command ──────────────────────────────────────────────────

  pi.registerCommand("kill", {
    description: "Kill a background task by ID",
    getArgumentCompletions: (prefix: string) => {
      const items = Array.from(tasks.values())
        .filter(t => t.status === "running")
        .map(t => ({ value: t.id, label: `${t.id} ${t.name}` }));
      return items.filter(i => i.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      if (!args) {
        const running = Array.from(tasks.values()).filter(t => t.status === "running");
        if (running.length === 0) {
          ctx.ui.notify("No running tasks.", "info");
          return;
        }
        const choice = await ctx.ui.select(
          "Kill which task?",
          running.map(t => `${t.id} ${t.name}`),
        );
        if (!choice) return;
        args = choice.split(" ", 1)[0];
      }

      const task = tasks.get(args);
      if (!task) {
        ctx.ui.notify(`Task not found: ${args}`, "error");
        return;
      }
      if (task.status !== "running") {
        ctx.ui.notify(`Task "${task.name}" is already ${task.status}.`, "warning");
        return;
      }

      task.completionNotified = true;
      try {
        await sendTaskSignal(task, "SIGKILL");
      } catch (error) {
        task.completionNotified = false;
        ctx.ui.notify(`Failed to kill "${task.name}": ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      await waitForTaskEnd(task, 500);
      ctx.ui.notify(`Stop requested for "${task.name}" (${task.id}); status: ${task.status}`, "info");
    },
  });
}
