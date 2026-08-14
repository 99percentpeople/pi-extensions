import type { RemoteAdapter } from "../adapters/types.ts";
import {
  buildPowerShellInvocation,
  buildWindowsPowerShellCommand,
  buildWindowsProcessControlHooks,
  buildWindowsProcessTreeKillCommand,
} from "../adapters/windows.ts";
import {
  controlDirectoryName,
  WINDOWS_BACKGROUND_SIGNALS,
  type BackgroundSignal,
} from "./control.ts";

const WINDOWS_TERMINATION_SIGNALS = new Set<BackgroundSignal>(
  WINDOWS_BACKGROUND_SIGNALS,
);

/** Wrap a Windows background command and record the root PowerShell PID. */
export function buildWindowsBackgroundShellCommand(
  command: string,
  cwd: string,
  shell: RemoteAdapter["shell"],
  token: string,
  interactive: boolean,
  env?: NodeJS.ProcessEnv,
): string {
  if (shell !== "pwsh" && shell !== "powershell") {
    throw new Error(`Unsupported Windows SSH shell: ${shell}`);
  }
  return buildWindowsPowerShellCommand(
    shell,
    command,
    cwd,
    env,
    interactive,
    buildWindowsProcessControlHooks(token),
  );
}

/** Build the remote Windows half of a background termination request. */
export function buildWindowsBackgroundSignalCommand(
  token: string,
  signal: BackgroundSignal,
  shell: RemoteAdapter["shell"],
): string {
  if (shell !== "pwsh" && shell !== "powershell") {
    throw new Error(`Unsupported Windows SSH shell: ${shell}`);
  }
  if (!WINDOWS_TERMINATION_SIGNALS.has(signal)) {
    throw new Error(
      `${signal} cannot be delivered to a Windows SSH process tree; use SIGTERM or SIGKILL`,
    );
  }
  return buildWindowsProcessTreeKillCommand(shell, token);
}

/** Probe whether a Windows background root still owns the control record. */
export function buildWindowsBackgroundProbeCommand(
  token: string,
  shell: RemoteAdapter["shell"],
): string {
  if (shell !== "pwsh" && shell !== "powershell") {
    throw new Error(`Unsupported Windows SSH shell: ${shell}`);
  }
  const directory = controlDirectoryName(token);
  const controller = `
$ErrorActionPreference = 'Stop'
$controlDirectory = Join-Path ([IO.Path]::GetTempPath()) '${directory}'
$statePath = Join-Path $controlDirectory 'state'
if (-not [IO.File]::Exists($statePath)) { [Console]::Out.WriteLine('PI_SSH_BG_STATUS=finished'); exit 0 }
$rootParts = [IO.File]::ReadAllText($statePath).Trim() -split ' '
$rootProcessId = 0
$rootStartedAt = [long]0
if ($rootParts.Count -ne 2 -or -not [int]::TryParse($rootParts[0], [ref]$rootProcessId) -or $rootProcessId -le 0 -or -not [long]::TryParse($rootParts[1], [ref]$rootStartedAt)) { exit 76 }
$process = Get-Process -Id $rootProcessId -ErrorAction SilentlyContinue
if ($null -eq $process -or $process.HasExited -or $process.StartTime.ToUniversalTime().Ticks -ne $rootStartedAt) {
  Remove-Item -LiteralPath $controlDirectory -Recurse -Force -ErrorAction SilentlyContinue
  [Console]::Out.WriteLine('PI_SSH_BG_STATUS=finished')
  exit 0
}
[Console]::Out.WriteLine('PI_SSH_BG_STATUS=running')
`;
  return buildPowerShellInvocation(shell, controller);
}
