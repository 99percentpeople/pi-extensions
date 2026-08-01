import {
  isAbsolute as isLocalAbsolute,
  relative as localRelative,
  resolve as resolveLocal,
  sep as localSeparator,
  win32,
} from "node:path";
import type { SshExecutor, SshRunOptions } from "../client.ts";
import type { RemoteAdapter, RemoteShell, RemoteWorkspace } from "./types.ts";

const WINDOWS_ENV_START = "\u001ePI_SSH_WINDOWS_ENV\u001f";
const WINDOWS_CWD_START = "\u001ePI_SSH_WINDOWS_CWD\u001f";
const VIRTUAL_WINDOWS_ROOT = "/__pi_ssh_remote_windows__";
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

export function encodeWindowsToolPath(nativePath: string): string {
  const normalized = validateWindowsPath("path", nativePath);
  if (normalized.startsWith("\\\\")) {
    const components = normalized.slice(2).split("\\").filter(Boolean);
    if (components.length < 2) throw new Error(`Invalid UNC path: ${nativePath}`);
    return `${VIRTUAL_WINDOWS_ROOT}/unc/${components.map(encodeSegment).join("/")}`;
  }

  const drive = normalized.slice(0, 1).toUpperCase();
  const rest = normalized.slice(3).split("\\").filter(Boolean);
  return `${VIRTUAL_WINDOWS_ROOT}/drive/${encodeSegment(drive)}${rest.length ? `/${rest.map(encodeSegment).join("/")}` : ""}`;
}

export function decodeWindowsToolPath(toolPath: string): string {
  const normalized = toolPath.replace(/\\/g, "/");
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
  return `${powerShellExecutable(shell)} -NoLogo -NoProfile${mode} -EncodedCommand ${encodePowerShell(script)}`;
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

function isInsideLocalRoot(root: string, value: string): boolean {
  const fromRoot = localRelative(root, value);
  return fromRoot === "" || (
    !fromRoot.startsWith(`..${localSeparator}`)
    && fromRoot !== ".."
    && !isLocalAbsolute(fromRoot)
  );
}

export function buildWindowsPowerShellCommand(
  shell: RemoteShell,
  command: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
  interactive = false,
): string {
  const assignments: string[] = [];
  for (const key of REMOTE_SESSION_ENV_KEYS) {
    const value = env?.[key];
    if (typeof value === "string") assignments.push(`$env:${key} = ${utf8BytesExpression(value)}`);
  }
  const body = `
Set-Location -LiteralPath (${utf8BytesExpression(cwd)})
${assignments.join("\n")}
$global:LASTEXITCODE = 0
$command = ${utf8BytesExpression(command)}
& ([ScriptBlock]::Create($command))
if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) {
  exit $global:LASTEXITCODE
}
`;
  return buildPowerShellInvocation(shell, wrappedPowerShellScript(body), !interactive);
}

export class WindowsPowerShellAdapter implements RemoteAdapter {
  readonly platform = "windows" as const;

  constructor(
    private readonly executor: SshExecutor,
    readonly shell: "pwsh" | "powershell",
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
    return encodeWindowsToolPath(resolveWindowsRemotePath(path, workspace.home, workspace.cwd));
  }

  fromToolPath(path: string): string {
    return decodeWindowsToolPath(path);
  }

  mapCwd(value: string, localCwd: string, workspace: RemoteWorkspace): string {
    const stripped = value.startsWith("@") ? value.slice(1) : value;
    const expanded = normalizeWindowsHomePath(stripped, workspace.home);
    if (expanded.startsWith(VIRTUAL_WINDOWS_ROOT)) return this.fromToolPath(expanded);

    if (isLocalAbsolute(expanded) && !isFullyQualifiedWindowsPath(expanded)) {
      const localRoot = resolveLocal(localCwd);
      const absolute = resolveLocal(expanded);
      if (!isInsideLocalRoot(localRoot, absolute)) {
        throw new Error(`Cannot map local absolute cwd to the remote Windows workspace: ${value}`);
      }
      const relative = localRelative(localRoot, absolute);
      return relative
        ? win32.resolve(workspace.cwd, relative.split(localSeparator).join("\\"))
        : workspace.cwd;
    }
    if (isFullyQualifiedWindowsPath(expanded)) {
      return validateWindowsPath("working directory", expanded);
    }
    return resolveWindowsRemotePath(expanded, workspace.home, workspace.cwd);
  }

  private async runScript(script: string, options: SshRunOptions = {}) {
    return this.executor.runChecked(buildPowerShellInvocation(this.shell, wrappedPowerShellScript(script)), options);
  }

  async readFile(path: string, signal?: AbortSignal): Promise<Buffer> {
    const nativePath = this.fromToolPath(path);
    const script = `
$path = ${utf8BytesExpression(nativePath)}
$bytes = [IO.File]::ReadAllBytes($path)
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
`;
    return (await this.runScript(script, { signal })).stdout;
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
    const script = `
$path = ${utf8BytesExpression(nativePath)}
$inputStream = [Console]::OpenStandardInput()
$outputStream = [IO.File]::Open($path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
`;
    await this.runScript(script, { input: content, signal });
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
    options: SshRunOptions & { env?: NodeJS.ProcessEnv },
  ): Promise<number | null> {
    const { env, ...runOptions } = options;
    const result = await this.executor.run(this.buildShellCommand(command, cwd, env), runOptions);
    if (result.exitCode === 255) {
      throw new Error("SSH transport failed (ssh exited with code 255)");
    }
    return result.exitCode;
  }
}
