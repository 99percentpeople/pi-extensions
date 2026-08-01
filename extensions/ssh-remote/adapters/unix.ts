import type { SshExecutor, SshRunOptions } from "../client.ts";
import {
  mapCwdToRemote,
  normalizeRemoteToolPath,
  normalizeRemoteHomePath,
  shellQuote,
} from "../target.ts";
import type { RemoteAdapter, RemoteWorkspace } from "./types.ts";

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

function remoteSessionExports(env: NodeJS.ProcessEnv | undefined): string {
  if (!env) return "";
  const assignments: string[] = [];
  for (const key of REMOTE_SESSION_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string") assignments.push(`${key}=${shellQuote(value)}`);
  }
  return assignments.length > 0 ? `export ${assignments.join(" ")}; ` : "";
}

export function buildUnixBashCommand(
  command: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): string {
  return `cd -- ${shellQuote(cwd)} && ${remoteSessionExports(env)}exec bash -lc ${shellQuote(command)}`;
}

export class UnixBashAdapter implements RemoteAdapter {
  readonly platform = "unix" as const;
  readonly shell = "bash" as const;

  constructor(private readonly executor: SshExecutor) {}

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
    return normalizeRemoteToolPath(path, workspace.home);
  }

  fromToolPath(path: string): string {
    return path;
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

  buildShellCommand(
    command: string,
    cwd: string,
    env?: NodeJS.ProcessEnv,
    _interactive = false,
  ): string {
    return buildUnixBashCommand(command, cwd, env);
  }

  async runShell(
    command: string,
    cwd: string,
    options: SshRunOptions & { env?: NodeJS.ProcessEnv },
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
