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
  /** Persist entered passwords to a 0600 secrets file for -r resumes. */
  persistPasswords: boolean;
}

export const SSH_REMOTE_SETTINGS_NAMESPACE = "ssh-remote";

export const DEFAULT_SSH_REMOTE_CONFIG: SshRemoteConfig = {
  transport: "auto",
  passwordPrompt: true,
  persistPasswords: true,
};

export function normalizeSshRemoteConfig(value: unknown): SshRemoteConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_SSH_REMOTE_CONFIG };
  const transport = (value as { transport?: unknown }).transport;
  const passwordPrompt = (value as { passwordPrompt?: unknown }).passwordPrompt;
  const persistPasswords = (value as { persistPasswords?: unknown }).persistPasswords;
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
