import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  isAbsolute as isLocalAbsolute,
  relative as localRelative,
  resolve as resolveLocal,
  sep as localSeparator,
  win32,
} from "node:path";
import { controlDirectoryName } from "../background/control.ts";
import type {
  SshExecutor,
  SshRunOptions,
  SshRunResult,
} from "../transport/client.ts";
import type { SshRunCompletion } from "../transport/completion.ts";
import type {
  RemoteAdapter,
  RemoteDirectoryEntry,
  RemoteFindEntry,
  RemoteGrepMatch,
  RemoteGrepOptions,
  RemoteShell,
  RemoteWorkspace,
} from "./types.ts";

const VIRTUAL_WINDOWS_ROOT = "/__pi_ssh_remote_windows__";
const WINDOWS_LOCAL_WINDOWS_ROOT = "C:\\__pi_ssh_remote_windows__";
const WINDOWS_FILE_TRANSFER_TIMEOUT_SECONDS = 120;
const WINDOWS_SHELL_COMPLETION_GRACE_MS = 100;
const WINDOWS_SHELL_COMPLETION_PREFIX = "PI_SSH_WINDOWS_DONE";
const REMOTE_SESSION_ENV_KEYS = [
  "PI_SESSION_ID",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;
const IMAGE_MIME_BY_EXTENSION = new Map([
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

function encodeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoded Windows path segment");
  return Buffer.from(value, "base64url").toString("utf8");
}

function isFullyQualifiedWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value);
}

function validateWindowsPath(label: string, value: string): string {
  if (
    !value
    || !isFullyQualifiedWindowsPath(value)
    || value.startsWith("\\\\?\\")
    || value.startsWith("\\\\.\\")
    || /[\0\r\n\u001e\u001f]/.test(value)
  ) {
    throw new Error(`SSH returned an invalid remote Windows ${label}: ${JSON.stringify(value)}`);
  }
  return win32.normalize(value);
}

function normalizeWindowsHomePath(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return win32.resolve(home, value.slice(2));
  }
  if (value.startsWith("~")) {
    throw new Error(`Remote ~user paths are not supported: ${value}`);
  }
  return value;
}

export function resolveWindowsRemotePath(
  value: string,
  home: string,
  cwd: string,
): string {
  const stripped = value.startsWith("@") ? value.slice(1) : value;
  const expanded = normalizeWindowsHomePath(stripped, home);
  if (/^[A-Za-z]:[^\\/]/.test(expanded)) {
    throw new Error(`Drive-relative Windows paths are not supported: ${value}`);
  }
  const resolved = isFullyQualifiedWindowsPath(expanded) ? expanded : win32.resolve(cwd, expanded);
  return validateWindowsPath("path", resolved);
}

export function encodeWindowsToolPath(
  nativePath: string,
  localPlatform: NodeJS.Platform = process.platform,
): string {
  const normalized = validateWindowsPath("path", nativePath);
  let kind: "drive" | "unc";
  let components: string[];
  if (normalized.startsWith("\\\\")) {
    kind = "unc";
    components = normalized.slice(2).split("\\").filter(Boolean);
    if (components.length < 2) throw new Error(`Invalid UNC path: ${nativePath}`);
  } else {
    kind = "drive";
    components = [
      normalized.slice(0, 1).toUpperCase(),
      ...normalized.slice(3).split("\\").filter(Boolean),
    ];
  }

  const encoded = components.map(encodeSegment);
  return localPlatform === "win32"
    ? win32.join(WINDOWS_LOCAL_WINDOWS_ROOT, kind, ...encoded)
    : `${VIRTUAL_WINDOWS_ROOT}/${kind}/${encoded.join("/")}`;
}

