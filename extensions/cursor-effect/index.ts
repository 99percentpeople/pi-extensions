import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { LoaderIndicatorOptions } from "@earendil-works/pi-tui";
import {
  loadCursorEffectConfig,
  saveCursorEffectConfig,
  type CursorEffectConfig,
} from "./config.ts";
import { resolveCursorTheme } from "./effects/theme.ts";
import {
  installCursorEffectPatch,
  type CursorEffectPatchHandle,
} from "./runtime-patch.ts";
import { registerCursorEffectSettings } from "./settings.ts";

export default function (pi: ExtensionAPI) {
  let config = loadCursorEffectConfig();
  let patch: CursorEffectPatchHandle | undefined;
  let activeContext: {
    theme: Pick<Theme, "fg" | "bold">;
    setIndicator(options?: LoaderIndicatorOptions): void;
  } | undefined;
  let patchError: string | undefined;

  const applyRuntime = () => {
    if (!activeContext) return;
    const resolved = resolveCursorTheme(config, activeContext.theme);
    patch?.setTheme(activeContext.theme);
    patch?.setResolvedTheme(resolved);
    activeContext.setIndicator(resolved.indicator);
  };

  const saveAndApply = (
    next: CursorEffectConfig,
    notify: (message: string) => void,
  ) => {
    config = next;
    applyRuntime();
    try {
      saveCursorEffectConfig(config);
    } catch (error) {
      notify(`Failed to save cursor-effect settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  try {
    patch = installCursorEffectPatch();
  } catch (error) {
    patchError = error instanceof Error ? error.message : String(error);
  }

  registerCursorEffectSettings(pi, {
    getConfig: () => config,
    updateConfig: (next, ctx) => {
      saveAndApply(next, (message) => ctx.ui.notify(message, "error"));
    },
  });

  pi.on("session_start", (_event, ctx) => {
    activeContext = {
      theme: ctx.ui.theme,
      setIndicator: (options) => ctx.ui.setWorkingIndicator(options),
    };
    applyRuntime();
    if (patchError && ctx.hasUI) {
      ctx.ui.notify(`cursor-effect label effects disabled: ${patchError}`, "warning");
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWorkingIndicator();
    activeContext = undefined;
    patch?.dispose();
    patch = undefined;
  });
}

export {
  CURSOR_EFFECT_SETTINGS_NAMESPACE,
  DEFAULT_CURSOR_EFFECT_CONFIG,
  DEFAULT_CUSTOM_CURSOR_EFFECTS,
  getCursorEffectConfigPath,
  loadCursorEffectConfig,
  normalizeCursorEffectConfig,
  saveCursorEffectConfig,
  type CursorEffectConfig,
  type CursorEffectTheme,
  type CustomCursorEffects,
  type EffectDirection,
  type EffectPause,
  type EffectSpeed,
  type LabelEffectStyle,
  type LoaderEffectColor,
  type LoaderEffectStyle,
  type WaveCrestWidth,
  type WavePalette,
} from "./config.ts";
export {
  createClaudeIndicator,
  createClaudeLoaderFrames,
  createCodexIndicator,
  createLoaderIndicator,
  LOADER_FRAMES,
  LOADER_SPEED_MS,
  PI_LOADER_FRAMES,
} from "./effects/loader.ts";
export {
  cursorEffectFrame,
  LABEL_SPEED_MS,
  labelFrameInterval,
  renderLabelEffect,
  renderPulseEffect,
  renderRainbowEffect,
  renderScanEffect,
  renderShimmerEffect,
  renderWaveEffect,
  splitLabelGraphemes,
  sweepPosition,
  type ResolvedLabelEffect,
} from "./effects/label.ts";
export {
  resolveCursorTheme,
  type ResolvedCursorTheme,
} from "./effects/theme.ts";
export {
  installCursorEffectPatch,
  type CursorEffectPatchHandle,
} from "./runtime-patch.ts";
export {
  CURSOR_THEMES,
  LABEL_EFFECTS,
  LOADER_EFFECTS,
  registerCursorEffectSettings,
} from "./settings.ts";
