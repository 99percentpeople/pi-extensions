/**
 * Background Tasks extension public entry point.
 *
 * Runtime implementation is split by responsibility and bundled into one
 * `index.min.js` by the package build.
 */

export { default } from "./extension.ts";

export { MemoryLogStore } from "./memory-log-store.ts";
export {
  BACKGROUND_BACKEND_PROTOCOL_VERSION,
  BACKGROUND_SEND_SIGNALS,
} from "./runtime.ts";
export type {
  BackgroundControlOptions,
  BackgroundControlProbeResult,
  BackgroundSignal,
  BackgroundTaskControl,
  BackgroundTasksExtensionDependencies,
  BackgroundTransportExitDisposition,
  WindowsProcessTreeKiller,
} from "./types.ts";
export {
  BACKGROUND_COLLAPSED_TASK_LIMIT_MAX,
  BACKGROUND_COLLAPSED_TASK_LIMIT_MIN,
  BACKGROUND_COLLAPSED_TASK_LIMIT_PRESETS,
  BACKGROUND_TASKS_SETTINGS_NAMESPACE,
  DEFAULT_BACKGROUND_TASKS_CONFIG,
  getBackgroundTasksConfigPath,
  loadBackgroundTasksConfig,
  normalizeBackgroundTasksConfig,
  saveBackgroundTasksConfig,
  type BackgroundOutputPreview,
  type BackgroundTasksConfig,
} from "./config.ts";
export {
  OUTPUT_PREVIEW_LABELS,
  registerBackgroundTasksSettings,
} from "./settings.ts";
