import type { SshRunOptions } from "../transport/client.ts";

export type RemotePlatform = "unix" | "windows";
export type RemoteShell = "bash" | "zsh" | "sh" | "pwsh" | "powershell";
export type SshShellPreference = "auto" | RemoteShell;

export interface RemoteWorkspace {
  platform: RemotePlatform;
  shell: RemoteShell;
  home: string;
  cwd: string;
}

export interface RemoteDirectoryEntry {
  name: string;
  isDirectory: boolean;
}

export interface RemoteFindEntry {
  path: string;
  isDirectory: boolean;
}

export interface RemoteGrepMatch {
  path: string;
  toolPath: string;
  lineNumber: number;
  line: string;
}

export interface RemoteGrepOptions {
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  limit: number;
}

export interface RemoteAdapter {
  readonly platform: RemotePlatform;
  readonly shell: RemoteShell;

  inspectWorkspace(requestedCwd?: string): Promise<RemoteWorkspace>;

  /** Convert a model-facing path to the logical path consumed by Pi's tool definition. */
  toToolPath(path: string, workspace: RemoteWorkspace): string;
  /** Map Pi's logical path back to a native remote path. */
  fromToolPath(path: string): string;
  /** Map a local/logical execution cwd to the remote platform's native path syntax. */
  mapCwd(value: string, localCwd: string, workspace: RemoteWorkspace): string;

  readFile(path: string, signal?: AbortSignal): Promise<Buffer>;
  fileExists(path: string, signal?: AbortSignal): Promise<boolean>;
  access(path: string, mode: "read" | "write", signal?: AbortSignal): Promise<void>;
  detectImageMimeType(path: string, signal?: AbortSignal): Promise<string | null>;
  mkdir(path: string, signal?: AbortSignal): Promise<void>;
  writeFile(path: string, content: string | Buffer, signal?: AbortSignal): Promise<void>;
  listDirectory(path: string, signal?: AbortSignal): Promise<RemoteDirectoryEntry[]>;
  findEntries(
    path: string,
    pattern: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<RemoteFindEntry[]>;
  grep(
    path: string,
    pattern: string,
    options: RemoteGrepOptions,
    signal?: AbortSignal,
  ): Promise<RemoteGrepMatch[]>;

  buildShellCommand(
    command: string,
    cwd: string,
    env?: NodeJS.ProcessEnv,
    interactive?: boolean,
  ): string;
  runShell(command: string, cwd: string, options?: SshRunOptions & { env?: NodeJS.ProcessEnv }): Promise<number | null>;
}

export interface SelectRemoteAdapterOptions {
  localPlatform?: NodeJS.Platform;
  preference?: SshShellPreference;
  expectedPlatform?: RemotePlatform;
  expectedShell?: RemoteShell;
  requestedCwd?: string;
}
