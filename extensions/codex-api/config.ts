import {
  getSharedSettingsPath,
  readSettingsNamespace,
  writeSettingsNamespace,
} from "@99percentpeople/pi-shared-settings";

export type CodexSearchMode = "auto" | "cached" | "indexed" | "live";
export type CodexSearchContextSize = "low" | "medium" | "high";
export type CodexImageQuality = "auto" | "low" | "medium" | "high";
export type CodexResponseVerbosity = "auto" | "low" | "medium" | "high";

export interface CodexApiConfig {
  fastMode: boolean;
  responseVerbosity: CodexResponseVerbosity;
  searchEnabled: boolean;
  imageEnabled: boolean;
  askEnabled: boolean;
  allowOtherProviders: boolean;
  searchMode: CodexSearchMode;
  searchContextSize: CodexSearchContextSize;
  imageQuality: CodexImageQuality;
  usageStatus: boolean;
  /** Minutes between background status refreshes; 0 disables polling. */
  usagePollInterval: number;
}

export const CODEX_API_SETTINGS_NAMESPACE = "codex-api";

export const DEFAULT_CODEX_API_CONFIG: CodexApiConfig = {
  fastMode: false,
  responseVerbosity: "auto",
  searchEnabled: true,
  imageEnabled: true,
  askEnabled: true,
  allowOtherProviders: false,
  searchMode: "auto",
  searchContextSize: "medium",
  imageQuality: "auto",
  usageStatus: true,
  usagePollInterval: 5,
};

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}

export function normalizeCodexApiConfig(value: unknown): CodexApiConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_CODEX_API_CONFIG };
  const input = value as Record<string, unknown>;
  return {
    fastMode: typeof input.fastMode === "boolean"
      ? input.fastMode
      : DEFAULT_CODEX_API_CONFIG.fastMode,
    responseVerbosity: oneOf(
      input.responseVerbosity,
      ["auto", "low", "medium", "high"],
      DEFAULT_CODEX_API_CONFIG.responseVerbosity,
    ),
    searchEnabled: typeof input.searchEnabled === "boolean"
      ? input.searchEnabled
      : DEFAULT_CODEX_API_CONFIG.searchEnabled,
    imageEnabled: typeof input.imageEnabled === "boolean"
      ? input.imageEnabled
      : DEFAULT_CODEX_API_CONFIG.imageEnabled,
    askEnabled: typeof input.askEnabled === "boolean"
      ? input.askEnabled
      : DEFAULT_CODEX_API_CONFIG.askEnabled,
    allowOtherProviders: typeof input.allowOtherProviders === "boolean"
      ? input.allowOtherProviders
      : DEFAULT_CODEX_API_CONFIG.allowOtherProviders,
    searchMode: oneOf(
      input.searchMode,
      ["auto", "cached", "indexed", "live"],
      DEFAULT_CODEX_API_CONFIG.searchMode,
    ),
    searchContextSize: oneOf(
      input.searchContextSize,
      ["low", "medium", "high"],
      DEFAULT_CODEX_API_CONFIG.searchContextSize,
    ),
    imageQuality: oneOf(
      input.imageQuality,
      ["auto", "low", "medium", "high"],
      DEFAULT_CODEX_API_CONFIG.imageQuality,
    ),
    usageStatus: typeof input.usageStatus === "boolean"
      ? input.usageStatus
      : DEFAULT_CODEX_API_CONFIG.usageStatus,
    usagePollInterval: typeof input.usagePollInterval === "number"
        && Number.isFinite(input.usagePollInterval)
        && input.usagePollInterval >= 0
      ? Math.min(60, Math.round(input.usagePollInterval))
      : DEFAULT_CODEX_API_CONFIG.usagePollInterval,
  };
}

export function getCodexApiConfigPath(): string {
  return getSharedSettingsPath();
}

export function loadCodexApiConfig(path = getCodexApiConfigPath()): CodexApiConfig {
  return readSettingsNamespace(CODEX_API_SETTINGS_NAMESPACE, normalizeCodexApiConfig, path);
}

export function saveCodexApiConfig(
  config: CodexApiConfig,
  path = getCodexApiConfigPath(),
): void {
  writeSettingsNamespace(CODEX_API_SETTINGS_NAMESPACE, normalizeCodexApiConfig(config), path);
}
