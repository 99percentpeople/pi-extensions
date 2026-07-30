import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import todoExtension from "../extensions/todo/index.ts";
import {
  TODO_SCHEMA_VERSION,
  TodoValidationError,
  cloneTodoState,
  createEmptyTodoState,
  getTodoTasks,
  needsTodoContextCheckpoint,
  removeCompletedTasks,
  replayTodoState,
  type TodoState,
  type TodoTaskInput,
  writeTodoSnapshot,
} from "../extensions/todo/state.ts";

const initialPlan: TodoTaskInput[] = [
  {
    key: "inspect",
    subject: "Inspect the existing extension",
    description: "Review the current architecture and constraints",
    status: "in_progress",
  },
  {
    key: "design",
    subject: "Design the snapshot protocol",
    status: "pending",
    dependsOn: ["inspect"],
  },
  {
    key: "verify",
    subject: "Verify the implementation",
    status: "pending",
    dependsOn: ["design"],
  },
];

function asState(details: ReturnType<typeof writeTodoSnapshot>): TodoState {
  return cloneTodoState(details);
}

test("todo writes a complete dependency plan atomically and hands work off in one update", () => {
  const first = writeTodoSnapshot(createEmptyTodoState(), { tasks: initialPlan, baseRevision: 0 });
  assert.equal(first.schemaVersion, TODO_SCHEMA_VERSION);
  assert.equal(first.revision, 1);
  assert.deepEqual(first.change, {
    added: ["inspect", "design", "verify"],
    updated: [],
    removed: [],
  });
  assert.deepEqual(getTodoTasks(first).map((task) => task.key), ["inspect", "design", "verify"]);
  assert.equal("nextId" in first, false);
  assert.equal(first.tasks.some((task) => "id" in task || "archived" in task), false);

  const handoff: TodoTaskInput[] = [
    { key: "inspect", status: "completed" },
    {
      key: "design",
      status: "in_progress",
    },
    { key: "verify" },
  ];
  const second = writeTodoSnapshot(asState(first), { tasks: handoff, baseRevision: 1 });
  assert.equal(second.revision, 2);
  assert.deepEqual(second.change.updated, ["inspect", "design"]);
  assert.deepEqual(getTodoTasks(second).map((task) => task.status), ["completed", "in_progress", "pending"]);
  assert.deepEqual(getTodoTasks(second).map((task) => task.subject), initialPlan.map((task) => task.subject));
  assert.equal(getTodoTasks(second)[0].description, "Review the current architecture and constraints");
  assert.deepEqual(getTodoTasks(second).map((task) => task.dependsOn), [undefined, ["inspect"], ["design"]]);
});

test("todo sparse snapshots preserve omitted fields, support explicit clears, and reject incomplete new keys", () => {
  const first = writeTodoSnapshot(createEmptyTodoState(), {
    tasks: [
      { key: "root", subject: "Root task", description: "Keep this", status: "completed" },
      { key: "child", subject: "Child task", status: "pending", dependsOn: ["root"] },
    ],
  });
  const before = asState(first);

  const noOp = writeTodoSnapshot(before, {
    tasks: [{ key: "root" }, { key: "child" }],
    baseRevision: 1,
  });
  assert.equal(noOp.revision, 1);
  assert.deepEqual(noOp.change, { added: [], updated: [], removed: [] });
  assert.equal(getTodoTasks(noOp)[0].description, "Keep this");
  assert.deepEqual(getTodoTasks(noOp)[1].dependsOn, ["root"]);

  const cleared = writeTodoSnapshot(asState(noOp), {
    tasks: [{ key: "root", description: "" }, { key: "child", dependsOn: [] }],
    baseRevision: 1,
  });
  assert.equal(cleared.revision, 2);
  assert.equal(getTodoTasks(cleared)[0].description, undefined);
  assert.equal(getTodoTasks(cleared)[1].dependsOn, undefined);

  const reordered = writeTodoSnapshot(asState(cleared), {
    tasks: [{ key: "child" }, { key: "root" }],
    baseRevision: 2,
  });
  assert.equal(reordered.revision, 3, "changing task order is a state change");
  assert.deepEqual(getTodoTasks(reordered).map((task) => task.key), ["child", "root"]);

  const stable = asState(reordered);
  assert.throws(
    () => writeTodoSnapshot(stable, { tasks: [{ key: "new-task" }] }),
    /subject is required for new task new-task/,
  );
  assert.throws(
    () => writeTodoSnapshot(stable, { tasks: [{ key: "new-task", subject: "New task" }] }),
    /status is required for new task new-task/,
  );
  assert.deepEqual(stable, asState(reordered), "failed sparse updates must not mutate state");
});

