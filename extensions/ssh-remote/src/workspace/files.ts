import { posix, win32 } from "node:path";
import {
  collectWorkspaceFile,
  registerWorkspaceFileProvider,
  type WorkspaceFileSystem,
} from "@99percentpeople/pi-workspace-files";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RemoteAdapter, RemoteWorkspace } from "../adapters/index.ts";

export interface RemoteWorkspaceFileConnection {
  adapter: RemoteAdapter;
  workspace: RemoteWorkspace;
}

function pathApi(workspace: RemoteWorkspace): typeof posix | typeof win32 {
  return workspace.platform === "windows" ? win32 : posix;
}

function isInsideWorkspace(workspace: RemoteWorkspace, nativePath: string): boolean {
  const api = pathApi(workspace);
  const root = api.resolve(workspace.cwd);
  const absolute = api.resolve(nativePath);
  const relative = api.relative(root, absolute);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${api.sep}`)
    && !api.isAbsolute(relative)
  );
}

function assertWorkspacePath(workspace: RemoteWorkspace, path: string): string {
  const nativePath = pathApi(workspace).resolve(path);
  if (!isInsideWorkspace(workspace, nativePath)) {
    throw new Error(`Path must stay inside the remote workspace: ${path}`);
  }
  return nativePath;
}

function createRemoteWorkspaceFiles(
  connection: RemoteWorkspaceFileConnection,
  localCwd: string,
): WorkspaceFileSystem {
  const { adapter, workspace } = connection;
  const api = pathApi(workspace);
  const toolPath = (path: string): string =>
    adapter.toToolPath(assertWorkspacePath(workspace, path), workspace);

  return {
    resolvePath(path) {
      return assertWorkspacePath(
        workspace,
        adapter.mapCwd(path, localCwd, workspace),
      );
    },
    extname: (path) => api.extname(path),
    dirname: (path) => api.dirname(path),
    exists: (path, options) =>
      adapter.fileExists(toolPath(path), options?.signal),
    readFile: (path, options) =>
      adapter.readFile(toolPath(path), options?.signal),
    mkdir: (path, options) =>
      adapter.mkdir(toolPath(path), options?.signal),
    async writeFile(path, content, options) {
      const bytes = await collectWorkspaceFile(content, options);
      await adapter.writeFile(toolPath(path), bytes, options?.signal);
    },
  };
}

export function registerRemoteWorkspaceFiles(
  pi: ExtensionAPI,
  getConnection: () => RemoteWorkspaceFileConnection | undefined,
): void {
  registerWorkspaceFileProvider(
    pi,
    "@99percentpeople/pi-ssh-remote",
    ({ cwd }) => {
      const connection = getConnection();
      return connection ? createRemoteWorkspaceFiles(connection, cwd) : undefined;
    },
  );
}
