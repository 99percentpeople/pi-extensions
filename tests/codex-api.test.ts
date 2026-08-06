import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
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
  collectWorkspaceFile,
  WORKSPACE_FILES_REQUEST_CHANNEL,
  type WorkspaceFileSystem,
} from "@99percentpeople/pi-workspace-files";
import {
  applyFastModePayload,
  CodexApiClient,
  CodexApiError,
  CodexOAuthError,
  createCodexApiClient,
  createCodexSearchDisplay,
  DEFAULT_CODEX_API_CONFIG,
  extractCodexAccountId,
  formatCodexSearchDisplay,
  formatCodexStatus,
  formatCodexUsage,
  formatCodexRedeemCredits,
  loadCodexApiConfig,
  normalizeCodexApiConfig,
  normalizeCodexImageSize,
  parseCodexRateLimits,
  parseCodexUsagePayload,
  maskCodexEmail,
  parseCodexAccountInfo,
  parseCodexRedeemCredits,
  registerCodexImageTool,
  registerCodexSearchTool,
  registerCodexUsageAndFast,
  resolveCodexApiRoot,
  resolveSearchMode,
  saveCodexApiConfig,
  SEARCH_MODE_LABELS,
  usageRefreshNeeded,
} from "../extensions/codex-api/index.ts";

