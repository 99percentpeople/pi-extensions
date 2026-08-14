import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { stripVTControlCharacters } from "node:util";
import {
  getShellConfig,
  SettingsManager,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { MemoryLogStore } from "./memory-log-store.ts";
import {
  HeadlessTerminal,
  nodePty,
  SerializeAddon,
} from "./runtime-dependencies.ts";
import type {
  BackgroundShellProviderRegistration,
  BackgroundSignal,
  BackgroundTaskControl,
  BackgroundTasksExtensionDependencies,
  BackgroundTransportExitDisposition,
  BgTask,
  ConsoleData,
  ConsoleSession,
  FinishedTaskStatus,
  LatestLog,
  OrderedToolCall,
  PersistedFinishedTask,
  PersistedTaskEvent,
  ShellLaunch,
  ShellResolver,
  ShellResolverContext,
  WindowsProcessTreeKiller,
} from "./types.ts";

// ── Execution Backend ─────────────────────────────────────────────────

export const terminalIO: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
} = {
  input: process.stdin,
  output: process.stdout,
};

export const BACKGROUND_SEND_SIGNALS: readonly BackgroundSignal[] = Object.freeze([
  "SIGABRT", "SIGALRM", "SIGBREAK", "SIGBUS", "SIGCHLD", "SIGCONT",
  "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGIO", "SIGIOT",
  "SIGKILL", "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT",
  "SIGSEGV", "SIGSTKFLT", "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP",
  "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGUSR1", "SIGUSR2",
  "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ",
].sort() as BackgroundSignal[]);

const defaultWindowsProcessTreeKiller: WindowsProcessTreeKiller = (
  pid,
  signal,
) => new Promise<void>((resolve, reject) => {
  const args = ["/T", "/PID", String(pid)];
  if (signal === "SIGKILL") args.unshift("/F");
  const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
  killer.once("error", reject);
  killer.once("exit", (code) => code === 0
    ? resolve()
    : reject(new Error(`taskkill exited with code ${code}`)));
});

let killWindowsProcessTree: WindowsProcessTreeKiller = defaultWindowsProcessTreeKiller;

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

export const BACKGROUND_BACKEND_PROTOCOL_VERSION = 2;

interface RegisteredShellProvider {
  id: string;
  priority: number;
  order: number;
  resolveShell: ShellResolver;
  spawn?: typeof spawn;
  ptySpawn?: typeof nodePty.spawn;
}

let shellProviderOrder = 0;
const shellProviders = new Map<string, RegisteredShellProvider>();

export function resolveShell(
  command: string,
  interactive: boolean,
  context?: ShellResolverContext,
): ShellLaunch {
  const providers = Array.from(shellProviders.values()).sort(
    (left, right) => right.priority - left.priority || right.order - left.order,
  );
  for (const provider of providers) {
    const launch = provider.resolveShell(command, interactive, context);
    if (launch) {
      return {
        ...launch,
        spawnProcess: provider.spawn ?? spawn,
        ptySpawnProcess: provider.ptySpawn ?? nodePty.spawn,
      };
    }
  }
  return defaultShellResolver(command, interactive, context);
}

export function resetExecutionBackend(): void {
  terminalIO.input = process.stdin;
  terminalIO.output = process.stdout;
  killWindowsProcessTree = defaultWindowsProcessTreeKiller;
  shellProviders.clear();
  shellProviderOrder = 0;
}

export function configureExecutionBackend(
  dependencies: BackgroundTasksExtensionDependencies,
): void {
  resetExecutionBackend();
  terminalIO.input = dependencies.terminalInput ?? process.stdin;
  terminalIO.output = dependencies.terminalOutput ?? process.stdout;
  killWindowsProcessTree = dependencies.killWindowsProcessTree
    ?? defaultWindowsProcessTreeKiller;
}

export function unregisterShellProvider(id: unknown): void {
  if (typeof id === "string") shellProviders.delete(id);
}

