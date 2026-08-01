import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const WORKSPACE_FILES_REQUEST_CHANNEL =
  "@99percentpeople/pi-workspace-files/request-v1";

export type WorkspaceFileData = Uint8Array | AsyncIterable<Uint8Array>;

export interface WorkspaceFileOptions {
  signal?: AbortSignal;
}

export interface WorkspaceFileSystem {
  /** Resolve a model-facing path and reject paths outside this workspace. */
  resolvePath(path: string): string;
  /** Return the platform-native extension for a resolved path. */
  extname(path: string): string;
  /** Return the platform-native parent directory for a resolved path. */
  dirname(path: string): string;
  /** Test whether a resolved file or directory already exists. */
  exists(path: string, options?: WorkspaceFileOptions): Promise<boolean>;
  /** Read a resolved file as buffered bytes or an asynchronous byte stream. */
  readFile(path: string, options?: WorkspaceFileOptions): Promise<WorkspaceFileData>;
  /** Create a resolved directory recursively. */
  mkdir(path: string, options?: WorkspaceFileOptions): Promise<void>;
  /** Write buffered bytes or an asynchronous byte stream to a resolved file. */
  writeFile(
    path: string,
    content: WorkspaceFileData,
    options?: WorkspaceFileOptions,
  ): Promise<void>;
}

export interface WorkspaceFileProviderContext {
  /** Pi's local anchor cwd for mapping model-facing paths. */
  cwd: string;
}

export type WorkspaceFileProvider = (
  context: WorkspaceFileProviderContext,
) => WorkspaceFileSystem | undefined;

export interface WorkspaceFilesRequest {
  version: 1;
  cwd: string;
  claim(owner: string, files: WorkspaceFileSystem): void;
}

interface WorkspaceFilesClaim {
  owner: string;
  files: WorkspaceFileSystem;
}

function isInsideRoot(root: string, value: string): boolean {
  const fromRoot = relative(root, value);
  return fromRoot === "" || (
    fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
}

function localWorkspacePath(cwd: string, path: string): string {
  const root = resolve(cwd);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (!isInsideRoot(root, absolute)) {
    throw new Error(`Path must stay inside the current workspace: ${path}`);
  }
  return absolute;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function isByteArray(data: WorkspaceFileData): data is Uint8Array {
  return data instanceof Uint8Array;
}

async function* checkedChunks(
  data: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of data) {
    throwIfAborted(signal);
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("Workspace file streams must yield Uint8Array chunks");
    }
    yield chunk;
  }
  throwIfAborted(signal);
}

export async function collectWorkspaceFile(
  data: WorkspaceFileData,
  options: WorkspaceFileOptions = {},
): Promise<Buffer> {
  const { signal } = options;
  throwIfAborted(signal);
  if (isByteArray(data)) return Buffer.from(data);
  const chunks: Buffer[] = [];
  for await (const chunk of checkedChunks(data, signal)) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createLocalWorkspaceFiles(cwd: string): WorkspaceFileSystem {
  return {
    resolvePath: (path) => localWorkspacePath(cwd, path),
    extname,
    dirname,
    async exists(path, options = {}) {
      const { signal } = options;
      throwIfAborted(signal);
      try {
        await access(path);
        throwIfAborted(signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async readFile(path, options = {}) {
      const { signal } = options;
      throwIfAborted(signal);
      return createReadStream(path, { signal });
    },
    async mkdir(path, options = {}) {
      const { signal } = options;
      throwIfAborted(signal);
      await mkdir(path, { recursive: true });
      throwIfAborted(signal);
    },
    async writeFile(path, content, options = {}) {
      const { signal } = options;
      throwIfAborted(signal);
      if (isByteArray(content)) {
        await writeFile(path, content, { signal });
        return;
      }
      await pipeline(
        Readable.from(checkedChunks(content, signal)),
        createWriteStream(path, { signal }),
        { signal },
      );
    },
  };
}

function isWorkspaceFilesRequest(value: unknown): value is WorkspaceFilesRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<WorkspaceFilesRequest>;
  return request.version === 1
    && typeof request.cwd === "string"
    && typeof request.claim === "function";
}

function assertOwner(owner: string): void {
  if (!owner.trim() || /[\0\r\n]/.test(owner)) {
    throw new Error("Workspace file provider owner must be a non-empty single line");
  }
}

export function registerWorkspaceFileProvider(
  pi: Pick<ExtensionAPI, "events">,
  owner: string,
  provider: WorkspaceFileProvider,
): () => void {
  assertOwner(owner);
  return pi.events.on(WORKSPACE_FILES_REQUEST_CHANNEL, (value) => {
    if (!isWorkspaceFilesRequest(value)) return;
    const files = provider({ cwd: value.cwd });
    if (files) value.claim(owner, files);
  });
}

export function resolveWorkspaceFiles(
  pi: Pick<ExtensionAPI, "events">,
  cwd: string,
): WorkspaceFileSystem {
  const claims: WorkspaceFilesClaim[] = [];
  const request: WorkspaceFilesRequest = {
    version: 1,
    cwd,
    claim(owner, files) {
      assertOwner(owner);
      claims.push({ owner, files });
    },
  };
  pi.events.emit(WORKSPACE_FILES_REQUEST_CHANNEL, request);
  if (claims.length > 1) {
    throw new Error(
      `Multiple extensions claimed the active workspace file system: ${claims.map((claim) => claim.owner).join(", ")}`,
    );
  }
  return claims[0]?.files ?? createLocalWorkspaceFiles(cwd);
}
