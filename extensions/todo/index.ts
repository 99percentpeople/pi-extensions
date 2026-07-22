import { StringEnum } from "@earendil-works/pi-ai";
import { keyHint, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  MAX_TODO_TASKS,
  TODO_SCHEMA_VERSION,
  TODO_STATE_CUSTOM_TYPE,
  TODO_TOOL_NAME,
  cloneTodoState,
  createEmptyTodoState,
  getTodoTasks,
  needsTodoContextCheckpoint,
  removeCompletedTasks,
  replayTodoState,
  type TodoState,
  type TodoStatus,
  writeTodoSnapshot,
} from "./state.ts";

const WIDGET_KEY = "pi-todo-widget";
const COLLAPSED_TASK_LIMIT = 3;

interface TodoDisplayTask {
  subject: string;
  status?: TodoStatus;
}

const TodoKeySchema = Type.String({
  description: "Stable 1-40 character lowercase task key, e.g. inspect-api or write-tests",
  minLength: 1,
  maxLength: 40,
  pattern: "^[a-z0-9][a-z0-9._-]*$",
});

const TodoTaskSchema = Type.Object({
  key: TodoKeySchema,
  subject: Type.Optional(Type.String({
    description: "Short imperative task subject; required for a new key, omitted to preserve an existing value",
    minLength: 1,
    maxLength: 160,
  })),
  description: Type.Optional(Type.String({
    description: "Long-form task description; omitted to preserve, empty string to clear",
    maxLength: 2_000,
  })),
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const, {
    description: "Current task status; required for a new key, omitted to preserve an existing value",
  })),
  dependsOn: Type.Optional(Type.Array(Type.String(), {
    description: "Dependency keys; omitted to preserve, empty array to clear",
    maxItems: 20,
  })),
});

const TodoParamsSchema = Type.Object({
  tasks: Type.Array(TodoTaskSchema, {
    description: "Complete authoritative list of tasks to retain; omitted current keys are deleted, existing tasks may omit unchanged fields, and new keys require subject and status",
    maxItems: MAX_TODO_TASKS,
  }),
  baseRevision: Type.Optional(Type.Integer({
    description: "Revision shown in current todo context; rejects stale writes when provided",
    minimum: 0,
  })),
});

function formatChange(details: TodoState): string {
  const visible = getTodoTasks(details);
  if (visible.length === 0) return `Todo plan cleared (revision ${details.revision}).`;
  const lines = visible.map((task) => {
    const description = task.description ? ` — ${task.description}` : "";
    const deps = task.dependsOn?.length ? ` ← ${task.dependsOn.join(",")}` : "";
    return `[${task.status}] ${task.key}: ${task.subject}${description}${deps}`;
  });
  return `Todo plan revision ${details.revision}:\n${lines.join("\n")}`;
}

function renderTaskLine(task: TodoDisplayTask, theme: Theme): string {
  if (!task.status) return theme.fg("text", task.subject);
  const glyph = task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : "○";
  const color = task.status === "completed" ? "success" : task.status === "in_progress" ? "warning" : "dim";
  let subject = theme.fg(task.status === "completed" ? "dim" : "text", task.subject);
  if (task.status === "completed") subject = theme.strikethrough(subject);
  return `${theme.fg(color, glyph)} ${subject}`;
}

