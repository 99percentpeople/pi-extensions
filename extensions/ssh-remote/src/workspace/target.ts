import { homedir } from "node:os";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { posix, win32 } from "node:path";

export interface ParsedSshTarget {
  target: string;
  port?: number;
  requestedCwd?: string;
}

function assertSafeTarget(target: string): void {
  if (!target) throw new Error("SSH target cannot be empty");
  if (target.startsWith("-")) {
    throw new Error(`SSH target cannot start with '-': ${target}`);
  }
  if (/[\s\0\r\n]/.test(target)) {
    throw new Error("SSH target cannot contain whitespace or control characters");
  }
}

function normalizeBracketedTarget(user: string | undefined, host: string): string {
  return `${user ?? ""}${host}`;
}

/**
 * Parse the part after the host (for example `2201`, `2201:/srv`, or
 * `/srv`). A pure number is an SSH port; a number followed by `:path` is a
 * port plus remote cwd. Every other value keeps the legacy rsync-style cwd
 * meaning. Numeric directories must be written with an explicit `./` prefix.
 */
function parseSuffix(
  suffix: string | undefined,
  input: string,
): { port?: number; requestedCwd?: string } {
  const value = suffix?.trim() || "";
  if (!value) return { requestedCwd: undefined };

  const portAndCwd = /^(\d+)(?::(.*))?$/.exec(value);
  if (!portAndCwd) return { requestedCwd: value };

  const port = Number(portAndCwd[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    const target = input.slice(0, input.indexOf(value));
    throw new Error(
      `Invalid SSH port in ${JSON.stringify(input)}; use ${JSON.stringify(`${target}./${value}`)} for a numeric remote directory`,
    );
  }
  return {
    port,
    requestedCwd: portAndCwd[2]?.trim() || undefined,
  };
}

/**
 * Parse rsync-style SSH locations such as host:/srv/project or unified
 * host:2201:/srv/project targets. IPv6 literals must use brackets, for
 * example user@[2001:db8::1]:2201:/srv/project.
 */
export function parseSshTarget(value: string): ParsedSshTarget {
  const input = value.trim();
  if (!input) {
    throw new Error(
      "--ssh requires a host, host:path, host:port, or host:port:path value",
    );
  }
  if (/[\0\r\n]/.test(input)) {
    throw new Error("SSH location cannot contain control characters");
  }

  const bracketed = /^(?:([^@\s]+)@)?\[([^\]\s]+)\](?::(.*))?$/.exec(input);
  if (bracketed) {
    const target = normalizeBracketedTarget(
      bracketed[1] ? `${bracketed[1]}@` : undefined,
      bracketed[2],
    );
    assertSafeTarget(target);
    return { target, ...parseSuffix(bracketed[3], input) };
  }

  const separator = input.indexOf(":");
  const target = separator === -1 ? input : input.slice(0, separator);
  assertSafeTarget(target);
  if (target.includes("[") || target.includes("]")) {
    throw new Error(`Malformed bracketed SSH target: ${target}`);
  }

  return {
    target,
    ...parseSuffix(separator === -1 ? undefined : input.slice(separator + 1), input),
  };
}

export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("Shell values cannot contain NUL bytes");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function expandLocalPath(value: string, cwd: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(cwd, value);
}

export function normalizeRemoteHomePath(value: string, remoteHome: string): string {
  if (value === "~") return remoteHome;
  if (value.startsWith("~/")) return posix.resolve(remoteHome, value.slice(2));
  if (value.startsWith("~")) {
    throw new Error(`Remote ~user paths are not supported: ${value}`);
  }
  return value;
}

/** Normalize Pi's optional @ path prefix and expand ~ against the remote home. */
export function normalizeRemoteToolPath(value: string, remoteHome: string): string {
  const stripped = value.startsWith("@") ? value.slice(1) : value;
  return normalizeRemoteHomePath(stripped, remoteHome);
}

interface LocalPathApi {
  isAbsolute(value: string): boolean;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
  readonly sep: string;
}

const nativeLocalPathApi: LocalPathApi = { isAbsolute, relative, resolve, sep };

function localPathApi(cwd: string): LocalPathApi {
  return /^[A-Za-z]:[\\/]/.test(cwd) || /^\\\\[^\\]/.test(cwd)
    ? win32
    : nativeLocalPathApi;
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

function toPosix(value: string, separator: string): string {
  return value.split(separator).join(posix.sep);
}

/**
 * Map a cwd accepted by a local Pi tool into the active remote workspace.
 * Relative paths and local paths under localCwd retain their relative position;
 * unrelated absolute paths are interpreted as remote absolute paths.
 */
export function mapCwdToRemote(
  value: string,
  localCwd: string,
  remoteCwd: string,
): string {
  const api = localPathApi(localCwd);
  if (!api.isAbsolute(value)) {
    return posix.resolve(remoteCwd, toPosix(value, api.sep));
  }

  const localRoot = api.resolve(localCwd);
  const absolute = api.resolve(value);
  if (isInsideLocalRoot(api, localRoot, absolute)) {
    const fromRoot = api.relative(localRoot, absolute);
    return fromRoot
      ? posix.resolve(remoteCwd, toPosix(fromRoot, api.sep))
      : posix.normalize(remoteCwd);
  }

  if (
    api === win32
    && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value))
  ) {
    throw new Error(
      `Cannot map local absolute cwd to the remote Unix workspace: ${value}`,
    );
  }
  return posix.normalize(toPosix(value, api.sep));
}
