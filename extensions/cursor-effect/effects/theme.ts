import type { Theme } from "@earendil-works/pi-coding-agent";
import type { LoaderIndicatorOptions } from "@earendil-works/pi-tui";
import type { CursorEffectConfig } from "../config.ts";
import { createClaudeIndicator, createCodexIndicator, createLoaderIndicator } from "./loader.ts";
import type { ResolvedLabelEffect } from "./label.ts";

export interface ResolvedCursorTheme {
  indicator?: LoaderIndicatorOptions;
  label: ResolvedLabelEffect;
}

export function resolveCursorTheme(
  config: CursorEffectConfig,
  theme: Pick<Theme, "fg" | "bold">,
): ResolvedCursorTheme {
  if (config.theme === "default") return { indicator: undefined, label: { style: "none" } };
  if (config.theme === "claude-code") {
    return { indicator: createClaudeIndicator(), label: { style: "claude" } };
  }
  if (config.theme === "codex") {
    return { indicator: createCodexIndicator(theme), label: { style: "codex" } };
  }
  return {
    indicator: createLoaderIndicator(config.custom, theme),
    label: config.custom.label.style === "none"
      ? { style: "none" }
      : { ...config.custom.label, style: config.custom.label.style },
  };
}
