import {
  collectWorkspaceFile,
  resolveWorkspaceFiles,
  type WorkspaceFileSystem,
} from "@99percentpeople/pi-workspace-files";
import {
  contentText,
  uuidv7,
  type AssistantMessage,
  type Context,
  type ImageContent,
  type OpenAICodexResponsesOptions,
  type OpenAIResponsesOptions,
  type TextContent,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stringEnum } from "./schema.ts";
import {
  DEFAULT_CODEX_API_CONFIG,
  type CodexApiConfig,
  type CodexResponseVerbosity,
} from "./config.ts";
import {
  codexToolsAllowed,
  isCodexTextModel,
  type CodexTextModel,
} from "./auth.ts";
import { createCodexApiClient, type CodexFetch } from "./client.ts";
import { applyResponseVerbosityPayload } from "./payload.ts";
import {
  reusableText,
  streamingSuffix,
  textOutput,
} from "./render.ts";

const MAX_ASK_IMAGES = 5;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const MAX_OUTPUT_TOKENS = 32768;
const CODEX_MODELS_CLIENT_VERSION = "0.0.0";
const CODEX_ASK_SYSTEM_PROMPT = `You are Codex answering a standalone request delegated by another Pi agent.
Answer the request directly and accurately. Use only the prompt and images provided in this request.
Do not assume access to the surrounding conversation, repository, files, or tools unless their relevant contents are included.
If required context is missing, say exactly what is needed.`;

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const ReasoningSchema = stringEnum(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  "Optional Codex reasoning effort. Omit to use the selected model's default",
);

const VerbositySchema = stringEnum(
  ["auto", "low", "medium", "high"],
  "Per-call answer detail override. Omit to use the /99settings default",
);

export type CodexAskReasoning = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type CodexAskPhase = "selecting-model" | "reading-images" | "asking" | "completed";
export type { CodexTextModel } from "./auth.ts";

export interface CodexAskDetails {
  phase: CodexAskPhase;
  provider?: string;
  model?: string;
  imageCount?: number;
  outputChars?: number;
  stopReason?: string;
}

function phaseLabel(phase: CodexAskPhase): string {
  if (phase === "selecting-model") return "Selecting a logged-in Codex model…";
  if (phase === "reading-images") return "Reading image inputs…";
  if (phase === "asking") return "Waiting for Codex…";
  return "Codex answer completed";
}

function normalizeConversationImage(value: ImageContent): ImageContent | undefined {
  if (!value.data || !value.mimeType.toLowerCase().startsWith("image/")) return undefined;
  if (!value.data.startsWith("data:image/")) {
    return {
      type: "image",
      data: value.data,
      mimeType: value.mimeType.toLowerCase() === "image/jpg" ? "image/jpeg" : value.mimeType,
    };
  }
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value.data);
  if (!match) return undefined;
  return { type: "image", mimeType: match[1], data: match[2] };
}

function imagesFromContent(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) return [];
  const images: ImageContent[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "image") continue;
    const normalized = normalizeConversationImage(item as ImageContent);
    if (normalized) images.push(normalized);
  }
  return images;
}

function recentConversationImages(ctx: ExtensionContext, count: number): ImageContent[] {
  const images: ImageContent[] = [];
  for (const entry of ctx.sessionManager.buildContextEntries()) {
    if (entry.type === "message" && "content" in entry.message) {
      images.push(...imagesFromContent(entry.message.content));
    } else if (entry.type === "custom_message") {
      images.push(...imagesFromContent(entry.content));
    }
  }
  const selected = images.slice(-count);
  if (selected.length !== count) {
    throw new Error(
      `Requested the last ${count} conversation image${count === 1 ? "" : "s"}, but only ${selected.length} were available`,
    );
  }
  return selected;
}

async function workspaceImage(
  files: WorkspaceFileSystem,
  path: string,
  signal?: AbortSignal,
): Promise<ImageContent> {
  const absolute = files.resolvePath(path);
  const mimeType = IMAGE_MIME_TYPES[files.extname(absolute).toLowerCase()];
  if (!mimeType) throw new Error(`Unsupported image input type: ${path}`);
  const bytes = await collectWorkspaceFile(await files.readFile(absolute, { signal }), { signal });
  return { type: "image", data: bytes.toString("base64"), mimeType };
}

