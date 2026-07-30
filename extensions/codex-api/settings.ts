import { registerExtensionSettings } from "@99percentpeople/pi-shared-settings";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CODEX_API_SETTINGS_NAMESPACE,
  type CodexApiConfig,
  type CodexImageQuality,
  type CodexSearchContextSize,
  type CodexSearchMode,
} from "./config.ts";

const SEARCH_MODE_LABELS: Record<CodexSearchMode, string> = {
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

function keyForLabel<T extends string>(labels: Record<T, string>, value: string): T | undefined {
  return (Object.entries(labels) as Array<[T, string]>).find(([, label]) => label === value)?.[0];
}

interface CodexSettingsController {
  getConfig(): CodexApiConfig;
  updateConfig(config: CodexApiConfig, ctx: ExtensionContext): void;
}

export function registerCodexApiSettings(
  pi: ExtensionAPI,
  controller: CodexSettingsController,
): void {
  registerExtensionSettings(pi, {
    namespace: CODEX_API_SETTINGS_NAMESPACE,
    title: "Codex API",
    settings: () => {
      const config = controller.getConfig();
      return [
        {
          id: "fastMode",
          label: "Fast mode",
          description: "Use the priority service tier and consume included limits faster",
          currentValue: config.fastMode ? "On" : "Off",
          values: ["Off", "On"],
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
          description: "Cached avoids live access; Indexed and Live allow fresher results",
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
          id: "usageStatus",
          label: "Usage status",
          description: "Show remaining Codex subscription usage in the status area",
          currentValue: config.usageStatus ? "Show" : "Hide",
          values: ["Show", "Hide"],
        },
      ];
    },
    onChange: (id, value, ctx) => {
      const config = controller.getConfig();
      if (id === "fastMode") {
        controller.updateConfig({ ...config, fastMode: value === "On" }, ctx);
      } else if (id === "allowOtherProviders") {
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
      } else if (id === "usageStatus") {
        controller.updateConfig({ ...config, usageStatus: value === "Show" }, ctx);
      }
    },
  });
}

export { CONTEXT_SIZE_LABELS, IMAGE_QUALITY_LABELS, SEARCH_MODE_LABELS };
