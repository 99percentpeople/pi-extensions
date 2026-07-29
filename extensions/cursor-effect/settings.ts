import {
  registerExtensionSettings,
  type ExtensionSettingsPanel,
} from "@99percentpeople/pi-shared-settings";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_EFFECT_SETTINGS_NAMESPACE,
  type CursorEffectConfig,
  type CursorEffectTheme,
  type EffectDirection,
  type EffectPause,
  type EffectSpeed,
  type LabelEffectStyle,
  type LoaderEffectColor,
  type LoaderEffectStyle,
  type WaveCrestWidth,
  type WavePalette,
} from "./config.ts";

export const CURSOR_THEMES: Record<CursorEffectTheme, string> = {
  default: "Default",
  "claude-code": "Claude Code",
  codex: "Codex",
  custom: "Custom",
};

export const LOADER_EFFECTS: Record<LoaderEffectStyle, { label: string }> = {
  "pi-default": { label: "Pi default" },
  none: { label: "None" },
  claude: { label: "Claude Code" },
  pulse: { label: "Pulse" },
  dots: { label: "Dots" },
  bounce: { label: "Bounce" },
  orbit: { label: "Orbit" },
};

export const LABEL_EFFECTS: Record<LabelEffectStyle, { label: string }> = {
  none: { label: "None" },
  wave: { label: "Wave" },
  shimmer: { label: "Shimmer" },
  scan: { label: "Scan" },
  pulse: { label: "Pulse" },
  rainbow: { label: "Rainbow" },
};

const SPEED_LABELS: Record<EffectSpeed, string> = {
  slow: "Slow",
  normal: "Normal",
  fast: "Fast",
};
const COLOR_LABELS: Record<LoaderEffectColor, string> = {
  accent: "Accent",
  text: "Text",
  muted: "Muted",
  claude: "Claude",
};
const CREST_WIDTH_LABELS: Record<WaveCrestWidth, string> = {
  narrow: "Narrow",
  soft: "Soft",
  wide: "Wide",
};
const PALETTE_LABELS: Record<WavePalette, string> = {
  accent: "Accent",
  thinking: "Thinking",
  monochrome: "Monochrome",
};
const DIRECTION_LABELS: Record<EffectDirection, string> = {
  "left-to-right": "Left to right",
  "right-to-left": "Right to left",
  "ping-pong": "Ping-pong",
};
const PAUSE_LABELS: Record<EffectPause, string> = {
  none: "No pause",
  short: "Short",
  long: "Long",
};

function keyForLabel<T extends string>(labels: Record<T, string>, label: string): T | undefined {
  return (Object.entries(labels) as Array<[T, string]>).find(([, value]) => value === label)?.[0];
}

function effectLabels<T extends string>(effects: Record<T, { label: string }>): Record<T, string> {
  return Object.fromEntries(
    Object.entries(effects).map(([key, effect]) => [key, (effect as { label: string }).label]),
  ) as Record<T, string>;
}

interface CursorEffectSettingsController {
  getConfig(): CursorEffectConfig;
  updateConfig(config: CursorEffectConfig, ctx: ExtensionContext): void;
}

