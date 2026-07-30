import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  applyFastModePayload,
  CodexApiClient,
  CodexApiError,
  createCodexApiClient,
  createCodexSearchDisplay,
  DEFAULT_CODEX_API_CONFIG,
  extractCodexAccountId,
  formatCodexSearchDisplay,
  formatCodexStatus,
  formatCodexUsage,
  loadCodexApiConfig,
  normalizeCodexApiConfig,
  normalizeCodexImageSize,
  parseCodexRateLimits,
  parseCodexUsagePayload,
  registerCodexImageTool,
  registerCodexSearchTool,
  registerCodexUsageAndFast,
  resolveCodexApiRoot,
  resolveSearchMode,
  saveCodexApiConfig,
  SEARCH_MODE_LABELS,
} from "../extensions/codex-api/index.ts";

function jwt(accountId = "acct-123"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

function toolRegistry(register: (pi: ExtensionAPI) => void): ToolDefinition {
  let tool: ToolDefinition | undefined;
  register({
    registerTool: (value) => { tool = value; },
    on: () => {},
  } as unknown as ExtensionAPI);
  assert.ok(tool);
  return tool;
}

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const taggedTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
} as unknown as Theme;

function renderContext(expanded: boolean, overrides: Record<string, unknown> = {}): any {
  return {
    args: {},
    toolCallId: "render-call",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded,
    showImages: true,
    isError: false,
    ...overrides,
  };
}

function render(component: Component): string {
  return component.render(240).map((line) => line.trimEnd()).join("\n").trimEnd();
}

function context(cwd: string): ExtensionContext {
  const model = {
    id: "gpt-5.6",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
  };
  return {
    cwd,
    model,
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: jwt() }),
    },
    sessionManager: {
      getSessionId: () => "session-123",
      buildContextEntries: () => [],
    },
  } as unknown as ExtensionContext;
}

function otherProviderContext(cwd: string): ExtensionContext {
  const codexModel = {
    id: "gpt-5.6-codex",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
  };
  return {
    ...context(cwd),
    model: { id: "claude-test", provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: (model: { provider?: string }) => model.provider === "openai-codex",
      getAll: () => [codexModel],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: jwt() }),
    },
  } as unknown as ExtensionContext;
}

