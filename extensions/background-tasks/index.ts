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
 *   - Per-task console sessions with detachable PTY interaction or retained/live pipe output
 *   - Explicit completion waits with timeout (no polling required)
 *   - Abortable completion waits
 *   - Live widget with one-second duration updates
 *   - Extensible spawn backend via pi.events
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/background-tasks/
 *   Or: pi -e ./background-tasks/
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { stripVTControlCharacters } from "node:util";
import {
  getShellConfig,
  keyText,
  SettingsManager,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
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

type ConsoleData = string | Buffer;
type MouseEncodingMode = "default" | "utf8" | "sgr" | "urxvt" | "sgr-pixels";

interface ConsoleSession {
  terminal: XtermTerminal;
  serializer: XtermSerializeAddon;
  parsed: Promise<void>;
  catchUpBuffer: ConsoleData[] | null;
  mouseEncodingMode: MouseEncodingMode;
  subscriber?: (data: ConsoleData) => void;
}

type AttachmentReason = "detached" | "shutdown";

interface AttachmentState {
  detach?: (reason: AttachmentReason) => void;
  taskExited?: () => void;
}

interface ShellLaunch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  initialStdin?: string;
}

interface ShellResolverContext {
  cwd: string;
  projectTrusted: boolean;
}

type ShellResolver = (command: string, interactive: boolean, context?: ShellResolverContext) => ShellLaunch;

interface BgTask {
  id: string;
  name: string;
  command: string;
  mode: "pipe" | "pty";
  process: BackgroundProcess | null;
  console: ConsoleSession;
  attachment: AttachmentState;
  status: "running" | "completed" | "failed" | "stopped";
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  endedAt: number | null;
  stdoutLogKey: string;
  stderrLogKey: string;
  stdoutLines: number;
  stderrLines: number;
  done: AbortController;
  latestLog: LatestLog | null;
  finalLog?: LatestLog | null;
  retainForNextAgentTurn: boolean;
  stdoutPending: string;
  stderrPending: string;
  requestedStopSignal: NodeJS.Signals | null;
}

interface LatestLog {
  stream: "stdout" | "stderr" | "terminal";
  text: string;
  at: number;
}

interface BgWaitRenderState {
  startedAt?: number;
  interval?: ReturnType<typeof setInterval>;
}

interface StoredLog {
  chunks: Buffer[];
  firstChunk: number;
  size: number;
}

export class MemoryLogStore {
  private readonly logs = new Map<string, StoredLog>();

  constructor(readonly maxLogBytes = 4 * 1024 * 1024) {
    if (!Number.isInteger(maxLogBytes) || maxLogBytes < 1) {
      throw new Error("Log capacity must be a positive integer");
    }
  }

  append(key: string, data: Buffer | string): void {
    const chunk = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, "utf8");
    if (chunk.length === 0) return;

    const log = this.logs.get(key) ?? { chunks: [], firstChunk: 0, size: 0 };
    log.chunks.push(chunk);
    log.size += chunk.length;
    this.trim(log);
    this.logs.set(key, log);
  }

  read(key: string): string {
    const log = this.logs.get(key);
    if (!log || log.size === 0) return "";
    return Buffer.concat(log.chunks.slice(log.firstChunk), log.size).toString("utf8");
  }

  delete(key: string): void {
    this.logs.delete(key);
  }

  clear(): void {
    this.logs.clear();
  }

  size(key: string): number {
    return this.logs.get(key)?.size ?? 0;
  }

  private trim(log: StoredLog): void {
    let excess = log.size - this.maxLogBytes;
    while (excess > 0) {
      const first = log.chunks[log.firstChunk];
      if (!first) break;
      if (first.length <= excess) {
        log.firstChunk += 1;
        log.size -= first.length;
        excess -= first.length;
        continue;
      }
      log.chunks[log.firstChunk] = Buffer.from(first.subarray(excess));
      log.size -= excess;
      excess = 0;
    }

    if (log.firstChunk >= 1024 && log.firstChunk * 2 >= log.chunks.length) {
      log.chunks = log.chunks.slice(log.firstChunk);
      log.firstChunk = 0;
    }
  }
}

// ── Execution Backend ─────────────────────────────────────────────────

let spawnFn: typeof spawn = spawn;
let ptySpawnFn: typeof nodePty.spawn = nodePty.spawn;
let terminalInput: NodeJS.ReadStream = process.stdin;
let terminalOutput: NodeJS.WriteStream = process.stdout;

function defaultShellResolver(
  command: string,
  interactive: boolean,
  context?: ShellResolverContext,
): ShellLaunch {
  const settings = context
    ? SettingsManager.create(context.cwd, undefined, { projectTrusted: context.projectTrusted })
    : undefined;
  const prefix = settings?.getShellCommandPrefix();
  const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
  const shell = getShellConfig(settings?.getShellPath());

  if (shell.commandTransport === "stdin") {
    if (interactive) {
      throw new Error(
        "The configured legacy WSL bash transport cannot start PTY background tasks. " +
        "Use pipe mode or configure a modern Git Bash, Cygwin, or MSYS2 bash executable.",
      );
    }
    return {
      file: shell.shell,
      args: [...shell.args],
      env: { ...process.env },
      initialStdin: resolvedCommand,
    };
  }

  return {
    file: shell.shell,
    args: [...shell.args, resolvedCommand],
    env: { ...process.env },
  };
}

let resolveShell: ShellResolver = defaultShellResolver;

// ── Helpers ────────────────────────────────────────────────────────────

const tasks = new Map<string, BgTask>();
const runningTasks = new Set<BgTask>();
const outputLogStore = new MemoryLogStore();

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function taskLogKey(id: string, stream: "stdout" | "stderr"): string {
  return `${id}:${stream}`;
}

function createConsoleSession(cols: number, rows: number, mode: "pipe" | "pty"): ConsoleSession {
  const terminal = new HeadlessTerminal({
    cols,
    rows,
    scrollback: 2000,
    allowProposedApi: true,
    // Pipe output commonly uses LF without CR. Treat LF as a new line so the
    // retained snapshot matches how ordinary stdout is displayed by a TTY.
    convertEol: mode === "pipe",
  });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  const session: ConsoleSession = {
    terminal,
    serializer,
    parsed: Promise.resolve(),
    catchUpBuffer: null,
    mouseEncodingMode: "default",
  };

  const trackMouseEncoding = (enabled: boolean) => (params: (number | number[])[]) => {
    for (const param of params) {
      if (typeof param !== "number") continue;
      if (!enabled && (param === 1005 || param === 1006 || param === 1015 || param === 1016)) {
        session.mouseEncodingMode = "default";
        continue;
      }
      if (!enabled) continue;
      if (param === 1005) session.mouseEncodingMode = "utf8";
      else if (param === 1006) session.mouseEncodingMode = "sgr";
      else if (param === 1015) session.mouseEncodingMode = "urxvt";
      else if (param === 1016) session.mouseEncodingMode = "sgr-pixels";
    }
    // Keep xterm's built-in mode handler active.
    return false;
  };
  terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, trackMouseEncoding(true));
  terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, trackMouseEncoding(false));
  return session;
}

