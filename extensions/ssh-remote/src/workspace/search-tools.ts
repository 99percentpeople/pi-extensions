import {
  DEFAULT_MAX_BYTES,
  truncateHead,
  truncateLine,
  type AgentToolResult,
  type FindToolDetails,
  type GrepToolDetails,
  type LsToolDetails,
} from "@earendil-works/pi-coding-agent";
import type {
  RemoteAdapter,
  RemoteDirectoryEntry,
  RemoteFindEntry,
  RemoteGrepMatch,
} from "../adapters/index.ts";

export const DEFAULT_REMOTE_GREP_LIMIT = 100;
export const DEFAULT_REMOTE_FIND_LIMIT = 1_000;
export const DEFAULT_REMOTE_LS_LIMIT = 500;

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Limit must be a positive finite number");
  }
  return Math.max(1, Math.floor(value));
}

function textResult<T>(text: string, details?: T): AgentToolResult<T | undefined> {
  return { content: [{ type: "text", text }], details };
}

export function formatRemoteLsResult(
  entries: RemoteDirectoryEntry[],
  requestedLimit?: number,
): AgentToolResult<LsToolDetails | undefined> {
  const limit = positiveLimit(requestedLimit, DEFAULT_REMOTE_LS_LIMIT);
  const sorted = [...entries].sort((left, right) =>
    left.name.toLowerCase().localeCompare(right.name.toLowerCase())
  );
  const visible = sorted.slice(0, limit);
  if (visible.length === 0) return textResult("(empty directory)");

  const raw = visible
    .map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`)
    .join("\n");
  const truncation = truncateHead(raw, { maxLines: Number.MAX_SAFE_INTEGER });
  const details: LsToolDetails = {};
  const notices: string[] = [];
  if (sorted.length > limit) {
    details.entryLimitReached = limit;
    notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
  }
  const output = notices.length > 0
    ? `${truncation.content}\n\n[${notices.join(". ")}]`
    : truncation.content;
  return textResult(output, Object.keys(details).length > 0 ? details : undefined);
}

export function formatRemoteFindResult(
  entries: RemoteFindEntry[],
  requestedLimit?: number,
): AgentToolResult<FindToolDetails | undefined> {
  const limit = positiveLimit(requestedLimit, DEFAULT_REMOTE_FIND_LIMIT);
  if (entries.length === 0) return textResult("No files found matching pattern");

  const visible = entries.slice(0, limit);
  const raw = visible
    .map((entry) => `${entry.path.replace(/\\/g, "/")}${entry.isDirectory ? "/" : ""}`)
    .join("\n");
  const truncation = truncateHead(raw, { maxLines: Number.MAX_SAFE_INTEGER });
  const details: FindToolDetails = {};
  const notices: string[] = [];
  if (entries.length >= limit) {
    details.resultLimitReached = limit;
    notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
  }
  const output = notices.length > 0
    ? `${truncation.content}\n\n[${notices.join(". ")}]`
    : truncation.content;
  return textResult(output, Object.keys(details).length > 0 ? details : undefined);
}

async function contextBlock(
  adapter: RemoteAdapter,
  match: RemoteGrepMatch,
  context: number,
  cache: Map<string, string[]>,
  signal?: AbortSignal,
): Promise<{ lines: string[]; truncated: boolean }> {
  let lines = cache.get(match.toolPath);
  if (!lines) {
    try {
      signal?.throwIfAborted();
      const content = await adapter.readFile(match.toolPath, signal);
      lines = content.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    } catch {
      signal?.throwIfAborted();
      return {
        lines: [`${match.path}:${match.lineNumber}: (unable to read file)`],
        truncated: false,
      };
    }
    cache.set(match.toolPath, lines);
  }

  const output: string[] = [];
  let truncated = false;
  const start = Math.max(1, match.lineNumber - context);
  const end = Math.min(lines.length, match.lineNumber + context);
  for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
    const value = truncateLine(lines[lineNumber - 1] ?? "");
    if (value.wasTruncated) truncated = true;
    const separator = lineNumber === match.lineNumber ? ":" : "-";
    output.push(`${match.path}${separator}${lineNumber}${separator} ${value.text}`);
  }
  return { lines: output, truncated };
}

export async function formatRemoteGrepResult(
  adapter: RemoteAdapter,
  matches: RemoteGrepMatch[],
  requestedLimit?: number,
  requestedContext?: number,
  signal?: AbortSignal,
): Promise<AgentToolResult<GrepToolDetails | undefined>> {
  const limit = positiveLimit(requestedLimit, DEFAULT_REMOTE_GREP_LIMIT);
  if (matches.length === 0) return textResult("No matches found");

  const context = requestedContext && requestedContext > 0
    ? Math.floor(requestedContext)
    : 0;
  const outputLines: string[] = [];
  const cache = new Map<string, string[]>();
  let linesTruncated = false;
  for (const match of matches.slice(0, limit)) {
    signal?.throwIfAborted();
    if (context > 0) {
      const block = await contextBlock(adapter, match, context, cache, signal);
      outputLines.push(...block.lines);
      if (block.truncated) linesTruncated = true;
      continue;
    }
    const value = truncateLine(match.line.replace(/\r/g, ""));
    if (value.wasTruncated) linesTruncated = true;
    outputLines.push(`${match.path}:${match.lineNumber}: ${value.text}`);
  }

  const truncation = truncateHead(outputLines.join("\n"), {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  const details: GrepToolDetails = {};
  const notices: string[] = [];
  if (matches.length >= limit) {
    details.matchLimitReached = limit;
    notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
  }
  if (linesTruncated) {
    details.linesTruncated = true;
    notices.push("Some lines truncated. Use read tool to see full lines");
  }
  const output = notices.length > 0
    ? `${truncation.content}\n\n[${notices.join(". ")}]`
    : truncation.content;
  return textResult(output, Object.keys(details).length > 0 ? details : undefined);
}

export function resolveRemoteLimit(value: number | undefined, fallback: number): number {
  return positiveLimit(value, fallback);
}
