import {
  keyHint,
  keyText,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import {
  DEFAULT_BACKGROUND_TASKS_CONFIG,
  type BackgroundOutputPreview,
  type BackgroundTasksConfig,
} from "./config.ts";
import {
  MAX_DISPLAY_LOG_CHARS,
  deleteTaskLogs,
  flushConsole,
  isFinalTaskStatus,
  runningTasks,
  tasks,
  truncateText,
} from "./runtime.ts";
import type { BgTask } from "./types.ts";

export const WIDGET_KEY = "bg-tasks-widget";
const WIDGET_REFRESH_INTERVAL_MS = 1000;
let backgroundTasksConfig = { ...DEFAULT_BACKGROUND_TASKS_CONFIG };
let uiCtx: ExtensionContext | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let widgetTui: TUI | null = null;
let widgetRegistered = false;

export function setBackgroundTasksConfig(config: BackgroundTasksConfig): void {
  backgroundTasksConfig = { ...config };
}

export function getBackgroundTasksConfig(): BackgroundTasksConfig {
  return { ...backgroundTasksConfig };
}

export function setWidgetContext(ctx: ExtensionContext | null): void {
  uiCtx = ctx;
}

export function getWidgetContext(): ExtensionContext | null {
  return uiCtx;
}

function getRunningTasks(): BgTask[] {
  return Array.from(runningTasks);
}

function getVisibleTasks(): BgTask[] {
  return Array.from(tasks.values());
}

interface TaskReconciliation {
  removed: string[];
  clearedRetention: string[];
}

export async function discardExpiredFinishedTasks(): Promise<TaskReconciliation> {
  const expired = Array.from(tasks.values()).filter(
    (task) => isFinalTaskStatus(task.status) && !task.retainForNextAgentTurn,
  );
  const clearedRetention: string[] = [];
  for (const task of tasks.values()) {
    if (!task.retainForNextAgentTurn) continue;
    task.retainForNextAgentTurn = false;
    if (isFinalTaskStatus(task.status)) clearedRetention.push(task.id);
  }
  for (const task of expired) tasks.delete(task.id);
  await Promise.all(expired.map(async (task) => {
    await flushConsole(task);
    task.console.terminal.dispose();
    deleteTaskLogs(task);
  }));
  return { removed: expired.map((task) => task.id), clearedRetention };
}

function stopRefreshTimer() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    // A timer callback may already be queued when the final task exits. Avoid
    // issuing one stale render after finishTask has stopped the ticker.
    if (runningTasks.size === 0) {
      stopRefreshTimer();
      return;
    }
    updateWidget();
  }, WIDGET_REFRESH_INTERVAL_MS);
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

function getCollapsedBackgroundTasks(
  visible: readonly BgTask[],
  collapsedTaskLimit: number,
): BgTask[] {
  if (collapsedTaskLimit <= 0) return [];
  if (visible.length <= collapsedTaskLimit) return [...visible];

  const selected = new Set(
    visible
      .filter((task) => task.status === "running" || task.status === "disconnected")
      .slice(-collapsedTaskLimit),
  );
  const remaining = collapsedTaskLimit - selected.size;
  if (remaining > 0) {
    for (const task of visible
      .filter((candidate) => isFinalTaskStatus(candidate.status))
      .slice(-remaining)) {
      selected.add(task);
    }
  }
  return visible.filter((task) => selected.has(task));
}

function shouldShowOutputPreview(
  task: BgTask,
  outputPreview: BackgroundOutputPreview,
): boolean {
  if (task.mode !== "pipe" || outputPreview === "off") return false;
  if (outputPreview === "all") return true;
  if (outputPreview === "finished") return task.status !== "running";
  return task.status === "failed";
}