export function decodeWindowsToolPath(toolPath: string): string {
  let normalized = toolPath.replace(/\\/g, "/");
  const windowsLocal = /^[A-Za-z]:(\/__pi_ssh_remote_windows__(?:\/|$).*)$/i.exec(
    normalized,
  );
  if (windowsLocal) normalized = windowsLocal[1];
  if (!normalized.startsWith(`${VIRTUAL_WINDOWS_ROOT}/`)) {
    throw new Error(`Invalid logical Windows tool path: ${toolPath}`);
  }
  const parts = normalized.slice(VIRTUAL_WINDOWS_ROOT.length + 1).split("/").filter(Boolean);
  const kind = parts.shift();
  if (kind === "drive") {
    if (parts.length < 1) throw new Error(`Invalid logical Windows drive path: ${toolPath}`);
    const drive = decodeSegment(parts.shift()!);
    if (!/^[A-Za-z]$/.test(drive)) throw new Error(`Invalid Windows drive: ${drive}`);
    const components = parts.map(decodeSegment);
    return `${drive.toUpperCase()}:\\${components.join("\\")}`;
  }
  if (kind === "unc") {
    if (parts.length < 2) throw new Error(`Invalid logical Windows UNC path: ${toolPath}`);
    return `\\\\${parts.map(decodeSegment).join("\\")}`;
  }
  throw new Error(`Invalid logical Windows path kind: ${kind ?? "missing"}`);
}

function powerShellExecutable(shell: RemoteShell): string {
  if (shell === "pwsh") return "pwsh.exe";
  if (shell === "powershell") return "powershell.exe";
  throw new Error(`Unsupported Windows remote shell: ${shell}`);
}

export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function buildPowerShellInvocation(
  shell: RemoteShell,
  script: string,
  nonInteractive = true,
): string {
  const mode = nonInteractive ? " -NonInteractive" : "";
  let encoded = encodePowerShell(script);
  if (encoded.length > 6_000) {
    const compressed = gzipSync(Buffer.from(script, "utf8")).toString("base64");
    const loader = `
$data = [Convert]::FromBase64String('${compressed}')
$inputStream = New-Object IO.MemoryStream(,$data)
$gzip = New-Object IO.Compression.GzipStream($inputStream, [IO.Compression.CompressionMode]::Decompress)
$reader = New-Object IO.StreamReader($gzip, [Text.Encoding]::UTF8)
try { $source = $reader.ReadToEnd() } finally { $reader.Dispose(); $gzip.Dispose(); $inputStream.Dispose() }
& ([ScriptBlock]::Create($source))
`;
    encoded = encodePowerShell(loader);
  }
  if (encoded.length > 7_500) {
    throw new Error("PowerShell control script exceeds the Windows command-line limit");
  }
  return `${powerShellExecutable(shell)} -NoLogo -NoProfile${mode} -EncodedCommand ${encoded}`;
}

