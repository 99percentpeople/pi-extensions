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
  type CodexUsageHandle,
} from "./usage.ts";

export default function (pi: ExtensionAPI) {
  let config = loadCodexApiConfig();
  let usageHandle: CodexUsageHandle | undefined;

  const controller = {
    getConfig: () => config,
    updateConfig: (next: CodexApiConfig, ctx: Parameters<CodexUsageHandle["refreshStatus"]>[0]) => {
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
    },
  };

  usageHandle = registerCodexUsageAndFast(pi, controller);
  const refreshUsageInBackground = (ctx: Parameters<CodexUsageHandle["refreshUsage"]>[0]) => {
    void usageHandle?.refreshUsage(ctx).catch(() => {});
  };
  registerCodexImageTool(pi, () => config, refreshUsageInBackground);
  registerCodexSearchTool(pi, () => config, refreshUsageInBackground);
  registerCodexApiSettings(pi, controller);
}

export {
  CodexApiClient,
  CodexApiError,
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