export function registerCursorEffectSettings(
  pi: ExtensionAPI,
  controller: CursorEffectSettingsController,
): void {
  const loaderLabels = effectLabels(LOADER_EFFECTS);
  const labelLabels = effectLabels(LABEL_EFFECTS);

  const loaderPanel: ExtensionSettingsPanel = {
    title: "Loader Effect",
    currentValue: () => loaderLabels[controller.getConfig().custom.loader.style],
    settings: () => {
      const config = controller.getConfig();
      const loader = config.custom.loader;
      return [
        {
          id: "style",
          label: "Style",
          description: "Fixed-width symbol animation before the label",
          currentValue: loaderLabels[loader.style],
          values: Object.values(loaderLabels),
        },
        ...(loader.style === "none" ? [] : [
          {
            id: "speed",
            label: "Speed",
            description: "Loader frame interval",
            currentValue: SPEED_LABELS[loader.speed],
            values: Object.values(SPEED_LABELS),
          },
          {
            id: "color",
            label: "Color",
            description: "Loader frame color",
            currentValue: COLOR_LABELS[loader.color],
            values: Object.values(COLOR_LABELS),
          },
        ]),
      ];
    },
    onChange: (id, value, ctx) => {
      const config = controller.getConfig();
      const loader = { ...config.custom.loader };
      if (id === "style") loader.style = keyForLabel(loaderLabels, value) ?? loader.style;
      else if (id === "speed") loader.speed = keyForLabel(SPEED_LABELS, value) ?? loader.speed;
      else if (id === "color") loader.color = keyForLabel(COLOR_LABELS, value) ?? loader.color;
      controller.updateConfig({ ...config, custom: { ...config.custom, loader } }, ctx);
    },
  };

  const labelPanel: ExtensionSettingsPanel = {
    title: "Label Effect",
    currentValue: () => labelLabels[controller.getConfig().custom.label.style],
    settings: () => {
      const config = controller.getConfig();
      const label = config.custom.label;
      const hasSweep = label.style === "wave"
        || label.style === "shimmer"
        || label.style === "scan"
        || label.style === "rainbow";
      const hasWidth = label.style === "wave" || label.style === "shimmer" || label.style === "scan";
      return [
        {
          id: "style",
          label: "Style",
          description: "Visual effect applied to the status label",
          currentValue: labelLabels[label.style],
          values: Object.values(labelLabels),
        },
        ...(label.style === "none" ? [] : [
          {
            id: "speed",
            label: "Speed",
            description: "Time between label animation frames",
            currentValue: SPEED_LABELS[label.speed],
            values: Object.values(SPEED_LABELS),
          },
          ...(hasWidth ? [{
            id: "crestWidth",
            label: "Crest width",
            description: "Width of the highlighted band",
            currentValue: CREST_WIDTH_LABELS[label.crestWidth],
            values: Object.values(CREST_WIDTH_LABELS),
          }] : []),
          ...(label.style === "rainbow" ? [] : [{
            id: "palette",
            label: "Palette",
            description: "Theme colors used by the label effect",
            currentValue: PALETTE_LABELS[label.palette],
            values: Object.values(PALETTE_LABELS),
          }]),
          ...(hasSweep ? [{
            id: "direction",
            label: "Direction",
            description: "Direction of the moving effect",
            currentValue: DIRECTION_LABELS[label.direction],
            values: Object.values(DIRECTION_LABELS),
          }] : []),
          {
            id: "pause",
            label: "Loop pause",
            description: "Rest time between animation cycles",
            currentValue: PAUSE_LABELS[label.pause],
            values: Object.values(PAUSE_LABELS),
          },
        ]),
      ];
    },
    onChange: (id, value, ctx) => {
      const config = controller.getConfig();
      const label = { ...config.custom.label };
      if (id === "style") label.style = keyForLabel(labelLabels, value) ?? label.style;
      else if (id === "speed") label.speed = keyForLabel(SPEED_LABELS, value) ?? label.speed;
      else if (id === "crestWidth") {
        label.crestWidth = keyForLabel(CREST_WIDTH_LABELS, value) ?? label.crestWidth;
      } else if (id === "palette") {
        label.palette = keyForLabel(PALETTE_LABELS, value) ?? label.palette;
      } else if (id === "direction") {
        label.direction = keyForLabel(DIRECTION_LABELS, value) ?? label.direction;
      } else if (id === "pause") label.pause = keyForLabel(PAUSE_LABELS, value) ?? label.pause;
      controller.updateConfig({ ...config, custom: { ...config.custom, label } }, ctx);
    },
  };

  registerExtensionSettings(pi, {
    namespace: CURSOR_EFFECT_SETTINGS_NAMESPACE,
    title: "Cursor Effect",
    settings: () => {
      const config = controller.getConfig();
      return [
        {
          id: "theme",
          label: "Theme",
          description: "Apply a complete cursor theme",
          currentValue: CURSOR_THEMES[config.theme],
          values: Object.values(CURSOR_THEMES),
        },
        ...(config.theme === "custom" ? [
          {
            id: "loader",
            label: "Loader effect",
            description: "Configure the custom loader",
            currentValue: loaderLabels[config.custom.loader.style],
            submenu: loaderPanel,
          },
          {
            id: "label",
            label: "Label effect",
            description: "Configure the custom label",
            currentValue: labelLabels[config.custom.label.style],
            submenu: labelPanel,
          },
        ] : []),
      ];
    },
    onChange: (id, value, ctx) => {
      if (id !== "theme") return;
      const config = controller.getConfig();
      const theme = keyForLabel(CURSOR_THEMES, value);
      if (theme) controller.updateConfig({ ...config, theme }, ctx);
    },
  });
}
