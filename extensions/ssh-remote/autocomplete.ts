import { posix, win32 } from "node:path";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { RemoteAdapter, RemoteWorkspace } from "./adapters/index.ts";

const MAX_REMOTE_CANDIDATES = 100;
const MAX_REMOTE_SUGGESTIONS = 20;
const REMOTE_CANDIDATE_CACHE_MS = 2_000;
const MAX_CACHED_DIRECTORIES = 8;
const PATH_DELIMITERS = new Set([" ", "\t", "\"", "'", "="]);

export interface RemoteAutocompleteConnection {
  adapter: RemoteAdapter;
  workspace: RemoteWorkspace;
}

export type RemoteAutocompleteEnvironment =
  | { kind: "local" }
  | { kind: "unavailable" }
  | { kind: "active"; connection: RemoteAutocompleteConnection };

interface AtPrefix {
  prefix: string;
  rawPrefix: string;
  quoted: boolean;
}

interface RemoteCandidate {
  path: string;
  isDirectory: boolean;
}

interface CachedCandidates {
  expiresAt: number;
  values: RemoteCandidate[];
}

function findLastDelimiter(text: string): number {
  for (let index = text.length - 1; index >= 0; index--) {
    if (PATH_DELIMITERS.has(text[index] ?? "")) return index;
  }
  return -1;
}

function findUnclosedQuoteStart(text: string): number | undefined {
  let quoteStart: number | undefined;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\"") continue;
    quoteStart = quoteStart === undefined ? index : undefined;
  }
  return quoteStart;
}

