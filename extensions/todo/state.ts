export const TODO_SCHEMA_VERSION = 2 as const;
const LEGACY_TODO_SCHEMA_VERSION = 1 as const;
export const TODO_TOOL_NAME = "todo";
export const TODO_STATE_CUSTOM_TYPE = "pi-todo-state";
export const MAX_TODO_TASKS = 50;
export const MAX_TASK_DEPENDENCIES = 20;

export type TodoStatus = "pending" | "in_progress" | "completed";

const TODO_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
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

export interface TodoTask extends ResolvedTodoTaskInput {}

export interface TodoState {
  schemaVersion: typeof TODO_SCHEMA_VERSION;
  revision: number;
  tasks: TodoTask[];
}

export interface TodoChangeSummary {
  added: string[];
  updated: string[];
  removed: string[];
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
    tasks: state.tasks.map(cloneTask),
  };
}

export function getTodoTasks(state: TodoState): TodoTask[] {
  return state.tasks.map(cloneTask);
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

function normalizeTaskKey(value: string, location: string): string {
  const key = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(key)) {
    throw new TodoValidationError(
      `${location} must be 1-40 lowercase ASCII letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return key;
}

function normalizeTask(input: ResolvedTodoTaskInput, index: number): ResolvedTodoTaskInput {
  const key = normalizeTaskKey(input.key, `tasks[${index}].key`);
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

  if ((input.dependsOn?.length ?? 0) > MAX_TASK_DEPENDENCIES) {
    throw new TodoValidationError(`tasks[${index}].dependsOn supports at most ${MAX_TASK_DEPENDENCIES} keys`);
  }
  const dependsOn = [...new Set((input.dependsOn ?? []).map((dependency) => dependency.trim()))];
  if (dependsOn.some((dependency) => !dependency)) {
    throw new TodoValidationError(`tasks[${index}].dependsOn cannot contain an empty key`);
  }
  for (const [dependencyIndex, dependency] of dependsOn.entries()) {
    normalizeTaskKey(dependency, `tasks[${index}].dependsOn[${dependencyIndex}]`);
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

function tasksEqual(left: TodoTask, right: TodoTask): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
    const key = normalizeTaskKey(patch.key, `tasks[${index}].key`);
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

  const removedTasks = state.tasks.filter((task) => !keys.has(task.key));
  const removedByKey = new Map(removedTasks.map((task) => [task.key, task]));
  const nextResolved = normalized.map<ResolvedTodoTaskInput>((task) => {
    if (task.status !== "completed" || !task.dependsOn?.length) return task;
    const dependsOn = task.dependsOn.filter(
      (dependency) => removedByKey.get(dependency)?.status !== "completed",
    );
    return {
      key: task.key,
      subject: task.subject,
      status: task.status,
      ...(task.description ? { description: task.description } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
    };
  });

  assertDependenciesAreConsistent(nextResolved);
  assertNoDependencyCycles(nextResolved);

  const added: string[] = [];
  const updated: string[] = [];
  const nextTasks = nextResolved.map<TodoTask>((task) => {
    const existing = existingByKey.get(task.key);
    const candidate = cloneTask(task);
    if (!existing) added.push(task.key);
    else if (!tasksEqual(existing, candidate)) updated.push(task.key);
    return candidate;
  });

  const previousOrder = state.tasks.map((task) => task.key);
  const nextOrder = nextTasks.map((task) => task.key);
  const orderChanged = previousOrder.length !== nextOrder.length || previousOrder.some((key, index) => key !== nextOrder[index]);
  const removed = removedTasks.map((task) => task.key);
  const changed = added.length > 0 || updated.length > 0 || removed.length > 0 || orderChanged;
  return {
    schemaVersion: TODO_SCHEMA_VERSION,
    revision: changed ? state.revision + 1 : state.revision,
    tasks: nextTasks,
    change: { added, updated, removed },
  };
}

function todoTaskToInput(task: TodoTask, removedKeys: ReadonlySet<string>): TodoTaskInput {
  const dependsOn = task.dependsOn?.filter((key) => !removedKeys.has(key));
  return {
    key: task.key,
    subject: task.subject,
    status: task.status,
    ...(task.description ? { description: task.description } : {}),
    dependsOn: dependsOn ?? [],
  };
}

/**
 * Remove completed tasks that are no longer direct prerequisites of unfinished
 * work. Dependencies pointing at removed tasks are deleted from survivors so
 * the resulting snapshot remains self-contained and valid.
 */
export function removeCompletedTasks(state: TodoState): TodoDetails | undefined {
  const tasks = getTodoTasks(state);
  const required = new Set<string>();
  for (const task of tasks) {
    if (task.status !== "pending" && task.status !== "in_progress") continue;
    for (const dependency of task.dependsOn ?? []) required.add(dependency);
  }

  const removedKeys = new Set(
    tasks
      .filter((task) => task.status === "completed" && !required.has(task.key))
      .map((task) => task.key),
  );
  if (removedKeys.size === 0) return undefined;

  const nextTasks = tasks
    .filter((task) => !removedKeys.has(task.key))
    .map((task) => todoTaskToInput(task, removedKeys));
  return writeTodoSnapshot(state, {
    tasks: nextTasks,
    baseRevision: state.revision,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function readPersistedTask(candidate: unknown, index: number): ResolvedTodoTaskInput | undefined {
  if (!isRecord(candidate)) return undefined;
  if (
    typeof candidate.key !== "string" ||
    typeof candidate.subject !== "string" ||
    typeof candidate.status !== "string"
  ) {
    return undefined;
  }
  if (candidate.description !== undefined && typeof candidate.description !== "string") return undefined;
  if (
    candidate.dependsOn !== undefined &&
    (!Array.isArray(candidate.dependsOn) || candidate.dependsOn.some((item) => typeof item !== "string"))
  ) {
    return undefined;
  }

  try {
    return normalizeTask({
      key: candidate.key,
      subject: candidate.subject,
      status: candidate.status as TodoStatus,
      ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
      ...(Array.isArray(candidate.dependsOn) ? { dependsOn: candidate.dependsOn as string[] } : {}),
    }, index);
  } catch {
    return undefined;
  }
}

function validatePersistedTasks(candidates: readonly unknown[]): TodoTask[] | undefined {
  if (candidates.length > MAX_TODO_TASKS) return undefined;
  const tasks: TodoTask[] = [];
  const keys = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    const task = readPersistedTask(candidate, index);
    if (!task || keys.has(task.key)) return undefined;
    keys.add(task.key);
    tasks.push(task);
  }
  try {
    assertDependenciesAreConsistent(tasks);
    assertNoDependencyCycles(tasks);
  } catch {
    return undefined;
  }
  return tasks;
}

function readRevision(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

function readCurrentState(value: Record<string, unknown>): TodoState | undefined {
  const revision = readRevision(value.revision);
  if (revision === undefined || !Array.isArray(value.tasks)) return undefined;
  const tasks = validatePersistedTasks(value.tasks);
  if (!tasks) return undefined;
  return { schemaVersion: TODO_SCHEMA_VERSION, revision, tasks };
}

function readLegacyState(value: Record<string, unknown>): TodoState | undefined {
  const revision = readRevision(value.revision);
  if (revision === undefined || !Array.isArray(value.tasks)) return undefined;

  const droppedKeys = new Set<string>();
  for (const candidate of value.tasks) {
    if (!isRecord(candidate) || typeof candidate.key !== "string") continue;
    if (candidate.archived === true || candidate.status === "cancelled") droppedKeys.add(candidate.key.trim());
  }

  const migratedCandidates: unknown[] = [];
  for (const candidate of value.tasks) {
    if (!isRecord(candidate)) return undefined;
    if (candidate.archived === true || candidate.status === "cancelled") continue;
    migratedCandidates.push(Array.isArray(candidate.dependsOn)
      ? {
          ...candidate,
          dependsOn: candidate.dependsOn.filter(
            (dependency) => typeof dependency !== "string" || !droppedKeys.has(dependency.trim()),
          ),
        }
      : candidate);
  }
  const tasks = validatePersistedTasks(migratedCandidates);
  if (!tasks) return undefined;
  return { schemaVersion: TODO_SCHEMA_VERSION, revision, tasks };
}

function readState(value: unknown): TodoState | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion === TODO_SCHEMA_VERSION) return readCurrentState(value);
  if (value.schemaVersion === LEGACY_TODO_SCHEMA_VERSION) return readLegacyState(value);
  return undefined;
}

function readTodoStateEntry(rawEntry: unknown): TodoState | undefined {
  if (!isRecord(rawEntry)) return undefined;

  if (rawEntry.type === "custom" && rawEntry.customType === TODO_STATE_CUSTOM_TYPE) {
    return readState(rawEntry.data);
  }
  if (rawEntry.type === "custom_message" && rawEntry.customType === TODO_STATE_CUSTOM_TYPE) {
    return readState(rawEntry.details);
  }
  if (rawEntry.type !== "message" || !isRecord(rawEntry.message)) return undefined;
  const message = rawEntry.message;
  if (message.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME) return undefined;
  return readState(message.details);
}

export function replayTodoState(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TodoState {
  let state = createEmptyTodoState();
  for (const rawEntry of ctx.sessionManager.getBranch()) {
    const restored = readTodoStateEntry(rawEntry);
    if (restored) state = restored;
  }
  return cloneTodoState(state);
}

/**
 * A compaction summary is not guaranteed to retain exact keys, dependencies,
 * and revision numbers. Legacy state migration also changes model-visible
 * semantics. Request one model-facing v2 checkpoint until a current-schema
 * todo result or custom message satisfies that requirement.
 */
export function needsTodoContextCheckpoint(entries: Iterable<unknown>): boolean {
  let needed = false;
  for (const rawEntry of entries) {
    if (!isRecord(rawEntry)) continue;
    if (rawEntry.type === "compaction") {
      needed = true;
      continue;
    }

    let persisted: unknown;
    let modelFacing = false;
    if (rawEntry.type === "custom" && rawEntry.customType === TODO_STATE_CUSTOM_TYPE) {
      persisted = rawEntry.data;
    } else if (rawEntry.type === "custom_message" && rawEntry.customType === TODO_STATE_CUSTOM_TYPE) {
      persisted = rawEntry.details;
      modelFacing = true;
    } else if (rawEntry.type === "message" && isRecord(rawEntry.message)) {
      const message = rawEntry.message;
      if (message.role === "toolResult" && message.toolName === TODO_TOOL_NAME) {
        persisted = message.details;
        modelFacing = true;
      }
    }
    if (!isRecord(persisted) || !readState(persisted)) continue;
    if (persisted.schemaVersion === LEGACY_TODO_SCHEMA_VERSION) needed = true;
    else if (persisted.schemaVersion === TODO_SCHEMA_VERSION && modelFacing) needed = false;
  }
  return needed;
}
