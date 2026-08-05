import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  loadCodexApiConfig,
  saveCodexApiConfig,
  type CodexApiConfig,
} from "./config.ts";
import { registerCodexImageTool } from "./image.ts";
import { registerCodexSearchTool } from "./search.ts";
import { registerCodexApiSettings } from "./settings.ts";
import {
  registerCodexUsageAndFast,
  usageRefreshNeeded,
  type CodexUsageHandle,
} from "./usage.ts";

export default function (pi: ExtensionAPI) {
  let config = loadCodexApiConfig();
  let usageHandle: CodexUsageHandle | undefined;

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
    void usageHandle?.refreshUsage(ctx).catch(() => {});
  };
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
  CODEX_API_SETTINGS_NAMESPACE,
  DEFAULT_CODEX_API_CONFIG,
  getCodexApiConfigPath,
  loadCodexApiConfig,
  normalizeCodexApiConfig,
  saveCodexApiConfig,
  type CodexApiConfig,
  type CodexImageQuality,
  type CodexSearchContextSize,
  type CodexSearchMode,
} from "./config.ts";
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
  CONTEXT_SIZE_LABELS,
  IMAGE_QUALITY_LABELS,
  registerCodexApiSettings,
  SEARCH_MODE_LABELS,
} from "./settings.ts";
export {
  applyFastModePayload,
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
