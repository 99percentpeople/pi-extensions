import {
  SshPasswordCancelledError,
  SshPasswordFailedError,
} from "../transport/password-resolver.ts";
import type { SshExecutor, SshRunResult } from "../transport/client.ts";
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
  const shProbeOptions = { allowUnknownExit255: true } as const;
  const shProbe = await runUnchecked(() =>
    executor.run(
      `sh -c 'command -v ${command} >/dev/null 2>&1 && printf ok || printf no'`,
      { timeoutSeconds: 10 },
    ),
    shProbeOptions,
  );
  if (shProbe) throwIfFatalProbeFailure(shProbe, shProbeOptions);
  if (shProbe?.exitCode === 0) {
    return shProbe.stdout.toString("utf8").trim() === "ok";
  }
  // The probe did not run because sh is unavailable (normally Windows).
  // Terminal transport/authentication failures were already rethrown. Ask
  // PowerShell; its absence on Unix yields undefined.
  const psProbe = await runUnchecked(() =>
    executor.run(
      `powershell -NoProfile -NonInteractive -Command "if (Get-Command '${command}' -ErrorAction SilentlyContinue) { Write-Output ok }"`,
      { timeoutSeconds: 10 },
    )
  );
  if (psProbe) throwIfFatalProbeFailure(psProbe);
  if (psProbe?.exitCode === 0) {
    return psProbe.stdout.toString("utf8").trim() === "ok";
  }
  return undefined;
}

const SSH_AUTHENTICATION_FAILURE =
  /authentication (?:failed|failure)|all configured authentication methods failed|no supported authentication methods|unable to authenticate/i;
const SSH_CONNECTION_FAILURE =
  /connection (?:refused|reset|closed|timed out)|no route to host|network is unreachable|could not resolve hostname|name or service not known|host key verification failed|remote host identification has changed|kex_exchange_identification|ssh_exchange_identification|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND/i;
const SSH_TRANSPORT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
]);

/** A connection/authentication failure, rather than a missing remote shell. */
class FatalSshProbeError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FatalSshProbeError";
  }
}

function compactFailureText(value: string, maxLength = 360): string {
  const uniqueLines: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (normalized && !uniqueLines.includes(normalized)) uniqueLines.push(normalized);
  }
  const compact = uniqueLines.join(" ");
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

function isRunResult(value: unknown): value is SshRunResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SshRunResult>;
  return (typeof candidate.exitCode === "number" || candidate.exitCode === null)
    && Buffer.isBuffer(candidate.stdout)
    && Buffer.isBuffer(candidate.stderr);
}

function rawProbeFailure(value: unknown): {
  message: string;
  detail: string;
  exitCode?: number | null;
} {
  if (isRunResult(value)) {
    const stderr = value.stderr.toString("utf8").trim();
    const stdout = value.stdout.toString("utf8").trim();
    const detail = compactFailureText(stderr || stdout);
    return {
      message: `SSH command failed (${value.exitCode ?? "signal"})${detail ? `: ${detail}` : ""}`,
      detail,
      exitCode: value.exitCode,
    };
  }
  const message = compactFailureText(
    value instanceof Error ? value.message : String(value),
  );
  const status = /SSH command failed \((\d+|signal)\)/i.exec(message)?.[1];
  return {
    message,
    detail: message.replace(/^SSH command failed \([^)]*\):?\s*/i, ""),
    exitCode: status === undefined
      ? undefined
      : status === "signal"
        ? null
        : Number(status),
  };
}

interface FatalProbeOptions {
  /**
   * A remote Windows launcher can return 255 when the probed POSIX shell is
   * missing. Permit only an otherwise-unclassified 255 where that absence is
   * expected; authentication and recognizable transport failures still win.
   */
  allowUnknownExit255?: boolean;
}

/**
 * Convert terminal SSH failures into one concise error. Probe-language
 * failures deliberately return undefined so another supported shell can be
 * attempted.
 */
function fatalProbeFailure(
  value: unknown,
  options: FatalProbeOptions = {},
): Error | undefined {
  if (value instanceof FatalSshProbeError) return value;
  if (value instanceof SshPasswordCancelledError || value instanceof SshPasswordFailedError) {
    return value;
  }

  const { message, detail, exitCode } = rawProbeFailure(value);
  const sourceError = value instanceof Error ? value : undefined;
  const ssh255 = exitCode === 255 || /SSH command failed \(255\)/i.test(message);
  const connectionErrorName = sourceError?.name === "Ssh2ConnectionError";
  const code = sourceError && "code" in sourceError
    ? String((sourceError as Error & { code?: unknown }).code ?? "")
    : "";
  const unstructuredFailure = exitCode === undefined;
  const transportCode = SSH_TRANSPORT_ERROR_CODES.has(code.toUpperCase());
  const authenticationText = SSH_AUTHENTICATION_FAILURE.test(message);
  const permissionDenied = /permission denied/i.test(message);

  if (/password authentication was cancelled|authentication .* cancelled/i.test(message)) {
    return sourceError ?? new FatalSshProbeError(message);
  }
  if (
    authenticationText
    || (permissionDenied && (ssh255 || connectionErrorName || unstructuredFailure))
  ) {
    return new FatalSshProbeError(
      `SSH authentication failed${detail ? `: ${detail}` : ""}`,
      value,
    );
  }
  if (/connection timed out during banner exchange/i.test(message)) {
    return new FatalSshProbeError(
      "SSH connection timed out during banner exchange. Check the configured host, port, proxy settings, and sshd.",
      value,
    );
  }
  const timeout = /(?:^|\b)timeout:(\d+(?:\.\d+)?)\b/i.exec(message);
  if (timeout && (unstructuredFailure || ssh255 || connectionErrorName)) {
    return new FatalSshProbeError(
      `SSH connection probe timed out after ${timeout[1]} seconds. Check the configured host, port, proxy settings, and sshd.`,
      value,
    );
  }
  if (/^(?:aborted|cancelled)$/i.test(message)) {
    return sourceError ?? new FatalSshProbeError(message);
  }
  const connectionText = SSH_CONNECTION_FAILURE.test(message);
  const terminalSsh255 = ssh255 && (!options.allowUnknownExit255 || connectionText);
  if (
    connectionErrorName
    || terminalSsh255
    || exitCode === null
    || transportCode
    || (unstructuredFailure && connectionText)
  ) {
    return new FatalSshProbeError(
      `SSH connection failed${detail ? `: ${detail}` : ""}`,
      value,
    );
  }
  if (code === "ENOENT" || code === "EACCES") {
    return new FatalSshProbeError(
      `SSH transport could not start${detail ? `: ${detail}` : ""}`,
      value,
    );
  }
  return undefined;
}

