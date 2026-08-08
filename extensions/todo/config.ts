import {
  getSharedSettingsPath,
  readSettingsNamespace,
  writeSettingsNamespace,
} from "@99percentpeople/pi-shared-settings";

export interface TodoConfig {
  collapsedTaskLimit: number;
  showDependencyNumbers: boolean;
  reminderInterval: number;
}

export const TODO_SETTINGS_NAMESPACE = "todo";
export const TODO_COLLAPSED_TASK_LIMIT_MIN = 1;
export const TODO_COLLAPSED_TASK_LIMIT_MAX = 10;
export const TODO_COLLAPSED_TASK_LIMIT_PRESETS = [1, 2, 3, 5, 8, 10] as const;
export const TODO_REMINDER_INTERVAL_MIN = 0;
export const TODO_REMINDER_INTERVAL_MAX = 20;
export const TODO_REMINDER_INTERVAL_PRESETS = [0, 1, 2, 3, 5, 8, 10, 20] as const;

export const DEFAULT_TODO_CONFIG: TodoConfig = {
  collapsedTaskLimit: 3,
  showDependencyNumbers: true,
  reminderInterval: 3,
};

function isCollapsedTaskLimit(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= TODO_COLLAPSED_TASK_LIMIT_MIN
    && value <= TODO_COLLAPSED_TASK_LIMIT_MAX;
}

function isReminderInterval(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= TODO_REMINDER_INTERVAL_MIN
    && value <= TODO_REMINDER_INTERVAL_MAX;
}

export function normalizeTodoConfig(value: unknown): TodoConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_TODO_CONFIG };
  const input = value as {
    collapsedTaskLimit?: unknown;
    showDependencyNumbers?: unknown;
    reminderInterval?: unknown;
  };
  return {
    collapsedTaskLimit: isCollapsedTaskLimit(input.collapsedTaskLimit)
      ? input.collapsedTaskLimit
      : DEFAULT_TODO_CONFIG.collapsedTaskLimit,
    showDependencyNumbers: typeof input.showDependencyNumbers === "boolean"
      ? input.showDependencyNumbers
      : DEFAULT_TODO_CONFIG.showDependencyNumbers,
    reminderInterval: isReminderInterval(input.reminderInterval)
      ? input.reminderInterval
      : DEFAULT_TODO_CONFIG.reminderInterval,
  };
}

export function getTodoConfigPath(): string {
  return getSharedSettingsPath();
}

export function loadTodoConfig(path = getTodoConfigPath()): TodoConfig {
  return readSettingsNamespace(TODO_SETTINGS_NAMESPACE, normalizeTodoConfig, path);
}

export function saveTodoConfig(
  config: TodoConfig,
  path = getTodoConfigPath(),
): void {
  writeSettingsNamespace(TODO_SETTINGS_NAMESPACE, normalizeTodoConfig(config), path);
}
