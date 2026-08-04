export interface CodexSearchSource {
  type?: string;
  refId?: string;
  title: string;
  domain?: string;
  url?: string;
  snippet?: string;
}

export interface CodexSearchDocument {
  source?: CodexSearchSource;
  body: string;
}

export type CodexSearchLookupType = "weather" | "finance" | "sports" | "time" | "data";

export interface CodexSearchLookupSection {
  title?: string;
  lines: string[];
}

export interface CodexSearchLookup {
  type: CodexSearchLookupType;
  /** Zero-based position of the corresponding item in the tool arguments. */
  requestIndex?: number;
  title: string;
  summary?: string;
  sections: CodexSearchLookupSection[];
}

export type CodexSearchDisplay =
  | { kind: "sources"; sources: CodexSearchSource[] }
  | {
      kind: "document";
      source?: CodexSearchSource;
      body: string;
      /** One entry per open/click/find/screenshot result block. */
      documents?: CodexSearchDocument[];
    }
  | { kind: "lookups"; lookups: CodexSearchLookup[] }
  | { kind: "data"; body: string };

export type CodexSearchDisplayLineRole =
  | "title"
  | "url"
  | "body"
  | "hint"
  | "warning"
  | "error";

export interface CodexSearchDisplayLine {
  role: CodexSearchDisplayLineRole;
  text: string;
  /** Styled keyHint kept separate so renderers do not recolor it. */
  expandHint?: string;
}

const SOURCE_PREVIEW_COUNT = 3;
const DOCUMENT_PREVIEW_LINES = 10;
const MULTI_DOCUMENT_PREVIEW_COUNT = 3;
const MULTI_DOCUMENT_PREVIEW_LINES = 5;
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

function rawSourceBlocks(output: string, imageResults = false): CodexSearchSource[] {
  const sources: CodexSearchSource[] = [];
  for (const block of output.split(RESULT_SEPARATOR)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const heading = /^(.*?)\s+\((https?:\/\/[^\s)]+)\)\s*$/.exec(lines[0]);
    if (!heading) continue;
    const pageTitle = cleanInline(heading[1]);
    const url = safeUrl(heading[2]);
    const imageHeading = imageResults
      ? lines.slice(1)
          .map((line) => line.replace(CITATION_MARKER, "").trim())
          .find((line) => /^#{1,6}\s+/.test(line))
      : undefined;
    const title = imageHeading ? cleanInline(imageHeading) : pageTitle;
    const candidates = lines.slice(1)
      .map(cleanInline)
      .filter((line) => line
        && line !== title
        && line !== pageTitle
        && !/^Image:/i.test(line)
        && !/^\d+$/.test(line));
    const snippet = candidates.find((line) => line.length >= 20);
    sources.push({ title, url, domain: domainFor(url), snippet });
  }
  return sources;
}

function removeDocumentLinePrefix(line: string): string {
  return line.replace(/^(?:L\d+:\s*)+/, "").trim();
}

function isDocumentChrome(line: string): boolean {
  return /^\*?\s*\[(?:Button|Input)(?::[^\]]*)?\]\s*$/i.test(line)
    || /^(?:\*\s*)+$/.test(line)
    || /^(?:\*\s*)?(?:L\d+:\s*)+$/.test(line);
}

function cleanDocumentLine(line: string): string {
  const cleaned = cleanInline(removeDocumentLinePrefix(line));
  return cleanInline(cleaned.replace(/(?:^|\s)L\d+:\s*/g, " "));
}

