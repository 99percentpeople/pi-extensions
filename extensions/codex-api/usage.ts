import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createCodexApiClient } from "./client.ts";
import type { CodexApiConfig } from "./config.ts";

const USAGE_PATH = "../wham/usage";
const USAGE_REFRESH_INTERVAL_MS = 60_000;
const AUTH_WATCH_DEBOUNCE_MS = 100;

const STATUS_KEY = "codex-api-usage";

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface CodexCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

export interface CodexRateLimitSnapshot {
  limitId: string;
  limitName?: string;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  credits?: CodexCreditsSnapshot;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function property(value: Record<string, unknown>, snake: string, camel: string): unknown {
  return value[snake] ?? value[camel];
}

function payloadNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function payloadBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || (typeof value === "string" && value.toLowerCase() === "true")) return true;
  if (value === 0 || value === "0" || (typeof value === "string" && value.toLowerCase() === "false")) return false;
  return undefined;
}

function payloadWindow(value: unknown): CodexRateLimitWindow | undefined {
  const input = object(value);
  if (!input) return undefined;
  const usedPercent = payloadNumber(property(input, "used_percent", "usedPercent"));
  if (usedPercent === undefined) return undefined;
  const seconds = payloadNumber(property(input, "limit_window_seconds", "limitWindowSeconds"));
  return {
    usedPercent,
    windowMinutes: seconds !== undefined && seconds > 0 ? Math.ceil(seconds / 60) : undefined,
    resetsAt: payloadNumber(property(input, "reset_at", "resetAt")),
  };
}

function payloadCredits(value: unknown): CodexCreditsSnapshot | undefined {
  const input = object(value);
  if (!input) return undefined;
  const hasCredits = payloadBool(property(input, "has_credits", "hasCredits"));
  const unlimited = payloadBool(input.unlimited);
  if (hasCredits === undefined || unlimited === undefined) return undefined;
  const balance = input.balance;
  return {
    hasCredits,
    unlimited,
    balance: typeof balance === "string" && balance ? balance : undefined,
  };
}

function payloadSnapshot(
  limitId: string,
  limitName: string | undefined,
  rateLimitValue: unknown,
  creditsValue?: unknown,
): CodexRateLimitSnapshot {
  const rateLimit = object(rateLimitValue);
  return {
    limitId,
    limitName,
    primary: payloadWindow(rateLimit && property(rateLimit, "primary_window", "primaryWindow")),
    secondary: payloadWindow(rateLimit && property(rateLimit, "secondary_window", "secondaryWindow")),
    credits: payloadCredits(creditsValue),
  };
}

export function parseCodexUsagePayload(value: unknown): CodexRateLimitSnapshot[] {
  const input = object(value);
  if (!input) return [];
  const rateLimit = property(input, "rate_limit", "rateLimit");
  const snapshots = rateLimit !== undefined || input.credits !== undefined
    ? [payloadSnapshot("codex", undefined, rateLimit, input.credits)]
    : [];
  const additional = property(input, "additional_rate_limits", "additionalRateLimits");
  if (Array.isArray(additional)) {
    for (const value of additional) {
      const item = object(value);
      if (!item) continue;
      const id = property(item, "metered_feature", "meteredFeature");
      if (typeof id !== "string" || !id.trim()) continue;
      const name = property(item, "limit_name", "limitName");
      snapshots.push(payloadSnapshot(
        id.trim().toLowerCase().replace(/-/g, "_"),
        typeof name === "string" && name.trim() ? name.trim() : undefined,
        property(item, "rate_limit", "rateLimit"),
      ));
    }
  }
  return snapshots;
}

function normalizedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function bool(value: string | undefined): boolean | undefined {
  if (value === "1" || value?.toLowerCase() === "true") return true;
  if (value === "0" || value?.toLowerCase() === "false") return false;
  return undefined;
}

function windowFor(headers: Record<string, string>, prefix: string): CodexRateLimitWindow | undefined {
  const usedPercent = finiteNumber(headers[`${prefix}-used-percent`]);
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    windowMinutes: finiteNumber(headers[`${prefix}-window-minutes`]),
    resetsAt: finiteNumber(headers[`${prefix}-reset-at`]),
  };
}

