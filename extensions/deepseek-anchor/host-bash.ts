import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface HostBashOptions {
  shellPath?: string;
  commandPrefix?: string;
}

function readSettingsObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    // Best-effort mirror of the host settings. If Pi's settings file is
    // locked, malformed, or unreadable, fall back to the defaults used by
    // createBashToolDefinition rather than breaking the Bash tool.
    return undefined;
  }
}

function normalizeShellPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  // Accept the Windows spelling as well. The exact-dsh wrapper is
  // POSIX-only, but this helper itself remains platform-agnostic.
  if (process.platform === "win32" && trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function pickSetting(
  project: Record<string, unknown> | undefined,
  global: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  // Project settings override global settings, matching Pi's deep merge.
  // An empty string is equivalent to "unset" for both shellPath and
  // shellCommandPrefix once they reach createBashToolDefinition.
  for (const source of [project, global]) {
    if (!source || typeof source[key] !== "string") continue;
    const value = (source[key] as string).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * Reproduce the options Pi passes to its built-in Bash tool
 * (settings.shellPath and settings.shellCommandPrefix) so the exact-dsh
 * compatibility wrapper remains behaviorally transparent whenever it runs a
 * non-exact Bash command. The settings files are documented Pi locations:
 * `~/.pi/agent/settings.json` and `<cwd>/.pi/settings.json`; project settings
 * only count while the project is trusted, exactly like Pi's SettingsManager.
 */
export function loadHostBashOptions(
  cwd: string,
  projectTrusted = true,
): HostBashOptions {
  const global = readSettingsObject(join(getAgentDir(), "settings.json"));
  const project = projectTrusted
    ? readSettingsObject(join(cwd, CONFIG_DIR_NAME, "settings.json"))
    : undefined;

  const shellPath = pickSetting(project, global, "shellPath");
  const commandPrefix = pickSetting(project, global, "shellCommandPrefix");

  return {
    ...(shellPath === undefined ? {} : { shellPath: normalizeShellPath(shellPath) }),
    ...(commandPrefix === undefined ? {} : { commandPrefix }),
  };
}
