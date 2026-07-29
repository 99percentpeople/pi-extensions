import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CUSTOM_CURSOR_EFFECTS,
  type CustomCursorEffects,
  type EffectDirection,
  type EffectPause,
  type EffectSpeed,
  type LabelEffectStyle,
  type WaveCrestWidth,
  type WavePalette,
} from "../config.ts";
import {
  ansi256,
  CODEX_LABEL_INTERVAL_MS,
  CODEX_LABEL_SWEEP_MS,
  codexColor,
  codexIntensity,
} from "./loader.ts";

const SWEEP_PADDING = 2;
const CLAUDE_LABEL_INTERVAL_MS = 200;
const RAINBOW_COLORS = [203, 215, 227, 120, 87, 111, 177];

export const LABEL_SPEED_MS: Record<EffectSpeed, number> = {
  slow: 160,
  normal: 100,
  fast: 60,
};

const PAUSE_MS: Record<EffectPause, number> = {
  none: 0,
  short: 300,
  long: 700,
};

type AnimatedLabelStyle = Exclude<LabelEffectStyle, "none">;
type CustomAnimatedLabelEffect = Omit<CustomCursorEffects["label"], "style"> & {
  style: AnimatedLabelStyle;
};

export type ResolvedLabelEffect =
  | { style: "none" }
  | CustomAnimatedLabelEffect
  | { style: "claude" }
  | { style: "codex" };

let graphemeSegmenter: Intl.Segmenter | undefined;

export function splitLabelGraphemes(label: string): string[] {
  if (typeof Intl.Segmenter !== "function") return Array.from(label);
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(graphemeSegmenter.segment(label), ({ segment }) => segment);
}

function renderRuns(
  characters: string[],
  colorAt: (index: number) => ThemeColor | number,
  theme: Pick<Theme, "fg" | "bold">,
  bold = false,
): string {
  let output = "";
  let run = "";
  let runColor: ThemeColor | number | undefined;
  const flush = () => {
    if (!run || runColor === undefined) return;
    const text = bold ? theme.bold(run) : run;
    output += typeof runColor === "number" ? ansi256(runColor, text) : theme.fg(runColor, text);
    run = "";
  };
  characters.forEach((character, index) => {
    const color = colorAt(index);
    if (runColor !== color) {
      flush();
      runColor = color;
    }
    run += character;
  });
  flush();
  return output;
}

function paletteColors(
  palette: WavePalette,
): { crest: ThemeColor; band: ThemeColor; base: ThemeColor } {
  if (palette === "thinking") return { crest: "text", band: "thinkingText", base: "muted" };
  if (palette === "monochrome") return { crest: "text", band: "dim", base: "muted" };
  return { crest: "text", band: "accent", base: "muted" };
}

function crestWidth(width: WaveCrestWidth): number {
  return width === "narrow" ? 1 : width === "wide" ? 3 : 2;
}

function pauseFrames(pause: EffectPause, speed: EffectSpeed): number {
  return Math.ceil(PAUSE_MS[pause] / LABEL_SPEED_MS[speed]);
}

export function sweepPosition(
  frame: number,
  characterCount: number,
  direction: EffectDirection,
  pause: EffectPause,
  speed: EffectSpeed,
): number | undefined {
  if (characterCount <= 0) return undefined;
  const forwardLength = characterCount + SWEEP_PADDING * 2;
  const movementLength = direction === "ping-pong"
    ? Math.max(1, forwardLength * 2 - 2)
    : forwardLength;
  const rest = pauseFrames(pause, speed);
  const cycleLength = movementLength + rest;
  const phase = ((frame % cycleLength) + cycleLength) % cycleLength;
  if (phase >= movementLength) return undefined;

  let positionIndex = phase;
  if (direction === "right-to-left") positionIndex = forwardLength - 1 - phase;
  else if (direction === "ping-pong" && phase >= forwardLength) {
    positionIndex = movementLength - phase;
  }
  return positionIndex - SWEEP_PADDING;
}

type CustomLabelOptions = Omit<CustomCursorEffects["label"], "style">;

function normalizedOptions(options?: Partial<CustomLabelOptions>): CustomLabelOptions {
  return { ...DEFAULT_CUSTOM_CURSOR_EFFECTS.label, ...options };
}

export function renderWaveEffect(
  label: string,
  frame: number,
  theme: Pick<Theme, "fg" | "bold">,
  options?: Partial<CustomLabelOptions>,
): string {
  const characters = splitLabelGraphemes(label);
  if (characters.length === 0) return label;
  const config = normalizedOptions(options);
  const position = sweepPosition(frame, characters.length, config.direction, config.pause, config.speed);
  const width = crestWidth(config.crestWidth);
  const colors = paletteColors(config.palette);
  return renderRuns(characters, (index) => {
    if (position === undefined) return colors.base;
    const distance = Math.abs(index - position);
    if (distance < 0.75) return colors.crest;
    if (distance < width + 0.5) return colors.band;
    return colors.base;
  }, theme);
}