function decodeUtf8Base64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function utf8BytesExpression(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`;
}

function writeFrameScript(prefix: string, values: string[]): string {
  const joined = values.map((value) => `(${value})`).join(` + [char]31 + `);
  return `
$frame = ([char]30 + '${prefix}' + [char]31 + ${joined} + [char]30)
$bytes = [Text.Encoding]::UTF8.GetBytes($frame)
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
`;
}

function wrappedPowerShellScript(body: string): string {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
if (Get-Variable -Name PSStyle -ErrorAction SilentlyContinue) { $PSStyle.OutputRendering = 'PlainText' }
try {
${body}
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
}

function parseFrame(text: string, prefix: string): string | undefined {
  const marker = `\u001e${prefix}\u001f`;
  const start = text.lastIndexOf(marker);
  const end = start === -1 ? -1 : text.indexOf("\u001e", start + marker.length);
  return start === -1 || end === -1 ? undefined : text.slice(start + marker.length, end);
}

interface LocalPathApi {
  isAbsolute(value: string): boolean;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
  readonly sep: string;
}

const nativeLocalPathApi: LocalPathApi = {
  isAbsolute: isLocalAbsolute,
  relative: localRelative,
  resolve: resolveLocal,
  sep: localSeparator,
};

function localPathApi(cwd: string): LocalPathApi {
  return isFullyQualifiedWindowsPath(cwd) ? win32 : nativeLocalPathApi;
}

function isInsideLocalRoot(
  api: LocalPathApi,
  root: string,
  value: string,
): boolean {
  const fromRoot = api.relative(root, value);
  return fromRoot === "" || (
    !fromRoot.startsWith(`..${api.sep}`)
    && fromRoot !== ".."
    && !api.isAbsolute(fromRoot)
  );
}

export interface WindowsPowerShellCommandHooks {
  /** Runs after the PowerShell runtime is initialized but before the user command. */
  before?: string;
  /** Runs even when the user command throws or exits. */
  finally?: string;
}

function applyWindowsPowerShellCommandHooks(
  body: string,
  hooks?: WindowsPowerShellCommandHooks,
): string {
  return hooks?.finally !== undefined
    ? `${hooks.before ?? ""}\ntry {\n${body}\n} finally {\n${hooks.finally}\n}`
    : `${hooks?.before ?? ""}\n${body}`;
}

function buildWindowsShellCompletion(token: string): SshRunCompletion {
  return {
    startMarker: Buffer.from(
      `\u001e${WINDOWS_SHELL_COMPLETION_PREFIX}\u001f${token}\u001f`,
      "utf8",
    ),
    endMarker: Buffer.from("\u001e", "utf8"),
    graceMs: WINDOWS_SHELL_COMPLETION_GRACE_MS,
  };
}

function buildWindowsShellCompletionScript(token: string): string {
  return `
$completionExitCode = $(if ($commandCompleted) { [string]$commandExitCode } else { '?' })
$completionFrame = ([char]30 + '${WINDOWS_SHELL_COMPLETION_PREFIX}' + [char]31 + '${token}' + [char]31 + $completionExitCode + [char]30)
$completionBytes = [Text.Encoding]::UTF8.GetBytes($completionFrame)
$completionStream = [Console]::OpenStandardError()
$completionStream.Write($completionBytes, 0, $completionBytes.Length)
$completionStream.Flush()
`;
}

/** Record a PowerShell root PID and start time for out-of-band tree cleanup. */
export function buildWindowsProcessControlHooks(
  token: string,
): WindowsPowerShellCommandHooks {
  const directory = controlDirectoryName(token);
  return {
    before: `
$controlDirectory = Join-Path ([IO.Path]::GetTempPath()) '${directory}'
$statePath = Join-Path $controlDirectory 'state'
if ([IO.Directory]::Exists($controlDirectory)) { throw 'SSH process control path already exists' }
[IO.Directory]::CreateDirectory($controlDirectory) | Out-Null
$controlUtf8 = New-Object Text.UTF8Encoding($false)
$rootStartedAt = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
[IO.File]::WriteAllText($statePath, ("$PID $rootStartedAt"), $controlUtf8)
`,
    finally: `
Remove-Item -LiteralPath $controlDirectory -Recurse -Force -ErrorAction SilentlyContinue
`,
  };
}

/** Terminate the validated PowerShell root and every descendant with taskkill. */
export function buildWindowsProcessTreeKillCommand(
  shell: RemoteShell,
  token: string,
): string {
  const directory = controlDirectoryName(token);
  const controller = `
$ErrorActionPreference = 'Stop'
$controlDirectory = Join-Path ([IO.Path]::GetTempPath()) '${directory}'
$statePath = Join-Path $controlDirectory 'state'
for ($attempt = 0; $attempt -lt 30 -and -not [IO.File]::Exists($statePath); $attempt++) {
  Start-Sleep -Milliseconds 100
}
if (-not [IO.File]::Exists($statePath)) { exit 75 }
$rootParts = [IO.File]::ReadAllText($statePath).Trim() -split ' '
$rootProcessId = 0
$rootStartedAt = [long]0
if ($rootParts.Count -ne 2 -or -not [int]::TryParse($rootParts[0], [ref]$rootProcessId) -or $rootProcessId -le 0 -or -not [long]::TryParse($rootParts[1], [ref]$rootStartedAt)) { exit 76 }
$rootProcess = Get-Process -Id $rootProcessId -ErrorAction SilentlyContinue
if ($null -eq $rootProcess -or $rootProcess.StartTime.ToUniversalTime().Ticks -ne $rootStartedAt) {
  Remove-Item -LiteralPath $controlDirectory -Recurse -Force -ErrorAction SilentlyContinue
  exit 77
}
& taskkill.exe /PID $rootProcessId /T /F 2>$null | Out-Null
$exitCode = $LASTEXITCODE
if ($exitCode -eq 0) {
  Remove-Item -LiteralPath $controlDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
exit $exitCode
`;
  return buildPowerShellInvocation(shell, controller);
}

export function buildWindowsPowerShellCommand(
  shell: RemoteShell,
  command: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
  interactive = false,
  hooks?: WindowsPowerShellCommandHooks,
  completionToken?: string,
): string {
  const assignments: string[] = [];
  for (const key of REMOTE_SESSION_ENV_KEYS) {
    const value = env?.[key];
    if (typeof value === "string") assignments.push(`$env:${key} = ${utf8BytesExpression(value)}`);
  }
  if (completionToken !== undefined && !/^[a-f0-9]{32}$/.test(completionToken)) {
    throw new Error("Invalid Windows shell completion token");
  }
  const commandBody = completionToken === undefined ? `
Set-Location -LiteralPath (${utf8BytesExpression(cwd)})
${assignments.join("\n")}
$global:LASTEXITCODE = 0
$command = ${utf8BytesExpression(command)}
& ([ScriptBlock]::Create($command))
if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) {
  exit $global:LASTEXITCODE
}
` : `
$commandExitCode = 0
$commandCompleted = $false
try {
  Set-Location -LiteralPath (${utf8BytesExpression(cwd)})
  ${assignments.join("\n")}
  $global:LASTEXITCODE = 0
  $command = ${utf8BytesExpression(command)}
  & ([ScriptBlock]::Create($command))
  if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) {
    $commandExitCode = [int]$global:LASTEXITCODE
  }
  $commandCompleted = $true
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $commandExitCode = 1
  $commandCompleted = $true
}
if ($commandCompleted) { exit $commandExitCode }
`;
  const effectiveHooks = completionToken === undefined ? hooks : {
    before: hooks?.before,
    finally: `${hooks?.finally ?? ""}\n${buildWindowsShellCompletionScript(completionToken)}`,
  };
  const body = applyWindowsPowerShellCommandHooks(commandBody, effectiveHooks);
  return buildPowerShellInvocation(shell, wrappedPowerShellScript(body), !interactive);
}

export class WindowsPowerShellAdapter implements RemoteAdapter {
  readonly platform = "windows" as const;

  constructor(
    private readonly executor: SshExecutor,
    readonly shell: "pwsh" | "powershell",
    private readonly localPlatform: NodeJS.Platform = process.platform,
  ) {}

  async inspectWorkspace(requestedCwd?: string): Promise<RemoteWorkspace> {
    const probeBody = `
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'PowerShell is not running on Windows' }
$homePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$cwdPath = (Get-Location).ProviderPath
${writeFrameScript("PI_SSH_WINDOWS_ENV", ["$homePath", "$cwdPath"])}
`;
    const probe = await this.executor.runChecked(
      buildPowerShellInvocation(this.shell, wrappedPowerShellScript(probeBody)),
      { timeoutSeconds: 15 },
    );
    const payload = parseFrame(probe.stdout.toString("utf8"), "PI_SSH_WINDOWS_ENV");
    const parts = payload?.split("\u001f");
    if (!parts || parts.length !== 2) {
      throw new Error("Could not determine the remote Windows HOME and working directory");
    }
    const home = validateWindowsPath("HOME", parts[0]);
    const initialCwd = validateWindowsPath("working directory", parts[1]);
    if (!requestedCwd) {
      return { platform: this.platform, shell: this.shell, home, cwd: initialCwd };
    }

    const requested = resolveWindowsRemotePath(requestedCwd, home, initialCwd);
    const cwdBody = `
