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
- Stable task keys and key-based dependencies
- Atomic validation with optional optimistic revisions
- Branch-aware state that survives `/reload` and `/tree`
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

The `todo` tool accepts the complete authoritative task-key list. Existing
tasks may omit unchanged fields; a new key requires `subject` and `status`:

```ts
todo({
  baseRevision?: number,
  tasks: Array<{
    key: string,
    subject?: string,
    description?: string,
    status?: "pending" | "in_progress" | "completed" | "cancelled",
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

## Semantics

- `key` is stable across updates and preserves the internal numeric ID.
- Existing keys inherit omitted fields from their previous state.
- New keys require `subject` and `status`.
- `description: ""` and `dependsOn: []` explicitly clear those fields.
- Omitted keys are archived. Reintroducing the same key restores its prior ID.
- Completed tasks remain visible for the current turn, then are automatically
archived on the next turn. Tasks that are still blocking a pending or
in_progress task are preserved.
- `tasks: []` clears the visible plan.
- `baseRevision`, when provided, rejects stale writes.
- Every dependency must refer to another key in the merged snapshot.
- Dependency cycles are rejected.
- An `in_progress` or `completed` task requires all dependencies to be completed.
- Validation is all-or-nothing; failed writes do not mutate state.
- Multiple independent tasks may be `in_progress` concurrently.

Each successful result includes the current revision and complete visible plan.
When next-turn cleanup changes the plan, the extension emits one hidden custom
message containing the new revision and snapshot so the model never works from
stale tool history.

## Rendering

The task list is rendered in a read-only widget above Pi's input box. It follows
Pi's standard tool-output expansion state (`Ctrl+O` by default):

- collapsed: overall progress and the current `in_progress` task;
- expanded: the complete visible todo list with a status glyph and task name only.

The model-facing result includes keys, dependencies, and descriptions so task
goals survive sparse updates and automatic checkpoints. The user-facing tool
result and widget show only status glyphs and task names. The shortcut respects
the user's `app.tools.expand` keybinding.

## Persistence

Normal writes are stored in tool-result `details`. Automatic next-turn archives
are stored in hidden custom-message `details`; the same message also tells the
model which snapshot and revision are current. On `session_start`, `/reload`,
and `/tree` navigation, the extension restores the latest valid state entry from
the active branch.

## License

MIT
