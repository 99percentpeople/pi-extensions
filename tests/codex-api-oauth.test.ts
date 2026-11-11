import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore, type AssistantMessage, type Model, type Api } from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  CodexApiClient,
  CodexOAuthError,
  completeCodexAsk,
  createCodexApiClient,
  DEFAULT_CODEX_API_CONFIG,
  registerCodexAskTool,
  registerCodexImageTool,
  registerCodexSearchTool,
  registerCodexUsageAndFast,
  resolveCodexAskModel,
  resolveOfficialCodexAskModel,
  type CodexTextModel,
} from "../extensions/codex-api/index.ts";

function subscriptionModel(provider: "openai" | "openai-codex" = "openai", id = "gpt-test"): CodexTextModel {
  return {
    id,
    name: id,
    provider,
    api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
    baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
    reasoning: true,
    thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high", xhigh: null, max: null },
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function legacyToken(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-legacy-test" },
  })}.test-signature`;
}

function fixture(options: {
  active?: Model<Api>;
  models?: Model<Api>[];
  oauthProviders?: string[];
} = {}): any {
  const active = options.active ?? subscriptionModel();
  const models = options.models ?? [active];
  const oauth = new Set(options.oauthProviders ?? ["openai", "openai-codex"]);
  return {
    cwd: "/local/workspace",
    model: active,
    modelRegistry: {
      getAll: () => models,
      isUsingOAuth: (model: Model<Api>) => oauth.has(model.provider),
      getApiKeyAndHeaders: async (model: Model<Api>) => ({
        ok: true,
        apiKey: model.provider === "openai-codex" ? legacyToken() : "test-openai-oauth-access",
      }),
      complete: async () => { throw new Error("Unexpected completion"); },
    },
    sessionManager: {
      getSessionId: () => "test-session",
      buildContextEntries: () => [],
    },
  };
}

function captureTool(
  register: (pi: ExtensionAPI) => void,
  settings: { defaultProvider?: string; defaultModel?: string } = {},
): ToolDefinition {
  let tool: ToolDefinition | undefined;
  const events = new EventEmitter();
  register({
    registerTool: (value: ToolDefinition) => { tool = value; },
    getSettings: () => settings,
    on: () => {},
    events: {
      on: (name: string, handler: (value: unknown) => void) => {
        events.on(name, handler);
        return () => events.off(name, handler);
      },
      emit: (name: string, value: unknown) => events.emit(name, value),
    },
  } as unknown as ExtensionAPI);
  assert.ok(tool);
  return tool;
}

function answer(model: CodexTextModel, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: "A standalone test answer." }],
    timestamp: Date.now(),
    stopReason: "stop",
    usage: {
      input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  };
}

const standaloneContext = {
  messages: [{ role: "user" as const, content: "A standalone test request.", timestamp: 0 }],
};

test("codex_ask selects OAuth models by provider and never treats an OpenAI API key as a subscription", () => {
  const native = subscriptionModel();
  const legacy = subscriptionModel("openai-codex");
  const ctx = fixture({ active: native, models: [legacy, native] });
  assert.equal(resolveCodexAskModel(ctx, false), native);
  assert.equal(resolveCodexAskModel(ctx, false, "gpt-test"), native);
  assert.equal(resolveCodexAskModel(ctx, false, "openai/gpt-test"), native);
  assert.equal(resolveCodexAskModel(ctx, false, "openai-codex/gpt-test"), legacy);
  ctx.model = legacy;
  assert.equal(resolveCodexAskModel(ctx, false, "gpt-test"), legacy);
  assert.equal(resolveCodexAskModel(ctx, false, "openai/gpt-test"), native);

  const keyOnly = fixture({ active: native, models: [native], oauthProviders: [] });
  assert.throws(() => resolveCodexAskModel(keyOnly, false), /ChatGPT OAuth.*Other providers/);
  assert.throws(() => resolveCodexAskModel(keyOnly, true), /Sign in with ChatGPT.*API-key logins are not supported/);
  assert.throws(() => resolveCodexAskModel(keyOnly, true, "openai/gpt-test"), /unavailable or not logged in/);

  const legacyOnly = fixture({ active: native, models: [native, legacy], oauthProviders: ["openai-codex"] });
  assert.throws(() => resolveCodexAskModel(legacyOnly, false), /Other providers/);
  assert.equal(resolveCodexAskModel(legacyOnly, true), legacy);
  assert.throws(() => resolveCodexAskModel(legacyOnly, true, "openai/gpt-test"), /unavailable or not logged in/);
});

test("modern OAuth default selection uses the active or saved model without calling the legacy catalog", async () => {
  const native = subscriptionModel();
  const saved = subscriptionModel("openai", "gpt-saved-test");
  const legacy = subscriptionModel("openai-codex");
  const ctx = fixture({ active: native, models: [legacy, native, saved] });
  const noCatalog = async () => { throw new Error("Must not request the legacy catalog for modern OAuth"); };
  assert.equal(await resolveOfficialCodexAskModel(ctx, false, undefined, undefined, noCatalog), native);
  // Active OAuth models may not yet appear in the registry snapshot.
  ctx.modelRegistry.getAll = () => [saved];
  assert.equal(resolveCodexAskModel(ctx, false), native);

  ctx.model = { ...native, provider: "anthropic", api: "anthropic-messages" };
  ctx.modelRegistry.getAll = () => [legacy, native, saved];
  assert.throws(() => resolveCodexAskModel(ctx, false, saved.id), /Other providers/);
  assert.equal(
    await resolveOfficialCodexAskModel(ctx, true, undefined, undefined, noCatalog, saved.id),
    saved,
  );
  assert.equal(await resolveOfficialCodexAskModel(ctx, true, "openai/gpt-test", undefined, noCatalog), native);
  assert.throws(() => resolveCodexAskModel(ctx, true, undefined, "missing-saved-model"), /default OpenAI model.*unavailable/);
  assert.equal(await resolveOfficialCodexAskModel(ctx, true, undefined, undefined, async () => Response.json({
    models: [{ slug: legacy.id, priority: 1, visibility: "list" }],
  })), legacy, "legacy catalog defaults stay provider-qualified even when modern models have the same ID");

  ctx.modelRegistry.getAll = () => [native, saved];
  await assert.rejects(
    () => resolveOfficialCodexAskModel(ctx, true, undefined, undefined, noCatalog),
    /no default OpenAI model.*specify model/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    () => resolveOfficialCodexAskModel(ctx, true, "openai/gpt-test", abort.signal, noCatalog),
    { name: "AbortError" },
  );
});

test("legacy backend clients use only separate legacy credentials even under an active modern OAuth model", async () => {
  const native = subscriptionModel();
  const legacy = subscriptionModel("openai-codex");
  const ctx = fixture({ active: native, models: [native, legacy] });
  const resolvedProviders: string[] = [];
  ctx.modelRegistry.getApiKeyAndHeaders = async (model: Model<Api>) => {
    resolvedProviders.push(model.provider);
    assert.equal(model.provider, "openai-codex");
    return { ok: true, apiKey: legacyToken(), baseUrl: "https://chatgpt.com/backend-api/codex/responses" };
  };
  const client = await createCodexApiClient(ctx, {}, async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(request.headers.get("authorization"), `Bearer ${legacyToken()}`);
    assert.equal(request.headers.get("chatgpt-account-id"), "acct-legacy-test");
    return Response.json({ rate_limit: {} });
  });
  assert.equal(client.rootUrl, "https://chatgpt.com/backend-api/codex");
  await client.get("../wham/usage");
  assert.deepEqual(resolvedProviders, ["openai-codex"]);

  ctx.modelRegistry.getAll = () => [native];
  await assert.rejects(() => createCodexApiClient(ctx), (error: unknown) => {
    assert.ok(error instanceof CodexOAuthError);
    assert.match(error.message, /\/login openai-codex.*separate legacy login.*\/login openai supports codex_ask/);
    return true;
  });
  assert.deepEqual(resolvedProviders, ["openai-codex"], "never resolve the newer OpenAI token for a legacy endpoint");
});

test("search and images report missing legacy OAuth before making any backend request", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-codex-oauth-tools-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const requests = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  const ctx = fixture({ oauthProviders: ["openai"] });
  ctx.cwd = temporary;
  const search = captureTool((pi) => registerCodexSearchTool(pi, () => DEFAULT_CODEX_API_CONFIG));
  const image = captureTool((pi) => registerCodexImageTool(pi, () => DEFAULT_CODEX_API_CONFIG));
  await assert.rejects(
    () => search.execute("search-test", { search_query: [{ q: "test query" }] }, undefined, undefined, ctx),
    /separate legacy login/,
  );
  await assert.rejects(
    () => image.execute("image-test", { prompt: "test", output_path: join(temporary, "unused.png") }, undefined, undefined, ctx),
    /separate legacy login/,
  );
  assert.equal(requests.mock.callCount(), 0);
});

test("nullable provider headers delete defaults case-insensitively while retaining mandatory legacy authentication", async () => {
  const ctx = fixture({ active: subscriptionModel("openai-codex") });
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({
    ok: true,
    apiKey: legacyToken(),
    headers: {
      Originator: "overridden",
      ORIGINATOR: null,
      ACCEPT: null,
      "Content-Type": null,
      "X-Removed": null,
      "X-Keep": "kept",
      Authorization: "Bearer sk-test-not-a-real-key",
      "ChatGPT-Account-ID": null,
    },
  });
  const client = await createCodexApiClient(ctx, async (input, init) => {
    const request = new Request(input, init);
    for (const name of ["originator", "accept", "x-removed"]) assert.equal(request.headers.has(name), false);
    // Fetch supplies its own text/plain default for a string body; our supplied
    // headers must still omit Content-Type rather than serializing null.
    assert.equal(new Headers(init?.headers).has("content-type"), false);
    assert.equal(request.headers.get("x-keep"), "kept");
    assert.equal(request.headers.get("authorization"), `Bearer ${legacyToken()}`);
    assert.equal(request.headers.get("chatgpt-account-id"), "acct-legacy-test");
    assert.ok([...request.headers.values()].every((value) => value !== "null"));
    assert.equal(init?.redirect, "error");
    return Response.json({ ok: true });
  });
  assert.deepEqual(await client.post("responses", { model: "gpt-test" }), { ok: true });
  assert.equal(client.accountId, "acct-legacy-test");
});

test("resolved auth base URLs and direct clients reject insecure origins and URL credentials", async () => {
  const ctx = fixture({ active: subscriptionModel("openai-codex") });
  let requests = 0;
  const noNetwork = async () => { requests += 1; return Response.json({}); };
  const userinfo = new URL("https://chatgpt.com/backend-api");
  userinfo.username = "test-user";
  userinfo.password = "test-password";
  for (const baseUrl of [
    "https://api.openai.com/v1",
    "http://chatgpt.com/backend-api",
    "https://chatgpt.com:8443/backend-api",
    "https://chatgpt.com.example/backend-api",
    userinfo.toString(),
  ]) {
    ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: legacyToken(), baseUrl });
    await assert.rejects(() => createCodexApiClient(ctx, noNetwork), /Refusing to send Codex OAuth credentials/);
    const direct = new CodexApiClient({ accessToken: legacyToken(), accountId: "test", baseUrl, fetch: noNetwork });
    await assert.rejects(() => direct.get("models"), /Refusing to send Codex OAuth credentials/);
  }
  const client = new CodexApiClient({ accessToken: legacyToken(), accountId: "test", fetch: noNetwork });
  await assert.rejects(() => client.get("https://outside.example/path"), /Refusing to send Codex OAuth credentials/);
  assert.equal(requests, 0);
});

test("modern codex_ask applies native Responses options and preserves payload hooks", async () => {
  const ctx = fixture();
  let options: any;
  let hookCalls = 0;
  ctx.modelRegistry.complete = async function (model: CodexTextModel, _context: unknown, supplied: unknown) {
    assert.equal(this, ctx.modelRegistry);
    assert.equal(model.provider, "openai");
    options = supplied;
    return answer(model);
  };
  const result = await completeCodexAsk(ctx, ctx.model, standaloneContext, {
    reasoningEffort: "none",
    reasoningSummary: "off",
    textVerbosity: "high",
    serviceTier: "priority",
    cacheRetention: "none",
    onPayload: async (payload) => {
      hookCalls += 1;
      return { ...(payload as object), text: { format: "plain", custom: "preserved" } };
    },
  });
  assert.equal(result.provider, "openai");
  assert.equal(options.reasoningEffort, undefined);
  assert.equal(options.reasoningSummary, null);
  assert.equal("textVerbosity" in options, false);
  assert.equal(options.serviceTier, "priority");
  assert.equal(options.cacheRetention, "none");
  assert.equal(options.apiKey, undefined, "authentication remains inside Pi's registry");
  assert.deepEqual(await options.onPayload({ model: "gpt-test" }, ctx.model), {
    model: "gpt-test", text: { format: "plain", custom: "preserved", verbosity: "high" },
  });
  assert.equal(hookCalls, 1);

  await completeCodexAsk(ctx, ctx.model, standaloneContext, {
    reasoningEffort: "none", reasoningSummary: "auto",
  });
  assert.equal(options.reasoningEffort, undefined);
  assert.equal(options.reasoningSummary, null, "a summary must not silently re-enable reasoning after Off");

  await completeCodexAsk(ctx, ctx.model, standaloneContext, {
    reasoningEffort: "high",
    reasoningSummary: "on",
    onPayload: async (payload: any) => { payload.changed = true; },
  });
  const payload = { model: "gpt-test", text: { format: "plain" } };
  assert.equal(options.reasoningEffort, "high");
  assert.equal(options.reasoningSummary, "auto");
  assert.equal(await options.onPayload(payload, ctx.model), payload);
  assert.equal((payload as any).changed, true);
});

test("codex_ask rejects lost OAuth and blocks actual API keys at the final HTTP boundary", async () => {
  const ctx = fixture();
  let options: any;
  let completions = 0;
  let requests = 0;
  ctx.modelRegistry.complete = async (_model: CodexTextModel, _context: unknown, supplied: unknown) => {
    completions += 1;
    options = supplied;
    return answer(ctx.model);
  };
  let usingOAuth = false;
  ctx.modelRegistry.isUsingOAuth = () => usingOAuth;
  await assert.rejects(() => completeCodexAsk(ctx, ctx.model, standaloneContext, {}), /API-key fallback is not allowed/);
  assert.equal(completions, 0);

  usingOAuth = true;
  await completeCodexAsk(ctx, ctx.model, standaloneContext, {
    fetch: async () => { requests += 1; return Response.json({}); },
  });
  for (const authorization of [undefined, "Bearer sk-test-not-a-real-key"]) {
    await assert.rejects(
      () => options.fetch("https://api.openai.com/v1/responses", { headers: authorization ? { authorization } : {} }),
      /API-key fallback is not allowed/,
    );
  }
  assert.equal(requests, 0, "a stale OAuth snapshot must not allow an API-key request");
  await options.fetch(new Request("https://api.openai.com/v1/responses", {
    headers: { authorization: "Bearer test-openai-oauth-access" },
  }));
  assert.equal(requests, 1);
  usingOAuth = false;
  await assert.rejects(() => options.onPayload({}, ctx.model), /API-key fallback is not allowed/);
  await assert.rejects(
    () => options.fetch("https://api.openai.com/v1/responses", { headers: { authorization: "Bearer test-openai-oauth-access" } }),
    /API-key fallback is not allowed/,
  );
  assert.equal(requests, 1);
});

test("modern codex_ask uses Pi's saved OpenAI default, attaches vision input, and never refreshes legacy usage", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-codex-modern-ask-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await writeFile(join(temporary, "diagram.png"), Buffer.from("mock image bytes"));
  const native = subscriptionModel("openai", "gpt-saved-test");
  const ctx = fixture({ active: { ...native, provider: "anthropic" }, models: [native], oauthProviders: ["openai"] });
  ctx.cwd = temporary;
  let completion: any;
  let usageRefreshes = 0;
  ctx.modelRegistry.complete = async (model: CodexTextModel, context: unknown, options: unknown) => {
    completion = { model, context, options };
    return answer(model);
  };
  const config = { ...DEFAULT_CODEX_API_CONFIG, askEnabled: true, allowOtherProviders: true, fastMode: true, responseVerbosity: "medium" as const };
  const tool = captureTool(
    (pi) => registerCodexAskTool(pi, () => config, () => { usageRefreshes += 1; }),
    { defaultProvider: "openai", defaultModel: native.id },
  );
  const updates: any[] = [];
  const result = await tool.execute("ask-modern", {
    prompt: "Review only this test image.", image_paths: ["diagram.png"], reasoning: "high",
  }, undefined, (update) => updates.push(update), ctx);
  assert.equal(completion.model, native);
  assert.equal(completion.options.reasoningEffort, "high");
  assert.equal(completion.options.serviceTier, "priority");
  assert.equal(completion.options.cacheRetention, "none");
  assert.equal(completion.options.maxTokens, 8192);
  assert.equal(completion.context.messages.length, 1);
  assert.deepEqual(completion.context.messages[0].content, [
    { type: "text", text: "Review only this test image." },
    { type: "image", mimeType: "image/png", data: Buffer.from("mock image bytes").toString("base64") },
  ]);
  assert.deepEqual(await completion.options.onPayload({ text: { format: "plain" } }, native), {
    text: { format: "plain", verbosity: "medium" },
  });
  assert.deepEqual(updates.map((update) => update.details.phase), ["selecting-model", "reading-images", "asking"]);
  assert.equal((result.details as any).provider, "openai");
  assert.equal((result.details as any).imageCount, 1);
  assert.equal(result.usage?.totalTokens, 15);
  assert.equal(usageRefreshes, 0);
  assert.doesNotMatch(JSON.stringify(result), /test-openai-oauth-access|test-signature|Review only this test image/);
});

test("modern codex_ask rejects unsupported reasoning, text-only vision, and aborted completions", async () => {
  const ctx = fixture();
  let completions = 0;
  ctx.modelRegistry.complete = async () => { completions += 1; return answer(ctx.model, { stopReason: "aborted" }); };
  const tool = captureTool((pi) => registerCodexAskTool(pi, () => ({ ...DEFAULT_CODEX_API_CONFIG, askEnabled: true })));
  await assert.rejects(
    () => tool.execute("unsupported", { prompt: "test", reasoning: "xhigh" }, undefined, undefined, ctx),
    /does not support xhigh reasoning/,
  );
  ctx.model = { ...ctx.model, thinkingLevelMap: { off: null } };
  ctx.modelRegistry.getAll = () => [ctx.model];
  await assert.rejects(
    () => tool.execute("unsupported-off", { prompt: "test", reasoning: "off" }, undefined, undefined, ctx),
    /does not support off reasoning/,
  );
  ctx.model = { ...ctx.model, reasoning: false, input: ["text"] };
  await assert.rejects(
    () => tool.execute("unsupported-reasoning", { prompt: "test", reasoning: "high" }, undefined, undefined, ctx),
    /does not support reasoning controls/,
  );
  ctx.sessionManager.buildContextEntries = () => [{ type: "message", message: {
    role: "user", content: [{ type: "image", mimeType: "image/png", data: "dGVzdA==" }],
  } }];
  await assert.rejects(
    () => tool.execute("unsupported-vision", { prompt: "test", num_last_images_to_include: 1 }, undefined, undefined, ctx),
    /does not accept image input/,
  );
  assert.equal(completions, 0);
  await assert.rejects(
    () => tool.execute("aborted-answer", { prompt: "test" }, undefined, undefined, ctx),
    /Codex answer aborted/,
  );
  assert.equal(completions, 1);
  ctx.modelRegistry.complete = async () => answer(ctx.model, { stopReason: "length" });
  const limited = await tool.execute("limited-answer", { prompt: "test" }, undefined, undefined, ctx);
  assert.match((limited.content[0] as any).text, /stopped at an output limit/);
  assert.doesNotMatch((limited.content[0] as any).text, /configured output limit/);
});

test("Fast/detail hooks cover modern and legacy subscriptions, not API-key or third-party traffic", async (t) => {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const handle = registerCodexUsageAndFast({
    registerCommand: () => {},
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => handlers.set(name, handler),
  } as unknown as ExtensionAPI, {
    getConfig: () => ({ ...DEFAULT_CODEX_API_CONFIG, fastMode: true, responseVerbosity: "high", usageStatus: true }),
    updateConfig: () => {},
  });
  t.after(() => handlers.get("session_shutdown")?.({}, fixture()));
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected legacy usage request"); });
  const ctx = fixture();
  const payload = { model: ctx.model.id, text: { format: "plain" }, input: [] };
  assert.deepEqual(await handlers.get("before_provider_request")?.({ payload }, ctx), {
    ...payload, service_tier: "priority", text: { format: "plain", verbosity: "high" },
  });
  assert.deepEqual(payload.text, { format: "plain" }, "hooks do not mutate the provider's original object");
  await handlers.get("after_provider_response")?.({ headers: {
    "x-codex-primary-used-percent": "10",
  } }, ctx);
  assert.deepEqual(handle.getSnapshots(), [], "modern response headers cannot masquerade as legacy quota");
  assert.equal(network.mock.callCount(), 0, "normal modern replies never start legacy quota polling");
  ctx.modelRegistry.isUsingOAuth = () => false;
  assert.equal(await handlers.get("before_provider_request")?.({ payload }, ctx), undefined);
  ctx.model = { ...ctx.model, provider: "anthropic" };
  ctx.modelRegistry.isUsingOAuth = () => true;
  assert.equal(await handlers.get("before_provider_request")?.({ payload }, ctx), undefined);
});

test("modern-only OAuth keeps legacy commands/status hidden; adding legacy auth enables only its own usage", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-codex-auth-status-"));
  const authPath = join(temporary, "auth.json");
  await writeFile(authPath, "{}");
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const commands = new Map<string, any>();
  const handle = registerCodexUsageAndFast({
    registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => handlers.set(name, handler),
  } as unknown as ExtensionAPI, {
    getConfig: () => ({ ...DEFAULT_CODEX_API_CONFIG, usageStatus: true, usagePollInterval: 0 }),
    updateConfig: () => {},
  }, { authPath });
  const ctx = fixture({ oauthProviders: ["openai"] });
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];
  ctx.ui = {
    setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    notify: (value: string) => notices.push(value),
    theme: { fg: (_color: string, value: string) => value },
    addAutocompleteProvider: () => {},
  };
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    await rm(temporary, { recursive: true, force: true });
  });
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.url);
    assert.equal(request.headers.get("authorization"), `Bearer ${legacyToken()}`);
    return Response.json({ rate_limit: { primary_window: {
      used_percent: 20, limit_window_seconds: 18000,
    } } });
  });
  await handlers.get("session_start")?.({}, ctx);
  assert.equal(commands.size, 0);
  assert.ok(statuses.every((value) => value === undefined));
  assert.equal(requests.length, 0);
  await assert.rejects(() => handle.refreshUsage(ctx, true), /separate legacy login/);

  const legacy = subscriptionModel("openai-codex");
  ctx.modelRegistry.getAll = () => [ctx.model, legacy];
  ctx.modelRegistry.isUsingOAuth = () => true;
  await handlers.get("model_select")?.({}, ctx);
  assert.equal(commands.has("codex-usage"), true);
  assert.equal(commands.has("codex-redeem"), true);
  assert.ok(statuses.some((value) => value?.includes("Codex 5h 80%")));
  assert.ok(requests.length > 0);
  assert.ok(requests.every((url) => url === "https://chatgpt.com/backend-api/wham/usage"));

  ctx.modelRegistry.getAll = () => [ctx.model];
  ctx.modelRegistry.isUsingOAuth = (model: Model<Api>) => model.provider === "openai";
  await handlers.get("model_select")?.({}, ctx);
  await commands.get("codex-usage").handler("", ctx);
  assert.match(notices.at(-1) ?? "", /separate legacy login/);
  assert.equal(statuses.at(-1), undefined);
});

function responsesStream(model: string): Response {
  const item = {
    type: "message", id: "msg-test", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "A native SDK test answer.", annotations: [] }],
  };
  const events = [
    { type: "response.created", response: { id: "resp-test", model, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "A native SDK test answer." },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: {
      id: "resp-test", model, status: "completed", output: [item],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    } },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

test("Pi 1.5 real registry and Responses adapter send modern OAuth only to the public API (mock HTTP)", async (t) => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({
    type: "oauth", access: "test-direct-oauth-access", refresh: "test-unused-refresh",
    expires: Date.now() + 3600000, clientId: "test-client", scopes: ["chatgpt.tokens.use.direct"],
  }));
  const requests: Array<{ request: Request; body: any }> = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://api.openai.com/v1/responses");
    const body = await request.json();
    requests.push({ request, body });
    return responsesStream(body.model);
  });
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const model = registry.getAll().find((candidate) => candidate.provider === "openai"
    && candidate.api === "openai-responses" && candidate.reasoning
    && candidate.thinkingLevelMap?.high !== null && candidate.thinkingLevelMap?.off !== null
    && candidate.input.includes("image"));
  assert.ok(model);
  assert.equal(registry.isUsingOAuth(model), true);
  const ctx = fixture({ active: model });
  ctx.modelRegistry = registry;
  ctx.sessionManager.buildContextEntries = () => [{ type: "message", message: {
    role: "user", content: [{ type: "image", mimeType: "image/png", data: "dGVzdA==" }],
  } }];
  const tool = captureTool((pi) => registerCodexAskTool(pi, () => ({
    ...DEFAULT_CODEX_API_CONFIG, askEnabled: true, fastMode: true,
  })));
  const result = await tool.execute("sdk-test", {
    prompt: "Review the attached test image.", num_last_images_to_include: 1, reasoning: "high", verbosity: "high",
    max_output_tokens: 4096,
  }, undefined, undefined, ctx);
  assert.equal(requests.length, 1);
  const { request, body } = requests[0];
  assert.equal(request.headers.get("authorization"), "Bearer test-direct-oauth-access");
  assert.equal(request.headers.has("chatgpt-account-id"), false);
  assert.equal(body.model, model.id);
  assert.equal(body.service_tier, "priority");
  assert.equal(body.text.verbosity, "high");
  assert.equal(body.reasoning.effort, model.thinkingLevelMap?.high ?? "high");
  assert.equal(body.store, false);
  assert.equal(body.prompt_cache_key, undefined);
  assert.equal(body.max_output_tokens, undefined, "Pi omits unsupported token caps for ChatGPT sign-in");
  assert.ok(body.input.some((message: any) => Array.isArray(message.content)
    && message.content.some((part: any) => part.type === "input_image")));
  assert.deepEqual(result.content, [{ type: "text", text: "A native SDK test answer." }]);
  assert.equal(result.usage?.totalTokens, 15);
  assert.equal((result.details as any).provider, "openai");

  await tool.execute("sdk-off-test", {
    prompt: "Test explicit reasoning Off.", reasoning: "off", verbosity: "auto",
  }, undefined, undefined, ctx);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.reasoning.effort, model.thinkingLevelMap?.off ?? "none");
  assert.equal(requests[1].body.text, undefined, "Auto detail does not add a verbosity override");

  // Deliberately change the backing store without refreshing the OAuth snapshot.
  // The last-boundary guard must still prevent an actual paid API-key request.
  await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-test-not-a-real-key" }));
  assert.equal(registry.isUsingOAuth(model), true, "exercise a genuinely stale real-registry snapshot");
  await assert.rejects(
    () => completeCodexAsk(ctx, model as CodexTextModel, standaloneContext, { maxRetries: 0 }),
    /API-key fallback is not allowed/,
  );
  assert.equal(requests.length, 2, "no extra HTTP request and no API-key billing");
});
