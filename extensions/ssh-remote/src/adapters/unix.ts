import type { SshExecutor, SshRunOptions } from "../transport/client.ts";
import {
  mapCwdToRemote,
  normalizeRemoteToolPath,
  normalizeRemoteHomePath,
  shellQuote,
} from "../workspace/target.ts";
import { posix, win32 } from "node:path";
import type {
  RemoteAdapter,
  RemoteDirectoryEntry,
  RemoteFindEntry,
  RemoteGrepMatch,
  RemoteGrepOptions,
  RemoteWorkspace,
} from "./types.ts";

const ENV_START = "\u001ePI_SSH_UNIX_ENV\u001f";
const CWD_START = "\u001ePI_SSH_UNIX_CWD\u001f";
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const REMOTE_SESSION_ENV_KEYS = [
  "PI_SESSION_ID",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;
const VIRTUAL_UNIX_ROOT = "/__pi_ssh_remote_unix__";
const WINDOWS_LOCAL_UNIX_ROOT = "C:\\__pi_ssh_remote_unix__";

function encodeUnixSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeUnixSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid encoded Unix path segment");
  }
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  if (
    !decoded
    || decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || /[\0\r\n\u001e\u001f]/.test(decoded)
    || encodeUnixSegment(decoded) !== value
  ) {
    throw new Error("Invalid encoded Unix path segment");
  }
  return decoded;
}

function encodeUnixToolPath(
  nativePath: string,
  localPlatform: NodeJS.Platform,
): string {
  const normalized = posix.normalize(validateUnixPath("path", nativePath));
  const segments = normalized.slice(1).split("/").filter(Boolean);
  const encoded = segments.map(encodeUnixSegment);
  return localPlatform === "win32"
    ? win32.join(WINDOWS_LOCAL_UNIX_ROOT, "root", ...encoded)
    : posix.join(VIRTUAL_UNIX_ROOT, "root", ...encoded);
}

function decodeUnixToolPath(toolPath: string): string {
  let normalized = toolPath.replace(/\\/g, "/");
  const windowsLocal = /^[A-Za-z]:(\/__pi_ssh_remote_unix__(?:\/|$).*)$/i.exec(
    normalized,
  );
  if (windowsLocal) normalized = windowsLocal[1];
  if (!normalized.startsWith(`${VIRTUAL_UNIX_ROOT}/`)) {
    throw new Error(`Invalid logical Unix tool path: ${toolPath}`);
  }
  const parts = normalized
    .slice(VIRTUAL_UNIX_ROOT.length + 1)
    .split("/")
    .filter(Boolean);
  if (parts.shift()?.toLowerCase() !== "root") {
    throw new Error(`Invalid logical Unix tool path: ${toolPath}`);
  }
  return posix.resolve("/", ...parts.map(decodeUnixSegment));
}

