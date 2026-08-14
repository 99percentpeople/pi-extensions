import { registerExtensionSettings } from "@99percentpeople/pi-shared-settings";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SSH_REMOTE_SETTINGS_NAMESPACE,
  type SshRemoteConfig,
} from "./config.ts";
import type { SshTransportPreference } from "./transport/client.ts";

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

function booleanForLabel(value: string): boolean | undefined {
  if (value === "On") return true;
  if (value === "Off") return false;
  return undefined;
}

function booleanLabel(value: boolean): string {
  return value ? "On" : "Off";
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
    }, {
      id: "passwordPrompt",
      label: "Password prompt",
      description: "Ask for an SSH password in the TUI when key/agent authentication fails",
      currentValue: booleanLabel(controller.getConfig().passwordPrompt),
      values: ["On", "Off"],
    }, {
      id: "persistPasswords",
      label: "Persist passwords",
      description: "Save entered passwords to a restricted secrets file so -r resumes reuse them without re-asking",
      currentValue: booleanLabel(controller.getConfig().persistPasswords),
      values: ["On", "Off"],
    }, {
      id: "aiControlTools",
      label: "AI control tools",
      description: "Let the model connect, exit, inspect, and change the cwd of SSH environments",
      currentValue: booleanLabel(controller.getConfig().aiControlTools),
      values: ["On", "Off"],
    }, {
      id: "aiPasswordAuth",
      label: "AI password auth",
      description: "Allow model-triggered SSH connections to request a password when key authentication fails",
      currentValue: booleanLabel(controller.getConfig().aiPasswordAuth),
      values: ["On", "Off"],
    }],
    onChange: (id, value, ctx) => {
      const config = controller.getConfig();
      if (id === "transport") {
        const transport = transportForLabel(value);
        if (transport) controller.updateConfig({ ...config, transport }, ctx);
        return;
      }
      if (
        id === "passwordPrompt"
        || id === "persistPasswords"
        || id === "aiControlTools"
        || id === "aiPasswordAuth"
      ) {
        const enabled = booleanForLabel(value);
        if (enabled !== undefined) {
          controller.updateConfig({ ...config, [id]: enabled }, ctx);
        }
      }
    },
  });
}

export { TRANSPORT_LABELS };
