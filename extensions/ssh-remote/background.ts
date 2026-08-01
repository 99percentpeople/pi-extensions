import type { RemoteAdapter, RemoteWorkspace } from "./adapters/types.ts";
import type { SshClientOptions } from "./client.ts";
import { buildSshArguments } from "./client.ts";

export interface BackgroundShellLaunch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  initialStdin?: string;
}

export interface BackgroundShellResolverContext {
  cwd: string;
  projectTrusted: boolean;
}

export type BackgroundShellResolver = (
  command: string,
  interactive: boolean,
  context?: BackgroundShellResolverContext,
) => BackgroundShellLaunch;

export interface SshBackgroundResolverOptions {
  ssh: SshClientOptions;
  adapter: RemoteAdapter;
  workspace: RemoteWorkspace;
  localCwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Create a bg:register shell resolver backed by the system OpenSSH client. */
export function createSshBackgroundShellResolver(
  options: SshBackgroundResolverOptions,
): BackgroundShellResolver {
  return (command, interactive, context) => {
    const requestedCwd = context?.cwd ?? options.localCwd;
    const remoteCwd = options.adapter.mapCwd(
      requestedCwd,
      options.localCwd,
      options.workspace,
    );
    // Non-interactive launches on Windows add -n so ssh.exe does not wedge
    // when spawned with piped stdio (see client.ts). Interactive launches
    // keep stdin for user input.
    const windowsClient = options.ssh.executable === "ssh.exe";
    return {
      file: options.ssh.executable ?? "ssh",
      args: [
        ...buildSshArguments(
          options.ssh,
          interactive,
          !interactive && windowsClient,
        ),
        options.adapter.buildShellCommand(command, remoteCwd, undefined, interactive),
      ],
      env: { ...(options.env ?? process.env) },
      // background-tasks >=1.2.7 honors this launch cwd. It keeps the local
      // OpenSSH process out of a remote-only path while the command itself
      // changes to the mapped remote directory.
      cwd: options.localCwd,
    };
  };
}
