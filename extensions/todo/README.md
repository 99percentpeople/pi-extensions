# @99percentpeople/pi-todo

A minimal, atomic todo tool for the [Pi coding agent](https://pi.dev/).
The model writes the complete task plan in one call instead of issuing one
`create` call per task.

You see your plan as a live list above the input box: progress, active task,
and dependencies update as the model works, and finished tasks roll off
automatically. No commands to learn — just let the model maintain the plan.

The extension intentionally has no todo-specific slash commands, interactive
manager, or user-editable todo interface. Todo state belongs to the model. A read-only list
is rendered above Pi's input box.

## Demo

The model creates the plan, works through it, and the widget tracks progress
from `0/3` to `3/3 completed`:

![todo demo](https://raw.githubusercontent.com/99percentpeople/pi-extensions/master/promo/demo/todo.gif)

## Features

- One-call creation of a complete plan
- One-call completion and handoff to the next task
- Omission-based deletion without retained cancelled or archived tasks
- Stable task keys and key-based dependencies
- Atomic validation with optional optimistic revisions
- Branch- and compaction-aware state that survives `/reload` and `/tree`
- Configurable compact reminders that keep the plan salient to the model
- Read-only collapsible list above the input box

## Install

This extension registers the `todo` tool. Remove another extension that owns the
same tool name before installing it:

```bash
pi remove npm:@juicesharp/rpiv-todo
pi install npm:@99percentpeople/pi-todo
```

During local development:

```bash
pi -e ./extensions/todo/index.ts
```

## Tool schema

The `todo` tool accepts the complete authoritative list of tasks to retain.
Existing tasks may omit unchanged fields; a new key requires `subject` and
`status`. Any current key omitted from `tasks` is permanently deleted:

```ts
todo({
  baseRevision?: number,
  tasks: Array<{
    key: string,
    subject?: string,
    description?: string,
    status?: "pending" | "in_progress" | "completed",
    dependsOn?: string[],
  }>,
})
```

Example:

```json
{
  "baseRevision": 0,
  "tasks": [
    {
      "key": "inspect",
      "subject": "Inspect the existing implementation",
      "status": "in_progress"
    },
    {
      "key": "implement",
      "subject": "Implement the optimized protocol",
      "status": "pending",
      "dependsOn": ["inspect"]
    },
    {
      "key": "verify",
      "subject": "Verify the implementation",
      "status": "pending",
      "dependsOn": ["implement"]
    }
  ]
}
```

To hand work off, include every current key but only send changed fields:

```json
{
  "baseRevision": 1,
  "tasks": [
    { "key": "inspect", "status": "completed" },
    { "key": "implement", "status": "in_progress" },
    { "key": "verify" }
  ]
}
```

Subjects and dependencies are inherited from the previous snapshot. Both status
changes commit atomically.

To cancel or otherwise delete work, omit its key from the next complete plan:

```json
{
  "baseRevision": 2,
  "tasks": [
    { "key": "inspect" },
    { "key": "implement" }
  ]
}
```

Deletion is permanent state removal. The extension stores no `cancelled` status
or archived task record. A completed task may retain a dependency only as
history: when its completed prerequisite is omitted, that soft reference is
automatically removed. A pending or in-progress task cannot retain a dependency
on an omitted key.

## Semantics

- `key` is the task identity while that task remains in the plan.
- Existing keys inherit omitted fields from their previous state.
- New keys require `subject` and `status`.
- `description: ""` and `dependsOn: []` explicitly clear those fields.
- Every key present in `tasks` remains in the plan; omitted current keys are
  permanently deleted.
- Completed tasks remain visible for the current turn, then are automatically
  removed on the next turn. Completed tasks that still block pending or
  in-progress work are preserved.
- `tasks: []` clears the plan.
- `baseRevision`, when provided, rejects stale writes.
- Every dependency must refer to another key in the resulting snapshot, except
  completed-to-completed references are automatically pruned when the target is
  deleted.
- Dependency cycles are rejected.
- An `in_progress` or `completed` task requires all dependencies to be completed.
- Validation is all-or-nothing; failed writes do not mutate state.
- Multiple independent tasks may be `in_progress` concurrently.

Each successful result includes the current revision and complete retained plan.
When next-turn cleanup changes the plan, the extension emits one hidden custom
message containing the new revision and snapshot so the model never works from
stale tool history.

State schema v2 removes internal numeric IDs, archived records, and the
`cancelled` status. Valid v1 session state is migrated on replay; archived and
cancelled legacy tasks are discarded, and one hidden v2 checkpoint updates the
model on the next prompt.

## Model reminders

While unfinished work remains, the extension periodically appends a compact,
hidden reminder immediately before an LLM call. The reminder contains only the
current revision and complete key/status list—not task subjects, descriptions,
or dependency payloads—and asks the model to reconcile changed progress before
its final response. It is context-only and is not written to the session, so
reminders do not accumulate in conversation history.

The default interval is every three LLM calls. The counter resets after a
successful `todo` write, session or branch restoration, an injected exact
checkpoint, or a reminder-setting change. No reminder is sent for an empty or
fully completed plan. Use `/99settings` to select Off, every call, or an interval
of 2, 3, 5, 8, 10, or 20 calls.

## Rendering

The task list is rendered in a read-only widget above Pi's input box. It follows
Pi's standard tool-output expansion state (`Ctrl+O` by default):

- collapsed: overall progress and a configurable number of tasks (three by
  default);
- expanded: the complete todo list with status glyphs, task names, and resolved
  prerequisites.

While the model is streaming a `todo` call, the tool row updates in place and
shows each task name and its compact dependency references as they are written
instead of only showing a task count.
Sparse updates reuse the current task name and status until their changed fields
arrive. Fields that are not yet known are omitted: a new task appears after its
subject is written, and its status glyph appears only after its status is
available. This live preview uses the configured collapsed-item limit and shows
all tasks when expanded. After a successful write, the result renderer stays
empty because the completed tool call already contains the final list;
validation errors are still displayed below the attempted list.

Tasks always keep their plan order. When collapsed, the widget selects a window
around the first `in_progress` task where possible. If no task is active, it
shows the first configured number of tasks. Once every task is completed, it
shows the last configured number instead so the most recently finished work
remains visible. The expand/collapse hint is shown only when the complete list
exceeds that limit.

`in_progress` task labels are rendered in bold in both the live tool call and
widget. The model-facing result still includes keys, dependencies, and
descriptions. In the user-facing display, dependency numbering can be shown or
hidden. When shown, tasks participating in the dependency graph receive
plan-order display numbers after their names, such as `○ Inspect #1` and
`○ Implement #2 ← #1`. Independent tasks stay unnumbered, multiple prerequisites
use `← #1, #2`, and stable task keys remain hidden. These numbers are
display-only and may be reassigned when the plan changes. The shortcut respects
the user's `app.tools.expand` keybinding.

## Persistence

Normal writes are stored in tool-result `details`. Automatic next-turn removals
are stored in hidden custom-message `details`; the same message also tells the
model which snapshot and revision are current. On `session_start`, `/reload`,
and `/tree` navigation, the extension restores the latest valid state entry from
the active branch.

After compaction, the extension stores an exact schema-v2 checkpoint outside the
model context. It injects that snapshot as one hidden model-facing message on
the next prompt, or immediately as steering context when overflow recovery or an
already queued continuation proceeds without a new prompt. This preserves exact
keys, dependencies, and revision numbers without triggering an extra model turn.

## Shared settings

Use the shared `/99settings` menu to choose how many Todo items are shown while
the widget and streaming tool call are collapsed, whether display-only
dependency numbers are shown, and how often compact model reminders are
injected. Collapsed-item presets are 1, 2, 3, 5, 8, and 10; the default remains
3. Dependency numbers default to shown. Model reminders default to every three
LLM calls and can be disabled. Values are stored under the `todo` namespace in
`~/.pi/agent/99extensions.json`.

## License

MIT