function isTokenStart(text: string, index: number): boolean {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

/** Match Pi's built-in token rules for unquoted `@path` and open `@"path`. */
export function extractRemoteAtPrefix(textBeforeCursor: string): AtPrefix | undefined {
  const quoteStart = findUnclosedQuoteStart(textBeforeCursor);
  if (
    quoteStart !== undefined
    && quoteStart > 0
    && textBeforeCursor[quoteStart - 1] === "@"
    && isTokenStart(textBeforeCursor, quoteStart - 1)
  ) {
    const prefix = textBeforeCursor.slice(quoteStart - 1);
    return { prefix, rawPrefix: prefix.slice(2).replace(/\\/g, "/"), quoted: true };
  }

  const delimiter = findLastDelimiter(textBeforeCursor);
  const tokenStart = delimiter === -1 ? 0 : delimiter + 1;
  if (textBeforeCursor[tokenStart] !== "@") return undefined;
  const prefix = textBeforeCursor.slice(tokenStart);
  return { prefix, rawPrefix: prefix.slice(1).replace(/\\/g, "/"), quoted: false };
}

function splitScopedQuery(rawPrefix: string): { displayBase: string; query: string } {
  const separator = rawPrefix.lastIndexOf("/");
  if (separator === -1) return { displayBase: "", query: rawPrefix };
  return {
    displayBase: rawPrefix.slice(0, separator + 1),
    query: rawPrefix.slice(separator + 1),
  };
}

function resolveRemoteDirectory(
  workspace: RemoteWorkspace,
  displayBase: string,
): string | undefined {
  if (!displayBase) return workspace.cwd;
  if (displayBase.startsWith("~") && !displayBase.startsWith("~/")) return undefined;

  const api = workspace.platform === "windows" ? win32 : posix;
  if (displayBase.startsWith("~/")) {
    const relative = displayBase.slice(2);
    return api.resolve(workspace.home, workspace.platform === "windows"
      ? relative.replace(/\//g, "\\")
      : relative);
  }

  const value = workspace.platform === "windows"
    ? displayBase.replace(/\//g, "\\")
    : displayBase;
  return api.resolve(workspace.cwd, value);
}

function normalizeCandidatePath(value: string): string | undefined {
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
  ) {
    return undefined;
  }
  const segments = normalized.split("/");
  if (segments.includes(".git")) return undefined;
  return normalized;
}

function mergeCandidates(
  workspace: RemoteWorkspace,
  direct: readonly { name: string; isDirectory: boolean }[],
  recursive: readonly { path: string; isDirectory: boolean }[],
): RemoteCandidate[] {
  const byPath = new Map<string, RemoteCandidate>();
  const add = (value: string, isDirectory: boolean): void => {
    const path = normalizeCandidatePath(value);
    if (!path) return;
    const key = workspace.platform === "windows" ? path.toLowerCase() : path;
    const previous = byPath.get(key);
    byPath.set(key, {
      path: previous?.path ?? path,
      isDirectory: previous?.isDirectory || isDirectory,
    });
  };
  for (const entry of direct) add(entry.name, entry.isDirectory);
  for (const entry of recursive) add(entry.path, entry.isDirectory);
  return [...byPath.values()];
}

function candidateScore(candidate: RemoteCandidate, query: string): number {
  if (!query) return candidate.isDirectory ? 2 : 1;
  const path = candidate.path.toLowerCase();
  const name = posix.basename(candidate.path).toLowerCase();
  const needle = query.toLowerCase();
  let score = 0;
  if (name === needle) score = 100;
  else if (name.startsWith(needle)) score = 80;
  else if (name.includes(needle)) score = 50;
  else if (path.includes(needle)) score = 30;
  if (candidate.isDirectory && score > 0) score += 10;
  return score;
}

function displayPath(displayBase: string, candidatePath: string): string {
  if (displayBase === "/") return `/${candidatePath}`;
  return `${displayBase}${candidatePath}`;
}

function completionValue(path: string, quoted: boolean): string {
  return quoted || path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function toAutocompleteItem(
  candidate: RemoteCandidate,
  displayBase: string,
  quoted: boolean,
): AutocompleteItem {
  const path = displayPath(displayBase, candidate.path);
  const completionPath = candidate.isDirectory ? `${path}/` : path;
  return {
    value: completionValue(completionPath, quoted),
    label: `${posix.basename(candidate.path)}${candidate.isDirectory ? "/" : ""}`,
    description: path,
  };
}

export function createRemoteAutocompleteProvider(
  current: AutocompleteProvider,
  getEnvironment: () => RemoteAutocompleteEnvironment,
): AutocompleteProvider {
  let cachedConnection: RemoteAutocompleteConnection | undefined;
  const cache = new Map<string, CachedCandidates>();

  const loadCandidates = async (
    connection: RemoteAutocompleteConnection,
    directory: string,
    signal: AbortSignal,
  ): Promise<RemoteCandidate[]> => {
    if (cachedConnection !== connection) {
      cachedConnection = connection;
      cache.clear();
    }
    const cached = cache.get(directory);
    if (cached && cached.expiresAt > Date.now()) return cached.values;

    let toolPath: string;
    try {
      toolPath = connection.adapter.toToolPath(directory, connection.workspace);
    } catch {
      return [];
    }
    const [directResult, recursiveResult] = await Promise.allSettled([
      connection.adapter.listDirectory(toolPath, signal),
      connection.adapter.findEntries(toolPath, "*", MAX_REMOTE_CANDIDATES, signal),
    ]);
    if (signal.aborted) return [];
    const direct = directResult.status === "fulfilled" ? directResult.value : [];
    const recursive = recursiveResult.status === "fulfilled" ? recursiveResult.value : [];
    const values = mergeCandidates(connection.workspace, direct, recursive);
    cache.set(directory, {
      expiresAt: Date.now() + REMOTE_CANDIDATE_CACHE_MS,
      values,
    });
    while (cache.size > MAX_CACHED_DIRECTORIES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return values;
  };

  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],

    async getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    ): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? "";
      const atPrefix = extractRemoteAtPrefix(line.slice(0, cursorCol));
      if (!atPrefix) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const environment = getEnvironment();
      if (environment.kind === "local") {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      if (environment.kind !== "active" || options.signal.aborted) return null;

      const { displayBase, query } = splitScopedQuery(atPrefix.rawPrefix);
      const directory = resolveRemoteDirectory(environment.connection.workspace, displayBase);
      if (!directory) return null;
      const candidates = await loadCandidates(environment.connection, directory, options.signal);
      if (options.signal.aborted) return null;

      const items = candidates
        .map((candidate) => ({ candidate, score: candidateScore(candidate, query) }))
        .filter(({ score }) => score > 0)
        .sort((left, right) =>
          right.score - left.score
          || left.candidate.path.localeCompare(right.candidate.path))
        .slice(0, MAX_REMOTE_SUGGESTIONS)
        .map(({ candidate }) => toAutocompleteItem(candidate, displayBase, atPrefix.quoted));
      return items.length > 0 ? { items, prefix: atPrefix.prefix } : null;
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
