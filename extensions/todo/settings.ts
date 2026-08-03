import { registerExtensionSettings } from "@99percentpeople/pi-shared-settings";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  TODO_COLLAPSED_TASK_LIMIT_MAX,
  TODO_COLLAPSED_TASK_LIMIT_MIN,
  TODO_COLLAPSED_TASK_LIMIT_PRESETS,
  TODO_SETTINGS_NAMESPACE,
  type TodoConfig,
} from "./config.ts";

interface TodoSettingsController {
  getConfig(): TodoConfig;
  updateConfig(config: TodoConfig, ctx: ExtensionContext): void;
}

function collapsedTaskLimitValues(current: number): string[] {
  return [...new Set([...TODO_COLLAPSED_TASK_LIMIT_PRESETS, current])]
    .sort((left, right) => left - right)
    .map(String);
}

export function registerTodoSettings(
  pi: ExtensionAPI,
  controller: TodoSettingsController,
): void {
  registerExtensionSettings(pi, {
    namespace: TODO_SETTINGS_NAMESPACE,
    title: "Todo",
    settings: () => {
      const config = controller.getConfig();
      return [{
        id: "collapsedTaskLimit",
        label: "Collapsed items",
        description: "Number of tasks shown while Todo is collapsed",
        currentValue: String(config.collapsedTaskLimit),
        values: collapsedTaskLimitValues(config.collapsedTaskLimit),
      }, {
        id: "showDependencyNumbers",
        label: "Dependency numbers",
        description: "Show display-only task numbers and dependency references",
        currentValue: config.showDependencyNumbers ? "Show" : "Hide",
        values: ["Show", "Hide"],
      }];
    },
    onChange: (id, value, ctx) => {
      const config = controller.getConfig();
      if (id === "collapsedTaskLimit") {
        const collapsedTaskLimit = Number(value);
        if (
          !Number.isInteger(collapsedTaskLimit)
          || collapsedTaskLimit < TODO_COLLAPSED_TASK_LIMIT_MIN
          || collapsedTaskLimit > TODO_COLLAPSED_TASK_LIMIT_MAX
        ) return;
        controller.updateConfig({ ...config, collapsedTaskLimit }, ctx);
      } else if (
        id === "showDependencyNumbers"
        && (value === "Show" || value === "Hide")
      ) {
        controller.updateConfig({
          ...config,
          showDependencyNumbers: value === "Show",
        }, ctx);
      }
    },
  });
}
