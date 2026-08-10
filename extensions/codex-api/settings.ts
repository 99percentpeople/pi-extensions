import {
  registerExtensionSettings,
  type ExtensionSettingsPanel,
} from "@99percentpeople/pi-shared-settings";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CODEX_API_SETTINGS_NAMESPACE,
  type CodexApiConfig,
  type CodexImageQuality,
  type CodexSearchContextSize,
  type CodexSearchMode,
} from "./config.ts";

const SEARCH_MODE_LABELS: Record<CodexSearchMode, string> = {
  auto: "Auto",
  cached: "Cached",
  indexed: "Indexed",
  live: "Live",
};

const CONTEXT_SIZE_LABELS: Record<CodexSearchContextSize, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const IMAGE_QUALITY_LABELS: Record<CodexImageQuality, string> = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "High",
};

function usagePollLabel(minutes: number): string {
  if (minutes <= 0) return "Off";
  return `${minutes}m`;
}

function usagePollMinutes(label: string): number {
  const match = /^(\d+)m$/.exec(label);
  return match ? Number(match[1]) : 0;
}

function keyForLabel<T extends string>(labels: Record<T, string>, value: string): T | undefined {
  return (Object.entries(labels) as Array<[T, string]>).find(([, label]) => label === value)?.[0];
}

export interface CodexSettingsController {
  getConfig(): CodexApiConfig;
  updateConfig(config: CodexApiConfig, ctx: ExtensionContext): void;
}

type CodexFeatureId = "searchEnabled" | "imageEnabled" | "fastMode" | "usageStatus";

interface CodexFeatureDefinition {
  id: CodexFeatureId;
  label: string;
  description: string;
}

const CODEX_FEATURES: readonly CodexFeatureDefinition[] = [
  {
    id: "searchEnabled",
    label: "Search",
    description: "Expose codex_search to the model and allow search or lookup calls",
  },
  {
    id: "imageEnabled",
    label: "Image",
    description: "Expose codex_image to the model and allow image generation or editing",
  },
  {
    id: "fastMode",
    label: "Fast mode",
    description: "Use the priority service tier and consume included limits faster",
  },
  {
    id: "usageStatus",
    label: "Usage monitor",
    description: "Show and refresh subscription usage in the background; manual usage commands remain available",
  },
];

export function codexFeatureSummary(config: CodexApiConfig): string {
  const enabled = CODEX_FEATURES.filter((feature) => config[feature.id]).length;
  return `${enabled}/${CODEX_FEATURES.length} On`;
}

export function createCodexFeaturesPanel(
  controller: CodexSettingsController,
): ExtensionSettingsPanel {
  return {
    title: "Codex Features",
    currentValue: () => codexFeatureSummary(controller.getConfig()),
    settings: () => {
      const config = controller.getConfig();
      return CODEX_FEATURES.map((feature) => ({
        ...feature,
        currentValue: config[feature.id] ? "On" : "Off",
        values: ["Off", "On"],
      }));
    },
    onChange: (id, value, ctx) => {
      const feature = CODEX_FEATURES.find((candidate) => candidate.id === id);
      if (!feature) return;
      controller.updateConfig({
        ...controller.getConfig(),
        [feature.id]: value === "On",
      }, ctx);
    },
  };
}

export function registerCodexApiSettings(
  pi: ExtensionAPI,
  controller: CodexSettingsController,
): void {
  const featurePanel = createCodexFeaturesPanel(controller);
  registerExtensionSettings(pi, {
    namespace: CODEX_API_SETTINGS_NAMESPACE,
    title: "Codex API",
    settings: () => {
      const config = controller.getConfig();
      return [
        {
          id: "features",
          label: "Features",
          description: "Open the Codex feature manager and toggle each capability On or Off",
          currentValue: codexFeatureSummary(config),
          submenu: featurePanel,
        },
        {
          id: "allowOtherProviders",
          label: "Other providers",
          description: "Allow non-Codex models to use Codex tools with your logged-in ChatGPT subscription",
          currentValue: config.allowOtherProviders ? "Allow" : "Codex only",
          values: ["Codex only", "Allow"],
        },
        {
          id: "searchMode",
          label: "Search mode",
          description: "Auto lets the AI choose per call; fixed modes cannot be overridden",
          currentValue: SEARCH_MODE_LABELS[config.searchMode],
          values: Object.values(SEARCH_MODE_LABELS),
        },
        {
          id: "searchContextSize",
          label: "Search context",
          description: "Amount of first-party search context returned to Codex",
          currentValue: CONTEXT_SIZE_LABELS[config.searchContextSize],
          values: Object.values(CONTEXT_SIZE_LABELS),
        },
        {
          id: "imageQuality",
          label: "Image quality",
          description: "Default GPT Image 2 quality; explicit per-image requests may override it",
          currentValue: IMAGE_QUALITY_LABELS[config.imageQuality],
          values: Object.values(IMAGE_QUALITY_LABELS),
        },
        {
          id: "usagePollInterval",
          label: "Usage poll",
          description: "Periodically refresh the usage status while a session is active (Off disables polling)",
          currentValue: usagePollLabel(config.usagePollInterval),
          values: ["Off", "1m", "5m", "15m"],
        },
      ];
    },
    onChange: (id, value, ctx) => {
      const config = controller.getConfig();
      if (id === "allowOtherProviders") {
        controller.updateConfig({ ...config, allowOtherProviders: value === "Allow" }, ctx);
      } else if (id === "searchMode") {
        controller.updateConfig({
          ...config,
          searchMode: keyForLabel(SEARCH_MODE_LABELS, value) ?? config.searchMode,
        }, ctx);
      } else if (id === "searchContextSize") {
        controller.updateConfig({
          ...config,
          searchContextSize:
            keyForLabel(CONTEXT_SIZE_LABELS, value) ?? config.searchContextSize,
        }, ctx);
      } else if (id === "imageQuality") {
        controller.updateConfig({
          ...config,
          imageQuality: keyForLabel(IMAGE_QUALITY_LABELS, value) ?? config.imageQuality,
        }, ctx);
      } else if (id === "usagePollInterval") {
        controller.updateConfig({ ...config, usagePollInterval: usagePollMinutes(value) }, ctx);
      }
    },
  });
}

export { CONTEXT_SIZE_LABELS, IMAGE_QUALITY_LABELS, SEARCH_MODE_LABELS };
