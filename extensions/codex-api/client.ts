import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

export type CodexFetch = typeof fetch;

export interface CodexApiClientOptions {
  accessToken: string;
  accountId: string;
  modelId?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: CodexFetch;
}

export class CodexApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "CodexApiError";
    this.status = status;
    this.body = body;
  }
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  const normalized = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === normalized)?.[1];
}

export function extractCodexAccountId(accessToken: string): string {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) throw new Error("not a JWT");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      [CODEX_AUTH_CLAIM]?: { chatgpt_account_id?: unknown };
    };
    const accountId = payload[CODEX_AUTH_CLAIM]?.chatgpt_account_id;
    if (typeof accountId !== "string" || accountId.length === 0) throw new Error("missing claim");
    return accountId;
  } catch {
    throw new Error("Failed to extract ChatGPT account ID from Codex OAuth token");
  }
}

export function resolveCodexApiRoot(baseUrl = DEFAULT_CODEX_BASE_URL): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized.slice(0, -"/responses".length);
  if (normalized.endsWith("/codex")) return normalized;
  return `${normalized}/codex`;
}

function errorMessage(status: number, statusText: string, body: unknown): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof body === "string" && body.trim()) return body.trim();
  return `Codex API request failed with HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function transportErrorCode(error: unknown): string | undefined {
  const values = [
    error,
    error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined,
  ];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_-]+$/.test(code)) return code;
  }
  return undefined;
}

function transportError(method: string, endpoint: string, error: unknown): CodexApiError {
  const path = new URL(endpoint).pathname;
  const code = transportErrorCode(error);
  return new CodexApiError(
    0,
    `Codex network request failed before a response: ${method} ${path}${code ? ` (${code})` : ""}. `
      + "No HTTP status was received, so a generation may or may not have reached ChatGPT. "
      + "Automatic retry was not attempted.",
  );
}

export class CodexApiClient {
  readonly rootUrl: string;
  readonly modelId?: string;
  /** ChatGPT account identity used only for in-memory account-scoped state. */
  readonly accountId: string;
  private readonly accessToken: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: CodexFetch;

  constructor(options: CodexApiClientOptions) {
    this.rootUrl = resolveCodexApiRoot(options.baseUrl);
    this.modelId = options.modelId;
    this.accessToken = options.accessToken;
    this.accountId = options.accountId;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? fetch;
  }

  private endpoint(path: string): string {
    const root = new URL(`${this.rootUrl}/`);
    const endpoint = new URL(path.replace(/^\/+/, ""), root);
    if (endpoint.protocol !== "https:" || endpoint.hostname !== "chatgpt.com" || endpoint.origin !== root.origin) {
      throw new Error(`Refusing to send Codex OAuth credentials to non-ChatGPT endpoint: ${endpoint.origin}`);
    }
    return endpoint.toString();
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = new Headers(this.headers);
    headers.set("authorization", `Bearer ${this.accessToken}`);
    headers.set("chatgpt-account-id", this.accountId);
    headers.set("originator", "pi");
    headers.set("accept", "application/json");
    if (body !== undefined) headers.set("content-type", "application/json");

    const endpoint = this.endpoint(path);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw transportError(method, endpoint, error);
    }
    const parsed = await responseBody(response);
    if (!response.ok) {
      throw new CodexApiError(
        response.status,
        errorMessage(response.status, response.statusText, parsed),
        parsed,
      );
    }
    return parsed as T;
  }

  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>("GET", path, undefined, signal);
  }

  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>("POST", path, body, signal);
  }
}

export interface CodexApiClientContextOptions {
  /** Allow a non-Codex active model to use separately stored Codex OAuth. */
  allowOtherProviders?: boolean;
}

function codexOAuthUnavailable(message?: string): Error {
  return new Error(
    `Codex subscription OAuth is unavailable${message ? `: ${message}` : ""}. `
      + "Run /login and sign in to openai-codex, then retry.",
  );
}

function resolveCodexAuthModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  allowOtherProviders: boolean,
) {
  if (ctx.model?.provider === "openai-codex") return ctx.model;
  if (!allowOtherProviders) {
    throw new Error(
      "Codex API tools require an active openai-codex model. "
        + "Enable Other providers in /99settings to use them from another model.",
    );
  }
  const model = ctx.modelRegistry.getAll().find((candidate) =>
    candidate.provider === "openai-codex" && ctx.modelRegistry.isUsingOAuth(candidate)
  );
  if (!model) throw codexOAuthUnavailable();
  return model;
}

export async function createCodexApiClient(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  optionsOrFetch: CodexApiClientContextOptions | CodexFetch = {},
  fetchImpl?: CodexFetch,
): Promise<CodexApiClient> {
  // Keep the former (ctx, fetch) call shape usable for extension consumers.
  const options = typeof optionsOrFetch === "function" ? {} : optionsOrFetch;
  const effectiveFetch = typeof optionsOrFetch === "function" ? optionsOrFetch : fetchImpl;
  const model = resolveCodexAuthModel(ctx, options.allowOtherProviders === true);
  if (!ctx.modelRegistry.isUsingOAuth(model)) {
    throw codexOAuthUnavailable("API-key authentication is not supported");
  }
  const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!resolved.ok) throw codexOAuthUnavailable(resolved.error);
  if (!resolved.apiKey) throw codexOAuthUnavailable();
  const accountId = headerValue(resolved.headers, "chatgpt-account-id")
    ?? extractCodexAccountId(resolved.apiKey);
  const baseUrl = model.baseUrl ?? DEFAULT_CODEX_BASE_URL;
  const endpoint = new URL(resolveCodexApiRoot(baseUrl));
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "chatgpt.com") {
    throw new Error(`Refusing to send Codex OAuth credentials to non-ChatGPT endpoint: ${endpoint.origin}`);
  }
  return new CodexApiClient({
    accessToken: resolved.apiKey,
    accountId,
    modelId: model.id,
    baseUrl,
    headers: resolved.headers,
    fetch: effectiveFetch,
  });
}
