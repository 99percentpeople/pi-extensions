/**
 * Background Tasks Extension for Pi
 *
 * 6 tools, clear responsibilities:
 *   bg_start  - Start a background task
 *   bg_wait   - Wait for a task to finish or time out
 *   bg_status - Check status / list tasks
 *   bg_logs   - Read stdout/stderr output or a PTY screen snapshot
 *   bg_send   - Interact via stdin or send process signals
 *   bg_kill   - Terminate unresponsive processes
 *
 * Features:
 *   - Optional PTY sessions for interactive commands and full-screen TUIs
 *   - Detachable terminal attachment via /bg-attach (Ctrl+] to detach)
 *   - Explicit completion waits with timeout (no polling required)
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
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { keyText, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as nodePty from "node-pty";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import type { SerializeAddon as XtermSerializeAddon } from "@xterm/addon-serialize";

const cjsRequire = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = cjsRequire("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon } = cjsRequire("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

// ── Types ──────────────────────────────────────────────────────────────

interface PipeTaskProcess {
  kind: "pipe";
  pid: number;
  child: ChildProcess;
}

interface PtyTaskProcess {
  kind: "pty";
  pid: number;
  pty: nodePty.IPty;
}

type BackgroundProcess = PipeTaskProcess | PtyTaskProcess;

interface PtyState {
  terminal: XtermTerminal;
  serializer: XtermSerializeAddon;
  parsed: Promise<void>;
  attachedWriter?: (data: string) => void;
  detach?: (reason: "detached" | "exited" | "shutdown") => void;
}

interface ShellLaunch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

type ShellResolver = (command: string, interactive: boolean) => ShellLaunch;

interface BgTask {
  id: string;
  name: string;
  command: string;
  mode: "pipe" | "pty";
  process: BackgroundProcess | null;
  ptyState: PtyState | null;
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
  requestedStopSignal: NodeJS.Signals | null;
}

interface LatestLog {
  stream: "stdout" | "stderr" | "terminal";
  text: string;
  at: number;
}

// ── Execution Backend ─────────────────────────────────────────────────

let spawnFn: typeof spawn = spawn;
let ptySpawnFn: typeof nodePty.spawn = nodePty.spawn;

function defaultShellResolver(command: string): ShellLaunch {
  if (process.platform === "win32") {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
      env: { ...process.env },
    };
  }
  return {
    file: process.env.SHELL || "/bin/sh",
    args: ["-c", command],
    env: { ...process.env },
  };
}

let resolveShell: ShellResolver = defaultShellResolver;

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

function sanitizeLogOutput(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitLogLines(text: string): string[] {
  const lines = sanitizeLogOutput(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function readTail(filePath: string, lines: number): Promise<string> {
  try { return splitLogLines(await readFile(filePath, "utf-8")).slice(-lines).join("\n"); }
  catch { return ""; }
}

async function readRange(filePath: string, fromLine: number, maxLines: number): Promise<string> {
  try { return splitLogLines(await readFile(filePath, "utf-8")).slice(fromLine, fromLine + maxLines).join("\n"); }
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
  const latestText = sanitizeLogOutput(task[pendingKey] || latestCompleteLine || "");
  if (!latestText) return;

  task.latestLog = {
    stream,
    text: truncateText(latestText, MAX_STORED_LOG_CHARS),
    at: Date.now(),
  };
}

function getPtySnapshotLines(task: BgTask): string[] {
  const terminal = task.ptyState?.terminal;
  if (!terminal) return [];

  const lines: string[] = [];
  const buffer = terminal.buffer.active;
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index)?.translateToString(true) ?? "";
    lines.push(line.replace(/\0/g, ""));
  }
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

const TERMINAL_SNAPSHOT_HEADER = "── terminal snapshot";

function formatPtyScreenSnapshot(task: BgTask, label?: string): string {
  const rows = task.ptyState?.terminal.rows ?? 30;
  const snapshot = getPtySnapshotLines(task).slice(-rows).join("\n");
  const header = label ? `${TERMINAL_SNAPSHOT_HEADER}: ${label} ──` : `${TERMINAL_SNAPSHOT_HEADER} ──`;
  return `${header}\n${snapshot || "(no terminal output yet)"}`;
}

function renderContentWithoutCollapsedSnapshots(content: string, expanded: boolean): string {
  if (expanded) return content;
  const lines = content.split("\n");
  const snapshotIndex = lines.findIndex((line) => line.startsWith(TERMINAL_SNAPSHOT_HEADER));
  return snapshotIndex === -1 ? content : lines.slice(0, snapshotIndex).join("\n").trimEnd();
}

function updatePtyLatestLog(task: BgTask): void {
  const latestText = getPtySnapshotLines(task).findLast((line) => line.trim().length > 0)?.trim();
  if (!latestText) return;
  task.latestLog = {
    stream: "terminal",
    text: truncateText(latestText, MAX_STORED_LOG_CHARS),
    at: Date.now(),
  };
}

function recordPtyData(task: BgTask, data: string): void {
  const state = task.ptyState;
  if (!state) return;

  task.stdoutLines += data.split("\n").length - 1;
  appendToFile(task.stdoutFile, data).catch(() => {});
  state.parsed = new Promise<void>((resolve) => {
    state.terminal.write(data, () => {
      updatePtyLatestLog(task);
      resolve();
    });
  });
  state.attachedWriter?.(data);
}

async function flushPty(task: BgTask): Promise<void> {
  await task.ptyState?.parsed;
}

function formatTaskOutputStats(task: BgTask): string[] {
  if (task.mode === "pty") {
    const terminal = task.ptyState?.terminal;
    const dimensions = terminal ? ` (${terminal.cols}x${terminal.rows})` : "";
    return [
      `  Mode:       pty${dimensions}`,
      `  Terminal:   ${getPtySnapshotLines(task).length} rows`,
    ];
  }
  return [
    `  Stdout:     ${task.stdoutLines} lines`,
    `  Stderr:     ${task.stderrLines} lines`,
  ];
}

function formatLatestLog(latestLog: LatestLog | null): string {
  if (!latestLog) return "(no output yet)";
  return `[${latestLog.stream}] ${truncateText(latestLog.text, MAX_DISPLAY_LOG_CHARS)}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Background task wait cancelled");
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

async function sendProcessSignal(task: BgTask, signal: NodeJS.Signals, killTree = false): Promise<void> {
  const taskProcess = task.process;
  const pid = taskProcess?.pid;
  if (!taskProcess || !pid) throw new Error(`Task "${task.name}" process is unavailable.`);

  if (process.platform === "win32") {
    if (killTree && (signal === "SIGTERM" || signal === "SIGKILL")) {
      await new Promise<void>((resolve, reject) => {
        const args = ["/T", "/PID", String(pid)];
        if (signal === "SIGKILL") args.unshift("/F");
        const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
        killer.once("error", reject);
        killer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`taskkill exited with code ${code}`)));
      });
      return;
    }
    if (taskProcess.kind === "pty") {
      if (signal !== "SIGTERM" && signal !== "SIGHUP") {
        throw new Error(`${signal} is not supported by node-pty on Windows; send a terminal control key or use bg_kill.`);
      }
      taskProcess.pty.kill();
      return;
    }
    if (!taskProcess.child.kill(signal)) throw new Error(`Failed to send ${signal} to task "${task.name}".`);
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "ESRCH") throw error;
    if (taskProcess.kind === "pty") taskProcess.pty.kill(signal);
    else if (!taskProcess.child.kill(signal)) throw error;
  }
}

async function sendTaskSignal(task: BgTask, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  task.requestedStopSignal = signal;
  try {
    await sendProcessSignal(task, signal, true);
  } catch (error) {
    task.requestedStopSignal = null;
    throw error;
  }
}

function writeTaskInput(task: BgTask, data: Buffer | string): void {
  const taskProcess = task.process;
  if (!taskProcess) throw new Error(`Task "${task.name}" process is unavailable.`);
  if (taskProcess.kind === "pty") {
    taskProcess.pty.write(data);
    return;
  }
  if (!taskProcess.child.stdin?.write(data)) {
    throw new Error(`Task "${task.name}" stdin is unavailable or closed.`);
  }
}

function closeTaskInput(task: BgTask): void {
  const taskProcess = task.process;
  if (!taskProcess) throw new Error(`Task "${task.name}" process is unavailable.`);
  if (taskProcess.kind === "pty") {
    taskProcess.pty.write("\x04");
    return;
  }
  taskProcess.child.stdin?.end();
}

function forceKillProcess(task: BgTask): void {
  const taskProcess = task.process;
  if (!taskProcess) return;
  if (taskProcess.kind === "pty") {
    if (process.platform === "win32") taskProcess.pty.kill();
    else taskProcess.pty.kill("SIGKILL");
    return;
  }
  taskProcess.child.kill("SIGKILL");
}

function finishTask(task: BgTask, code: number | null, signal: string | null, failedToSpawn = false): void {
  if (task.status !== "running") return;
  task.endedAt = Date.now();
  task.exitCode = code;
  task.signal = task.requestedStopSignal ?? signal;
  task.process = null;
  task.status = task.requestedStopSignal
    ? "stopped"
    : failedToSpawn
      ? "failed"
      : signal
        ? "stopped"
        : code === 0 ? "completed" : "failed";
  task.done.abort();
  task.ptyState?.detach?.("exited");
  updateWidget();
}

const PTY_DETACH_KEY = "\x1d";
const TERMINAL_RESET = [
  "\x1b[?1000l", "\x1b[?1002l", "\x1b[?1003l", "\x1b[?1006l",
  "\x1b[?2004l", "\x1b[?1049l", "\x1b[0m", "\x1b[?25h", "\x1b[2J", "\x1b[H",
].join("");

async function attachPtyTask(task: BgTask, ctx: ExtensionContext): Promise<void> {
  const state = task.ptyState;
  const taskProcess = task.process;
  if (!state || task.mode !== "pty") {
    ctx.ui.notify(`Task "${task.name}" is not a PTY task.`, "warning");
    return;
  }
  if (task.status !== "running" || !taskProcess || taskProcess.kind !== "pty") {
    ctx.ui.notify(`Task "${task.name}" is not running.`, "warning");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify("PTY attachment requires Pi TUI mode.", "warning");
    return;
  }
  if (state.detach) {
    ctx.ui.notify(`Task "${task.name}" is already attached.`, "warning");
    return;
  }

  let attachError: string | undefined;
  const reason = await ctx.ui.custom<"detached" | "exited" | "shutdown">((tui, _theme, _keybindings, done) => {
    let cleaned = false;
    let terminalStarted = false;
    let rawBeforeAttach = false;
    let ptyPaused = false;
    let inputHandler: ((data: string | Buffer) => void) | undefined;
    let resizeHandler: (() => void) | undefined;

    const cleanup = (result: "detached" | "exited" | "shutdown") => {
      if (cleaned) return;
      cleaned = true;
      state.attachedWriter = undefined;
      state.detach = undefined;
      if (inputHandler) process.stdin.removeListener("data", inputHandler);
      if (resizeHandler) process.stdout.removeListener("resize", resizeHandler);
      if (ptyPaused) {
        try { taskProcess.pty.resume(); } catch {}
        ptyPaused = false;
      }
      if (terminalStarted) {
        process.stdin.pause();
        process.stdin.setRawMode?.(rawBeforeAttach);
        process.stdout.write(TERMINAL_RESET);
        tui.start();
        tui.requestRender(true);
      }
      done(result);
    };

    state.detach = cleanup;

    queueMicrotask(async () => {
      try {
        if (cleaned) return;
        tui.stop();
        terminalStarted = true;
        rawBeforeAttach = process.stdin.isRaw || false;
        process.stdin.setRawMode?.(true);
        process.stdin.setEncoding("utf8");
        process.stdin.resume();

        inputHandler = (chunk) => {
          const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
          const detachAt = data.indexOf(PTY_DETACH_KEY);
          if (detachAt >= 0) {
            if (detachAt > 0) taskProcess.pty.write(data.slice(0, detachAt));
            cleanup("detached");
            return;
          }
          taskProcess.pty.write(data);
        };
        resizeHandler = () => {
          const cols = Math.max(20, process.stdout.columns || state.terminal.cols || 80);
          const rows = Math.max(5, process.stdout.rows || state.terminal.rows || 24);
          state.terminal.resize(cols, rows);
          if (task.process?.kind === "pty") task.process.pty.resize(cols, rows);
        };

        process.stdin.on("data", inputHandler);
        process.stdout.on("resize", resizeHandler);
        process.stdout.write("\x1b[2J\x1b[H");
        taskProcess.pty.pause();
        ptyPaused = true;
        await flushPty(task);
        if (cleaned) return;
        process.stdout.write(state.serializer.serialize({ scrollback: 200 }));
        state.attachedWriter = (data) => process.stdout.write(data);
        resizeHandler();
        taskProcess.pty.resume();
        ptyPaused = false;
      } catch (error) {
        attachError = error instanceof Error ? error.message : String(error);
        cleanup("detached");
      }
    });

    return {
      render: () => [],
      invalidate: () => {},
      dispose: () => cleanup("detached"),
    } satisfies Component & { dispose(): void };
  });

  if (attachError) {
    ctx.ui.notify(`PTY attachment failed: ${attachError}`, "error");
  } else if (reason === "exited") {
    ctx.ui.notify(`PTY task "${task.name}" exited.`, "info");
  } else if (reason === "detached") {
    ctx.ui.notify(`Detached from "${task.name}"; the task is still running.`, "info");
  }
}

// ── Widget ─────────────────────────────────────────────────────────────

const WIDGET_KEY = "bg-tasks-widget";
let uiCtx: ExtensionContext | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

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
        const output = t.mode === "pty"
          ? `pty:${t.ptyState?.terminal.cols ?? "?"}x${t.ptyState?.terminal.rows ?? "?"}`
          : `stdout:${t.stdoutLines} stderr:${t.stderrLines}`;
        return `  ${theme.bold(theme.fg("accent", t.name))} ${theme.fg("dim", `(${t.id})`)} ${theme.fg("muted", dur)} ${theme.fg("dim", output)}`;
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
    const ops = data as {
      spawn?: typeof spawn;
      ptySpawn?: typeof nodePty.spawn;
      resolveShell?: ShellResolver;
    };
    if (ops.spawn) spawnFn = ops.spawn;
    if (ops.ptySpawn) ptySpawnFn = ops.ptySpawn;
    if (ops.resolveShell) resolveShell = ops.resolveShell;
  });

  pi.on("session_start", async (_event, ctx) => { uiCtx = ctx; });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName.startsWith("bg_")) { uiCtx = ctx; updateWidget(); }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopRefreshTimer();
    if (ctx?.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    uiCtx = null;
    for (const task of tasks.values()) task.ptyState?.detach?.("shutdown");
    await Promise.all(Array.from(tasks.values()).map(async (task) => {
      if (!task.process || task.status !== "running") return;
      try {
        await sendTaskSignal(task, "SIGTERM");
        await waitForTaskEnd(task, 3000);
        if (task.status === "running") {
          await sendTaskSignal(task, "SIGKILL");
          await waitForTaskEnd(task, 1000);
        }
      } catch {
        forceKillProcess(task);
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
      "Set pty=true only when a command requires a terminal or TUI interaction; ordinary builds and servers should keep the default pipe mode.",
      "For a finite task whose result is needed, continue other useful work first and then call bg_wait once instead of polling bg_status or bg_logs.",
      "Do not call bg_wait for persistent servers or watchers, or when the task result is not needed before responding.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "A short descriptive name for the task" }),
      command: Type.String({ description: "The shell command to run" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current)" })),
      wait: Type.Optional(Type.Number({ description: "Minimum seconds between status checks (default: 5)", minimum: 1, maximum: 3600 })),
      pty: Type.Optional(Type.Boolean({ description: "Run in a pseudoterminal for interactive/TUI programs (default: false)" })),
      cols: Type.Optional(Type.Number({ description: "Initial PTY columns (default: current terminal or 120)", minimum: 20, maximum: 500 })),
      rows: Type.Optional(Type.Number({ description: "Initial PTY rows (default: current terminal or 30)", minimum: 5, maximum: 200 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
      const dir = await ensureTaskDir();
      const id = generateId();
      const stdoutFile = join(dir, `${id}.stdout`);
      const stderrFile = join(dir, `${id}.stderr`);
      const mode = params.pty ? "pty" : "pipe";
      const shell = resolveShell(params.command, mode === "pty");
      const cwd = params.cwd || ctx.cwd;
      const cols = Math.min(500, Math.max(20, Math.floor(params.cols ?? process.stdout.columns ?? 120)));
      const rows = Math.min(200, Math.max(5, Math.floor(params.rows ?? process.stdout.rows ?? 30)));
      let taskProcess: BackgroundProcess;
      let ptyState: PtyState | null = null;

      if (mode === "pty") {
        const terminal = new HeadlessTerminal({
          cols,
          rows,
          scrollback: 2000,
          allowProposedApi: true,
        });
        const serializer = new SerializeAddon();
        terminal.loadAddon(serializer);
        let ptyProcess: nodePty.IPty;
        try {
          ptyProcess = ptySpawnFn(shell.file, shell.args, {
            name: shell.env.TERM || "xterm-256color",
            cols,
            rows,
            cwd,
            env: { ...shell.env, TERM: shell.env.TERM || "xterm-256color" },
          });
        } catch (error) {
          terminal.dispose();
          throw error;
        }
        taskProcess = { kind: "pty", pid: ptyProcess.pid, pty: ptyProcess };
        ptyState = { terminal, serializer, parsed: Promise.resolve() };
      } else {
        const child = spawnFn(shell.file, shell.args, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: shell.env,
          detached: process.platform !== "win32",
        });
        taskProcess = { kind: "pipe", pid: child.pid ?? 0, child };
      }

      const task: BgTask = {
        id, name: params.name, command: params.command, mode,
        process: taskProcess, ptyState, status: "running",
        exitCode: null, signal: null,
        startedAt: Date.now(), endedAt: null,
        stdoutFile, stderrFile, stdoutLines: 0, stderrLines: 0,
        wait: params.wait ?? 5, nextCheckAt: Date.now() + (params.wait ?? 5) * 1000,
        done: new AbortController(),
        latestLog: null, stdoutPending: "", stderrPending: "",
        requestedStopSignal: null,
      };
      tasks.set(id, task);

      if (taskProcess.kind === "pty") {
        taskProcess.pty.onData((data) => recordPtyData(task, data));
        taskProcess.pty.onExit(({ exitCode, signal }) => {
          finishTask(task, exitCode, signal ? `signal ${signal}` : null);
        });
      } else {
        const child = taskProcess.child;
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
          finishTask(task, code, signal, Boolean(spawnError));
        });
      }

      uiCtx = ctx;
      updateWidget();

      return {
        content: [{ type: "text", text: `Background task started:\n  ID:      ${id}\n  Name:    ${params.name}\n  Command: ${params.command}\n  PID:     ${taskProcess.pid}\n  Mode:    ${mode}${mode === "pty" ? ` (${cols}x${rows}; use /bg-attach ${id} for interactive control)` : ""}\nUse bg_wait once if the final result is needed; do not poll bg_status or bg_logs.` }],
        details: { id, name: params.name, command: params.command, pid: taskProcess.pid, wait: task.wait, mode, cols: mode === "pty" ? cols : undefined, rows: mode === "pty" ? rows : undefined },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const name = args.name ? theme.fg("accent", args.name) : theme.fg("toolOutput", "...");
      const cmd = args.command
        ? theme.fg("muted", `$ ${args.command}`)
        : theme.fg("toolOutput", "...");
      const wait = args.wait ? theme.fg("dim", ` (wait ${args.wait}s)`) : "";
      const mode = args.pty ? theme.fg("dim", " [pty]") : "";
      text.setText(theme.fg("toolTitle", theme.bold(`bg_start `)) + name + ` ${cmd}` + wait + mode);
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

  // ── bg_wait ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_wait",
    label: "BG Wait",
    description: "Wait for a finite background task to finish or until a timeout. A timeout does not stop the task.",
    promptSnippet: "Wait once for a finite background task to finish",
    promptGuidelines: [
      "Use bg_wait once when the final result of a finite background task is required before responding.",
      "Prefer doing other useful work first, then use bg_wait instead of polling bg_status/bg_logs or running a shell sleep command.",
      "For a PTY task, set terminal_snapshot=true when the final terminal screen is needed; it is omitted by default.",
      "Do not use bg_wait for persistent servers or watchers. A timeout leaves the task running; do not immediately call bg_wait again unless the user asks you to keep waiting.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
      timeout: Type.Optional(Type.Number({ description: "Maximum seconds to wait (default: 300)", minimum: 1, maximum: 3600 })),
      terminal_snapshot: Type.Optional(Type.Boolean({ description: "For PTY tasks, include the current terminal screen in the result (default: false)" })),
    }),

    executionMode: "sequential",

    async execute(_toolCallId, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      const task = tasks.get(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };

      const timeoutSeconds = params.timeout ?? 300;
      const timeoutMs = timeoutSeconds * 1000;
      if (task.status === "running") {
        await waitUntilAllowed(timeoutMs, [task.done.signal], signal);
      }
      await flushPty(task);

      const timedOut = task.status === "running";
      const duration = task.endedAt
        ? formatDuration(task.endedAt - task.startedAt)
        : formatDuration(Date.now() - task.startedAt);
      const parts = timedOut
        ? [
            `Timed out after ${formatDuration(timeoutMs)} waiting for task "${task.name}" (${task.id}).`,
            "The task is still running; the timeout did not stop it.",
          ]
        : [`Task "${task.name}" (${task.id}) ${task.status} after ${duration}.`];
      parts.push(
        `  Status:     ${task.status}`,
        `  Duration:   ${duration}`,
      );
      if (task.exitCode !== null) parts.push(`  Exit code:  ${task.exitCode}`);
      if (task.signal) parts.push(`  Signal:     ${task.signal}`);
      parts.push(...formatTaskOutputStats(task));
      if (task.mode === "pipe") parts.push(`  Latest log: ${formatLatestLog(task.latestLog)}`);
      else if (params.terminal_snapshot) parts.push(formatPtyScreenSnapshot(task));
      if (task.mode === "pipe" && !timedOut && task.exitCode === 0 && task.stderrLines > 0) {
        parts.push("  Note: the task exited with code 0 but wrote output to stderr.");
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: {
          id: task.id,
          name: task.name,
          status: task.status,
          timedOut,
          timeout: timeoutSeconds,
          exitCode: task.exitCode,
          signal: task.signal,
          mode: task.mode,
          stdoutLines: task.stdoutLines,
          stderrLines: task.stderrLines,
          latestLog: task.mode === "pipe" ? task.latestLog : null,
          terminalSnapshot: task.mode === "pty" && Boolean(params.terminal_snapshot),
        },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const task = tasks.get(args.id);
      const name = task ? theme.fg("accent", task.name) : theme.fg("muted", args.id);
      const timeout = theme.fg("dim", ` timeout=${args.timeout ?? 300}s`);
      const snapshot = args.terminal_snapshot
        ? theme.fg("dim", ` snapshot (${keyText("app.tools.expand")} ${context.expanded ? "to collapse" : "to expand"})`)
        : "";
      text.setText(theme.fg("toolTitle", theme.bold("bg_wait ")) + name + timeout + snapshot);
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Waiting..."), 0, 0);
      const content = result.content[0]?.type === "text" ? result.content[0].text : "";
      const visibleContent = renderContentWithoutCollapsedSnapshots(content, Boolean(expanded));
      const details = result.details as { status?: BgTask["status"]; timedOut?: boolean } | undefined;
      const color = details?.timedOut
        ? "warning"
        : details?.status === "failed"
          ? "error"
          : details?.status === "stopped"
            ? "warning"
            : "toolOutput";
      return new Text(theme.fg(color, visibleContent) || visibleContent, 0, 0);
    },
  });

  // ── bg_status ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_status",
    label: "BG Status",
    description: "Inspect a background task snapshot or list tasks. This is not a polling or waiting tool.",
    promptSnippet: "Inspect background tasks only when status details are needed",
    promptGuidelines: [
      "Do not poll bg_status after bg_start; use bg_wait once when a finite task's final result is required.",
      "Use bg_status only when the user explicitly asks for current task details, when recovering missing context, or when diagnosing task state.",
      "Use bg_status without id only when a task ID is unknown and a task list is specifically needed.",
      "For PTY tasks, set terminal_snapshot=true only when the current terminal screen is needed; it is omitted by default.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Task ID. If omitted, lists all tasks." })),
      terminal_snapshot: Type.Optional(Type.Boolean({ description: "For PTY tasks, include the current terminal screen in the result (default: false)" })),
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
        await Promise.all(entries.map((task) => flushPty(task)));
        const lines = entries.map((t) => {
          const dur = t.endedAt ? formatDuration(t.endedAt - t.startedAt) : formatDuration(Date.now() - t.startedAt);
          const exit = t.exitCode !== null ? ` exit=${t.exitCode}` : "";
          const summary = `[${t.id}] "${t.name}" ${t.status} ${t.mode} (${dur})${exit}`;
          if (t.mode === "pipe") return `${summary}\n  Latest log: ${formatLatestLog(t.latestLog)}`;
          return summary;
        });
        if (params.terminal_snapshot) {
          lines.push(...entries
            .filter((task) => task.mode === "pty")
            .map((task) => formatPtyScreenSnapshot(task, `"${task.name}" (${task.id})`)));
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { tasks: entries.map((t) => ({ id: t.id, name: t.name, status: t.status, mode: t.mode, latestLog: t.mode === "pipe" ? t.latestLog : null, terminalSnapshot: t.mode === "pty" && Boolean(params.terminal_snapshot) })) },
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
      await flushPty(task);

      const duration = task.endedAt ? formatDuration(task.endedAt - task.startedAt) : formatDuration(Date.now() - task.startedAt);
      const parts: string[] = [
        `Task: ${task.name} (${task.id})`,
        `  Status:    ${task.status}`, `  Command:   ${task.command}`, `  Duration:  ${duration}`,
      ];
      if (task.exitCode !== null) parts.push(`  Exit code: ${task.exitCode}`);
      if (task.signal) parts.push(`  Signal:    ${task.signal}`);
      if (task.process?.pid) parts.push(`  PID:       ${task.process.pid}`);
      parts.push(...formatTaskOutputStats(task));
      if (task.mode === "pipe") parts.push(`  Latest log: ${formatLatestLog(task.latestLog)}`);
      else if (params.terminal_snapshot) parts.push(formatPtyScreenSnapshot(task));
      if (task.status === "running") parts.push("  Use bg_wait to await completion; do not poll bg_status.");

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: { id: task.id, name: task.name, status: task.status, mode: task.mode, exitCode: task.exitCode, signal: task.signal, pid: task.process?.pid, stdoutLines: task.stdoutLines, stderrLines: task.stderrLines, wait: task.wait, latestLog: task.mode === "pipe" ? task.latestLog : null, terminalSnapshot: task.mode === "pty" && Boolean(params.terminal_snapshot) },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const t = args.id ? tasks.get(args.id) : undefined;
      const label = t ? theme.fg("accent", t.name) : args.id ? theme.fg("muted", args.id) : theme.fg("toolOutput", "all");
      const snapshot = args.terminal_snapshot
        ? theme.fg("dim", ` snapshot (${keyText("app.tools.expand")} ${context.expanded ? "to collapse" : "to expand"})`)
        : "";
      text.setText(theme.fg("toolTitle", theme.bold("bg_status ")) + label + snapshot);
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Checking..."), 0, 0);
      const content = result.content[0]?.type === "text" ? result.content[0].text : "";
      const visibleContent = renderContentWithoutCollapsedSnapshots(content, Boolean(expanded));
      const lines = visibleContent.split("\n").map(l => {
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
    description:
      "Read stdout/stderr output or a PTY screen snapshot from a background task for inspection, not for polling progress.",
    promptSnippet: "Read output or a terminal screen snapshot from a background task",
    promptGuidelines: [
      "Use bg_logs to read the output of a background task.",
      "Use bg_logs with tail=N to read the last N lines of output.",
      "PTY tasks return a terminal screen snapshot because stdout and stderr are merged by the pseudoterminal.",
      "Do not repeatedly call bg_logs to wait for progress; use bg_wait once when a finite task's final result is required.",
    ],

    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
      tail: Type.Optional(
        Type.Number({ description: "Read last N lines (default: 100)" }),
      ),
      stream: Type.Optional(
        StringEnum(["stdout", "stderr", "both", "terminal"] as const, {
          description: "Which stream (default: 'both'); use terminal for PTY snapshots",
        }),
      ),
      from_line: Type.Optional(
        Type.Number({
          description: "Start from this line (0-indexed). Overrides tail.",
        }),
      ),
      max_lines: Type.Optional(
        Type.Number({ description: "Max lines with from_line (default: 500)" }),
      ),
    }),

    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const task = tasks.get(params.id);
      if (!task)
        return {
          content: [{ type: "text", text: `Task not found: ${params.id}` }],
          details: {},
        };

      const stream = params.stream || "both";
      const maxLines = params.max_lines || 500;
      const lines = params.tail || 100;
      let stdout = "",
        stderr = "";

      if (task.mode === "pty") {
        await flushPty(task);
        if (stream === "stderr") {
          return {
            content: [{ type: "text", text: "(PTY output combines stdout and stderr; use stream=terminal)" }],
            details: { id: task.id, name: task.name, status: task.status, mode: task.mode },
          };
        }
        const snapshotLines = getPtySnapshotLines(task);
        const selected = params.from_line !== undefined
          ? snapshotLines.slice(params.from_line, params.from_line + maxLines)
          : snapshotLines.slice(-lines);
        const output = selected.join("\n");
        return {
          content: [{ type: "text", text: output ? `── terminal ──\n${output}` : "(no terminal output yet)" }],
          details: {
            id: task.id,
            name: task.name,
            status: task.status,
            mode: task.mode,
            terminalRows: snapshotLines.length,
            cols: task.ptyState?.terminal.cols,
            rows: task.ptyState?.terminal.rows,
          },
        };
      }

      if (stream === "terminal") {
        return {
          content: [{ type: "text", text: "(terminal snapshots are only available for PTY tasks)" }],
          details: { id: task.id, name: task.name, status: task.status, mode: task.mode },
        };
      }

      if (stream === "stdout" || stream === "both")
        stdout =
          params.from_line !== undefined
            ? await readRange(task.stdoutFile, params.from_line, maxLines)
            : await readTail(task.stdoutFile, lines);
      if (stream === "stderr" || stream === "both")
        stderr =
          params.from_line !== undefined
            ? await readRange(task.stderrFile, params.from_line, maxLines)
            : await readTail(task.stderrFile, lines);

      const parts: string[] = [];
      if (stream === "both") {
        if (stdout) parts.push(`── stdout ──\n${stdout}`);
        if (stderr) parts.push(`── stderr ──\n${stderr}`);
        if (!stdout && !stderr) parts.push("(no output yet)");
      } else {
        parts.push(
          stream === "stdout"
            ? stdout || "(no stdout)"
            : stderr || "(no stderr)",
        );
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: {
          id: task.id,
          name: task.name,
          status: task.status,
          stdoutLines: task.stdoutLines,
          stderrLines: task.stderrLines,
        },
      };
    },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const t = tasks.get(args.id);
      const name = t ? theme.fg("accent", t.name) : theme.fg("muted", args.id);
      const extras: string[] = [];
      if (args.tail) extras.push(`tail=${args.tail}`);
      if (args.stream && args.stream !== "both") extras.push(args.stream);
      const extra = extras.length
        ? theme.fg("dim", ` ${extras.join(" ")}`)
        : "";
      const toggleHint = theme.fg(
        "dim",
        ` (${keyText("app.tools.expand")} ${context.expanded ? "to collapse" : "to expand"})`,
      );
      text.setText(
        theme.fg("toolTitle", theme.bold("bg_logs ")) +
          name +
          extra +
          toggleHint,
      );
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (!expanded) {
        text.setText("");
        return text;
      }
      const content =
        result.content[0]?.type === "text" ? result.content[0].text : "";
      const lines = content.split("\n").map((l) => {
        if (l.startsWith("── ") || l.startsWith("-- "))
          return theme.fg("accent", l) || l;
        if (
          l === "(no output yet)" ||
          l === "(no stdout)" ||
          l === "(no stderr)" ||
          l === "(no terminal output yet)"
        )
          return theme.fg("muted", l) || l;
        return theme.fg("toolOutput", l) || l;
      });
      text.setText(`\n${lines.join("\n")}`);
      return text;
    },
  });

  // ── bg_send ────────────────────────────────────────────────────────

  const CTRL: Record<string, Buffer> = {
    "ctrl+l": Buffer.from([0x0c]), "ctrl+u": Buffer.from([0x15]),
    "ctrl+k": Buffer.from([0x0b]), "ctrl+a": Buffer.from([0x01]),
    "ctrl+e": Buffer.from([0x05]),
    "escape": Buffer.from([0x1b]), "tab": Buffer.from([0x09]),
    "backspace": Buffer.from([0x7f]),
  };
  const PTY_CTRL: Record<string, Buffer> = {
    ...CTRL,
    "ctrl+c": Buffer.from([0x03]),
    "ctrl+d": Buffer.from([0x04]),
    "ctrl+z": Buffer.from([0x1a]),
    "ctrl+\\": Buffer.from([0x1c]),
  };
  const SIGNAL_ALIASES: Record<string, NodeJS.Signals> = {
    "ctrl+c": "SIGINT",
    "ctrl+z": "SIGTSTP",
    "ctrl+\\": "SIGQUIT",
  };
  const STOP_SIGNALS = new Set<NodeJS.Signals>(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
  const SEND_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP", "SIGCONT", "SIGUSR1", "SIGUSR2"] as const;

  pi.registerTool({
    name: "bg_send",
    label: "BG Send",
    description: "Send stdin input or an OS control signal to a running background task.",
    promptSnippet: "Send text, EOF, or a control signal to a background task",
    promptGuidelines: [
      "Use bg_send with text to interact with a task's stdin, or with signal to send an OS signal to its process group; provide only one of them.",
      "For pipe tasks, text='ctrl+c', 'ctrl+z', and 'ctrl+\\' send process signals. For PTY tasks, control keywords write terminal control bytes so the foreground TUI handles them normally.",
      "Use text='ctrl+d' or text='eof' to close stdin. Use bg_kill instead when the task must be terminated forcefully.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
      text: Type.Optional(Type.String({ description: "Text to send. Keywords: ctrl+c, ctrl+z, ctrl+\\, ctrl+d, eof, escape, tab, backspace" })),
      signal: Type.Optional(StringEnum(SEND_SIGNALS, { description: "OS signal to send to the task's process group" })),
      raw: Type.Optional(Type.Boolean({ description: "Send raw bytes without newline (default: false)" })),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
      const task = tasks.get(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };
      if (task.status !== "running") return { content: [{ type: "text", text: `Task "${task.name}" is not running.` }], details: {} };
      if (!task.process) return { content: [{ type: "text", text: `Task "${task.name}" process is unavailable.` }], details: {} };

      if (params.text !== undefined && params.signal !== undefined) {
        return { content: [{ type: "text", text: "Provide either text or signal, not both." }], details: {} };
      }
      if (params.text === undefined && params.signal === undefined) {
        return { content: [{ type: "text", text: "Provide text or signal to send." }], details: {} };
      }

      const keyword = params.text?.toLowerCase().trim();
      if (task.mode === "pty" && keyword && PTY_CTRL[keyword]) {
        const data = PTY_CTRL[keyword];
        try {
          writeTaskInput(task, data);
          return {
            content: [{ type: "text", text: `Sent ${keyword} to "${task.name}" PTY (${data.length} byte).` }],
            details: { id: task.id, name: task.name, bytes: data.length, keyword, mode: task.mode },
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      }

      const signal = params.signal ?? (keyword ? SIGNAL_ALIASES[keyword] : undefined);
      if (signal) {
        const previousStopSignal = task.requestedStopSignal;
        if (STOP_SIGNALS.has(signal)) task.requestedStopSignal = signal;
        try {
          await sendProcessSignal(task, signal);
          return {
            content: [{ type: "text", text: `Sent ${signal} to "${task.name}" process group.` }],
            details: { id: task.id, name: task.name, signal },
          };
        } catch (err) {
          task.requestedStopSignal = previousStopSignal;
          return { content: [{ type: "text", text: `Failed to send ${signal}: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      }

      if (keyword === "ctrl+d" || keyword === "eof") {
        closeTaskInput(task);
        return {
          content: [{ type: "text", text: task.mode === "pty" ? `Sent EOF (Ctrl+D) to "${task.name}" PTY.` : `Closed stdin for "${task.name}".` }],
          details: { id: task.id, name: task.name, eof: true },
        };
      }

      const input = params.text ?? "";
      const data = (keyword && CTRL[keyword]) || (params.raw ? Buffer.from(input, "utf-8") : Buffer.from(input + (task.mode === "pty" ? "\r" : "\n"), "utf-8"));
      const desc = keyword && CTRL[keyword] ? keyword : params.raw ? `raw(${input})` : JSON.stringify(input);

      try {
        writeTaskInput(task, data);
        return { content: [{ type: "text", text: `Sent to "${task.name}": ${desc} (${data.length} bytes)` }], details: { id: task.id, name: task.name, bytes: data.length, keyword, mode: task.mode } };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
      }
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const t = tasks.get(args.id);
      const name = t ? theme.fg("accent", t.name) : theme.fg("muted", args.id);
      const value = args.signal ?? args.text;
      const input = value ? theme.fg("dim", ` → ${value}`) : "";
      text.setText(theme.fg("toolTitle", theme.bold("bg_send ")) + name + input);
      return text;
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Sending..."), 0, 0);
      const content = result.content[0]?.type === "text" ? result.content[0].text : "";
      return new Text(theme.fg("toolOutput", content) || content, 0, 0);
    },
  });

  // ── bg_kill ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_kill",
    label: "BG Kill",
    description: "Terminate a background task. Sends SIGTERM by default or SIGKILL with force=true.",
    promptSnippet: "Terminate an unresponsive background task",
    promptGuidelines: [
      "Use bg_kill when a background task needs to be terminated.",
      "Use bg_kill with force=true to send SIGKILL immediately; otherwise it sends SIGTERM.",
      "For PTY tasks, set terminal_snapshot=true when the final terminal screen is needed; it is omitted by default.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
      force: Type.Optional(Type.Boolean({ description: "Send SIGKILL instead of SIGTERM (default: false)" })),
      terminal_snapshot: Type.Optional(Type.Boolean({ description: "For PTY tasks, include the final terminal screen in the result (default: false)" })),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
      const task = tasks.get(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };
      if (task.status !== "running") return { content: [{ type: "text", text: `Task "${task.name}" is already ${task.status}.` }], details: {} };

      const signal = params.force ? "SIGKILL" : "SIGTERM";
      try {
        await sendTaskSignal(task, signal);
      }
      catch (err) {
        return { content: [{ type: "text", text: `Failed to send ${signal}: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
      }

      await waitForTaskEnd(task, params.force ? 500 : 2500);

      const action = task.status === "running" ? `Sent ${signal} to` : "Terminated";
      const parts = [`${action} "${task.name}". Status: ${task.status}`];
      if (task.mode === "pty") {
        await flushPty(task);
        if (params.terminal_snapshot) parts.push(formatPtyScreenSnapshot(task));
      } else {
        parts.push(`  Latest log: ${formatLatestLog(task.latestLog)}`);
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: { id: task.id, name: task.name, status: task.status, signal, mode: task.mode, latestLog: task.mode === "pipe" ? task.latestLog : null, terminalSnapshot: task.mode === "pty" && Boolean(params.terminal_snapshot) },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const t = tasks.get(args.id);
      const name = t ? theme.fg("accent", t.name) : theme.fg("muted", args.id);
      const sig = args.force ? theme.fg("error", " SIGKILL") : "";
      const snapshot = args.terminal_snapshot
        ? theme.fg("dim", ` snapshot (${keyText("app.tools.expand")} ${context.expanded ? "to collapse" : "to expand"})`)
        : "";
      text.setText(theme.fg("toolTitle", theme.bold("bg_kill ")) + name + sig + snapshot);
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Killing..."), 0, 0);
      const content = result.content[0]?.type === "text" ? result.content[0].text : "";
      const visibleContent = renderContentWithoutCollapsedSnapshots(content, Boolean(expanded));
      const lines = visibleContent.split("\n").map(l => {
        if (l.includes("SIGKILL")) return theme.fg("error", l) || l;
        if (l.includes("SIGTERM")) return theme.fg("warning", l) || l;
        if (l.startsWith("── ") || l.startsWith("-- ")) return theme.fg("accent", l) || l;
        return theme.fg("toolOutput", l) || l;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ── /bg-attach command ─────────────────────────────────────────────

  pi.registerCommand("bg-attach", {
    description: "Attach the terminal to a running PTY background task (Ctrl+] to detach)",
    getArgumentCompletions: (prefix: string) => {
      const items = Array.from(tasks.values())
        .filter((task) => task.mode === "pty" && task.status === "running")
        .map((task) => ({ value: task.id, label: `${task.id} ${task.name}` }));
      return items.filter((item) => item.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      let id = args.trim().split(/\s+/, 1)[0];
      if (!id) {
        const running = Array.from(tasks.values()).filter((task) => task.mode === "pty" && task.status === "running");
        if (running.length === 0) {
          ctx.ui.notify("No running PTY tasks.", "info");
          return;
        }
        const choice = await ctx.ui.select(
          "Attach to which PTY task? (Ctrl+] to detach)",
          running.map((task) => `${task.id} ${task.name}`),
        );
        if (!choice) return;
        id = choice.split(" ", 1)[0];
      }

      const task = tasks.get(id);
      if (!task) {
        ctx.ui.notify(`Task not found: ${id}`, "error");
        return;
      }
      await attachPtyTask(task, ctx);
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

      try {
        await sendTaskSignal(task, "SIGKILL");
      } catch (error) {
        ctx.ui.notify(`Failed to kill "${task.name}": ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      await waitForTaskEnd(task, 500);
      ctx.ui.notify(`Stop requested for "${task.name}" (${task.id}); status: ${task.status}`, "info");
    },
  });
}