function validateUnixPath(label: string, value: string): string {
  if (!value || !value.startsWith("/") || /[\0\r\n\u001e\u001f]/.test(value)) {
    throw new Error(`SSH returned an invalid remote ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseFrame(text: string, prefix: string): string | undefined {
  const start = text.lastIndexOf(prefix);
  const end = start === -1 ? -1 : text.indexOf("\u001e", start + prefix.length);
  return start === -1 || end === -1 ? undefined : text.slice(start + prefix.length, end);
}

function splitNul(buffer: Buffer): string[] {
  const values = buffer.toString("utf8").split("\0");
  if (values.at(-1) === "") values.pop();
  return values;
}

function remoteSessionExports(env: NodeJS.ProcessEnv | undefined): string {
  if (!env) return "";
  const assignments: string[] = [];
  for (const key of REMOTE_SESSION_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string") assignments.push(`${key}=${shellQuote(value)}`);
  }
  return assignments.length > 0 ? `export ${assignments.join(" ")}; ` : "";
}

export type UnixUserShell = "bash" | "zsh" | "sh";

export function buildUnixBashCommand(
  command: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
  shell: UnixUserShell = "bash",
): string {
  // A login shell (-l) re-runs /etc/profile for every SSH operation. On
  // OpenWrt that profile prints /etc/banner, polluting every bash result.
  // SSH has already established the account environment, so execute the
  // selected shell non-interactively without replaying login startup files.
  return `cd -- ${shellQuote(cwd)} && ${remoteSessionExports(env)}exec ${shell} -c ${shellQuote(command)}`;
}

export class UnixBashAdapter implements RemoteAdapter {
  readonly platform = "unix" as const;
  readonly shell: UnixUserShell;

  constructor(
    private readonly executor: SshExecutor,
    private readonly localPlatform: NodeJS.Platform = process.platform,
    shell: UnixUserShell = "bash",
  ) {
    this.shell = shell;
  }

  async inspectWorkspace(requestedCwd?: string): Promise<RemoteWorkspace> {
    // Validate the user shell the adapter will exec for commands; the
    // control scripts themselves are POSIX and run through `sh`, so only
    // the user shell needs to exist (and sh always does).
    const required = this.shell === "sh" ? "sh" : this.shell;
    const environment = await this.executor.runChecked(
      `command -v ${required} >/dev/null 2>&1 || { printf 'Remote ${required} is required\\n' >&2; exit 127; }; `
        + `printf '\\036PI_SSH_UNIX_ENV\\037%s\\037%s\\036' "$HOME" "$(pwd -P)"`,
      { timeoutSeconds: 15 },
    );
    const payload = parseFrame(environment.stdout.toString("utf8"), ENV_START);
    const parts = payload?.split("\u001f");
    if (!parts || parts.length !== 2) {
      throw new Error("Could not determine the remote Unix HOME and working directory");
    }

    const home = validateUnixPath("HOME", parts[0]);
    const initialCwd = validateUnixPath("working directory", parts[1]);
    if (!requestedCwd) {
      return { platform: this.platform, shell: this.shell, home, cwd: initialCwd };
    }

    const requested = normalizeRemoteHomePath(requestedCwd, home);
    const resolved = await this.executor.runChecked(
      `cd -- ${shellQuote(requested)} && printf '\\036PI_SSH_UNIX_CWD\\037%s\\036' "$(pwd -P)"`,
      { timeoutSeconds: 15 },
    );
    const cwdPayload = parseFrame(resolved.stdout.toString("utf8"), CWD_START);
    if (cwdPayload === undefined) {
      throw new Error(`Could not resolve remote Unix working directory: ${requestedCwd}`);
    }
    const cwd = validateUnixPath("working directory", cwdPayload);
    return { platform: this.platform, shell: this.shell, home, cwd };
  }

  toToolPath(path: string, workspace: RemoteWorkspace): string {
    const normalized = normalizeRemoteToolPath(path, workspace.home);
    const nativePath = posix.resolve(workspace.cwd, normalized);
    return encodeUnixToolPath(nativePath, this.localPlatform);
  }

  fromToolPath(path: string): string {
    return decodeUnixToolPath(path);
  }

  mapCwd(value: string, localCwd: string, workspace: RemoteWorkspace): string {
    const normalized = normalizeRemoteHomePath(value, workspace.home);
    return mapCwdToRemote(normalized, localCwd, workspace.cwd);
  }

  async readFile(path: string, signal?: AbortSignal): Promise<Buffer> {
    return (await this.executor.runChecked(
      `cat ${shellQuote(this.fromToolPath(path))}`,
      { signal },
    )).stdout;
  }

  async fileExists(path: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.executor.run(
      `test -e ${shellQuote(this.fromToolPath(path))}`,
      { signal },
    );
    if (result.exitCode === 255) {
      throw new Error("SSH transport failed (ssh exited with code 255)");
    }
    return result.exitCode === 0;
  }

  async access(path: string, mode: "read" | "write", signal?: AbortSignal): Promise<void> {
    const remotePath = shellQuote(this.fromToolPath(path));
    const command = mode === "read"
      ? `test -r ${remotePath}`
      : `test -r ${remotePath} && test -w ${remotePath}`;
    await this.executor.runChecked(command, { signal });
  }

  async detectImageMimeType(path: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.executor.run(
      `command -v file >/dev/null 2>&1 && file --mime-type -b ${shellQuote(this.fromToolPath(path))}`,
      { signal },
    );
    if (result.exitCode !== 0) return null;
    const mimeType = result.stdout.toString("utf8").trim().toLowerCase();
    return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) ? mimeType : null;
  }

  async mkdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.executor.runChecked(`mkdir -p ${shellQuote(this.fromToolPath(path))}`, { signal });
  }

  async writeFile(
    path: string,
    content: string | Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.executor.runChecked(`cat > ${shellQuote(this.fromToolPath(path))}`, {
      input: content,
      signal,
    });
  }

  private runControl(script: string, signal?: AbortSignal): Promise<Buffer> {
    // Control scripts are POSIX sh (no bashisms) and therefore run through
    // `sh` on every Unix host: dash, bash, busybox ash, or macOS bash.
    return this.executor.runChecked(
      `exec sh -c ${shellQuote(script)}`,
      { signal },
    ).then((result) => result.stdout);
  }

  async listDirectory(
    path: string,
    signal?: AbortSignal,
  ): Promise<RemoteDirectoryEntry[]> {
    const root = this.fromToolPath(path);
    // POSIX: .* + * covers dotfiles (dotglob) and empty dirs collapse to a
    // literal * that fails -e/-L, which the case arms then skip.
    const output = await this.runControl(`
# PI_SSH_REMOTE_LS
cd -- ${shellQuote(root)} || exit 1
for entry in .* *; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  case "$entry" in .|..) continue ;; esac
  if [ -d "$entry" ]; then kind=D; else kind=F; fi
  printf '%s\\0%s\\0' "$kind" "$entry"
done
`, signal);
    const fields = splitNul(output);
    const entries: RemoteDirectoryEntry[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      entries.push({ name: fields[index + 1], isDirectory: fields[index] === "D" });
    }
    return entries;
  }

  async findEntries(
    path: string,
    pattern: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<RemoteFindEntry[]> {
    const root = this.fromToolPath(path);
    // POSIX has no process substitution or read -d; producers stream
    // through tr (filenames containing newlines are a known limitation),
    // and the { ...; exit 0; } group pins the pipeline exit status.
    const output = await this.runControl(`
# PI_SSH_REMOTE_FIND
cd -- ${shellQuote(root)} || exit 1
pattern=${shellQuote(pattern)}
limit=${limit}
count=0
emit() {
  rel="$1"
  kind=F
  [ -d "$rel" ] && kind=D
  printf '%s\\0%s\\0' "$kind" "$rel"
  count=$((count + 1))
  [ "$count" -ge "$limit" ]
}
if command -v rg >/dev/null 2>&1; then
  rg --files --hidden -0 -g '!**/.git/**' -g '!**/node_modules/**' -g "$pattern" . | tr '\\0' '\\n' | { while IFS= read -r rel; do
    rel="\${rel#./}"
    emit "$rel" && break
  done; exit 0; }
else
  find . -mindepth 1 -print0 | tr '\\0' '\\n' | { while IFS= read -r candidate; do
    rel="\${candidate#./}"
    case "$rel" in .git|.git/*|node_modules|node_modules/*|*/.git/*|*/node_modules/*) continue ;; esac
    if [ "$pattern" != "\${pattern%/*}" ]; then target="$rel"; else target="\${rel##*/}"; fi
    case "$target" in $pattern) emit "$rel" && break ;; esac
  done; exit 0; }
