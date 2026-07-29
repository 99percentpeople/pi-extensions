import {
  registerExtensionSettings,
  type ExtensionSettingsPanel,
} from "@99percentpeople/pi-shared-settings";
import { VERSION, type ExtensionAPI, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Loader, type LoaderIndicatorOptions } from "@earendil-works/pi-tui";
import {
  CURSOR_EFFECT_SETTINGS_NAMESPACE,
  DEFAULT_CURSOR_EFFECT_CONFIG,
  DEFAULT_CUSTOM_CURSOR_EFFECTS,
  loadCursorEffectConfig,
  saveCursorEffectConfig,
  type CursorEffectConfig,
  type CursorEffectTheme,
  type CustomCursorEffects,
  type EffectSpeed,
  type LabelEffectStyle,
  type LoaderEffectColor,
  type LoaderEffectStyle,
  type WaveCrestWidth,
  type WavePalette,
} from "./config.ts";

const PATCH_SYMBOL = Symbol.for("@99percentpeople/pi-cursor-effect/working-status-patch");
const WAVE_PADDING = 4;
const CLAUDE_BASE_COLOR = "\u001b[38;5;174m";
const CLAUDE_SHIMMER_COLOR = "\u001b[38;5;216m";
const CLAUDE_RENDER_INTERVAL_MS = 50;
const CLAUDE_GLYPH_INTERVAL_MS = 120;
const CODEX_RENDER_INTERVAL_MS = 32;
const CODEX_SWEEP_MS = 2000;

const PI_LOADER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const PI_LOADER_SPEED_MS: Record<EffectSpeed, number> = {
  slow: 140,
  normal: 80,
  fast: 50,
};
const LABEL_SPEED_MS: Record<EffectSpeed, number> = {
  slow: 160,
  normal: 100,
  fast: 60,
};

export const CURSOR_THEMES: Record<CursorEffectTheme, string> = {
  default: "Default",
  "claude-code": "Claude Code",
  codex: "Codex",
  custom: "Custom",
};

export const LOADER_EFFECTS: Record<LoaderEffectStyle, { label: string; frames: string[] }> = {
  "pi-default": { label: "Pi default", frames: PI_LOADER_FRAMES },
  none: { label: "None", frames: [] },
  claude: { label: "Claude Code", frames: [] },
};
export const LABEL_EFFECTS: Record<LabelEffectStyle, { label: string }> = {
  none: { label: "None" },
  wave: { label: "Wave" },
};

const SPEED_LABELS: Record<EffectSpeed, string> = { slow: "Slow", normal: "Normal", fast: "Fast" };
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

function keyForLabel<T extends string>(labels: Record<T, string>, label: string): T | undefined {
  return (Object.entries(labels) as Array<[T, string]>).find(([, value]) => value === label)?.[0];
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

function ansi256(code: number, value: string): string {
  return `\u001b[38;5;${code}m${value}\u001b[39m`;
}

function createClaudeIndicator(): LoaderIndicatorOptions {
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

function createCodexIndicator(theme: Pick<Theme, "fg" | "bold">): LoaderIndicatorOptions {
  const frameCount = Math.ceil(CODEX_SWEEP_MS / CODEX_RENDER_INTERVAL_MS);
  const period = 21; // one bullet + ten columns of padding on each side
  const frames = Array.from({ length: frameCount }, (_, frame) => {
    const position = Math.floor(((frame * CODEX_RENDER_INTERVAL_MS) % CODEX_SWEEP_MS) / CODEX_SWEEP_MS * period);
    const color = codexColor(codexIntensity(position, 0));
    const bullet = color === "text" ? theme.bold("•") : "•";
    return theme.fg(color, bullet);
  });
  return { frames, intervalMs: CODEX_RENDER_INTERVAL_MS };
}

function colorizeCustomLoaderFrame(
  frame: string,
  color: LoaderEffectColor,
  theme: Pick<Theme, "fg">,
): string {
  return color === "claude" ? ansi256(174, frame) : theme.fg(color, frame);
}

export function createLoaderIndicator(
  value: CursorEffectConfig | CustomCursorEffects,
  theme: Pick<Theme, "fg">,
): LoaderIndicatorOptions {
  const custom = "custom" in value ? value.custom : value;
  if (custom.loader.style === "claude") return createClaudeIndicator();
  if (custom.loader.style === "none") {
    return custom.label.style === "wave"
      ? { frames: ["", ""], intervalMs: LABEL_SPEED_MS[custom.label.speed] }
      : { frames: [] };
  }
  return {
    frames: PI_LOADER_FRAMES.map((frame) => colorizeCustomLoaderFrame(frame, custom.loader.color, theme)),
    intervalMs: PI_LOADER_SPEED_MS[custom.loader.speed],
  };
}

export type ResolvedLabelEffect =
  | { style: "none" }
  | ({ style: "wave" } & CustomCursorEffects["label"])
  | { style: "claude" }
  | { style: "codex" };

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
    label: config.custom.label.style === "wave"
      ? { ...config.custom.label, style: "wave" }
      : { style: "none" },
  };
}