$requested = ${utf8BytesExpression(requested)}
if (-not [IO.Directory]::Exists($requested)) { throw "Remote directory does not exist: $requested" }
Set-Location -LiteralPath $requested
$cwdPath = (Get-Location).ProviderPath
${writeFrameScript("PI_SSH_WINDOWS_CWD", ["$cwdPath"])}
`;
    const resolved = await this.executor.runChecked(
      buildPowerShellInvocation(this.shell, wrappedPowerShellScript(cwdBody)),
      { timeoutSeconds: 15 },
    );
    const cwdPayload = parseFrame(resolved.stdout.toString("utf8"), "PI_SSH_WINDOWS_CWD");
    if (cwdPayload === undefined) {
      throw new Error(`Could not resolve remote Windows working directory: ${requestedCwd}`);
    }
    const cwd = validateWindowsPath("working directory", cwdPayload);
    return { platform: this.platform, shell: this.shell, home, cwd };
  }

  toToolPath(path: string, workspace: RemoteWorkspace): string {
    return encodeWindowsToolPath(
      resolveWindowsRemotePath(path, workspace.home, workspace.cwd),
      this.localPlatform,
    );
  }

  fromToolPath(path: string): string {
    return decodeWindowsToolPath(path);
  }

  mapCwd(value: string, localCwd: string, workspace: RemoteWorkspace): string {
    const stripped = value.startsWith("@") ? value.slice(1) : value;
    const expanded = normalizeWindowsHomePath(stripped, workspace.home);
    if (expanded.startsWith(VIRTUAL_WINDOWS_ROOT)) return this.fromToolPath(expanded);

    const localPaths = localPathApi(localCwd);
    if (localPaths.isAbsolute(expanded)) {
      const localRoot = localPaths.resolve(localCwd);
      const absolute = localPaths.resolve(expanded);
      if (isInsideLocalRoot(localPaths, localRoot, absolute)) {
        const relative = localPaths.relative(localRoot, absolute);
        return relative
          ? win32.resolve(
              workspace.cwd,
              relative.split(localPaths.sep).join("\\"),
            )
          : workspace.cwd;
      }
      if (!isFullyQualifiedWindowsPath(expanded)) {
        throw new Error(
          `Cannot map local absolute cwd to the remote Windows workspace: ${value}`,
        );
      }
    }
    if (isFullyQualifiedWindowsPath(expanded)) {
      return validateWindowsPath("working directory", expanded);
    }
    return resolveWindowsRemotePath(expanded, workspace.home, workspace.cwd);
  }

  private async runControlledPowerShell(
    buildCommand: (hooks?: WindowsPowerShellCommandHooks) => string,
    options: SshRunOptions,
    checked: boolean,
  ): Promise<SshRunResult> {
    const { signal, timeoutSeconds, ...runOptions } = options;
    if (signal?.aborted) throw new Error("aborted");
    if (
      timeoutSeconds !== undefined
      && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
    ) {
      throw new Error("SSH timeout must be a positive number of seconds");
    }

    const controlled = signal !== undefined || timeoutSeconds !== undefined;
    if (!controlled) {
      return checked
        ? this.executor.runChecked(buildCommand(), runOptions)
        : this.executor.run(buildCommand(), runOptions);
    }

    // Windows OpenSSH does not reliably deliver SSH TERM/KILL requests to a
    // PowerShell process tree. Record the root PID for cancellable operations,
    // then clean it through a second channel before aborting the primary one.
    const token = randomBytes(16).toString("hex");
    const transportController = new AbortController();
    const command = buildCommand(buildWindowsProcessControlHooks(token));
    let stopReason: "aborted" | "timeout" | undefined;
    let stopPromise: Promise<void> | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const requestStop = (reason: "aborted" | "timeout"): void => {
      if (stopReason) return;
      stopReason = reason;
      stopPromise = this.executor.run(
        buildWindowsProcessTreeKillCommand(this.shell, token),
        { timeoutSeconds: 4, captureOutput: false },
      ).then((result) => {
        if (result.exitCode !== 0 && result.exitCode !== 77) {
          throw new Error(`Remote Windows process-tree cleanup failed (${result.exitCode ?? "signal"})`);
        }
      }).catch(() => {
        // The primary transport is still aborted below. Its hard cancellation
        // deadline prevents an unresponsive cleanup channel from wedging Pi.
      }).finally(() => {
        transportController.abort();
      });
      void stopPromise;
    };
    const onAbort = (): void => requestStop("aborted");

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (timeoutSeconds !== undefined) {
      timeoutHandle = setTimeout(() => requestStop("timeout"), timeoutSeconds * 1_000);
      timeoutHandle.unref?.();
    }

    let result: SshRunResult | undefined;
    let runError: unknown;
    try {
      result = checked
        ? await this.executor.runChecked(command, {
            ...runOptions,
            signal: transportController.signal,
          })
        : await this.executor.run(command, {
            ...runOptions,
            signal: transportController.signal,
          });
    } catch (error) {
      runError = error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      if (stopPromise) await stopPromise;
    }

    if (stopReason === "aborted") throw new Error("aborted");
    if (stopReason === "timeout") throw new Error(`timeout:${timeoutSeconds}`);
    if (runError) throw runError;
    if (!result) throw new Error("SSH command ended without a result");
    return result;
  }

  private runScript(
    script: string,
    options: SshRunOptions = {},
  ): Promise<SshRunResult> {
    return this.runControlledPowerShell(
      (hooks) => buildPowerShellInvocation(
        this.shell,
        wrappedPowerShellScript(applyWindowsPowerShellCommandHooks(script, hooks)),
      ),
      options,
      true,
    );
  }

  async readFile(path: string, signal?: AbortSignal): Promise<Buffer> {
    const nativePath = this.fromToolPath(path);
    const script = `