function sanitizeLogOutput(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitLogLines(text: string): string[] {
  const lines = sanitizeLogOutput(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function readTail(logKey: string, lines: number): string {
  return splitLogLines(outputLogStore.read(logKey)).slice(-lines).join("\n");
}

function readRange(logKey: string, fromLine: number, maxLines: number): string {
  return splitLogLines(outputLogStore.read(logKey)).slice(fromLine, fromLine + maxLines).join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

function formatElapsedSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

const MAX_STORED_LOG_CHARS = 500;
const MAX_DISPLAY_LOG_CHARS = 240;

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function renderTaskCallLabel(id: unknown, theme: Theme): string {
  const taskId = typeof id === "string" ? id.trim() : "";
  if (!taskId) return "";
  const task = tasks.get(taskId);
  return task ? theme.fg("accent", task.name) : theme.fg("muted", taskId);
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

function getTerminalSnapshotLines(task: BgTask): string[] {
  const terminal = task.console.terminal;
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
  const rows = task.console.terminal.rows;
  const snapshot = getTerminalSnapshotLines(task).slice(-rows).join("\n");
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
  const latestText = getTerminalSnapshotLines(task).findLast((line) => line.trim().length > 0)?.trim();
  if (!latestText) return;
  task.latestLog = {
    stream: "terminal",
    text: truncateText(latestText, MAX_STORED_LOG_CHARS),
    at: Date.now(),
  };
}

function writeConsoleData(task: BgTask, data: ConsoleData): void {
  const session = task.console;
  session.parsed = session.parsed.then(() =>
    new Promise<void>((resolve) => {
      session.terminal.write(data, () => {
        if (task.mode === "pty") updatePtyLatestLog(task);
        resolve();
      });
    }),
  );
}

function appendTaskLog(logKey: string, data: Buffer | string): void {
  outputLogStore.append(logKey, data);
}

function recordPtyData(task: BgTask, data: string): void {
  task.stdoutLines += data.split("\n").length - 1;

  const session = task.console;
  if (session.catchUpBuffer !== null) {
    session.catchUpBuffer.push(data);
    return;
  }
  writeConsoleData(task, data);
  session.subscriber?.(data);
}

function recordPipeData(task: BgTask, stream: "stdout" | "stderr", data: Buffer): void {
  if (stream === "stdout") task.stdoutLines += data.toString().split("\n").length - 1;
  else task.stderrLines += data.toString().split("\n").length - 1;
  updateLatestLog(task, stream, data);
  appendTaskLog(stream === "stdout" ? task.stdoutLogKey : task.stderrLogKey, data);

  const session = task.console;
  if (session.catchUpBuffer !== null) {
    session.catchUpBuffer.push(data);
    return;
  }
  writeConsoleData(task, data);
  session.subscriber?.(data);
}

function beginConsoleCatchUp(task: BgTask): ConsoleData[] {
  const session = task.console;
  if (session.catchUpBuffer !== null) throw new Error(`Task "${task.name}" already has an attach catch-up in progress.`);
  const buffer: ConsoleData[] = [];
  session.catchUpBuffer = buffer;
  return buffer;
}

function releaseConsoleCatchUp(task: BgTask, buffer: ConsoleData[]): void {
  const session = task.console;
  if (session.catchUpBuffer !== buffer) return;
  session.catchUpBuffer = null;

  for (const data of buffer) writeConsoleData(task, data);
  const writer = session.subscriber;
  if (writer) {
    for (const data of buffer) writer(data);
  }
}

async function flushConsole(task: BgTask): Promise<void> {
  await task.console.parsed;
}

function deleteTaskLogs(task: BgTask): void {
  outputLogStore.delete(task.stdoutLogKey);
  outputLogStore.delete(task.stderrLogKey);
}

function formatTaskOutputStats(task: BgTask): string[] {
  if (task.mode === "pty") {
    const terminal = task.console.terminal;
    const dimensions = ` (${terminal.cols}x${terminal.rows})`;
    return [
      `  Mode:       pty${dimensions}`,
      `  Terminal:   ${getTerminalSnapshotLines(task).length} rows`,
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
  runningTasks.delete(task);
  task.done.abort();
  task.attachment.taskExited?.();
  updateWidget();
  void flushConsole(task).then(() => {
    task.finalLog = task.latestLog ? { ...task.latestLog } : null;
    updateWidget();
  });
}

const ATTACH_DETACH_KEY = "\x1d";
const ATTACH_RESIZE_DEBOUNCE_MS = 40;
const MIN_TERMINAL_COLS = 20;
const MAX_TERMINAL_COLS = 500;
const MIN_TERMINAL_ROWS = 5;
const MAX_TERMINAL_ROWS = 200;
const FINISHED_ATTACH_HINT = "Task finished - Ctrl+] to return";
const TERMINAL_INPUT_MODE_RESET = [
  "\x1b[?9l", "\x1b[?1000l", "\x1b[?1001l", "\x1b[?1002l", "\x1b[?1003l",
  "\x1b[?1004l", "\x1b[?1005l", "\x1b[?1006l", "\x1b[?1007l",
  "\x1b[?1015l", "\x1b[?1016l", "\x1b[?2004l",
].join("");
const TERMINAL_RESET = [
  TERMINAL_INPUT_MODE_RESET,
  "\x1b[?1049l", "\x1b[0m", "\x1b[?25h", "\x1b[2J", "\x1b[H",
].join("");
const ATTACH_STATUS_GRACE_MS = 100;

function writePipeFinishedHint(): void {
  terminalOutput.write(TERMINAL_INPUT_MODE_RESET);
  terminalOutput.write(`\r\n[${FINISHED_ATTACH_HINT}]\r\n`);
}

function writePtyFinishedView(task: BgTask): void {
  const cols = Math.max(1, Math.floor(terminalOutput.columns || task.console.terminal.cols || 80));
  const rows = Math.max(1, Math.floor(terminalOutput.rows || task.console.terminal.rows || 24));
  const hint = ` ${FINISHED_ATTACH_HINT} `.slice(0, cols);
  const column = Math.max(1, cols - hint.length + 1);

  terminalOutput.write("\x1b[2J\x1b[H");
  terminalOutput.write(task.console.serializer.serialize({ scrollback: 200 }));
  terminalOutput.write(TERMINAL_INPUT_MODE_RESET);
  terminalOutput.write(`\x1b7\x1b[${rows};${column}H\x1b[7m${hint}\x1b[0m\x1b8`);
}

function serializeMouseEncodingMode(mode: MouseEncodingMode): string {
  if (mode === "utf8") return "\x1b[?1005h";
  if (mode === "sgr") return "\x1b[?1006h";
  if (mode === "urxvt") return "\x1b[?1015h";
  if (mode === "sgr-pixels") return "\x1b[?1016h";
  return "";
}

async function notifyAttachmentResult(
  task: BgTask,
  modeLabel: "PTY" | "Pipe",
  reason: AttachmentReason,
  attachError: string | undefined,
  ctx: ExtensionContext,
): Promise<void> {
  if (attachError) {
    ctx.ui.notify(`${modeLabel} attachment failed: ${attachError}`, "error");
    return;
  }
  if (reason === "shutdown") return;

  if (reason === "detached" && task.status === "running") {
    await waitForTaskEnd(task, ATTACH_STATUS_GRACE_MS);
  }
  if (task.status !== "running") {
    const detail = task.exitCode !== null
      ? ` (exit code ${task.exitCode})`
      : task.signal
        ? ` (${task.signal})`
        : "";
    ctx.ui.notify(
      `${modeLabel} task "${task.name}" ${task.status}${detail}.`,
      task.status === "failed" ? "error" : "info",
    );
    return;
  }
  ctx.ui.notify(`Detached from "${task.name}".`, "info");
}

async function attachFinishedTaskSnapshot(
  task: BgTask,
  modeLabel: "PTY" | "Pipe",
  ctx: ExtensionContext,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(`${modeLabel} attachment requires Pi TUI mode.`, "warning");
    return;
  }
  if (task.attachment.detach) {
    ctx.ui.notify(`Task "${task.name}" is already attached.`, "warning");
    return;
  }

  let attachError: string | undefined;
  const reason = await ctx.ui.custom<AttachmentReason>((tui, _theme, _keybindings, done) => {
    let cleaned = false;
    let terminalStarted = false;
    let rawBeforeAttach = false;
    let inputHandler: ((data: string | Buffer) => void) | undefined;

    const cleanup = (result: AttachmentReason) => {
      if (cleaned) return;
      cleaned = true;
      task.attachment.detach = undefined;
      task.attachment.taskExited = undefined;
      if (inputHandler) terminalInput.removeListener("data", inputHandler);
      if (terminalStarted) {
        terminalInput.pause();
        terminalInput.setRawMode?.(rawBeforeAttach);
        terminalOutput.write(TERMINAL_RESET);
        tui.start();
        tui.requestRender(true);
      }
      done(result);
    };

    task.attachment.detach = cleanup;

    queueMicrotask(async () => {
      try {
        if (cleaned) return;
        tui.stop();
        terminalStarted = true;
        rawBeforeAttach = terminalInput.isRaw || false;
        terminalInput.setRawMode?.(true);
        terminalInput.setEncoding("utf8");
        terminalInput.resume();

        inputHandler = (chunk) => {
          const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
          if (data.includes(ATTACH_DETACH_KEY)) cleanup("detached");
        };
        terminalInput.on("data", inputHandler);

        await flushConsole(task);
        if (cleaned) return;
        if (modeLabel === "PTY") {
          writePtyFinishedView(task);
        } else {
          terminalOutput.write("\x1b[2J\x1b[H");
          terminalOutput.write(task.console.serializer.serialize({ scrollback: 200 }));
          writePipeFinishedHint();
        }
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

  await notifyAttachmentResult(task, modeLabel, reason, attachError, ctx);
}

async function attachPtyTask(task: BgTask, ctx: ExtensionContext): Promise<void> {
  const state = task.console;
  const taskProcess = task.process;
  if (task.mode !== "pty") {
    ctx.ui.notify(`Task "${task.name}" is not a PTY task.`, "warning");
    return;
  }
  if (task.status !== "running") {
    await attachFinishedTaskSnapshot(task, "PTY", ctx);
    return;
  }
  if (!taskProcess || taskProcess.kind !== "pty") {
    ctx.ui.notify(`Task "${task.name}" process is unavailable.`, "warning");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify("PTY attachment requires Pi TUI mode.", "warning");
    return;
  }
  if (task.attachment.detach) {
    ctx.ui.notify(`Task "${task.name}" is already attached.`, "warning");
    return;
  }

  let attachError: string | undefined;
  const reason = await ctx.ui.custom<AttachmentReason>((tui, _theme, _keybindings, done) => {
    let cleaned = false;
    let terminalStarted = false;
    let rawBeforeAttach = false;
    let catchUpBuffer: ConsoleData[] | null = null;
    let inputHandler: ((data: string | Buffer) => void) | undefined;
    let resizeHandler: (() => void) | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let attachmentReady = false;
    let finishedViewScheduled = false;
    let finishedViewShown = false;

    const cleanup = (result: AttachmentReason) => {
      if (cleaned) return;
      cleaned = true;
      state.subscriber = undefined;
      task.attachment.detach = undefined;
      task.attachment.taskExited = undefined;
      if (inputHandler) terminalInput.removeListener("data", inputHandler);
      if (resizeHandler) terminalOutput.removeListener("resize", resizeHandler);
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = undefined;
      }
      if (catchUpBuffer) {
        releaseConsoleCatchUp(task, catchUpBuffer);
        catchUpBuffer = null;
      }
      if (terminalStarted) {
        terminalInput.pause();
        terminalInput.setRawMode?.(rawBeforeAttach);
        terminalOutput.write(TERMINAL_RESET);
        tui.start();
        tui.requestRender(true);
      }
      done(result);
    };

    const showFinishedView = () => {
      if (cleaned || !attachmentReady || finishedViewScheduled) return;
      finishedViewScheduled = true;
      void flushConsole(task).then(() => {
        if (cleaned) return;
        state.subscriber = undefined;
        finishedViewShown = true;
        writePtyFinishedView(task);
      }).catch((error) => {
        attachError = error instanceof Error ? error.message : String(error);
        cleanup("detached");
      });
    };

    task.attachment.detach = cleanup;
    task.attachment.taskExited = showFinishedView;

    queueMicrotask(async () => {
      try {
        if (cleaned) return;
        tui.stop();
        terminalStarted = true;
        rawBeforeAttach = terminalInput.isRaw || false;
        terminalInput.setRawMode?.(true);
        terminalInput.setEncoding("utf8");
        terminalInput.resume();

        inputHandler = (chunk) => {
          const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
          const detachAt = data.indexOf(ATTACH_DETACH_KEY);
          if (detachAt >= 0) {
            if (task.status === "running" && detachAt > 0) taskProcess.pty.write(data.slice(0, detachAt));
            cleanup("detached");
            return;
          }
          if (task.status === "running") taskProcess.pty.write(data);
        };
        const applyResize = () => {
          const cols = Math.min(MAX_TERMINAL_COLS, Math.max(
            MIN_TERMINAL_COLS,
            Math.floor(terminalOutput.columns || state.terminal.cols || 80),
          ));
          const rows = Math.min(MAX_TERMINAL_ROWS, Math.max(
            MIN_TERMINAL_ROWS,
            Math.floor(terminalOutput.rows || state.terminal.rows || 24),
          ));
          state.terminal.resize(cols, rows);
          if (task.process?.kind === "pty") task.process.pty.resize(cols, rows);
        };
        resizeHandler = () => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = undefined;
            applyResize();
            if (finishedViewShown) writePtyFinishedView(task);
          }, ATTACH_RESIZE_DEBOUNCE_MS);
        };

        terminalInput.on("data", inputHandler);
        terminalOutput.on("resize", resizeHandler);
        catchUpBuffer = beginConsoleCatchUp(task);
        await flushConsole(task);
        if (cleaned) return;
        applyResize();
        terminalOutput.write("\x1b[2J\x1b[H");
        terminalOutput.write(state.serializer.serialize({ scrollback: 200 }));
        const mouseEncodingSequence = serializeMouseEncodingMode(state.mouseEncodingMode);
        if (mouseEncodingSequence) terminalOutput.write(mouseEncodingSequence);
        state.subscriber = (data) => terminalOutput.write(data);
        releaseConsoleCatchUp(task, catchUpBuffer);
        catchUpBuffer = null;
        attachmentReady = true;
        if (task.status !== "running") showFinishedView();
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

  await notifyAttachmentResult(task, "PTY", reason, attachError, ctx);
}

async function attachPipeTask(task: BgTask, ctx: ExtensionContext): Promise<void> {
  const taskProcess = task.process;
  const state = task.console;
  if (task.mode !== "pipe") {
    ctx.ui.notify(`Task "${task.name}" is not a pipe task.`, "warning");
    return;
  }
  if (task.status !== "running") {
    await attachFinishedTaskSnapshot(task, "Pipe", ctx);
    return;
  }
  if (!taskProcess || taskProcess.kind !== "pipe") {
    ctx.ui.notify(`Task "${task.name}" process is unavailable.`, "warning");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Pipe attachment requires Pi TUI mode.", "warning");
    return;
  }
  if (task.attachment.detach) {
    ctx.ui.notify(`Task "${task.name}" is already attached.`, "warning");
    return;
  }

  let attachError: string | undefined;
  const reason = await ctx.ui.custom<AttachmentReason>((tui, _theme, _keybindings, done) => {
    let cleaned = false;
    let terminalStarted = false;
    let rawBeforeAttach = false;
    let catchUpBuffer: ConsoleData[] | null = null;
    let inputHandler: ((data: string | Buffer) => void) | undefined;
    let attachmentReady = false;
    let finishedHintScheduled = false;

    const cleanup = (result: AttachmentReason) => {
      if (cleaned) return;
      cleaned = true;
      state.subscriber = undefined;
      task.attachment.detach = undefined;
      task.attachment.taskExited = undefined;
      if (inputHandler) terminalInput.removeListener("data", inputHandler);
      if (catchUpBuffer) {
        releaseConsoleCatchUp(task, catchUpBuffer);
        catchUpBuffer = null;
      }
      if (terminalStarted) {
        terminalInput.pause();
        terminalInput.setRawMode?.(rawBeforeAttach);
        terminalOutput.write(TERMINAL_RESET);
        tui.start();
        tui.requestRender(true);
      }
      done(result);
    };

    const showFinishedHint = () => {
      if (cleaned || !attachmentReady || finishedHintScheduled) return;
      finishedHintScheduled = true;
      void flushConsole(task).then(() => {
        if (cleaned) return;
        state.subscriber = undefined;
        writePipeFinishedHint();
      }).catch((error) => {
        attachError = error instanceof Error ? error.message : String(error);
        cleanup("detached");
      });
    };

    task.attachment.detach = cleanup;
    task.attachment.taskExited = showFinishedHint;

    queueMicrotask(async () => {
      try {
        if (cleaned) return;
        tui.stop();
        terminalStarted = true;
        rawBeforeAttach = terminalInput.isRaw || false;
        terminalInput.setRawMode?.(true);
        terminalInput.setEncoding("utf8");
        terminalInput.resume();

        inputHandler = (chunk) => {
          const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
          if (data.includes(ATTACH_DETACH_KEY)) cleanup("detached");
        };

        terminalInput.on("data", inputHandler);
        catchUpBuffer = beginConsoleCatchUp(task);
        await flushConsole(task);
        if (cleaned) return;

        const cols = Math.min(MAX_TERMINAL_COLS, Math.max(
          MIN_TERMINAL_COLS,
          Math.floor(terminalOutput.columns || state.terminal.cols || 80),
        ));
        const rows = Math.min(MAX_TERMINAL_ROWS, Math.max(
          MIN_TERMINAL_ROWS,
          Math.floor(terminalOutput.rows || state.terminal.rows || 24),
        ));
        state.terminal.resize(cols, rows);
        terminalOutput.write("\x1b[2J\x1b[H");
        terminalOutput.write(state.serializer.serialize({ scrollback: 200 }));
        state.subscriber = (data) => terminalOutput.write(data);
        releaseConsoleCatchUp(task, catchUpBuffer);
        catchUpBuffer = null;
        attachmentReady = true;
        if (task.status !== "running") showFinishedHint();
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

  await notifyAttachmentResult(task, "Pipe", reason, attachError, ctx);
}

async function attachTask(task: BgTask, ctx: ExtensionContext): Promise<void> {
  if (task.mode === "pty") await attachPtyTask(task, ctx);
  else await attachPipeTask(task, ctx);
}

// ── Widget ─────────────────────────────────────────────────────────────

const WIDGET_KEY = "bg-tasks-widget";
const WIDGET_REFRESH_INTERVAL_MS = 1000;
const COLLAPSED_WIDGET_TASK_LIMIT = 3;
let uiCtx: ExtensionContext | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let widgetTui: TUI | null = null;
let widgetRegistered = false;

function getRunningTasks(): BgTask[] {
  return Array.from(runningTasks);
}

function getVisibleTasks(): BgTask[] {
  return Array.from(tasks.values());
}

function getBackgroundWidgetTasks(visible: BgTask[], expanded: boolean): BgTask[] {
  if (expanded || visible.length <= COLLAPSED_WIDGET_TASK_LIMIT) return visible;
  return [
    ...visible.filter((task) => task.status === "running"),
    ...visible.filter((task) => task.status !== "running"),
  ].slice(0, COLLAPSED_WIDGET_TASK_LIMIT);
}

async function discardExpiredFinishedTasks(): Promise<boolean> {
  const expired = Array.from(tasks.values()).filter(
    (task) => task.status !== "running" && !task.retainForNextAgentTurn,
  );
  for (const task of tasks.values()) task.retainForNextAgentTurn = false;
  for (const task of expired) tasks.delete(task.id);
  await Promise.all(expired.map(async (task) => {
    await flushConsole(task);
    task.console.terminal.dispose();
    deleteTaskLogs(task);
  }));
  return expired.length > 0;
}

function getTaskDisplayLog(task: BgTask): LatestLog | null {
  if (task.status === "running" || task.finalLog === undefined) return task.latestLog;
  return task.finalLog;
}

function stopRefreshTimer() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(updateWidget, WIDGET_REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

function formatWidgetDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
  }
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function renderWidgetLines(theme?: Theme, width = MAX_DISPLAY_LOG_CHARS, expanded = false): string[] {
  const visible = getVisibleTasks();
  const displayed = getBackgroundWidgetTasks(visible, expanded);
  const runningCount = getRunningTasks().length;
  const finishedCount = visible.length - runningCount;
  const now = Date.now();
  const lines: string[] = [];

  for (const [index, task] of displayed.entries()) {
    const isLast = index === displayed.length - 1;
    const branch = isLast ? "└─" : "├─";
    const duration = formatWidgetDuration((task.endedAt ?? now) - task.startedAt);
    if (task.status === "running") {
      const output = task.mode === "pty"
        ? `pty:${task.console.terminal.cols}x${task.console.terminal.rows}`
        : `stdout:${task.stdoutLines} stderr:${task.stderrLines}`;
      lines.push(theme
        ? `${theme.fg("dim", branch)} ${theme.fg("warning", "◐")} ${theme.bold(theme.fg("accent", task.name))} ${theme.fg("dim", `(${task.id})`)} ${theme.fg("muted", duration)} ${theme.fg("dim", output)}`
        : `${branch} ◐ ${task.name} (${task.id}) ${duration} ${output}`);
      continue;
    }

    const glyph = task.status === "completed" ? "✓" : task.status === "failed" ? "×" : "■";
    const color = task.status === "completed" ? "success" : task.status === "failed" ? "error" : "warning";
    const exit = task.exitCode !== null ? ` exit=${task.exitCode}` : "";
    const signal = task.signal ? ` signal=${task.signal}` : "";
    lines.push(theme
      ? `${theme.fg("dim", branch)} ${theme.fg(color, glyph)} ${theme.bold(theme.fg("accent", task.name))} ${theme.fg("dim", `(${task.id})`)} ${theme.fg(color, task.status)} ${theme.fg("muted", duration)}${theme.fg("dim", `${exit}${signal}`)}`
      : `${branch} ${glyph} ${task.name} (${task.id}) ${task.status} ${duration}${exit}${signal}`);

    const latestLog = getTaskDisplayLog(task);
    const output = latestLog
      ? `[${latestLog.stream}] ${truncateText(latestLog.text, MAX_DISPLAY_LOG_CHARS)}`
      : "(no output)";
    const outputBranch = isLast ? "   └─" : "│  └─";
    lines.push(theme
      ? `${theme.fg("dim", outputBranch)} ${theme.fg("muted", output)}`
      : `${outputBranch} ${output}`);
  }

  const canExpand = visible.length > COLLAPSED_WIDGET_TASK_LIMIT;
  const hint = canExpand
    ? ` · ${keyText("app.tools.expand")} ${expanded ? "to collapse" : "to expand"}`
    : "";
  const title = `${visible.length} background task${visible.length === 1 ? "" : "s"}`;
  const header = theme
    ? theme.fg("accent", theme.bold(title)) +
      theme.fg("muted", " · ") +
      theme.fg(runningCount > 0 ? "warning" : "muted", `${runningCount} running`) +
      theme.fg("muted", ` · ${finishedCount} finished${hint}`)
    : `${title} · ${runningCount} running · ${finishedCount} finished${hint}`;
  const rendered = [header, ...lines];
  return rendered.map((line) => truncateToWidth(line, width, "…"));
}

function clearWidget(): void {
  stopRefreshTimer();
  if (widgetRegistered && uiCtx?.hasUI) uiCtx.ui.setWidget(WIDGET_KEY, undefined);
  widgetTui = null;
  widgetRegistered = false;
}

function updateWidget(): void {
  if (!uiCtx?.hasUI) {
    stopRefreshTimer();
    return;
  }
  const visible = getVisibleTasks();
  if (visible.length === 0) {
    clearWidget();
    return;
  }

  if (uiCtx.mode === "tui") {
    if (!widgetRegistered) {
      uiCtx.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          widgetTui = tui;
          return {
            render: (width: number) => renderWidgetLines(
              theme,
              width,
              uiCtx?.ui.getToolsExpanded() ?? false,
            ),
            invalidate: () => {},
            dispose: () => {
              if (widgetTui === tui) widgetTui = null;
            },
          };
        },
        { placement: "belowEditor" },
      );
      widgetRegistered = true;
    } else {
      widgetTui?.requestRender();
    }
  } else {
    uiCtx.ui.setWidget(
      WIDGET_KEY,
      renderWidgetLines(undefined, MAX_DISPLAY_LOG_CHARS, uiCtx.ui.getToolsExpanded()),
      { placement: "belowEditor" },
    );
    widgetRegistered = true;
  }
  if (runningTasks.size > 0) startRefreshTimer();
  else stopRefreshTimer();
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.events.on("bg:register", (data: unknown) => {
    const ops = data as {
      spawn?: typeof spawn;
      ptySpawn?: typeof nodePty.spawn;
      resolveShell?: ShellResolver;
      terminalInput?: NodeJS.ReadStream;
      terminalOutput?: NodeJS.WriteStream;
    };
    if (ops.spawn) spawnFn = ops.spawn;
    if (ops.ptySpawn) ptySpawnFn = ops.ptySpawn;
    if (ops.resolveShell) resolveShell = ops.resolveShell;
    if (ops.terminalInput) terminalInput = ops.terminalInput;
    if (ops.terminalOutput) terminalOutput = ops.terminalOutput;
  });

  pi.on("session_start", async (_event, ctx) => {
    clearWidget();
    uiCtx = ctx;
    updateWidget();
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName.startsWith("bg_")) { uiCtx = ctx; updateWidget(); }
  });

  pi.on("agent_settled", async () => {
    for (const task of runningTasks) task.retainForNextAgentTurn = true;
  });

  pi.on("before_agent_start", async () => {
    if (await discardExpiredFinishedTasks()) updateWidget();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearWidget();
    if (ctx?.hasUI && ctx !== uiCtx) ctx.ui.setWidget(WIDGET_KEY, undefined);
    uiCtx = null;
    for (const task of tasks.values()) task.attachment.detach?.("shutdown");
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
    for (const task of tasks.values()) {
      if (task.status !== "running") continue;
      forceKillProcess(task);
      finishTask(task, null, "shutdown");
    }
    await Promise.all(Array.from(tasks.values()).map((task) => flushConsole(task)));
    for (const task of tasks.values()) task.console.terminal.dispose();
    tasks.clear();
    runningTasks.clear();
    outputLogStore.clear();
  });

  // ── bg_start ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_start",
    label: "BG Start",
    description: "Start a background task asynchronously using the same configured shell syntax as Pi's bash tool.",
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
      pty: Type.Optional(Type.Boolean({ description: "Run in a pseudoterminal for interactive/TUI programs (default: false)" })),
      cols: Type.Optional(Type.Number({ description: "Initial PTY columns (default: current terminal or 120)", minimum: 20, maximum: 500 })),
      rows: Type.Optional(Type.Number({ description: "Initial PTY rows (default: current terminal or 30)", minimum: 5, maximum: 200 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
      const id = generateId();
      const stdoutLogKey = taskLogKey(id, "stdout");
      const stderrLogKey = taskLogKey(id, "stderr");
      const mode = params.pty ? "pty" : "pipe";
      const shell = resolveShell(params.command, mode === "pty", {
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
      const cwd = params.cwd || ctx.cwd;
      const cols = Math.min(MAX_TERMINAL_COLS, Math.max(
        MIN_TERMINAL_COLS,
        Math.floor(params.cols ?? terminalOutput.columns ?? 120),
      ));
      const rows = Math.min(MAX_TERMINAL_ROWS, Math.max(
        MIN_TERMINAL_ROWS,
        Math.floor(params.rows ?? terminalOutput.rows ?? 30),
      ));
      let taskProcess: BackgroundProcess;
      const console = createConsoleSession(cols, rows, mode);

      try {
        if (mode === "pty") {
          let ptyProcess: nodePty.IPty;
          ptyProcess = ptySpawnFn(shell.file, shell.args, {
            name: shell.env.TERM || "xterm-256color",
            cols,
            rows,
            cwd,
            env: { ...shell.env, TERM: shell.env.TERM || "xterm-256color" },
          });
          taskProcess = { kind: "pty", pid: ptyProcess.pid, pty: ptyProcess };
        } else {
          const child = spawnFn(shell.file, shell.args, {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: shell.env,
            detached: process.platform !== "win32",
          });
          taskProcess = { kind: "pipe", pid: child.pid ?? 0, child };
        }
      } catch (error) {
        console.terminal.dispose();
        throw error;
      }

      const task: BgTask = {
        id, name: params.name, command: params.command, mode,
        process: taskProcess, console, attachment: {}, status: "running",
        exitCode: null, signal: null,
        startedAt: Date.now(), endedAt: null,
        stdoutLogKey, stderrLogKey, stdoutLines: 0, stderrLines: 0,
        done: new AbortController(),
        latestLog: null, finalLog: undefined,
        retainForNextAgentTurn: false,
        stdoutPending: "", stderrPending: "",
        requestedStopSignal: null,
      };
      tasks.set(id, task);
      runningTasks.add(task);

      if (taskProcess.kind === "pty") {
        taskProcess.pty.onData((data) => recordPtyData(task, data));
        taskProcess.pty.onExit(({ exitCode, signal }) => {
          finishTask(task, exitCode, signal ? `signal ${signal}` : null);
        });
      } else {
        const child = taskProcess.child;
        child.stdout?.on("data", (d: Buffer) => recordPipeData(task, "stdout", d));
        child.stderr?.on("data", (d: Buffer) => recordPipeData(task, "stderr", d));
        let spawnError: Error | null = null;
        child.on("error", (err) => {
          spawnError = err;
          const errorLine = `[error: ${err.message}]`;
          recordPipeData(task, "stderr", Buffer.from(`\n${errorLine}\n`));
        });
        child.on("close", (code, signal) => {
          finishTask(task, code, signal, Boolean(spawnError));
        });
        if (shell.initialStdin !== undefined) {
          child.stdin?.end(shell.initialStdin);
        }
      }

      uiCtx = ctx;
      updateWidget();

      return {
        content: [{ type: "text", text: `Background task started:\n  ID:      ${id}\n  Name:    ${params.name}\n  Command: ${params.command}\n  PID:     ${taskProcess.pid}\n  Mode:    ${mode}${mode === "pty" ? ` (${cols}x${rows}; use /bg-attach ${id} for interactive control)` : ` (use /bg-attach ${id} to replay and follow output)`}\nUse bg_wait once if the final result is needed; do not poll bg_status or bg_logs.` }],
        details: { id, name: params.name, command: params.command, pid: taskProcess.pid, mode, cols: mode === "pty" ? cols : undefined, rows: mode === "pty" ? rows : undefined },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const parts = [theme.fg("toolTitle", theme.bold("bg_start"))];
      if (typeof args.name === "string" && args.name) parts.push(theme.fg("accent", args.name));
      if (typeof args.command === "string" && args.command) parts.push(theme.fg("muted", `$ ${args.command}`));
      if (args.pty) parts.push(theme.fg("dim", "[pty]"));
      text.setText(parts.join(" "));
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
      "When results from multiple finite tasks are required, call bg_wait for them together; independent waits execute in parallel.",
      "For a PTY task, set terminal_snapshot=true when the final terminal screen is needed; it is omitted by default.",
      "Do not use bg_wait for persistent servers or watchers. A timeout leaves the task running; do not immediately call bg_wait again unless the user asks you to keep waiting.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
      timeout: Type.Optional(Type.Number({ description: "Maximum seconds to wait (default: 300)", minimum: 1, maximum: 3600 })),
      terminal_snapshot: Type.Optional(Type.Boolean({ description: "For PTY tasks, include the current terminal screen in the result (default: false)" })),
    }),

    executionMode: "parallel",

    async execute(_toolCallId, params, signal, onUpdate): Promise<AgentToolResult<Record<string, unknown>>> {
      const task = tasks.get(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };

      const timeoutSeconds = params.timeout ?? 300;
      const timeoutMs = timeoutSeconds * 1000;
      if (task.status === "running") {
        onUpdate?.({
          content: [],
          details: { id: task.id, name: task.name, status: task.status },
        });
        await waitUntilAllowed(timeoutMs, [task.done.signal], signal);
      }
      await flushConsole(task);

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
      if (task.mode === "pipe") parts.push(`  Latest log: ${formatLatestLog(getTaskDisplayLog(task))}`);
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
          latestLog: task.mode === "pipe" ? getTaskDisplayLog(task) : null,
          terminalSnapshot: task.mode === "pty" && Boolean(params.terminal_snapshot),
        },
      };
    },

    renderCall(args, theme, context) {
      const state = context.state as BgWaitRenderState;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
      }
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const name = renderTaskCallLabel(args.id, theme);
      const timeout = typeof args.timeout === "number" ? theme.fg("dim", `timeout=${args.timeout}s`) : "";
      const snapshot = args.terminal_snapshot
        ? theme.fg("dim", `snapshot (${keyText("app.tools.expand")} ${context.expanded ? "to collapse" : "to expand"})`)
        : "";
      text.setText([theme.fg("toolTitle", theme.bold("bg_wait")), name, timeout, snapshot].filter(Boolean).join(" "));
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const state = context.state as BgWaitRenderState;
      if (state.startedAt !== undefined && isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
        state.interval.unref?.();
      }
      if (!isPartial || context.isError) {
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }
      if (isPartial) {
        const elapsed = state.startedAt === undefined
          ? "0.0s"
          : formatElapsedSeconds(Date.now() - state.startedAt);
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(`${theme.fg("muted", `Elapsed ${elapsed}`)}`);
        return text;
      }
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
    description: "Inspect a background task snapshot or list current tasks. This is not a polling or waiting tool.",
    promptSnippet: "Inspect background tasks only when status details are needed",
    promptGuidelines: [
      "Do not poll bg_status after bg_start; use bg_wait once when a finite task's final result is required.",
      "Use bg_status only when the user explicitly asks for current task details, when recovering missing context, or when diagnosing task state.",
      "Use bg_status without id only when a task ID is unknown and a task list is specifically needed.",
      "For PTY tasks, set terminal_snapshot=true only when the current terminal screen is needed; it is omitted by default.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Task ID. If omitted, lists all retained tasks." })),
      terminal_snapshot: Type.Optional(Type.Boolean({ description: "For PTY tasks, include the current terminal screen in the result (default: false)" })),
    }),

    executionMode: "sequential",

    async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!params.id) {
        const entries = Array.from(tasks.values());
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "No background tasks." }], details: { tasks: [] } };
        }
        await Promise.all(entries.map((task) => flushConsole(task)));
        const lines = entries.map((t) => {
          const dur = t.endedAt ? formatDuration(t.endedAt - t.startedAt) : formatDuration(Date.now() - t.startedAt);
          const exit = t.exitCode !== null ? ` exit=${t.exitCode}` : "";
          const summary = `[${t.id}] "${t.name}" ${t.status} ${t.mode} (${dur})${exit}`;
          if (t.mode === "pipe") return `${summary}\n  Latest log: ${formatLatestLog(getTaskDisplayLog(t))}`;
          return summary;
        });
        if (params.terminal_snapshot) {
          lines.push(...entries
            .filter((task) => task.mode === "pty")
            .map((task) => formatPtyScreenSnapshot(task, `"${task.name}" (${task.id})`)));
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            tasks: entries.map((t) => ({
              id: t.id,
              name: t.name,
              status: t.status,
              mode: t.mode,
              latestLog: t.mode === "pipe" ? getTaskDisplayLog(t) : null,
              terminalSnapshot: t.mode === "pty" && Boolean(params.terminal_snapshot),
            })),
          },
        };
      }

      const task = tasks.get(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };

      await flushConsole(task);

      const duration = task.endedAt ? formatDuration(task.endedAt - task.startedAt) : formatDuration(Date.now() - task.startedAt);
      const parts: string[] = [
        `Task: ${task.name} (${task.id})`,
        `  Status:    ${task.status}`, `  Command:   ${task.command}`, `  Duration:  ${duration}`,
      ];
      if (task.exitCode !== null) parts.push(`  Exit code: ${task.exitCode}`);
      if (task.signal) parts.push(`  Signal:    ${task.signal}`);
      if (task.process?.pid) parts.push(`  PID:       ${task.process.pid}`);
      parts.push(...formatTaskOutputStats(task));
      if (task.mode === "pipe") parts.push(`  Latest log: ${formatLatestLog(getTaskDisplayLog(task))}`);
      else if (params.terminal_snapshot) parts.push(formatPtyScreenSnapshot(task));
      if (task.status === "running") parts.push("  Use bg_wait to await completion; do not poll bg_status.");

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: { id: task.id, name: task.name, status: task.status, mode: task.mode, exitCode: task.exitCode, signal: task.signal, pid: task.process?.pid, stdoutLines: task.stdoutLines, stderrLines: task.stderrLines, latestLog: task.mode === "pipe" ? getTaskDisplayLog(task) : null, terminalSnapshot: task.mode === "pty" && Boolean(params.terminal_snapshot) },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const hasTaskId = typeof args.id === "string" && args.id.trim().length > 0;
      const label = hasTaskId
        ? renderTaskCallLabel(args.id, theme)
        : context.argsComplete ? theme.fg("toolOutput", "all") : "";
      const snapshot = args.terminal_snapshot
        ? theme.fg("dim", `snapshot (${keyText("app.tools.expand")} ${context.expanded ? "to collapse" : "to expand"})`)
        : "";
      text.setText([theme.fg("toolTitle", theme.bold("bg_status")), label, snapshot].filter(Boolean).join(" "));
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
        await flushConsole(task);
        if (stream === "stderr") {
          return {
            content: [{ type: "text", text: "(PTY output combines stdout and stderr; use stream=terminal)" }],
            details: { id: task.id, name: task.name, status: task.status, mode: task.mode },
          };
        }
        const snapshotLines = getTerminalSnapshotLines(task);
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
            cols: task.console.terminal.cols,
            rows: task.console.terminal.rows,
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
            ? await readRange(task.stdoutLogKey, params.from_line, maxLines)
            : await readTail(task.stdoutLogKey, lines);
      if (stream === "stderr" || stream === "both")
        stderr =
          params.from_line !== undefined
            ? await readRange(task.stderrLogKey, params.from_line, maxLines)
            : await readTail(task.stderrLogKey, lines);

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
      const name = renderTaskCallLabel(args.id, theme);
      const extras: string[] = [];
      if (args.tail) extras.push(`tail=${args.tail}`);
      if (args.stream && args.stream !== "both") extras.push(args.stream);
      const extra = extras.length
        ? theme.fg("dim", extras.join(" "))
        : "";
      const toggleHint = theme.fg(
        "dim",
        ` (${keyText("app.tools.expand")} ${context.expanded ? "to collapse" : "to expand"})`,
      );
      text.setText(
        [theme.fg("toolTitle", theme.bold("bg_logs")), name, extra, toggleHint].filter(Boolean).join(" "),
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

  const MAX_INPUT_BYTES = 65_536;
  const MAX_KEY_REPEAT = 100;

  type KeyDefinition =
    | { kind: "character"; value: string }
    | { kind: "fixed"; sequence: string }
    | { kind: "cursor"; final: string }
    | { kind: "function"; final: string }
    | { kind: "tilde"; code: number }
    | { kind: "eof" };

  const KEY_DEFINITIONS = {
    space: { kind: "character", value: " " },
    enter: { kind: "fixed", sequence: "\r" },
    escape: { kind: "fixed", sequence: "\x1b" },
    tab: { kind: "fixed", sequence: "\t" },
    backspace: { kind: "fixed", sequence: "\x7f" },
    insert: { kind: "tilde", code: 2 },
    delete: { kind: "tilde", code: 3 },
    pageup: { kind: "tilde", code: 5 },
    pagedown: { kind: "tilde", code: 6 },
    up: { kind: "cursor", final: "A" },
    down: { kind: "cursor", final: "B" },
    right: { kind: "cursor", final: "C" },
    left: { kind: "cursor", final: "D" },
    home: { kind: "cursor", final: "H" },
    end: { kind: "cursor", final: "F" },
    f1: { kind: "function", final: "P" },
    f2: { kind: "function", final: "Q" },
    f3: { kind: "function", final: "R" },
    f4: { kind: "function", final: "S" },
    f5: { kind: "tilde", code: 15 },
    f6: { kind: "tilde", code: 17 },
    f7: { kind: "tilde", code: 18 },
    f8: { kind: "tilde", code: 19 },
    f9: { kind: "tilde", code: 20 },
    f10: { kind: "tilde", code: 21 },
    f11: { kind: "tilde", code: 23 },
    f12: { kind: "tilde", code: 24 },
    eof: { kind: "eof" },
  } as const satisfies Record<string, KeyDefinition>;
  type NamedInputKey = keyof typeof KEY_DEFINITIONS;

  const NAMED_KEY_ALIASES: Record<string, NamedInputKey> = {
    space: "space", spc: "space",
    esc: "escape", escape: "escape",
    enter: "enter", return: "enter", cr: "enter",
    tab: "tab", backtab: "tab",
    bs: "backspace", backspace: "backspace",
    ins: "insert", insert: "insert", del: "delete", delete: "delete",
    home: "home", end: "end",
    pageup: "pageup", pgup: "pageup", pagedown: "pagedown", pgdn: "pagedown",
    up: "up", down: "down", left: "left", right: "right",
    f1: "f1", f2: "f2", f3: "f3", f4: "f4", f5: "f5", f6: "f6",
    f7: "f7", f8: "f8", f9: "f9", f10: "f10", f11: "f11", f12: "f12",
    eof: "eof",
  };

  const CHARACTER_ALIASES: Record<string, string> = {
    lt: "<", gt: ">", backslash: "\\",
  };

  const MODIFIER_ALIASES = {
    c: "ctrl", ctrl: "ctrl", control: "ctrl",
    a: "alt", alt: "alt", m: "alt", meta: "alt",
    s: "shift", shift: "shift",
  } as const;

  const SHIFTED_CHARACTERS: Record<string, string> = {
    "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^",
    "7": "&", "8": "*", "9": "(", "0": ")", "-": "_", "=": "+",
    "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"",
    ",": "<", ".": ">", "/": "?", "`": "~",
  };

  const CONTROL_BYTES: Record<string, number> = {
    "@": 0x00, " ": 0x00, "[": 0x1b, "\\": 0x1c,
    "]": 0x1d, "^": 0x1e, "_": 0x1f, "?": 0x7f,
  };

  interface KeyModifiers {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
  }

  type LogicalKey =
    | { kind: "named"; name: NamedInputKey }
    | { kind: "character"; value: string };

  interface KeyStroke {
    kind: "key";
    key: LogicalKey;
    modifiers: KeyModifiers;
  }

  type NormalizedInputToken = KeyStroke | { kind: "literal"; value: string };

  function hasModifiers(modifiers: KeyModifiers): boolean {
    return modifiers.ctrl || modifiers.alt || modifiers.shift;
  }

  function normalizeInputToken(token: string): NormalizedInputToken | null {
    let remaining = token.trim().replace(/\s+/g, "");
    const modifiers: KeyModifiers = { ctrl: false, alt: false, shift: false };

    while (remaining.length > 0) {
      const match = /^(c|ctrl|control|a|alt|m|meta|s|shift)[+-]/i.exec(remaining);
      if (!match) break;
      const modifier = MODIFIER_ALIASES[match[1].toLowerCase() as keyof typeof MODIFIER_ALIASES];
      if (modifiers[modifier]) return null;
      modifiers[modifier] = true;
      remaining = remaining.slice(match[0].length);
    }
    if (remaining.length === 0) return null;

    const lowerKey = remaining.toLowerCase();
    if (lowerKey === "lt" && !hasModifiers(modifiers)) return { kind: "literal", value: "<" };
    if (lowerKey === "backtab") modifiers.shift = true;

    const namedKey = NAMED_KEY_ALIASES[lowerKey];
    if (namedKey) return { kind: "key", key: { kind: "named", name: namedKey }, modifiers };

    const aliasedCharacter = CHARACTER_ALIASES[lowerKey];
    if (aliasedCharacter) {
      return { kind: "key", key: { kind: "character", value: aliasedCharacter }, modifiers };
    }

    const characters = Array.from(remaining);
    const codePoint = characters[0]?.codePointAt(0) ?? 0;
    if (hasModifiers(modifiers) && characters.length === 1 && codePoint >= 0x21 && codePoint <= 0x7e) {
      return { kind: "key", key: { kind: "character", value: remaining }, modifiers };
    }
    return null;
  }

  function modifierParameter(modifiers: KeyModifiers): number {
    return 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  }

  function shiftCharacter(character: string): string {
    if (/^[a-z]$/.test(character)) return character.toUpperCase();
    return SHIFTED_CHARACTERS[character] ?? character;
  }

  function controlByte(character: string): number | null {
    const lower = character.toLowerCase();
    if (/^[a-z]$/.test(lower)) return lower.charCodeAt(0) - 96;
    return CONTROL_BYTES[character] ?? null;
  }

  function encodeCharacter(character: string, modifiers: KeyModifiers): Buffer {
    const byte = modifiers.ctrl ? controlByte(character) : null;
    if (modifiers.ctrl && byte === null) throw new Error(`Unsupported Ctrl key: ${character}`);
    const data = byte === null
      ? Buffer.from(modifiers.shift ? shiftCharacter(character) : character)
      : Buffer.from([byte]);
    return modifiers.alt ? Buffer.concat([Buffer.from("\x1b"), data]) : data;
  }

  function encodeInputKey(task: BgTask, stroke: KeyStroke): Buffer {
    if (stroke.key.kind === "character") return encodeCharacter(stroke.key.value, stroke.modifiers);

    const definition = KEY_DEFINITIONS[stroke.key.name];
    if (definition.kind === "character") return encodeCharacter(definition.value, stroke.modifiers);
    if (definition.kind === "eof") {
      if (hasModifiers(stroke.modifiers)) throw new Error("<EOF> does not accept modifiers.");
      return Buffer.from([0x04]);
    }
    if (definition.kind === "fixed") {
      const sequence = stroke.key.name === "tab" && stroke.modifiers.shift ? "\x1b[Z" : definition.sequence;
      return stroke.modifiers.alt
        ? Buffer.concat([Buffer.from("\x1b"), Buffer.from(sequence)])
        : Buffer.from(sequence);
    }

    const parameter = modifierParameter(stroke.modifiers);
    if (definition.kind === "cursor") {
      if (parameter > 1) return Buffer.from(`\x1b[1;${parameter}${definition.final}`);
      const prefix = task.console.terminal.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
      return Buffer.from(`${prefix}${definition.final}`);
    }
    if (definition.kind === "function") {
      return Buffer.from(parameter > 1
        ? `\x1b[1;${parameter}${definition.final}`
        : `\x1bO${definition.final}`);
    }
    return Buffer.from(parameter > 1
      ? `\x1b[${definition.code};${parameter}~`
      : `\x1b[${definition.code}~`);
  }

  function isNamedKey(stroke: KeyStroke, name: NamedInputKey): boolean {
    return stroke.key.kind === "named" && stroke.key.name === name;
  }

  function isPipeEof(stroke: KeyStroke): boolean {
    if (isNamedKey(stroke, "eof")) return !hasModifiers(stroke.modifiers);
    return stroke.key.kind === "character" && stroke.key.value.toLowerCase() === "d" &&
      stroke.modifiers.ctrl && !stroke.modifiers.alt;
  }

  interface ParsedInput {
    data: Buffer;
    eof: boolean;
    keyTokens: number;
    textBytes: number;
  }

  function parseInput(task: BgTask, input: string): ParsedInput {
    if (input.length === 0) throw new Error("Input cannot be empty; use <Enter> to press Enter.");

    const chunks: Buffer[] = [];
    let expandedBytes = 0;
    let keyTokens = 0;
    let textBytes = 0;
    let eof = false;

    const pushChunk = (chunk: Buffer, text: boolean): void => {
      expandedBytes += chunk.length;
      if (expandedBytes > MAX_INPUT_BYTES) throw new Error(`Expanded input exceeds ${MAX_INPUT_BYTES} bytes.`);
      chunks.push(chunk);
      if (text) textBytes += chunk.length;
    };

    let cursor = 0;
    let textStart = 0;
    while (cursor < input.length) {
      if (input[cursor] === "\\" && (input[cursor + 1] === "<" || input[cursor + 1] === "\\")) {
        if (cursor > textStart) pushChunk(Buffer.from(input.slice(textStart, cursor), "utf-8"), true);
        pushChunk(Buffer.from(input[cursor + 1], "utf-8"), true);
        cursor += 2;
        textStart = cursor;
        continue;
      }
      if (input[cursor] !== "<") {
        cursor += 1;
        continue;
      }

      const tokenStart = cursor;
      if (tokenStart > textStart) pushChunk(Buffer.from(input.slice(textStart, tokenStart), "utf-8"), true);

      const tokenEnd = input.indexOf(">", tokenStart + 1);
      if (tokenEnd === -1) throw new Error(`Unclosed input token at offset ${tokenStart}; use \\< for a literal '<'.`);
      const rawToken = input.slice(tokenStart + 1, tokenEnd);
      const repeated = /^(.*?)(?:\*([0-9]+))?$/.exec(rawToken);
      const tokenName = repeated?.[1] ?? rawToken;
      const repeat = repeated?.[2] === undefined ? 1 : Number(repeated[2]);
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_KEY_REPEAT) {
        throw new Error(`Invalid repeat count in <${rawToken}> at offset ${tokenStart}; use 1-${MAX_KEY_REPEAT}.`);
      }

      const token = normalizeInputToken(tokenName);
      if (!token) throw new Error(`Unknown input token <${tokenName}> at offset ${tokenStart}.`);

      if (token.kind === "literal") {
        pushChunk(Buffer.from(token.value.repeat(repeat)), true);
      } else {
        keyTokens += repeat;
        if (task.mode === "pipe") {
          if (isPipeEof(token)) {
            if (repeat !== 1) throw new Error("Ctrl+D/<EOF> cannot be repeated for a pipe task.");
            eof = true;
          } else if (isNamedKey(token, "enter") && !hasModifiers(token.modifiers)) {
            pushChunk(Buffer.from("\n".repeat(repeat)), false);
          } else if (isNamedKey(token, "space") && !hasModifiers(token.modifiers)) {
            pushChunk(Buffer.from(" ".repeat(repeat)), false);
          } else {
            throw new Error(`Key token <${tokenName}> requires a PTY task; pipe tasks accept text, <Space>, <Enter>, and <C-d>/<EOF>.`);
          }
        } else {
          const encoded = encodeInputKey(task, token);
          for (let index = 0; index < repeat; index++) pushChunk(encoded, false);
        }
      }

      cursor = tokenEnd + 1;
      textStart = cursor;
    }
    if (textStart < input.length) pushChunk(Buffer.from(input.slice(textStart), "utf-8"), true);

    const data = Buffer.concat(chunks);
    if (eof && (data.length > 0 || keyTokens !== 1)) {
      throw new Error("For a pipe task, Ctrl+D/<EOF> must be the only input token.");
    }
    return { data, eof, keyTokens, textBytes };
  }

  const STOP_SIGNALS = new Set<NodeJS.Signals>(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
  const SEND_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP", "SIGCONT", "SIGUSR1", "SIGUSR2"] as const;

  pi.registerTool({
    name: "bg_send",
    label: "BG Send",
    description: "Send text and terminal keys using one compact input string, or send an OS signal to a running background task.",
    promptSnippet: "Send a compact text/key input string or an OS signal to a background task",
    promptGuidelines: [
      "Provide exactly one of input or signal. Plain input is exact text; every terminal key must be inside an angle-bracket token such as <C-d>, <A-f>, <Space>, or <Up>. Escape a literal '<' as \\<.",
      "Terminal keys always use input. Use signal only when an OS process signal is explicitly intended.",
      "For pipe tasks, <C-d> or <EOF> closes stdin.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
      input: Type.Optional(Type.String({ description: "Exact text; terminal keys must use <...> tokens, for example y<Enter>, <A-f>, or <C-d>", minLength: 1, maxLength: MAX_INPUT_BYTES })),
      signal: Type.Optional(StringEnum(SEND_SIGNALS, { description: "OS signal for the process group" })),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
      const task = tasks.get(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };
      if (task.status !== "running") return { content: [{ type: "text", text: `Task "${task.name}" is not running.` }], details: {} };
      if (!task.process) return { content: [{ type: "text", text: `Task "${task.name}" process is unavailable.` }], details: {} };

      const sourceCount = [params.input !== undefined, params.signal !== undefined].filter(Boolean).length;
      if (sourceCount !== 1) {
        return { content: [{ type: "text", text: "Provide exactly one of input or signal." }], details: {} };
      }

      if (params.signal) {
        const previousStopSignal = task.requestedStopSignal;
        if (STOP_SIGNALS.has(params.signal)) task.requestedStopSignal = params.signal;
        try {
          await sendProcessSignal(task, params.signal);
          return {
            content: [{ type: "text", text: `Sent ${params.signal} to "${task.name}" process group.` }],
            details: { id: task.id, name: task.name, signal: params.signal },
          };
        } catch (err) {
          task.requestedStopSignal = previousStopSignal;
          return { content: [{ type: "text", text: `Failed to send ${params.signal}: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      }

      let parsed: ParsedInput;
      try {
        parsed = parseInput(task, params.input ?? "");
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
      }

      if (parsed.eof) {
        closeTaskInput(task);
        return {
          content: [{ type: "text", text: `Closed stdin for "${task.name}".` }],
          details: { id: task.id, name: task.name, eof: true, mode: task.mode },
        };
      }

      try {
        writeTaskInput(task, parsed.data);
        return {
          content: [{ type: "text", text: `Sent to "${task.name}": ${parsed.data.length} bytes (${parsed.keyTokens} key tokens)` }],
          details: { id: task.id, name: task.name, bytes: parsed.data.length, keyTokens: parsed.keyTokens, textBytes: parsed.textBytes, mode: task.mode },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
      }
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const name = renderTaskCallLabel(args.id, theme);
      const value = args.signal ?? (args.input !== undefined ? truncateText(JSON.stringify(args.input), 80) : undefined);
      const input = value !== undefined ? theme.fg("dim", `→ ${value}`) : "";
      text.setText([theme.fg("toolTitle", theme.bold("bg_send")), name, input].filter(Boolean).join(" "));
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
        await flushConsole(task);
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
      const name = renderTaskCallLabel(args.id, theme);
      const sig = args.force ? theme.fg("error", "SIGKILL") : "";
      const snapshot = args.terminal_snapshot
        ? theme.fg("dim", `snapshot (${keyText("app.tools.expand")} ${context.expanded ? "to collapse" : "to expand"})`)
        : "";
      text.setText([theme.fg("toolTitle", theme.bold("bg_kill")), name, sig, snapshot].filter(Boolean).join(" "));
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
    description: "Attach to a task (live while running, read-only final snapshot after exit; Ctrl+] to detach)",
    getArgumentCompletions: (prefix: string) => {
      const items = Array.from(tasks.values())
        .map((task) => ({ value: task.id, label: `${task.id} [${task.mode}] ${task.name} (${task.status})` }));
      return items.filter((item) => item.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      let id = args.trim().split(/\s+/, 1)[0];
      if (!id) {
        const retained = Array.from(tasks.values());
        if (retained.length === 0) {
          ctx.ui.notify("No background tasks.", "info");
          return;
        }
        const choice = await ctx.ui.select(
          "Attach to which task? (finished snapshots are read-only; Ctrl+] to detach)",
          retained.map((task) => `${task.id} [${task.mode}] ${task.name} (${task.status})`),
        );
        if (!choice) return;
        id = choice.split(" ", 1)[0];
      }

      const task = tasks.get(id);
      if (!task) {
        ctx.ui.notify(`Task not found: ${id}`, "error");
        return;
      }
      await attachTask(task, ctx);
    },
  });

  // ── /bg-kill command ───────────────────────────────────────────────

  pi.registerCommand("bg-kill", {
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
