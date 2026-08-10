import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  CodexApiError,
  CodexOAuthError,
  createCodexApiClient,
  type CodexApiClient,
} from "./client.ts";
import type { CodexApiConfig } from "./config.ts";

const USAGE_PATH = "../wham/usage";
const REDEEM_CREDITS_PATH = "../wham/rate-limit-reset-credits";
const REDEEM_PATH = "../wham/rate-limit-reset-credits/consume";
const REDEEM_CONFIRM_WINDOW_MS = 10_000;
const REDEEM_DIALOG_TIMEOUT_MS = 30_000;
const REDEEM_RETRY_WINDOW_MS = 5 * 60_000;
const USAGE_REFRESH_INTERVAL_MS = 60_000;
/** Re-render the reset countdown locally; network refreshes only re-sync the snapshot. */
const USAGE_COUNTDOWN_INTERVAL_MS = 60_000;
const AUTH_WATCH_DEBOUNCE_MS = 100;
/** Cap usage/redeem requests so a stalled backend cannot wedge the status pipeline. */
const USAGE_FETCH_TIMEOUT_MS = 15_000;
const AUTH_EXPIRED_STATUS = "Codex auth expired";
const USAGE_UNAVAILABLE_STATUS = "Codex usage unavailable";

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
  /** True when the server reports the account has hit its Codex usage limit. */
  limitReached?: boolean;
}

export interface CodexAccountSnapshot {
  planType?: string;
  email?: string;
}

export interface CodexRedeemCredit {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  /** Epoch milliseconds, when provided by the backend. */
  grantedAt?: number;
  expiresAt?: number;
}

export interface CodexRedeemCreditsSnapshot {
  availableCount: number;
  totalEarnedCount?: number;
  credits: CodexRedeemCredit[];
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

function payloadDate(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function payloadString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  limitReached?: boolean,
): CodexRateLimitSnapshot {
  const rateLimit = object(rateLimitValue);
  return {
    limitId,
    limitName,
    primary: payloadWindow(rateLimit && property(rateLimit, "primary_window", "primaryWindow")),
    secondary: payloadWindow(rateLimit && property(rateLimit, "secondary_window", "secondaryWindow")),
    credits: payloadCredits(creditsValue),
    limitReached,
  };
}

export function parseCodexAccountInfo(value: unknown): CodexAccountSnapshot | undefined {
  const input = object(value);
  if (!input) return undefined;
  const planType = payloadString(property(input, "plan_type", "planType"));
  const email = payloadString(property(input, "email", "email"));
  if (planType === undefined && email === undefined) return undefined;
  return { planType, email };
}

export function maskCodexEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const head = local.length > 3 ? local.slice(0, 3) : local.slice(0, 1);
  return `${head}***@${domain}`;
}

export function parseCodexRedeemCredits(value: unknown): CodexRedeemCreditsSnapshot | undefined {
  const input = object(value);
  if (!input) return undefined;
  const availableCount = payloadNumber(property(input, "available_count", "availableCount"));
  if (availableCount === undefined) return undefined;
  const credits: CodexRedeemCredit[] = [];
  const list = property(input, "credits", "credits");
  if (Array.isArray(list)) {
    for (const item of list) {
      const credit = object(item);
      if (!credit) continue;
      const id = payloadString(property(credit, "id", "id"));
      if (!id) continue;
      credits.push({
        id,
        title: payloadString(property(credit, "title", "title")),
        description: payloadString(property(credit, "description", "description")),
        status: payloadString(property(credit, "status", "status")),
        grantedAt: payloadDate(property(credit, "granted_at", "grantedAt")),
        expiresAt: payloadDate(property(credit, "expires_at", "expiresAt")),
      });
    }
  }
  return {
    availableCount,
    totalEarnedCount: payloadNumber(property(input, "total_earned_count", "totalEarnedCount")),
    credits,
  };
}