test("todo rejects stale, partial, cyclic, and dependency-inconsistent snapshots without mutating state", () => {
  const first = writeTodoSnapshot(createEmptyTodoState(), { tasks: initialPlan });
  const state = asState(first);
  const before = cloneTodoState(state);

  assert.throws(
    () => writeTodoSnapshot(state, { tasks: initialPlan, baseRevision: 0 }),
    /stale todo revision/,
  );
  assert.throws(
    () => writeTodoSnapshot(state, {
      tasks: [{ key: "blocked", subject: "Start too early", status: "in_progress", dependsOn: ["missing"] }],
    }),
    /references missing task missing/,
  );
  assert.throws(
    () => writeTodoSnapshot(state, {
      tasks: [
        { key: "a", subject: "Task A", status: "pending", dependsOn: ["b"] },
        { key: "b", subject: "Task B", status: "pending", dependsOn: ["a"] },
      ],
    }),
    /dependency cycle/,
  );
  assert.deepEqual(state, before, "failed validation must not mutate the input state");
});

test("todo deletes omitted tasks without cancelled or archived state", () => {
  const first = writeTodoSnapshot(createEmptyTodoState(), { tasks: initialPlan });
  const removed = writeTodoSnapshot(asState(first), { tasks: [initialPlan[0]] });

  assert.equal(removed.revision, 2);
  assert.deepEqual(removed.change.removed, ["design", "verify"]);
  assert.deepEqual(getTodoTasks(removed).map((task) => task.key), ["inspect"]);
  assert.equal(removed.tasks.some((task) => task.key === "design" || task.key === "verify"), false);
  assert.equal(JSON.stringify(removed).includes("cancelled"), false);
  assert.equal(JSON.stringify(removed).includes("archived"), false);
});

test("todo prunes completed soft dependencies but preserves unfinished hard dependencies", () => {
  const completed = writeTodoSnapshot(createEmptyTodoState(), {
    tasks: [
      { key: "prerequisite", subject: "Complete prerequisite", status: "completed" },
      {
        key: "finished",
        subject: "Finish dependent work",
        status: "completed",
        dependsOn: ["prerequisite"],
      },
    ],
  });
  const pruned = writeTodoSnapshot(asState(completed), { tasks: [{ key: "finished" }] });
  assert.deepEqual(pruned.change, {
    added: [],
    updated: ["finished"],
    removed: ["prerequisite"],
  });
  assert.deepEqual(getTodoTasks(pruned), [{
    key: "finished",
    subject: "Finish dependent work",
    status: "completed",
  }]);

  const unfinished = writeTodoSnapshot(createEmptyTodoState(), {
    tasks: [
      { key: "prerequisite", subject: "Complete prerequisite", status: "completed" },
      {
        key: "remaining",
        subject: "Continue dependent work",
        status: "pending",
        dependsOn: ["prerequisite"],
      },
    ],
  });
  assert.throws(
    () => writeTodoSnapshot(asState(unfinished), { tasks: [{ key: "remaining" }] }),
    /dependsOn references missing task prerequisite/,
  );
});

test("todo auto-removes only unneeded completions and cleans surviving dependencies", () => {
  const current = writeTodoSnapshot(createEmptyTodoState(), {
    tasks: [
      { key: "step-a", subject: "Step A", status: "completed" },
      { key: "step-b", subject: "Step B", status: "completed", dependsOn: ["step-a"] },
      { key: "step-c", subject: "Step C", status: "pending", dependsOn: ["step-b"] },
    ],
  });
  const before = cloneTodoState(current);
  const removed = removeCompletedTasks(before);
  assert.ok(removed);
  assert.equal(removed.revision, 2);
  assert.deepEqual(removed.change, {
    added: [],
    updated: ["step-b"],
    removed: ["step-a"],
  });
  assert.deepEqual(getTodoTasks(removed).map((task) => [task.key, task.dependsOn]), [
    ["step-b", undefined],
    ["step-c", ["step-b"]],
  ]);
  assert.deepEqual(before, cloneTodoState(current), "automatic removal must not mutate its input state");
});

test("todo replay restores persisted tool results and drops removed fields", () => {
  const current = writeTodoSnapshot(createEmptyTodoState(), {
    tasks: [{ key: "modern", subject: "Use modern state", status: "pending" }],
  });
  const persisted = {
    ...current,
    tasks: current.tasks.map((task) => ({ ...task, activeForm: "legacy progress label" })),
  };
  const replayed = replayTodoState({
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "toolResult", toolName: "todo", details: persisted } },
      ],
    },
  });
  assert.equal(replayed.revision, current.revision);
  assert.deepEqual(getTodoTasks(replayed).map((task) => task.key), ["modern"]);
  assert.equal("activeForm" in getTodoTasks(replayed)[0], false, "replay should discard removed activeForm data");
});

