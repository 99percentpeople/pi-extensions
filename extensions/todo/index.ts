import { StringEnum } from "@earendil-works/pi-ai";
import { keyHint, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  MAX_TODO_TASKS,
  TODO_SCHEMA_VERSION,
  TODO_STATE_CUSTOM_TYPE,
  TODO_TOOL_NAME,
  archiveCompletedTasks,
  cloneTodoState,
  createEmptyTodoState,
  getVisibleTasks,
  replayTodoState,
  type TodoDetails,
  type TodoState,
  writeTodoSnapshot,
} from "./state.ts";

const WIDGET_KEY = "pi-todo-widget";

const TodoTaskSchema = Type.Object({
  key: Type.String({
    description: "Stable 1-40 character lowercase task key, e.g. inspect-api or write-tests",
    minLength: 1,
    maxLength: 40,
    pattern: "^[a-z0-9][a-z0-9._-]*$",
  }),
  subject: Type.Optional(Type.String({
    description: "Short imperative task subject; required for a new key, omitted to preserve an existing value",
    minLength: 1,
    maxLength: 160,
  })),
  description: Type.Optional(Type.String({
    description: "Long-form task description; omitted to preserve, empty string to clear",
    maxLength: 2_000,
  })),
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "cancelled"] as const, {
    description: "Current task status; required for a new key, omitted to preserve an existing value",
  })),
  dependsOn: Type.Optional(Type.Array(Type.String(), {
    description: "Dependency keys; omitted to preserve, empty array to clear",
    maxItems: 20,
  })),
});

const TodoParamsSchema = Type.Object({
  tasks: Type.Array(TodoTaskSchema, {
    description: "Complete authoritative task-key list; existing tasks may omit unchanged fields, new keys require subject and status",
    maxItems: MAX_TODO_TASKS,
  }),
  baseRevision: Type.Optional(Type.Integer({
    description: "Revision shown in current todo context; rejects stale writes when provided",
    minimum: 0,
  })),
});

function formatChange(details: TodoDetails): string {
  const visible = getVisibleTasks(details);
  if (visible.length === 0) return `Todo plan cleared (revision ${details.revision}).`;
  const lines = visible.map((task) => {
    const description = task.description ? ` — ${task.description}` : "";
    const deps = task.dependsOn?.length ? ` ← ${task.dependsOn.join(",")}` : "";
    return `[${task.status}] ${task.key}: ${task.subject}${description}${deps}`;
  });
  return `Todo plan revision ${details.revision}:\n${lines.join("\n")}`;
}

function renderTaskLine(task: TodoDetails["tasks"][number], theme: Theme): string {
  const glyph = task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : task.status === "cancelled" ? "×" : "○";
  const color = task.status === "completed" ? "success" : task.status === "in_progress" ? "warning" : task.status === "cancelled" ? "muted" : "dim";
  let subject = theme.fg(task.status === "completed" || task.status === "cancelled" ? "dim" : "text", task.subject);
  if (task.status === "completed" || task.status === "cancelled") subject = theme.strikethrough(subject);
  return `${theme.fg(color, glyph)} ${subject}`;
}

function renderTodoWidget(state: TodoState, width: number, expanded: boolean, theme: Theme): string[] {
  const tasks = getVisibleTasks(state);
  if (tasks.length === 0) return [];
  const completed = tasks.filter((task) => task.status === "completed").length;
  const current = tasks.filter((task) => task.status === "in_progress");
  const hint = keyHint("app.tools.expand", expanded ? "to collapse" : "to expand");
  const lines = [
    theme.fg("accent", theme.bold(`Todo ${completed}/${tasks.length} completed`)) +
      theme.fg("muted", ` · rev ${state.revision} · ${hint}`)
  ];

  if (expanded) {
    lines.push(...tasks.map((task) => renderTaskLine(task, theme)));
  } else if (current.length > 0) {
    lines.push(...current.map((task) => renderTaskLine(task, theme)));
  } else if (tasks.length > 0 && completed !== tasks.length) {
    lines.push(theme.fg("dim", "○ No task in progress"));
  }

  return lines.map((line) => truncateToWidth(line, width, "…"));
}

function renderTaskLines(state: TodoState, theme: Theme): string[] {
  const tasks = getVisibleTasks(state);
  if (tasks.length === 0) return [];
  return tasks.map((task) => renderTaskLine(task, theme));
}

export default function todoExtension(pi: ExtensionAPI): void {
  let state = createEmptyTodoState();
  let uiContext: ExtensionContext | undefined;
  let widgetRegistered = false;
  let widgetTui: TUI | undefined;

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
    if (getVisibleTasks(state).length === 0) {
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
    description: `Atomically replace the complete todo plan with up to ${MAX_TODO_TASKS} tasks. Include every current task key; existing tasks may omit unchanged fields, while new keys require subject and status. Omitted tasks are archived. An empty tasks array clears the visible plan.`,
    promptSnippet: "Atomically write or sparsely update the complete task plan",
    promptGuidelines: [
      "Use todo for complex work with 3+ steps or when the user gives a task list; write the complete plan in one todo call rather than one create call per task.",
      "Every todo call must include the complete current key list from the latest result or checkpoint. For existing keys, omit unchanged fields; for new keys, provide subject and status. Omitted keys are archived.",
      "Keep stable todo task keys, do not reintroduce auto-archived keys, and include baseRevision when a revision is shown.",
      "Do not mark todo work completed while tests fail, implementation is partial, or blockers remain.",
      "Use dependsOn task keys for real prerequisites. A task cannot be in_progress or completed until all of its dependencies are completed. Completed tasks are automatically archived on the next agent turn unless they are still blocking a pending or in_progress task.",
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
      const count = args.tasks?.length ?? 0;
      text.setText(
        theme.fg("toolTitle", theme.bold("todo ")) +
        theme.fg("accent", `${count} task${count === 1 ? "" : "s"}`),
      );
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Validating todo plan..."));
        return text;
      }
      const details = result.details as TodoDetails | undefined;
      if (!details) {
        text.setText(theme.fg("success", "✓"));
        return text;
      }
      const taskLines = renderTaskLines(details, theme);
      text.setText(taskLines.join("\n"));
      return text;
    },
  });

  const restore = (ctx: ExtensionContext): void => {
    clearWidget();
    state = replayTodoState(ctx);
    uiContext = ctx;
    updateWidget(ctx);
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", async () => {
    clearWidget();
    uiContext = undefined;
  });

  pi.on("before_agent_start", async () => {
    const details = archiveCompletedTasks(state);
    if (!details) return;

    state = cloneTodoState(details);
    updateWidget();
    return {
      message: {
        customType: TODO_STATE_CUSTOM_TYPE,
        content: formatChange(details),
        display: false,
        details,
      },
    };
  });
}

export { TODO_SCHEMA_VERSION };