test("Codex client resolves OAuth account, roots, headers, and API errors", async () => {
  assert.equal(extractCodexAccountId(jwt()), "acct-123");
  assert.throws(() => extractCodexAccountId("not-a-token"), /account ID/);
  assert.equal(resolveCodexApiRoot(), "https://chatgpt.com/backend-api/codex");
  assert.equal(
    resolveCodexApiRoot("https://chatgpt.com/backend-api/codex/responses"),
    "https://chatgpt.com/backend-api/codex",
  );

  let request: { input: string; init?: RequestInit } | undefined;
  const client = new CodexApiClient({
    accessToken: "access-token",
    accountId: "acct-123",
    fetch: async (input, init) => {
      request = { input: String(input), init };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(await client.post("test", { value: 1 }), { ok: true });
  assert.equal(request?.input, "https://chatgpt.com/backend-api/codex/test");
  const headers = new Headers(request?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer access-token");
  assert.equal(headers.get("chatgpt-account-id"), "acct-123");
  assert.equal(headers.get("originator"), "pi");
  assert.equal(request?.init?.body, JSON.stringify({ value: 1 }));

  assert.deepEqual(await client.get("../wham/usage"), { ok: true });
  assert.equal(request?.input, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(request?.init?.method, "GET");
  assert.equal(request?.init?.body, undefined);
  assert.equal(new Headers(request?.init?.headers).get("content-type"), null);

  const failing = new CodexApiClient({
    accessToken: "access-token",
    accountId: "acct-123",
    fetch: async () => new Response(
      JSON.stringify({ error: { message: "feature unavailable" } }),
      { status: 403, statusText: "Forbidden" },
    ),
  });
  await assert.rejects(
    () => failing.post("test", {}),
    (error) => error instanceof CodexApiError
      && error.status === 403
      && error.message === "feature unavailable",
  );

  let transportAttempts = 0;
  const transportFailure = new CodexApiClient({
    accessToken: "access-token",
    accountId: "acct-123",
    fetch: async () => {
      transportAttempts += 1;
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNRESET", message: "Bearer secret-token" },
      });
    },
  });
  await assert.rejects(
    () => transportFailure.post("images/generations", { prompt: "test" }),
    (error) => {
      assert.ok(error instanceof CodexApiError);
      assert.equal(error.status, 0);
      assert.match(error.message, /POST \/backend-api\/codex\/images\/generations \(ECONNRESET\)/);
      assert.match(error.message, /No HTTP status was received/);
      assert.match(error.message, /Automatic retry was not attempted/);
      assert.doesNotMatch(error.message, /secret-token|fetch failed/);
      return true;
    },
  );
  assert.equal(transportAttempts, 1);

  const otherProvider = otherProviderContext(process.cwd());
  await assert.rejects(
    () => createCodexApiClient(otherProvider),
    /active openai-codex model.*Other providers/,
  );
  const crossProviderClient = await createCodexApiClient(otherProvider, { allowOtherProviders: true });
  assert.equal(crossProviderClient.modelId, "gpt-5.6-codex");

  const noCodexLogin = otherProviderContext(process.cwd()) as any;
  noCodexLogin.modelRegistry.getAll = () => [];
  await assert.rejects(
    () => createCodexApiClient(noCodexLogin, { allowOtherProviders: true }),
    /Codex subscription OAuth is unavailable.*Run \/login/,
  );

  const expiredCodex = context(process.cwd()) as any;
  expiredCodex.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "token refresh failed" });
  await assert.rejects(
    () => createCodexApiClient(expiredCodex),
    /Codex subscription OAuth is unavailable: token refresh failed.*Run \/login/,
  );
});

test("codex_image generates, edits, saves PNGs, and returns image content", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-codex-image-"));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png-data").toString("base64") }] }));
  };
  const refreshedContexts: ExtensionContext[] = [];
  const tool = toolRegistry((pi) => registerCodexImageTool(
    pi,
    () => ({ ...DEFAULT_CODEX_API_CONFIG, imageQuality: "medium" }),
    (ctx) => refreshedContexts.push(ctx),
  ));
  const imageProperties = (tool.parameters as any).properties;
  assert.deepEqual(Object.keys(imageProperties), [
    "prompt",
    "referenced_image_paths",
    "num_last_images_to_include",
    "size",
    "quality",
    "output_path",
  ]);
  assert.equal(imageProperties.model, undefined);
  assert.equal(imageProperties.background, undefined);
  assert.equal(imageProperties.n, undefined);
  assert.equal(imageProperties.output_format, undefined);
  try {
    const ctx = context(temporary);
    const generatedPath = join(temporary, "generated.png");
    const generatedUpdates: any[] = [];
    const generated = await tool.execute(
      "image-call-1",
      { prompt: "a red fox", output_path: generatedPath },
      undefined,
      (update) => generatedUpdates.push(update),
      ctx,
    );
    assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/images/generations");
    assert.equal(calls[0].body.model, "gpt-image-2");
    assert.equal(calls[0].body.background, "auto");
    assert.equal(calls[0].body.quality, "medium");
    assert.equal(calls[0].body.size, "auto");
    assert.equal(await readFile(generatedPath, "utf8"), "png-data");
    assert.deepEqual(generated.content[1], {
      type: "image",
      data: Buffer.from("png-data").toString("base64"),
      mimeType: "image/png",
    });
    assert.deepEqual(
      generatedUpdates.map((update) => update.details.phase),
      ["preparing", "authenticating", "generating", "saving"],
    );
    assert.equal(refreshedContexts.length, 1);
    assert.ok(generatedUpdates.every((update) => !("prompt" in update.details)));
    assert.ok(generated.details && !("prompt" in generated.details));

    const partialImageCall = tool.renderCall!(
      { prompt: "a red" },
      plainTheme,
      renderContext(false, {
        args: { prompt: "a red" },
        argsComplete: false,
        executionStarted: false,
        isPartial: true,
      }),
    );
    assert.match(render(partialImageCall), /codex_image generate "a red" …/);
    const startedImageCall = tool.renderCall!(
      { prompt: "a red" },
      plainTheme,
      renderContext(false, {
        args: { prompt: "a red" },
        argsComplete: false,
        executionStarted: true,
        isPartial: true,
      }),
    );
    assert.doesNotMatch(render(startedImageCall), / …$/);
    const completeImageArgs = { prompt: "a red fox", output_path: generatedPath };
    const completeImageCall = tool.renderCall!(
      completeImageArgs,
      plainTheme,
      renderContext(false, { args: completeImageArgs, argsComplete: true, lastComponent: partialImageCall }),
    );
    assert.equal(completeImageCall, partialImageCall);
    assert.match(render(completeImageCall), /"a red fox" output=/);
    assert.doesNotMatch(render(completeImageCall), /--output| …$/);
    const styledImageCall = tool.renderCall!(
      {
        prompt: "a red fox",
        referenced_image_paths: ["source.png", "texture.webp"],
        size: "1536x1024",
        quality: "high",
        output_path: "result.png",
      },
      taggedTheme,
      renderContext(false, {
        args: {
          prompt: "a red fox",
          referenced_image_paths: ["source.png", "texture.webp"],
          size: "1536x1024",
          quality: "high",
          output_path: "result.png",
        },
      }),
    );
    assert.match(
      render(styledImageCall),
      /<toolTitle>codex_image<\/toolTitle> <accent>edit<\/accent> <muted>"a red fox"<\/muted> <dim>references=\["source\.png", "texture\.webp"\]<\/dim> <dim>size=1536x1024<\/dim> <dim>quality=high<\/dim> <muted>output="result\.png"<\/muted>/,
    );

    const collapsedImage = render(tool.renderResult!(
      generated,
      { expanded: false, isPartial: false },
      plainTheme,
      renderContext(false),
    ));
    assert.match(collapsedImage, /Generated image saved to/);
    assert.doesNotMatch(collapsedImage, /Prompt:|a red fox/);
    const expandedImage = render(tool.renderResult!(
      generated,
      { expanded: true, isPartial: false },
      plainTheme,
      renderContext(true),
    ));
    assert.equal(expandedImage, collapsedImage);
    const partialImage = render(tool.renderResult!(
      generatedUpdates[2],
      { expanded: false, isPartial: true },
      plainTheme,
      renderContext(false, { isPartial: true }),
    ));
    assert.match(partialImage, /Waiting for Codex image generation/);

    const editedPath = join(temporary, "edited.png");
    const editedUpdates: any[] = [];
    await tool.execute(
      "image-call-2",
      {
        prompt: "add a blue hat",
        referenced_image_paths: [generatedPath],
        size: "1536x1024",
        quality: "high",
        output_path: editedPath,
      },
      undefined,
      (update) => editedUpdates.push(update),
      ctx,
    );
    assert.equal(calls[1].url, "https://chatgpt.com/backend-api/codex/images/edits");
    assert.deepEqual(
      editedUpdates.map((update) => update.details.phase),
      ["preparing", "authenticating", "reading-references", "generating", "saving"],
    );
    assert.match(calls[1].body.images[0].image_url, /^data:image\/png;base64,/);
    assert.equal(calls[1].body.size, "1536x1024");
    assert.equal(calls[1].body.quality, "high");
    assert.equal(refreshedContexts.length, 2);

    const recentPath = join(temporary, "recent-edit.png");
    const recentCtx = context(temporary) as any;
    recentCtx.sessionManager.buildContextEntries = () => [{
      type: "message",
      message: {
        role: "user",
        content: [{
          type: "image",
          data: Buffer.from("conversation-image").toString("base64"),
          mimeType: "image/jpeg",
        }],
      },
    }];
    await tool.execute(
      "image-call-3",
      {
        prompt: "edit the attached image",
        num_last_images_to_include: 1,
        output_path: recentPath,
      },
      undefined,
      undefined,
      recentCtx,
    );
    assert.equal(calls[2].url, "https://chatgpt.com/backend-api/codex/images/edits");
    assert.match(calls[2].body.images[0].image_url, /^data:image\/jpeg;base64,/);
    assert.equal(refreshedContexts.length, 3);

    const recentCall = tool.renderCall!(
      { prompt: "edit this", num_last_images_to_include: 1 },
      plainTheme,
      renderContext(false, { args: { prompt: "edit this", num_last_images_to_include: 1 } }),
    );
    assert.match(render(recentCall), /codex_image edit "edit this" recent=1/);
    await assert.rejects(
      () => tool.execute(
        "image-call-conflict",
        {
          prompt: "invalid edit",
          referenced_image_paths: [generatedPath],
          num_last_images_to_include: 1,
        },
        undefined,
        undefined,
        recentCtx,
      ),
      /Provide only one of referenced_image_paths or num_last_images_to_include/,
    );
    assert.equal(calls.length, 3);

    assert.equal(normalizeCodexImageSize("2048x1152"), "2048x1152");
    assert.equal(normalizeCodexImageSize(), "auto");
    assert.throws(() => normalizeCodexImageSize("1000x1000"), /divisible by 16/);
    assert.throws(() => normalizeCodexImageSize("4096x2048"), /must not exceed 3840px/);

    await assert.rejects(
      () => tool.execute(
        "image-call-4",
        { prompt: "overwrite", output_path: editedPath },
        undefined,
        undefined,
        ctx,
      ),
      /Refusing to overwrite/,
    );
    assert.equal(refreshedContexts.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("codex_search sends official commands and subscription search settings", async () => {
  const originalFetch = globalThis.fetch;
  initTheme("dark", false);
  let request: { url: string; body: any } | undefined;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({
      output: Array.from(
        { length: 10 },
        (_, index) => `Search result line ${index + 1}${index === 9 ? " [turn0search0]" : ""}`,
      ).join("\n"),
      results: Array.from({ length: 5 }, (_, index) => ({
        type: "text_result",
        ref_id: `turn0search${index}`,
        title: `Source ${index + 1}`,
        domain: `source${index + 1}.example`,
        url: `https://source${index + 1}.example/article`,
        snippet: index === 0
          ? "citeturn0search0 [wordlim: 200] Published: today; Crawled: today; Clean first snippet"
          : `Snippet ${index + 1}`,
      })),
    }));
  };
  let searchRefreshes = 0;
  const tool = toolRegistry((pi) => registerCodexSearchTool(
    pi,
    () => ({
      ...DEFAULT_CODEX_API_CONFIG,
      searchMode: "auto",
      searchContextSize: "high",
    }),
    () => { searchRefreshes += 1; },
  ));
  assert.ok(tool.parameters.properties?.search_mode);
  const searchGuidelines = tool.promptGuidelines?.join("\n") ?? "";
  assert.match(searchGuidelines, /search_mode.*cached.*indexed.*live.*Auto.*fixed user mode/i);
  assert.match(
    searchGuidelines,
    /same-day.*exact calendar date.*recency to 1.*freshness.*source-timezone/i,
  );
  try {
    const updates: any[] = [];
    const args = {
      search_query: [{ q: "Codex documentation", domains: ["openai.com"] }],
      search_mode: "live" as const,
    };
    const result = await tool.execute(
      "search-call",
      args,
      undefined,
      (update) => updates.push(update),
      context(process.cwd()),
    );
    assert.equal(request?.url, "https://chatgpt.com/backend-api/codex/alpha/search");
    assert.equal(request?.body.id, "session-123");
    assert.equal(request?.body.model, "gpt-5.6");
    assert.equal(request?.body.settings.external_web_access, true);
    assert.equal(request?.body.settings.search_context_size, "high");
    assert.equal(request?.body.commands.search_mode, undefined);
    assert.equal(result.details.mode, "live");
    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].type === "text" ? result.content[0].text : "", /turn0search0/);
    assert.deepEqual(
      updates.map((update) => update.details.phase),
      ["authenticating", "searching"],
    );
    assert.ok(updates.every((update) => !("operation" in update.details)));
    assert.ok(updates.every((update) => update.details.mode === "live"));
    assert.ok(result.details && !("operation" in result.details));
    assert.equal(searchRefreshes, 1);

    const partialArgs = { search_query: [{ q: "Codex doc" }] };
    const partialCallComponent = tool.renderCall!(
      partialArgs,
      plainTheme,
      renderContext(false, {
        args: partialArgs,
        argsComplete: false,
        executionStarted: false,
        isPartial: true,
      }),
    );
    assert.match(render(partialCallComponent), /codex_search search "Codex doc" mode=indexed …/);
    const startedSearchCall = tool.renderCall!(
      partialArgs,
      plainTheme,
      renderContext(false, {
        args: partialArgs,
        argsComplete: false,
        executionStarted: true,
        isPartial: true,
      }),
    );
    assert.doesNotMatch(render(startedSearchCall), / …$/);
    const completeCallComponent = tool.renderCall!(
      args,
      plainTheme,
      renderContext(false, { args, argsComplete: true, lastComponent: partialCallComponent }),
    );
    assert.equal(completeCallComponent, partialCallComponent);
    const collapsedCall = render(completeCallComponent);
    assert.match(collapsedCall, /codex_search search "Codex documentation" domains=openai.com mode=live/);
    assert.doesNotMatch(collapsedCall, / …$/);
    const restoredCompleteCall = tool.renderCall!(
      args,
      plainTheme,
      renderContext(false, {
        args,
        argsComplete: false,
        executionStarted: false,
        isPartial: false,
      }),
    );
    assert.doesNotMatch(
      render(restoredCompleteCall),
      / …$/,
      "a completed/restored result must not retain the argument-streaming suffix",
    );
    const styledSearchArgs = {
      search_query: [{ q: "Codex documentation", domains: ["openai.com"], recency: 7 }],
      response_length: "long",
      search_mode: "live" as const,
    };
    const styledSearchCall = tool.renderCall!(
      styledSearchArgs,
      taggedTheme,
      renderContext(false, { args: styledSearchArgs }),
    );
    assert.match(
      render(styledSearchCall),
      /<toolTitle>codex_search<\/toolTitle> <accent>search<\/accent> <muted>"Codex documentation"<\/muted> <dim>recent=7d domains=openai\.com<\/dim><dim> <\/dim><dim>response=long<\/dim><dim> <\/dim><dim>mode=live<\/dim>/,
    );
    const multiOpenArgs = {
      open: [
        { ref_id: "turn2reddit18" },
        { ref_id: "turn2search9" },
        { ref_id: "turn2search1" },
      ],
    };
    const multiOpenCall = render(tool.renderCall!(
      multiOpenArgs,
      taggedTheme,
      renderContext(false, { args: multiOpenArgs }),
    ));
    assert.match(
      multiOpenCall,
      /<toolTitle>codex_search<\/toolTitle> <accent>open<\/accent> <muted>turn2reddit18<\/muted><dim>\s*<\/dim><accent>open<\/accent> <muted>turn2search9<\/muted><dim>\s*<\/dim><accent>open<\/accent> <muted>turn2search1<\/muted><dim>\s*<\/dim><dim>mode=indexed<\/dim>/,
    );
    const multiSearchArgs = {
      search_query: [
        { q: "first query", recency: 1 },
        { q: "second query", domains: ["example.com"] },
      ],
    };
    const multiSearchCall = render(tool.renderCall!(
      multiSearchArgs,
      taggedTheme,
      renderContext(false, { args: multiSearchArgs }),
    ));
    assert.match(
      multiSearchCall,
      /<accent>search<\/accent> <muted>"first query"<\/muted> <dim>recent=1d<\/dim><dim>\s*<\/dim><accent>search<\/accent> <muted>"second query"<\/muted> <dim>domains=example\.com<\/dim>/,
    );
    const collapsedResult = stripVTControlCharacters(render(tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      plainTheme,
      renderContext(false, { args }),
    )));
    assert.match(collapsedResult, /1\. Source 1/);
    assert.match(collapsedResult, /source1\.example/);
    assert.match(collapsedResult, /Clean first snippet/);
    assert.match(collapsedResult, /3\. Source 3/);
    assert.match(collapsedResult, /2 more results \( ?to expand\)/);
    assert.doesNotMatch(collapsedResult, /4\. Source 4|turn0search|wordlim|Search result line|Completed/);
    const hintGuardTheme = {
      ...plainTheme,
      fg: (_color: string, text: string) => {
        assert.doesNotMatch(
          text,
          /to expand/,
          "the surrounding search-line color must not override keyHint styling",
        );
        return text;
      },
    } as Theme;
    const guardedCollapsedResult = stripVTControlCharacters(render(tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      hintGuardTheme,
      renderContext(false, { args }),
    )));
    assert.match(guardedCollapsedResult, /2 more results \( ?to expand\)/);
    const expandedResult = render(tool.renderResult!(
      result,
      { expanded: true, isPartial: false },
      plainTheme,
      renderContext(true, { args }),
    ));
    assert.match(expandedResult, /1\. Source 1/);
    assert.match(expandedResult, /https:\/\/source1\.example\/article/);
    assert.match(expandedResult, /5\. Source 5/);
    assert.match(expandedResult, /https:\/\/source5\.example\/article/);
    assert.doesNotMatch(expandedResult, /turn0search|wordlim|Search result line|more results/);
    const partialResult = render(tool.renderResult!(
      updates[1],
      { expanded: false, isPartial: true },
      plainTheme,
      renderContext(false, { args, isPartial: true }),
    ));
    assert.match(partialResult, /Waiting for Codex search/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex_search uses the logged-in Codex model when cross-provider tools are enabled", async () => {
  const originalFetch = globalThis.fetch;
  let request: { body: any } | undefined;
  globalThis.fetch = async (_input, init) => {
    request = { body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ output: "Cross-provider source" }));
  };
  const tool = toolRegistry((pi) => registerCodexSearchTool(pi, () => ({
    ...DEFAULT_CODEX_API_CONFIG,
    allowOtherProviders: true,
    searchMode: "cached",
  })));
  try {
    const result = await tool.execute(
      "cross-provider-search",
      { search_query: [{ q: "Codex" }], search_mode: "live" },
      undefined,
      undefined,
      otherProviderContext(process.cwd()),
    );
    assert.equal(request?.body.model, "gpt-5.6-codex");
    assert.equal(request?.body.settings.external_web_access, false);
    assert.equal(request?.body.commands.search_mode, undefined);
    assert.equal(result.details.mode, "cached");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex search display normalizes raw sources and document views", () => {
  const rawSources = [
    "First result (https://one.example/article)",
    "citeturn0search0 [wordlim: 200] Published: today; Crawled: today; Useful first snippet",
    "----------------------------------------",
    "Second result (https://two.example/page)",
    "citeturn0search1 [wordlim: 100] Useful second snippet",
  ].join("\n");
  const sourceDisplay = createCodexSearchDisplay(
    { search_query: [{ q: "test" }] },
    rawSources,
  );
  assert.equal(sourceDisplay.kind, "sources");
  const sourceText = formatCodexSearchDisplay(sourceDisplay, true)
    .map((line) => line.text)
    .join("\n");
  assert.match(sourceText, /1\. First result\n   https:\/\/one\.example\/article/);
  assert.match(sourceText, /Useful first snippet/);
  assert.match(sourceText, /2\. Second result/);
  assert.doesNotMatch(sourceText, /cite|wordlim|Published|Crawled|-{20}|\n\n/);

  const duplicateUrlDisplay = createCodexSearchDisplay(
    { search_query: [{ q: "test" }] },
    "",
    [
      { title: "Original", url: "https://docs.example/article.pdf" },
      { title: "Repeatedly encoded duplicate", url: "https://docs.example/article%252525252525252Epdf" },
    ],
  );
  assert.equal(duplicateUrlDisplay.kind, "sources");
  if (duplicateUrlDisplay.kind === "sources") {
    assert.deepEqual(duplicateUrlDisplay.sources.map((source) => source.url), ["https://docs.example/article.pdf"]);
  }

  const documentOutput = [
    "Opened page (https://docs.example/page)",
    "citeturn0view0 [wordlim: 200] Crawled: today; Opened page",
    "L0: L1:",
    "L2: * [Button: Products]",
    "L3: # Opened page",
    ...Array.from({ length: 12 }, (_, index) => `L${index + 4}: Document line ${index + 1}`),
  ].join("\n");
  const documentDisplay = createCodexSearchDisplay(
    { open: [{ ref_id: "turn0search0" }] },
    documentOutput,
    [{
      type: "text_result",
      title: "Opened page",
      domain: "docs.example",
      url: "https://docs.example/page",
      ref_id: "turn0view0",
    }],
  );
  assert.equal(documentDisplay.kind, "document");
  if (documentDisplay.kind === "document") assert.equal(documentDisplay.documents?.length, 1);
  const collapsedDocumentLines = formatCodexSearchDisplay(documentDisplay, false, "ctrl+o to expand");
  assert.equal(collapsedDocumentLines.at(-1)?.expandHint, "ctrl+o to expand");
  const collapsedDocument = collapsedDocumentLines.map((line) => line.text).join("\n");
  assert.match(collapsedDocument, /^Opened page\n   docs\.example/);
  assert.match(collapsedDocument, /   Document line 1/);
  assert.doesNotMatch(collapsedDocument, /https:\/\/docs\.example\/page/);
  assert.match(collapsedDocument, /2 more lines \(ctrl\+o to expand\)/);
  assert.doesNotMatch(collapsedDocument, /cite|wordlim|Image:|Button:|L\d+:|-{20}/);
  const expandedDocument = formatCodexSearchDisplay(documentDisplay, true)
    .map((line) => line.text)
    .join("\n");
  assert.match(expandedDocument, /^Opened page\n   https:\/\/docs\.example\/page/);
  assert.match(expandedDocument, /Document line 12/);
  assert.doesNotMatch(expandedDocument, /more lines/);

  const multiDocumentOutput = [
    [
      "First page (https://one.example/article)",
      "citeturn4view0 [wordlim: 200] Content type: text/html; Total lines: 20",
      "L0: # First page",
      ...Array.from({ length: 7 }, (_, index) => `L${index + 1}: First line ${index + 1}`),
      "L8: [Input]",
    ].join("\n"),
    [
      "Second page (https://two.example/article)",
      "citeturn4view1 [wordlim: 200] Content type: text/html; Total lines: 20",
      "L0: # Second page",
      ...Array.from({ length: 6 }, (_, index) => `L${index + 1}: Second line ${index + 1}`),
      "L7: cite2†Terms L8: ## Embedded heading",
    ].join("\n"),
    [
      "Internal Error ()",
      "citeturn4view2 [wordlim: 200] Unable to resolve open call",
      "L0: Unable to resolve open call",
    ].join("\n"),
  ].join("\n----------------------------------------\n");
  const multiDocumentDisplay = createCodexSearchDisplay(
    {
      open: [
        { ref_id: "turn2reddit18" },
        { ref_id: "turn2search9" },
        { ref_id: "turn2search1" },
      ],
    },
    multiDocumentOutput,
  );
  assert.equal(multiDocumentDisplay.kind, "document");
  if (multiDocumentDisplay.kind === "document") {
    assert.equal(multiDocumentDisplay.documents?.length, 3);
  }
  const multiDocumentLines = formatCodexSearchDisplay(
    multiDocumentDisplay,
    false,
    "ctrl+o to expand",
  );
  const collapsedMultiDocument = multiDocumentLines.map((line) => line.text).join("\n");
  assert.match(collapsedMultiDocument, /^1\. First page\n   one\.example/);
  assert.match(collapsedMultiDocument, /\n2\. Second page\n   two\.example/);
  assert.match(collapsedMultiDocument, /\n3\. Internal Error\n   Unable to resolve open call/);
  assert.doesNotMatch(collapsedMultiDocument, /\n\n/);
  assert.match(collapsedMultiDocument, /4 more lines across 3 results \(ctrl\+o to expand\)$/);
  assert.equal(multiDocumentLines.filter((line) => line.expandHint).length, 1);
  assert.equal(multiDocumentLines.find((line) => line.text.includes("Internal Error"))?.role, "error");
  assert.doesNotMatch(
    collapsedMultiDocument,
    /https:\/\/|First line 6|Second line 6|\[Input\]|cite|wordlim|L\d+:/,
  );
  const expandedMultiDocument = formatCodexSearchDisplay(multiDocumentDisplay, true)
    .map((line) => line.text)
    .join("\n");
  assert.match(expandedMultiDocument, /https:\/\/one\.example\/article/);
  assert.match(expandedMultiDocument, /First line 7/);
  assert.match(expandedMultiDocument, /Second line 6/);
  assert.match(expandedMultiDocument, /Embedded heading/);
  assert.doesNotMatch(expandedMultiDocument, /more lines|\[Input\]|cite|wordlim|L\d+:/);

  const dataDisplay = createCodexSearchDisplay(
    { weather: [{ location: "Tokyo" }] },
    "citeweather0 Weather: Sunny\nTemperature: 24 C",
  );
  assert.equal(dataDisplay.kind, "data");
  assert.deepEqual(
    formatCodexSearchDisplay(dataDisplay, false).map((line) => line.text),
    ["Weather: Sunny", "Temperature: 24 C"],
  );
});