$path = ${utf8BytesExpression(nativePath)}
$bytes = [IO.File]::ReadAllBytes($path)
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
`;
    return (await this.runScript(script, {
      signal,
      timeoutSeconds: WINDOWS_FILE_TRANSFER_TIMEOUT_SECONDS,
    })).stdout;
  }

  async fileExists(path: string, signal?: AbortSignal): Promise<boolean> {
    const nativePath = this.fromToolPath(path);
    const result = await this.runScript(`
$path = ${utf8BytesExpression(nativePath)}
$exists = [IO.File]::Exists($path) -or [IO.Directory]::Exists($path)
[Console]::Out.Write($(if ($exists) { '1' } else { '0' }))
`, { signal });
    return result.stdout.toString("utf8") === "1";
  }

  async access(path: string, mode: "read" | "write", signal?: AbortSignal): Promise<void> {
    const nativePath = this.fromToolPath(path);
    const access = mode === "read" ? "[IO.FileAccess]::Read" : "[IO.FileAccess]::Write";
    const share = mode === "read" ? "[IO.FileShare]::ReadWrite" : "[IO.FileShare]::Read";
    const script = `
$path = ${utf8BytesExpression(nativePath)}
$stream = [IO.File]::Open($path, [IO.FileMode]::Open, ${access}, ${share})
$stream.Dispose()
`;
    await this.runScript(script, { signal });
  }

  async detectImageMimeType(path: string): Promise<string | null> {
    return IMAGE_MIME_BY_EXTENSION.get(win32.extname(this.fromToolPath(path)).toLowerCase()) ?? null;
  }

  async mkdir(path: string, signal?: AbortSignal): Promise<void> {
    const nativePath = this.fromToolPath(path);
    await this.runScript(`