export function cleanCodexSearchOutput(output: string): string {
  const lines = output
    .split(RESULT_SEPARATOR)
    .join("\n\n")
    .split("\n")
    .map(cleanDocumentLine)
    .filter((line) => line && !/^Image:/i.test(line) && !isDocumentChrome(line));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function requestedLookupType(
  params: Record<string, unknown>,
): CodexSearchLookupType | undefined {
  const requested = (["weather", "finance", "sports", "time"] as const)
    .filter((type) => hasItems(params[type]));
  return requested.length === 1 ? requested[0] : undefined;
}

function lookupIdentity(
  block: string,
  params: Record<string, unknown>,
  fallbackIndex: number,
): { type: CodexSearchLookupType; index: number } | undefined {
  const match = /(?:turn\d+)?(forecast|weather|finance|sports|time)(\d+)/i.exec(block);
  if (match) {
    const type = /^(?:forecast|weather)$/i.test(match[1])
      ? "weather"
      : match[1].toLowerCase() as CodexSearchLookupType;
    if (!hasItems(params[type])) return undefined;
    return { type, index: Number(match[2]) };
  }
  const type = requestedLookupType(params);
  return type ? { type, index: fallbackIndex } : undefined;
}

function lookupCommand(
  params: Record<string, unknown>,
  type: CodexSearchLookupType,
  index: number,
): Record<string, unknown> | undefined {
  return record((params[type] as unknown[] | undefined)?.[index]);
}

function dedupeLocation(value: string): string {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.filter((part, index) =>
    index === 0 || part.toLowerCase() !== parts[index - 1].toLowerCase()
  ).join(", ");
}

function weatherAlertSummaries(block: string): string[] {
  const summaries: string[] = [];
  for (const match of block.matchAll(/summary='((?:\\.|[^'])*)'/g)) {
    const summary = cleanInline(match[1]
      .replace(/\\n/g, " ")
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\"));
    if (summary && !summaries.includes(summary)) summaries.push(summary);
  }
  return summaries;
}

function formatForecastLine(line: string): string {
  const match = /^([^:]+):\s*(.*?),\s*High:\s*(.*?),\s*Low:\s*(.*)$/i.exec(line);
  if (!match) return line;
  return `${match[1]} · ${match[2]} · H ${match[3]} · L ${match[4]}`;
}

function weatherLookup(block: string): CodexSearchLookup {
  const lines = cleanCodexSearchOutput(block).split("\n").filter(Boolean);
  const heading = lines.find((line) => /^Weather for\s+/i.test(line));
  const current = lines.find((line) => /^Current Conditions:/i.test(line));
  const forecastStart = lines.findIndex((line) => /^Daily Forecast:?$/i.test(line));
  const alertsStart = lines.findIndex((line) => /^Severe weather alerts:?$/i.test(line));
  const forecastEnd = alertsStart >= 0 ? alertsStart : lines.length;
  const forecasts = forecastStart >= 0
    ? lines.slice(forecastStart + 1, forecastEnd).map(formatForecastLine)
    : [];
  const alerts = weatherAlertSummaries(block);
  const location = dedupeLocation(
    (heading ?? "Weather").replace(/^Weather for\s+/i, "").replace(/:$/, ""),
  );
  const sections: CodexSearchLookupSection[] = [];
  if (forecasts.length > 0) sections.push({ title: "Forecast", lines: forecasts });
  if (alerts.length > 0) sections.push({ title: "Alerts", lines: alerts });
  const knownLines = new Set([heading, current, "Daily Forecast:", "Daily Forecast", "Severe weather alerts:", "Severe weather alerts"]);
  if (sections.length === 0) {
    const remaining = lines.filter((line) => !knownLines.has(line));
    if (remaining.length > 0) sections.push({ lines: remaining });
  }
  return {
    type: "weather",
    title: location && location !== "Weather" ? `Weather · ${location}` : "Weather",
    ...(current ? { summary: current.replace(/^Current Conditions:\s*/i, "") } : {}),
    sections,
  };
}