test("Codex usage parsing and Fast payload preserve provider data", () => {
  const snapshots = parseCodexRateLimits({
    "X-Codex-Primary-Used-Percent": "25.5",
    "X-Codex-Primary-Window-Minutes": "300",
    "X-Codex-Primary-Reset-At": String(Math.floor(Date.now() / 1000) + 3600),
    "X-Codex-Secondary-Used-Percent": "40",
    "X-Codex-Credits-Has-Credits": "true",
    "X-Codex-Credits-Unlimited": "false",
    "X-Codex-Credits-Balance": "12.50",
    "X-Codex-Spark-Primary-Used-Percent": "10",
    "X-Codex-Spark-Limit-Name": "gpt-5.3-codex-spark",
  });
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].limitId, "codex");
  assert.equal(snapshots[0].primary?.usedPercent, 25.5);
  assert.equal(snapshots[0].secondary?.usedPercent, 40);
  assert.equal(snapshots[0].credits?.balance, "12.50");
  assert.equal(snapshots[1].limitName, "gpt-5.3-codex-spark");
  const usage = formatCodexUsage(snapshots);
  assert.match(usage, /Codex usage\n\ncodex\n/);
  assert.match(usage, /5h\s+\[███████████████░░░░░\] 74\.5% left/);
  assert.doesNotMatch(usage, /% used|•|codex:/);
  assert.deepEqual(
    applyFastModePayload({ model: "gpt-5.6", service_tier: "default" }, true),
    { model: "gpt-5.6", service_tier: "priority" },
  );
  const payload = { model: "gpt-5.6" };
  assert.equal(applyFastModePayload(payload, false), payload);
});

