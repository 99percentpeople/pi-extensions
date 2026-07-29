import {
  getSharedSettingsPath,
  readSettingsNamespace,
  writeSettingsNamespace,
} from "@99percentpeople/pi-shared-settings";

export type CursorEffectTheme = "default" | "claude-code" | "codex" | "custom";
export type LoaderEffectStyle =
  | "pi-default"
  | "none"
  | "claude"
  | "pulse"
  | "dots"
  | "bounce"
  | "orbit";
export type LabelEffectStyle = "none" | "wave" | "shimmer" | "scan" | "pulse" | "rainbow";
export type EffectSpeed = "slow" | "normal" | "fast";
export type LoaderEffectColor = "accent" | "text" | "muted" | "claude";
export type WaveCrestWidth = "narrow" | "soft" | "wide";
export type WavePalette = "accent" | "thinking" | "monochrome";
export type EffectDirection = "left-to-right" | "right-to-left" | "ping-pong";
export type EffectPause = "none" | "short" | "long";

export interface CustomCursorEffects {
  loader: {
    style: LoaderEffectStyle;
    speed: EffectSpeed;
    color: LoaderEffectColor;
  };
  label: {
    style: LabelEffectStyle;
    speed: EffectSpeed;
    crestWidth: WaveCrestWidth;
    palette: WavePalette;
    direction: EffectDirection;
    pause: EffectPause;
  };
}

export interface CursorEffectConfig {
  theme: CursorEffectTheme;
  custom: CustomCursorEffects;
}

export const DEFAULT_CUSTOM_CURSOR_EFFECTS: CustomCursorEffects = {
  loader: {
    style: "pi-default",
    speed: "normal",
    color: "accent",
  },
  label: {
    style: "wave",
    speed: "normal",
    crestWidth: "soft",
    palette: "accent",
    direction: "left-to-right",
    pause: "none",
  },
};

export const DEFAULT_CURSOR_EFFECT_CONFIG: CursorEffectConfig = {
  theme: "default",
  custom: structuredClone(DEFAULT_CUSTOM_CURSOR_EFFECTS),
};

export const CURSOR_EFFECT_SETTINGS_NAMESPACE = "cursor-effect";

export function getCursorEffectConfigPath(): string {
  return getSharedSettingsPath();
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}

function normalizeCustomCursorEffects(value: unknown): CustomCursorEffects {
  const input = value && typeof value === "object"
    ? value as {
        style?: unknown;
        loader?: Record<string, unknown>;
        label?: Record<string, unknown>;
      }
    : {};
  const legacyLabelStyle = input.style === "none" || input.style === "wave" ? input.style : undefined;
  const loader = input.loader ?? {};
  const label = input.label ?? {};
  return {
    loader: {
      style: oneOf(
        loader.style,
        ["pi-default", "none", "claude", "pulse", "dots", "bounce", "orbit"],
        "pi-default",
      ),
      speed: oneOf(loader.speed, ["slow", "normal", "fast"], "normal"),
      color: oneOf(loader.color, ["accent", "text", "muted", "claude"], "accent"),
    },
    label: {
      style: oneOf(
        label.style ?? legacyLabelStyle,
        ["none", "wave", "shimmer", "scan", "pulse", "rainbow"],
        "wave",
      ),
      speed: oneOf(label.speed, ["slow", "normal", "fast"], "normal"),
      crestWidth: oneOf(label.crestWidth, ["narrow", "soft", "wide"], "soft"),
      palette: oneOf(label.palette, ["accent", "thinking", "monochrome"], "accent"),
      direction: oneOf(
        label.direction,
        ["left-to-right", "right-to-left", "ping-pong"],
        "left-to-right",
      ),
      pause: oneOf(label.pause, ["none", "short", "long"], "none"),
    },
  };
}

export function normalizeCursorEffectConfig(value: unknown): CursorEffectConfig {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_CURSOR_EFFECT_CONFIG);
  const input = value as {
    theme?: unknown;
    custom?: unknown;
    style?: unknown;
    loader?: unknown;
    label?: unknown;
  };
  const hasLegacyEffects = input.style !== undefined || input.loader !== undefined || input.label !== undefined;
  return {
    theme: oneOf(
      input.theme,
      ["default", "claude-code", "codex", "custom"],
      hasLegacyEffects ? "custom" : "default",
    ),
    custom: normalizeCustomCursorEffects(input.custom ?? input),
  };
}

export function loadCursorEffectConfig(path = getCursorEffectConfigPath()): CursorEffectConfig {
  return readSettingsNamespace(CURSOR_EFFECT_SETTINGS_NAMESPACE, normalizeCursorEffectConfig, path);
}

export function saveCursorEffectConfig(
  config: CursorEffectConfig,
  path = getCursorEffectConfigPath(),
): void {
  writeSettingsNamespace(
    CURSOR_EFFECT_SETTINGS_NAMESPACE,
    normalizeCursorEffectConfig(config),
    path,
  );
}
