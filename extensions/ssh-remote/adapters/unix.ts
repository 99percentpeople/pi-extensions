import type { SshExecutor, SshRunOptions } from "../client.ts";
import {
  mapCwdToRemote,
  normalizeRemoteToolPath,
  normalizeRemoteHomePath,
  shellQuote,
} from "../target.ts";
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
const WINDOWS_LOCAL_UNIX_ROOT = "C:\\__pi_ssh_remote_unix__";

function encodeUnixSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeUnixSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid encoded Unix path segment");
  }
  return Buffer.from(value, "base64url").toString("utf8");
}

function encodeUnixToolPath(nativePath: string): string {
  const normalized = posix.normalize(validateUnixPath("path", nativePath));
  const segments = normalized.slice(1).split("/").filter(Boolean);
  return win32.join(
    WINDOWS_LOCAL_UNIX_ROOT,
    "root",
    ...segments.map(encodeUnixSegment),
  );
}

function decodeUnixToolPath(toolPath: string): string {
  const normalized = win32.normalize(toolPath);
  const relative = win32.relative(WINDOWS_LOCAL_UNIX_ROOT, normalized);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${win32.sep}`)
    || win32.isAbsolute(relative)
  ) {
    throw new Error(`Invalid logical Unix tool path: ${toolPath}`);
  }
  const parts = relative.split(win32.sep).filter(Boolean);
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
  return `cd -- ${shellQuote(cwd)} && ${remoteSessionExports(env)}exec ${shell} -lc ${shellQuote(command)}`;
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
    const environment = await this.executor.runChecked(
      `command -v bash >/dev/null 2>&1 || { printf 'Remote bash is required\\n' >&2; exit 127; }; `
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
    return this.localPlatform === "win32"
      ? encodeUnixToolPath(nativePath)
      : nativePath;
  }

  fromToolPath(path: string): string {
    return this.localPlatform === "win32"
      ? decodeUnixToolPath(path)
      : path;
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

  private runBashControl(script: string, signal?: AbortSignal): Promise<Buffer> {
    // Control scripts use Bash syntax (shopt, [[ ]], dotglob) and therefore
    // always run through Bash regardless of the user's default shell; only
    // user-entered commands go through the detected default shell.
    return this.executor.runChecked(
      `exec bash -lc ${shellQuote(script)}`,
      { signal },
    ).then((result) => result.stdout);
  }

  async listDirectory(
    path: string,
    signal?: AbortSignal,
  ): Promise<RemoteDirectoryEntry[]> {
    const root = this.fromToolPath(path);
    const output = await this.runBashControl(`
# PI_SSH_REMOTE_LS
cd -- ${shellQuote(root)}
shopt -s dotglob nullglob
for entry in *; do
  [[ "$entry" == "." || "$entry" == ".." ]] && continue
  if [[ -d "$entry" ]]; then kind=D; else kind=F; fi
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
    const output = await this.runBashControl(`
# PI_SSH_REMOTE_FIND
cd -- ${shellQuote(root)}
pattern=${shellQuote(pattern)}
limit=${limit}
count=0
emit() {
  local rel="$1" kind=F
  [[ -d "$rel" ]] && kind=D
  printf '%s\\0%s\\0' "$kind" "$rel"
  ((count += 1))
  ((count >= limit))
}
if command -v rg >/dev/null 2>&1; then
  while IFS= read -r -d '' rel; do
    rel="\${rel#./}"
    emit "$rel" && break
  done < <(rg --files --hidden -0 -g '!**/.git/**' -g '!**/node_modules/**' -g "$pattern" .)
else
  while IFS= read -r -d '' candidate; do
    rel="\${candidate#./}"
    [[ "$rel" == .git || "$rel" == .git/* || "$rel" == node_modules || "$rel" == node_modules/* || "$rel" == */.git/* || "$rel" == */node_modules/* ]] && continue
    if [[ "$pattern" == */* ]]; then target="$rel"; else target="\${rel##*/}"; fi
    [[ "$target" == $pattern ]] || continue
    emit "$rel" && break
  done < <(find . -mindepth 1 -print0)
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
    const output = await this.runBashControl(`
# PI_SSH_REMOTE_GREP
root=${shellQuote(root)}
if [[ -d "$root" ]]; then
  cd -- "$root"
  target=.
elif [[ -f "$root" ]]; then
  cd -- "$(dirname -- "$root")"
  target="./$(basename -- "$root")"
else
  printf 'Path not found: %s\\n' "$root" >&2
  exit 1
fi
file_candidates() {
  if [[ "$target" == "." ]]; then
    find . -type d \\( -name .git -o -name node_modules \\) -prune -o -type f -print0
  else
    printf '%s\\0' "$target"
  fi
}
if command -v rg >/dev/null 2>&1; then
  printf 'R\\0'
  status=0
  rg ${quotedRg} "$target" || status=$?
  ((status == 0 || status == 1)) || exit "$status"
else
  printf 'G\\0'
  pattern=${shellQuote(pattern)}
  glob=${shellQuote(glob)}
  limit=${options.limit}
  count=0
  stop=0
  validation=0
  printf '' | grep ${fallbackFlags} -- "$pattern" >/dev/null 2>&1 || validation=$?
  ((validation == 0 || validation == 1)) || { printf 'Invalid grep pattern\\n' >&2; exit 2; }
  while IFS= read -r -d '' file; do
    rel="\${file#./}"
    [[ -n "$glob" && "$rel" != $glob ]] && continue
    while IFS=: read -r line text; do
      printf '%s\\0%s\\0%s\\0' "$rel" "$line" "$text"
      ((count += 1))
      if ((count >= limit)); then stop=1; break; fi
    done < <(grep -I -n ${fallbackFlags} -- "$pattern" "$file")
    ((stop)) && break
  done < <(file_candidates)
fi
exit 0
`, signal);

    if (output.subarray(0, 2).equals(Buffer.from("R\0"))) {
      const matches: RemoteGrepMatch[] = [];
      const text = output.subarray(2).toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let event: any;
        try {
          event = JSON.parse(line);
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
          toolPath: this.localPlatform === "win32"
            ? encodeUnixToolPath(posix.resolve(root, relative))
            : posix.resolve(root, relative),
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
        toolPath: this.localPlatform === "win32"
          ? encodeUnixToolPath(posix.resolve(root, relative))
          : posix.resolve(root, relative),
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