test("Codex usage labels server windows and hides inactive placeholders", () => {
  const now = 1_700_000_000_000;
  const weeklyOnly = [{
    limitId: "codex",
    primary: {
      usedPercent: 35,
      windowMinutes: 7 * 24 * 60,
      resetsAt: now / 1000 + 7 * 24 * 60 * 60,
    },
    secondary: {
      usedPercent: 0,
      windowMinutes: 5 * 60,
      resetsAt: 0,
    },
    credits: { hasCredits: false, unlimited: false },
  }];
  const weeklyText = formatCodexUsage(weeklyOnly, now);
  assert.equal(
    weeklyText,
    "Codex usage\n\ncodex\n  weekly [█████████████░░░░░░░] 65% left resets in 7d\n  no additional credits",
  );
  assert.doesNotMatch(weeklyText, /% used|5h|secondary|•|codex:/);
  assert.match(weeklyText, /no additional credits/);
  assert.equal(formatCodexStatus(weeklyOnly, false, now), "Codex weekly 65% 7d");

  const restoredFiveHourWindow = [{
    limitId: "codex",
    primary: {
      usedPercent: 25,
      windowMinutes: 5 * 60,
      resetsAt: now / 1000 + 2 * 60 * 60,
    },
    secondary: {
      usedPercent: 40,
      windowMinutes: 7 * 24 * 60,
      resetsAt: now / 1000 + 6 * 24 * 60 * 60,
    },
  }];
  const bothText = formatCodexUsage(restoredFiveHourWindow, now);
  assert.match(bothText, /5h\s+\[███████████████░░░░░\] 75% left resets in 2h/);
  assert.match(bothText, /weekly \[████████████░░░░░░░░\] 60% left resets in 6d/);
  assert.doesNotMatch(bothText, /% used/);
  assert.equal(
    formatCodexStatus(restoredFiveHourWindow, true, now),
    "Codex 5h 75% 2h Fast",
  );

  const boundedText = formatCodexUsage([{
    limitId: "bounds",
    primary: { usedPercent: -10, windowMinutes: 24 * 60 },
    secondary: { usedPercent: 150, windowMinutes: 7 * 24 * 60 },
  }], now);
  assert.match(boundedText, /daily\s+\[████████████████████\] 100% left/);
  assert.match(boundedText, /weekly \[░░░░░░░░░░░░░░░░░░░░\] 0% left/);
});

