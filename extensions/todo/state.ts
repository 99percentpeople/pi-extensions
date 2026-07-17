export const TODO_SCHEMA_VERSION = 1 as const;
export const TODO_TOOL_NAME = "todo";
export const TODO_STATE_CUSTOM_TYPE = "pi-todo-state";
export const MAX_TODO_TASKS = 50;
const MAX_ARCHIVED_TASKS = 100;

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

const TODO_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && TODO_STATUSES.has(value as TodoStatus);
}

export interface TodoTaskInput {
  key: string;
  subject?: string;
  description?: string;
  status?: TodoStatus;
  dependsOn?: string[];
}

interface ResolvedTodoTaskInput {
  key: string;
  subject: string;
  description?: string;
  status: TodoStatus;
  dependsOn?: string[];
}

export interface TodoTask extends ResolvedTodoTaskInput {
  id: number;
  archived: boolean;
}

export interface TodoState {
  schemaVersion: typeof TODO_SCHEMA_VERSION;
  revision: number;
  nextId: number;
  tasks: TodoTask[];
}

export interface TodoChangeSummary {
  added: string[];
  updated: string[];
  archived: string[];
}

export interface TodoDetails extends TodoState {
  change: TodoChangeSummary;
}

export interface TodoSnapshotInput {
  tasks: TodoTaskInput[];
  baseRevision?: number;
}

export class TodoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoValidationError";
  }
}

export function createEmptyTodoState(): TodoState {
  return {
    schemaVersion: TODO_SCHEMA_VERSION,
    revision: 0,
    nextId: 1,
    tasks: [],
  };
}

function cloneTask(task: TodoTask): TodoTask {
  return {
    ...task,
    ...(task.dependsOn ? { dependsOn: [...task.dependsOn] } : {}),
  };
}

export function cloneTodoState(state: TodoState): TodoState {
  return {
    schemaVersion: TODO_SCHEMA_VERSION,
    revision: state.revision,
    nextId: state.nextId,
    tasks: state.tasks.map(cloneTask),
  };
}

export function getVisibleTasks(state: TodoState): TodoTask[] {
  return state.tasks.filter((task) => !task.archived).map(cloneTask);
}