export function parseCodexUsagePayload(value: unknown): CodexRateLimitSnapshot[] {
  const input = object(value);
  if (!input) return [];
  const rateLimit = property(input, "rate_limit", "rateLimit");
  const rateLimitObject = object(rateLimit);
  const limitReached = payloadBool(rateLimitObject && property(rateLimitObject, "limit_reached", "limitReached"));
  const snapshots = rateLimit !== undefined || input.credits !== undefined
    ? [payloadSnapshot("codex", undefined, rateLimit, input.credits, limitReached)]
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
    // The backend includes this header only when the account is currently rate limited.
    const limitReached = prefix === "x-codex"
      ? headers["x-codex-rate-limit-reached-type"] !== undefined
      : undefined;
    if (!primary && !secondary && !credits && !limitReached) return [];
    return [{
      limitId: prefix.slice(2).replace(/-/g, "_"),
      limitName: headers[`${prefix}-limit-name`],
      primary,
      secondary,
      credits,
      limitReached,
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
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  if (totalMinutes < 24 * 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
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

function windowText(item: LabeledWindow, labelWidth: number, now: number, limitReached: boolean): string {
  const reset = resetText(item.window.resetsAt, now);
  const remaining = remainingPercent(item.window);
  const state = limitReached ? "limit reached" : `${percent(remaining)}% left`;
  return `${item.label.padEnd(labelWidth)} ${usageBar(limitReached ? 0 : remaining)} ${state}${reset ? ` resets in ${reset}` : ""}`;
}

function creditsText(credits: CodexCreditsSnapshot): string {
  if (credits.unlimited) return "unlimited additional credits";
  if (credits.hasCredits) {
    return `additional credits available${credits.balance ? ` (${credits.balance})` : ""}`;
  }
  return "no additional credits";
}

export interface CodexUsageExtras {
  account?: CodexAccountSnapshot;
  redeemCredits?: CodexRedeemCreditsSnapshot;
}

function planLabel(planType: string): string {
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}

function formatDateTime(epochMs: number): string {
  // Render in the user's local timezone with an explicit UTC offset label, so
  // the expiry reads naturally while the boundary stays unambiguous.
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -new Date(epochMs).getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset = abs % 60 === 0
    ? `UTC${sign}${abs / 60}`
    : `UTC${sign}${Math.floor(abs / 60)}:${pad(abs % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${offset}`;
}

/** Renders redeem lines; returns an empty array when there is nothing to redeem. */
export function formatCodexRedeemCredits(
  redeemCredits: CodexRedeemCreditsSnapshot | undefined,
  now = Date.now(),
): string[] {
  if (!redeemCredits || redeemCredits.availableCount <= 0) return [];
  const lines = [`rate limit redeem${redeemCredits.availableCount === 1 ? "" : ` ×${redeemCredits.availableCount}`}`];
  const available = redeemCredits.credits
    .filter((credit) => credit.status === undefined || credit.status === "available")
    // Earliest expiring first, so the most urgent card is visible at the top.
    .sort((left, right) => (left.expiresAt ?? Number.POSITIVE_INFINITY) - (right.expiresAt ?? Number.POSITIVE_INFINITY));
  for (const credit of available) {
    const details: string[] = ["available"];
    if (credit.expiresAt !== undefined) {
      details.push(credit.expiresAt > now ? `expires ${formatDateTime(credit.expiresAt)}` : "expired");
    }
    lines.push(`  ${credit.title ?? "reset credit"} (${details.join(", ")})`);
  }
  return lines.length > 1 ? lines : [];
}

export function formatCodexUsage(
  snapshots: CodexRateLimitSnapshot[],
  now = Date.now(),
  extras: CodexUsageExtras = {},
): string {
  if (snapshots.length === 0) {
    return "No Codex usage data is available. Run /codex-usage with an active Codex subscription model to refresh it.";
  }
  const lines = ["Codex usage"];
  if (extras.account) {
    const plan = extras.account.planType ? planLabel(extras.account.planType) : "unknown plan";
    lines.push("", `account · ${plan}${extras.account.email ? ` (${maskCodexEmail(extras.account.email)})` : ""}`);
  }
  for (const snapshot of snapshots) {
    const name = snapshot.limitName ?? snapshot.limitId;
    const windows = activeWindows(snapshot, now);
    const labelWidth = Math.max(0, ...windows.map((window) => window.label.length));
    lines.push("", name);
    if (windows.length === 0) lines.push("  no active usage windows");
    else lines.push(...windows.map((window) => `  ${windowText(window, labelWidth, now, snapshot.limitReached === true)}`));
    if (snapshot.credits) lines.push(`  ${creditsText(snapshot.credits)}`);
  }
  const redeemLines = formatCodexRedeemCredits(extras.redeemCredits, now);
  if (redeemLines.length > 0) lines.push("", ...redeemLines);
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
  const usage = snapshot.limitReached === true ? "limit reached" : `${percent(remaining)}%`;
  return `Codex ${shortest.label} ${usage}${reset ? ` ${reset}` : ""}${fastMode ? " Fast" : ""}`;
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

interface ResolvedActiveClient {
  accountChanged: boolean;
  accountId: string;
  client: CodexApiClient;
  revision: number;
}

interface PendingRedeem {
  redeemRequestId: string;
  creditId?: string;
  expiresAt: number;
}

interface AccountUsageState {
  snapshots: CodexRateLimitSnapshot[];
  account?: CodexAccountSnapshot;
  redeemCredits?: CodexRedeemCreditsSnapshot;
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
  /** Internal/test override for command-handler tests without a session lifecycle. */
  registerCommandsImmediately?: boolean;
  /** Internal/test override to keep timeout tests fast. */
  usageFetchTimeoutMs?: number;
}

/**
 * Whether a settings change should pull fresh usage data immediately:
 * toggling status visibility on, or changing cross-provider tool access,
 * both alter what the status area can show.
 */
export function usageRefreshNeeded(prev: CodexApiConfig, next: CodexApiConfig): boolean {
  return next.usageStatus
    && (prev.usageStatus !== next.usageStatus || prev.allowOtherProviders !== next.allowOtherProviders);
}

export function registerCodexUsageAndFast(
  pi: ExtensionAPI,
  controller: UsageController,
  options: CodexUsageOptions = {},
): CodexUsageHandle {
  const usageByAccount = new Map<string, AccountUsageState>();
  const pendingRedeemByAccount = new Map<string, PendingRedeem>();
  let activeAccountId: string | undefined;
  let credentialRevision = 0;
  let latestContext: ExtensionContext | undefined;
  let accountCheck: Promise<void> | undefined;
  let accountObserverActive = false;
  let authWatcher: FSWatcher | undefined;
  let authWatchDebounce: ReturnType<typeof setTimeout> | undefined;
  let pollDelay: ReturnType<typeof setTimeout> | undefined;
  let countdownInterval: ReturnType<typeof setInterval> | undefined;

  const codexOAuthLoginAvailable = (ctx: ExtensionContext): boolean =>
    (ctx.model?.provider === "openai-codex" && ctx.modelRegistry.isUsingOAuth(ctx.model))
    || (ctx.modelRegistry.getAll?.() ?? []).some((candidate) =>
      candidate.provider === "openai-codex" && ctx.modelRegistry.isUsingOAuth(candidate)
    );

  const usageEnabled = (ctx: ExtensionContext): boolean => {
    const config = controller.getConfig();
    return config.usageStatus
      && (ctx.model?.provider === "openai-codex" || config.allowOtherProviders);
  };

  const usageFetchSignal = (): AbortSignal =>
    AbortSignal.timeout(options.usageFetchTimeoutMs ?? USAGE_FETCH_TIMEOUT_MS);

  const setStatus = (
    ctx: ExtensionContext,
    value: string | undefined,
    color: ThemeColor = "muted",
  ): void => {
    ctx.ui.setStatus(STATUS_KEY, value && ctx.ui.theme
      ? ctx.ui.theme.fg(color, value)
      : value);
  };

  const stopCountdown = (): void => {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = undefined;
    }
  };

  const resetAccountState = (): void => {
    stopCountdown();
    credentialRevision += 1;
    activeAccountId = undefined;
    usageByAccount.clear();
    pendingRedeemByAccount.clear();
  };

  /** Missing OAuth is an inactive state, not an expired-credential error. */
  const clearIfCodexOAuthUnavailable = (ctx: ExtensionContext): boolean => {
    if (codexOAuthLoginAvailable(ctx)) return false;
    if (
      activeAccountId !== undefined
      || usageByAccount.size > 0
      || pendingRedeemByAccount.size > 0
      || accountCheck !== undefined
    ) {
      resetAccountState();
    }
    setStatus(ctx, undefined);
    return true;
  };

  const currentState = (): AccountUsageState | undefined =>
    activeAccountId ? usageByAccount.get(activeAccountId) : undefined;

  const hasFutureReset = (state: AccountUsageState | undefined, now = Date.now()): boolean =>
    state?.snapshots.some((snapshot) => [snapshot.primary, snapshot.secondary].some((window) =>
      window?.resetsAt !== undefined && window.resetsAt * 1000 > now
    )) === true;

  const syncCountdown = (ctx: ExtensionContext): void => {
    if (!usageEnabled(ctx) || !hasFutureReset(currentState())) {
      stopCountdown();
      return;
    }
    if (countdownInterval) return;
    countdownInterval = setInterval(() => {
      const active = latestContext;
      if (!active) {
        stopCountdown();
        return;
      }
      // Recompute from the absolute reset timestamp. This intentionally does
      // not fetch; a normal refresh replaces the snapshot and re-syncs it.
      refreshStatus(active);
    }, USAGE_COUNTDOWN_INTERVAL_MS);
    countdownInterval.unref?.();
  };

  function refreshStatus(ctx: ExtensionContext): void {
    latestContext = ctx;
    if (clearIfCodexOAuthUnavailable(ctx)) return;
    if (!usageEnabled(ctx)) {
      stopCountdown();
      setStatus(ctx, undefined);
      return;
    }
    setStatus(ctx, formatCodexStatus(currentState()?.snapshots ?? [], controller.getConfig().fastMode));
    syncCountdown(ctx);
  }

  const showSyncingStatus = (ctx: ExtensionContext): void => {
    latestContext = ctx;
    if (clearIfCodexOAuthUnavailable(ctx)) return;
    stopCountdown();
    setStatus(ctx, usageEnabled(ctx) ? "Codex syncing…" : undefined);
  };

  /**
   * Terminal status for a failed refresh: keep the last known usage during
   * transient failures, but surface an actionable error when the stored OAuth
   * token is rejected outright (the snapshot would be stale anyway).
   */
  const showErrorStatus = (ctx: ExtensionContext, error: unknown): void => {
    latestContext = ctx;
    if (clearIfCodexOAuthUnavailable(ctx)) return;
    if (!usageEnabled(ctx)) {
      stopCountdown();
      setStatus(ctx, undefined);
      return;
    }
    const isAuthError = error instanceof CodexOAuthError
      || (error instanceof CodexApiError && (error.status === 401 || error.status === 403));
    const snapshots = currentState()?.snapshots;
    if (!isAuthError && snapshots && snapshots.length > 0) {
      setStatus(ctx, formatCodexStatus(snapshots, controller.getConfig().fastMode));
      syncCountdown(ctx);
      return;
    }
    stopCountdown();
    setStatus(
      ctx,
      isAuthError ? AUTH_EXPIRED_STATUS : USAGE_UNAVAILABLE_STATUS,
      isAuthError ? "error" : "warning",
    );
  };

  const invalidateAuthState = (ctx: ExtensionContext, action: "set" | "remove"): void => {
    resetAccountState();
    if (action === "set") showSyncingStatus(ctx);
    else setStatus(ctx, undefined);
  };

  const activateAccount = (accountId: string, ctx: ExtensionContext): boolean => {
    if (activeAccountId === accountId) return false;
    credentialRevision += 1;
    activeAccountId = accountId;
    usageByAccount.clear();
    pendingRedeemByAccount.clear();
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

  const resolveActiveClient = async (
    ctx: ExtensionContext,
    config: CodexApiConfig,
  ): Promise<ResolvedActiveClient> => {
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

  const isCurrentResolution = (
    ctx: ExtensionContext,
    resolved: ResolvedActiveClient,
  ): boolean => latestContext === ctx
    && activeAccountId === resolved.accountId
    && credentialRevision === resolved.revision;

  const refreshResolvedUsage = async (
    ctx: ExtensionContext,
    resolved: ResolvedActiveClient,
    force = false,
  ): Promise<void> => {
    const state = accountState(resolved.accountId);
    const now = Date.now();
    if (
      !force
      && !resolved.accountChanged
      && state.snapshots.length > 0
      && now - state.lastFetchAt < USAGE_REFRESH_INTERVAL_MS
    ) {
      if (isCurrentResolution(ctx, resolved)) refreshStatus(ctx);
      return;
    }

    let usageFetch = state.usageFetch;
    if (!usageFetch || usageFetch.revision !== resolved.revision) {
      const operation = (async () => {
        // Timeout: a stalled request must settle so the transient syncing
        // state is always replaced by a terminal status.
        const payload = await resolved.client.get<unknown>(
          USAGE_PATH,
          usageFetchSignal(),
        );
        const parsed = parseCodexUsagePayload(payload);
        if (parsed.length === 0) throw new Error("Codex usage API returned no usage data");
        state.snapshots = parsed;
        state.account = parseCodexAccountInfo(payload);
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
    if (isCurrentResolution(ctx, resolved)) refreshStatus(ctx);
  };

  const refreshUsage = async (ctx: ExtensionContext, force = false): Promise<void> => {
    latestContext = ctx;
    const invocationRevision = credentialRevision;
    const config = controller.getConfig();
    if (ctx.model?.provider !== "openai-codex" && !config.allowOtherProviders) {
      const error = new Error(
        "An active openai-codex model is required to refresh subscription usage. "
          + "Enable Other providers in /99settings to use the logged-in Codex subscription from another model.",
      );
      showErrorStatus(ctx, error);
      throw error;
    }

    let resolved: ResolvedActiveClient | undefined;
    try {
      resolved = await resolveActiveClient(ctx, config);
      await refreshResolvedUsage(ctx, resolved, force);
    } catch (error) {
      // Ignore stale completions from an old account/context/session. A current
      // failure always replaces syncing with a terminal status.
      const isCurrent = resolved
        ? isCurrentResolution(ctx, resolved)
        : latestContext === ctx && credentialRevision === invocationRevision;
      if (isCurrent) showErrorStatus(ctx, error);
      throw error;
    }
  };

  const refreshInBackground = (ctx: ExtensionContext, force = false) => {
    latestContext = ctx;
    // refreshUsage reports the terminal status itself on failure.
    void refreshUsage(ctx, force).catch(() => {});
  };

  const stopPolling = (): void => {
    if (pollDelay) {
      clearTimeout(pollDelay);
      pollDelay = undefined;
    }
  };

  /**
   * Chain a background poll with setTimeout (not setInterval) so the interval
   * is re-read from the latest config on every round: changing the setting
   * takes effect without restarting anything.
   */
  const scheduleNextPoll = (): void => {
    if (pollDelay) return;
    const intervalMinutes = Math.round(controller.getConfig().usagePollInterval);
    if (intervalMinutes <= 0) return;
    pollDelay = setTimeout(() => {
      pollDelay = undefined;
      const active = latestContext;
      if (active) {
        // Reconcile auth before polling so logout cannot revive an expired
        // status through a credential-resolution failure.
        const oauthAvailable = !clearIfCodexOAuthUnavailable(active);
        const state = currentState();
        if (oauthAvailable && usageEnabled(active)) {
          const intervalMs = intervalMinutes * 60_000;
          if (!state || state.snapshots.length === 0 || Date.now() - state.lastFetchAt >= intervalMs) {
            void refreshUsage(active).catch(() => {});
          }
        }
      }
      scheduleNextPoll();
    }, intervalMinutes * 60_000);
    pollDelay.unref?.();
  };

  const startPolling = (ctx: ExtensionContext): void => {
    latestContext = ctx;
    scheduleNextPoll();
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

  const checkCurrentAccount = (
    ctx: ExtensionContext,
    forceUsage = false,
  ): Promise<void> => {
    latestContext = ctx;
    if (accountCheck) return accountCheck;
    const operation = (async () => {
      const config = controller.getConfig();
      const usageAvailable = codexOAuthAvailable(ctx, config);
      if (!codexOAuthLoginAvailable(ctx)) {
        if (activeAccountId !== undefined) invalidateAuthState(ctx, "remove");
        else setStatus(ctx, undefined);
        return;
      }
      let client: CodexApiClient;
      try {
        // Command visibility follows login state, not the active model or the
        // cross-provider tool setting. The latter still controls execution.
        client = await createCodexApiClient(ctx, {
          allowOtherProviders: true,
        });
      } catch (error) {
        // Credential-resolution failures are terminal too. Suppress a stale
        // completion after a context switch or session shutdown.
        if (latestContext === ctx) showErrorStatus(ctx, error);
        return;
      }
      if (!accountObserverActive || latestContext !== ctx) return;
      registerCodexCommands(ctx);
      const accountChanged = activateAccount(client.accountId, ctx);
      const resolved: ResolvedActiveClient = {
        accountChanged,
        accountId: client.accountId,
        client,
        revision: credentialRevision,
      };
      if (
        usageAvailable
        && config.usageStatus
        && (forceUsage || accountChanged || (currentState()?.snapshots.length ?? 0) === 0)
      ) {
        try {
          // Reuse the client resolved above. Resolving OAuth a second time after
          // showing syncing would create an unbounded pre-fetch stall window.
          await refreshResolvedUsage(ctx, resolved, true);
        } catch (error) {
          if (isCurrentResolution(ctx, resolved)) showErrorStatus(ctx, error);
        }
      } else {
        refreshStatus(ctx);
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

  const codexUsageCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
    description: "Refresh and show Codex subscription usage, plan, and rate limit redeems",
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
      try {
        const resolved = await resolveActiveClient(ctx, controller.getConfig());
        const state = accountState(resolved.accountId);
        const payload = await resolved.client.get<unknown>(
          REDEEM_CREDITS_PATH,
          usageFetchSignal(),
        );
        state.redeemCredits = parseCodexRedeemCredits(payload);
      } catch {
        // Redeem details are best-effort; the base usage message still shows.
      }
      const state = currentState();
      const message = formatCodexUsage(state?.snapshots ?? [], Date.now(), {
        account: state?.account,
        redeemCredits: state?.redeemCredits,
      });
      // Notify renders in dim; wrap the message in muted so the usage block is
      // slightly more visible. The embedded ANSI codes survive the notify path.
      ctx.ui.notify(ctx.ui.theme ? ctx.ui.theme.fg("muted", message) : message, "info");
    },
  };

  const codexRedeemCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
    description: "Preview and redeem an earned Codex rate limit reset credit (confirmation required)",
    handler: async (_args, ctx) => {
      const config = controller.getConfig();
      if (ctx.model?.provider !== "openai-codex" && !config.allowOtherProviders) {
        ctx.ui.notify(
          "An active openai-codex model is required to redeem a rate limit reset. "
            + "Enable Other providers in /99settings to use the logged-in Codex subscription from another model.",
          "error",
        );
        return;
      }
      let resolved: Awaited<ReturnType<typeof resolveActiveClient>>;
      try {
        resolved = await resolveActiveClient(ctx, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to resolve the Codex subscription: ${message}`, "error");
        return;
      }
      const state = accountState(resolved.accountId);
      try {
        const payload = await resolved.client.get<unknown>(
          REDEEM_CREDITS_PATH,
          usageFetchSignal(),
        );
        const redeemCredits = parseCodexRedeemCredits(payload);
        state.redeemCredits = redeemCredits;
        const now = Date.now();
        if (!redeemCredits || redeemCredits.availableCount <= 0) {
          pendingRedeemByAccount.delete(resolved.accountId);
          ctx.ui.notify("No Codex rate limit reset credits are available to redeem.", "info");
          return;
        }
        const availableCredits = [...redeemCredits.credits]
          .filter((item) => item.status === undefined || item.status === "available")
          // Prefer the card that expires soonest, so near-expiry credits are used first.
          .sort((left, right) => (left.expiresAt ?? Number.POSITIVE_INFINITY) - (right.expiresAt ?? Number.POSITIVE_INFINITY));
        const credit = availableCredits[0] ?? redeemCredits.credits[0];
        const expiryOf = (item: CodexRedeemCredit | undefined): string =>
          item?.expiresAt !== undefined && item.expiresAt > now
            ? ` (expires ${formatDateTime(item.expiresAt)})`
            : "";
        let selected = credit;

        if (ctx.hasUI) {
          // 1) Pick a card when more than one is available.
          if (availableCredits.length > 1) {
            const options = availableCredits.map((item) => `${item.title ?? "reset credit"}${expiryOf(item)}`);
            const choice = await ctx.ui.select("Select a reset credit to redeem", options, {
              timeout: REDEEM_DIALOG_TIMEOUT_MS,
            });
            if (choice === undefined) {
              pendingRedeemByAccount.delete(resolved.accountId);
              ctx.ui.notify("Redeem cancelled — no reset credit was consumed.", "info");
              return;
            }
            const index = options.indexOf(choice);
            selected = availableCredits[index] ?? credit;
          }
          // 2) Confirm the selection before redeeming. "No" is listed first so
          // a stray Enter on the default-selected row cancels instead of redeeming.
          const confirmOptions = ["No", "Yes"];
          const choice = await ctx.ui.select(
            `Redeem ${selected?.title ?? "Full reset"}${expiryOf(selected)}?`,
            confirmOptions,
            { timeout: REDEEM_DIALOG_TIMEOUT_MS },
          );
          if (choice !== confirmOptions[1]) {
            pendingRedeemByAccount.delete(resolved.accountId);
            ctx.ui.notify("Redeem cancelled — no reset credit was consumed.", "info");
            return;
          }
        }

        // Reuse an in-flight redeem_request_id while it is still valid, so a
        // retry after a network failure cannot consume a second credit.
        const targetId = selected?.id;
        const existing = pendingRedeemByAccount.get(resolved.accountId);
        const pending = existing && existing.expiresAt > now && existing.creditId === targetId
          ? existing
          : {
              redeemRequestId: crypto.randomUUID(),
              creditId: targetId,
              expiresAt: now + REDEEM_CONFIRM_WINDOW_MS,
            };
        pendingRedeemByAccount.set(resolved.accountId, pending);

        if (!ctx.hasUI && (!existing || existing.expiresAt <= now || existing.creditId !== targetId)) {
          // No dialog UI: preview now and require a second run within the window.
          ctx.ui.notify(
            `${redeemCredits.availableCount} rate limit reset redeem available: ${credit?.title ?? "Full reset"}${expiryOf(credit)}. `
              + `Run /codex-redeem again within ${REDEEM_CONFIRM_WINDOW_MS / 1000}s to confirm.`,
            "warning",
          );
          return;
        }

        try {
          await resolved.client.post<unknown>(REDEEM_PATH, {
            redeem_request_id: pending.redeemRequestId,
            credit_id: pending.creditId,
          }, usageFetchSignal());
          pendingRedeemByAccount.delete(resolved.accountId);
          try {
            await refreshUsage(ctx, true);
          } catch {
            // The redeem succeeded; usage refresh is best-effort.
          }
          const status = formatCodexStatus(currentState()?.snapshots ?? [], config.fastMode);
          ctx.ui.notify(
            `✓ Rate limit reset redeemed — usage reset.${status ? `\n${status}` : ""}`,
            "info",
          );
        } catch (error) {
          // Keep the redeem_request_id so a retry stays idempotent.
          pending.expiresAt = Date.now() + REDEEM_RETRY_WINDOW_MS;
          pendingRedeemByAccount.set(resolved.accountId, pending);
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(
            `Failed to redeem a rate limit reset: ${message}. `
              + "Run /codex-redeem again to retry with the same request ID.",
            "error",
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to redeem a rate limit reset: ${message}`, "error");
      }
    },
  };

  let commandsRegistered = false;
  const registerCodexCommands = (ctx?: ExtensionContext): void => {
    if (commandsRegistered) return;
    commandsRegistered = true;
    pi.registerCommand("codex-usage", codexUsageCommand);
    pi.registerCommand("codex-redeem", codexRedeemCommand);

    // Refresh interactive autocomplete when login happens after startup.
    ctx?.ui.addAutocompleteProvider?.((current) => current);
  };

  if (options.registerCommandsImmediately) registerCodexCommands();

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

  pi.on("model_select", async (_event, ctx) => {
    startAccountObserver(ctx);
    await checkCurrentAccount(ctx, true).catch(() => {});
    startPolling(ctx);
  });
  pi.on("session_start", async (_event, ctx) => {
    startAccountObserver(ctx);
    await checkCurrentAccount(ctx, true).catch(() => {});
    startPolling(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stopPolling();
    stopCountdown();
    credentialRevision += 1;
    activeAccountId = undefined;
    usageByAccount.clear();
    pendingRedeemByAccount.clear();
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