function reasoningEffort(value: CodexAskReasoning | undefined): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  return value === "off" ? "none" : value;
}

function abbreviatedPrompt(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(compact.length > 180 ? `${compact.slice(0, 177)}…` : compact);
}

function answerPreview(value: string, maxChars = 320): { text: string; truncated: boolean } {
  const compact = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  if (characters.length <= maxChars) return { text: compact, truncated: false };
  return {
    text: `${characters.slice(0, Math.max(0, maxChars - 1)).join("").trimEnd()}…`,
    truncated: true,
  };
}

interface CodexModelsCatalogEntry {
  slug?: unknown;
  priority?: unknown;
  visibility?: unknown;
}

interface CodexModelsCatalog {
  models?: unknown;
}

function officialDefaultModelId(catalog: CodexModelsCatalog): string | undefined {
  if (!Array.isArray(catalog.models)) return undefined;
  return (catalog.models as CodexModelsCatalogEntry[])
    .filter((model) =>
      typeof model.slug === "string"
      && model.visibility === "list"
      && typeof model.priority === "number"
      && Number.isFinite(model.priority)
    )
    .sort((left, right) => (left.priority as number) - (right.priority as number))[0]
    ?.slug as string | undefined;
}

async function resolveOfficialCodexDefaultModelId(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  allowOtherProviders: boolean,
  signal?: AbortSignal,
  fetchImpl?: CodexFetch,
): Promise<string> {
  const client = await createCodexApiClient(
    ctx,
    { allowOtherProviders },
    fetchImpl,
  );
  const catalog = await client.get<CodexModelsCatalog>(
    `/models?client_version=${encodeURIComponent(CODEX_MODELS_CLIENT_VERSION)}`,
    signal,
  );
  const modelId = officialDefaultModelId(catalog);
  if (!modelId) {
    throw new Error("Codex did not return an official default model");
  }
  return modelId;
}

export function resolveCodexAskModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  allowOtherProviders: boolean,
  requestedModelId?: string,
  defaultOpenAIModelId?: string,
): CodexTextModel {
  if (!codexToolsAllowed(ctx, allowOtherProviders)) {
    throw new Error(
      "codex_ask requires an active openai-codex model or an openai ChatGPT OAuth model. "
        + "Enable Other providers in /99settings to use it from another model.",
    );
  }
  const candidates = ctx.modelRegistry.getAll().filter((model): model is CodexTextModel =>
    isCodexTextModel(ctx, model)
  );
  const active = ctx.model && isCodexTextModel(ctx, ctx.model) ? ctx.model : undefined;
  if (active && !candidates.some((model) => model.provider === active.provider && model.id === active.id)) {
    candidates.unshift(active);
  }
  // A bare ID remains backward compatible. Prefer the active subscription's provider,
  // then modern OpenAI OAuth; an explicit provider/ID always selects exactly that login.
  candidates.sort((left, right) => {
    const rank = (model: CodexTextModel) => model.provider === active?.provider
      ? 0 : model.provider === "openai" ? 1 : 2;
    return rank(left) - rank(right);
  });
  const requested = requestedModelId?.trim();
  if (requested) {
    const qualified = /^(openai|openai-codex)\/(.+)$/.exec(requested);
    const selected = candidates.find((model) => qualified
      ? model.provider === qualified[1] && model.id === qualified[2]
      : model.id === requested);
    if (!selected) {
      throw new Error(
        `Codex model is unavailable or not logged in: ${requested}. `
          + "Use Pi's model list to inspect openai or openai-codex OAuth model IDs; API-key logins are not supported.",
      );
    }
    return selected;
  }
  if (active) return active;
  if (defaultOpenAIModelId) {
    const selected = candidates.find((model) => model.provider === "openai" && model.id === defaultOpenAIModelId);
    if (selected) return selected;
    // When modern OAuth exists, respect its configured model instead of switching to legacy.
    if (candidates.some((model) => model.provider === "openai")) {
      throw new Error(`Pi's default OpenAI model (${defaultOpenAIModelId}) is unavailable. Select a model with /model or specify model explicitly.`);
    }
  }
  const legacy = candidates.find((model) => model.provider === "openai-codex");
  if (legacy) return legacy;
  if (candidates.length > 0) {
    throw new Error(
      "ChatGPT OAuth is available, but no default OpenAI model is selected. "
        + "Select an openai model with /model, save it as Pi's default, or specify model as openai/<model-id>.",
    );
  }
  throw new Error(
    "Codex subscription OAuth is unavailable. Run /login openai and choose Sign in with ChatGPT, "
      + "or use /login openai-codex for the legacy provider. API-key logins are not supported.",
  );
}

export async function resolveOfficialCodexAskModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  allowOtherProviders: boolean,
  requestedModelId?: string,
  signal?: AbortSignal,
  fetchImpl?: CodexFetch,
  defaultOpenAIModelId?: string,
): Promise<CodexTextModel> {
  signal?.throwIfAborted();
  const requested = requestedModelId?.trim();
  const selected = resolveCodexAskModel(ctx, allowOtherProviders, requested, defaultOpenAIModelId);
  if (requested || selected.provider === "openai") return selected;
  const officialDefault = await resolveOfficialCodexDefaultModelId(
    ctx,
    allowOtherProviders,
    signal,
    fetchImpl,
  );
  try {
    return resolveCodexAskModel(ctx, allowOtherProviders, `openai-codex/${officialDefault}`);
  } catch (error) {
    if (error instanceof Error && /unavailable or not logged in/.test(error.message)) {
      throw new Error(
        `The official Codex default model (${officialDefault}) is unavailable in Pi's model registry. Update Pi and retry.`,
      );
    }
    throw error;
  }
}

interface CompleteCapableRegistry {
  complete?: (
    model: CodexTextModel,
    context: Context,
    options?: OpenAICodexResponsesOptions | OpenAIResponsesOptions,
  ) => Promise<AssistantMessage>;
}

export async function completeCodexAsk(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  model: CodexTextModel,
  context: Context,
  options: OpenAICodexResponsesOptions,
): Promise<AssistantMessage> {
  const registry = ctx.modelRegistry as unknown as CompleteCapableRegistry;
  if (typeof registry.complete !== "function") {
    throw new Error("codex_ask requires Pi 0.84.1 or newer; update Pi and retry");
  }
  const requireOAuth = () => {
    if (!ctx.modelRegistry.isUsingOAuth(model)) {
      throw new Error("codex_ask requires a ChatGPT OAuth login; API-key fallback is not allowed. Sign in again and retry.");
    }
  };
  requireOAuth();
  const guardedPayload: NonNullable<OpenAICodexResponsesOptions["onPayload"]> = async (payload, requestModel) => {
    requireOAuth();
    const replacement = await options.onPayload?.(payload, requestModel);
    requireOAuth();
    return replacement;
  };
  if (model.api === "openai-codex-responses") {
    return registry.complete.call(ctx.modelRegistry, model, context, { ...options, onPayload: guardedPayload });
  }
  const { textVerbosity, reasoningEffort, reasoningSummary, fetch: fetchImpl = globalThis.fetch, ...shared } = options;
  let blockedRequest: Error | undefined;
  const nativeOptions: OpenAIResponsesOptions = {
    ...shared,
    // The Responses adapter maps an omitted effort to this model's supported Off
    // value. `none` and `textVerbosity` are Codex-only option names.
    reasoningEffort: reasoningEffort === "none" ? undefined : reasoningEffort,
    // A summary with omitted effort would re-enable medium reasoning in Responses.
    reasoningSummary: reasoningEffort === "none" || reasoningSummary === "off"
      ? null : reasoningSummary === "on" ? "auto" : reasoningSummary,
    onPayload: async (payload, requestModel) => {
      const replacement = await guardedPayload(payload, requestModel);
      return applyResponseVerbosityPayload(replacement === undefined ? payload : replacement, textVerbosity ?? "auto");
    },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const token = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "")?.[1];
      // A stale registry snapshot can still report OAuth after credentials change
      // on disk. Reject an actual OpenAI API key at the last HTTP boundary too.
      if (!ctx.modelRegistry.isUsingOAuth(model) || !token || token.startsWith("sk-")) {
        blockedRequest = new Error("codex_ask refused a non-OAuth request; API-key fallback is not allowed.");
        throw blockedRequest;
      }
      return fetchImpl(input, init);
    },
  };
  const response = await registry.complete.call(ctx.modelRegistry, model, context, nativeOptions);
  // The OpenAI SDK wraps fetch failures as a generic "Connection error".
  // Preserve the actionable authentication error instead of reporting a network outage.
  if (blockedRequest) throw blockedRequest;
  return response;
}

