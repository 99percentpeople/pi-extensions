import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import todoExtension from "../extensions/todo/index.ts";
import {
  TODO_SCHEMA_VERSION,
  TodoValidationError,
  archiveCompletedTasks,
  cloneTodoState,
  createEmptyTodoState,
  getVisibleTasks,
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
  assert.equal(first.nextId, 4);
  assert.deepEqual(first.change, {
    added: ["inspect", "design", "verify"],
    updated: [],
    archived: [],
  });
  assert.deepEqual(getVisibleTasks(first).map((task) => [task.id, task.key]), [
    [1, "inspect"],
    [2, "design"],
    [3, "verify"],
  ]);

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
  assert.deepEqual(getVisibleTasks(second).map((task) => task.status), ["completed", "in_progress", "pending"]);
  assert.deepEqual(getVisibleTasks(second).map((task) => task.subject), initialPlan.map((task) => task.subject));
  assert.equal(getVisibleTasks(second)[0].description, "Review the current architecture and constraints");
  assert.deepEqual(getVisibleTasks(second).map((task) => task.dependsOn), [undefined, ["inspect"], ["design"]]);
  assert.deepEqual(getVisibleTasks(second).map((task) => task.id), [1, 2, 3], "stable keys must preserve ids");
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
  assert.deepEqual(noOp.change, { added: [], updated: [], archived: [] });
  assert.equal(getVisibleTasks(noOp)[0].description, "Keep this");
  assert.deepEqual(getVisibleTasks(noOp)[1].dependsOn, ["root"]);

  const cleared = writeTodoSnapshot(asState(noOp), {
    tasks: [{ key: "root", description: "" }, { key: "child", dependsOn: [] }],
    baseRevision: 1,
  });
  assert.equal(cleared.revision, 2);
  assert.equal(getVisibleTasks(cleared)[0].description, undefined);
  assert.equal(getVisibleTasks(cleared)[1].dependsOn, undefined);

  const reordered = writeTodoSnapshot(asState(cleared), {
    tasks: [{ key: "child" }, { key: "root" }],
    baseRevision: 2,
  });
  assert.equal(reordered.revision, 3, "changing visible order is a state change");
  assert.deepEqual(getVisibleTasks(reordered).map((task) => task.key), ["child", "root"]);

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

test("todo archives omitted tasks and reuses their stable ids when restored", () => {
  const first = writeTodoSnapshot(createEmptyTodoState(), { tasks: initialPlan });
  const removed = writeTodoSnapshot(asState(first), { tasks: [initialPlan[0]] });
  assert.equal(removed.revision, 2);
  assert.deepEqual(removed.change.archived, ["design", "verify"]);
  assert.deepEqual(getVisibleTasks(removed).map((task) => task.key), ["inspect"]);
  assert.equal(removed.tasks.find((task) => task.key === "design")?.status, "cancelled");
  assert.equal(removed.tasks.find((task) => task.key === "design")?.archived, true);

  const restored = writeTodoSnapshot(asState(removed), {
    tasks: [
      initialPlan[0],
      { key: "design", subject: "Design again", status: "pending", dependsOn: ["inspect"] },
    ],
  });
  assert.equal(restored.tasks.find((task) => task.key === "design")?.id, 2);
  assert.equal(restored.tasks.find((task) => task.key === "design")?.archived, false);
});

test("todo auto-archives only unneeded completions and cleans surviving dependencies", () => {
  const current = writeTodoSnapshot(createEmptyTodoState(), {
    tasks: [
      { key: "step-a", subject: "Step A", status: "completed" },
      { key: "step-b", subject: "Step B", status: "completed", dependsOn: ["step-a"] },
      { key: "step-c", subject: "Step C", status: "pending", dependsOn: ["step-b"] },
    ],
  });
  const before = cloneTodoState(current);
  const archived = archiveCompletedTasks(before);
  assert.ok(archived);
  assert.equal(archived.revision, 2);
  assert.deepEqual(archived.change, {
    added: [],
    updated: ["step-b"],
    archived: ["step-a"],
  });
  assert.deepEqual(getVisibleTasks(archived).map((task) => [task.key, task.dependsOn]), [
    ["step-b", undefined],
    ["step-c", ["step-b"]],
  ]);
  assert.deepEqual(before, cloneTodoState(current), "auto-archive must not mutate its input state");
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
  assert.deepEqual(getVisibleTasks(replayed).map((task) => task.key), ["modern"]);
  assert.equal("activeForm" in getVisibleTasks(replayed)[0], false, "replay should discard removed activeForm data");
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
  let toolsExpanded = false;
  let branch = [...initialBranch];

  const pi = {
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => branch },
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
    setToolsExpanded: (value: boolean) => { toolsExpanded = value; },
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
  assert.equal(tool.parameters.properties?.action, undefined);
  assert.match(tool.promptGuidelines?.join("\n") ?? "", /complete plan in one todo call/i);
  assert.equal(commands.size, 0, "the extension should not register a user-facing todo interface");
  assert.deepEqual([...handlers.keys()].sort(), ["before_agent_start", "session_shutdown", "session_start", "session_tree"]);

  await handlers.get("session_start")?.({}, ctx);
  const result = await tool.execute("todo-1", { tasks: initialPlan, baseRevision: 0 }, undefined, undefined, ctx);
  assert.equal(result.details.revision, 1);
  assert.match(result.content[0].text, /\[in_progress\] inspect:.*Review the current architecture and constraints/);
  assert.match(result.content[0].text, /\[pending\] design:.*← inspect/);
  assert.equal(
    await handlers.get("before_agent_start")?.({ prompt: "continue", images: [], systemPrompt: "base" }, ctx),
    undefined,
    "a turn with no archivable completion must not create a checkpoint",
  );

  assert.ok(tool.renderCall);
  assert.ok(tool.renderResult);
  initTheme("dark", false);
  const theme = {
    fg: (_color: string, text: string) => text,
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
  assert.match(initialDraft.render(160).join("\n"), /✓ Design the database schema/);

  const updatedDraft = tool.renderCall(
    {
      tasks: [
        { key: "schema", subject: "Design the database schema", status: "completed" },
        { key: "scaffold", subject: "Initialize the project scaffold", status: "completed" },
        { key: "auth", subject: "Implement user authentication", status: "in_progress" },
        { key: "core-api", subject: "Implement the core API", status: "pending" },
        { key: "system-verify", subject: "Verify the completed system", status: "pending" },
      ],
    },
    theme,
    { lastComponent: initialDraft, expanded: false, argsComplete: false },
  );
  assert.strictEqual(updatedDraft, initialDraft, "streamed arguments should update the existing component");
  const updatedDraftText = updatedDraft.render(160).join("\n");
  assert.match(updatedDraftText, /todo 5 tasks.*to expand/);
  assert.match(updatedDraftText, /Initialize the project scaffold/);
  assert.match(updatedDraftText, /Implement user authentication/);
  assert.match(updatedDraftText, /Implement the core API/);
  assert.doesNotMatch(updatedDraftText, /Design the database schema|Verify the completed system/);
  assert.doesNotMatch(
    updatedDraftText,
    /(?:schema|scaffold|auth|core-api|system-verify):/,
    "draft keys should not be user-visible",
  );

  const expandedDraft = tool.renderCall(
    {
      tasks: [
        { key: "schema", subject: "Design the database schema", status: "completed" },
        { key: "scaffold", subject: "Initialize the project scaffold", status: "completed" },
        { key: "auth", subject: "Implement user authentication", status: "in_progress" },
        { key: "core-api", subject: "Implement the core API", status: "pending" },
        { key: "system-verify", subject: "Verify the completed system", status: "pending" },
      ],
    },
    theme,
    { lastComponent: updatedDraft, expanded: true, argsComplete: false },
  );
  assert.strictEqual(expandedDraft, updatedDraft);
  const expandedDraftText = expandedDraft.render(160).join("\n");
  assert.match(expandedDraftText, /to collapse/);
  assert.match(expandedDraftText, /Design the database schema/);
  assert.match(expandedDraftText, /Verify the completed system/);

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
  assert.match(sparseDraftText, /✓ Inspect the existing extension/);
  assert.match(sparseDraftText, /◐ Design the snapshot protocol/);
  assert.match(sparseDraftText, /○ Verify the implementation/);
  assert.doesNotMatch(sparseDraftText, /Writing task/);

  const emptyDraft = tool.renderCall(
    {},
    theme,
    { lastComponent: undefined, expanded: false, argsComplete: false },
  );
  assert.match(emptyDraft.render(160).join("\n"), /Writing task list…/);

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
  assert.match(collapsedText, /Todo 0\/3 completed · rev 1/);
  assert.match(collapsedText, /Inspect the existing extension/);
  assert.match(collapsedText, /Design the snapshot protocol/);
  assert.match(collapsedText, /Verify the implementation/);
  assert.doesNotMatch(collapsedText, /\binspect\b/, "stable keys should not be user-visible");
  assert.doesNotMatch(collapsedText, /expand/);
  assert.ok(
    collapsedText.indexOf("Inspect the existing extension") < collapsedText.indexOf("Design the snapshot protocol") &&
      collapsedText.indexOf("Design the snapshot protocol") < collapsedText.indexOf("Verify the implementation"),
    "collapsed tasks should keep their plan order",
  );

  setToolsExpanded(true);
  const expandedText = widget.render(160).join("\n");
  assert.match(expandedText, /Inspect the existing extension/);
  assert.match(expandedText, /Design the snapshot protocol/);
  assert.match(expandedText, /Verify the implementation/);
  assert.doesNotMatch(expandedText, /\binspect\b|\bdesign\b|\bverify\b|dependsOn|←/);
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
  assert.match(overflowCollapsed, /Todo 2\/5 completed · rev 2.*to expand/);
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
});

test("todo archives previous-turn completions atomically and replays them across reload and tree changes", async () => {
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

  // Reloading within the same turn must not archive newly completed work.
  await sessionStart({ reason: "reload" }, ctx);
  assert.match(renderWidget(), /Todo 2\/3 completed/);
  const branchBeforeArchive = getBranch();

  const archived = await beforeAgentStart({ prompt: "next", images: [], systemPrompt: "base" }, ctx);
  assert.ok(archived?.message);
  assert.equal(archived.message.display, false);
  assert.match(String(archived.message.content), /Todo plan revision 2/);
  const archivedState = archived.message.details as TodoState;
  assert.deepEqual(getVisibleTasks(archivedState).map((task) => [task.key, task.status, task.dependsOn]), [
    ["step-b", "completed", undefined],
    ["step-c", "in_progress", ["step-b"]],
  ]);
  appendCustomMessage(archived.message);
  assert.match(renderWidget(), /Todo 1\/2 completed/);

  await sessionStart({ reason: "reload" }, ctx);
  assert.match(renderWidget(), /Todo 1\/2 completed/);

  // Tree navigation before and after the auto-archive checkpoint must replay branch-local state.
  const branchAfterArchive = getBranch();
  setBranch(branchBeforeArchive);
  await sessionTree({}, ctx);
  assert.match(renderWidget(), /Todo 2\/3 completed/);
  setBranch(branchAfterArchive);
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
  assert.deepEqual(getVisibleTasks(cleared.message.details as TodoState), []);
  appendCustomMessage(cleared.message);
  assert.equal(widgets.has("pi-todo-widget"), false);

  await sessionStart({ reason: "reload" }, ctx);
  assert.equal(widgets.has("pi-todo-widget"), false);
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