test("Codex usage refreshes directly from the official WHAM endpoint", async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  const payload = {
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        used_percent: 35,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: resetAt,
      },
      secondary_window: {
        used_percent: 0,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: 0,
      },
    },
    credits: { has_credits: false, unlimited: false },
    additional_rate_limits: [{
      metered_feature: "codex_spark",
      limit_name: "gpt-5.6-luna",
      rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 24 * 60 * 60,
          reset_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        },
      },
    }],
  };
  const parsed = parseCodexUsagePayload(payload);
  assert.equal(parsed[0].primary?.windowMinutes, 7 * 24 * 60);
  assert.equal(parsed[0].secondary?.windowMinutes, 5 * 60);
  assert.equal(parsed[1].limitId, "codex_spark");
  assert.equal(parsed[1].limitName, "gpt-5.6-luna");

  let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
  const commands: string[] = [];
  const pi = {
    registerCommand(name: string, definition: any) {
      commands.push(name);
      if (name === "codex-usage") command = definition;
    },
    on() {},
  } as unknown as ExtensionAPI;
  registerCodexUsageAndFast(pi, {
    getConfig: () => DEFAULT_CODEX_API_CONFIG,
    updateConfig: () => {},
  });
  assert.ok(command);
  assert.deepEqual(commands, ["codex-usage"]);

  const originalFetch = globalThis.fetch;
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify(payload));
  };
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<string | undefined> = [];
  const ctx = context(process.cwd()) as any;
  ctx.ui = {
    notify: (message: string, level: string) => notifications.push({ message, level }),
    setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    theme: { fg: (color: string, text: string) => `[${color}]${text}` },
  };
  try {
    await command.handler("", ctx);
    assert.equal(request?.url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(request?.init?.method, "GET");
    const message = notifications.at(-1)?.message ?? "";
    assert.match(message, /^Codex usage\n\ncodex\n/);
    assert.match(message, /weekly \[█████████████░░░░░░░\] 65% left/);
    assert.doesNotMatch(message, /% used|5h|•|codex:/);
    assert.match(message, /\n\ngpt-5\.6-luna\n  daily \[██████████████████░░\] 90% left/);
    assert.equal(statuses.at(-1), "[muted]Codex weekly 65% 7d");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex usage watches auth.json for account switches and ignores stale requests", async () => {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerCommand() {},
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const temporary = await mkdtemp(join(tmpdir(), "pi-codex-auth-watch-"));
  const authPath = join(temporary, "auth.json");
  await writeFile(authPath, JSON.stringify({ account: "a" }));
  const handle = registerCodexUsageAndFast(pi, {
    getConfig: () => DEFAULT_CODEX_API_CONFIG,
    updateConfig: () => {},
  }, { authPath });

  const tokenA = jwt("acct-a");
  const tokenB = jwt("acct-b");
  let activeToken = tokenA;
  let oauthAvailable = true;
  let registryRefreshes = 0;
  const statuses: Array<string | undefined> = [];
  const ctx = context(process.cwd()) as any;
  ctx.modelRegistry.isUsingOAuth = () => oauthAvailable;
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: activeToken });
  ctx.modelRegistry.refresh = async () => {
    registryRefreshes += 1;
    const stored = JSON.parse(await readFile(authPath, "utf8")) as { account?: string };
    oauthAvailable = stored.account !== undefined;
    if (stored.account === "b") activeToken = tokenB;
  };
  ctx.ui = {
    setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    theme: { fg: (color: string, text: string) => `[${color}]${text}` },
    notify() {},
  };

  const originalFetch = globalThis.fetch;
  let accountAFetches = 0;
  let releaseStaleAccountA: (() => void) | undefined;
  globalThis.fetch = async (_input, init) => {
    const accountId = new Headers(init?.headers).get("chatgpt-account-id");
    const payload = (usedPercent: number) => JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: usedPercent,
          limit_window_seconds: 5 * 60 * 60,
          reset_at: Math.floor(Date.now() / 1000) + 60 * 60,
        },
      },
    });
    if (accountId === "acct-a") {
      accountAFetches += 1;
      if (accountAFetches === 2) {
        await new Promise<void>((resolve) => {
          releaseStaleAccountA = resolve;
        });
        return new Response(payload(90));
      }
      return new Response(payload(10));
    }
    assert.equal(accountId, "acct-b");
    return new Response(payload(70));
  };

  let staleRefresh: Promise<void> | undefined;
  try {
    handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    await handle.refreshUsage(ctx, true);
    assert.equal(handle.getSnapshots()[0]?.primary?.usedPercent, 10);
    assert.equal("authStorage" in ctx.modelRegistry, false);

    staleRefresh = handle.refreshUsage(ctx, true);
    while (!releaseStaleAccountA) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await writeFile(authPath, JSON.stringify({ account: "b" }));
    for (
      let attempt = 0;
      attempt < 200 && handle.getSnapshots()[0]?.primary?.usedPercent !== 70;
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(statuses.includes("[muted]Codex syncing…"));
    assert.equal(handle.getSnapshots()[0]?.primary?.usedPercent, 70);
    assert.match(statuses.at(-1) ?? "", /Codex 5h 30%/);

    releaseStaleAccountA();
    await staleRefresh;
    assert.equal(handle.getSnapshots()[0]?.primary?.usedPercent, 70);
    assert.match(statuses.at(-1) ?? "", /Codex 5h 30%/);

    await writeFile(authPath, JSON.stringify({}));
    for (let attempt = 0; attempt < 200 && handle.getSnapshots().length > 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(handle.getSnapshots(), []);
    assert.equal(statuses.at(-1), undefined);

    handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    const refreshesAtShutdown = registryRefreshes;
    await writeFile(authPath, JSON.stringify({ account: "b" }));
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    assert.equal(registryRefreshes, refreshesAtShutdown);
  } finally {
    releaseStaleAccountA?.();
    await staleRefresh?.catch(() => {});
    handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    globalThis.fetch = originalFetch;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Codex API config normalizes, saves, and reloads", async () => {
  assert.equal(DEFAULT_CODEX_API_CONFIG.searchMode, "auto");
  assert.deepEqual(SEARCH_MODE_LABELS, {
    auto: "Auto",
    cached: "Cached",
    indexed: "Indexed",
    live: "Live",
  });
  assert.equal(normalizeCodexApiConfig({ searchMode: "auto" }).searchMode, "auto");
  assert.equal(resolveSearchMode("auto"), "indexed");
  assert.equal(resolveSearchMode("auto", "live"), "live");
  assert.equal(resolveSearchMode("auto", "cached"), "cached");
  assert.equal(resolveSearchMode("cached", "live"), "cached");
  assert.equal(resolveSearchMode("indexed", "live"), "indexed");
  assert.equal(resolveSearchMode("live", "cached"), "live");
  assert.deepEqual(normalizeCodexApiConfig({
    fastMode: true,
    allowOtherProviders: true,
    searchMode: "live",
    searchContextSize: "high",
    imageQuality: "high",
    usageStatus: false,
  }), {
    fastMode: true,
    allowOtherProviders: true,
    searchMode: "live",
    searchContextSize: "high",
    imageQuality: "high",
    usageStatus: false,
  });
  assert.deepEqual(normalizeCodexApiConfig({
    fastMode: "yes",
    searchMode: "invalid",
  }), DEFAULT_CODEX_API_CONFIG);

  const temporary = await mkdtemp(join(tmpdir(), "pi-codex-config-"));
  const path = join(temporary, "99extensions.json");
  try {
    await writeFile(path, JSON.stringify({ untouched: { enabled: true } }));
    saveCodexApiConfig({
      fastMode: true,
      allowOtherProviders: true,
      searchMode: "indexed",
      searchContextSize: "low",
      imageQuality: "low",
      usageStatus: true,
    }, path);
    assert.deepEqual(loadCodexApiConfig(path), {
      fastMode: true,
      allowOtherProviders: true,
      searchMode: "indexed",
      searchContextSize: "low",
      imageQuality: "low",
      usageStatus: true,
    });
    const document = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(document.untouched, { enabled: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
