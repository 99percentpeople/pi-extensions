import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createCodexApiClient } from "./client.ts";
import {
  DEFAULT_CODEX_API_CONFIG,
  type CodexApiConfig,
  type CodexImageQuality,
} from "./config.ts";
import {
  reusableText,
  streamingSuffix,
  textOutput,
} from "./render.ts";

const IMAGE_MODEL = "gpt-image-2";
const MAX_REFERENCE_IMAGES = 5;
const MIN_IMAGE_PIXELS = 655_360;
const MAX_IMAGE_PIXELS = 8_294_400;
const MAX_IMAGE_EDGE = 3_840;

const ImageQualitySchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
], {
  description: "Per-call quality override. Omit to use the /99settings default; override only when the user explicitly asks for a draft or quality level",
});

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export type CodexImagePhase =
  | "preparing"
  | "authenticating"
  | "reading-references"
  | "generating"
  | "saving"
  | "completed";

export interface CodexImageDetails {
  phase: CodexImagePhase;
  savedPath?: string;
}

interface ImageResponse {
  data?: Array<{ b64_json?: unknown }>;
}

interface ImageReference {
  image_url: string;
}

function sanitizeFilePart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized || "generated_image";
}

export function normalizeCodexImageSize(value?: string): string {
  const normalized = value?.trim().toLowerCase() || "auto";
  if (normalized === "auto") return normalized;
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(normalized);
  if (!match) {
    throw new Error("Image size must be auto or WIDTHxHEIGHT, for example 1536x1024");
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new Error("GPT Image 2 width and height must both be divisible by 16");
  }
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    throw new Error(`GPT Image 2 width and height must not exceed ${MAX_IMAGE_EDGE}px`);
  }
  if (Math.max(width, height) / Math.min(width, height) > 3) {
    throw new Error("GPT Image 2 aspect ratio must be between 1:3 and 3:1");
  }
  if (pixels < MIN_IMAGE_PIXELS || pixels > MAX_IMAGE_PIXELS) {
    throw new Error(
      `GPT Image 2 size must contain between ${MIN_IMAGE_PIXELS.toLocaleString("en-US")} and ${MAX_IMAGE_PIXELS.toLocaleString("en-US")} pixels`,
    );
  }
  return `${width}x${height}`;
}

function workspacePath(cwd: string, path: string): string {
  const root = resolve(cwd);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new Error(`Image path must stay inside the current workspace: ${path}`);
  }
  return absolute;
}

function outputPath(cwd: string, toolCallId: string, requested?: string): string {
  const path = requested?.trim()
    ? requested.trim()
    : `output/codex-images/${sanitizeFilePart(toolCallId)}.png`;
  const absolute = workspacePath(cwd, path);
  return extname(absolute).toLowerCase() === ".png" ? absolute : `${absolute}.png`;
}

