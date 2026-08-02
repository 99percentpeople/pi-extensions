import { win32 } from "node:path";
import type { RemotePlatform, RemoteShell } from "./adapters/types.ts";

export const SSH_SESSION_STATE_TYPE = "pi-ssh-remote-state";
export const SSH_SESSION_STATE_VERSION = 2 as const;

export interface SshSessionState {
  version: typeof SSH_SESSION_STATE_VERSION;
  target: string;
  remotePlatform: RemotePlatform;
  remoteShell: RemoteShell;
  remoteCwd: string;
  remoteHome: string;
  requestedCwd?: string;
  configFile?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeOptionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && !/[\0\r\n]/.test(value));
}

function isValidTarget(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("-")
    && !/[\s\0\r\n]/.test(value);
}

function isValidUnixPath(value: string): boolean {
  return value.startsWith("/") && !/[\0\r\n]/.test(value);
}

function isValidWindowsPath(value: string): boolean {
  const fullyQualified = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value);
  return fullyQualified && win32.isAbsolute(value) && !/[\0\r\n]/.test(value);
}

function commonFieldsAreValid(value: Record<string, unknown>): boolean {
  return isValidTarget(value.target)
    && typeof value.remoteCwd === "string"
    && typeof value.remoteHome === "string"
    && isSafeOptionalString(value.requestedCwd)
    && isSafeOptionalString(value.configFile);
}

export function normalizeSshSessionState(value: unknown): SshSessionState | undefined {
  if (!isRecord(value) || !commonFieldsAreValid(value)) return undefined;

  // Version 1 represented Unix/Bash sessions implicitly. Normalize them to v2
  // in memory so existing conversations resume without a migration entry.
  if (value.version === 1) {
    if (!isValidUnixPath(value.remoteCwd as string) || !isValidUnixPath(value.remoteHome as string)) {
      return undefined;
    }
    return {
      version: SSH_SESSION_STATE_VERSION,
      target: value.target as string,
      remotePlatform: "unix",
      remoteShell: "bash",
      remoteCwd: value.remoteCwd as string,
      remoteHome: value.remoteHome as string,
      requestedCwd: value.requestedCwd as string | undefined,
      configFile: value.configFile as string | undefined,
    };
  }

  if (value.version !== SSH_SESSION_STATE_VERSION) return undefined;
  if (value.remotePlatform !== "unix" && value.remotePlatform !== "windows") return undefined;
  if (value.remoteShell !== "bash" && value.remoteShell !== "zsh" && value.remoteShell !== "pwsh" && value.remoteShell !== "powershell") {
    return undefined;
  }
  if (value.remotePlatform === "unix") {
    if (value.remoteShell !== "bash" && value.remoteShell !== "zsh") return undefined;
    if (!isValidUnixPath(value.remoteCwd as string) || !isValidUnixPath(value.remoteHome as string)) {
      return undefined;
    }
  } else {
    if (value.remoteShell === "bash") return undefined;
    if (!isValidWindowsPath(value.remoteCwd as string) || !isValidWindowsPath(value.remoteHome as string)) {
      return undefined;
    }
  }

  return {
    version: SSH_SESSION_STATE_VERSION,
    target: value.target as string,
    remotePlatform: value.remotePlatform,
    remoteShell: value.remoteShell,
    remoteCwd: value.remoteCwd as string,
    remoteHome: value.remoteHome as string,
    requestedCwd: value.requestedCwd as string | undefined,
    configFile: value.configFile as string | undefined,
  };
}

export function findSshSessionState(entries: readonly unknown[]): SshSessionState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SSH_SESSION_STATE_TYPE) {
      continue;
    }
    const state = normalizeSshSessionState(entry.data);
    if (state) return state;
  }
  return undefined;
}

export function formatRemoteLocation(state: Pick<SshSessionState, "target" | "remoteCwd">): string {
  return `${state.target}:${state.remoteCwd}`;
}
