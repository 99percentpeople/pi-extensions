import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { LoaderIndicatorOptions } from "@earendil-works/pi-tui";
import type {
  CursorEffectConfig,
  CustomCursorEffects,
  EffectSpeed,
  LoaderEffectColor,
  LoaderEffectStyle,
} from "../config.ts";

const CLAUDE_RENDER_INTERVAL_MS = 50;
const CLAUDE_GLYPH_INTERVAL_MS = 120;
const CODEX_RENDER_INTERVAL_MS = 32;
const CODEX_SWEEP_MS = 2000;

export const PI_LOADER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const LOADER_FRAMES: Record<Exclude<LoaderEffectStyle, "none" | "claude">, string[]> = {
  "pi-default": PI_LOADER_FRAMES,
  pulse: ["·", "•", "●", "•"],
  dots: ["···", "•··", "••·", "•••", "·••", "··•"],
  bounce: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"],
  orbit: ["◐", "◓", "◑", "◒"],
};

export const LOADER_SPEED_MS: Record<EffectSpeed, number> = {
  slow: 140,
  normal: 80,
  fast: 50,
};

function ansi256(code: number, value: string): string {
  return `\u001b[38;5;${code}m${value}\u001b[39m`;
}

export function createClaudeLoaderFrames(
  platform = process.platform,
  terminal = process.env.TERM,
): string[] {
  const base = terminal === "xterm-ghostty"
    ? ["·", "✢", "✳", "✶", "✻", "*"]
    : platform === "darwin"
      ? ["·", "✢", "✳", "✶", "✻", "✽"]
      : ["·", "✢", "*", "✶", "✻", "✽"];
  return [...base, ...[...base].reverse()];
}

export function createClaudeIndicator(): LoaderIndicatorOptions {
  const glyphs = createClaudeLoaderFrames();
  const glyphCycleMs = glyphs.length * CLAUDE_GLYPH_INTERVAL_MS;
  const timelineMs = 7200; // lcm(1440ms glyph cycle, 50ms render tick)
  const frames = Array.from({ length: timelineMs / CLAUDE_RENDER_INTERVAL_MS }, (_, index) => {
    const elapsed = (index * CLAUDE_RENDER_INTERVAL_MS) % glyphCycleMs;
    return ansi256(174, glyphs[Math.floor(elapsed / CLAUDE_GLYPH_INTERVAL_MS)]!);
  });
  return { frames, intervalMs: CLAUDE_RENDER_INTERVAL_MS };
}

function codexIntensity(position: number, characterIndex: number): number {
  const distance = Math.abs(characterIndex + 10 - position);
  if (distance > 5) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * (distance / 5)));
}

function codexColor(intensity: number): ThemeColor {
  if (intensity < 0.2) return "dim";
  if (intensity < 0.6) return "muted";
  return "text";
}

export function createCodexIndicator(
  theme: Pick<Theme, "fg" | "bold">,
): LoaderIndicatorOptions {
  const frameCount = Math.ceil(CODEX_SWEEP_MS / CODEX_RENDER_INTERVAL_MS);
  const period = 21; // one bullet + ten columns of padding on each side
  const frames = Array.from({ length: frameCount }, (_, frame) => {
    const position = Math.floor(
      ((frame * CODEX_RENDER_INTERVAL_MS) % CODEX_SWEEP_MS) / CODEX_SWEEP_MS * period,
    );
    const color = codexColor(codexIntensity(position, 0));
    const bullet = color === "text" ? theme.bold("•") : "•";
    return theme.fg(color, bullet);
  });
  return { frames, intervalMs: CODEX_RENDER_INTERVAL_MS };
}

function colorizeFrame(
  frame: string,
  color: LoaderEffectColor,
  theme: Pick<Theme, "fg">,
): string {
  return color === "claude" ? ansi256(174, frame) : theme.fg(color, frame);
}

function customLoaderFrames(style: LoaderEffectStyle): string[] {
  if (style === "none") return [];
  if (style === "claude") return createClaudeLoaderFrames();
  return LOADER_FRAMES[style];
}

/** Create a Custom-theme indicator. Every visible style honors speed and color. */
export function createLoaderIndicator(
  value: CursorEffectConfig | CustomCursorEffects,
  theme: Pick<Theme, "fg">,
): LoaderIndicatorOptions {
  const custom = "custom" in value ? value.custom : value;
  if (custom.loader.style === "none") return { frames: [] };
  return {
    frames: customLoaderFrames(custom.loader.style).map((frame) =>
      colorizeFrame(frame, custom.loader.color, theme)
    ),
    intervalMs: LOADER_SPEED_MS[custom.loader.speed],
  };
}

export const CODEX_LABEL_INTERVAL_MS = CODEX_RENDER_INTERVAL_MS;
export const CODEX_LABEL_SWEEP_MS = CODEX_SWEEP_MS;
export { ansi256, codexColor, codexIntensity };