async function assertDoesNotExist(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing image: ${path}`);
}

async function imageDataUrl(cwd: string, path: string): Promise<string> {
  const absolute = workspacePath(cwd, path);
  const mimeType = IMAGE_MIME_TYPES[extname(absolute).toLowerCase()];
  if (!mimeType) throw new Error(`Unsupported reference image type: ${path}`);
  const bytes = await readFile(absolute);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function conversationImageDataUrl(value: ImageContent): string | undefined {
  if (!value.data || !value.mimeType.toLowerCase().startsWith("image/")) return undefined;
  if (value.data.startsWith("data:image/")) return value.data;
  const mimeType = value.mimeType.toLowerCase() === "image/jpg" ? "image/jpeg" : value.mimeType;
  return `data:${mimeType};base64,${value.data}`;
}

function imagesFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const images: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "image") continue;
    const dataUrl = conversationImageDataUrl(item as ImageContent);
    if (dataUrl) images.push(dataUrl);
  }
  return images;
}

function recentConversationImages(ctx: ExtensionContext, count: number): ImageReference[] {
  const images: string[] = [];
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
  return selected.map((image_url) => ({ image_url }));
}

function firstImage(response: ImageResponse): string {
  const value = response.data?.[0]?.b64_json;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Codex image API returned no image data");
  }
  return value;
}

function imagePhaseLabel(phase: CodexImagePhase): string {
  if (phase === "preparing") return "Preparing image request…";
  if (phase === "authenticating") return "Authenticating with Codex…";
  if (phase === "reading-references") return "Reading reference images…";
  if (phase === "generating") return "Waiting for Codex image generation…";
  if (phase === "saving") return "Saving generated PNG…";
  return "Image completed";
}

export function registerCodexImageTool(
  pi: ExtensionAPI,
  getConfig: () => CodexApiConfig = () => DEFAULT_CODEX_API_CONFIG,
  refreshUsageInBackground?: (ctx: ExtensionContext) => void,
): void {
  pi.registerTool({
    name: "codex_image",
    label: "Codex Image",
    description:
      "Generate a PNG with the Codex subscription image API, or edit with up to five local or recent conversation images. Uses the active openai-codex OAuth subscription and gpt-image-2; no API key is required.",
    promptSnippet: "Generate or edit raster images through the active Codex subscription",
    promptGuidelines: [
      "Use codex_image for requested raster images, illustrations, mockups, textures, or edits when the active model uses openai-codex OAuth, or Other providers is enabled in /99settings and Codex OAuth is logged in.",
      "For a new image, omit both reference fields. For an edit, use referenced_image_paths for local files or num_last_images_to_include for recent attached/generated conversation images; never provide both.",
      "Omit size and quality unless the user explicitly requests exact dimensions, a draft, or a quality level; otherwise official automatic sizing and the user's /99settings quality default apply.",
      "Use a new output_path and do not overwrite an existing asset; report the saved path after generation.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        minLength: 1,
        description: "Detailed image generation or editing prompt",
      }),
      referenced_image_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        maxItems: MAX_REFERENCE_IMAGES,
        description: "Local PNG, JPEG, WebP, or GIF paths used for an edit",
      })),
      num_last_images_to_include: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_REFERENCE_IMAGES,
        description: "Use the smallest number of recent attached or generated conversation images needed for an edit; do not combine with referenced_image_paths",
      })),
      size: Type.Optional(Type.String({
        minLength: 1,
        pattern: "^(auto|[1-9][0-9]*x[1-9][0-9]*)$",
        description: "Exact GPT Image 2 output size as WIDTHxHEIGHT only when required. Edges must be divisible by 16 and at most 3840px, aspect ratio 1:3 to 3:1, total 655360 to 8294400 pixels",
      })),
      quality: Type.Optional(ImageQualitySchema),
      output_path: Type.Optional(Type.String({
        minLength: 1,
        description: "Destination PNG path; defaults under output/codex-images",
      })),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const references = params.referenced_image_paths ?? [];
      const recentImageCount = params.num_last_images_to_include;
      if (references.length > MAX_REFERENCE_IMAGES) {
        throw new Error(`referenced_image_paths accepts at most ${MAX_REFERENCE_IMAGES} images`);
      }
      if (references.length > 0 && recentImageCount !== undefined) {
        throw new Error("Provide only one of referenced_image_paths or num_last_images_to_include");
      }
      const operation = references.length === 0 && recentImageCount === undefined ? "generate" : "edit";
      const savedPath = outputPath(ctx.cwd, toolCallId, params.output_path);
      const config = getConfig();
      const quality: CodexImageQuality = params.quality ?? config.imageQuality ?? "auto";
      const size = normalizeCodexImageSize(params.size);
      const update = (phase: CodexImagePhase) => onUpdate?.({
        content: [{ type: "text", text: imagePhaseLabel(phase) }],
        details: {
          phase,
          savedPath,
        },
      });
      update("preparing");
      await assertDoesNotExist(savedPath);
      update("authenticating");
      const client = await createCodexApiClient(ctx, {
        allowOtherProviders: config.allowOtherProviders,
      });
      let images: ImageReference[] | undefined;
      if (references.length > 0) {
        update("reading-references");
        images = await Promise.all(
          references.map(async (path) => ({ image_url: await imageDataUrl(ctx.cwd, path) })),
        );
      } else if (recentImageCount !== undefined) {
        update("reading-references");
        images = recentConversationImages(ctx, recentImageCount);
      }
      const request = {
        prompt: params.prompt,
        background: "auto",
        model: IMAGE_MODEL,
        quality,
        size,
      };
      update("generating");
      const response = images === undefined
        ? await client.post<ImageResponse>("images/generations", request, signal)
        : await client.post<ImageResponse>("images/edits", { ...request, images }, signal);
      const data = firstImage(response);
      update("saving");
      await mkdir(dirname(savedPath), { recursive: true });
      await writeFile(savedPath, Buffer.from(data, "base64"));
      refreshUsageInBackground?.(ctx);

      return {
        content: [
          { type: "text", text: `${operation === "edit" ? "Edited" : "Generated"} image saved to ${savedPath}` },
          { type: "image", data, mimeType: "image/png" },
        ],
        details: {
          phase: "completed",
          savedPath,
        } satisfies CodexImageDetails,
      };
    },
    renderCall(args, theme, context) {
      const text = reusableText(context);
      const references = Array.isArray(args.referenced_image_paths)
        ? args.referenced_image_paths
        : [];
      const recentImageCount = typeof args.num_last_images_to_include === "number"
        ? args.num_last_images_to_include
        : undefined;
      const operation = references.length > 0 || recentImageCount !== undefined ? "edit" : "generate";
      const prompt = typeof args.prompt === "string" && args.prompt
        ? JSON.stringify(args.prompt)
        : "";
      const referencePaths = references.filter((path): path is string => typeof path === "string");
      const referenceParameter = referencePaths.length > 0
        ? `references=[${referencePaths.map((path) => JSON.stringify(path)).join(", ")}]`
        : "";
      const recentParameter = recentImageCount !== undefined ? `recent=${recentImageCount}` : "";
      const sizeParameter = typeof args.size === "string" && args.size ? `size=${args.size}` : "";
      const qualityParameter = typeof args.quality === "string" && args.quality
        ? `quality=${args.quality}`
        : "";
      const outputParameter = typeof args.output_path === "string" && args.output_path
        ? `output=${JSON.stringify(args.output_path)}`
        : "";
      text.setText(
        theme.fg("toolTitle", theme.bold("codex_image"))
          + (operation ? ` ${theme.fg("accent", operation)}` : "")
          + (prompt ? ` ${theme.fg("muted", prompt)}` : "")
          + (referenceParameter ? ` ${theme.fg("dim", referenceParameter)}` : "")
          + (recentParameter ? ` ${theme.fg("dim", recentParameter)}` : "")
          + (sizeParameter ? ` ${theme.fg("dim", sizeParameter)}` : "")
          + (qualityParameter ? ` ${theme.fg("dim", qualityParameter)}` : "")
          + (outputParameter ? ` ${theme.fg("muted", outputParameter)}` : "")
          + streamingSuffix(theme, context.argsComplete || context.executionStarted),
      );
      return text;
    },
    renderResult(result, { isPartial }, theme, context) {
      const text = reusableText(context);
      const details = result.details as CodexImageDetails | undefined;
      const output = textOutput(result.content);
      if (isPartial) {
        text.setText(theme.fg("warning", imagePhaseLabel(details?.phase ?? "preparing")));
        return text;
      }
      if (context.isError || !details) {
        text.setText(output ? theme.fg("error", output) : theme.fg("error", "Codex image request failed"));
        return text;
      }
      text.setText(output ? theme.fg("toolOutput", output) : "");
      return text;
    },
  });
}