function jwt(accountId = "acct-123"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

function formatLocalDateTime(epochMs: number): string {
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

function toolRegistry(
  register: (pi: ExtensionAPI) => void,
  configureEvents?: (events: EventEmitter) => void,
): ToolDefinition {
  let tool: ToolDefinition | undefined;
  const events = new EventEmitter();
  configureEvents?.(events);
  register({
    registerTool: (value) => { tool = value; },
    on: () => {},
    events: {
      on: (name: string, handler: (data: unknown) => void) => {
        events.on(name, handler);
        return () => events.off(name, handler);
      },
      emit: (name: string, data: unknown) => {
        events.emit(name, data);
      },
    },
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
    (error) => error instanceof CodexOAuthError
      && /Codex subscription OAuth is unavailable: token refresh failed.*Run \/login/.test(error.message),
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
  const tool = toolRegistry((pi) => registerCodexImageTool(
    pi,
    () => ({ ...DEFAULT_CODEX_API_CONFIG, imageQuality: "medium" }),
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
  } finally {
    globalThis.fetch = originalFetch;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("codex_image uses a claimed workspace file system for binary output and references", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-codex-remote-files-"));
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("remote png data").toString("base64") }],
    }));
  };

  const root = "C:\\Users\\Admin";
  const stored = new Map<string, Buffer>([
    ["C:\\Users\\Admin\\Desktop\\reference.jpg", Buffer.from("remote reference")],
  ]);
  const files: WorkspaceFileSystem = {
    resolvePath(path) {
      const absolute = win32.isAbsolute(path) ? win32.normalize(path) : win32.resolve(root, path);
      const relative = win32.relative(root, absolute);
      if (relative === ".." || relative.startsWith("..\\") || win32.isAbsolute(relative)) {
        throw new Error(`outside remote workspace: ${path}`);
      }
      return absolute;
    },
    extname: win32.extname,
    dirname: win32.dirname,
    exists: async (path) => stored.has(path),
    readFile: async (path) => {
      const value = stored.get(path);
      if (!value) throw new Error(`missing: ${path}`);
      return value;
    },
    mkdir: async () => {},
    writeFile: async (path, content, options) => {
      stored.set(path, await collectWorkspaceFile(content, options));
    },
  };
  const tool = toolRegistry(
    (pi) => registerCodexImageTool(pi),
    (events) => {
      events.on(WORKSPACE_FILES_REQUEST_CHANNEL, (value) => {
        (value as { claim(owner: string, files: WorkspaceFileSystem): void }).claim(
          "test-remote-files",
          files,
        );
      });
    },
  );

  try {
    const result = await tool.execute(
      "remote-image",
      {
        prompt: "Use the remote reference",
        referenced_image_paths: ["Desktop\\reference.jpg"],
        output_path: "Desktop\\generated",
      },
      undefined,
      undefined,
      context(temporary),
    );
    const output = "C:\\Users\\Admin\\Desktop\\generated.png";
    assert.equal((result.details as { savedPath: string }).savedPath, output);
    assert.equal(stored.get(output)?.toString("utf8"), "remote png data");
    assert.match(requests[0].images[0].image_url, /^data:image\/jpeg;base64,/);
    assert.equal(requests[0].images[0].image_url.split(",")[1], Buffer.from("remote reference").toString("base64"));
    assert.match((result.content[0] as { text: string }).text, /C:\\Users\\Admin\\Desktop\\generated\.png/);
    await assert.rejects(
      () => tool.execute(
        "remote-overwrite",
        { prompt: "overwrite", output_path: output },
        undefined,
        undefined,
        context(temporary),
      ),
      /Refusing to overwrite existing image/,
    );
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
  assert.equal((tool.parameters as any).properties.search_query.maxItems, 4);
  assert.equal((tool.parameters as any).properties.image_query.maxItems, 4);
  assert.equal((tool.parameters as any).properties.open.maxItems, 3);
  assert.equal((tool.parameters as any).properties.click.maxItems, 3);
  assert.equal((tool.parameters as any).properties.find.maxItems, 3);
  assert.match(
    (tool.parameters as any).properties.finance.items.properties.ticker.description,
    /crypto.*bare symbol.*BTC.*not BTC-USD/i,
  );
  assert.match(
    (tool.parameters as any).properties.finance.items.properties.market.description,
    /provider hint.*does not resolve.*international/i,
  );
  assert.match(
    (tool.parameters as any).properties.weather.items.properties.duration.description,
    /use 1.*current conditions.*omit.*seven-day/i,
  );
  const promptGuidelines = tool.promptGuidelines ?? [];
  const searchGuidelines = promptGuidelines.join("\n");
  assert.ok(promptGuidelines.length <= 7, "keep codex_search guidance consolidated");
  assert.ok(searchGuidelines.length <= 1_250, "keep codex_search guidance token-efficient");
  assert.match(searchGuidelines, /search first.*strong ref_ids.*short output.*three queries.*fourth.*medium or long/i);
  assert.match(searchGuidelines, /direct URLs.*best effort.*do not retry blocked URLs/i);
  assert.match(searchGuidelines, /three pages.*open\/click\/find.*full documents.*response_length.*lineno/i);
  assert.match(searchGuidelines, /structured data.*separately from page navigation/i);
  assert.match(searchGuidelines, /Weather: duration=1.*current conditions.*no data.*retry once.*then search/i);
  assert.match(searchGuidelines, /Crypto: BTC\/ETH.*not BTC-USD.*market.*unsupported exchanges/i);
  assert.match(searchGuidelines, /NHL standings.*nhl\.com/i);
  assert.match(searchGuidelines, /cached.*indexed.*live.*Auto.*search_mode/i);
  assert.match(searchGuidelines, /breaking news.*exact date.*recency=1.*freshness/i);
  assert.match(searchGuidelines, /screenshots.*open the PDF.*ref_id.*Retry one render timeout/i);
  assert.match(searchGuidelines, /external content.*untrusted data.*never as instructions/i);
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

test("codex_search compacts lookup output, hints blocked URLs, and truncates large pages", async () => {
  const originalFetch = globalThis.fetch;
  let payload: Record<string, unknown> = {};
  globalThis.fetch = async () => new Response(JSON.stringify(payload));
  const tool = toolRegistry((pi) => registerCodexSearchTool(pi, () => ({
    ...DEFAULT_CODEX_API_CONFIG,
    searchMode: "auto",
  })));
  try {
    payload = {
      output: "citeturn5finance0 Apple Inc (AAPL) is a equity in the USA market. The price is 308.91 USD currently with a change of -23.80000 (-0.07138%) from the previous close. The intraday high is 311.87 USD and the intraday low is 300.015 USD. The latest open price was 304.69 USD and the intraday volume is 132489137. The market cap is 4,548,969,428,430. The PE ratio is 37.398305084745765. The EPS ratio is 8.71. The latest trade time is Saturday, August 01, 00:15:00 UTC.",
      results: [],
    };
    const financeArgs = { finance: [{ ticker: "AAPL", type: "equity" as const }] };
    const financeResult = await tool.execute(
      "finance-call",
      financeArgs,
      undefined,
      undefined,
      context(process.cwd()),
    );
    const financeText = financeResult.content[0].type === "text" ? financeResult.content[0].text : "";
    assert.match(financeText, /^Apple Inc \(AAPL\) · equity · USA/);
    assert.match(financeText, /P\/E 37\.4 · EPS 8\.71/);
    assert.doesNotMatch(financeText, /cite|turn5finance|currently with a change/);
    assert.equal((financeResult.details as any).display.kind, "lookups");
    const renderedFinance = render(tool.renderResult!(
      financeResult,
      { expanded: false, isPartial: false },
      plainTheme,
      renderContext(false, { args: financeArgs }),
    ));
    assert.match(renderedFinance, /Apple Inc \(AAPL\) · equity · USA/);

    payload = {
      output: [
        "Internal Error ()",
        "citeturn6view0 Source: open; Total lines: 1",
        "L0: URL https://example.com/path?q=1 is not safe to open (non-retryable error)",
      ].join("\n"),
      results: [],
    };
    const blockedResult = await tool.execute(
      "blocked-open",
      { open: [{ ref_id: "https://example.com/path?q=1" }] },
      undefined,
      undefined,
      context(process.cwd()),
    );
    const blockedText = blockedResult.content[0].type === "text" ? blockedResult.content[0].text : "";
    assert.match(blockedText, /Codex rejected this direct URL/);
    assert.match(blockedText, /search.*returned reference ID/i);
    assert.match(blockedText, /do not repeatedly retry/i);

    payload = {
      output: Array.from({ length: 2_500 }, (_, index) => `L${index}: page line ${index}`).join("\n"),
      results: [],
    };
    const largeResult = await tool.execute(
      "large-open",
      { open: [{ ref_id: "turn9search0" }] },
      undefined,
      undefined,
      context(process.cwd()),
    );
    const largeText = largeResult.content[0].type === "text" ? largeResult.content[0].text : "";
    assert.match(largeText, /Codex search output truncated: 2000\/2500 lines/);
    assert.match(largeText, /Open fewer references in separate calls/);
    assert.doesNotMatch(largeText, /page line 2499/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex_search explains lookup outages, invalid symbols, unsupported leagues, and partial omissions", async () => {
  const originalFetch = globalThis.fetch;
  let payload: Record<string, unknown> = {};
  globalThis.fetch = async () => new Response(JSON.stringify(payload));
  const tool = toolRegistry((pi) => registerCodexSearchTool(pi, () => ({
    ...DEFAULT_CODEX_API_CONFIG,
    searchMode: "auto",
  })));
  const execute = async (id: string, args: Record<string, unknown>, output: string) => {
    payload = { output, results: [] };
    const result = await tool.execute(
      id,
      args as any,
      undefined,
      undefined,
      context(process.cwd()),
    );
    return {
      result,
      text: result.content[0].type === "text" ? result.content[0].text : "",
    };
  };

  try {
    const weather = await execute(
      "weather-outage",
      { weather: [{ location: "Shanghai, China", duration: 1 }], search_mode: "indexed" },
      "Found no tool response. This likely means the arguments you provided were not valid.",
    );
    assert.match(weather.text, /weather lookup intermittently returns no data.*Retry once/i);
    assert.match(weather.text, /search_query.*instead of repeatedly changing location, duration, or search mode/i);
    const weatherDisplay = createCodexSearchDisplay(
      { weather: [{ location: "Shanghai, China", duration: 1 }] },
      weather.text,
    );
    assert.ok(formatCodexSearchDisplay(weatherDisplay, false).some((line) =>
      line.role === "warning" && /weather lookup intermittently/i.test(line.text)
    ));

    const crypto = await execute(
      "crypto-pair",
      { finance: [{ ticker: "BTC-USD", type: "crypto" }], search_mode: "indexed" },
      "Found no tool response. This likely means the arguments you provided were not valid.",
    );
    assert.match(crypto.text, /crypto quotes require a bare asset ticker.*BTC.*ETH/i);
    assert.match(crypto.text, /BTC-USD.*ETH-USD.*return no data/i);

    const partialCryptoArgs = {
      finance: [
        { ticker: "AAPL", type: "equity" },
        { ticker: "BTC-USD", type: "crypto" },
      ],
      search_mode: "indexed",
    };
    const partialCrypto = await execute(
      "partial-crypto",
      partialCryptoArgs,
      "citeturn31finance0 Apple Inc (AAPL) is a equity in the USA market. The price is 303.42 USD currently with a change of -5.50000 (-0.01781%) from the previous close.",
    );
    assert.match(partialCrypto.text, /^Apple Inc \(AAPL\)/);
    assert.match(partialCrypto.text, /crypto quotes require a bare asset ticker/i);
    assert.deepEqual((partialCrypto.result.details as any).hints, [
      "Tip: crypto quotes require a bare asset ticker such as BTC or ETH; pair tickers such as BTC-USD and ETH-USD return no data.",
    ]);
    const renderedPartialCrypto = render(tool.renderResult!(
      partialCrypto.result,
      { expanded: false, isPartial: false },
      plainTheme,
      renderContext(false, { args: partialCryptoArgs }),
    ));
    assert.match(renderedPartialCrypto, /Apple Inc \(AAPL\).*crypto quotes require a bare asset ticker/is);

    const nhl = await execute(
      "nhl-standings",
      { sports: [{ fn: "standings", league: "nhl" }], search_mode: "indexed" },
      "Found no tool response. This likely means the arguments you provided were not valid.",
    );
    assert.match(nhl.text, /does not currently serve NHL standings.*nhl\.com/i);

    const partialNhl = await execute(
      "partial-nhl",
      {
        sports: [
          { fn: "standings", league: "mlb" },
          { fn: "standings", league: "nhl" },
        ],
        search_mode: "indexed",
      },
      "citeturn33sports0 # Division: East\nTampa Bay Rays 65-46",
    );
    assert.match(partialNhl.text, /^MLB standings/);
    assert.match(partialNhl.text, /does not currently serve NHL standings/i);

    const international = await execute(
      "international-finance",
      {
        finance: [
          { ticker: "0700", type: "equity", market: "HK" },
          { ticker: "0700.HK", type: "equity" },
        ],
        search_mode: "indexed",
      },
      "Found no tool response. This likely means the arguments you provided were not valid.",
    );
    assert.match(international.text, /does not reliably resolve non-U\.S\. listings.*0700\.HK/i);
    assert.match(international.text, /market is only a provider hint/i);
    assert.doesNotMatch(international.text, /ticker is an ETF/i);

    const indexQuote = await execute(
      "index-quote",
      { finance: [{ ticker: "SPX", type: "index" }], search_mode: "indexed" },
      "Found no tool response. This likely means the arguments you provided were not valid.",
    );
    assert.match(indexQuote.text, /does not serve index quotes.*SPY/i);

    const filteredSchedule = await execute(
      "filtered-schedule",
      { sports: [{ fn: "schedule", league: "nba", team: "Lakers" }], search_mode: "indexed" },
      "Found no tool response. This likely means the arguments you provided were not valid.",
    );
    assert.match(filteredSchedule.text, /schedule with team\/opponent.*retry without/i);
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

  const imageDisplay = createCodexSearchDisplay(
    { image_query: [{ q: "mount fuji sunrise" }] },
    [
      "Landscape image page | Flickr (https://flickr.example/photo)",
      "citeturn2image0 # Sunrise Reflection at Lake Kawaguchiko",
      "A snow-capped Mount Fuji is mirrored in a calm lake under warm dawn light.",
      "This photograph appears on a travel page with unrelated background details.",
    ].join("\n"),
  );
  assert.equal(imageDisplay.kind, "sources");
  const imageText = formatCodexSearchDisplay(imageDisplay, false)
    .map((line) => line.text)
    .join("\n");
  assert.match(imageText, /^1\. Sunrise Reflection at Lake Kawaguchiko/);
  assert.match(imageText, /flickr\.example/);
  assert.match(imageText, /snow-capped Mount Fuji/);
  assert.doesNotMatch(imageText, /Landscape image page|unrelated background details/);

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

  const screenshotDisplay = createCodexSearchDisplay(
    { screenshot: [{ ref_id: "turn2view0", pageno: 2 }] },
    " (https://docs.example/report.pdf)\nciteturn3view0 ",
  );
  assert.equal(screenshotDisplay.kind, "document");
  const screenshotText = formatCodexSearchDisplay(screenshotDisplay, false)
    .map((line) => line.text)
    .join("\n");
  assert.equal(screenshotText, "PDF screenshot · page 3\n   docs.example");

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

  const manyDocumentOutput = Array.from({ length: 5 }, (_, index) => [
    `Page ${index + 1} (https://page${index + 1}.example/article)`,
    `citeturn8view${index} [wordlim: 200] Content type: text/html`,
    `L0: # Page ${index + 1}`,
    `L1: Body ${index + 1}`,
  ].join("\n")).join("\n----------------------------------------\n");
  const manyDocumentDisplay = createCodexSearchDisplay(
    { open: Array.from({ length: 5 }, (_, index) => ({ ref_id: `turn7search${index}` })) },
    manyDocumentOutput,
  );
  const collapsedManyDocuments = formatCodexSearchDisplay(manyDocumentDisplay, false, "expand")
    .map((line) => line.text)
    .join("\n");
  assert.match(collapsedManyDocuments, /1\. Page 1/);
  assert.match(collapsedManyDocuments, /3\. Page 3/);
  assert.doesNotMatch(collapsedManyDocuments, /4\. Page 4|5\. Page 5/);
  assert.match(collapsedManyDocuments, /2 more results and 2 more lines \(expand\)/);
  const expandedManyDocuments = formatCodexSearchDisplay(manyDocumentDisplay, true)
    .map((line) => line.text)
    .join("\n");
  assert.match(expandedManyDocuments, /5\. Page 5/);

  const dataDisplay = createCodexSearchDisplay(
    {},
    "citeweather0 Weather: Sunny\nTemperature: 24 C",
  );
  assert.equal(dataDisplay.kind, "data");
  assert.deepEqual(
    formatCodexSearchDisplay(dataDisplay, false).map((line) => line.text),
    ["Weather: Sunny", "Temperature: 24 C"],
  );
});

test("Codex search display formats weather, finance, sports, and time lookups", () => {
  const weatherOutput = [
    "citeturn8forecast0 Weather for Shanghai, Shanghai, China, China:",
    "Current Conditions: Light rain, 92°F (33°C)",
    "Daily Forecast:",
    "Sunday, August 02: Partly sunny and hot, High: 100°F (38°C), Low: 82°F (28°C)",
    "Monday, August 03: Mostly sunny, High: 97°F (36°C), Low: 79°F (26°C)",
    "Tuesday, August 04: Rain, High: 94°F (35°C), Low: 83°F (28°C)",
    "Wednesday, August 05: Storms, High: 93°F (34°C), Low: 82°F (28°C)",
    "Severe weather alerts:",
    "[SevereWeather(name='Shanghai', summary='Thunderstorm Warning in effect. Source: CMA', details='Very long\\nalert instructions')]",
  ].join("\n");
  const weatherDisplay = createCodexSearchDisplay(
    { weather: [{ location: "Shanghai", duration: 4 }] },
    weatherOutput,
  );
  assert.equal(weatherDisplay.kind, "lookups");
  const collapsedWeatherLines = formatCodexSearchDisplay(weatherDisplay, false, "expand");
  const collapsedWeather = collapsedWeatherLines.map((line) => line.text).join("\n");
  assert.match(collapsedWeather, /^Weather · Shanghai, China/);
  assert.match(collapsedWeather, /Light rain, 92°F \(33°C\)/);
  assert.match(collapsedWeather, /Sunday, August 02 · Partly sunny and hot · H 100°F \(38°C\) · L 82°F \(28°C\)/);
  assert.match(collapsedWeather, /Thunderstorm Warning in effect\. Source: CMA/);
  assert.match(collapsedWeather, /1 more line \(expand\)$/);
  assert.doesNotMatch(collapsedWeather, /Wednesday, August 05|Very long|alert instructions/);
  assert.equal(
    collapsedWeatherLines.find((line) => line.text.includes("Thunderstorm Warning"))?.role,
    "warning",
  );
  const expandedWeather = formatCodexSearchDisplay(weatherDisplay, true)
    .map((line) => line.text)
    .join("\n");
  assert.match(expandedWeather, /Wednesday, August 05 · Storms/);
  assert.doesNotMatch(expandedWeather, /Very long|alert instructions/);

  const financeOutput = "citeturn5finance0 Apple Inc (AAPL) is a equity in the USA market. The price is 308.91 USD currently with a change of -23.80000 (-0.07138%) from the previous close. The intraday high is 311.87 USD and the intraday low is 300.015 USD. The latest open price was 304.69 USD and the intraday volume is 132489137. The market cap is 4,548,969,428,430. The PE ratio is 37.398305084745765. The EPS ratio is 8.71. The latest trade time is Saturday, August 01, 00:15:00 UTC.";
  const sportsOutput = [
    "citeturn5sports0 # Conference: Eastern Conference",
    "Detroit Pistons 60-22",
    "Boston Celtics 56-26",
    "# Conference: Western Conference",
    "Oklahoma City Thunder 64-18",
    "San Antonio Spurs 62-20",
  ].join("\n");
  const timeOutput = "citeturn5time0 The time in UTC+09:00 is Aug 2, 2026, 6:04:00 PM";
  const lookupDisplay = createCodexSearchDisplay(
    {
      finance: [{ ticker: "AAPL", type: "equity" }],
      sports: [{ fn: "standings", league: "nba" }],
      time: [{ utc_offset: "+09:00" }],
    },
    [sportsOutput, financeOutput, timeOutput].join("\n----------------------------------------\n"),
  );
  assert.equal(lookupDisplay.kind, "lookups");
  const lookupText = formatCodexSearchDisplay(lookupDisplay, true)
    .map((line) => line.text)
    .join("\n");
  assert.match(lookupText, /1\. NBA standings/);
  assert.match(lookupText, /Eastern Conference\n   1\. Detroit Pistons 60-22/);
  assert.match(lookupText, /2\. Apple Inc \(AAPL\) · equity · USA/);
  assert.match(lookupText, /308\.91 USD · -23\.8 \(-7\.15%\)/);
  assert.match(lookupText, /Open 304\.69 · High 311\.87 · Low 300\.015/);
  assert.match(lookupText, /Volume 132\.49M · Market cap 4\.55T USD/);
  assert.match(lookupText, /P\/E 37\.4 · EPS 8\.71/);
  assert.match(lookupText, /3\. Time · UTC\+09:00\n   Aug 2, 2026, 6:04:00 PM/);
  assert.doesNotMatch(lookupText, /cite|turn5|currently with a change/);

  const failedLookup = createCodexSearchDisplay(
    { weather: [{ location: "Tokyo", duration: 1 }] },
    "Found no tool response. This likely means the arguments were not valid.",
  );
  assert.equal(failedLookup.kind, "data");
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

test("Codex usage reset time shows granular day/hour/minute units", () => {
  const now = 1_700_000_000_000;
  const snapshotFor = (secondsFromNow: number) => [{
    limitId: "codex",
    primary: {
      usedPercent: 50,
      windowMinutes: 7 * 24 * 60,
      resetsAt: now / 1000 + secondsFromNow,
    },
  }];

  assert.match(formatCodexUsage(snapshotFor(5 * 24 * 60 * 60 + 3 * 60 * 60), now), /resets in 5d 3h/);
  assert.match(formatCodexUsage(snapshotFor(6 * 24 * 60 * 60), now), /resets in 6d/);
  assert.match(formatCodexUsage(snapshotFor(12 * 60 * 60 + 30 * 60), now), /resets in 12h 30m/);
  assert.match(formatCodexUsage(snapshotFor(23 * 60 * 60 + 59 * 60), now), /resets in 23h 59m/);
  assert.match(formatCodexUsage(snapshotFor(60 * 60), now), /resets in 1h/);
  assert.match(formatCodexUsage(snapshotFor(45 * 60), now), /resets in 45m/);
  assert.match(formatCodexUsage(snapshotFor(59 * 60), now), /resets in 59m/);
  assert.match(formatCodexUsage(snapshotFor(60), now), /resets in 1m/);
  assert.doesNotMatch(formatCodexUsage(snapshotFor(60), now), /resets in 0m/);

  assert.equal(formatCodexStatus(snapshotFor(5 * 24 * 60 * 60 + 3 * 60 * 60), false, now), "Codex weekly 50% 5d 3h");
  assert.equal(formatCodexStatus(snapshotFor(12 * 60 * 60 + 30 * 60), false, now), "Codex weekly 50% 12h 30m");
  assert.equal(formatCodexStatus(snapshotFor(45 * 60), false, now), "Codex weekly 50% 45m");
});

test("Codex usage shows limit reached instead of a percentage", () => {
  const now = 1_700_000_000_000;
  const resetAt = now / 1000 + 5 * 24 * 60 * 60 + 3 * 60 * 60;
  const snapshots = parseCodexUsagePayload({
    plan_type: "plus",
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: {
        used_percent: 100,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: resetAt,
      },
      secondary_window: null,
    },
    credits: { has_credits: false, unlimited: false, balance: "0" },
  });
  assert.equal(snapshots[0].limitReached, true);

  const usageText = formatCodexUsage(snapshots, now);
  assert.match(usageText, /weekly \[░░░░░░░░░░░░░░░░░░░░\] limit reached resets in 5d 3h/);
  assert.doesNotMatch(usageText, /% left|% used/);
  assert.match(usageText, /no additional credits/);

  assert.equal(
    formatCodexStatus(snapshots, false, now),
    "Codex weekly limit reached 5d 3h",
  );
  assert.equal(
    formatCodexStatus(snapshots, true, now),
    "Codex weekly limit reached 5d 3h Fast",
  );

  // Not reached: percentages remain.
  const normal = parseCodexUsagePayload({
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 65,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: resetAt,
      },
    },
  });
  assert.equal(normal[0].limitReached, false);
  assert.equal(formatCodexStatus(normal, false, now), "Codex weekly 35% 5d 3h");
  assert.match(formatCodexUsage(normal, now), /weekly \[\u2588{7}\u2591{13}\] 35% left/);

  // Header fallback: the reached-type header marks the snapshot.
  const headerSnapshots = parseCodexRateLimits({
    "X-Codex-Primary-Used-Percent": "100",
    "X-Codex-Primary-Window-Minutes": "300",
    "X-Codex-Primary-Reset-At": String(Math.floor(now / 1000) + 3600),
    "X-Codex-Rate-Limit-Reached-Type": "rate_limit_reached",
  });
  assert.equal(headerSnapshots[0].limitReached, true);
  assert.equal(
    formatCodexStatus(headerSnapshots, false, now),
    "Codex 5h limit reached 1h",
  );
  assert.match(formatCodexUsage(headerSnapshots, now), /5h\s+\[░░░░░░░░░░░░░░░░░░░░\] limit reached resets in 1h/);

  const normalHeaderSnapshots = parseCodexRateLimits({
    "X-Codex-Primary-Used-Percent": "50",
    "X-Codex-Primary-Window-Minutes": "300",
    "X-Codex-Primary-Reset-At": String(Math.floor(now / 1000) + 3600),
  });
  assert.equal(normalHeaderSnapshots[0].limitReached, false);
  assert.equal(formatCodexStatus(normalHeaderSnapshots, false, now), "Codex 5h 50% 1h");
});

test("Codex commands stay hidden until OAuth login becomes available", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, unknown>();
  const temporary = await mkdtemp(join(tmpdir(), "pi-codex-command-auth-"));
  const authPath = join(temporary, "auth.json");
  await writeFile(authPath, "{}");
  const pi = {
    registerCommand(name: string, definition: unknown) {
      commands.set(name, definition);
    },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  registerCodexUsageAndFast(pi, {
    getConfig: () => ({
      ...DEFAULT_CODEX_API_CONFIG,
      usageStatus: false,
      usagePollInterval: 0,
    }),
    updateConfig: () => {},
  }, { authPath });

  let loggedIn = false;
  let autocompleteRefreshes = 0;
  const ctx = context(process.cwd()) as any;
  ctx.modelRegistry = {
    isUsingOAuth: () => loggedIn,
    getAll: () => [ctx.model],
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: jwt() }),
    refresh: async () => {},
  };
  ctx.ui = {
    setStatus() {},
    notify() {},
    theme: plainTheme,
    addAutocompleteProvider: () => { autocompleteRefreshes += 1; },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ rate_limit: {} }));
  try {
    await handlers.get("session_start")?.({}, ctx);
    assert.equal(commands.has("codex-usage"), false);
    assert.equal(commands.has("codex-redeem"), false);

    loggedIn = true;
    await handlers.get("model_select")?.({}, ctx);
    assert.equal(commands.has("codex-usage"), true);
    assert.equal(commands.has("codex-redeem"), true);
    assert.equal(autocompleteRefreshes, 1);

    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(temporary, { recursive: true, force: true });
  }
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
  let redeemCommand: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
  const commands: string[] = [];
  const pi = {
    registerCommand(name: string, definition: any) {
      commands.push(name);
      if (name === "codex-usage") command = definition;
      if (name === "codex-redeem") redeemCommand = definition;
    },
    on() {},
  } as unknown as ExtensionAPI;
  registerCodexUsageAndFast(pi, {
    getConfig: () => DEFAULT_CODEX_API_CONFIG,
    updateConfig: () => {},
  }, { registerCommandsImmediately: true });
  assert.ok(command);
  assert.ok(redeemCommand);
  assert.deepEqual(commands, ["codex-usage", "codex-redeem"]);

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(payload));
  };
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<string | undefined> = [];
  const ctx = context(process.cwd()) as any;
  ctx.ui = {
    notify: (message: string, level: string) => notifications.push({ message, level }),
    setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    theme: {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bold: (text: string) => `[bold]${text}`,
    },
  };
  try {
    await command.handler("", ctx);
    assert.ok(requests.some((request) => request.url === "https://chatgpt.com/backend-api/wham/usage"
      && request.init?.method === "GET"));
    assert.ok(requests.some((request) => request.url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
      && request.init?.method === "GET"));
    const message = notifications.at(-1)?.message ?? "";
    assert.match(message, /^\[muted\]Codex usage\n\naccount · Pro\n\ncodex\n/);
    assert.match(message, /weekly \[█████████████░░░░░░░\] 65% left/);
    assert.doesNotMatch(message, /% used|5h|•|codex:/);
    assert.match(message, /\n\ngpt-5\.6-luna\n  daily \[██████████████████░░\] 90% left/);
    assert.equal(statuses.at(-1), "[muted]Codex weekly 65% 7d");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex account and redeem credits parse and display", () => {
  assert.equal(maskCodexEmail("alice@example.com"), "ali***@example.com");
  assert.equal(maskCodexEmail("ab@example.com"), "a***@example.com");
  assert.equal(maskCodexEmail("no-domain"), "***");

  const account = parseCodexAccountInfo({
    plan_type: "plus",
    email: "alice@example.com",
    user_id: "user-x",
  });
  assert.deepEqual(account, { planType: "plus", email: "alice@example.com" });
  assert.equal(parseCodexAccountInfo({ user_id: "user-x" }), undefined);

  const redeem = parseCodexRedeemCredits({
    credits: [{
      id: "RateLimitResetCredit_90c666dc336481918f61dbee048f2f0e",
      reset_type: "codex_rate_limits",
      is_supported_by_plan: true,
      status: "available",
      granted_at: "2026-07-13T18:14:16.753394Z",
      expires_at: "2026-08-12T18:14:16.753394Z",
      title: "Full reset",
      description: "Thanks for using Codex! You've been granted one free rate limit reset.",
    }],
    available_count: 1,
    total_earned_count: 0,
  });
  assert.ok(redeem);
  assert.equal(redeem.availableCount, 1);
  assert.equal(redeem.totalEarnedCount, 0);
  assert.equal(redeem.credits.length, 1);
  assert.equal(redeem.credits[0].id, "RateLimitResetCredit_90c666dc336481918f61dbee048f2f0e");
  assert.equal(redeem.credits[0].status, "available");
  assert.equal(redeem.credits[0].title, "Full reset");
  assert.ok(redeem.credits[0].grantedAt);
  assert.ok(redeem.credits[0].expiresAt);
  assert.equal(parseCodexRedeemCredits({ available_count: 0, credits: [] })?.availableCount, 0);
  assert.equal(parseCodexRedeemCredits({ credits: [] }), undefined);

  const snapshots = parseCodexUsagePayload({
    rate_limit: {
      primary_window: {
        used_percent: 100,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: Math.floor(Date.now() / 1000) + 5 * 24 * 60 * 60,
      },
    },
  });
  const text = formatCodexUsage(snapshots, Date.now(), { account, redeemCredits: redeem });
  assert.match(text, /^Codex usage\n\naccount · Plus \(ali\*\*\*@example\.com\)\n\ncodex\n/);
  assert.ok(text.includes(`\n\nrate limit redeem\n  Full reset (available, expires ${formatLocalDateTime(Date.parse("2026-08-12T18:14:16.753394Z"))})`));
  assert.doesNotMatch(text, /unknown plan/);

  const emptyRedeem = formatCodexUsage(snapshots, Date.now(), {
    account,
    redeemCredits: { availableCount: 0, credits: [] },
  });
  assert.doesNotMatch(emptyRedeem, /rate limit redeem/);
  assert.match(emptyRedeem, /account · Plus/);
});

