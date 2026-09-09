import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REF_ID = /^turn\d+[a-z]+\d+$/i;
const MARKER = /cite([^\n]+)/g;

/** A conflicting ID stays unresolved rather than linking old replies to a new URL. */
export type CodexCitationSources = Map<string, string | null>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\s\x00-\x1f\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    // Keep external strings out of Markdown syntax and terminal control sequences.
    return url.href.replace(/[<>`\\()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    return undefined;
  }
}

function addSource(sources: CodexCitationSources, ref: unknown, value: unknown): void {
  if (typeof ref !== "string" || !REF_ID.test(ref)) return;
  const url = safeUrl(value);
  if (!url) return;
  if (!sources.has(ref)) sources.set(ref, url);
  else if (sources.get(ref) !== url) sources.set(ref, null);
}

/** Only index Codex search results, never arbitrary user/assistant text. */
export function collectCodexCitationSources(sources: CodexCitationSources, value: unknown): void {
  const result = record(value);
  if (result?.toolName !== "codex_search" || result.isError) return;
  const details = record(result.details);
  if (Array.isArray(details?.results)) {
    for (const item of details.results) {
      const source = record(item);
      if (source) addSource(sources, source.ref_id ?? source.refId,
        source.url ?? source.source_url ?? source.sourceUrl ?? source.page_url ?? source.pageUrl);
    }
  }
  if (!Array.isArray(result.content)) return;
  for (const item of result.content) {
    const content = record(item);
    if (content?.type !== "text" || typeof content.text !== "string") continue;
    // A page's own inline link markers are NOT source IDs. Only pair a result
    // header with its immediately following citation metadata line.
    for (const block of content.text.split(/\n-{40,}\s*\n/)) {
      const match = /^[^\n]*\((https?:\/\/[^\s]+)\)\r?\ncite(turn\d+[a-z]+\d+)/i.exec(block.trim());
      if (match) addSource(sources, match[2], match[1]);
    }
  }
}

function formatProse(text: string, sources: ReadonlyMap<string, string | null>, streaming: boolean): string {
  const formatted = text.replace(MARKER, (marker, body: string) => {
    const refs = body.split("");
    if (!refs.every((ref) => REF_ID.test(ref))) return marker;
    return [...new Set(refs)].map((ref) => {
      const url = safeUrl(sources.get(ref));
      if (!url) return `\\[${ref}\\]`;
      const label = new URL(url).hostname.replace(/[[\]\\*_`]/g, "\\$&");
      return `[${label}](<${url}>)`;
    }).join(" ");
  });
  // Hide only a trailing unfinished citation, not other Codex marker families.
  return streaming
    ? formatted.replace(/(?:c(?:i(?:t(?:e(?:[^\n]*)?)?)?)?)?$/, "")
    : formatted;
}

/** Preserve code examples (including unfinished streaming fences/backticks). */
export function formatCodexCitations(
  markdown: string,
  sources: ReadonlyMap<string, string | null>,
  streaming = false,
): string {
  if (!markdown.includes("")) return markdown;
  let fence: { char: string; length: number } | undefined;
  let inlineTicks = 0;
  return markdown.split(/(?<=\n)/).map((line, index, lines) => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.char
        && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      return line;
    }
    if (!inlineTicks && delimiter) {
      fence = { char: delimiter[1][0], length: delimiter[1].length };
      return line;
    }
    if (!inlineTicks && /^(?: {4}|\t)/.test(line)) return line;
    return line.split(/(`+)/).map((part, partIndex, parts) => {
      if (/^`+$/.test(part)) {
        if (!inlineTicks) inlineTicks = part.length;
        else if (inlineTicks === part.length) inlineTicks = 0;
        return part;
      }
      return inlineTicks ? part : formatProse(part, sources,
        streaming && index === lines.length - 1 && partIndex === parts.length - 1);
    }).join("");
  }).join("");
}

interface MarkdownTransformContext {
  messageType: "user" | "assistant" | "assistant-thinking";
  isStreaming: boolean;
}

type CitationExtensionAPI = ExtensionAPI & {
  registerMarkdownTransformer?: (
    transformer: (markdown: string, context: MarkdownTransformContext) => string,
  ) => void;
};

export function registerCodexCitationRendering(pi: ExtensionAPI): void {
  // Older Pi versions still support the tools; do not patch private prototypes.
  const api = pi as CitationExtensionAPI;
  if (typeof api.registerMarkdownTransformer !== "function") return;
  const sources: CodexCitationSources = new Map();
  const rebuild = (_event: unknown, ctx: ExtensionContext) => {
    sources.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        collectCodexCitationSources(sources, entry.message);
      }
    }
  };
  api.registerMarkdownTransformer((markdown, context) => context.messageType === "user"
    ? markdown
    : formatCodexCitations(markdown, sources, context.isStreaming));
  pi.on("session_start", rebuild);
  pi.on("session_tree", rebuild);
  pi.on("before_agent_start", rebuild);
  pi.on("tool_result", (event) => { collectCodexCitationSources(sources, event); });
  pi.on("session_shutdown", () => { sources.clear(); });
}
