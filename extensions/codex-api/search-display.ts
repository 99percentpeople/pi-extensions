export interface CodexSearchSource {
  type?: string;
  refId?: string;
  title: string;
  domain?: string;
  url?: string;
  snippet?: string;
}

export type CodexSearchDisplay =
  | { kind: "sources"; sources: CodexSearchSource[] }
  | { kind: "document"; source?: CodexSearchSource; body: string }
  | { kind: "data"; body: string };

export type CodexSearchDisplayLineRole = "title" | "url" | "body" | "hint";

export interface CodexSearchDisplayLine {
  role: CodexSearchDisplayLineRole;
  text: string;
}

const SOURCE_PREVIEW_COUNT = 3;
const DOCUMENT_PREVIEW_LINES = 10;
const RESULT_SEPARATOR = /\s*-{40,}\s*/;
const CITATION_MARKER = /cite[^]*/g;
const WORD_LIMIT = /\[wordlim:\s*[^\]]+\]/gi;
const SEARCH_METADATA = /^(?:(?:Published|Crawled):\s*[^;]+;\s*)+/i;
const URL_DECODE_PASSES = 12;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const field = value[name];
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  return undefined;
}

function cleanInline(value: string): string {
  return value
    .replace(CITATION_MARKER, "")
    .replace(WORD_LIMIT, "")
    .trim()
    .replace(SEARCH_METADATA, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeRepeatedUrlEncoding(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < URL_DECODE_PASSES; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    // The search service can return duplicate URLs with their percent escapes
    // encoded many times. Canonicalize for display and duplicate detection;
    // this never changes the raw ToolResult passed to the model.
    const url = new URL(decodeRepeatedUrlEncoding(value));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function domainFor(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function normalizeSource(value: unknown): CodexSearchSource | undefined {
  const item = record(value);
  if (!item) return undefined;
  const url = safeUrl(stringField(item, "url", "source_url", "sourceUrl", "page_url", "pageUrl"));
  const domain = stringField(item, "domain", "source_domain", "sourceDomain") ?? domainFor(url);
  const title = cleanInline(stringField(item, "title", "name", "caption") ?? domain ?? url ?? "Search result");
  const snippetValue = stringField(item, "snippet", "description", "text", "content");
  const cleanedSnippet = snippetValue ? cleanInline(snippetValue) : undefined;
  let snippet = cleanedSnippet && !/^Image:/i.test(cleanedSnippet) ? cleanedSnippet : undefined;
  if (snippet === title) snippet = undefined;
  else if (snippet?.startsWith(title)) {
    snippet = snippet.slice(title.length).replace(/^[\s.…:|—-]+/, "").trim() || undefined;
  }
  const refId = stringField(item, "ref_id", "refId");
  const type = stringField(item, "type");
  if (!url && !domain && !snippet && !refId) return undefined;
  return { type, refId, title, domain, url, snippet };
}

function rawSourceBlocks(output: string): CodexSearchSource[] {
  const sources: CodexSearchSource[] = [];
  for (const block of output.split(RESULT_SEPARATOR)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const heading = /^(.*?)\s+\((https?:\/\/[^\s)]+)\)\s*$/.exec(lines[0]);
    if (!heading) continue;
    const title = cleanInline(heading[1]);
    const url = safeUrl(heading[2]);
    const candidates = lines.slice(1)
      .map(cleanInline)
      .filter((line) => line && !/^Image:/i.test(line) && !/^\d+$/.test(line));
    const snippet = candidates.find((line) => line !== title && line.length >= 20);
    sources.push({ title, url, domain: domainFor(url), snippet });
  }
  return sources;
}

function removeDocumentLinePrefix(line: string): string {
  return line.replace(/^(?:L\d+:\s*)+/, "").trim();
}

function isDocumentChrome(line: string): boolean {
  return /^\*?\s*\[(?:Button|Input):/i.test(line)
    || /^(?:\*\s*)+$/.test(line)
    || /^(?:\*\s*)?(?:L\d+:\s*)+$/.test(line);
}

export function cleanCodexSearchOutput(output: string): string {
  const lines = output
    .split(RESULT_SEPARATOR)
    .join("\n\n")
    .split("\n")
    .map((line) => cleanInline(removeDocumentLinePrefix(line)))
    .filter((line) => line && !/^Image:/i.test(line) && !isDocumentChrome(line));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function cleanCodexDocumentOutput(output: string): string {
  let lines = output.split(RESULT_SEPARATOR).join("\n\n").split("\n");
  const firstHeading = lines.findIndex((line) => /^#{1,6}\s+/.test(removeDocumentLinePrefix(line)));
  if (firstHeading >= 0 && firstHeading <= 30) lines = lines.slice(firstHeading);
  return cleanCodexSearchOutput(lines.join("\n"));
}

function uniqueSources(results: unknown[] | undefined, output: string): CodexSearchSource[] {
  const candidates = (results ?? []).map(normalizeSource).filter((value): value is CodexSearchSource => value !== undefined);
  const sources = candidates.length > 0 ? candidates : rawSourceBlocks(output);
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.url ?? source.refId ?? `${source.title}\n${source.snippet ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function documentBody(output: string, source: CodexSearchSource | undefined): string {
  const lines = cleanCodexDocumentOutput(output).split("\n");
  if (!source) return lines.join("\n");
  while (lines.length > 0) {
    const first = lines[0];
    const isHeading = first === source.title
      || (source.url !== undefined && first.includes(source.url))
      || (source.domain !== undefined && first === source.domain);
    if (!isHeading) break;
    lines.shift();
  }
  return lines.join("\n").trim();
}

export function createCodexSearchDisplay(
  params: Record<string, unknown>,
  output: string,
  results?: unknown[],
): CodexSearchDisplay {
  const sources = uniqueSources(results, output);
  if ((hasItems(params.search_query) || hasItems(params.image_query)) && sources.length > 0) {
    return { kind: "sources", sources };
  }
  if (hasItems(params.open) || hasItems(params.click) || hasItems(params.find) || hasItems(params.screenshot)) {
    return { kind: "document", source: sources[0], body: documentBody(output, sources[0]) };
  }
  return { kind: "data", body: cleanCodexSearchOutput(output) };
}

function sourceLines(source: CodexSearchSource, index: number, expanded: boolean): CodexSearchDisplayLine[] {
  const location = expanded ? source.url ?? source.domain : source.domain ?? source.url;
  const lines: CodexSearchDisplayLine[] = [{ role: "title", text: `${index + 1}. ${source.title}` }];
  if (location) lines.push({ role: "url", text: `   ${location}` });
  if (source.snippet) {
    const snippet = !expanded && source.snippet.length > 110
      ? `${source.snippet.slice(0, 109).trimEnd()}…`
      : source.snippet;
    lines.push({ role: "body", text: `   ${snippet}` });
  }
  return lines;
}

function appendExpandHint(text: string, expandHint?: string): string {
  return expandHint ? `${text} (${expandHint})` : text;
}

function excerptLines(body: string, expanded: boolean, expandHint?: string): CodexSearchDisplayLine[] {
  const all = body.split("\n").filter(Boolean);
  const shown = expanded ? all : all.slice(0, DOCUMENT_PREVIEW_LINES);
  const lines: CodexSearchDisplayLine[] = shown.map((text) => ({ role: "body", text }));
  if (!expanded && shown.length < all.length) {
    lines.push({
      role: "hint",
      text: appendExpandHint(`… ${all.length - shown.length} more lines`, expandHint),
    });
  }
  return lines;
}

export function formatCodexSearchDisplay(
  display: CodexSearchDisplay,
  expanded: boolean,
  expandHint?: string,
): CodexSearchDisplayLine[] {
  if (display.kind === "sources") {
    const shown = expanded ? display.sources : display.sources.slice(0, SOURCE_PREVIEW_COUNT);
    const lines: CodexSearchDisplayLine[] = [];
    shown.forEach((source, index) => lines.push(...sourceLines(source, index, expanded)));
    if (!expanded && shown.length < display.sources.length) {
      lines.push({
        role: "hint",
        text: appendExpandHint(`… ${display.sources.length - shown.length} more results`, expandHint),
      });
    }
    return lines;
  }

  if (display.kind === "document") {
    const lines: CodexSearchDisplayLine[] = [];
    if (display.source) {
      lines.push({ role: "title", text: display.source.title });
      if (display.source.url) lines.push({ role: "url", text: display.source.url });
    }
    lines.push(...excerptLines(display.body, expanded, expandHint));
    return lines;
  }

  return excerptLines(display.body, expanded, expandHint);
}