function getCollapsedTodoTasks<T extends TodoDisplayTask>(tasks: readonly T[]): T[] {
  if (tasks.length <= COLLAPSED_TASK_LIMIT) return [...tasks];
  if (tasks.every((task) => task.status === "completed")) {
    return tasks.slice(-COLLAPSED_TASK_LIMIT);
  }
  const activeIndex = tasks.findIndex((task) => task.status === "in_progress");
  if (activeIndex < 0) return tasks.slice(0, COLLAPSED_TASK_LIMIT);
  const start = Math.min(
    Math.max(0, activeIndex - 1),
    tasks.length - COLLAPSED_TASK_LIMIT,
  );
  return tasks.slice(start, start + COLLAPSED_TASK_LIMIT);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function resolveDraftTodoTasks(rawTasks: unknown, state: TodoState): TodoDisplayTask[] {
  if (!Array.isArray(rawTasks)) return [];
  const currentByKey = new Map(getTodoTasks(state).map((task) => [task.key, task]));

  return rawTasks.flatMap((rawTask) => {
    const draft = rawTask && typeof rawTask === "object"
      ? rawTask as { key?: unknown; subject?: unknown; status?: unknown }
      : {};
    const key = typeof draft.key === "string" ? draft.key.trim() : "";
    const current = key ? currentByKey.get(key) : undefined;
    const streamedSubject = typeof draft.subject === "string" ? draft.subject.trim() : "";

    const subject = streamedSubject || current?.subject;
    if (!subject) return [];
    return [{
      subject,
      status: isTodoStatus(draft.status) ? draft.status : current?.status,
    }];
  });
}

function renderTodoWidget(state: TodoState, width: number, expanded: boolean, theme: Theme): string[] {
  const tasks = getTodoTasks(state);
  if (tasks.length === 0) return [];
  const completed = tasks.filter((task) => task.status === "completed").length;
  const displayed = expanded ? tasks : getCollapsedTodoTasks(tasks);
  const canExpand = tasks.length > COLLAPSED_TASK_LIMIT;
  const hint = canExpand
    ? theme.fg("muted", ` · ${keyHint("app.tools.expand", expanded ? "to collapse" : "to expand")}`)
    : "";
  const lines = [
    theme.fg("accent", theme.bold(`Todo ${completed}/${tasks.length} completed`)) +
      theme.fg("muted", ` · rev ${state.revision}`) + hint,
  ];

  lines.push(...displayed.map((task) => renderTaskLine(task, theme)));

  return lines.map((line) => truncateToWidth(line, width, "…"));
}

export default function todoExtension(pi: ExtensionAPI): void {
  let state = createEmptyTodoState();
  let uiContext: ExtensionContext | undefined;
  let widgetRegistered = false;
  let widgetTui: TUI | undefined;
  let contextCheckpointNeeded = false;

  const clearWidget = (): void => {
    if (widgetRegistered && uiContext?.hasUI) {
      try { uiContext.ui.setWidget(WIDGET_KEY, undefined); } catch {}
    }
    widgetRegistered = false;
    widgetTui = undefined;
  };

  const updateWidget = (ctx?: ExtensionContext): void => {
    if (ctx) uiContext = ctx;
    if (!uiContext?.hasUI || uiContext.mode !== "tui") return;
    if (getTodoTasks(state).length === 0) {
      clearWidget();
      return;
    }
    if (!widgetRegistered) {
      uiContext.ui.setWidget(
        WIDGET_KEY,
        (tui: TUI, theme: Theme) => {
          widgetTui = tui;
          return {
            render: (width: number) =>
              renderTodoWidget(state, width, uiContext?.ui.getToolsExpanded() ?? false, theme),
            invalidate: () => {},
            dispose: () => { if (widgetTui === tui) widgetTui = undefined; },
          };
        },
        { placement: "aboveEditor" },
      );
      widgetRegistered = true;
    } else {
      widgetTui?.requestRender();
    }
  };

  pi.registerTool({
    name: TODO_TOOL_NAME,
    label: "Todo",
    description: `Maintain the task plan with one atomic update. Every call replaces the task list: include each key to keep, and omit a key to delete it. Existing tasks may omit unchanged fields; new tasks require subject and status. Up to ${MAX_TODO_TASKS} tasks; an empty list clears the plan.`,
    promptSnippet: "Maintain the task plan with one atomic update",
    promptGuidelines: [
      "When a task needs a plan of 3+ steps, define it yourself and call todo before beginning implementation or other substantive work.",
      "Each todo call replaces the task list. Include every key to keep; omitted keys are deleted.",
      "Keep keys stable. Existing tasks may omit unchanged fields; new tasks require subject and status. Include baseRevision when available.",
      "Use dependsOn only for real prerequisites; dependencies must be completed before a task starts or completes.",
      "Mark work completed only after implementation and verification succeed. Completed tasks are removed next turn unless they still block unfinished work.",
    ],
    parameters: TodoParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Todo update cancelled");
      const details = writeTodoSnapshot(state, params);
      state = cloneTodoState(details);
      updateWidget(ctx);
      return {
        content: [{ type: "text", text: formatChange(details) }],
        details,
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const tasks = resolveDraftTodoTasks(args.tasks, state);
      const hasTaskList = Array.isArray(args.tasks);
      const count = hasTaskList ? args.tasks.length : 0;
      const canExpand = tasks.length > COLLAPSED_TASK_LIMIT;
      const displayed = context.expanded ? tasks : getCollapsedTodoTasks(tasks);
      const hint = canExpand
        ? theme.fg("muted", ` · ${keyHint("app.tools.expand", context.expanded ? "to collapse" : "to expand")}`)
        : "";
      const summary = hasTaskList ? theme.fg("accent", `${count} task${count === 1 ? "" : "s"}`) : "";
      const lines = [[theme.fg("toolTitle", theme.bold("todo")), summary].filter(Boolean).join(" ") + hint];
      if (displayed.length > 0) {
        lines.push(...displayed.map((task) => renderTaskLine(task, theme)));
      }
      text.setText(lines.join("\n"));
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Validating todo plan..."));
        return text;
      }
      if (!result.details) {
        const output = result.content
          .filter((item): item is { type: "text"; text: string } => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        text.setText(output ? theme.fg(context.isError ? "error" : "toolOutput", output) : "");
        return text;
      }
      // The completed call remains visible above this result and already contains
      // the final task list. Keep successful results empty to avoid rendering it twice.
      text.setText("");
      return text;
    },
  });

  const restore = (ctx: ExtensionContext): void => {
    clearWidget();
    const branch = [...ctx.sessionManager.getBranch()];
    state = replayTodoState({ sessionManager: { getBranch: () => branch } });
    contextCheckpointNeeded = needsTodoContextCheckpoint(branch);
    uiContext = ctx;
    updateWidget(ctx);
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("session_compact", async (event, ctx) => {
    const checkpoint = cloneTodoState(state);
    pi.appendEntry(TODO_STATE_CUSTOM_TYPE, checkpoint);
    if (event.willRetry || ctx.hasPendingMessages()) {
      contextCheckpointNeeded = false;
      pi.sendMessage({
        customType: TODO_STATE_CUSTOM_TYPE,
        content: formatChange(checkpoint),
        display: false,
        details: checkpoint,
      }, { deliverAs: "steer" });
    } else {
      contextCheckpointNeeded = true;
    }
  });
  pi.on("session_shutdown", async () => {
    clearWidget();
    uiContext = undefined;
    contextCheckpointNeeded = false;
  });

  pi.on("before_agent_start", async () => {
    const details = removeCompletedTasks(state);
    if (details) {
      state = cloneTodoState(details);
      updateWidget();
    }
    if (!details && !contextCheckpointNeeded) return;

    contextCheckpointNeeded = false;
    const checkpoint = details ?? cloneTodoState(state);
    return {
      message: {
        customType: TODO_STATE_CUSTOM_TYPE,
        content: formatChange(checkpoint),
        display: false,
        details: checkpoint,
      },
    };
  });
}

export { TODO_SCHEMA_VERSION };
