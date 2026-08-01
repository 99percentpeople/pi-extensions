import type { SshExecutor } from "../client.ts";
import { UnixBashAdapter } from "./unix.ts";
import type {
  RemoteAdapter,
  RemoteShell,
  RemoteWorkspace,
  SelectRemoteAdapterOptions,
} from "./types.ts";
import { WindowsPowerShellAdapter } from "./windows.ts";

export interface SelectedRemote {
  adapter: RemoteAdapter;
  workspace: RemoteWorkspace;
}

function createAdapter(
  executor: SshExecutor,
  shell: RemoteShell,
  localPlatform: NodeJS.Platform,
): RemoteAdapter {
  return shell === "bash"
    ? new UnixBashAdapter(executor, localPlatform)
    : new WindowsPowerShellAdapter(executor, shell, localPlatform);
}

function shellCandidates(options: SelectRemoteAdapterOptions): RemoteShell[] {
  if (options.expectedShell) return [options.expectedShell];
  const preference = options.preference ?? "auto";
  return preference === "auto" ? ["bash", "pwsh", "powershell"] : [preference];
}

function boundedProbeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const singleLine = message.replace(/\s+/g, " ").trim();
  return singleLine.length > 500 ? `${singleLine.slice(0, 500)}…` : singleLine;
}

export async function selectRemoteAdapter(
  executor: SshExecutor,
  options: SelectRemoteAdapterOptions = {},
): Promise<SelectedRemote> {
  const failures: string[] = [];
  for (const shell of shellCandidates(options)) {
    const adapter = createAdapter(
      executor,
      shell,
      options.localPlatform ?? process.platform,
    );
    if (options.expectedPlatform && adapter.platform !== options.expectedPlatform) {
      failures.push(`${shell}: expected ${options.expectedPlatform}, adapter is ${adapter.platform}`);
      continue;
    }
    try {
      const workspace = await adapter.inspectWorkspace(options.requestedCwd);
      return { adapter, workspace };
    } catch (error) {
      failures.push(`${shell}: ${boundedProbeError(error)}`);
    }
  }

  const expected = options.expectedPlatform && options.expectedShell
    ? ` Expected ${options.expectedPlatform}/${options.expectedShell}.`
    : "";
  throw new Error(
    `Could not find a supported remote shell.${expected} `
      + "The host must provide Unix bash, PowerShell 7, or Windows PowerShell 5.1. "
      + `Probe results: ${failures.join(" | ")}`,
  );
}

export { UnixBashAdapter } from "./unix.ts";
export { WindowsPowerShellAdapter } from "./windows.ts";
export type {
  RemoteAdapter,
  RemoteDirectoryEntry,
  RemoteFindEntry,
  RemoteGrepMatch,
  RemoteGrepOptions,
  RemotePlatform,
  RemoteShell,
  RemoteWorkspace,
  SelectRemoteAdapterOptions,
  SshShellPreference,
} from "./types.ts";