test("todo replay ignores malformed current-schema checkpoints", () => {
  const valid = writeTodoSnapshot(createEmptyTodoState(), {
    tasks: [{ key: "valid", subject: "Keep valid state", status: "pending" }],
  });
  const replayed = replayTodoState({
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "toolResult", toolName: "todo", details: valid } },
        {
          type: "custom",
          customType: "pi-todo-state",
          data: {
            schemaVersion: TODO_SCHEMA_VERSION,
            revision: 99,
            tasks: [{ key: "broken", subject: "Broken state", status: "completed", dependsOn: ["missing"] }],
          },
        },
      ],
    },
  });

  assert.equal(replayed.revision, 1);
  assert.deepEqual(getTodoTasks(replayed).map((task) => task.key), ["valid"]);
});

test("todo replay migrates v1 state and drops archived and cancelled tasks", () => {
  const replayed = replayTodoState({
    sessionManager: {
      getBranch: () => [{
        type: "custom",
        customType: "pi-todo-state",
        data: {
          schemaVersion: 1,
          revision: 7,
          nextId: 4,
          tasks: [
            { id: 1, key: "done", subject: "Old completion", status: "completed", archived: true },
            { id: 2, key: "cancel", subject: "Cancelled work", status: "cancelled", archived: false },
            {
              id: 3,
              key: "survivor",
              subject: "Continue useful work",
              status: "pending",
              archived: false,
              dependsOn: ["done", "cancel"],
            },
          ],
        },
      }],
    },
  });

  assert.equal(replayed.schemaVersion, TODO_SCHEMA_VERSION);
  assert.equal(replayed.revision, 7);
  assert.deepEqual(getTodoTasks(replayed), [{
    key: "survivor",
    subject: "Continue useful work",
    status: "pending",
  }]);
});

test("todo detects when compaction requires a fresh model-facing checkpoint", () => {
  const state = writeTodoSnapshot(createEmptyTodoState(), { tasks: initialPlan });
  const result = { type: "message", message: { role: "toolResult", toolName: "todo", details: state } };
  const compact = { type: "compaction" };
  const legacy = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "todo",
      details: {
        schemaVersion: 1,
        revision: 1,
        nextId: 2,
        tasks: [{ id: 1, key: "legacy", subject: "Migrate legacy task", status: "pending", archived: false }],
      },
    },
  };
  const checkpoint = {
    type: "custom_message",
    customType: "pi-todo-state",
    details: cloneTodoState(state),
  };

  assert.equal(needsTodoContextCheckpoint([result]), false);
  assert.equal(needsTodoContextCheckpoint([legacy]), true);
  assert.equal(needsTodoContextCheckpoint([legacy, result]), false);
  assert.equal(needsTodoContextCheckpoint([result, compact]), true);
  assert.equal(needsTodoContextCheckpoint([result, compact, checkpoint]), false);
});

interface RegisteredTool {
  name: string;
  executionMode?: string;
  promptGuidelines?: string[];
  parameters: { properties?: Record<string, unknown> };
  execute: (...args: any[]) => Promise<any>;
  renderCall?: (...args: any[]) => any;
  renderResult?: (...args: any[]) => any;
}

function createHarness(initialBranch: unknown[] = []) {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, unknown>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const widgets = new Map<string, unknown>();
  const sentMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  let toolsExpanded = false;
  let pendingMessages = false;
  let branch = [...initialBranch];

  const pi = {
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ type: "custom", customType, data });
    },
    sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    hasPendingMessages: () => pendingMessages,
    ui: {
      setWidget: (key: string, widget: unknown) => {
        if (widget === undefined) widgets.delete(key);
        else widgets.set(key, widget);
      },
      getToolsExpanded: () => toolsExpanded,
    },
  } as unknown as ExtensionContext;

  todoExtension(pi);
  return {
    tools,
    commands,
    handlers,
    widgets,
    sentMessages,
    ctx,
    getBranch: () => [...branch],
    setBranch: (entries: unknown[]) => { branch = [...entries]; },
    appendToolResult: (result: { details: unknown }) => {
      branch.push({
        type: "message",
        message: { role: "toolResult", toolName: "todo", details: result.details },
      });
    },
    appendCustomMessage: (message: Record<string, unknown>) => {
      branch.push({ type: "custom_message", ...message });
    },
    appendRawEntry: (entry: unknown) => { branch.push(entry); },
    setToolsExpanded: (value: boolean) => { toolsExpanded = value; },
    setPendingMessages: (value: boolean) => { pendingMessages = value; },
  };
}

