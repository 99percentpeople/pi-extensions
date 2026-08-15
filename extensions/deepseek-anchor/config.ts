import {
  getSharedSettingsPath,
  readSettingsNamespace,
  writeSettingsNamespace,
} from "@99percentpeople/pi-shared-settings";

export type AnchorProfile = "pi-native" | "exact-dsh";
export type AnchorMode = "anchored" | "minimal" | "off";
export type AnchorScope = "session" | "prompt";

export interface DeepSeekAnchorConfig {
  version: 1;
  profile: AnchorProfile;
  mode: AnchorMode;
  scope: AnchorScope;
  targetProvider: string;
  targetModelId: string;
  nativeBootstrapTools: string[];
  nativeSystemPrompt: string;
}

export const DEEPSEEK_ANCHOR_SETTINGS_NAMESPACE = "deepseek-anchor";
export const DSH_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

export const DEFAULT_CONFIG: DeepSeekAnchorConfig = {
  version: 1,
  profile: "pi-native",
  mode: "anchored",
  scope: "session",
  targetProvider: "deepseek",
  targetModelId: "deepseek-v4-pro",
  nativeBootstrapTools: ["bash", "edit"],
  nativeSystemPrompt: DSH_SYSTEM_PROMPT,
};

function cloneDefaultConfig(): DeepSeekAnchorConfig {
  return {
    ...DEFAULT_CONFIG,
    nativeBootstrapTools: [...DEFAULT_CONFIG.nativeBootstrapTools],
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = [...new Set(value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => /^[A-Za-z0-9_.:-]+$/.test(entry)))];
  return names.length > 0 ? names : undefined;
}

export function normalizeConfig(value: unknown): DeepSeekAnchorConfig {
  const config = cloneDefaultConfig();
  if (!value || typeof value !== "object" || Array.isArray(value)) return config;
  const raw = value as Record<string, unknown>;

  if (raw.profile === "pi-native" || raw.profile === "exact-dsh") {
    config.profile = raw.profile;
  }
  if (raw.mode === "anchored" || raw.mode === "minimal" || raw.mode === "off") {
    config.mode = raw.mode;
  }
  if (raw.scope === "session" || raw.scope === "prompt") {
    config.scope = raw.scope;
  }

  config.targetProvider = nonEmptyString(raw.targetProvider) ?? config.targetProvider;
  config.targetModelId = nonEmptyString(raw.targetModelId) ?? config.targetModelId;
  config.nativeBootstrapTools =
    toolNames(raw.nativeBootstrapTools) ?? config.nativeBootstrapTools;
  config.nativeSystemPrompt =
    nonEmptyString(raw.nativeSystemPrompt) ?? config.nativeSystemPrompt;

  return config;
}

export function getDeepSeekAnchorConfigPath(): string {
  return getSharedSettingsPath();
}

export function loadConfig(path = getDeepSeekAnchorConfigPath()): DeepSeekAnchorConfig {
  return readSettingsNamespace(
    DEEPSEEK_ANCHOR_SETTINGS_NAMESPACE,
    normalizeConfig,
    path,
  );
}

export function saveConfig(config: DeepSeekAnchorConfig, path = getDeepSeekAnchorConfigPath()): void {
  writeSettingsNamespace(
    DEEPSEEK_ANCHOR_SETTINGS_NAMESPACE,
    normalizeConfig(config),
    path,
  );
}

export function targetKey(config: Pick<DeepSeekAnchorConfig, "targetProvider" | "targetModelId">): string {
  return `${config.targetProvider}/${config.targetModelId}`;
}

export function systemPromptFor(config: DeepSeekAnchorConfig): string {
  return config.profile === "exact-dsh" ? DSH_SYSTEM_PROMPT : config.nativeSystemPrompt;
}

export function bootstrapToolsFor(config: DeepSeekAnchorConfig): string[] {
  return config.profile === "exact-dsh"
    ? ["bash", "str_replace_editor"]
    : [...config.nativeBootstrapTools];
}