export function renderShimmerEffect(
  label: string,
  frame: number,
  theme: Pick<Theme, "fg" | "bold">,
  options?: Partial<CustomLabelOptions>,
): string {
  const characters = splitLabelGraphemes(label);
  if (characters.length === 0) return label;
  const config = normalizedOptions(options);
  const position = sweepPosition(frame, characters.length, config.direction, config.pause, config.speed);
  const radius = crestWidth(config.crestWidth) + 2;
  const colors = paletteColors(config.palette);
  return renderRuns(characters, (index) => {
    if (position === undefined) return colors.base;
    const distance = Math.abs(index - position);
    if (distance > radius) return colors.base;
    const intensity = 0.5 * (1 + Math.cos(Math.PI * distance / radius));
    if (intensity >= 0.72) return colors.crest;
    if (intensity >= 0.16) return colors.band;
    return colors.base;
  }, theme);
}

export function renderScanEffect(
  label: string,
  frame: number,
  theme: Pick<Theme, "fg" | "bold">,
  options?: Partial<CustomLabelOptions>,
): string {
  const characters = splitLabelGraphemes(label);
  if (characters.length === 0) return label;
  const config = normalizedOptions(options);
  const position = sweepPosition(frame, characters.length, config.direction, config.pause, config.speed);
  const width = crestWidth(config.crestWidth);
  const colors = paletteColors(config.palette);
  return renderRuns(characters, (index) => {
    if (position === undefined) return colors.base;
    const distance = Math.abs(index - position);
    if (distance < 0.5) return colors.crest;
    return distance < width ? colors.band : colors.base;
  }, theme);
}

export function renderPulseEffect(
  label: string,
  frame: number,
  theme: Pick<Theme, "fg" | "bold">,
  options?: Partial<CustomLabelOptions>,
): string {
  const characters = splitLabelGraphemes(label);
  if (characters.length === 0) return label;
  const config = normalizedOptions(options);
  const colors = paletteColors(config.palette);
  const rest = pauseFrames(config.pause, config.speed);
  const pulse = [colors.base, colors.band, colors.crest, colors.band] as ThemeColor[];
  const phase = frame % (pulse.length + rest);
  const color = phase < pulse.length ? pulse[phase]! : colors.base;
  return renderRuns(characters, () => color, theme);
}

export function renderRainbowEffect(
  label: string,
  frame: number,
  theme: Pick<Theme, "fg" | "bold">,
  options?: Partial<CustomLabelOptions>,
): string {
  const characters = splitLabelGraphemes(label);
  if (characters.length === 0) return label;
  const config = normalizedOptions(options);
  const position = sweepPosition(frame, characters.length, config.direction, config.pause, config.speed);
  if (position === undefined) return theme.fg("muted", label);
  return renderRuns(characters, (index) => {
    const colorIndex = ((index - position) % RAINBOW_COLORS.length + RAINBOW_COLORS.length)
      % RAINBOW_COLORS.length;
    return RAINBOW_COLORS[colorIndex]!;
  }, theme);
}

function renderClaudeLabel(
  label: string,
  frame: number,
  theme: Pick<Theme, "fg" | "bold">,
): string {
  const characters = splitLabelGraphemes(label);
  const glimmer = characters.length + 10 - frame % (characters.length + 20);
  return renderRuns(characters, (index) => Math.abs(index - glimmer) <= 1 ? 216 : 174, theme);
}

function renderCodexLabel(
  label: string,
  frame: number,
  theme: Pick<Theme, "fg" | "bold">,
): string {
  const characters = splitLabelGraphemes(label);
  const period = characters.length + 20;
  const position = Math.floor(
    ((frame * CODEX_LABEL_INTERVAL_MS) % CODEX_LABEL_SWEEP_MS) / CODEX_LABEL_SWEEP_MS * period,
  );
  return renderRuns(
    characters,
    (index) => codexColor(codexIntensity(position, index)),
    theme,
    true,
  );
}

export function labelFrameInterval(effect: ResolvedLabelEffect): number {
  if (
    effect.style === "wave"
    || effect.style === "shimmer"
    || effect.style === "scan"
    || effect.style === "pulse"
    || effect.style === "rainbow"
  ) return LABEL_SPEED_MS[effect.speed];
  if (effect.style === "claude") return CLAUDE_LABEL_INTERVAL_MS;
  if (effect.style === "codex") return CODEX_LABEL_INTERVAL_MS;
  return 100;
}

export function renderLabelEffect(
  label: string,
  frame: number,
  effect: ResolvedLabelEffect,
  theme: Pick<Theme, "fg" | "bold">,
): string {
  if (effect.style === "wave") return renderWaveEffect(label, frame, theme, effect);
  if (effect.style === "shimmer") return renderShimmerEffect(label, frame, theme, effect);
  if (effect.style === "scan") return renderScanEffect(label, frame, theme, effect);
  if (effect.style === "pulse") return renderPulseEffect(label, frame, theme, effect);
  if (effect.style === "rainbow") return renderRainbowEffect(label, frame, theme, effect);
  if (effect.style === "claude") return renderClaudeLabel(label, frame, theme);
  if (effect.style === "codex") return renderCodexLabel(label, frame, theme);
  return label;
}

export function cursorEffectFrame(startedAt: number, now: number, intervalMs = 100): number {
  return Math.floor(Math.max(0, now - startedAt) / Math.max(1, intervalMs));
}
