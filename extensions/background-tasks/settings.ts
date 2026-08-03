import { registerExtensionSettings } from "@99percentpeople/pi-shared-settings";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BACKGROUND_COLLAPSED_TASK_LIMIT_MAX,
  BACKGROUND_COLLAPSED_TASK_LIMIT_MIN,
  BACKGROUND_COLLAPSED_TASK_LIMIT_PRESETS,
  BACKGROUND_TASKS_SETTINGS_NAMESPACE,
  type BackgroundOutputPreview,
  type BackgroundTasksConfig,
} from "./config.ts";

const OUTPUT_PREVIEW_LABELS: Record<BackgroundOutputPreview, string> = {
  off: "Off",
  failures: "Failures",
  finished: "Finished",
  all: "All pipe tasks",
};

interface BackgroundTasksSettingsController {
  getConfig(): BackgroundTasksConfig;
  updateConfig(config: BackgroundTasksConfig, ctx: ExtensionContext): void;
}

function collapsedTaskLimitLabel(limit: number): string {
  return limit === 0 ? "Summary only" : String(limit);
}

function collapsedTaskLimitValues(current: number): string[] {
  return [...new Set([...BACKGROUND_COLLAPSED_TASK_LIMIT_PRESETS, current])]
    .sort((left, right) => left - right)
    .map(collapsedTaskLimitLabel);
}

function outputPreviewForLabel(value: string): BackgroundOutputPreview | undefined {
  return (Object.entries(OUTPUT_PREVIEW_LABELS) as Array<[BackgroundOutputPreview, string]>)
    .find(([, label]) => label === value)?.[0];
}

export function registerBackgroundTasksSettings(
  pi: ExtensionAPI,
  controller: BackgroundTasksSettingsController,
): void {
  registerExtensionSettings(pi, {
    namespace: BACKGROUND_TASKS_SETTINGS_NAMESPACE,
    title: "Background Tasks",
    settings: () => {
      const config = controller.getConfig();
      return [{
        id: "collapsedTaskLimit",
        label: "Collapsed tasks",
        description: "Number of task rows shown before the widget is expanded",
        currentValue: collapsedTaskLimitLabel(config.collapsedTaskLimit),
        values: collapsedTaskLimitValues(config.collapsedTaskLimit),
      }, {
        id: "outputPreview",
        label: "Output preview",
        description: "Choose which pipe-task rows include their latest output",
        currentValue: OUTPUT_PREVIEW_LABELS[config.outputPreview],
        values: Object.values(OUTPUT_PREVIEW_LABELS),
      }];
    },
    onChange: (id, value, ctx) => {
      const config = controller.getConfig();
      if (id === "collapsedTaskLimit") {
        const collapsedTaskLimit = value === "Summary only" ? 0 : Number(value);
        if (
          !Number.isInteger(collapsedTaskLimit)
          || collapsedTaskLimit < BACKGROUND_COLLAPSED_TASK_LIMIT_MIN
          || collapsedTaskLimit > BACKGROUND_COLLAPSED_TASK_LIMIT_MAX
        ) return;
        controller.updateConfig({ ...config, collapsedTaskLimit }, ctx);
      } else if (id === "outputPreview") {
        const outputPreview = outputPreviewForLabel(value);
        if (outputPreview) controller.updateConfig({ ...config, outputPreview }, ctx);
      }
    },
  });
}

export { OUTPUT_PREVIEW_LABELS };
