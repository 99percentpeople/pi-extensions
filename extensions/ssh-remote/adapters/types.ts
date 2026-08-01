import type { SshRunOptions } from "../client.ts";

export type RemotePlatform = "unix" | "windows";
export type RemoteShell = "bash" | "pwsh" | "powershell";
export type SshShellPreference = "auto" | RemoteShell;

export interface RemoteWorkspace {
  platform: RemotePlatform;
  shell: RemoteShell;
  home: string;
  cwd: string;
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

  buildShellCommand(
    command: string,
    cwd: string,
    env?: NodeJS.ProcessEnv,
    interactive?: boolean,
  ): string;
  runShell(command: string, cwd: string, options: SshRunOptions & { env?: NodeJS.ProcessEnv }): Promise<number | null>;
}

export interface SelectRemoteAdapterOptions {
  preference?: SshShellPreference;
  expectedPlatform?: RemotePlatform;
  expectedShell?: RemoteShell;
  requestedCwd?: string;
}
