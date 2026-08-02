import { registerExtensionSettings } from "@99percentpeople/pi-shared-settings";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SSH_REMOTE_SETTINGS_NAMESPACE,
  type SshRemoteConfig,
} from "./config.ts";
import type { SshTransportPreference } from "./client.ts";

const TRANSPORT_LABELS: Record<SshTransportPreference, string> = {
  auto: "Auto",
  openssh: "OpenSSH",
  ssh2: "ssh2",
};

interface SshRemoteSettingsController {
  getConfig(): SshRemoteConfig;
  updateConfig(config: SshRemoteConfig, ctx: ExtensionContext): void;
}

function transportForLabel(value: string): SshTransportPreference | undefined {
  return (Object.entries(TRANSPORT_LABELS) as Array<[SshTransportPreference, string]>)
    .find(([, label]) => label === value)?.[0];
}

export function registerSshRemoteSettings(
  pi: ExtensionAPI,
  controller: SshRemoteSettingsController,
): void {
  registerExtensionSettings(pi, {
    namespace: SSH_REMOTE_SETTINGS_NAMESPACE,
    title: "SSH Remote",
    settings: () => [{
      id: "transport",
      label: "Transport",
      description: "Auto uses multiplexed OpenSSH on Unix and persistent ssh2 on Windows",
      currentValue: TRANSPORT_LABELS[controller.getConfig().transport],
      values: Object.values(TRANSPORT_LABELS),
    }],
    onChange: (id, value, ctx) => {
      if (id !== "transport") return;
      const transport = transportForLabel(value);
      if (!transport) return;
      controller.updateConfig({ ...controller.getConfig(), transport }, ctx);
    },
  });
}

export { TRANSPORT_LABELS };