test("Codex redeem credits sort by expiry and skip non-available cards", () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const text = formatCodexRedeemCredits({
    availableCount: 2,
    totalEarnedCount: 3,
    credits: [
      { id: "late", title: "Full reset", status: "available", expiresAt: now + 12 * day },
      { id: "redeemed", title: "Full reset", status: "redeemed" },
      { id: "early", title: "Full reset", status: "available", expiresAt: now + 3 * day },
      { id: "expired", title: "Full reset", status: "expired" },
    ],
  }, now).join("\n");
  assert.match(text, /^rate limit redeem ×2\n/);
  assert.match(text, /  Full reset \(available, expires /);
  assert.doesNotMatch(text, /redeemed|expired/);
  // The earliest expiring card is listed first.
  assert.ok(text.indexOf(`expires ${formatLocalDateTime(now + 3 * day)}`) < text.indexOf(`expires ${formatLocalDateTime(now + 12 * day)}`));
});

test("Codex usage redeem command previews then confirms before consuming", async () => {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const pi = {
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  registerCodexUsageAndFast(pi, {
    getConfig: () => DEFAULT_CODEX_API_CONFIG,
    updateConfig: () => {},
  }, { registerCommandsImmediately: true });
  const redeemCommand = commands.get("codex-redeem");
  assert.ok(redeemCommand);

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  const usagePayload = {
    plan_type: "plus",
    rate_limit: {
      limit_reached: true,
      primary_window: {
        used_percent: 100,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: Math.floor(Date.now() / 1000) + 60 * 60,
      },
    },
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/rate-limit-reset-credits")) {
      const day = 24 * 60 * 60 * 1000;
      return new Response(JSON.stringify({
        credits: [
          {
            id: "late-credit",
            status: "available",
            title: "Full reset",
            expires_at: new Date(Date.now() + 30 * day).toISOString(),
          },
          {
            id: "early-credit",
            status: "available",
            title: "Full reset",
            expires_at: new Date(Date.now() + 2 * day).toISOString(),
          },
        ],
        available_count: 2,
        total_earned_count: 2,
      }));
    }
    if (url.endsWith("/consume")) {
      return new Response(JSON.stringify({ outcome: "reset" }));
    }
    return new Response(JSON.stringify(usagePayload));
  };
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<string | undefined> = [];
  const ctx = context(process.cwd()) as any;
  ctx.hasUI = false;
  ctx.ui = {
    notify: (message: string, level: string) => notifications.push({ message, level }),
    setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    theme: {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bold: (text: string) => `[bold]${text}`,
    },
  };
  try {
    // First run: preview only, no consume request, and a pending redeem is armed.
    await redeemCommand.handler("", ctx);
    assert.equal(requests.filter((request) => request.url.endsWith("/consume")).length, 0);
    const preview = notifications.at(-1);
    assert.equal(preview?.level, "warning");
    assert.match(preview?.message ?? "", /2 rate limit reset redeem available: Full reset/);
    assert.match(preview?.message ?? "", /Run \/codex-redeem again within 10s to confirm/);

    // Second run within the window: consumes with the same redeem_request_id.
    await redeemCommand.handler("", ctx);
    const consumeRequests = requests.filter((request) => request.url.endsWith("/consume"));
    assert.equal(consumeRequests.length, 1);
    assert.equal(consumeRequests[0].method, "POST");
    const body = consumeRequests[0].body as { redeem_request_id?: string; credit_id?: string };
    assert.ok(body.redeem_request_id);
    // The earliest expiring available card is picked.
    assert.equal(body.credit_id, "early-credit");
    const success = notifications.at(-1);
    assert.equal(success?.level, "info");
    assert.match(success?.message ?? "", /✓ Rate limit reset redeemed — usage reset/);

    // Third run: a fresh preview with a new redeem_request_id.
    await redeemCommand.handler("", ctx);
    const after = notifications.at(-1);
    assert.equal(after?.level, "warning");
    assert.match(after?.message ?? "", /Run \/codex-redeem again/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex usage command wraps the notify output in muted styling", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const pi = {
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    on() {},
  } as unknown as ExtensionAPI;
  registerCodexUsageAndFast(pi, {
    getConfig: () => DEFAULT_CODEX_API_CONFIG,
    updateConfig: () => {},
  }, { registerCommandsImmediately: true });
  const usageCommand = commands.get("codex-usage");
  assert.ok(usageCommand);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    plan_type: "plus",
    rate_limit: {
      limit_reached: true,
      primary_window: {
        used_percent: 100,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: Math.floor(Date.now() / 1000) + 60 * 60,
      },
    },
  }));

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = context(process.cwd()) as any;
  ctx.hasUI = true;
  ctx.ui = {
    notify: (message: string, level: string) => notifications.push({ message, level }),
    setStatus() {},
    theme: {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bold: (text: string) => `[bold]${text}`,
    },
  };
  try {
    await usageCommand.handler("", ctx);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "info");
    assert.match(notifications[0].message, /^\[muted\]Codex usage\n\naccount · Plus/);
    assert.match(notifications[0].message, /weekly \[░░░░░░░░░░░░░░░░░░░░\] limit reached/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex usage redeem confirms via dialog when UI is available", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const pi = {
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    on() {},
  } as unknown as ExtensionAPI;
  registerCodexUsageAndFast(pi, {
    getConfig: () => DEFAULT_CODEX_API_CONFIG,
    updateConfig: () => {},
  }, { registerCommandsImmediately: true });
  const redeemCommand = commands.get("codex-redeem");
  assert.ok(redeemCommand);

  const originalFetch = globalThis.fetch;
  const consumeRequests: Array<{ redeemRequestId?: string; creditId?: string; failed: boolean }> = [];
  let consumeFails = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/rate-limit-reset-credits")) {
      const day = 24 * 60 * 60 * 1000;
      return new Response(JSON.stringify({
        credits: [
          {
            id: "early-credit",
            status: "available",
            title: "Full reset",
            expires_at: new Date(Date.now() + 3 * day).toISOString(),
          },
          {
            id: "late-credit",
            status: "available",
            title: "Full reset",
            expires_at: new Date(Date.now() + 20 * day).toISOString(),
          },
        ],
        available_count: 2,
        total_earned_count: 2,
      }));
    }
    if (url.endsWith("/consume")) {
      const body = JSON.parse(String(init?.body));
      const failed = consumeFails > 0;
      consumeRequests.push({ redeemRequestId: body.redeem_request_id, creditId: body.credit_id, failed });
      if (failed) {
        consumeFails -= 1;
        return new Response("{\"error\":\"boom\"}", { status: 500 });
      }
      return new Response(JSON.stringify({ outcome: "reset" }));
    }
    return new Response(JSON.stringify({
      rate_limit: {
        limit_reached: false,
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 7 * 24 * 60 * 60,
          reset_at: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        },
      },
    }));
  };
  const notifications: Array<{ message: string; level: string }> = [];
  const selects: Array<{ title: string; options: string[] }> = [];
  let confirmResult = true;
  let selectResult: string | undefined;
  const ctx = context(process.cwd()) as any;
  ctx.hasUI = true;
  ctx.ui = {
    notify: (message: string, level: string) => notifications.push({ message, level }),
    select: async (title: string, options: string[]) => {
      selects.push({ title, options });
      // The confirmation selector always lists "No" first and "Yes" second.
      if (options.length === 2 && options[0] === "No") {
        return confirmResult ? options[1] : options[0];
      }
      if (selectResult === "auto-first") return options[0];
      if (selectResult === "auto-last") return options[1];
      return selectResult;
    },
    setStatus() {},
    theme: {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bold: (text: string) => `[bold]${text}`,
    },
  };
  const fmt = formatLocalDateTime;
  try {
    // Escaping the card list cancels without consuming or confirming.
    selectResult = undefined;
    await redeemCommand.handler("", ctx);
    assert.equal(selects.length, 1);
    assert.equal(consumeRequests.length, 0);
    assert.match(notifications.at(-1)?.message ?? "", /Redeem cancelled — no reset credit was consumed/);

    // Card options are sorted by expiry, earliest first.
    assert.equal(selects[0].title, "Select a reset credit to redeem");
    assert.equal(selects[0].options.length, 2);
    assert.ok(selects[0].options[0].includes(`expires ${fmt(Date.now() + 3 * 24 * 60 * 60 * 1000)}`));
    assert.ok(selects[0].options[1].includes(`expires ${fmt(Date.now() + 20 * 24 * 60 * 60 * 1000)}`));

    // Picking "No" on the confirmation selector cancels without consuming.
    selectResult = "auto-first";
    confirmResult = false;
    await redeemCommand.handler("", ctx);
    assert.equal(selects.length, 3);
    const confirmSelector = selects[2];
    // The card details are in the title, matching the earlier dialog design.
    assert.match(confirmSelector.title, /^Redeem Full reset \(expires /);
    assert.equal(confirmSelector.options.length, 2);
    // "No" is the default-selected first row, so a stray Enter cannot redeem.
    assert.equal(confirmSelector.options[0], "No");
    assert.equal(confirmSelector.options[1], "Yes");
    assert.equal(consumeRequests.length, 0);
    assert.match(notifications.at(-1)?.message ?? "", /Redeem cancelled — no reset credit was consumed/);

    // Picking "Yes" redeems the card chosen earlier in a single run.
    selectResult = "auto-last";
    confirmResult = true;
    await redeemCommand.handler("", ctx);
    assert.equal(consumeRequests.length, 1);
    assert.ok(consumeRequests[0].redeemRequestId);
    assert.equal(consumeRequests[0].creditId, "late-credit");
    assert.equal(notifications.at(-1)?.level, "info");
    assert.match(notifications.at(-1)?.message ?? "", /✓ Rate limit reset redeemed — usage reset/);

    // A network failure keeps the redeem_request_id; the retry reuses it for the same card.
    consumeFails = 1;
    selectResult = "auto-first";
    await redeemCommand.handler("", ctx);
    assert.equal(notifications.at(-1)?.level, "error");
    assert.match(notifications.at(-1)?.message ?? "", /retry with the same request ID/);
    assert.equal(consumeRequests.at(-1)?.failed, true);
    const failedRequestId = consumeRequests.at(-1)?.redeemRequestId;
    await redeemCommand.handler("", ctx);
    assert.equal(consumeRequests.at(-1)?.failed, false);
    // The retry reuses the failed attempt's idempotency key.
    assert.equal(consumeRequests.at(-1)?.redeemRequestId, failedRequestId);
    assert.equal(consumeRequests.at(-1)?.creditId, "early-credit");
    assert.notEqual(failedRequestId, consumeRequests[0].redeemRequestId);
    assert.equal(notifications.at(-1)?.level, "info");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex usage redeem reports when no credits are available", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const pi = {
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    on() {},
  } as unknown as ExtensionAPI;
  registerCodexUsageAndFast(pi, {
    getConfig: () => DEFAULT_CODEX_API_CONFIG,
    updateConfig: () => {},
  }, { registerCommandsImmediately: true });
  const redeemCommand = commands.get("codex-redeem");
  assert.ok(redeemCommand);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    credits: [],
    available_count: 0,
    total_earned_count: 0,
  }));
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = context(process.cwd()) as any;
  ctx.ui = {
    notify: (message: string, level: string) => notifications.push({ message, level }),
    setStatus() {},
    theme: {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bold: (text: string) => `[bold]${text}`,
    },
  };
  try {
    await redeemCommand.handler("", ctx);
    assert.equal(notifications.at(-1)?.level, "info");
    assert.match(notifications.at(-1)?.message ?? "", /No Codex rate limit reset credits are available to redeem/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex usage status shows auth expired only while OAuth remains configured", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerCommand() {},
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const temporary = await mkdtemp(join(tmpdir(), "pi-codex-auth-expired-"));
  const authPath = join(temporary, "auth.json");
  await writeFile(authPath, JSON.stringify({ account: "a" }));
  let usageConfig = { ...DEFAULT_CODEX_API_CONFIG };
  const handle = registerCodexUsageAndFast(pi, {
    getConfig: () => usageConfig,
    updateConfig: () => {},
  }, { authPath });

  const statuses: Array<string | undefined> = [];
  const ctx = context(process.cwd()) as any;
  const codexModel = ctx.model;
  let oauthAvailable = true;
  ctx.modelRegistry.isUsingOAuth = () => oauthAvailable;
  ctx.modelRegistry.getAll = () => [codexModel];
  let credentialReads = 0;
  ctx.modelRegistry.getApiKeyAndHeaders = async () => {
    credentialReads += 1;
    return { ok: true, apiKey: jwt() };
  };
  ctx.ui = {
    setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    notify() {},
    theme: {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bold: (text: string) => `[bold]${text}`,
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "invalid token" } }), { status: 401 });
  try {
    await handlers.get("session_start")?.({}, ctx);
    // The transient syncing state must always be replaced by the terminal
    // auth error, even though the refresh itself failed.
    assert.equal(statuses.at(-1), "[error]Codex auth expired");
    assert.equal(handle.getSnapshots().length, 0);
    // Account checking must reuse its resolved OAuth client; a second
    // credential read after showing syncing could hang outside the fetch timeout.
    assert.equal(credentialReads, 1);

    // A later successful refresh clears the error and shows real usage.
    globalThis.fetch = async () => new Response(JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 30,
          limit_window_seconds: 5 * 60 * 60,
          reset_at: Math.floor(Date.now() / 1000) + 60 * 60,
        },
      },
    }));
    await handle.refreshUsage(ctx, true);
    assert.equal(statuses.at(-1), "[muted]Codex 5h 70% 1h");
    assert.equal(handle.getSnapshots()[0]?.primary?.usedPercent, 30);

    // Failure while resolving/refreshing OAuth itself is also actionable; it
    // may happen before the WHAM endpoint can return an HTTP 401.
    ctx.modelRegistry.getApiKeyAndHeaders = async () => ({
      ok: false,
      error: "token refresh failed",
    });
    await handlers.get("model_select")?.({}, ctx);
    assert.equal(statuses.at(-1), "[error]Codex auth expired");

    // /logout removes the OAuth configuration. From this point onward, no
    // refresh path may reinterpret the inactive state as an expired token.
    oauthAvailable = false;
    handle.refreshStatus(ctx);
    assert.equal(statuses.at(-1), undefined);
    assert.deepEqual(handle.getSnapshots(), []);

    // /99settings calls refreshStatus followed by a forced refresh when Other
    // providers is enabled. The forced resolution still rejects for callers,
    // but the status must remain cleared because no credential exists.
    ctx.model = { provider: "anthropic", id: "claude-test" };
    usageConfig = { ...usageConfig, allowOtherProviders: true };
    handle.refreshStatus(ctx);
    await assert.rejects(
      handle.refreshUsage(ctx, true),
      /Codex subscription OAuth is unavailable/,
    );
    assert.equal(statuses.at(-1), undefined);
  } finally {
    globalThis.fetch = originalFetch;
    handlers.get("session_shutdown")?.({}, ctx);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Codex usage status keeps the last snapshot on transient failures", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerCommand() {},
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const temporary = await mkdtemp(join(tmpdir(), "pi-codex-transient-"));
  const authPath = join(temporary, "auth.json");
  await writeFile(authPath, JSON.stringify({ account: "a" }));
  const handle = registerCodexUsageAndFast(pi, {
    getConfig: () => DEFAULT_CODEX_API_CONFIG,
    updateConfig: () => {},
  }, { authPath });

  const statuses: Array<string | undefined> = [];
  const ctx = context(process.cwd()) as any;
  ctx.ui = {
    setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    notify() {},
    theme: {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bold: (text: string) => `[bold]${text}`,
    },
  };

  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 5 * 60 * 60,
            reset_at: Math.floor(Date.now() / 1000) + 60 * 60,
          },
        },
      }));
    }
    return new Response(JSON.stringify({ error: "backend hiccup" }), { status: 500 });
  };
  try {
    await handlers.get("session_start")?.({}, ctx);
    assert.equal(handle.getSnapshots()[0]?.primary?.usedPercent, 10);
    assert.equal(statuses.at(-1), "[muted]Codex 5h 90% 1h");

    // Non-auth failures keep the last known usage instead of dropping it.
    await assert.rejects(handle.refreshUsage(ctx, true), /backend hiccup/);
    assert.equal(statuses.at(-1), "[muted]Codex 5h 90% 1h");
    assert.equal(handle.getSnapshots()[0]?.primary?.usedPercent, 10);
  } finally {
    globalThis.fetch = originalFetch;
    handlers.get("session_shutdown")?.({}, ctx);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Codex usage status shows unavailable when a first refresh fails without a snapshot", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerCommand() {},
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const temporary = await mkdtemp(join(tmpdir(), "pi-codex-unavailable-"));
  const authPath = join(temporary, "auth.json");
  await writeFile(authPath, JSON.stringify({ account: "a" }));
  registerCodexUsageAndFast(pi, {
    getConfig: () => DEFAULT_CODEX_API_CONFIG,
    updateConfig: () => {},
  }, { authPath });

  const statuses: Array<string | undefined> = [];
  const ctx = context(process.cwd()) as any;
  ctx.ui = {
    setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    notify() {},
    theme: {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bold: (text: string) => `[bold]${text}`,
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "network partition" }), { status: 502 });
  try {
    await handlers.get("session_start")?.({}, ctx);
    // A failed first refresh must not leave the transient syncing state up.
    assert.ok(statuses.includes("[muted]Codex syncing…"));
    assert.equal(statuses.at(-1), "[warning]Codex usage unavailable");
  } finally {
    globalThis.fetch = originalFetch;
    handlers.get("session_shutdown")?.({}, ctx);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Codex usage refresh times out stalled requests instead of syncing forever", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerCommand() {},
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const temporary = await mkdtemp(join(tmpdir(), "pi-codex-timeout-"));
  const authPath = join(temporary, "auth.json");
  await writeFile(authPath, JSON.stringify({ account: "a" }));
  const handle = registerCodexUsageAndFast(pi, {
    getConfig: () => DEFAULT_CODEX_API_CONFIG,
    updateConfig: () => {},
  }, { authPath, usageFetchTimeoutMs: 50 });

  const statuses: Array<string | undefined> = [];
  const ctx = context(process.cwd()) as any;
  ctx.ui = {
    setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    notify() {},
    theme: {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bold: (text: string) => `[bold]${text}`,
    },
  };

  const originalFetch = globalThis.fetch;
  let aborted = 0;
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      aborted += 1;
      reject(new DOMException("Timed out", "TimeoutError"));
    });
  });
  try {
    await handlers.get("session_start")?.({}, ctx);
    assert.equal(aborted, 1);
    // The stalled request must settle so the status moves past syncing.
    assert.equal(statuses.at(-1), "[warning]Codex usage unavailable");
    assert.equal(handle.getSnapshots().length, 0);

    // A later refresh creates a fresh request instead of awaiting the stale one.
    const started = Date.now();
    await assert.rejects(handle.refreshUsage(ctx, true), /network request failed/);
    assert.equal(aborted, 2);
    assert.ok(Date.now() - started < 5000);
    assert.equal(statuses.at(-1), "[warning]Codex usage unavailable");
  } finally {
    globalThis.fetch = originalFetch;
    handlers.get("session_shutdown")?.({}, ctx);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Codex usage ignores a late auth error from a stale account refresh", async () => {
  const pi = {
    registerCommand() {},
    on() {},
  } as unknown as ExtensionAPI;
  const handle = registerCodexUsageAndFast(pi, {
    getConfig: () => DEFAULT_CODEX_API_CONFIG,
    updateConfig: () => {},
  });

  const tokenA = jwt("acct-a");
  const tokenB = jwt("acct-b");
  let activeToken = tokenA;
  const statuses: Array<string | undefined> = [];
  const ctx = context(process.cwd()) as any;
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: activeToken });
  ctx.ui = {
    setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    notify() {},
    theme: {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bold: (text: string) => `[bold]${text}`,
    },
  };

  const payload = (usedPercent: number) => JSON.stringify({
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: Math.floor(Date.now() / 1000) + 60 * 60,
      },
    },
  });
  let accountAFetches = 0;
  let releaseStale: (() => void) | undefined;
  let markStaleStarted: (() => void) | undefined;
  const staleStarted = new Promise<void>((resolve) => {
    markStaleStarted = resolve;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const accountId = new Headers(init?.headers).get("chatgpt-account-id");
    if (accountId === "acct-a") {
      accountAFetches += 1;
      if (accountAFetches === 1) return new Response(payload(10));
      markStaleStarted?.();
      await new Promise<void>((resolve) => {
        releaseStale = resolve;
      });
      return new Response(
        JSON.stringify({ error: { message: "old token expired" } }),
        { status: 401 },
      );
    }
    assert.equal(accountId, "acct-b");
    return new Response(payload(70));
  };

  let staleRefresh: Promise<void> | undefined;
  try {
    await handle.refreshUsage(ctx, true);
    staleRefresh = handle.refreshUsage(ctx, true);
    await staleStarted;

    activeToken = tokenB;
    await handle.refreshUsage(ctx, true);
    assert.equal(handle.getSnapshots()[0]?.primary?.usedPercent, 70);
    const currentStatus = statuses.at(-1);
    assert.match(currentStatus ?? "", /Codex 5h 30%/);

    releaseStale?.();
    await assert.rejects(staleRefresh, /old token expired/);
    // Account A's late 401 must not overwrite account B's successful status.
    assert.equal(handle.getSnapshots()[0]?.primary?.usedPercent, 70);
    assert.equal(statuses.at(-1), currentStatus);
  } finally {
    releaseStale?.();
    await staleRefresh?.catch(() => {});
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
    theme: {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bold: (text: string) => `[bold]${text}`,
    },
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
    usagePollInterval: 5,
  });
  assert.deepEqual(normalizeCodexApiConfig({
    fastMode: "yes",
    searchMode: "invalid",
    usagePollInterval: 15,
  }), { ...DEFAULT_CODEX_API_CONFIG, usagePollInterval: 15 });
  assert.deepEqual(normalizeCodexApiConfig({
    usagePollInterval: -3,
  }), DEFAULT_CODEX_API_CONFIG);
  assert.equal(normalizeCodexApiConfig({ usagePollInterval: 7.7 }).usagePollInterval, 8);

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
      usagePollInterval: 5,
    });
    const document = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(document.untouched, { enabled: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Codex usage polls on an interval, throttles inside the window, and stops on shutdown", async () => {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerCommand() {},
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const temporary = await mkdtemp(join(tmpdir(), "pi-codex-poll-"));
  const authPath = join(temporary, "auth.json");
  await writeFile(authPath, JSON.stringify({}));

  let config = { ...DEFAULT_CODEX_API_CONFIG, usagePollInterval: 1 };
  registerCodexUsageAndFast(pi, {
    getConfig: () => config,
    updateConfig: () => {},
  }, { authPath });

  // Fake timers so the minute-long poll can be driven deterministically.
  const scheduled: Array<{ delay: number; cb: () => void }> = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let clearedTimers = 0;
  globalThis.setTimeout = ((cb: () => void, delay: number) => {
    const handle = { delay, cb, unref: () => {} };
    scheduled.push(handle);
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    if (handle !== undefined && handle !== null) clearedTimers += 1;
  }) as unknown as typeof clearTimeout;

  const originalFetch = globalThis.fetch;
  let usageFetches = 0;
  globalThis.fetch = async () => {
    usageFetches += 1;
    return new Response(JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 5 * 60 * 60,
          reset_at: Math.floor(Date.now() / 1000) + 60 * 60,
        },
      },
    }));
  };
  const statuses: Array<string | undefined> = [];
  const ctx = context(process.cwd()) as any;
  ctx.model = { provider: "openai-codex", id: "gpt-5.4-codex" };
  let oauthAvailable = true;
  ctx.modelRegistry.isUsingOAuth = () => oauthAvailable;
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: jwt() });
  ctx.ui = {
    setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    theme: { fg: (color: string, text: string) => `[${color}]${text}`, bold: (text: string) => `[bold]${text}` },
    notify() {},
  };

  try {
    // session_start force-refreshes once and starts the poll chain.
    const start = handlers.get("session_start")!;
    await start({}, ctx);
    await new Promise((resolve) => setImmediate(resolve)); // fire-and-forget refresh; drain microtasks
    assert.equal(usageFetches, 1);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 60_000);

    // Inside the 60s throttle the poll re-schedules without another fetch.
    const firstTick = scheduled.shift()!;
    firstTick.cb();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(usageFetches, 1);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 60_000);

    // A poll after /logout clears account state and stays silent instead of
    // reviving "Codex auth expired" from a failed credential resolution.
    oauthAvailable = false;
    scheduled.shift()!.cb();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(usageFetches, 1);
    assert.equal(statuses.at(-1), undefined);
    assert.equal(scheduled.length, 1);

    // Disabling polling stops the chain after the current round.
    config = { ...config, usagePollInterval: 0 };
    scheduled.shift()!.cb();
    assert.equal(scheduled.length, 0);
    assert.equal(usageFetches, 1);

    // A fresh logged-in session with polling disabled schedules nothing.
    oauthAvailable = true;
    const secondCtx = { ...ctx } as any;
    const secondStatuses: Array<string | undefined> = [];
    secondCtx.ui = { ...ctx.ui, setStatus: (_key: string, value: string | undefined) => secondStatuses.push(value) };
    await handlers.get("session_shutdown")!({}, ctx);
    await start({}, secondCtx as ExtensionContext);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduled.length, 0);
    assert.equal(usageFetches, 2); // force refresh still fires on session_start

    // Shutdown clears the outstanding timer.
    clearedTimers = 0;
    config = { ...config, usagePollInterval: 5 };
    await handlers.get("session_shutdown")!({}, secondCtx);
    await start({}, secondCtx as ExtensionContext);
    assert.equal(scheduled.length, 1);
    await handlers.get("session_shutdown")!({}, secondCtx);
    assert.ok(clearedTimers >= 1);
    assert.equal(scheduled.length, 1); // fake timers are not removed, but no new poll is scheduled
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.fetch = originalFetch;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Codex usage refresh is forced when settings toggle status visibility or providers", () => {
  const base = DEFAULT_CODEX_API_CONFIG;
  // Showing the status that was hidden forces a refresh.
  assert.equal(usageRefreshNeeded({ ...base, usageStatus: false }, { ...base, usageStatus: true }), true);
  // Changing cross-provider tool access forces a refresh.
  assert.equal(usageRefreshNeeded({ ...base, allowOtherProviders: false }, { ...base, allowOtherProviders: true }), true);
  assert.equal(usageRefreshNeeded({ ...base, allowOtherProviders: true }, { ...base, allowOtherProviders: false }), true);
  // Hiding the status does not fetch (the status area is cleared instead).
  assert.equal(usageRefreshNeeded({ ...base, usageStatus: true }, { ...base, usageStatus: false }), false);
  // Unrelated settings changes do not fetch.
  assert.equal(usageRefreshNeeded({ ...base, fastMode: false }, { ...base, fastMode: true }), false);
  assert.equal(usageRefreshNeeded(base, base), false);
});
