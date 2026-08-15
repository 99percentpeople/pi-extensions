import { registerExtensionSettings } from "@99percentpeople/pi-shared-settings";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEEPSEEK_ANCHOR_SETTINGS_NAMESPACE,
  type AnchorMode,
  type AnchorProfile,
  type AnchorScope,
  type DeepSeekAnchorConfig,
} from "./config.ts";

const PROFILE_LABELS: Record<AnchorProfile, string> = {
  "pi-native": "Pi native",
  "exact-dsh": "Exact DSH",
};

const MODE_LABELS: Record<AnchorMode, string> = {
  anchored: "Anchored",
  minimal: "Minimal",
  off: "Off",
};

const SCOPE_LABELS: Record<AnchorScope, string> = {
  session: "Session first",
  prompt: "Every prompt",
};

function keyForLabel<T extends string>(labels: Record<T, string>, label: string): T | undefined {
  return (Object.entries(labels) as Array<[T, string]>)
    .find(([, current]) => current === label)?.[0];
}

function toolsLabel(tools: string[]): string {
  return tools.join(" + ");
}

function toolChoices(config: DeepSeekAnchorConfig): string[] {
  return [...new Set([
    "bash + edit",
    "bash + read",
    toolsLabel(config.nativeBootstrapTools),
  ])];
}

export interface DeepSeekAnchorSettingsController {
  getConfig(): DeepSeekAnchorConfig;
  updateConfig(config: DeepSeekAnchorConfig, ctx: ExtensionContext): void;
}

export function updateDeepSeekAnchorConfigSetting(
  config: DeepSeekAnchorConfig,
  id: string,
  value: string,
): DeepSeekAnchorConfig | undefined {
  if (id === "profile") {
    const profile = keyForLabel(PROFILE_LABELS, value);
    return profile ? { ...config, profile } : undefined;
  }
  if (id === "mode") {
    const mode = keyForLabel(MODE_LABELS, value);
    return mode ? { ...config, mode } : undefined;
  }
  if (id === "scope") {
    const scope = keyForLabel(SCOPE_LABELS, value);
    return scope ? { ...config, scope } : undefined;
  }
  if (id === "nativeBootstrapTools") {
    const tools = value.split("+").map((name) => name.trim()).filter(Boolean);
    return tools.length > 0 ? { ...config, nativeBootstrapTools: tools } : undefined;
  }
  return undefined;
}

export function registerDeepSeekAnchorSettings(
  pi: ExtensionAPI,
  controller: DeepSeekAnchorSettingsController,
): void {
  registerExtensionSettings(pi, {
    namespace: DEEPSEEK_ANCHOR_SETTINGS_NAMESPACE,
    title: "DeepSeek Anchor",
    settings: () => {
      const config = controller.getConfig();
      return [
        {
          id: "profile",
          label: "Profile",
          description: "Pi-native compatibility or the POSIX-only DSH bootstrap contract",
          currentValue: PROFILE_LABELS[config.profile],
          values: Object.values(PROFILE_LABELS),
        },
        {
          id: "mode",
          label: "Mode",
          description: "Keep a session anchor with staged tools, stay minimal, or leave requests unchanged",
          currentValue: MODE_LABELS[config.mode],
          values: Object.values(MODE_LABELS),
        },
        ...(config.mode === "anchored" ? [{
          id: "scope",
          label: "Anchor scope",
          description: "Expand tools once per session or restage them for every user prompt",
          currentValue: SCOPE_LABELS[config.scope],
          values: Object.values(SCOPE_LABELS),
        }] : []),
        ...(config.profile === "pi-native" ? [{
          id: "nativeBootstrapTools",
          label: "Bootstrap tools",
          description: "Pi tools exposed by the native bootstrap request",
          currentValue: toolsLabel(config.nativeBootstrapTools),
          values: toolChoices(config),
        }] : []),
      ];
    },
    onChange: (id, value, ctx) => {
      const next = updateDeepSeekAnchorConfigSetting(controller.getConfig(), id, value);
      if (next) controller.updateConfig(next, ctx);
    },
  });
}

export {
  MODE_LABELS as DEEPSEEK_ANCHOR_MODE_LABELS,
  PROFILE_LABELS as DEEPSEEK_ANCHOR_PROFILE_LABELS,
  SCOPE_LABELS as DEEPSEEK_ANCHOR_SCOPE_LABELS,
};