function throwIfFatalProbeFailure(
  value: unknown,
  options?: FatalProbeOptions,
): void {
  const fatal = fatalProbeFailure(value, options);
  if (fatal) throw fatal;
}

/** Classify a runtime SSH transport/authentication failure without throwing. */
export function classifySshTransportFailure(value: unknown): Error | undefined {
  return fatalProbeFailure(value);
}

/** Run a shell-discovery probe while preserving terminal SSH failures. */
async function runUnchecked<T>(
  run: () => Promise<T>,
  options?: FatalProbeOptions,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    throwIfFatalProbeFailure(error, options);
    return undefined;
  }
}

interface RemoteHostProbe {
  /**
   * "unix" when the POSIX probe answered, "windows" when it could not run
   * (no `sh` on the host), and "unknown" when output was inconclusive.
   * Terminal transport/authentication failures are thrown instead.
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
  const shProbeOptions = { allowUnknownExit255: true } as const;
  const result = await runUnchecked(() =>
    executor.run(
      `sh -c 'p=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7); `
        + `[ -n "$p" ] || p=$(readlink -f /bin/sh 2>/dev/null); `
        + `n="\${p##*/}"; printf "unix:%s" "$n"'`,
      { timeoutSeconds: 10 },
    ),
    shProbeOptions,
  );
  if (!result) return unknown;
  throwIfFatalProbeFailure(result, shProbeOptions);
  const text = result.stdout.toString("utf8").replace(/\r/g, "").trim();
  const match = /^unix:([^:]*)$/.exec(text);
  if (result.exitCode === 0 && match) {
    return { kind: "unix", loginShell: match[1] };
  }
  if (result.exitCode !== 0 && text === "") {
    // The probe could not run: no sh on this host (Windows). Connection and
    // authentication failures were classified before output parsing.
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
    // order with Bash first, then sh for ash-only hosts (OpenWrt, Alpine,
    // busybox containers). Control scripts run through sh on every host,
    // so the sh candidate fails only when inspectWorkspace can't run.
    return ["bash", "sh", "pwsh", "powershell"];
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
  return compactFailureText(message, 240);
}

interface ShellProbeFailure {
  shell: RemoteShell;
  reason: string;
}

function formatProbeFailures(failures: readonly ShellProbeFailure[]): string {
  const grouped = new Map<string, RemoteShell[]>();
  for (const failure of failures) {
    const shells = grouped.get(failure.reason) ?? [];
    shells.push(failure.shell);
    grouped.set(failure.reason, shells);
  }
  const details = Array.from(grouped, ([reason, shells]) =>
    `${shells.join("/")}: ${reason}`
  ).join(" | ");
  return details.length > 800 ? `${details.slice(0, 800)}…` : details;
}

export async function selectRemoteAdapter(
  executor: SshExecutor,
  options: SelectRemoteAdapterOptions = {},
): Promise<SelectedRemote> {
  const failures: ShellProbeFailure[] = [];
  const warnings: string[] = [];
  for (const shell of await shellCandidates(executor, options, warnings)) {
    const adapter = createAdapter(
      executor,
      shell,
      options.localPlatform ?? process.platform,
    );
    if (options.expectedPlatform && adapter.platform !== options.expectedPlatform) {
      failures.push({
        shell,
        reason: `expected ${options.expectedPlatform}, adapter is ${adapter.platform}`,
      });
      continue;
    }
    try {
      const workspace = await adapter.inspectWorkspace(options.requestedCwd);
      return { adapter, workspace, warnings };
    } catch (error) {
      // Connection, authentication, and cancellation errors affect every
      // candidate. Stop immediately instead of reporting one copy per shell.
      throwIfFatalProbeFailure(error);
      failures.push({ shell, reason: boundedProbeError(error) });
    }
  }

  const expected = options.expectedPlatform && options.expectedShell
    ? ` Expected ${options.expectedPlatform}/${options.expectedShell}.`
    : "";
  throw new Error(
    `Could not find a supported remote shell.${expected} `
      + "The host must provide Unix Bash, Zsh, or POSIX sh, PowerShell 7, or Windows PowerShell 5.1. "
      + `Probe results: ${formatProbeFailures(failures)}`,
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