export function parseCodexRateLimits(input: Record<string, string>): CodexRateLimitSnapshot[] {
  const headers = normalizedHeaders(input);
  const prefixes = new Set<string>();
  for (const name of Object.keys(headers)) {
    const match = /^x-(.+)-primary-used-percent$/.exec(name);
    if (match) prefixes.add(`x-${match[1]}`);
  }
  if (Object.keys(headers).some((name) => name.startsWith("x-codex-"))) prefixes.add("x-codex");

  return [...prefixes].sort().flatMap((prefix) => {
    const primary = windowFor(headers, `${prefix}-primary`);
    const secondary = windowFor(headers, `${prefix}-secondary`);
    const hasCredits = bool(headers["x-codex-credits-has-credits"]);
    const unlimited = bool(headers["x-codex-credits-unlimited"]);
    const credits = prefix === "x-codex" && hasCredits !== undefined && unlimited !== undefined
      ? {
          hasCredits,
          unlimited,
          balance: headers["x-codex-credits-balance"],
        }
      : undefined;
    if (!primary && !secondary && !credits) return [];
    return [{
      limitId: prefix.slice(2).replace(/-/g, "_"),
      limitName: headers[`${prefix}-limit-name`],
      primary,
      secondary,
      credits,
    }];
  });
}