test("todo extension renders a collapsible read-only list above the editor", async () => {
  const { tools, commands, handlers, widgets, ctx, setToolsExpanded } = createHarness();
  const tool = tools.get("todo");
  assert.ok(tool);
  assert.equal(tool.executionMode, "sequential");
  assert.ok(tool.parameters.properties?.tasks);
  const tasksSchema = tool.parameters.properties?.tasks as {
    items?: { required?: string[]; properties?: Record<string, unknown> };
  };
  assert.deepEqual(tasksSchema.items?.required, ["key"], "only key should be schema-required for each sparse task entry");
  assert.equal(tasksSchema.items?.properties?.activeForm, undefined, "activeForm must be removed from the tool schema");
  assert.deepEqual(Object.keys(tool.parameters.properties ?? {}).sort(), ["baseRevision", "tasks"]);
  assert.equal(tool.parameters.properties?.action, undefined);
  assert.doesNotMatch(JSON.stringify(tool.parameters), /cancelled/);
  assert.match(tool.promptGuidelines?.join("\n") ?? "", /define it yourself.*before beginning implementation or other substantive work/i);
  assert.match(tool.promptGuidelines?.join("\n") ?? "", /omitted keys are deleted/i);
  assert.deepEqual(
    [...commands.keys()],
    ["99settings"],
    "todo exposes only the shared settings menu, not a todo-specific command",
  );
  assert.deepEqual([...handlers.keys()].sort(), [
    "before_agent_start",
    "session_compact",
    "session_shutdown",
    "session_start",
    "session_tree",
  ]);

  await handlers.get("session_start")?.({}, ctx);
  const result = await tool.execute("todo-1", { tasks: initialPlan, baseRevision: 0 }, undefined, undefined, ctx);
  assert.equal(result.details.revision, 1);
  assert.match(result.content[0].text, /\[in_progress\] inspect:.*Review the current architecture and constraints/);
  assert.match(result.content[0].text, /\[pending\] design:.*← inspect/);
  assert.equal(
    await handlers.get("before_agent_start")?.({ prompt: "continue", images: [], systemPrompt: "base" }, ctx),
    undefined,
    "a turn with no removable completion must not create a checkpoint",
  );

  assert.ok(tool.renderCall);
  assert.ok(tool.renderResult);
  initTheme("dark", false);
  const theme = {
    fg: (_color: string, text: string) => {
      assert.doesNotMatch(
        text,
        /to (?:expand|collapse)/,
        "the surrounding theme must not override keyHint's key/description styles",
      );
      return text;
    },
    bold: (text: string) => text,
    strikethrough: (text: string) => text,
  };
  const initialDraft = tool.renderCall(
    {
      tasks: [
        { key: "schema", subject: "Design the database schema", status: "completed" },
      ],
    },
    theme,
    { lastComponent: undefined, expanded: false, argsComplete: false },
  );
  const initialDraftText = initialDraft.render(160).join("\n");
  assert.match(initialDraftText, /✓ Design the database schema/);
  assert.doesNotMatch(initialDraftText, /#1|←/, "independent tasks should remain unnumbered");

  const updatedDraft = tool.renderCall(
    {
      tasks: [
        { key: "schema", subject: "Design the database schema", status: "completed" },
        { key: "scaffold", subject: "Initialize the project scaffold", status: "completed", dependsOn: ["schema"] },
        { key: "auth", subject: "Implement user authentication", status: "in_progress", dependsOn: ["scaffold"] },
        { key: "core-api", subject: "Implement the core API", status: "pending", dependsOn: ["auth"] },
        { key: "system-verify", subject: "Verify the completed system", status: "pending", dependsOn: ["core-api"] },
      ],
    },
    theme,
    { lastComponent: initialDraft, expanded: false, argsComplete: false },
  );
  assert.strictEqual(updatedDraft, initialDraft, "streamed arguments should update the existing component");
  const updatedDraftText = updatedDraft.render(160).join("\n");
  assert.match(updatedDraftText, /todo 5 tasks.*to expand/);
  assert.match(updatedDraftText, /Initialize the project scaffold #2 ← #1/);
  assert.match(updatedDraftText, /Implement user authentication #3 ← #2/);
  assert.match(updatedDraftText, /Implement the core API #4 ← #3/);
  assert.doesNotMatch(updatedDraftText, /✓ Design the database schema|Verify the completed system/);
  assert.doesNotMatch(
    updatedDraftText,
    /(?:schema|scaffold|auth|core-api|system-verify):/,
    "draft keys should not be user-visible",
  );

  const expandedDraft = tool.renderCall(
    {
      tasks: [
        { key: "schema", subject: "Design the database schema", status: "completed" },
        { key: "scaffold", subject: "Initialize the project scaffold", status: "completed", dependsOn: ["schema"] },
        { key: "auth", subject: "Implement user authentication", status: "in_progress", dependsOn: ["scaffold"] },
        { key: "core-api", subject: "Implement the core API", status: "pending", dependsOn: ["auth"] },
        { key: "system-verify", subject: "Verify the completed system", status: "pending", dependsOn: ["auth", "core-api"] },
      ],
    },
    theme,
    { lastComponent: updatedDraft, expanded: true, argsComplete: false },
  );
  assert.strictEqual(expandedDraft, updatedDraft);
  const expandedDraftText = expandedDraft.render(160).join("\n");
  assert.match(expandedDraftText, /to collapse/);
  assert.match(expandedDraftText, /Design the database schema #1/);
  assert.match(expandedDraftText, /Verify the completed system #5 ← #3, #4/);

  const completedDraft = tool.renderCall(
    {
      tasks: [
        { key: "schema", subject: "Design the database schema", status: "completed" },
        { key: "scaffold", subject: "Initialize the project scaffold", status: "completed" },
        { key: "auth", subject: "Implement user authentication", status: "completed" },
        { key: "core-api", subject: "Implement the core API", status: "completed" },
        { key: "system-verify", subject: "Verify the completed system", status: "completed" },
      ],
    },
    theme,
    { lastComponent: undefined, expanded: false, argsComplete: true },
  );
  const completedDraftText = completedDraft.render(160).join("\n");
  assert.match(completedDraftText, /Implement user authentication/);
  assert.match(completedDraftText, /Implement the core API/);
  assert.match(completedDraftText, /Verify the completed system/);
  assert.doesNotMatch(completedDraftText, /Design the database schema|Initialize the project scaffold/);

  const sparseDraft = tool.renderCall(
    {
      tasks: [
        { key: "inspect", status: "completed" },
        { key: "design", status: "in_progress" },
        { key: "verify" },
      ],
    },
    theme,
    { lastComponent: undefined, expanded: false, argsComplete: false },
  );
  const sparseDraftText = sparseDraft.render(160).join("\n");
  assert.match(sparseDraftText, /✓ Inspect the existing extension #1/);
  assert.match(sparseDraftText, /◐ Design the snapshot protocol #2 ← #1/);
  assert.match(sparseDraftText, /○ Verify the implementation #3 ← #2/);
  assert.doesNotMatch(sparseDraftText, /Writing task/);

  const emptyDraft = tool.renderCall(
    {},
    theme,
    { lastComponent: undefined, expanded: false, argsComplete: false },
  );
  const emptyDraftText = emptyDraft.render(160).join("\n").trim();
  assert.equal(emptyDraftText, "todo");

  const missingSubjectDraft = tool.renderCall(
    { tasks: [{ key: "new-task" }] },
    theme,
    { lastComponent: undefined, expanded: false, argsComplete: false },
  );
  const missingSubjectText = missingSubjectDraft.render(160).join("\n");
  assert.match(missingSubjectText, /todo 1 task/);
  assert.doesNotMatch(missingSubjectText, /new-task|Writing task|undefined|null|○|◐|✓|×/);

  const missingStatusDraft = tool.renderCall(
    { tasks: [{ key: "new-task", subject: "Implement the streamed task" }] },
    theme,
    { lastComponent: missingSubjectDraft, expanded: false, argsComplete: false },
  );
  const missingStatusText = missingStatusDraft.render(160).join("\n");
  assert.match(missingStatusText, /Implement the streamed task/);
  assert.doesNotMatch(missingStatusText, /undefined|null|○|◐|✓|×/);

  const removalDraft = tool.renderCall(
    {
      tasks: [{ key: "inspect" }, { key: "design" }],
    },
    theme,
    { lastComponent: undefined, expanded: false, argsComplete: true },
  );
  const removalDraftText = removalDraft.render(160).join("\n");
  assert.match(removalDraftText, /todo 2 tasks/);
  assert.doesNotMatch(removalDraftText, /removed/);
  assert.doesNotMatch(removalDraftText, /\bverify\b/);

  const toolResult = tool.renderResult(
    result,
    { expanded: false, isPartial: false },
    theme,
    { lastComponent: undefined, isError: false },
  );
  const toolResultText = toolResult.render(160).join("\n");
  assert.equal(toolResultText, "", "a successful result should not repeat the list already rendered by the call");

  const failedResult = tool.renderResult(
    { content: [{ type: "text", text: "tasks[0].dependsOn references missing task setup-database" }] },
    { expanded: false, isPartial: false },
    theme,
    { lastComponent: undefined, isError: true },
  );
  assert.match(failedResult.render(160).join("\n"), /dependsOn references missing task setup-database/);

  const widgetFactory = widgets.get("pi-todo-widget") as ((tui: unknown, theme: unknown) => { render(width: number): string[] });
  assert.ok(widgetFactory);
  const widget = widgetFactory({ requestRender: () => {} }, theme);
  const collapsedText = widget.render(160).join("\n");
  assert.match(collapsedText, /Todo 0\/3 completed rev 1/);
  assert.match(collapsedText, /Inspect the existing extension #1/);
  assert.match(collapsedText, /Design the snapshot protocol #2 ← #1/);
  assert.match(collapsedText, /Verify the implementation #3 ← #2/);
  assert.doesNotMatch(collapsedText, /\binspect\b/, "stable keys should not be user-visible");
  assert.doesNotMatch(collapsedText, /expand/);
  assert.ok(
    collapsedText.indexOf("Inspect the existing extension") < collapsedText.indexOf("Design the snapshot protocol") &&
      collapsedText.indexOf("Design the snapshot protocol") < collapsedText.indexOf("Verify the implementation"),
    "collapsed tasks should keep their plan order",
  );

  setToolsExpanded(true);
  const expandedText = widget.render(160).join("\n");
  assert.match(expandedText, /Inspect the existing extension #1/);
  assert.match(expandedText, /Design the snapshot protocol #2 ← #1/);
  assert.match(expandedText, /Verify the implementation #3 ← #2/);
  assert.doesNotMatch(expandedText, /\binspect\b|\bdesign\b|\bverify\b|dependsOn/);
  assert.doesNotMatch(expandedText, /collapse/);

  setToolsExpanded(false);
  await tool.execute(
    "todo-overflow",
    {
      tasks: [
        { key: "schema", subject: "Design the database schema", status: "completed" },
        { key: "scaffold", subject: "Initialize the project scaffold", status: "completed" },
        { key: "auth", subject: "Implement user authentication", status: "in_progress" },
        { key: "core-api", subject: "Implement the core API", status: "pending" },
        { key: "system-verify", subject: "Verify the completed system", status: "pending" },
      ],
      baseRevision: 1,
    },
    undefined,
    undefined,
    ctx,
  );
  const overflowCollapsed = widget.render(160).join("\n");
  assert.match(overflowCollapsed, /Todo 2\/5 completed rev 2.*to expand/);
  assert.match(overflowCollapsed, /Initialize the project scaffold/);
  assert.match(overflowCollapsed, /Implement user authentication/);
  assert.match(overflowCollapsed, /Implement the core API/);
  assert.doesNotMatch(overflowCollapsed, /Design the database schema|Verify the completed system/);
  assert.ok(
    overflowCollapsed.indexOf("Initialize the project scaffold") < overflowCollapsed.indexOf("Implement user authentication") &&
      overflowCollapsed.indexOf("Implement user authentication") < overflowCollapsed.indexOf("Implement the core API"),
    "the collapsed preview should keep the active task centered without reordering",
  );

  setToolsExpanded(true);
  const overflowExpanded = widget.render(160).join("\n");
  assert.match(overflowExpanded, /to collapse/);
  const orderedSubjects = [
    "Design the database schema",
    "Initialize the project scaffold",
    "Implement user authentication",
    "Implement the core API",
    "Verify the completed system",
  ];
  for (const subject of orderedSubjects) {
    assert.match(overflowExpanded, new RegExp(subject));
  }
  for (let index = 1; index < orderedSubjects.length; index++) {
    assert.ok(
      overflowExpanded.indexOf(orderedSubjects[index - 1]) < overflowExpanded.indexOf(orderedSubjects[index]),
      "expanded tasks should keep their plan order",
    );
  }

  setToolsExpanded(false);
  await tool.execute(
    "todo-all-completed",
    {
      tasks: [
        { key: "schema" },
        { key: "scaffold" },
        { key: "auth", status: "completed" },
        { key: "core-api", status: "completed" },
        { key: "system-verify", status: "completed" },
      ],
      baseRevision: 2,
    },
    undefined,
    undefined,
    ctx,
  );
  const completedCollapsed = widget.render(160).join("\n");
  assert.match(completedCollapsed, /Todo 5\/5 completed rev 3.*to expand/);
  assert.match(completedCollapsed, /Implement user authentication/);
  assert.match(completedCollapsed, /Implement the core API/);
  assert.match(completedCollapsed, /Verify the completed system/);
  assert.doesNotMatch(completedCollapsed, /Design the database schema|Initialize the project scaffold/);
  assert.ok(
    completedCollapsed.indexOf("Implement user authentication") < completedCollapsed.indexOf("Implement the core API") &&
      completedCollapsed.indexOf("Implement the core API") < completedCollapsed.indexOf("Verify the completed system"),
    "the completed preview should show the last three tasks without reordering",
  );

  await tool.execute(
    "todo-last-active",
    {
      tasks: [
        { key: "schema" },
        { key: "scaffold" },
        { key: "auth" },
        { key: "core-api" },
        { key: "system-verify", status: "in_progress" },
      ],
      baseRevision: 3,
    },
    undefined,
    undefined,
    ctx,
  );
  const lastActiveCollapsed = widget.render(160).join("\n");
  assert.match(lastActiveCollapsed, /Todo 4\/5 completed rev 4.*to expand/);
  assert.match(lastActiveCollapsed, /Implement user authentication/);
  assert.match(lastActiveCollapsed, /Implement the core API/);
  assert.match(lastActiveCollapsed, /Verify the completed system/);
  assert.doesNotMatch(lastActiveCollapsed, /Design the database schema|Initialize the project scaffold/);
});

test("todo removes previous-turn completions atomically and replays them across reload and tree changes", async () => {
  const {
    tools,
    handlers,
    widgets,
    ctx,
    getBranch,
    setBranch,
    appendToolResult,
    appendCustomMessage,
  } = createHarness();
  const tool = tools.get("todo");
  const beforeAgentStart = handlers.get("before_agent_start");
  const sessionStart = handlers.get("session_start");
  const sessionTree = handlers.get("session_tree");
  assert.ok(tool);
  assert.ok(beforeAgentStart);
  assert.ok(sessionStart);
  assert.ok(sessionTree);

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    strikethrough: (text: string) => text,
  };
  const renderWidget = (): string => {
    const factory = widgets.get("pi-todo-widget") as
      | ((tui: unknown, theme: unknown) => { render(width: number): string[] })
      | undefined;
    return factory?.({ requestRender: () => {} }, theme).render(160).join("\n") ?? "";
  };

  await sessionStart({ reason: "startup" }, ctx);
  const partial = await tool.execute("todo-partial", {
    tasks: [
      { key: "step-a", subject: "Step A", status: "completed" },
      { key: "step-b", subject: "Step B", status: "completed", dependsOn: ["step-a"] },
      {
        key: "step-c",
        subject: "Step C",
        status: "in_progress",
        dependsOn: ["step-b"],
      },
    ],
    baseRevision: 0,
  }, undefined, undefined, ctx);
  appendToolResult(partial);
  assert.match(renderWidget(), /Todo 2\/3 completed/);

  // Reloading within the same turn must not remove newly completed work.
  await sessionStart({ reason: "reload" }, ctx);
  assert.match(renderWidget(), /Todo 2\/3 completed/);
  const branchBeforeRemoval = getBranch();

  const removed = await beforeAgentStart({ prompt: "next", images: [], systemPrompt: "base" }, ctx);
  assert.ok(removed?.message);
  assert.equal(removed.message.display, false);
  assert.match(String(removed.message.content), /Todo plan revision 2/);
  const removedState = removed.message.details as TodoState;
  assert.deepEqual(getTodoTasks(removedState).map((task) => [task.key, task.status, task.dependsOn]), [
    ["step-b", "completed", undefined],
    ["step-c", "in_progress", ["step-b"]],
  ]);
  appendCustomMessage(removed.message);
  assert.match(renderWidget(), /Todo 1\/2 completed/);

  await sessionStart({ reason: "reload" }, ctx);
  assert.match(renderWidget(), /Todo 1\/2 completed/);

  // Tree navigation before and after the automatic-removal checkpoint must replay branch-local state.
  const branchAfterRemoval = getBranch();
  setBranch(branchBeforeRemoval);
  await sessionTree({}, ctx);
  assert.match(renderWidget(), /Todo 2\/3 completed/);
  setBranch(branchAfterRemoval);
  await sessionTree({}, ctx);
  assert.match(renderWidget(), /Todo 1\/2 completed/);

  const completed = await tool.execute("todo-complete", {
    tasks: [
      { key: "step-b" },
      { key: "step-c", status: "completed" },
    ],
    baseRevision: 2,
  }, undefined, undefined, ctx);
  appendToolResult(completed);
  assert.match(renderWidget(), /Todo 2\/2 completed/);

  await sessionStart({ reason: "reload" }, ctx);
  assert.match(renderWidget(), /Todo 2\/2 completed/);

  const cleared = await beforeAgentStart({ prompt: "next again", images: [], systemPrompt: "base" }, ctx);
  assert.ok(cleared?.message);
  assert.match(String(cleared.message.content), /Todo plan cleared \(revision 4\)/);
  assert.deepEqual(getTodoTasks(cleared.message.details as TodoState), []);
  appendCustomMessage(cleared.message);
  assert.equal(widgets.has("pi-todo-widget"), false);

  await sessionStart({ reason: "reload" }, ctx);
  assert.equal(widgets.has("pi-todo-widget"), false);
});

test("todo persists and injects exact state after compaction without triggering an extra turn", async () => {
  const harness = createHarness();
  const tool = harness.tools.get("todo");
  const sessionStart = harness.handlers.get("session_start");
  const sessionCompact = harness.handlers.get("session_compact");
  const beforeAgentStart = harness.handlers.get("before_agent_start");
  assert.ok(tool);
  assert.ok(sessionStart);
  assert.ok(sessionCompact);
  assert.ok(beforeAgentStart);

  await sessionStart({ reason: "startup" }, harness.ctx);
  const result = await tool.execute(
    "todo-before-compact",
    { tasks: initialPlan, baseRevision: 0 },
    undefined,
    undefined,
    harness.ctx,
  );
  harness.appendToolResult(result);
  harness.appendRawEntry({ type: "compaction", firstKeptEntryId: "kept" });
  await sessionCompact({ reason: "manual", willRetry: false }, harness.ctx);

  const persisted = harness.getBranch().at(-1) as { type?: string; customType?: string; data?: TodoState };
  assert.equal(persisted.type, "custom");
  assert.equal(persisted.customType, "pi-todo-state");
  assert.equal(persisted.data?.schemaVersion, TODO_SCHEMA_VERSION);
  assert.deepEqual(getTodoTasks(persisted.data as TodoState).map((task) => task.key), ["inspect", "design", "verify"]);
  assert.equal(harness.sentMessages.length, 0, "manual compaction must not steer or trigger the model");

  // A reload between compaction and the next prompt must retain the pending context checkpoint.
  await sessionStart({ reason: "reload" }, harness.ctx);
  const checkpoint = await beforeAgentStart({ prompt: "continue", images: [], systemPrompt: "base" }, harness.ctx);
  assert.ok(checkpoint?.message);
  assert.equal(checkpoint.message.display, false);
  assert.match(String(checkpoint.message.content), /Todo plan revision 1/);
  assert.match(String(checkpoint.message.content), /design: Design the snapshot protocol.*← inspect/);
  harness.appendCustomMessage(checkpoint.message);

  await sessionStart({ reason: "reload" }, harness.ctx);
  assert.equal(
    await beforeAgentStart({ prompt: "continue again", images: [], systemPrompt: "base" }, harness.ctx),
    undefined,
    "a current-schema model-facing checkpoint should satisfy the compaction requirement",
  );

  harness.setPendingMessages(true);
  harness.appendRawEntry({ type: "compaction", firstKeptEntryId: "kept-again" });
  await sessionCompact({ reason: "threshold", willRetry: false }, harness.ctx);
  assert.equal(harness.sentMessages.length, 1, "queued continuations need an immediate checkpoint after compaction");
  assert.deepEqual(harness.sentMessages[0]?.options, { deliverAs: "steer" });
  harness.setPendingMessages(false);

  const retryHarness = createHarness();
  const retryTool = retryHarness.tools.get("todo");
  const retryStart = retryHarness.handlers.get("session_start");
  const retryCompact = retryHarness.handlers.get("session_compact");
  const retryBeforeStart = retryHarness.handlers.get("before_agent_start");
  assert.ok(retryTool);
  assert.ok(retryStart);
  assert.ok(retryCompact);
  assert.ok(retryBeforeStart);

  await retryStart({ reason: "startup" }, retryHarness.ctx);
  const retryState = await retryTool.execute(
    "todo-before-overflow",
    { tasks: initialPlan, baseRevision: 0 },
    undefined,
    undefined,
    retryHarness.ctx,
  );
  retryHarness.appendToolResult(retryState);
  retryHarness.appendRawEntry({ type: "compaction", firstKeptEntryId: "kept" });
  await retryCompact({ reason: "overflow", willRetry: true }, retryHarness.ctx);
  assert.equal(retryHarness.sentMessages.length, 1);
  assert.deepEqual(retryHarness.sentMessages[0]?.options, { deliverAs: "steer" });
  assert.match(String(retryHarness.sentMessages[0]?.message.content), /Todo plan revision 1/);
  assert.equal(
    await retryBeforeStart({ prompt: "unused", images: [], systemPrompt: "base" }, retryHarness.ctx),
    undefined,
    "overflow retry already receives the steered checkpoint",
  );
});

test("todo rejects completed work whose dependency is still pending", () => {
  const details = writeTodoSnapshot(createEmptyTodoState(), { tasks: initialPlan });
  assert.throws(
    () => writeTodoSnapshot(asState(details), {
      tasks: [
        { key: "inspect", subject: "Inspect", status: "pending" },
        { key: "design", subject: "Design", status: "completed", dependsOn: ["inspect"] },
      ],
    }),
    TodoValidationError,
  );
});