function waveColors(palette: WavePalette): { crest: ThemeColor; band: ThemeColor; base: ThemeColor } {
  if (palette === "thinking") return { crest: "text", band: "thinkingText", base: "muted" };
  if (palette === "monochrome") return { crest: "text", band: "muted", base: "muted" };
  return { crest: "text", band: "accent", base: "muted" };
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

export function cursorEffectFrame(startedAt: number, now: number, intervalMs = 100): number {
  return Math.floor(Math.max(0, now - startedAt) / Math.max(1, intervalMs));
}

export function renderWaveEffect(
  label: string,
  frame: number,
  theme: Pick<Theme, "fg" | "bold">,
  options: Pick<CustomCursorEffects["label"], "crestWidth" | "palette"> =
    DEFAULT_CUSTOM_CURSOR_EFFECTS.label,
): string {
  const characters = Array.from(label);
  if (characters.length === 0) return label;
  const crest = frame % (characters.length + WAVE_PADDING * 2);
  const bandWidth = options.crestWidth === "narrow" ? 1 : options.crestWidth === "wide" ? 3 : 2;
  const colors = waveColors(options.palette);
  return renderRuns(characters, (index) => {
    const distance = Math.abs(index - crest);
    if (distance < 0.75) return colors.crest;
    if (distance < bandWidth) return colors.band;
    return colors.base;
  }, theme);
}

function renderClaudeLabel(label: string, frame: number, theme: Pick<Theme, "fg" | "bold">): string {
  const characters = Array.from(label);
  const glimmer = characters.length + 10 - frame % (characters.length + 20);
  return renderRuns(characters, (index) => Math.abs(index - glimmer) <= 1 ? 216 : 174, theme);
}

function renderCodexLabel(label: string, frame: number, theme: Pick<Theme, "fg" | "bold">): string {
  const characters = Array.from(label);
  const period = characters.length + 20;
  const position = Math.floor(((frame * CODEX_RENDER_INTERVAL_MS) % CODEX_SWEEP_MS) / CODEX_SWEEP_MS * period);
  return renderRuns(
    characters,
    (index) => codexColor(codexIntensity(position, index)),
    theme,
    true,
  );
}

function labelFrameInterval(effect: ResolvedLabelEffect): number {
  if (effect.style === "wave") return LABEL_SPEED_MS[effect.speed];
  if (effect.style === "claude") return 200;
  if (effect.style === "codex") return CODEX_RENDER_INTERVAL_MS;
  return 100;
}

function renderLabelEffect(
  label: string,
  frame: number,
  effect: ResolvedLabelEffect,
  theme: Pick<Theme, "fg" | "bold">,
): string {
  if (effect.style === "wave") return renderWaveEffect(label, frame, theme, effect);
  if (effect.style === "claude") return renderClaudeLabel(label, frame, theme);
  if (effect.style === "codex") return renderCodexLabel(label, frame, theme);
  return label;
}

type RuntimeLoader = {
  kind?: string;
  message: string;
  messageColorFn: (text: string) => string;
  updateDisplay(): void;
  setIndicator(options?: LoaderIndicatorOptions): void;
  render(width: number): string[];
};
const MAIN_STATUS_KINDS = new Set(["working", "retry", "compaction", "branchSummary"]);
function isMainStatus(loader: RuntimeLoader): boolean {
  return typeof loader.kind === "string" && MAIN_STATUS_KINDS.has(loader.kind);
}
interface PatchState {
  references: number;
  originalUpdateDescriptor: PropertyDescriptor | undefined;
  originalRenderDescriptor: PropertyDescriptor | undefined;
  theme?: Pick<Theme, "fg" | "bold">;
  indicator?: LoaderIndicatorOptions;
  labelEffect: ResolvedLabelEffect;
  revision: number;
  originalUpdate: (this: RuntimeLoader) => void;
  patchedUpdate: (this: RuntimeLoader) => void;
  originalRender: (this: RuntimeLoader, width: number) => string[];
  patchedRender: (this: RuntimeLoader, width: number) => string[];
}
interface LabelState { label: string; revision: number; startedAt: number }
export interface CursorEffectPatchHandle {
  setTheme(theme: Pick<Theme, "fg" | "bold">): void;
  setResolvedTheme(resolved: ResolvedCursorTheme): void;
  setLabelEffect(effect: ResolvedLabelEffect): void;
  setLabelConfig(config: CustomCursorEffects["label"]): void;
  dispose(): void;
}
const loaderPrototype = Loader.prototype as unknown as RuntimeLoader & { [PATCH_SYMBOL]?: PatchState };

function releasePatch(state: PatchState): void {
  state.references -= 1;
  if (state.references > 0) return;
  if (loaderPrototype.updateDisplay === state.patchedUpdate) {
    if (state.originalUpdateDescriptor) Object.defineProperty(loaderPrototype, "updateDisplay", state.originalUpdateDescriptor);
    else delete (loaderPrototype as unknown as Record<PropertyKey, unknown>).updateDisplay;
  }
  if (loaderPrototype.render === state.patchedRender) {
    if (state.originalRenderDescriptor) Object.defineProperty(loaderPrototype, "render", state.originalRenderDescriptor);
    else delete (loaderPrototype as unknown as Record<PropertyKey, unknown>).render;
  }
  delete (loaderPrototype as unknown as Record<PropertyKey, unknown>)[PATCH_SYMBOL];
}

export function installCursorEffectPatch(
  initial: ResolvedLabelEffect | CustomCursorEffects["label"] = { style: "none" },
): CursorEffectPatchHandle {
  const initialEffect: ResolvedLabelEffect = initial.style === "wave"
    ? { ...initial as CustomCursorEffects["label"], style: "wave" }
    : initial.style === "none" ? { style: "none" } : initial as ResolvedLabelEffect;
  const existing = loaderPrototype[PATCH_SYMBOL];
  if (existing) {
    existing.references += 1;
    existing.labelEffect = structuredClone(initialEffect);
    existing.revision += 1;
    let disposed = false;
    return {
      setTheme: (theme) => { existing.theme = theme; },
      setResolvedTheme: (resolved) => {
        existing.indicator = structuredClone(resolved.indicator);
        existing.labelEffect = structuredClone(resolved.label);
        existing.revision += 1;
      },
      setLabelEffect: (effect) => { existing.labelEffect = structuredClone(effect); existing.revision += 1; },
      setLabelConfig: (config) => { existing.labelEffect = config.style === "wave" ? { ...config } : { style: "none" }; existing.revision += 1; },
      dispose: () => { if (!disposed) { disposed = true; releasePatch(existing); } },
    };
  }
  const originalUpdateDescriptor = Object.getOwnPropertyDescriptor(loaderPrototype, "updateDisplay");
  const originalRenderDescriptor = Object.getOwnPropertyDescriptor(loaderPrototype, "render");
  const originalUpdate = loaderPrototype.updateDisplay;
  const originalRender = loaderPrototype.render;
  if (typeof originalUpdate !== "function" || typeof originalRender !== "function") {
    throw new Error("Loader rendering methods are unavailable");
  }
  const states = new WeakMap<object, LabelState>();
  const appliedIndicatorRevisions = new WeakMap<object, number>();
  let patchState: PatchState;
  const patchedUpdate = function (this: RuntimeLoader): void {
    const effect = patchState.labelEffect;
    if (!isMainStatus(this) || !patchState.theme || effect.style === "none") {
      originalUpdate.call(this);
      return;
    }
    const now = Date.now();
    let state = states.get(this);
    if (!state || state.label !== this.message || state.revision !== patchState.revision) {
      state = { label: this.message, revision: patchState.revision, startedAt: now };
      states.set(this, state);
    }
    const originalColor = this.messageColorFn;
    this.messageColorFn = this.message.includes("\u001b")
      ? originalColor
      : (text) => renderLabelEffect(
          text,
          cursorEffectFrame(state!.startedAt, now, labelFrameInterval(effect)),
          effect,
          patchState.theme!,
        );
    try { originalUpdate.call(this); } finally { this.messageColorFn = originalColor; }
  };
  const patchedRender = function (this: RuntimeLoader, width: number): string[] {
    if (isMainStatus(this) && appliedIndicatorRevisions.get(this) !== patchState.revision) {
      // StatusIndicator assigns `kind` only after Loader's constructor has run.
      // Applying on its first render avoids one native frame and also updates an
      // already-visible compaction/retry indicator when the selected theme changes.
      appliedIndicatorRevisions.set(this, patchState.revision);
      this.setIndicator(structuredClone(patchState.indicator));
    }
    return originalRender.call(this, width);
  };
  patchState = {
    references: 1,
    originalUpdateDescriptor,
    originalRenderDescriptor,
    labelEffect: structuredClone(initialEffect),
    revision: 0,
    originalUpdate,
    patchedUpdate,
    originalRender,
    patchedRender,
  };
  Object.defineProperty(loaderPrototype, "updateDisplay", { configurable: true, writable: true, value: patchedUpdate });
  Object.defineProperty(loaderPrototype, "render", { configurable: true, writable: true, value: patchedRender });
  Object.defineProperty(loaderPrototype, PATCH_SYMBOL, { configurable: true, value: patchState });
  let disposed = false;
  return {
    setTheme: (theme) => { patchState.theme = theme; },
    setResolvedTheme: (resolved) => {
      patchState.indicator = structuredClone(resolved.indicator);
      patchState.labelEffect = structuredClone(resolved.label);
      patchState.revision += 1;
    },
    setLabelEffect: (effect) => { patchState.labelEffect = structuredClone(effect); patchState.revision += 1; },
    setLabelConfig: (config) => { patchState.labelEffect = config.style === "wave" ? { ...config } : { style: "none" }; patchState.revision += 1; },
    dispose: () => { if (!disposed) { disposed = true; releasePatch(patchState); } },
  };
}

export default function (pi: ExtensionAPI) {
  let config = loadCursorEffectConfig();
  let patch: CursorEffectPatchHandle | undefined;
  let activeContext: { theme: Pick<Theme, "fg" | "bold">; setIndicator(options?: LoaderIndicatorOptions): void } | undefined;
  let patchError: string | undefined;

  const applyRuntime = () => {
    if (!activeContext) return;
    const resolved = resolveCursorTheme(config, activeContext.theme);
    patch?.setTheme(activeContext.theme);
    patch?.setResolvedTheme(resolved);
    activeContext.setIndicator(resolved.indicator);
  };
  const saveAndApply = (next: CursorEffectConfig, notify: (message: string) => void) => {
    config = next;
    applyRuntime();
    try { saveCursorEffectConfig(config); }
    catch (error) { notify(`Failed to save cursor-effect settings: ${error instanceof Error ? error.message : String(error)}`); }
  };
  try { patch = installCursorEffectPatch(); }
  catch (error) { patchError = error instanceof Error ? error.message : String(error); }

  const loaderLabels = Object.fromEntries(
    Object.entries(LOADER_EFFECTS).map(([key, effect]) => [key, effect.label]),
  ) as Record<LoaderEffectStyle, string>;
  const labelLabels = Object.fromEntries(
    Object.entries(LABEL_EFFECTS).map(([key, effect]) => [key, effect.label]),
  ) as Record<LabelEffectStyle, string>;

  const loaderPanel: ExtensionSettingsPanel = {
    title: "Loader Effect",
    currentValue: () => loaderLabels[config.custom.loader.style],
    settings: () => [
      { id: "style", label: "Style", description: "Symbol animation before the label", currentValue: loaderLabels[config.custom.loader.style], values: Object.values(loaderLabels) },
      ...(config.custom.loader.style === "none" ? [] : [
        { id: "speed", label: "Speed", description: "Loader frame interval", currentValue: SPEED_LABELS[config.custom.loader.speed], values: Object.values(SPEED_LABELS) },
        { id: "color", label: "Color", description: "Loader frame color", currentValue: COLOR_LABELS[config.custom.loader.color], values: Object.values(COLOR_LABELS) },
      ]),
    ],
    onChange: (id, value, ctx) => {
      const loader = { ...config.custom.loader };
      if (id === "style") loader.style = keyForLabel(loaderLabels, value) ?? loader.style;
      else if (id === "speed") loader.speed = keyForLabel(SPEED_LABELS, value) ?? loader.speed;
      else if (id === "color") loader.color = keyForLabel(COLOR_LABELS, value) ?? loader.color;
      saveAndApply({ ...config, custom: { ...config.custom, loader } }, (message) => ctx.ui.notify(message, "error"));
    },
  };
  const labelPanel: ExtensionSettingsPanel = {
    title: "Label Effect",
    currentValue: () => labelLabels[config.custom.label.style],
    settings: () => [
      { id: "style", label: "Style", description: "Visual effect applied to the label", currentValue: labelLabels[config.custom.label.style], values: Object.values(labelLabels) },
      ...(config.custom.label.style === "wave" ? [
        { id: "speed", label: "Speed", description: "Time between wave positions", currentValue: SPEED_LABELS[config.custom.label.speed], values: Object.values(SPEED_LABELS) },
        { id: "crestWidth", label: "Crest width", description: "Highlighted wave width", currentValue: CREST_WIDTH_LABELS[config.custom.label.crestWidth], values: Object.values(CREST_WIDTH_LABELS) },
        { id: "palette", label: "Palette", description: "Theme colors used by the wave", currentValue: PALETTE_LABELS[config.custom.label.palette], values: Object.values(PALETTE_LABELS) },
      ] : []),
    ],
    onChange: (id, value, ctx) => {
      const label = { ...config.custom.label };
      if (id === "style") label.style = keyForLabel(labelLabels, value) ?? label.style;
      else if (id === "speed") label.speed = keyForLabel(SPEED_LABELS, value) ?? label.speed;
      else if (id === "crestWidth") label.crestWidth = keyForLabel(CREST_WIDTH_LABELS, value) ?? label.crestWidth;
      else if (id === "palette") label.palette = keyForLabel(PALETTE_LABELS, value) ?? label.palette;
      saveAndApply({ ...config, custom: { ...config.custom, label } }, (message) => ctx.ui.notify(message, "error"));
    },
  };

  registerExtensionSettings(pi, {
    namespace: CURSOR_EFFECT_SETTINGS_NAMESPACE,
    title: "Cursor Effect",
    settings: () => [
      {
        id: "theme",
        label: "Theme",
        description: "Apply a complete cursor theme",
        currentValue: CURSOR_THEMES[config.theme],
        values: Object.values(CURSOR_THEMES),
      },
      ...(config.theme === "custom" ? [
        { id: "loader", label: "Loader effect", description: "Configure the custom loader", currentValue: loaderLabels[config.custom.loader.style], submenu: loaderPanel },
        { id: "label", label: "Label effect", description: "Configure the custom label", currentValue: labelLabels[config.custom.label.style], submenu: labelPanel },
      ] : []),
    ],
    onChange: (id, value, ctx) => {
      if (id !== "theme") return;
      const theme = keyForLabel(CURSOR_THEMES, value);
      if (theme) saveAndApply({ ...config, theme }, (message) => ctx.ui.notify(message, "error"));
    },
  });

  pi.on("session_start", (_event, ctx) => {
    activeContext = {
      theme: ctx.ui.theme,
      setIndicator: (options) => ctx.ui.setWorkingIndicator(options),
    };
    applyRuntime();
    if (patchError && ctx.hasUI) ctx.ui.notify(`cursor-effect label effects disabled on Pi ${VERSION}: ${patchError}`, "warning");
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
  type EffectSpeed,
  type LabelEffectStyle,
  type LoaderEffectColor,
  type LoaderEffectStyle,
  type WaveCrestWidth,
  type WavePalette,
} from "./config.ts";
