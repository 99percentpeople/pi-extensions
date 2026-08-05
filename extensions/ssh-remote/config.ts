import {
  getSharedSettingsPath,
  readSettingsNamespace,
  writeSettingsNamespace,
} from "@99percentpeople/pi-shared-settings";
import type { SshTransportPreference } from "./client.ts";

export interface SshRemoteConfig {
  transport: SshTransportPreference;
  /** Ask for an SSH password in the TUI when key/agent auth fails. */
  passwordPrompt: boolean;
  /** Persist entered passwords to a restricted secrets file for -r resumes. */
  persistPasswords: boolean;
  /** Expose tools that let the model connect, exit, inspect, or change SSH cwd. */
  aiControlTools: boolean;
  /** Allow model-triggered SSH connections to authenticate with a password. */
  aiPasswordAuth: boolean;
}

export const SSH_REMOTE_SETTINGS_NAMESPACE = "ssh-remote";

export const DEFAULT_SSH_REMOTE_CONFIG: SshRemoteConfig = {
  transport: "auto",
  passwordPrompt: true,
  persistPasswords: true,
  aiControlTools: false,
  aiPasswordAuth: true,
};

export function normalizeSshRemoteConfig(value: unknown): SshRemoteConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_SSH_REMOTE_CONFIG };
  const transport = (value as { transport?: unknown }).transport;
  const passwordPrompt = (value as { passwordPrompt?: unknown }).passwordPrompt;
  const persistPasswords = (value as { persistPasswords?: unknown }).persistPasswords;
  const aiControlTools = (value as { aiControlTools?: unknown }).aiControlTools;
  const aiPasswordAuth = (value as { aiPasswordAuth?: unknown }).aiPasswordAuth;
  return {
    transport: transport === "openssh" || transport === "ssh2" || transport === "auto"
      ? transport
      : DEFAULT_SSH_REMOTE_CONFIG.transport,
    passwordPrompt: typeof passwordPrompt === "boolean"
      ? passwordPrompt
      : DEFAULT_SSH_REMOTE_CONFIG.passwordPrompt,
    persistPasswords: typeof persistPasswords === "boolean"
      ? persistPasswords
      : DEFAULT_SSH_REMOTE_CONFIG.persistPasswords,
    aiControlTools: typeof aiControlTools === "boolean"
      ? aiControlTools
      : DEFAULT_SSH_REMOTE_CONFIG.aiControlTools,
    aiPasswordAuth: typeof aiPasswordAuth === "boolean"
      ? aiPasswordAuth
      : DEFAULT_SSH_REMOTE_CONFIG.aiPasswordAuth,
  };
}

export function getSshRemoteConfigPath(): string {
  return getSharedSettingsPath();
}

export function loadSshRemoteConfig(path = getSshRemoteConfigPath()): SshRemoteConfig {
  return readSettingsNamespace(SSH_REMOTE_SETTINGS_NAMESPACE, normalizeSshRemoteConfig, path);
}

export function saveSshRemoteConfig(
  config: SshRemoteConfig,
  path = getSshRemoteConfigPath(),
): void {
  writeSettingsNamespace(SSH_REMOTE_SETTINGS_NAMESPACE, normalizeSshRemoteConfig(config), path);
}
