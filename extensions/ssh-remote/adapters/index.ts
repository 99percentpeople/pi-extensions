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
  /** Non-fatal notices, for example a shell fallback after a failed probe. */
  warnings?: string[];
}

function createAdapter(
  executor: SshExecutor,
  shell: RemoteShell,
  localPlatform: NodeJS.Platform,
): RemoteAdapter {
  return shell === "bash" || shell === "zsh" || shell === "sh"
    ? new UnixBashAdapter(executor, localPlatform, shell)
    : new WindowsPowerShellAdapter(executor, shell, localPlatform);
}

/**
 * Probe whether a command exists on the remote host.
 *
 * The POSIX probe always answers ok/no when `sh` exists (exit 0 in both
 * cases). An empty stdout with a non-zero exit means the probe itself could
 * not run, which is how a Windows host without `sh` behaves; we then re-ask
 * through PowerShell. Returns `undefined` when neither probe can run.
 */
async function remoteCommandExists(
  executor: SshExecutor,
  command: string,
): Promise<boolean | undefined> {
  const shProbe = await runUnchecked(executor, () =>
    executor.run(
      `sh -c 'command -v ${command} >/dev/null 2>&1 && printf ok || printf no'`,
      { timeoutSeconds: 10 },
    )
  );
  if (shProbe && shProbe.exitCode === 0) {
    return shProbe.stdout.toString("utf8").trim() === "ok";
  }
  // The probe did not run: no sh on this host (Windows), or a transport
  // failure. Ask PowerShell; its absence on Unix yields undefined.
  const psProbe = await runUnchecked(executor, () =>
    executor.run(
      `powershell -NoProfile -NonInteractive -Command "if (Get-Command '${command}' -ErrorAction SilentlyContinue) { Write-Output ok }"`,
      { timeoutSeconds: 10 },
    )
  );
  if (psProbe && psProbe.exitCode === 0) {
    return psProbe.stdout.toString("utf8").trim() === "ok";
  }
  return undefined;
}

/** Run a probe, mapping transport failures to `undefined`. */
async function runUnchecked<T>(
  executor: SshExecutor,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    return undefined;
  }
}

interface RemoteHostProbe {
  /**
   * "unix" when the POSIX probe answered, "windows" when it could not run
   * (no `sh` on the host), "unknown" on transport failure.
   */
  kind: "unix" | "windows" | "unknown";
  /** Login shell basename for Unix hosts ("" when unknown). */
  loginShell: string;
}

/**
 * Classify the remote host and detect the login shell in a single round
 * trip. Runs through `sh -c` so it works regardless of the remote default
 * shell syntax.
 *
 * The login shell comes from `getent passwd`; on systems without `getent`
 * (Alpine, busybox) the probe falls back to the `sh` symlink target, which
 * is the POSIX baseline shell rather than the interactive login shell. A
 * Windows host without `sh` cannot run the probe (empty stdout, non-zero
 * exit) and is reported as "windows".
 */
async function probeRemoteHost(executor: SshExecutor): Promise<RemoteHostProbe> {
  const unknown = { kind: "unknown", loginShell: "" } as const;
  const result = await runUnchecked(executor, () =>
    executor.run(
      `sh -c 'p=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7); `
        + `[ -n "$p" ] || p=$(readlink -f /bin/sh 2>/dev/null); `
        + `n="\${p##*/}"; printf "unix:%s" "$n"'`,
      { timeoutSeconds: 10 },
    )
  );
  if (!result) return unknown;
  const text = result.stdout.toString("utf8").replace(/\r/g, "").trim();
  const match = /^unix:([^:]*)$/.exec(text);
  if (result.exitCode === 0 && match) {
    return { kind: "unix", loginShell: match[1] };
  }
  if (result.exitCode !== 0 && text === "") {
    // The probe could not run: no sh on this host (Windows).
    return { kind: "windows", loginShell: "" };
  }
  return unknown;
}

async function shellCandidates(
  executor: SshExecutor,
  options: SelectRemoteAdapterOptions,
  warnings: string[],
): Promise<RemoteShell[]> {
  if (options.expectedShell) return [options.expectedShell];
  const preference = options.preference ?? "auto";
  if (preference === "auto") {
    // One round trip classifies the host and detects the login shell; the
    // candidate list is then validated for real by inspectWorkspace.
    const probe = await probeRemoteHost(executor);
    if (probe.kind === "unix" && probe.loginShell === "zsh") {
      // A Zsh login shell implies zsh is installed (the passwd entry or the
      // /bin/sh symlink can only point at a working binary), so use it.
      return ["zsh"];
    }
    if (probe.kind === "windows") {
      // No sh on Windows: skip the futile Bash attempt and go straight to
      // PowerShell.
      return ["pwsh", "powershell"];
    }
    // Unix without a Zsh login shell, or an unknown host: deterministic
    // order with Bash first.
    return ["bash", "pwsh", "powershell"];
  }

  // Explicit preference: probe existence, fall back, and warn. An unknown
  // probe result (no sh on Windows) leaves the preference in charge; the
  // inspectWorkspace probe below validates it for real.
  if (preference === "zsh" || preference === "bash") {
    const exists = await remoteCommandExists(executor, preference);
    if (exists === false) {
      warnings.push(
        `The remote host does not provide ${preference}; falling back to sh`,
      );
      return ["sh"];
    }
    return [preference];
  }
  if (preference === "pwsh" || preference === "powershell") {
    const candidates: RemoteShell[] = preference === "pwsh"
      ? ["pwsh", "powershell"]
      : ["powershell", "pwsh"];
    const exists = await remoteCommandExists(executor, candidates[0]);
    if (exists === false) {
      warnings.push(
        `The remote host does not provide ${candidates[0]}; falling back to ${candidates[1]}`,
      );
      return [candidates[1]];
    }
    return candidates;
  }
  return [preference];
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
  const warnings: string[] = [];
  for (const shell of await shellCandidates(executor, options, warnings)) {
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
      return { adapter, workspace, warnings };
    } catch (error) {
      failures.push(`${shell}: ${boundedProbeError(error)}`);
    }
  }

  const expected = options.expectedPlatform && options.expectedShell
    ? ` Expected ${options.expectedPlatform}/${options.expectedShell}.`
    : "";
  throw new Error(
    `Could not find a supported remote shell.${expected} `
      + "The host must provide Unix Bash or Zsh, PowerShell 7, or Windows PowerShell 5.1. "
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