$path = ${utf8BytesExpression(nativePath)}
[void][IO.Directory]::CreateDirectory($path)
`, { signal });
  }

  async writeFile(
    path: string,
    content: string | Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    const nativePath = this.fromToolPath(path);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const script = `
$path = ${utf8BytesExpression(nativePath)}
$remaining = [long]${bytes.length}
$inputStream = [Console]::OpenStandardInput()
$outputStream = [IO.File]::Open($path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  $buffer = New-Object byte[] 65536
  while ($remaining -gt 0) {
    $count = [int][Math]::Min([long]$buffer.Length, $remaining)
    $read = $inputStream.Read($buffer, 0, $count)
    if ($read -le 0) { throw "stdin closed before the declared file payload was received" }
    $outputStream.Write($buffer, 0, $read)
    $remaining -= $read
  }
} finally {
  $outputStream.Dispose()
}
`;
    await this.runScript(script, {
      input: bytes,
      signal,
      timeoutSeconds: WINDOWS_FILE_TRANSFER_TIMEOUT_SECONDS,
    });
  }

  async listDirectory(
    path: string,
    signal?: AbortSignal,
  ): Promise<RemoteDirectoryEntry[]> {
    const nativePath = this.fromToolPath(path);
    const result = await this.runScript(`
# PI_SSH_REMOTE_LS
$path = ${utf8BytesExpression(nativePath)}
if (-not [IO.Directory]::Exists($path)) {
  if ([IO.File]::Exists($path)) { throw "Not a directory: $path" }
  throw "Path not found: $path"
}
foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($path)) {
  $name = [IO.Path]::GetFileName($entry)
  $kind = $(if ([IO.Directory]::Exists($entry)) { 'D' } else { 'F' })
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($name))
  [Console]::Out.WriteLine("$kind\`t$encoded")
}
`, { signal });
    const entries: RemoteDirectoryEntry[] = [];
    for (const line of result.stdout.toString("utf8").split(/\r?\n/)) {
      if (!line) continue;
      const [kind, encoded] = line.split("\t", 2);
      if (!encoded) continue;
      entries.push({ name: decodeUtf8Base64(encoded), isDirectory: kind === "D" });
    }
    return entries;
  }

  async findEntries(
    path: string,
    pattern: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<RemoteFindEntry[]> {
    const nativePath = this.fromToolPath(path);
    const result = await this.runScript(`
