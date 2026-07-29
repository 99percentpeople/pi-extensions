import {
  getSharedSettingsPath,
  readSettingsNamespace,
  writeSettingsNamespace,
} from "@99percentpeople/pi-shared-settings";
import {
  DEFAULT_THINKING_FOLD_OPTIONS,
  type ThinkingFoldMode,
  type ThinkingFoldOptions,
} from "./renderer.ts";

export interface ThinkingFoldConfig {
  mode: ThinkingFoldMode;
  previewLines: number;
  autoCollapse: boolean;
}

export const DEFAULT_THINKING_FOLD_CONFIG: ThinkingFoldConfig = {
  mode: DEFAULT_THINKING_FOLD_OPTIONS.mode,
  previewLines: DEFAULT_THINKING_FOLD_OPTIONS.previewLines,
  autoCollapse: DEFAULT_THINKING_FOLD_OPTIONS.autoCollapse,
};

export const THINKING_FOLD_SETTINGS_NAMESPACE = "thinking-fold";

export function getThinkingFoldConfigPath(): string {
  return getSharedSettingsPath();
}

function isMode(value: unknown): value is ThinkingFoldMode {
  return value === "auto" || value === "trace" || value === "summary";
}

export function normalizeThinkingFoldConfig(value: unknown): ThinkingFoldConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_THINKING_FOLD_CONFIG };
  const input = value as Partial<Record<keyof ThinkingFoldConfig, unknown>>;
  const previewLines =
    typeof input.previewLines === "number" &&
    Number.isInteger(input.previewLines) &&
    input.previewLines >= 1 &&
    input.previewLines <= 20
      ? input.previewLines
      : DEFAULT_THINKING_FOLD_CONFIG.previewLines;

  return {
    mode: isMode(input.mode) ? input.mode : DEFAULT_THINKING_FOLD_CONFIG.mode,
    previewLines,
    autoCollapse:
      typeof input.autoCollapse === "boolean"
        ? input.autoCollapse
        : DEFAULT_THINKING_FOLD_CONFIG.autoCollapse,
  };
}

export function loadThinkingFoldConfig(path = getThinkingFoldConfigPath()): ThinkingFoldConfig {
  return readSettingsNamespace(THINKING_FOLD_SETTINGS_NAMESPACE, normalizeThinkingFoldConfig, path);
}

export function saveThinkingFoldConfig(
  config: ThinkingFoldConfig,
  path = getThinkingFoldConfigPath(),
): void {
  writeSettingsNamespace(
    THINKING_FOLD_SETTINGS_NAMESPACE,
    normalizeThinkingFoldConfig(config),
    path,
  );
}

export function configToRenderOptions(
  config: ThinkingFoldConfig,
): Pick<ThinkingFoldOptions, "mode" | "previewLines" | "autoCollapse"> {
  return { ...config };
}