export function registerShellProvider(data: unknown): void {
  const ops = data as BackgroundShellProviderRegistration;
  const id = typeof ops.id === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(ops.id)
    ? ops.id
    : undefined;
  if (!id) {
    throw new Error(
      "Background shell provider registration requires protocol v2 with a valid id. "
        + "Update legacy SSH or PowerShell adapters before using this Background Tasks release.",
    );
  }
  if (typeof ops.resolveShell !== "function") {
    throw new Error(`Background shell provider "${id}" must register a resolveShell function.`);
  }
  for (const method of ["spawn", "ptySpawn", "onRegistered"] as const) {
    if (ops[method] !== undefined && typeof ops[method] !== "function") {
      throw new Error(`Background shell provider ${method} must be a function when provided.`);
    }
  }
  const priority = typeof ops.priority === "number" && Number.isFinite(ops.priority)
    ? Math.max(-1_000, Math.min(1_000, ops.priority))
    : 0;
  shellProviders.set(id, {
    id,
    priority,
    order: shellProviderOrder++,
    resolveShell: ops.resolveShell,
    spawn: ops.spawn,
    ptySpawn: ops.ptySpawn,
  });
  ops.onRegistered?.({
    protocolVersion: BACKGROUND_BACKEND_PROTOCOL_VERSION,
    providers: true,
    taskControl: true,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

export const MIN_TERMINAL_COLS = 20;
export const MAX_TERMINAL_COLS = 500;
export const MIN_TERMINAL_ROWS = 5;
export const MAX_TERMINAL_ROWS = 200;

let tasksChangedHandler: (() => void) | undefined;

export function setTasksChangedHandler(handler: (() => void) | undefined): void {
  tasksChangedHandler = handler;
}

function notifyTasksChanged(): void {
  tasksChangedHandler?.();
}

export const tasks = new Map<string, BgTask>();
export const runningTasks = new Set<BgTask>();
export const outputLogStore = new MemoryLogStore();
// Pi preflights sibling calls in source order before executing them concurrently.
// Build per-task chains during preflight so same-task calls preserve that order
// without serializing unrelated tasks. bg_start joins the chain by task name,
// allowing a model to compose start → wait → logs before a generated ID exists.
export const ORDERED_TASK_TOOL_NAMES = new Set(["bg_start", "bg_wait", "bg_status", "bg_logs", "bg_send", "bg_kill"]);
const orderedToolCalls = new Map<string, OrderedToolCall>();
const orderedTaskTails = new Map<string, Promise<void>>();
export const TASK_SNAPSHOT_CUSTOM_TYPE = "pi-background-task-snapshots";
const TASK_SNAPSHOT_SCHEMA_VERSION = 1 as const;
const PERSISTED_CONSOLE_SCROLLBACK = 200;
const PERSISTED_LOG_LINES = 500;
const MAX_PERSISTED_LOG_BYTES = 256 * 1024;
const MAX_PERSISTED_CONSOLE_BYTES = 512 * 1024;
let appendTaskSnapshotEntry: ((event: PersistedTaskEvent) => void) | null = null;
let snapshotPersistenceQueue: Promise<void> = Promise.resolve();
let nextTaskOrder = 0;

export function registerOrderedToolCall(toolCallId: string, taskId: string): void {
  if (orderedToolCalls.has(toolCallId)) return;

  const predecessor = orderedTaskTails.get(taskId) ?? Promise.resolve();
  let resolveCompletion: () => void = () => {};
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    resolveCompletion();
  };

  orderedToolCalls.set(toolCallId, { predecessor, release });
  orderedTaskTails.set(taskId, completion);
}

export function releaseOrderedToolCall(toolCallId: string): void {
  const ordered = orderedToolCalls.get(toolCallId);
  if (!ordered) return;
  ordered.release();
  orderedToolCalls.delete(toolCallId);
}

export function clearOrderedToolCalls(): void {
  for (const ordered of orderedToolCalls.values()) ordered.release();
  orderedToolCalls.clear();
  orderedTaskTails.clear();
}

export function normalizeTaskName(name: string): string {
  return name.trim();
}

function normalizeTaskNameKey(name: string): string {
  return normalizeTaskName(name).toLocaleLowerCase();
}

function findTaskByName(name: string): BgTask | undefined {
  const normalized = normalizeTaskNameKey(name);
  return Array.from(tasks.values()).find(
    (task) => normalizeTaskNameKey(task.name) === normalized,
  );
}

export function findTaskByReference(reference: string): BgTask | undefined {
  const normalized = normalizeTaskName(reference);
  return tasks.get(normalized) ?? findTaskByName(normalized);
}

export function taskOrderingKey(reference: string): string {
  const task = findTaskByReference(reference);
  return task ? `task:${task.id}` : `name:${normalizeTaskNameKey(reference)}`;
}

export function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  do {
    id = "";
    for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (tasks.has(id) || findTaskByName(id));
  return id;
}

export function taskLogKey(id: string, stream: "stdout" | "stderr"): string {
  return `${id}:${stream}`;
}

export function takeNextTaskOrder(): number {
  return nextTaskOrder++;
}

export function clearTaskRuntimeState(): void {
  tasks.clear();
  runningTasks.clear();
  outputLogStore.clear();
  nextTaskOrder = 0;
}

export function createConsoleSession(cols: number, rows: number, mode: "pipe" | "pty"): ConsoleSession {
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

export function readTail(logKey: string, lines: number): string {
  return splitLogLines(outputLogStore.read(logKey)).slice(-lines).join("\n");
}

export function readRange(logKey: string, fromLine: number, maxLines: number): string {
  return splitLogLines(outputLogStore.read(logKey)).slice(fromLine, fromLine + maxLines).join("\n");
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

export function formatElapsedSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

const MAX_STORED_LOG_CHARS = 500;
export const MAX_DISPLAY_LOG_CHARS = 240;

export function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

export function renderTaskCallLabel(id: unknown, theme: Theme): string {
  const taskId = typeof id === "string" ? id.trim() : "";
  if (!taskId) return "";
  const task = findTaskByReference(taskId);
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

export function getTerminalSnapshotLines(task: BgTask): string[] {
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

function updatePtyLatestLog(task: BgTask): void {
  const latestText = getTerminalSnapshotLines(task).findLast((line) => line.trim().length > 0)?.trim();
  if (!latestText) return;
  task.latestLog = {
    stream: "terminal",
    text: truncateText(latestText, MAX_STORED_LOG_CHARS),
    at: Date.now(),
  };
}

export function writeConsoleData(task: BgTask, data: ConsoleData): void {
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

export function appendTaskLog(logKey: string, data: Buffer | string): void {
  outputLogStore.append(logKey, data);
}

export function recordPtyData(task: BgTask, data: string): void {
  task.stdoutLines += data.split("\n").length - 1;

  const session = task.console;
  if (session.catchUpBuffer !== null) {
    session.catchUpBuffer.push(data);
    return;
  }
  writeConsoleData(task, data);
  session.subscriber?.(data);
}

export function recordPipeData(task: BgTask, stream: "stdout" | "stderr", data: Buffer): void {
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

export function beginConsoleCatchUp(task: BgTask): ConsoleData[] {
  const session = task.console;
  if (session.catchUpBuffer !== null) throw new Error(`Task "${task.name}" already has an attach catch-up in progress.`);
  const buffer: ConsoleData[] = [];
  session.catchUpBuffer = buffer;
  return buffer;
}

export function releaseConsoleCatchUp(task: BgTask, buffer: ConsoleData[]): void {
  const session = task.console;
  if (session.catchUpBuffer !== buffer) return;
  session.catchUpBuffer = null;

  for (const data of buffer) writeConsoleData(task, data);
  const writer = session.subscriber;
  if (writer) {
    for (const data of buffer) writer(data);
  }
}

export async function flushConsole(task: BgTask): Promise<void> {
  await task.console.parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function normalizeTaskEnvironment(value: unknown): string | null {
  // Accept the short-lived object form written by development builds before
  // task environments were simplified to one label.
  const label = typeof value === "string"
    ? value
    : isRecord(value) && typeof value.label === "string"
      ? value.label
      : undefined;
  if (
    !label
    || label.length > 1_000
    || /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(label)
  ) return null;
  return label;
}

export function taskEnvironmentDetails(task: BgTask): { environment?: string } {
  return task.environment ? { environment: task.environment } : {};
}

export function isFinalTaskStatus(status: BgTask["status"]): status is FinishedTaskStatus {
  return status === "completed" || status === "failed" || status === "stopped";
}

export function isTaskControllable(task: BgTask): boolean {
  return task.status === "running" || task.status === "disconnected";
}

export function taskControlFromLaunch(shell: ShellLaunch): BackgroundTaskControl | null {
  const control = shell.control;
  if (!control) return null;
  for (const method of ["sendSignal", "probe", "onTransportExit", "dispose"] as const) {
    if (typeof control[method] !== "function") {
      throw new Error(`Background task control must implement ${method}().`);
    }
  }
  return control;
}

export async function disposeTaskControl(task: BgTask): Promise<void> {
  if (task.controlDisposed) return;
  task.controlDisposed = true;
  const control = task.control;
  task.control = null;
  if (control) await control.dispose();
}

const TASK_DETAIL_LABEL_WIDTH = "Environment:".length + 1;

export function taskDetailLine(label: string, value: unknown, indent = ""): string {
  return `${indent}${`${label}:`.padEnd(TASK_DETAIL_LABEL_WIDTH)}${String(value)}`;
}

export function taskLatestPipeLog(task: BgTask): LatestLog | undefined {
  const latestLog = task.latestLog;
  if (task.mode !== "pipe" || !latestLog || latestLog.stream === "terminal") return undefined;
  return { ...latestLog };
}

export function taskLatestPipeLogLine(task: BgTask, indent = ""): string | undefined {
  const latestLog = taskLatestPipeLog(task);
  return latestLog
    ? taskDetailLine("Latest log", `[${latestLog.stream}] ${latestLog.text}`, indent)
    : undefined;
}

export function taskEnvironmentLine(task: BgTask, indent = ""): string | undefined {
  return task.environment
    ? taskDetailLine("Environment", task.environment, indent)
    : undefined;
}

export function withTaskEnvironment(task: BgTask, text: string): string {
  const line = taskEnvironmentLine(task);
  return line ? `${line}\n${text}` : text;
}

export function emptyOutputMessage(
  task: BgTask,
  label: "output" | "terminal output",
): string {
  return `(no ${label}${task.status === "running" ? " yet" : ""})`;
}

export function taskEnvironmentSuffix(task: BgTask): string {
  return task.environment ? ` on ${task.environment}` : "";
}

function tailUtf8(value: string, maxBytes: number): string {
  const data = Buffer.from(value, "utf8");
  if (data.length <= maxBytes) return value;
  return data.subarray(data.length - maxBytes).toString("utf8").replace(/^\uFFFD+/, "");
}

function serializeConsoleSnapshot(task: BgTask): string {
  const serialized = task.console.serializer.serialize({ scrollback: PERSISTED_CONSOLE_SCROLLBACK });
  if (Buffer.byteLength(serialized, "utf8") <= MAX_PERSISTED_CONSOLE_BYTES) return serialized;
  const plainSnapshot = getTerminalSnapshotLines(task)
    .slice(-(PERSISTED_CONSOLE_SCROLLBACK + task.console.terminal.rows))
    .join("\r\n");
  return tailUtf8(plainSnapshot, MAX_PERSISTED_CONSOLE_BYTES);
}

function serializeFinishedTask(task: BgTask): PersistedFinishedTask {
  if (!isFinalTaskStatus(task.status) || task.endedAt === null) {
    throw new Error(`Task "${task.name}" is not ready for snapshot persistence.`);
  }
  return {
    id: task.id,
    name: task.name,
    command: task.command,
    mode: task.mode,
    environment: task.environment,
    status: task.status,
    exitCode: task.exitCode,
    signal: task.signal,
    order: task.order,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    stdoutLines: task.stdoutLines,
    stderrLines: task.stderrLines,
    latestLog: task.latestLog ? { ...task.latestLog } : null,
    retainForNextAgentTurn: task.retainForNextAgentTurn,
    cols: task.console.terminal.cols,
    rows: task.console.terminal.rows,
    consoleSnapshot: serializeConsoleSnapshot(task),
    ...(task.mode === "pipe"
      ? {
          stdout: tailUtf8(readTail(task.stdoutLogKey, PERSISTED_LOG_LINES), MAX_PERSISTED_LOG_BYTES),
          stderr: tailUtf8(readTail(task.stderrLogKey, PERSISTED_LOG_LINES), MAX_PERSISTED_LOG_BYTES),
        }
      : {}),
  };
}

function readLatestLog(value: unknown): LatestLog | null {
  if (value === null) return null;
  if (!isRecord(value)) return null;
  if (
    value.stream !== "stdout" &&
    value.stream !== "stderr" &&
    value.stream !== "terminal"
  ) return null;
  if (typeof value.text !== "string" || typeof value.at !== "number" || !Number.isFinite(value.at)) return null;
  return {
    stream: value.stream,
    text: truncateText(value.text, MAX_STORED_LOG_CHARS),
    at: value.at,
  };
}

function readPersistedFinishedTask(value: unknown): PersistedFinishedTask | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.command !== "string" ||
    (value.mode !== "pipe" && value.mode !== "pty") ||
    (value.status !== "completed" && value.status !== "failed" && value.status !== "stopped") ||
    (value.exitCode !== null && typeof value.exitCode !== "number") ||
    (value.signal !== null && typeof value.signal !== "string") ||
    typeof value.order !== "number" ||
    typeof value.startedAt !== "number" ||
    typeof value.endedAt !== "number" ||
    typeof value.stdoutLines !== "number" ||
    typeof value.stderrLines !== "number" ||
    typeof value.retainForNextAgentTurn !== "boolean" ||
    typeof value.cols !== "number" ||
    typeof value.rows !== "number" ||
    typeof value.consoleSnapshot !== "string"
  ) return undefined;

  return {
    id: value.id,
    name: value.name,
    command: value.command,
    mode: value.mode,
    environment: normalizeTaskEnvironment(value.environment),
    status: value.status,
    exitCode: value.exitCode,
    signal: value.signal,
    order: Math.max(0, Math.floor(value.order)),
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    stdoutLines: Math.max(0, Math.floor(value.stdoutLines)),
    stderrLines: Math.max(0, Math.floor(value.stderrLines)),
    latestLog: readLatestLog(value.latestLog),
    retainForNextAgentTurn: value.retainForNextAgentTurn,
    cols: Math.min(MAX_TERMINAL_COLS, Math.max(MIN_TERMINAL_COLS, Math.floor(value.cols))),
    rows: Math.min(MAX_TERMINAL_ROWS, Math.max(MIN_TERMINAL_ROWS, Math.floor(value.rows))),
    consoleSnapshot: tailUtf8(value.consoleSnapshot, MAX_PERSISTED_CONSOLE_BYTES),
    ...(value.mode === "pipe"
      ? {
          stdout: typeof value.stdout === "string" ? tailUtf8(value.stdout, MAX_PERSISTED_LOG_BYTES) : "",
          stderr: typeof value.stderr === "string" ? tailUtf8(value.stderr, MAX_PERSISTED_LOG_BYTES) : "",
        }
      : {}),
  };
}

function replayFinishedTaskSnapshots(ctx: ExtensionContext): PersistedFinishedTask[] {
  const replayed = new Map<string, PersistedFinishedTask>();
  for (const rawEntry of ctx.sessionManager.getBranch()) {
    if (!isRecord(rawEntry) || rawEntry.type !== "custom" || rawEntry.customType !== TASK_SNAPSHOT_CUSTOM_TYPE) {
      continue;
    }
    const data = rawEntry.data;
    if (!isRecord(data) || data.schemaVersion !== TASK_SNAPSHOT_SCHEMA_VERSION) continue;
    if (data.action === "upsert") {
      const task = readPersistedFinishedTask(data.task);
      if (task) replayed.set(task.id, task);
      continue;
    }
    if (data.action !== "reconcile") continue;
    const removed = Array.isArray(data.removed)
      ? data.removed.filter((id): id is string => typeof id === "string")
      : [];
    const clearedRetention = Array.isArray(data.clearedRetention)
      ? data.clearedRetention.filter((id): id is string => typeof id === "string")
      : [];
    for (const id of removed) replayed.delete(id);
    for (const id of clearedRetention) {
      const task = replayed.get(id);
      if (task) replayed.set(id, { ...task, retainForNextAgentTurn: false });
    }
  }
  return Array.from(replayed.values()).sort((a, b) => a.order - b.order);
}

function enqueueSnapshotPersistence(operation: () => Promise<void> | void): Promise<void> {
  const pending = snapshotPersistenceQueue.then(operation, operation);
  snapshotPersistenceQueue = pending.catch(() => {});
  return pending;
}

export function setTaskSnapshotAppender(
  appender: ((event: PersistedTaskEvent) => void) | null,
): void {
  appendTaskSnapshotEntry = appender;
}

export function getTaskSnapshotAppender(): ((event: PersistedTaskEvent) => void) | null {
  return appendTaskSnapshotEntry;
}

export async function waitForSnapshotPersistence(): Promise<void> {
  await snapshotPersistenceQueue;
}

export function persistFinishedTaskSnapshot(task: BgTask): Promise<void> {
  return enqueueSnapshotPersistence(async () => {
    if (!appendTaskSnapshotEntry || !isFinalTaskStatus(task.status)) return;
    await flushConsole(task);
    if (!appendTaskSnapshotEntry || !tasks.has(task.id)) return;
    appendTaskSnapshotEntry({
      schemaVersion: TASK_SNAPSHOT_SCHEMA_VERSION,
      action: "upsert",
      task: serializeFinishedTask(task),
    });
  });
}

export function persistTaskReconciliation(removed: string[], clearedRetention: string[]): Promise<void> {
  if (removed.length === 0 && clearedRetention.length === 0) return snapshotPersistenceQueue;
  return enqueueSnapshotPersistence(() => {
    appendTaskSnapshotEntry?.({
      schemaVersion: TASK_SNAPSHOT_SCHEMA_VERSION,
      action: "reconcile",
      removed,
      clearedRetention,
    });
  });
}

export async function restoreFinishedTaskSnapshots(ctx: ExtensionContext): Promise<void> {
  await snapshotPersistenceQueue;
  const snapshots = replayFinishedTaskSnapshots(ctx);
  const finished = Array.from(tasks.values()).filter((task) => isFinalTaskStatus(task.status));
  for (const task of finished) {
    await flushConsole(task);
    tasks.delete(task.id);
    task.console.terminal.dispose();
    deleteTaskLogs(task);
  }

  for (const snapshot of snapshots) {
    if (tasks.has(snapshot.id)) continue;
    const console = createConsoleSession(snapshot.cols, snapshot.rows, snapshot.mode);
    const task: BgTask = {
      id: snapshot.id,
      name: snapshot.name,
      command: snapshot.command,
      mode: snapshot.mode,
      environment: snapshot.environment ?? null,
      process: null,
      control: null,
      controlDisposed: true,
      transportExitPending: null,
      console,
      attachment: {},
      status: snapshot.status,
      statusDetail: null,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      order: snapshot.order,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
      stdoutLogKey: taskLogKey(snapshot.id, "stdout"),
      stderrLogKey: taskLogKey(snapshot.id, "stderr"),
      stdoutLines: snapshot.stdoutLines,
      stderrLines: snapshot.stderrLines,
      done: new AbortController(),
      latestLog: snapshot.latestLog ? { ...snapshot.latestLog } : null,
      retainForNextAgentTurn: snapshot.retainForNextAgentTurn,
      stdoutPending: "",
      stderrPending: "",
      requestedStopSignal: null,
    };
    task.done.abort();
    tasks.set(task.id, task);
    if (snapshot.stdout) appendTaskLog(task.stdoutLogKey, snapshot.stdout);
    if (snapshot.stderr) appendTaskLog(task.stderrLogKey, snapshot.stderr);
    if (snapshot.consoleSnapshot) writeConsoleData(task, snapshot.consoleSnapshot);
    await flushConsole(task);
    task.latestLog = snapshot.latestLog ? { ...snapshot.latestLog } : null;
  }

  const ordered = Array.from(tasks.values()).sort((a, b) => a.order - b.order);
  tasks.clear();
  for (const task of ordered) tasks.set(task.id, task);
  nextTaskOrder = Math.max(nextTaskOrder, ...ordered.map((task) => task.order + 1), 0);
}

export function deleteTaskLogs(task: BgTask): void {
  outputLogStore.delete(task.stdoutLogKey);
  outputLogStore.delete(task.stderrLogKey);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Background task wait cancelled");
}

export function waitForOrderedToolCall(toolCallId: string, signal: AbortSignal | undefined): Promise<void> | undefined {
  const predecessor = orderedToolCalls.get(toolCallId)?.predecessor;
  if (!predecessor) return undefined;
  throwIfAborted(signal);
  if (!signal) return predecessor;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(
      signal.reason instanceof Error ? signal.reason : new Error("Background task tool call cancelled"),
    ));

    signal.addEventListener("abort", onAbort, { once: true });
    predecessor.then(() => finish(resolve));
    if (signal.aborted) onAbort();
  });
}

export async function waitUntilAllowed(
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

export async function waitForTaskEnd(task: BgTask, timeoutMs: number): Promise<void> {
  if (task.status !== "running" || task.done.signal.aborted) return;
  await waitUntilAllowed(timeoutMs, [task.done.signal], undefined);
}

export async function sendProcessSignal(
  task: BgTask,
  signal: BackgroundSignal,
  killTree = false,
  abortSignal?: AbortSignal,
): Promise<void> {
  throwIfAborted(abortSignal);
  const control = task.control;
  if (control) {
    if (
      control.supportedSignals
      && !control.supportedSignals.includes(signal)
    ) {
      throw new Error(
        `${signal} is not supported by the ${control.signalTarget ?? "adapter process"}.`,
      );
    }
    await control.sendSignal(signal, { abortSignal });
    throwIfAborted(abortSignal);
    return;
  }

  if (!(signal in osConstants.signals)) {
    throw new Error(`${signal} is not supported on ${process.platform}.`);
  }
  const localSignal = signal as NodeJS.Signals;
  const taskProcess = task.process;
  const pid = taskProcess?.pid;
  if (!taskProcess || !pid) throw new Error(`Task "${task.name}" process is unavailable.`);

  if (process.platform === "win32") {
    if (killTree && (signal === "SIGTERM" || signal === "SIGKILL")) {
      await killWindowsProcessTree(pid, signal);
      return;
    }
    if (taskProcess.kind === "pty") {
      if (localSignal !== "SIGTERM" && localSignal !== "SIGHUP") {
        throw new Error(`${localSignal} is not supported by node-pty on Windows; send a terminal control key or use bg_kill.`);
      }
      taskProcess.pty.kill();
      return;
    }
    if (!taskProcess.child.kill(localSignal)) throw new Error(`Failed to send ${localSignal} to task "${task.name}".`);
    return;
  }

  try {
    process.kill(-pid, localSignal);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "ESRCH") throw error;
    if (taskProcess.kind === "pty") taskProcess.pty.kill(localSignal);
    else if (!taskProcess.child.kill(localSignal)) throw error;
  }
}

export async function sendTaskSignal(
  task: BgTask,
  signal: "SIGTERM" | "SIGKILL",
  abortSignal?: AbortSignal,
): Promise<void> {
  task.requestedStopSignal = signal;
  try {
    await sendProcessSignal(task, signal, true, abortSignal);
  } catch (error) {
    task.requestedStopSignal = null;
    throw error;
  }
}

export async function settleDisconnectedTaskAfterSignal(
  task: BgTask,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (task.status !== "disconnected" || !task.control) return;
  const state = await task.control.probe({ abortSignal });
  if (state === "finished") {
    finishTask(
      task,
      task.exitCode,
      task.requestedStopSignal ?? task.signal,
      false,
      task.requestedStopSignal ? "stopped" : undefined,
    );
  }
}

export function writeTaskInput(task: BgTask, data: Buffer | string): void {
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

export function closeTaskInput(task: BgTask): void {
  const taskProcess = task.process;
  if (!taskProcess) throw new Error(`Task "${task.name}" process is unavailable.`);
  if (taskProcess.kind === "pty") {
    taskProcess.pty.write("\x04");
    return;
  }
  taskProcess.child.stdin?.end();
}

export function forceKillProcess(task: BgTask): void {
  const taskProcess = task.process;
  if (!taskProcess) return;
  if (taskProcess.kind === "pty") {
    if (process.platform === "win32") taskProcess.pty.kill();
    else taskProcess.pty.kill("SIGKILL");
    return;
  }
  taskProcess.child.kill("SIGKILL");
}

export function finishTask(
  task: BgTask,
  code: number | null,
  signal: string | null,
  failedToSpawn = false,
  statusOverride?: FinishedTaskStatus,
): void {
  if (isFinalTaskStatus(task.status)) return;
  task.endedAt = Date.now();
  task.exitCode = code;
  task.signal = task.requestedStopSignal ?? signal;
  task.process = null;
  task.status = statusOverride ?? (task.requestedStopSignal
    ? "stopped"
    : failedToSpawn
      ? "failed"
      : signal
        ? "stopped"
        : code === 0 ? "completed" : "failed");
  task.statusDetail = null;
  runningTasks.delete(task);
  task.done.abort();
  task.attachment.taskExited?.();
  notifyTasksChanged();
  // Snapshot persistence does not change visible task state; avoid a second,
  // delayed widget render after the task has already transitioned to finished.
  void persistFinishedTaskSnapshot(task).catch(() => {});
  void disposeTaskControl(task).catch(() => {});
}

function disconnectTask(
  task: BgTask,
  code: number | null,
  signal: string | null,
  error: string,
): void {
  if (task.status !== "running") return;
  task.endedAt = Date.now();
  task.exitCode = code;
  task.signal = signal;
  task.process = null;
  task.status = "disconnected";
  task.statusDetail = error;
  runningTasks.delete(task);
  task.done.abort();
  task.attachment.taskExited?.();
  notifyTasksChanged();
}

export function settleTaskTransportExit(
  task: BgTask,
  code: number | null,
  signal: string | null,
  failedToSpawn = false,
): void {
  if (task.transportExitPending || task.status !== "running") return;
  task.process = null;
  const operation = (async () => {
    if (
      failedToSpawn
      || task.requestedStopSignal
      || !task.control
    ) {
      finishTask(task, code, signal, failedToSpawn);
      return;
    }

    let disposition: BackgroundTransportExitDisposition;
    try {
      disposition = await task.control.onTransportExit({
        exitCode: code,
        signal,
      });
    } catch (error) {
      disposition = {
        state: "disconnected",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (isFinalTaskStatus(task.status)) return;
    if (task.requestedStopSignal) {
      finishTask(task, code, signal);
      return;
    }
    if (disposition.state === "finished") {
      finishTask(task, code, signal);
      return;
    }
    if (disposition.state === "stopped") {
      finishTask(
        task,
        code,
        disposition.signal ?? signal ?? "transport-exit",
        false,
        "stopped",
      );
      return;
    }
    disconnectTask(task, code, signal, disposition.error);
  })();
  const pending = operation
    .catch((error) => {
      if (task.status === "running") {
        disconnectTask(
          task,
          code,
          signal,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .finally(() => {
      if (task.transportExitPending === pending) task.transportExitPending = null;
    });
  task.transportExitPending = pending;
  void pending;
}