function percent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function resetText(epochSeconds: number | undefined, now = Date.now()): string | undefined {
  if (epochSeconds === undefined) return undefined;
  const remainingMs = epochSeconds * 1000 - now;
  if (remainingMs <= 0) return undefined;
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

const KNOWN_WINDOWS = [
  { minutes: 5 * 60, label: "5h" },
  { minutes: 24 * 60, label: "daily" },
  { minutes: 7 * 24 * 60, label: "weekly" },
  { minutes: 30 * 24 * 60, label: "monthly" },
  { minutes: 365 * 24 * 60, label: "annual" },
] as const;

function windowLabel(window: CodexRateLimitWindow, fallback: string): string {
  if (window.windowMinutes === undefined) return fallback;
  const known = KNOWN_WINDOWS.find(({ minutes }) =>
    window.windowMinutes! >= minutes * 0.95 && window.windowMinutes! <= minutes * 1.05
  );
  return known?.label ?? fallback;
}

function activeWindow(window: CodexRateLimitWindow | undefined, now: number): window is CodexRateLimitWindow {
  if (!window) return false;
  const resetIsStale = window.resetsAt !== undefined && window.resetsAt * 1000 <= now;
  if (window.usedPercent === 0 && resetIsStale) return false;
  return window.usedPercent > 0
    || (window.windowMinutes !== undefined && window.windowMinutes > 0)
    || (window.resetsAt !== undefined && window.resetsAt * 1000 > now);
}

interface LabeledWindow {
  label: string;
  window: CodexRateLimitWindow;
}

function activeWindows(snapshot: CodexRateLimitSnapshot, now: number): LabeledWindow[] {
  return [
    activeWindow(snapshot.primary, now)
      ? { label: windowLabel(snapshot.primary, "usage"), window: snapshot.primary }
      : undefined,
    activeWindow(snapshot.secondary, now)
      ? { label: windowLabel(snapshot.secondary, "secondary usage"), window: snapshot.secondary }
      : undefined,
  ].filter((value): value is LabeledWindow => value !== undefined);
}

const USAGE_BAR_WIDTH = 20;

function remainingPercent(window: CodexRateLimitWindow): number {
  return Math.min(100, Math.max(0, 100 - window.usedPercent));
}

function usageBar(remaining: number): string {
  const filled = Math.round(remaining / 100 * USAGE_BAR_WIDTH);
  return `[${"█".repeat(filled)}${"░".repeat(USAGE_BAR_WIDTH - filled)}]`;
}

function windowText(item: LabeledWindow, labelWidth: number, now: number): string {
  const reset = resetText(item.window.resetsAt, now);
  const remaining = remainingPercent(item.window);
  return `${item.label.padEnd(labelWidth)} ${usageBar(remaining)} ${percent(remaining)}% left${reset ? ` resets in ${reset}` : ""}`;
}

function creditsText(credits: CodexCreditsSnapshot): string {
  if (credits.unlimited) return "unlimited additional credits";
  if (credits.hasCredits) {
    return `additional credits available${credits.balance ? ` (${credits.balance})` : ""}`;
  }
  return "no additional credits";
}

export function formatCodexUsage(
  snapshots: CodexRateLimitSnapshot[],
  now = Date.now(),
): string {
  if (snapshots.length === 0) {
    return "No Codex usage data is available. Run /codex-usage with an active Codex subscription model to refresh it.";
  }
  const lines = ["Codex usage"];
  for (const snapshot of snapshots) {
    const name = snapshot.limitName ?? snapshot.limitId;
    const windows = activeWindows(snapshot, now);
    const labelWidth = Math.max(0, ...windows.map((window) => window.label.length));
    lines.push("", name);
    if (windows.length === 0) lines.push("  no active usage windows");
    else lines.push(...windows.map((window) => `  ${windowText(window, labelWidth, now)}`));
    if (snapshot.credits) lines.push(`  ${creditsText(snapshot.credits)}`);
  }
  return lines.join("\n");
}

export function formatCodexStatus(
  snapshots: CodexRateLimitSnapshot[],
  fastMode: boolean,
  now = Date.now(),
): string | undefined {
  const snapshot = snapshots.find((item) => item.limitId === "codex") ?? snapshots[0];
  if (!snapshot) return undefined;
  const shortest = activeWindows(snapshot, now)
    .sort((left, right) => {
      const leftWindow = left.window.windowMinutes ?? Number.POSITIVE_INFINITY;
      const rightWindow = right.window.windowMinutes ?? Number.POSITIVE_INFINITY;
      if (leftWindow !== rightWindow) return leftWindow - rightWindow;
      return (left.window.resetsAt ?? Number.POSITIVE_INFINITY) - (right.window.resetsAt ?? Number.POSITIVE_INFINITY);
    })[0];
  if (!shortest) return undefined;
  const remaining = remainingPercent(shortest.window);
  const reset = resetText(shortest.window.resetsAt, now);
  return `Codex ${shortest.label} ${percent(remaining)}%${reset ? ` ${reset}` : ""}${fastMode ? " Fast" : ""}`;
}

export function applyFastModePayload(payload: unknown, enabled: boolean): unknown {
  if (!enabled || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return { ...(payload as Record<string, unknown>), service_tier: "priority" };
}

interface UsageController {
  getConfig(): CodexApiConfig;
  updateConfig(config: CodexApiConfig, ctx: ExtensionContext): void;
}

interface AccountUsageFetch {
  revision: number;
  promise: Promise<void>;
}

interface AccountUsageState {
  snapshots: CodexRateLimitSnapshot[];
  lastFetchAt: number;
  usageFetch?: AccountUsageFetch;
}

export interface CodexUsageHandle {
  getSnapshots(): CodexRateLimitSnapshot[];
  refreshStatus(ctx: ExtensionContext): void;
  refreshUsage(ctx: ExtensionContext, force?: boolean): Promise<void>;
}

export interface CodexUsageOptions {
  /** Internal/test override. Production watches Pi's agent-dir auth.json. */
  authPath?: string;
}

export function registerCodexUsageAndFast(
  pi: ExtensionAPI,
  controller: UsageController,
  options: CodexUsageOptions = {},
): CodexUsageHandle {
  const usageByAccount = new Map<string, AccountUsageState>();
  let activeAccountId: string | undefined;
  let credentialRevision = 0;
  let latestContext: ExtensionContext | undefined;
  let accountCheck: Promise<void> | undefined;
  let accountObserverActive = false;
  let authWatcher: FSWatcher | undefined;
  let authWatchDebounce: ReturnType<typeof setTimeout> | undefined;

  const usageEnabled = (ctx: ExtensionContext): boolean => {
    const config = controller.getConfig();
    return config.usageStatus
      && (ctx.model?.provider === "openai-codex" || config.allowOtherProviders);
  };

  const setStatus = (ctx: ExtensionContext, value: string | undefined): void => {
    ctx.ui.setStatus(STATUS_KEY, value && ctx.ui.theme
      ? ctx.ui.theme.fg("muted", value)
      : value);
  };

  const currentState = (): AccountUsageState | undefined =>
    activeAccountId ? usageByAccount.get(activeAccountId) : undefined;

  const refreshStatus = (ctx: ExtensionContext) => {
    latestContext = ctx;
    if (!usageEnabled(ctx)) {
      setStatus(ctx, undefined);
      return;
    }
    setStatus(ctx, formatCodexStatus(currentState()?.snapshots ?? [], controller.getConfig().fastMode));
  };

  const showSyncingStatus = (ctx: ExtensionContext): void => {
    latestContext = ctx;
    setStatus(ctx, usageEnabled(ctx) ? "Codex syncing…" : undefined);
  };

  const invalidateAuthState = (ctx: ExtensionContext, action: "set" | "remove"): void => {
    credentialRevision += 1;
    activeAccountId = undefined;
    usageByAccount.clear();
    if (action === "set") showSyncingStatus(ctx);
    else setStatus(ctx, undefined);
  };

  const activateAccount = (accountId: string, ctx: ExtensionContext): boolean => {
    if (activeAccountId === accountId) return false;
    credentialRevision += 1;
    activeAccountId = accountId;
    usageByAccount.clear();
    showSyncingStatus(ctx);
    return true;
  };

  const accountState = (accountId: string): AccountUsageState => {
    let state = usageByAccount.get(accountId);
    if (!state) {
      state = { snapshots: [], lastFetchAt: 0 };
      usageByAccount.set(accountId, state);
    }
    return state;
  };

  const resolveActiveClient = async (ctx: ExtensionContext, config: CodexApiConfig) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const revision = credentialRevision;
      const client = await createCodexApiClient(ctx, {
        allowOtherProviders: config.allowOtherProviders,
      });
      if (revision !== credentialRevision) continue;
      const accountChanged = activateAccount(client.accountId, ctx);
      return {
        accountChanged,
        accountId: client.accountId,
        client,
        revision: credentialRevision,
      };
    }
    throw new Error("Codex account changed while resolving subscription usage; retry the refresh");
  };

  const refreshUsage = async (ctx: ExtensionContext, force = false): Promise<void> => {
    latestContext = ctx;
    const config = controller.getConfig();
    if (ctx.model?.provider !== "openai-codex" && !config.allowOtherProviders) {
      throw new Error(
        "An active openai-codex model is required to refresh subscription usage. "
          + "Enable Other providers in /99settings to use the logged-in Codex subscription from another model.",
      );
    }

    const resolved = await resolveActiveClient(ctx, config);
    const state = accountState(resolved.accountId);
    const now = Date.now();
    if (
      !force
      && !resolved.accountChanged
      && state.snapshots.length > 0
      && now - state.lastFetchAt < USAGE_REFRESH_INTERVAL_MS
    ) {
      refreshStatus(ctx);
      return;
    }

    let usageFetch = state.usageFetch;
    if (!usageFetch || usageFetch.revision !== resolved.revision) {
      const operation = (async () => {
        const payload = await resolved.client.get<unknown>(USAGE_PATH);
        const parsed = parseCodexUsagePayload(payload);
        if (parsed.length === 0) throw new Error("Codex usage API returned no usage data");
        state.snapshots = parsed;
        state.lastFetchAt = Date.now();
      })();
      let nextFetch: AccountUsageFetch;
      const pending = operation.finally(() => {
        if (state.usageFetch === nextFetch) state.usageFetch = undefined;
      });
      nextFetch = { revision: resolved.revision, promise: pending };
      state.usageFetch = nextFetch;
      usageFetch = nextFetch;
    }

    await usageFetch.promise;
    if (activeAccountId === resolved.accountId && credentialRevision === resolved.revision) {
      refreshStatus(ctx);
    }
  };

  const refreshInBackground = (ctx: ExtensionContext, force = false) => {
    latestContext = ctx;
    void refreshUsage(ctx, force).catch(() => refreshStatus(ctx));
  };

  const codexOAuthAvailable = (ctx: ExtensionContext, config: CodexApiConfig): boolean => {
    const model = ctx.model?.provider === "openai-codex"
      ? ctx.model
      : config.allowOtherProviders
        ? ctx.modelRegistry.getAll().find((candidate) =>
            candidate.provider === "openai-codex" && ctx.modelRegistry.isUsingOAuth(candidate)
          )
        : undefined;
    return !!model && ctx.modelRegistry.isUsingOAuth(model);
  };

  const checkCurrentAccount = (ctx: ExtensionContext): Promise<void> => {
    latestContext = ctx;
    if (accountCheck) return accountCheck;
    const operation = (async () => {
      const config = controller.getConfig();
      if (!codexOAuthAvailable(ctx, config)) {
        if (activeAccountId !== undefined) invalidateAuthState(ctx, "remove");
        return;
      }
      let accountId: string;
      try {
        const client = await createCodexApiClient(ctx, {
          allowOtherProviders: config.allowOtherProviders,
        });
        accountId = client.accountId;
      } catch {
        // Keep the latest valid snapshot on transient credential-refresh failures.
        return;
      }
      if (!accountObserverActive || latestContext !== ctx) return;
      const accountChanged = activateAccount(accountId, ctx);
      if (config.usageStatus && (accountChanged || (currentState()?.snapshots.length ?? 0) === 0)) {
        await refreshUsage(ctx, true);
      }
    })();
    const pending = operation.finally(() => {
      if (accountCheck === pending) accountCheck = undefined;
    });
    accountCheck = pending;
    return pending;
  };

  const startAccountObserver = (ctx: ExtensionContext): void => {
    latestContext = ctx;
    accountObserverActive = true;
    if (authWatcher) return;
    const authPath = options.authPath ?? join(getAgentDir(), "auth.json");
    const authFilename = basename(authPath);
    try {
      const watcher = watch(dirname(authPath), { persistent: false }, (_event, filename) => {
        if (filename !== null && filename.toString() !== authFilename) return;
        if (authWatchDebounce) clearTimeout(authWatchDebounce);
        authWatchDebounce = setTimeout(() => {
          authWatchDebounce = undefined;
          const activeContext = latestContext;
          if (!activeContext) return;
          void (async () => {
            await activeContext.modelRegistry.refresh();
            if (latestContext !== activeContext) return;
            await checkCurrentAccount(activeContext);
          })().catch(() => {});
        }, AUTH_WATCH_DEBOUNCE_MS);
        authWatchDebounce.unref?.();
      });
      watcher.on("error", () => {
        watcher.close();
        if (authWatcher === watcher) authWatcher = undefined;
      });
      authWatcher = watcher;
    } catch {
      // The normal agent directory exists; natural usage events remain a fallback.
    }
    void checkCurrentAccount(ctx).catch(() => {});
  };

  const storeHeaderSnapshots = async (
    ctx: ExtensionContext,
    snapshots: CodexRateLimitSnapshot[],
  ): Promise<void> => {
    const resolved = await resolveActiveClient(ctx, controller.getConfig());
    const state = accountState(resolved.accountId);
    state.snapshots = snapshots;
    state.lastFetchAt = Date.now();
    if (activeAccountId === resolved.accountId && credentialRevision === resolved.revision) {
      refreshStatus(ctx);
    }
  };

  pi.registerCommand("codex-usage", {
    description: "Refresh and show Codex subscription usage limits and credits",
    handler: async (_args, ctx) => {
      try {
        await refreshUsage(ctx, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const snapshots = currentState()?.snapshots ?? [];
        if (snapshots.length === 0) {
          ctx.ui.notify(`Failed to refresh Codex usage: ${message}`, "error");
          return;
        }
        ctx.ui.notify(`Failed to refresh Codex usage; showing the latest snapshot: ${message}`, "warning");
      }
      ctx.ui.notify(formatCodexUsage(currentState()?.snapshots ?? []), "info");
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openai-codex") return;
    refreshInBackground(ctx);
    return applyFastModePayload(event.payload, controller.getConfig().fastMode);
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model?.provider !== "openai-codex") return;
    const parsed = parseCodexRateLimits(event.headers);
    if (parsed.length > 0) {
      void storeHeaderSnapshots(ctx, parsed).catch(() => refreshInBackground(ctx));
      return;
    }
    refreshInBackground(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    startAccountObserver(ctx);
    void checkCurrentAccount(ctx).catch(() => {});
    refreshInBackground(ctx, true);
  });
  pi.on("session_start", (_event, ctx) => {
    startAccountObserver(ctx);
    refreshInBackground(ctx, true);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    credentialRevision += 1;
    activeAccountId = undefined;
    usageByAccount.clear();
    latestContext = undefined;
    accountObserverActive = false;
    if (authWatchDebounce) clearTimeout(authWatchDebounce);
    authWatchDebounce = undefined;
    authWatcher?.close();
    authWatcher = undefined;
    accountCheck = undefined;
    setStatus(ctx, undefined);
  });

  return {
    getSnapshots: () => structuredClone(currentState()?.snapshots ?? []),
    refreshStatus,
    refreshUsage,
  };
}