export function registerCodexAskTool(
  pi: ExtensionAPI,
  getConfig: () => CodexApiConfig = () => DEFAULT_CODEX_API_CONFIG,
  refreshUsage?: (ctx: ExtensionContext) => void,
): void {
  pi.registerTool({
    name: "codex_ask",
    label: "Ask Codex",
    description:
      "Ask a ChatGPT subscription model for a standalone text or vision second opinion through openai OAuth or legacy openai-codex. Supports translation, rewriting, analysis, and reasoning/detail controls; never uses API-key billing.",
    promptSnippet: "Ask the logged-in Codex subscription for an explicit standalone second opinion",
    promptGuidelines: [
      "Use codex_ask only when the user explicitly asks to consult Codex, requests a Codex second opinion, or delegates a specific translation, rewrite, analysis, or image-understanding task to Codex.",
      "Do not call codex_ask merely because the active model is already Codex; normal assistant responses already use Codex. Never invoke it recursively or automatically for routine work.",
      "The call is standalone and does not receive the Pi conversation or workspace automatically. Put all necessary context, target language, and output format in prompt, while avoiding unrelated secrets or large context dumps.",
      "Omit model unless the user names an exact openai or openai-codex model ID from Pi's model list. Use provider/model-id to disambiguate logins. Omit reasoning, verbosity, and max_output_tokens unless the user requests those controls.",
      "For vision, use image_paths for workspace images or num_last_images_to_include for recent conversation images; never provide both and use the smallest necessary number.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        minLength: 1,
        description: "Complete standalone request for Codex, including needed context, target language, and output format",
      }),
      model: Type.Optional(Type.String({
        minLength: 1,
        description: "Exact OAuth model ID, optionally openai/<id> or openai-codex/<id>. Default: active OpenAI subscription model, Pi's saved OpenAI default, or the legacy Codex catalog default",
      })),
      reasoning: Type.Optional(ReasoningSchema),
      verbosity: Type.Optional(VerbositySchema),
      image_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        maxItems: MAX_ASK_IMAGES,
        description: "Workspace PNG, JPEG, WebP, or GIF files to include for vision analysis",
      })),
      num_last_images_to_include: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_ASK_IMAGES,
        description: "Include recent attached/generated conversation images; do not combine with image_paths",
      })),
      max_output_tokens: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_OUTPUT_TOKENS,
        description: `Requested output cap only when explicitly needed; defaults to ${DEFAULT_MAX_OUTPUT_TOKENS}. Subscription backends may ignore it`,
      })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = getConfig();
      if (config.askEnabled === false) {
        throw new Error("codex_ask is disabled in /99settings > Codex API > Tools");
      }
      const paths = params.image_paths ?? [];
      const recentCount = params.num_last_images_to_include;
      if (paths.length > 0 && recentCount !== undefined) {
        throw new Error("Provide only one of image_paths or num_last_images_to_include");
      }
      const update = (phase: CodexAskPhase, details: Partial<CodexAskDetails> = {}) => onUpdate?.({
        content: [{ type: "text", text: phaseLabel(phase) }],
        details: { phase, ...details } satisfies CodexAskDetails,
      });

      update("selecting-model");
      const settings = pi.getSettings?.();
      const selected = await resolveOfficialCodexAskModel(
        ctx,
        config.allowOtherProviders,
        params.model,
        signal,
        undefined,
        settings?.defaultProvider === "openai" ? settings.defaultModel : undefined,
      );

      let images: ImageContent[] = [];
      if (paths.length > 0) {
        update("reading-images", { model: selected.id, imageCount: paths.length });
        const files = resolveWorkspaceFiles(pi, ctx.cwd);
        images = await Promise.all(paths.map((path) => workspaceImage(files, path, signal)));
      } else if (recentCount !== undefined) {
        update("reading-images", { model: selected.id, imageCount: recentCount });
        images = recentConversationImages(ctx, recentCount);
      }
      if (images.length > 0 && !selected.input.includes("image")) {
        throw new Error(`Codex model ${selected.id} does not accept image input`);
      }

      const requestedReasoning = params.reasoning as CodexAskReasoning | undefined;
      if (requestedReasoning && requestedReasoning !== "off" && !selected.reasoning) {
        throw new Error(`Codex model ${selected.id} does not support reasoning controls`);
      }
      if (requestedReasoning && selected.reasoning
        && selected.thinkingLevelMap?.[requestedReasoning] === null) {
        throw new Error(`Codex model ${selected.id} does not support ${requestedReasoning} reasoning`);
      }
      const verbosity = (params.verbosity ?? config.responseVerbosity) as CodexResponseVerbosity;

      const userContent: Array<TextContent | ImageContent> = [
        { type: "text", text: params.prompt },
        ...images,
      ];
      update("asking", { model: selected.id, imageCount: images.length });
      const response = await completeCodexAsk(
        ctx,
        selected,
        {
          systemPrompt: CODEX_ASK_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
        },
        {
          maxTokens: params.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          signal,
          cacheRetention: "none",
          sessionId: uuidv7(),
          serviceTier: config.fastMode ? "priority" : undefined,
          reasoningEffort: reasoningEffort(requestedReasoning),
          textVerbosity: verbosity === "auto" ? undefined : verbosity,
        },
      );
      signal?.throwIfAborted();
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(`Codex answer ${response.stopReason === "aborted" ? "aborted" : "failed"}: ${response.errorMessage || "Unknown error"}`);
      }
      const answer = contentText(response.content).trim();
      if (!answer) throw new Error("Codex returned no text answer");
      const output = response.stopReason === "length"
        ? `${answer}\n\n[Codex stopped at an output limit]`
        : answer;
      const details: CodexAskDetails = {
        phase: "completed",
        provider: selected.provider,
        model: selected.id,
        imageCount: images.length,
        outputChars: output.length,
        stopReason: response.stopReason,
      };
      if (selected.provider === "openai-codex") refreshUsage?.(ctx);
      return {
        content: [{ type: "text", text: output }],
        details,
        usage: response.usage,
      };
    },
    renderCall(args, theme, context) {
      const text = reusableText(context);
      const prompt = abbreviatedPrompt(args.prompt);
      const model = typeof args.model === "string" && args.model ? `model=${args.model}` : "";
      const reasoning = typeof args.reasoning === "string" && args.reasoning ? `reasoning=${args.reasoning}` : "";
      const verbosity = typeof args.verbosity === "string" && args.verbosity ? `detail=${args.verbosity}` : "";
      const imageCount = Array.isArray(args.image_paths)
        ? args.image_paths.length
        : typeof args.num_last_images_to_include === "number"
          ? args.num_last_images_to_include
          : 0;
      text.setText(
        theme.fg("toolTitle", theme.bold("codex_ask"))
          + (prompt ? ` ${theme.fg("muted", prompt)}` : "")
          + (model ? ` ${theme.fg("accent", model)}` : "")
          + (reasoning ? ` ${theme.fg("dim", reasoning)}` : "")
          + (verbosity ? ` ${theme.fg("dim", verbosity)}` : "")
          + (imageCount ? ` ${theme.fg("dim", `images=${imageCount}`)}` : "")
          + streamingSuffix(theme, context.argsComplete || context.executionStarted || !context.isPartial),
      );
      return text;
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = reusableText(context);
      const details = result.details as CodexAskDetails | undefined;
      const output = textOutput(result.content);
      if (isPartial) {
        text.setText(theme.fg("warning", phaseLabel(details?.phase ?? "selecting-model")));
        return text;
      }
      if (context.isError || !details) {
        text.setText(output ? theme.fg("error", output) : theme.fg("error", "Codex answer failed"));
        return text;
      }
      if (expanded) {
        text.setText(output ? theme.fg("toolOutput", output) : "");
        return text;
      }
      const preview = answerPreview(output);
      const model = details.model
        ? ` with ${details.provider === "openai" ? "openai/" : ""}${details.model}`
        : "";
      const length = details.outputChars === undefined ? "" : ` · ${details.outputChars.toLocaleString("en-US")} chars`;
      const expandHint = preview.truncated
        ? theme.fg("muted", " (") + (context.keyHint?.("app.tools.expand", "to expand") ?? "expand tools to view") + theme.fg("muted", ")")
        : "";
      const summary = theme.fg("success", `Codex answered${model}`)
        + theme.fg("muted", length)
        + expandHint;
      text.setText(preview.text
        ? `\n${theme.fg("toolOutput", preview.text)}\n${summary}`
        : summary);
      return text;
    },
  });
}