export function isTaskBlocked(task: TodoTask, tasks: readonly TodoTask[]): boolean {
  if (!task.dependsOn?.length) return false;
  const statusByKey = new Map(tasks.map((candidate) => [candidate.key, candidate.status]));
  return task.dependsOn.some((key) => statusByKey.get(key) !== "completed");
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeTaskKey(value: string, index: number): string {
  const key = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(key)) {
    throw new TodoValidationError(
      `tasks[${index}].key must be 1-40 lowercase ASCII letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return key;
}

function normalizeTask(input: ResolvedTodoTaskInput, index: number): ResolvedTodoTaskInput {
  const key = normalizeTaskKey(input.key, index);
  const subject = input.subject.trim();
  if (!subject) throw new TodoValidationError(`tasks[${index}].subject is required`);
  if (subject.length > 160) throw new TodoValidationError(`tasks[${index}].subject must be at most 160 characters`);

  const description = normalizeOptionalText(input.description);
  if (description && description.length > 2_000) {
    throw new TodoValidationError(`tasks[${index}].description must be at most 2000 characters`);
  }

  if (!isTodoStatus(input.status)) {
    throw new TodoValidationError(`tasks[${index}].status is invalid: ${String(input.status)}`);
  }

  const dependsOn = [...new Set((input.dependsOn ?? []).map((dependency) => dependency.trim()))];
  if (dependsOn.some((dependency) => !dependency)) {
    throw new TodoValidationError(`tasks[${index}].dependsOn cannot contain an empty key`);
  }
  if (dependsOn.includes(key)) {
    throw new TodoValidationError(`tasks[${index}] cannot depend on itself (${key})`);
  }

  return {
    key,
    subject,
    status: input.status,
    ...(description ? { description } : {}),
    ...(dependsOn.length ? { dependsOn } : {}),
  };
}

function assertNoDependencyCycles(tasks: readonly ResolvedTodoTaskInput[]): void {
  const dependencies = new Map(tasks.map((task) => [task.key, task.dependsOn ?? []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (key: string): void => {
    if (visiting.has(key)) throw new TodoValidationError(`dependency cycle detected at ${key}`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of dependencies.get(key) ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };

  for (const key of dependencies.keys()) visit(key);
}

function assertDependenciesAreConsistent(tasks: readonly ResolvedTodoTaskInput[]): void {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  for (const [index, task] of tasks.entries()) {
    for (const dependency of task.dependsOn ?? []) {
      if (!byKey.has(dependency)) {
        throw new TodoValidationError(`tasks[${index}].dependsOn references missing task ${dependency}`);
      }
    }

    if (task.status !== "in_progress" && task.status !== "completed") continue;
    const unresolved = (task.dependsOn ?? []).filter((dependency) => byKey.get(dependency)?.status !== "completed");
    if (unresolved.length > 0) {
      throw new TodoValidationError(
        `tasks[${index}] cannot be ${task.status} while dependencies are unresolved: ${unresolved.join(", ")}`,
      );
    }
  }
}

function comparableTask(task: TodoTask): ResolvedTodoTaskInput & { archived: boolean } {
  return {
    key: task.key,
    subject: task.subject,
    status: task.status,
    archived: task.archived,
    ...(task.description ? { description: task.description } : {}),
    ...(task.dependsOn?.length ? { dependsOn: [...task.dependsOn] } : {}),
  };
}

function tasksEqual(left: TodoTask, right: TodoTask): boolean {
  return JSON.stringify(comparableTask(left)) === JSON.stringify(comparableTask(right));
}

export function writeTodoSnapshot(state: TodoState, input: TodoSnapshotInput): TodoDetails {
  if (input.baseRevision !== undefined && input.baseRevision !== state.revision) {
    throw new TodoValidationError(
      `stale todo revision: expected ${input.baseRevision}, current revision is ${state.revision}`,
    );
  }
  if (input.tasks.length > MAX_TODO_TASKS) {
    throw new TodoValidationError(`tasks supports at most ${MAX_TODO_TASKS} items`);
  }

  const existingByKey = new Map(state.tasks.map((task) => [task.key, task]));
  const normalized: ResolvedTodoTaskInput[] = [];
  const keys = new Set<string>();
  for (const [index, patch] of input.tasks.entries()) {
    const key = normalizeTaskKey(patch.key, index);
    if (keys.has(key)) throw new TodoValidationError(`tasks[${index}].key is duplicated: ${key}`);
    keys.add(key);

    const existing = existingByKey.get(key);
    const subject = patch.subject ?? existing?.subject;
    if (subject === undefined) {
      throw new TodoValidationError(`tasks[${index}].subject is required for new task ${key}`);
    }
    const status = patch.status ?? existing?.status;
    if (status === undefined) {
      throw new TodoValidationError(`tasks[${index}].status is required for new task ${key}`);
    }

    normalized.push(normalizeTask({
      key,
      subject,
      status,
      ...(patch.description !== undefined
        ? { description: patch.description }
        : existing?.description
          ? { description: existing.description }
          : {}),
      ...(patch.dependsOn !== undefined
        ? { dependsOn: patch.dependsOn }
        : existing?.dependsOn?.length
          ? { dependsOn: [...existing.dependsOn] }
          : {}),
    }, index));
  }
  assertDependenciesAreConsistent(normalized);
  assertNoDependencyCycles(normalized);
  let nextId = state.nextId;
  const added: string[] = [];
  const updated: string[] = [];
  const archived: string[] = [];

  const nextVisible = normalized.map<TodoTask>((task) => {
    const existing = existingByKey.get(task.key);
    const candidate: TodoTask = {
      ...task,
      id: existing?.id ?? nextId++,
      archived: false,
    };
    if (!existing) added.push(task.key);
    else if (!tasksEqual(existing, candidate)) updated.push(task.key);
    return candidate;
  });

  const nextArchived = state.tasks
    .filter((task) => !keys.has(task.key))
    .map<TodoTask>((task) => {
      if (!task.archived) archived.push(task.key);
      return {
        ...cloneTask(task),
        status: task.status === "completed" || task.status === "cancelled" ? task.status : "cancelled",
        archived: true,
      };
    })
    .slice(0, MAX_ARCHIVED_TASKS);

  const previousOrder = state.tasks.filter((task) => !task.archived).map((task) => task.key);
  const nextOrder = nextVisible.map((task) => task.key);
  const orderChanged = previousOrder.length !== nextOrder.length || previousOrder.some((key, index) => key !== nextOrder[index]);
  const changed = added.length > 0 || updated.length > 0 || archived.length > 0 || orderChanged;
  return {
    schemaVersion: TODO_SCHEMA_VERSION,
    revision: changed ? state.revision + 1 : state.revision,
    nextId,
    tasks: [...nextVisible, ...nextArchived],
    change: { added, updated, archived },
  };
}

function todoTaskToInput(task: TodoTask, archivedKeys: ReadonlySet<string>): TodoTaskInput {
  const dependsOn = task.dependsOn?.filter((key) => !archivedKeys.has(key));
  return {
    key: task.key,
    subject: task.subject,
    status: task.status,
    ...(task.description ? { description: task.description } : {}),
    dependsOn: dependsOn ?? [],
  };
}

/**
 * Archive completed tasks that are no longer direct prerequisites of unfinished
 * work. Dependencies pointing at archived tasks are removed from survivors so
 * the resulting visible snapshot remains self-contained and valid.
 */
export function archiveCompletedTasks(state: TodoState): TodoDetails | undefined {
  const visible = getVisibleTasks(state);
  const required = new Set<string>();
  for (const task of visible) {
    if (task.status !== "pending" && task.status !== "in_progress") continue;
    for (const dependency of task.dependsOn ?? []) required.add(dependency);
  }

  const archivedKeys = new Set(
    visible
      .filter((task) => task.status === "completed" && !required.has(task.key))
      .map((task) => task.key),
  );
  if (archivedKeys.size === 0) return undefined;

  const tasks = visible
    .filter((task) => !archivedKeys.has(task.key))
    .map((task) => todoTaskToInput(task, archivedKeys));
  return writeTodoSnapshot(state, { tasks, baseRevision: state.revision });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function readState(value: unknown): TodoState | undefined {
  if (!isRecord(value) || value.schemaVersion !== TODO_SCHEMA_VERSION) return undefined;
  if (!Array.isArray(value.tasks) || typeof value.revision !== "number" || typeof value.nextId !== "number") {
    return undefined;
  }

  const tasks: TodoTask[] = [];
  for (const candidate of value.tasks) {
    if (!isRecord(candidate)) return undefined;
    if (
      typeof candidate.id !== "number" ||
      typeof candidate.key !== "string" ||
      typeof candidate.subject !== "string" ||
      typeof candidate.status !== "string"
    ) {
      return undefined;
    }
    if (!isTodoStatus(candidate.status)) return undefined;
    tasks.push({
      id: candidate.id,
      key: candidate.key,
      subject: candidate.subject,
      status: candidate.status as TodoStatus,
      archived: candidate.archived === true,
      ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
      ...(Array.isArray(candidate.dependsOn)
        ? { dependsOn: candidate.dependsOn.filter((item): item is string => typeof item === "string") }
        : {}),
    });
  }

  return {
    schemaVersion: TODO_SCHEMA_VERSION,
    revision: Math.max(0, Math.floor(value.revision)),
    nextId: Math.max(1, Math.floor(value.nextId)),
    tasks,
  };
}

export function replayTodoState(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TodoState {
  let state = createEmptyTodoState();
  for (const rawEntry of ctx.sessionManager.getBranch()) {
    if (!isRecord(rawEntry)) continue;

    // Read old custom checkpoints written by development builds.
    if (rawEntry.type === "custom" && rawEntry.customType === TODO_STATE_CUSTOM_TYPE) {
      const restored = readState(rawEntry.data);
      if (restored) state = restored;
      continue;
    }

    // Auto-archive checkpoints are hidden custom messages: one entry both
    // persists the new state and tells the model which revision is current.
    if (rawEntry.type === "custom_message" && rawEntry.customType === TODO_STATE_CUSTOM_TYPE) {
      const restored = readState(rawEntry.details);
      if (restored) state = restored;
      continue;
    }

    if (rawEntry.type !== "message" || !isRecord(rawEntry.message)) continue;
    const message = rawEntry.message;
    if (message.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME) continue;
    const restored = readState(message.details);
    if (restored) state = restored;
  }
  return cloneTodoState(state);
}