fi
exit 0
`, signal);
    const fields = splitNul(output);
    const entries: RemoteFindEntry[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      entries.push({
        path: fields[index + 1].replace(/\\/g, "/"),
        isDirectory: fields[index] === "D",
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
    const root = this.fromToolPath(path);
    const rgArgs = [
      "--json",
      "--line-number",
      "--color=never",
      "--hidden",
      "--glob",
      "!**/.git/**",
      "--glob",
      "!**/node_modules/**",
      ...(options.ignoreCase ? ["--ignore-case"] : []),
      ...(options.literal ? ["--fixed-strings"] : []),
      ...(options.glob ? ["--glob", options.glob] : []),
      "--",
      pattern,
    ];
    const quotedRg = rgArgs.map(shellQuote).join(" ");
    const fallbackFlags = [
      ...(options.ignoreCase ? ["-i"] : []),
      ...(options.literal ? ["-F"] : []),
    ].join(" ");
    const glob = options.glob ?? "";
    const output = await this.runControl(`
# PI_SSH_REMOTE_GREP
root=${shellQuote(root)}
if [ -d "$root" ]; then
  cd -- "$root" || exit 1
  target=.
elif [ -f "$root" ]; then
  cd -- "$(dirname -- "$root")" || exit 1
  target="./$(basename -- "$root")"
else
  printf 'Path not found: %s\\n' "$root" >&2
  exit 1
