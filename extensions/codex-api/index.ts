import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodexAskTool } from "./ask.ts";
import {
  loadCodexApiConfig,
  saveCodexApiConfig,
  type CodexApiConfig,
} from "./config.ts";
import {
  applyCodexToolFeatureChanges,
  disableUnavailableCodexTools,
  type CodexToolFeature,
} from "./features.ts";
import { registerCodexImageTool } from "./image.ts";
import { registerCodexSearchTool } from "./search.ts";
import { registerCodexApiSettings } from "./settings.ts";
import {
  registerCodexUsageAndFast,
  usageRefreshNeeded,
  type CodexUsageHandle,
} from "./usage.ts";

const CODEX_TOOL_FEATURES: readonly CodexToolFeature<CodexApiConfig>[] = [
  {
    toolName: "codex_search",
    isEnabled: (config) => config.searchEnabled !== false,
  },
  {
    toolName: "codex_image",
    isEnabled: (config) => config.imageEnabled !== false,
  },
  {
    toolName: "codex_ask",
    isEnabled: (config) => config.askEnabled !== false,
  },
];

export default function (pi: ExtensionAPI) {
  let config = loadCodexApiConfig();
  let usageHandle: CodexUsageHandle | undefined;

  pi.on("session_start", () => {
    disableUnavailableCodexTools(pi, config, CODEX_TOOL_FEATURES);
  });

  const controller = {
    getConfig: () => config,
    updateConfig: (next: CodexApiConfig, ctx: Parameters<CodexUsageHandle["refreshStatus"]>[0]) => {
      const prev = config;
      config = next;
      try {
        saveCodexApiConfig(config);
      } catch (error) {
        ctx.ui.notify(
          `Failed to save Codex API settings: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
      applyCodexToolFeatureChanges(pi, prev, next, CODEX_TOOL_FEATURES);
      usageHandle?.refreshStatus(ctx);
      // Toggling visibility or cross-provider access changes what the status
      // area may show; pull fresh data immediately instead of waiting for the
      // next request event (which may never come under other providers).
      if (usageRefreshNeeded(prev, next)) {
        void usageHandle?.refreshUsage(ctx, true).catch(() => {});
      }
    },
  };

  usageHandle = registerCodexUsageAndFast(pi, controller);
  const refreshUsageInBackground = (ctx: Parameters<CodexUsageHandle["refreshUsage"]>[0]) => {
    if (!config.usageStatus) return;
    void usageHandle?.refreshUsage(ctx).catch(() => {});
  };
  registerCodexAskTool(pi, () => config, refreshUsageInBackground);
  registerCodexImageTool(pi, () => config);
  registerCodexSearchTool(pi, () => config, refreshUsageInBackground);
  registerCodexApiSettings(pi, controller);
}

export {
  CodexApiClient,
  CodexApiError,
  CodexOAuthError,
  createCodexApiClient,
  extractCodexAccountId,
  resolveCodexApiRoot,
  type CodexApiClientContextOptions,
  type CodexApiClientOptions,
  type CodexFetch,
} from "./client.ts";
export {
  completeCodexAsk,
  registerCodexAskTool,
  resolveCodexAskModel,
  type CodexAskDetails,
  type CodexAskPhase,
  type CodexAskReasoning,
  type CodexTextModel,
} from "./ask.ts";
export {
  CODEX_API_SETTINGS_NAMESPACE,
  DEFAULT_CODEX_API_CONFIG,
  getCodexApiConfigPath,
  loadCodexApiConfig,
  normalizeCodexApiConfig,
  saveCodexApiConfig,
  type CodexApiConfig,
  type CodexImageQuality,
  type CodexResponseVerbosity,
  type CodexSearchContextSize,
  type CodexSearchMode,
} from "./config.ts";
export {
  applyCodexToolFeatureChanges,
  disableUnavailableCodexTools,
  type CodexToolFeature,
} from "./features.ts";
export {
  normalizeCodexImageSize,
  registerCodexImageTool,
  type CodexImageDetails,
} from "./image.ts";
export {
  cleanCodexSearchOutput,
  createCodexSearchDisplay,
  formatCodexSearchDisplay,
  type CodexSearchDisplay,
  type CodexSearchDocument,
  type CodexSearchDisplayLine,
  type CodexSearchDisplayLineRole,
  type CodexSearchLookup,
  type CodexSearchLookupSection,
  type CodexSearchLookupType,
  type CodexSearchSource,
} from "./search-display.ts";
export {
  registerCodexSearchTool,
  resolveSearchMode,
  SearchCommandsSchema,
  type CodexEffectiveSearchMode,
  type CodexSearchDetails,
} from "./search.ts";
export {
  codexFeatureSummary,
  CONTEXT_SIZE_LABELS,
  createCodexFeaturesPanel,
  IMAGE_QUALITY_LABELS,
  registerCodexApiSettings,
  RESPONSE_VERBOSITY_LABELS,
  SEARCH_MODE_LABELS,
  type CodexSettingsController,
} from "./settings.ts";
export {
  applyCodexProviderPayload,
  applyFastModePayload,
  applyResponseVerbosityPayload,
  formatCodexStatus,
  formatCodexUsage,
  formatCodexRedeemCredits,
  maskCodexEmail,
  parseCodexAccountInfo,
  parseCodexRateLimits,
  parseCodexRedeemCredits,
  parseCodexUsagePayload,
  registerCodexUsageAndFast,
  usageRefreshNeeded,
  type CodexAccountSnapshot,
  type CodexCreditsSnapshot,
  type CodexRateLimitSnapshot,
  type CodexRateLimitWindow,
  type CodexRedeemCredit,
  type CodexRedeemCreditsSnapshot,
  type CodexUsageExtras,
  type CodexUsageHandle,
  type CodexUsageOptions,
} from "./usage.ts";
