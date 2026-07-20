# @99percentpeople/pi-todo

A minimal, atomic todo tool for the [Pi coding agent](https://pi.dev/).
The model writes the complete task plan in one call instead of issuing one
`create` call per task.

The extension intentionally has no slash commands, interactive manager, or
user-editable todo interface. Todo state belongs to the model. A read-only list
is rendered above Pi's input box.

## Features

- One-call creation of a complete plan
- One-call completion and handoff to the next task
- Omission-based deletion without retained cancelled or archived tasks
- Stable task keys and key-based dependencies
- Atomic validation with optional optimistic revisions
- Branch- and compaction-aware state that survives `/reload` and `/tree`
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

## Rendering

The task list is rendered in a read-only widget above Pi's input box. It follows
Pi's standard tool-output expansion state (`Ctrl+O` by default):

- collapsed: overall progress and up to three tasks;
- expanded: the complete todo list with a status glyph and task name only.

While the model is streaming a `todo` call, the tool row updates in place and
shows each task name as it is written instead of only showing a task count.
Sparse updates reuse the current task name and status until their changed fields
arrive. Fields that are not yet known are omitted: a new task appears after its
subject is written, and its status glyph appears only after its status is
available. This live preview also shows up to three tasks when collapsed and
all tasks when expanded. After a successful write, the result renderer stays
empty because the completed tool call already contains the final list;
validation errors are still displayed below the attempted list.

Tasks always keep their plan order. When collapsed, the widget prefers a
three-task window containing the item before the first `in_progress` task, the
active task itself, and the following item. If no task is active, it shows the
first three tasks. Once every task is completed, it shows the last three tasks
instead so the most recently finished work remains visible. The expand/collapse
hint is shown only when more than three tasks are visible.

The model-facing result includes keys, dependencies, and descriptions. The
user-facing live tool call and widget show only status glyphs and task names.
The shortcut respects the user's `app.tools.expand` keybinding.

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

## License

MIT
