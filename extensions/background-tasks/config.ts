import {
  getSharedSettingsPath,
  readSettingsNamespace,
  writeSettingsNamespace,
} from "@99percentpeople/pi-shared-settings";

export type BackgroundOutputPreview = "off" | "failures" | "finished" | "all";

export interface BackgroundTasksConfig {
  collapsedTaskLimit: number;
  outputPreview: BackgroundOutputPreview;
}

export const BACKGROUND_TASKS_SETTINGS_NAMESPACE = "background-tasks";
export const BACKGROUND_COLLAPSED_TASK_LIMIT_MIN = 0;
export const BACKGROUND_COLLAPSED_TASK_LIMIT_MAX = 10;
export const BACKGROUND_COLLAPSED_TASK_LIMIT_PRESETS = [0, 1, 3, 5] as const;

export const DEFAULT_BACKGROUND_TASKS_CONFIG: BackgroundTasksConfig = {
  collapsedTaskLimit: 0,
  outputPreview: "finished",
};

function isCollapsedTaskLimit(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= BACKGROUND_COLLAPSED_TASK_LIMIT_MIN
    && value <= BACKGROUND_COLLAPSED_TASK_LIMIT_MAX;
}

function isOutputPreview(value: unknown): value is BackgroundOutputPreview {
  return value === "off"
    || value === "failures"
    || value === "finished"
    || value === "all";
}

export function normalizeBackgroundTasksConfig(value: unknown): BackgroundTasksConfig {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_BACKGROUND_TASKS_CONFIG };
  }
  const input = value as {
    collapsedTaskLimit?: unknown;
    outputPreview?: unknown;
  };
  return {
    collapsedTaskLimit: isCollapsedTaskLimit(input.collapsedTaskLimit)
      ? input.collapsedTaskLimit
      : DEFAULT_BACKGROUND_TASKS_CONFIG.collapsedTaskLimit,
    outputPreview: isOutputPreview(input.outputPreview)
      ? input.outputPreview
      : DEFAULT_BACKGROUND_TASKS_CONFIG.outputPreview,
  };
}

export function getBackgroundTasksConfigPath(): string {
  return getSharedSettingsPath();
}

export function loadBackgroundTasksConfig(
  path = getBackgroundTasksConfigPath(),
): BackgroundTasksConfig {
  return readSettingsNamespace(
    BACKGROUND_TASKS_SETTINGS_NAMESPACE,
    normalizeBackgroundTasksConfig,
    path,
  );
}

export function saveBackgroundTasksConfig(
  config: BackgroundTasksConfig,
  path = getBackgroundTasksConfigPath(),
): void {
  writeSettingsNamespace(
    BACKGROUND_TASKS_SETTINGS_NAMESPACE,
    normalizeBackgroundTasksConfig(config),
    path,
  );
}