fi
file_candidates() {
  if [ "$target" = "." ]; then
    find . -type d \\( -name .git -o -name node_modules \\) -prune -o -type f -print0
  else
    printf '%s\\0' "$target"
  fi
}
if command -v rg >/dev/null 2>&1; then
  printf 'R\\0'
  status=0
  rg ${quotedRg} "$target" || status=$?
  [ "$status" -eq 0 ] || [ "$status" -eq 1 ] || exit "$status"
else
  printf 'G\\0'
  pattern=${shellQuote(pattern)}
  glob=${shellQuote(glob)}
  limit=${options.limit}
  count=0
  validation=0
  printf '' | grep ${fallbackFlags} -- "$pattern" >/dev/null 2>&1 || validation=$?
  [ "$validation" -eq 0 ] || [ "$validation" -eq 1 ] || { printf 'Invalid grep pattern\\n' >&2; exit 2; }
  # POSIX: no process substitution or read -d; the file loop and the
  # line loop are separate pipeline stages so count survives in one
  # shell. A temp file buffers each grep so empty results emit nothing
  # (paths containing colons mis-split, same as before).
  tmp=/tmp/pi-ssh-grep.$$
  trap 'rm -f "$tmp"' EXIT HUP INT TERM
  file_candidates | tr '\\0' '\\n' | { while IFS= read -r file; do
    rel="\${file#./}"
    if [ -n "$glob" ]; then case "$rel" in $glob) ;; *) continue ;; esac; fi
    grep -I -n ${fallbackFlags} -- "$pattern" "$file" > "$tmp"
    if [ -s "$tmp" ]; then
      awk -v r="$rel" '{ print r ":" $0 }' "$tmp"
    fi
  done; } | { while IFS=: read -r rel line text; do
    printf '%s\\0%s\\0%s\\0' "$rel" "$line" "$text"
    count=$((count + 1))
    if [ "$count" -ge "$limit" ]; then break; fi
  done; exit 0; }
fi
exit 0
`, signal);

    if (output.subarray(0, 2).equals(Buffer.from("R\0"))) {
      const matches: RemoteGrepMatch[] = [];
      const text = output.subarray(2).toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let event: {
          type?: unknown;
          data?: {
            path?: { text?: unknown };
            line_number?: unknown;
            lines?: { text?: unknown };
          };
        };
        try {
          event = JSON.parse(line) as typeof event;
        } catch {
          continue;
        }
        if (event.type !== "match") continue;
        const rawPath = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        const lineText = event.data?.lines?.text;
        if (typeof rawPath !== "string" || typeof lineNumber !== "number" || typeof lineText !== "string") continue;
        const relative = rawPath.replace(/^\.\//, "").replace(/\\/g, "/");
        matches.push({
          path: relative,
          toolPath: encodeUnixToolPath(
            posix.resolve(root, relative),
            this.localPlatform,
          ),
          lineNumber,
          line: lineText.replace(/\r?\n$/, ""),
        });
        if (matches.length >= options.limit) break;
      }
      return matches;
    }

    const fields = splitNul(output.subarray(2));
    const matches: RemoteGrepMatch[] = [];
    for (let index = 0; index + 2 < fields.length; index += 3) {
      const relative = fields[index].replace(/\\/g, "/");
      const lineNumber = Number(fields[index + 1]);
      if (!Number.isInteger(lineNumber) || lineNumber < 1) continue;
      matches.push({
        path: relative,
        toolPath: encodeUnixToolPath(
          posix.resolve(root, relative),
          this.localPlatform,
        ),
        lineNumber,
        line: fields[index + 2],
      });
    }
    return matches;
  }

  buildShellCommand(
    command: string,
    cwd: string,
    env?: NodeJS.ProcessEnv,
    _interactive = false,
  ): string {
    return buildUnixBashCommand(command, cwd, env, this.shell);
  }

  async runShell(
    command: string,
    cwd: string,
    options: SshRunOptions & { env?: NodeJS.ProcessEnv } = {},
  ): Promise<number | null> {
    const { env, ...runOptions } = options;
    const result = await this.executor.run(
      this.buildShellCommand(command, cwd, env),
      runOptions,
    );
    if (result.exitCode === 255) {
      throw new Error("SSH transport failed (ssh exited with code 255)");
    }
    return result.exitCode;
  }
}