# PI_SSH_REMOTE_FIND
$root = [IO.Path]::GetFullPath(${utf8BytesExpression(nativePath)})
if (-not [IO.Directory]::Exists($root)) { throw "Path not found: $root" }
$pattern = ${utf8BytesExpression(pattern.replace(/\\/g, "/"))}
$matchPath = $pattern.Contains('/')
$matcher = New-Object System.Management.Automation.WildcardPattern($pattern, [System.Management.Automation.WildcardOptions]::IgnoreCase)
$stack = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
$stack.Push([IO.DirectoryInfo]::new($root))
$count = 0
while ($stack.Count -gt 0 -and $count -lt ${limit}) {
  $directory = $stack.Pop()
  try { $entries = $directory.EnumerateFileSystemInfos() } catch { continue }
  foreach ($entry in $entries) {
    $isDirectory = ($entry.Attributes -band [IO.FileAttributes]::Directory) -ne 0
    if ($isDirectory -and ($entry.Name -eq '.git' -or $entry.Name -eq 'node_modules')) { continue }
    $relative = $entry.FullName.Substring($root.Length).TrimStart('\\', '/').Replace('\\', '/')
    $target = $(if ($matchPath) { $relative } else { $entry.Name })
    if ($matcher.IsMatch($target)) {
      $kind = $(if ($isDirectory) { 'D' } else { 'F' })
      $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($relative))
      [Console]::Out.WriteLine("$kind\`t$encoded")
      $count += 1
      if ($count -ge ${limit}) { break }
    }
    if ($isDirectory -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
      $stack.Push([IO.DirectoryInfo]$entry)
    }
  }
}
`, { signal });
    const entries: RemoteFindEntry[] = [];
    for (const line of result.stdout.toString("utf8").split(/\r?\n/)) {
      if (!line) continue;
      const [kind, encoded] = line.split("\t", 2);
      if (!encoded) continue;
      entries.push({
        path: decodeUtf8Base64(encoded).replace(/\\/g, "/"),
        isDirectory: kind === "D",
      });
    }
    return entries;
  }

  async grep(
    path: string,
    pattern: string,
    options: RemoteGrepOptions,
    signal?: AbortSignal,
  ): Promise<RemoteGrepMatch[]> {
    const nativePath = this.fromToolPath(path);
    const glob = options.glob?.replace(/\\/g, "/") ?? "";
    const result = await this.runScript(`
