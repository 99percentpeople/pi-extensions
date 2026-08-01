import { homedir } from "node:os";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { posix } from "node:path";

export interface ParsedSshTarget {
  target: string;
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
 * Parse rsync-style SSH locations such as host:/srv/project. IPv6 literals must
 * use brackets, for example user@[2001:db8::1]:/srv/project.
 */
export function parseSshTarget(value: string): ParsedSshTarget {
  const input = value.trim();
  if (!input) throw new Error("--ssh requires a host or host:path value");
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
    const requestedCwd = bracketed[3]?.trim() || undefined;
    return { target, requestedCwd };
  }

  const separator = input.indexOf(":");
  const target = separator === -1 ? input : input.slice(0, separator);
  assertSafeTarget(target);
  if (target.includes("[") || target.includes("]")) {
    throw new Error(`Malformed bracketed SSH target: ${target}`);
  }

  const requestedCwd = separator === -1
    ? undefined
    : input.slice(separator + 1).trim() || undefined;
  return { target, requestedCwd };
}

export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("Shell values cannot contain NUL bytes");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function expandLocalPath(value: string, cwd: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
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

function isInsideLocalRoot(root: string, value: string): boolean {
  const fromRoot = relative(root, value);
  return fromRoot === "" || (
    !fromRoot.startsWith(`..${sep}`)
    && fromRoot !== ".."
    && !isAbsolute(fromRoot)
  );
}

function toPosix(value: string): string {
  return value.split(sep).join(posix.sep);
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
  if (!isAbsolute(value)) {
    return posix.resolve(remoteCwd, toPosix(value));
  }

  const localRoot = resolve(localCwd);
  const absolute = resolve(value);
  if (isInsideLocalRoot(localRoot, absolute)) {
    const fromRoot = relative(localRoot, absolute);
    return fromRoot
      ? posix.resolve(remoteCwd, toPosix(fromRoot))
      : posix.normalize(remoteCwd);
  }

  return posix.normalize(toPosix(value));
}