function renderWidgetLines(theme?: Theme, width = MAX_DISPLAY_LOG_CHARS, expanded = false): string[] {
  const visible = getVisibleTasks();
  const displayed = expanded
    ? visible
    : getCollapsedBackgroundTasks(visible, backgroundTasksConfig.collapsedTaskLimit);
  const runningCount = getRunningTasks().length;
  const disconnectedCount = visible.filter((task) => task.status === "disconnected").length;
  const finishedCount = visible.filter((task) => isFinalTaskStatus(task.status)).length;
  const now = Date.now();
  const lines: string[] = [];

  for (const [index, task] of displayed.entries()) {
    const isLast = index === displayed.length - 1;
    const branch = isLast ? "└─" : "├─";
    const duration = formatWidgetDuration((task.endedAt ?? now) - task.startedAt);
    const environment = task.environment ? ` @ ${task.environment}` : "";
    if (task.status === "running") {
      const output = task.mode === "pty"
        ? `pty:${task.console.terminal.cols}x${task.console.terminal.rows}`
        : `stdout:${task.stdoutLines} stderr:${task.stderrLines}`;
      lines.push(theme
        ? `${theme.fg("dim", branch)} ${theme.fg("warning", "◐")} ${theme.bold(theme.fg("accent", task.name))} ${theme.fg("dim", `(${task.id})`)} ${theme.fg("muted", duration)} ${theme.fg("dim", output)}${environment ? theme.fg("muted", environment) : ""}`
        : `${branch} ◐ ${task.name} (${task.id}) ${duration} ${output}${environment}`);
    } else {
      const glyph = task.status === "completed"
        ? "✓"
        : task.status === "failed"
          ? "×"
          : task.status === "disconnected"
            ? "!"
            : "■";
      const color = task.status === "completed"
        ? "success"
        : task.status === "failed"
          ? "error"
          : "warning";
      const exit = task.exitCode !== null ? ` exit=${task.exitCode}` : "";
      const signal = task.signal ? ` signal=${task.signal}` : "";
      lines.push(theme
        ? `${theme.fg("dim", branch)} ${theme.fg(color, glyph)} ${theme.bold(theme.fg("accent", task.name))} ${theme.fg("dim", `(${task.id})`)} ${theme.fg(color, task.status)} ${theme.fg("muted", duration)}${theme.fg("dim", `${exit}${signal}`)}${environment ? theme.fg("muted", environment) : ""}`
        : `${branch} ${glyph} ${task.name} (${task.id}) ${task.status} ${duration}${exit}${signal}${environment}`);
    }

    if (shouldShowOutputPreview(task, backgroundTasksConfig.outputPreview)) {
      const latestLog = task.latestLog;
      const output = latestLog
        ? `[${latestLog.stream}] ${truncateText(latestLog.text, MAX_DISPLAY_LOG_CHARS)}`
        : "(no output)";
      const outputBranch = isLast ? "   └─" : "│  └─";
      lines.push(theme
        ? `${theme.fg("dim", outputBranch)} ${theme.fg("muted", output)}`
        : `${outputBranch} ${output}`);
    }
  }

  const hintDescription = expanded ? "to collapse" : "to expand";
  const hint = visible.length > backgroundTasksConfig.collapsedTaskLimit
    ? theme
      ? theme.fg("muted", " · ") + keyHint("app.tools.expand", hintDescription)
      : ` · ${keyText("app.tools.expand")} ${hintDescription}`
    : "";
  const title = `${visible.length} background task${visible.length === 1 ? "" : "s"}`;
  const statusParts = [
    ...(runningCount > 0 ? [{ color: "warning" as const, text: `${runningCount} running` }] : []),
    ...(disconnectedCount > 0
      ? [{ color: "warning" as const, text: `${disconnectedCount} disconnected` }]
      : []),
    ...(finishedCount > 0 ? [{ color: "muted" as const, text: `${finishedCount} finished` }] : []),
  ];
  const header = theme
    ? theme.fg("accent", theme.bold(title)) +
      statusParts.map(({ color, text }) => theme.fg("muted", " · ") + theme.fg(color, text)).join("") +
      hint
    : [title, ...statusParts.map(({ text }) => text)].join(" · ") + hint;
  const rendered = [header, ...lines];
  return rendered.map((line) => truncateToWidth(line, width, "…"));
}

export function clearWidget(): void {
  stopRefreshTimer();
  if (widgetRegistered && uiCtx?.hasUI) uiCtx.ui.setWidget(WIDGET_KEY, undefined);
  widgetTui = null;
  widgetRegistered = false;
}

export function updateWidget(): void {
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