# PI_SSH_REMOTE_GREP
$root = [IO.Path]::GetFullPath(${utf8BytesExpression(nativePath)})
if (-not [IO.Directory]::Exists($root) -and -not [IO.File]::Exists($root)) { throw "Path not found: $root" }
$pattern = ${utf8BytesExpression(pattern)}
$regexPattern = $(if (${options.literal ? "$true" : "$false"}) { [Regex]::Escape($pattern) } else { $pattern })
$regexOptions = [Text.RegularExpressions.RegexOptions]::CultureInvariant
if (${options.ignoreCase ? "$true" : "$false"}) { $regexOptions = $regexOptions -bor [Text.RegularExpressions.RegexOptions]::IgnoreCase }
$regex = [Regex]::new($regexPattern, $regexOptions)
$glob = ${utf8BytesExpression(glob)}
$matchPath = $glob.Contains('/')
$globMatcher = $(if ($glob) { New-Object System.Management.Automation.WildcardPattern($glob, [System.Management.Automation.WildcardOptions]::IgnoreCase) } else { $null })
$files = New-Object 'System.Collections.Generic.Stack[System.IO.FileInfo]'
if ([IO.File]::Exists($root)) {
  $files.Push([IO.FileInfo]::new($root))
  $searchRoot = [IO.Path]::GetDirectoryName($root)
} else {
  $searchRoot = $root
  $directories = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
  $directories.Push([IO.DirectoryInfo]::new($root))
  while ($directories.Count -gt 0) {
    $directory = $directories.Pop()
    try { $entries = $directory.EnumerateFileSystemInfos() } catch { continue }
    foreach ($entry in $entries) {
      $isDirectory = ($entry.Attributes -band [IO.FileAttributes]::Directory) -ne 0
      if ($isDirectory) {
        if ($entry.Name -eq '.git' -or $entry.Name -eq 'node_modules') { continue }
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { $directories.Push([IO.DirectoryInfo]$entry) }
      } else {
        $files.Push([IO.FileInfo]$entry)
      }
    }
  }
}
$count = 0
while ($files.Count -gt 0 -and $count -lt ${options.limit}) {
  $file = $files.Pop()
  $relative = $file.FullName.Substring($searchRoot.Length).TrimStart('\\', '/').Replace('\\', '/')
  $target = $(if ($matchPath) { $relative } else { $file.Name })
  if ($null -ne $globMatcher -and -not $globMatcher.IsMatch($target)) { continue }
  $lineNumber = 0
  try {
    foreach ($text in [IO.File]::ReadLines($file.FullName)) {
      $lineNumber += 1
      if ($text.IndexOf([char]0) -ge 0) { break }
      if ($regex.IsMatch($text)) {
        $encodedPath = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($relative))
        $encodedFullPath = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($file.FullName))
        $encodedText = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
        [Console]::Out.WriteLine("$encodedPath\`t$lineNumber\`t$encodedText\`t$encodedFullPath")
        $count += 1
        if ($count -ge ${options.limit}) { break }
      }
    }
  } catch { continue }
}
`, { signal });
    const matches: RemoteGrepMatch[] = [];
    for (const line of result.stdout.toString("utf8").split(/\r?\n/)) {
      if (!line) continue;
      const [encodedPath, rawLineNumber, encodedText, encodedFullPath] = line.split("\t", 4);
      if (!encodedPath || !encodedText || !encodedFullPath) continue;
      const relative = decodeUtf8Base64(encodedPath).replace(/\\/g, "/");
      const lineNumber = Number(rawLineNumber);
      if (!Number.isInteger(lineNumber) || lineNumber < 1) continue;
      matches.push({
        path: relative,
        toolPath: encodeWindowsToolPath(
          decodeUtf8Base64(encodedFullPath),
          this.localPlatform,
        ),
        lineNumber,
        line: decodeUtf8Base64(encodedText),
      });
    }
    return matches;
  }

  buildShellCommand(
    command: string,
    cwd: string,
    env?: NodeJS.ProcessEnv,
    interactive = false,
  ): string {
    return buildWindowsPowerShellCommand(this.shell, command, cwd, env, interactive);
  }

  async runShell(
    command: string,
    cwd: string,
    options: SshRunOptions & { env?: NodeJS.ProcessEnv } = {},
  ): Promise<number | null> {
    const { env, ...runOptions } = options;
    const completionToken = randomBytes(16).toString("hex");
    const result = await this.runControlledPowerShell(
      (hooks) => buildWindowsPowerShellCommand(
        this.shell,
        command,
        cwd,
        env,
        false,
        hooks,
        completionToken,
      ),
      {
        ...runOptions,
        completion: buildWindowsShellCompletion(completionToken),
      },
      false,
    );
    if (result.exitCode === 255) {
      throw new Error("SSH transport failed (ssh exited with code 255)");
    }
    return result.exitCode;
  }
}
