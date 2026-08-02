import {
  getSharedSettingsPath,
  readSettingsNamespace,
  writeSettingsNamespace,
} from "@99percentpeople/pi-shared-settings";
import type { SshTransportPreference } from "./client.ts";

export interface SshRemoteConfig {
  transport: SshTransportPreference;
}

export const SSH_REMOTE_SETTINGS_NAMESPACE = "ssh-remote";

export const DEFAULT_SSH_REMOTE_CONFIG: SshRemoteConfig = {
  transport: "auto",
};

export function normalizeSshRemoteConfig(value: unknown): SshRemoteConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_SSH_REMOTE_CONFIG };
  const transport = (value as { transport?: unknown }).transport;
  return {
    transport: transport === "openssh" || transport === "ssh2" || transport === "auto"
      ? transport
      : DEFAULT_SSH_REMOTE_CONFIG.transport,
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