function parsedNumber(value: string | undefined): number | undefined {
  if (!value || /^None$/i.test(value)) return undefined;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatNumber(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function financeLookup(block: string): CodexSearchLookup {
  const text = cleanInline(block);
  const identity = /^(.+?)\s+\(([^()]+)\)\s+is\s+an?\s+(\w+)\s+in\s+the\s+(.+?)\s+market\./i.exec(text);
  const priceMatch = /The price is\s+([-+]?\d[\d,]*(?:\.\d+)?)\s+(\w+)\s+currently/i.exec(text);
  const changeMatch = /with a change of\s+([-+]?\d[\d,]*(?:\.\d+)?)\s+\(([-+]?\d[\d,]*(?:\.\d+)?)%\)/i.exec(text);
  const highMatch = /intraday high is\s+(None|[-+]?\d[\d,]*(?:\.\d+)?)\s+\w+\s+and the intraday low is\s+(None|[-+]?\d[\d,]*(?:\.\d+)?)\s+\w+/i.exec(text);
  const openMatch = /latest open price was\s+(None|[-+]?\d[\d,]*(?:\.\d+)?)\s+\w+/i.exec(text);
  const volumeMatch = /intraday volume is\s+([-+]?\d[\d,]*(?:\.\d+)?)/i.exec(text);
  const capMatch = /market cap is\s+([-+]?\d[\d,]*(?:\.\d+)?)/i.exec(text);
  const peMatch = /PE ratio is\s+([-+]?\d[\d,]*(?:\.\d+)?)/i.exec(text);
  const epsMatch = /EPS ratio is\s+([-+]?\d[\d,]*(?:\.\d+)?)/i.exec(text);
  const tradeMatch = /latest trade time is\s+(.+?)(?:\.|$)/i.exec(text);
  const price = parsedNumber(priceMatch?.[1]);
  const change = parsedNumber(changeMatch?.[1]);
  const currency = priceMatch?.[2] ?? "";
  const summaryParts: string[] = [];
  if (price !== undefined) summaryParts.push(`${formatNumber(price, 4)}${currency ? ` ${currency}` : ""}`);
  if (change !== undefined) {
    const previous = price === undefined ? undefined : price - change;
    const percent = previous && previous !== 0
      ? change / previous * 100
      : parsedNumber(changeMatch?.[2]);
    summaryParts.push(
      `${change > 0 ? "+" : ""}${formatNumber(change, 4)}`
        + (percent === undefined ? "" : ` (${percent > 0 ? "+" : ""}${formatNumber(percent)}%)`),
    );
  }
  const high = parsedNumber(highMatch?.[1]);
  const low = parsedNumber(highMatch?.[2]);
  const open = parsedNumber(openMatch?.[1]);
  const volume = parsedNumber(volumeMatch?.[1]);
  const marketCap = parsedNumber(capMatch?.[1]);
  const pe = parsedNumber(peMatch?.[1]);
  const eps = parsedNumber(epsMatch?.[1]);
  const details: string[] = [];
  const day = [
    open === undefined ? "" : `Open ${formatNumber(open, 4)}`,
    high === undefined ? "" : `High ${formatNumber(high, 4)}`,
    low === undefined ? "" : `Low ${formatNumber(low, 4)}`,
  ].filter(Boolean);
  if (day.length > 0) details.push(day.join(" · "));
  const scale = [
    volume === undefined ? "" : `Volume ${formatCompactNumber(volume)}`,
    marketCap === undefined ? "" : `Market cap ${formatCompactNumber(marketCap)}${currency ? ` ${currency}` : ""}`,
  ].filter(Boolean);
  if (scale.length > 0) details.push(scale.join(" · "));
  const ratios = [
    pe === undefined ? "" : `P/E ${formatNumber(pe)}`,
    eps === undefined ? "" : `EPS ${formatNumber(eps)}`,
  ].filter(Boolean);
  if (ratios.length > 0) details.push(ratios.join(" · "));
  if (tradeMatch?.[1]) details.push(`Updated ${tradeMatch[1]}`);
  const fallbackTitle = identity ? `${identity[1]} (${identity[2]})` : "Finance";
  return {
    type: "finance",
    title: identity
      ? `${fallbackTitle} · ${identity[3].toLowerCase()} · ${identity[4]}`
      : fallbackTitle,
    ...(summaryParts.length > 0 ? { summary: summaryParts.join(" · ") } : {}),
    sections: details.length > 0 ? [{ lines: details }] : [{ lines: [text] }],
  };
}

function sportsLookup(
  block: string,
  command: Record<string, unknown> | undefined,
): CodexSearchLookup {
  const lines = cleanCodexSearchOutput(block).split("\n").filter(Boolean);
  const sections: CodexSearchLookupSection[] = [];
  let current: CodexSearchLookupSection = { lines: [] };
  for (const line of lines) {
    const heading = /^(?:Conference|Division|League|Week|Date|Group):\s*(.+)$/i.exec(line);
    if (heading) {
      if (current.title || current.lines.length > 0) sections.push(current);
      current = { title: heading[1], lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.title || current.lines.length > 0) sections.push(current);
  const standings = command?.fn === "standings";
  if (standings) {
    for (const section of sections) {
      section.lines = section.lines.map((line, index) =>
        /\b\d+-\d+\s*$/.test(line) ? `${index + 1}. ${line}` : line
      );
    }
  }
  const league = typeof command?.league === "string" ? command.league.toUpperCase() : "Sports";
  const action = command?.fn === "standings" ? "standings" : command?.fn === "schedule" ? "schedule" : "results";
  const only = sections.length === 1 && !sections[0].title && sections[0].lines.length === 1
    ? sections[0].lines[0]
    : undefined;
  return {
    type: "sports",
    title: `${league} ${action}`,
    ...(only ? { summary: only } : {}),
    sections: only ? [] : sections,
  };
}

function timeLookup(block: string, command: Record<string, unknown> | undefined): CodexSearchLookup {
  const text = cleanCodexSearchOutput(block).replace(/\n+/g, " ");
  const match = /The time in\s+(UTC[^\s]+)\s+is\s+(.+)$/i.exec(text);
  const offset = match?.[1] ?? (typeof command?.utc_offset === "string" ? `UTC${command.utc_offset}` : "Time");
  return {
    type: "time",
    title: `Time · ${offset}`,
    ...(match?.[2] ? { summary: match[2] } : { summary: text }),
    sections: [],
  };
}

function lookupResults(
  output: string,
  params: Record<string, unknown>,
): CodexSearchLookup[] {
  const blocks = output.split(RESULT_SEPARATOR).map((block) => block.trim()).filter(Boolean);
  const lookups: CodexSearchLookup[] = [];
  blocks.forEach((block, blockIndex) => {
    if (/^(?:Found no tool response|Internal Error|Error parsing function call)/i.test(cleanInline(block))) {
      return;
    }
    const identity = lookupIdentity(block, params, blockIndex);
    if (!identity) return;
    const command = lookupCommand(params, identity.type, identity.index);
    let lookup: CodexSearchLookup | undefined;
    if (identity.type === "weather") lookup = weatherLookup(block);
    else if (identity.type === "finance") lookup = financeLookup(block);
    else if (identity.type === "sports") lookup = sportsLookup(block, command);
    else if (identity.type === "time") lookup = timeLookup(block, command);
    if (lookup) lookups.push({ ...lookup, requestIndex: identity.index });
  });
  return lookups;
}

function cleanCodexDocumentOutput(output: string): string {
  let lines = output.split(RESULT_SEPARATOR).join("\n\n").split("\n");
  const firstHeading = lines.findIndex((line) => /^#{1,6}\s+/.test(removeDocumentLinePrefix(line)));
  if (firstHeading >= 0 && firstHeading <= 30) lines = lines.slice(firstHeading);
  return cleanCodexSearchOutput(lines.join("\n"));
}

function uniqueSources(
  results: unknown[] | undefined,
  output: string,
  imageResults = false,
): CodexSearchSource[] {
  const candidates = (results ?? []).map(normalizeSource).filter((value): value is CodexSearchSource => value !== undefined);
  const sources = candidates.length > 0 ? candidates : rawSourceBlocks(output, imageResults);
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

function documentSourceFromBlock(block: string): CodexSearchSource | undefined {
  const first = block.split("\n").map((line) => line.trim()).find(Boolean);
  if (!first) return undefined;
  const heading = /^(.*?)\s*\((https?:\/\/[^)]*)?\)\s*$/.exec(first);
  if (!heading) return undefined;
  const url = safeUrl(heading[2]);
  const parsedTitle = cleanInline(heading[1]);
  const title = parsedTitle || domainFor(url) || "Opened page";
  if (!parsedTitle && !url) return undefined;
  return {
    ...(/^Internal Error$/i.test(title) ? { type: "error" } : {}),
    title,
    ...(url ? { domain: domainFor(url), url } : {}),
  };
}

function mergeDocumentSource(
  blockSource: CodexSearchSource | undefined,
  resultSources: CodexSearchSource[],
  index: number,
): CodexSearchSource | undefined {
  if (!blockSource) return resultSources[index];
  const matched = resultSources.find((source) =>
    (blockSource.url !== undefined && source.url === blockSource.url)
    || source.title === blockSource.title
  );
  if (!matched) return blockSource;
  return {
    ...blockSource,
    ...matched,
    type: blockSource.type ?? matched.type,
    title: matched.title || blockSource.title,
    domain: matched.domain ?? blockSource.domain,
    url: matched.url ?? blockSource.url,
  };
}

function documentBody(output: string, source: CodexSearchSource | undefined): string {
  const lines = cleanCodexDocumentOutput(output).split("\n");
  if (source) {
    while (lines.length > 0) {
      const first = lines[0];
      const headingText = first.replace(/\s+\([^)]*\)\s*$/, "");
      const isHeading = first === source.title
        || headingText === source.title
        || (source.url !== undefined && first.includes(source.url))
        || (source.domain !== undefined && first === source.domain);
      if (!isHeading) break;
      lines.shift();
    }
  }
  return lines.filter((line, index) => line !== lines[index - 1]).join("\n").trim();
}

function searchDocuments(
  output: string,
  results: unknown[] | undefined,
): CodexSearchDocument[] {
  const resultSources = (results ?? [])
    .map(normalizeSource)
    .filter((value): value is CodexSearchSource => value !== undefined);
  const blocks = output.split(RESULT_SEPARATOR).map((block) => block.trim()).filter(Boolean);
  const effectiveBlocks = blocks.length > 0 ? blocks : [output];
  return effectiveBlocks.map((block, index) => {
    const source = mergeDocumentSource(documentSourceFromBlock(block), resultSources, index);
    return { source, body: documentBody(block, source) };
  });
}

export function createCodexSearchDisplay(
  params: Record<string, unknown>,
  output: string,
  results?: unknown[],
): CodexSearchDisplay {
  const sources = uniqueSources(results, output, hasItems(params.image_query));
  if ((hasItems(params.search_query) || hasItems(params.image_query)) && sources.length > 0) {
    return { kind: "sources", sources };
  }
  if (hasItems(params.open) || hasItems(params.click) || hasItems(params.find) || hasItems(params.screenshot)) {
    const documents = searchDocuments(output, results);
    const screenshotItems = Array.isArray(params.screenshot) ? params.screenshot : [];
    documents.forEach((document, index) => {
      if (screenshotItems.length === 0) return;
      const item = record(screenshotItems[index]);
      const page = typeof item?.pageno === "number" ? item.pageno + 1 : index + 1;
      document.source = {
        ...(document.source ?? { title: "PDF screenshot" }),
        title: `PDF screenshot · page ${page}`,
      };
    });
    const first = documents[0] ?? { source: sources[0], body: documentBody(output, sources[0]) };
    return {
      kind: "document",
      source: first.source,
      body: first.body,
      documents,
    };
  }
  const lookups = lookupResults(output, params);
  if (lookups.length > 0) return { kind: "lookups", lookups };
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

function expandHintLine(text: string, expandHint?: string): CodexSearchDisplayLine {
  return {
    role: "hint",
    text: expandHint ? `${text} (${expandHint})` : text,
    ...(expandHint ? { expandHint } : {}),
  };
}

function excerptLines(body: string, expanded: boolean, expandHint?: string): CodexSearchDisplayLine[] {
  const all = body.split("\n").filter(Boolean);
  const shown = expanded ? all : all.slice(0, DOCUMENT_PREVIEW_LINES);
  const lines: CodexSearchDisplayLine[] = shown.map((text) => ({
    role: /^Tip:/i.test(text) ? "warning" : "body",
    text,
  }));
  if (!expanded && shown.length < all.length) {
    lines.push(expandHintLine(`… ${all.length - shown.length} more lines`, expandHint));
  }
  return lines;
}

function documentLines(
  documents: CodexSearchDocument[],
  expanded: boolean,
  expandHint?: string,
): CodexSearchDisplayLine[] {
  const multiple = documents.length > 1;
  const previewLines = multiple ? MULTI_DOCUMENT_PREVIEW_LINES : DOCUMENT_PREVIEW_LINES;
  const shownDocuments = expanded
    ? documents
    : documents.slice(0, multiple ? MULTI_DOCUMENT_PREVIEW_COUNT : 1);
  const lines: CodexSearchDisplayLine[] = [];
  let hiddenLineCount = 0;

  shownDocuments.forEach((document, index) => {
    if (document.source) {
      const title = multiple ? `${index + 1}. ${document.source.title}` : document.source.title;
      lines.push({
        role: document.source.type === "error" ? "error" : "title",
        text: title,
      });
      const location = expanded
        ? document.source.url ?? document.source.domain
        : document.source.domain ?? document.source.url;
      if (location) lines.push({ role: "url", text: `   ${location}` });
    }

    const allBodyLines = document.body.split("\n").filter(Boolean);
    const shownBodyLines = expanded ? allBodyLines : allBodyLines.slice(0, previewLines);
    lines.push(...shownBodyLines.map((text) => ({
      role: /^Tip:/i.test(text) ? "warning" as const : "body" as const,
      text: `   ${text}`,
    })));
    hiddenLineCount += allBodyLines.length - shownBodyLines.length;
  });

  const hiddenDocumentCount = documents.length - shownDocuments.length;
  for (const document of documents.slice(shownDocuments.length)) {
    hiddenLineCount += document.body.split("\n").filter(Boolean).length;
  }
  if (!expanded && (hiddenLineCount > 0 || hiddenDocumentCount > 0)) {
    const hiddenDocuments = hiddenDocumentCount > 0
      ? `${hiddenDocumentCount} more result${hiddenDocumentCount === 1 ? "" : "s"}`
      : "";
    const hiddenLines = hiddenLineCount > 0
      ? `${hiddenLineCount} more line${hiddenLineCount === 1 ? "" : "s"}`
      : "";
    const summary = hiddenDocuments && hiddenLines
      ? `${hiddenDocuments} and ${hiddenLines}`
      : hiddenDocuments || `${hiddenLines}${multiple ? ` across ${documents.length} results` : ""}`;
    lines.push(expandHintLine(`… ${summary}`, expandHint));
  }
  return lines;
}

function lookupPreviewCount(
  lookup: CodexSearchLookup,
  section: CodexSearchLookupSection,
  multiple: boolean,
): number {
  if (lookup.type === "weather") return section.title === "Alerts" ? 1 : multiple ? 2 : 3;
  if (lookup.type === "sports") return multiple ? 3 : 5;
  if (lookup.type === "finance") return multiple ? 1 : 2;
  return multiple ? 3 : 5;
}

function lookupLines(
  lookups: CodexSearchLookup[],
  expanded: boolean,
  expandHint?: string,
): CodexSearchDisplayLine[] {
  const multiple = lookups.length > 1;
  const lines: CodexSearchDisplayLine[] = [];
  let hiddenLineCount = 0;
  lookups.forEach((lookup, index) => {
    lines.push({
      role: "title",
      text: multiple ? `${index + 1}. ${lookup.title}` : lookup.title,
    });
    if (lookup.summary) lines.push({ role: "body", text: `   ${lookup.summary}` });
    for (const section of lookup.sections) {
      const warning = section.title === "Alerts";
      if (section.title) {
        lines.push({
          role: warning ? "warning" : "hint",
          text: `   ${section.title}`,
        });
      }
      const limit = lookupPreviewCount(lookup, section, multiple);
      const shown = expanded ? section.lines : section.lines.slice(0, limit);
      lines.push(...shown.map((text) => ({
        role: warning ? "warning" as const : "body" as const,
        text: `   ${text}`,
      })));
      hiddenLineCount += section.lines.length - shown.length;
    }
  });
  if (!expanded && hiddenLineCount > 0) {
    const scope = multiple ? ` across ${lookups.length} results` : "";
    lines.push(expandHintLine(
      `… ${hiddenLineCount} more line${hiddenLineCount === 1 ? "" : "s"}${scope}`,
      expandHint,
    ));
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
      lines.push(expandHintLine(`… ${display.sources.length - shown.length} more results`, expandHint));
    }
    return lines;
  }

  if (display.kind === "document") {
    return documentLines(
      display.documents ?? [{ source: display.source, body: display.body }],
      expanded,
      expandHint,
    );
  }

  if (display.kind === "lookups") {
    return lookupLines(display.lookups, expanded, expandHint);
  }

  return excerptLines(display.body, expanded, expandHint);
}
