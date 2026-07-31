import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Loader, type TUI } from "@earendil-works/pi-tui";
import {
  createClaudeLoaderFrames,
  createLoaderIndicator,
  cursorEffectFrame,
  DEFAULT_CURSOR_EFFECT_CONFIG,
  DEFAULT_CUSTOM_CURSOR_EFFECTS,
  installCursorEffectPatch,
  LABEL_EFFECTS,
  loadCursorEffectConfig,
  LOADER_EFFECTS,
  normalizeCursorEffectConfig,
  renderPulseEffect,
  renderRainbowEffect,
  renderScanEffect,
  renderShimmerEffect,
  renderWaveEffect,
  resolveCursorTheme,
  saveCursorEffectConfig,
  splitLabelGraphemes,
  sweepPosition,
} from "../extensions/cursor-effect/index.ts";

const colorCodes: Record<ThemeColor, number> = {
  accent: 96,
  border: 37,
  borderAccent: 96,
  borderMuted: 90,
  success: 32,
  error: 31,
  warning: 33,
  muted: 90,
  dim: 2,
  text: 97,
  thinkingText: 37,
  userMessageText: 37,
  customMessageText: 37,
  customMessageLabel: 37,
  toolTitle: 37,
  toolOutput: 37,
  mdHeading: 37,
  mdLink: 37,
  mdLinkUrl: 37,
  mdCode: 37,
  mdCodeBlock: 37,
  mdCodeBlockBorder: 37,
  mdQuote: 37,
  mdQuoteBorder: 37,
  mdHr: 37,
  mdListBullet: 37,
  toolDiffAdded: 32,
  toolDiffRemoved: 31,
  toolDiffContext: 37,
  syntaxComment: 37,
  syntaxKeyword: 37,
  syntaxFunction: 37,
  syntaxVariable: 37,
  syntaxString: 37,
  syntaxNumber: 37,
  syntaxType: 37,
  syntaxOperator: 37,
  syntaxPunctuation: 37,
  thinkingOff: 37,
  thinkingMinimal: 37,
  thinkingLow: 37,
  thinkingMedium: 37,
  thinkingHigh: 37,
  thinkingXhigh: 37,
  thinkingMax: 37,
  bashMode: 37,
};

const theme = {
  fg(color: ThemeColor, text: string) {
    return `\u001b[${colorCodes[color]}m${text}\u001b[39m`;
  },
  bold(text: string) {
    return `\u001b[1m${text}\u001b[22m`;
  },
} satisfies Pick<Theme, "fg" | "bold">;

const ui = { requestRender() {} } as unknown as TUI;
const muted = (text: string) => theme.fg("muted", text);

class StatusLoader extends Loader {
  readonly kind: "working" | "retry" | "compaction" | "branchSummary";

  constructor(kind: StatusLoader["kind"], message: string) {
    super(ui, (text) => text, muted, message, { frames: [] });
    this.kind = kind;
    // Loader invokes updateDisplay() from super() before the subclass field is
    // initialized, so trigger one status update after kind is present.
    this.setMessage(message);
  }
}

class WorkingLoader extends StatusLoader {
  constructor(message: string) {
    super("working", message);
  }
}

function rendered(loader: Loader): string {
  return loader.render(120).join("\n");
}

function customLabel(
  style: "wave" | "shimmer" | "scan" | "pulse" | "rainbow",
  overrides: Partial<typeof DEFAULT_CUSTOM_CURSOR_EFFECTS.label> = {},
) {
  return { ...DEFAULT_CUSTOM_CURSOR_EFFECTS.label, ...overrides, style };
}

test("label effects preserve text, animate, and handle grapheme clusters", () => {
  const label = "Thinking 👨‍👩‍👧‍👦 e\u0301";
  const renderers = [
    renderWaveEffect,
    renderShimmerEffect,
    renderScanEffect,
    renderPulseEffect,
    renderRainbowEffect,
  ];
  for (const renderer of renderers) {
    const first = renderer(label, 0, theme);
    const second = renderer(label, 1, theme);
    assert.equal(stripVTControlCharacters(first), label);
    assert.equal(stripVTControlCharacters(second), label);
    assert.notEqual(first, second, `${renderer.name} advances`);
  }

  assert.deepEqual(splitLabelGraphemes("A👨‍👩‍👧‍👦e\u0301"), ["A", "👨‍👩‍👧‍👦", "e\u0301"]);
  assert.equal(cursorEffectFrame(1_000, 1_059, 60), 0);
  assert.equal(cursorEffectFrame(1_000, 1_060, 60), 1);

  const narrow = renderWaveEffect("abcdef", 2, theme, {
    crestWidth: "narrow",
    palette: "monochrome",
  });
  const wide = renderWaveEffect("abcdef", 2, theme, {
    crestWidth: "wide",
    palette: "monochrome",
  });
  assert.notEqual(narrow, wide, "monochrome crest width remains visible");
});

test("moving labels support direction, ping-pong, and loop pauses", () => {
  assert.equal(sweepPosition(0, 5, "left-to-right", "none", "normal"), -2);
  assert.equal(sweepPosition(0, 5, "right-to-left", "none", "normal"), 6);
  assert.equal(sweepPosition(8, 5, "ping-pong", "none", "normal"), 6);
  assert.equal(sweepPosition(9, 5, "ping-pong", "none", "normal"), 5);
  assert.equal(sweepPosition(9, 5, "left-to-right", "short", "normal"), undefined);

  const left = renderScanEffect("direction", 2, theme, { direction: "left-to-right" });
  const right = renderScanEffect("direction", 2, theme, { direction: "right-to-left" });
  assert.notEqual(left, right);
});

test("loader library uses fixed widths and Custom Claude honors controls", () => {
  assert.deepEqual(Object.keys(LOADER_EFFECTS), [
    "pi-default",
    "none",
    "claude",
    "pulse",
    "dots",
    "bounce",
    "orbit",
  ]);
  assert.deepEqual(Object.keys(LABEL_EFFECTS), [
    "none",
    "wave",
    "shimmer",
    "scan",
    "pulse",
    "rainbow",
  ]);

  for (const style of ["pulse", "dots", "bounce", "orbit"] as const) {
    const indicator = createLoaderIndicator({
      ...DEFAULT_CUSTOM_CURSOR_EFFECTS,
      loader: { style, speed: "normal", color: "accent" },
    }, theme);
    const widths = new Set(indicator.frames?.map((frame) => Array.from(stripVTControlCharacters(frame)).length));
    assert.equal(widths.size, 1, `${style} frames have a stable width`);
    assert.equal(indicator.intervalMs, 80);
  }

  const slowClaude = createLoaderIndicator({
    ...DEFAULT_CUSTOM_CURSOR_EFFECTS,
    loader: { style: "claude", speed: "slow", color: "muted" },
  }, theme);
  const fastClaude = createLoaderIndicator({
    ...DEFAULT_CUSTOM_CURSOR_EFFECTS,
    loader: { style: "claude", speed: "fast", color: "text" },
  }, theme);
  assert.equal(slowClaude.intervalMs, 140);
  assert.equal(fastClaude.intervalMs, 50);
  assert.match(slowClaude.frames?.[0] ?? "", /\u001b\[90m·/);
  assert.match(fastClaude.frames?.[0] ?? "", /\u001b\[97m·/);
  assert.notDeepEqual(slowClaude, fastClaude);

  const hidden = createLoaderIndicator({
    ...DEFAULT_CUSTOM_CURSOR_EFFECTS,
    loader: { style: "none", speed: "normal", color: "accent" },
  }, theme);
  assert.deepEqual(hidden.frames, []);
});

test("preset themes retain inspected Claude Code and Codex timing", () => {
  assert.deepEqual(createClaudeLoaderFrames("linux", "xterm-256color"), [
    "·", "✢", "*", "✶", "✻", "✽", "✽", "✻", "✶", "*", "✢", "·",
  ]);
  assert.deepEqual(createClaudeLoaderFrames("darwin", "xterm-256color"), [
    "·", "✢", "✳", "✶", "✻", "✽", "✽", "✻", "✶", "✳", "✢", "·",
  ]);
  assert.deepEqual(createClaudeLoaderFrames("linux", "xterm-ghostty"), [
    "·", "✢", "✳", "✶", "✻", "*", "*", "✻", "✶", "✳", "✢", "·",
  ]);

  const defaultTheme = resolveCursorTheme(DEFAULT_CURSOR_EFFECT_CONFIG, theme);
  assert.equal(defaultTheme.indicator, undefined);
  assert.deepEqual(defaultTheme.label, { style: "none" });

  const claude = resolveCursorTheme({ ...DEFAULT_CURSOR_EFFECT_CONFIG, theme: "claude-code" }, theme);
  assert.equal(claude.indicator?.frames?.length, 144);
  assert.equal(claude.indicator?.intervalMs, 50);
  assert.match(claude.indicator?.frames?.[0] ?? "", /\u001b\[38;5;174m·/);
  assert.equal(claude.label.style, "claude");

  const codex = resolveCursorTheme({ ...DEFAULT_CURSOR_EFFECT_CONFIG, theme: "codex" }, theme);
  assert.equal(codex.indicator?.frames?.length, 63);
  assert.equal(codex.indicator?.intervalMs, 32);
  assert.equal(codex.label.style, "codex");
});

test("patch affects main statuses, excludes tool loaders, and restores all methods", () => {
  const prototype = Loader.prototype as unknown as {
    updateDisplay(): void;
    render(width: number): string[];
    stop(): void;
  };
  const originalUpdate = prototype.updateDisplay;
  const originalRender = prototype.render;
  const originalStop = prototype.stop;
  const first = installCursorEffectPatch(DEFAULT_CUSTOM_CURSOR_EFFECTS.label);
  const patchedUpdate = prototype.updateDisplay;
  const patchedStop = prototype.stop;
  const second = installCursorEffectPatch(DEFAULT_CUSTOM_CURSOR_EFFECTS.label);
  first.setTheme(theme);
  first.setResolvedTheme({
    indicator: { frames: [] },
    label: customLabel("wave"),
  });

  try {
    const working = new WorkingLoader("Thinking...");
    const toolLoader = new Loader(ui, (text) => text, muted, "Running tool...", { frames: [] });
    const workingOutput = rendered(working);
    const toolOutput = rendered(toolLoader);

    assert.equal(stripVTControlCharacters(workingOutput).trim(), "Thinking...");
    assert.match(workingOutput, /\u001b\[96mT/);
    assert.equal(stripVTControlCharacters(toolOutput).trim(), "Running tool...");
    assert.equal(toolOutput.includes("\u001b[96m"), false, "tool loaders stay outside plugin scope");

    const claudeTheme = resolveCursorTheme(
      { ...DEFAULT_CURSOR_EFFECT_CONFIG, theme: "claude-code" },
      theme,
    );
    first.setResolvedTheme(claudeTheme);
    const mainStatuses = [
      ["retry", "Retrying (1/3) in 2s... (escape to cancel)"],
      ["compaction", "Compacting context... (escape to cancel)"],
      ["branchSummary", "Summarizing branch... (escape to cancel)"],
    ] as const;
    for (const [kind, message] of mainStatuses) {
      const status = new StatusLoader(kind, message);
      const output = rendered(status);
      assert.equal(stripVTControlCharacters(output).trim(), `· ${message}`);
      assert.match(output, /\u001b\[38;5;174m·/);
      status.stop();
    }

    working.setMessage("\u001b[31mStyled status\u001b[39m");
    assert.equal(rendered(working).includes("\u001b[96m"), false, "pre-styled labels stay untouched");

    second.setLabelConfig({ ...DEFAULT_CUSTOM_CURSOR_EFFECTS.label, style: "none" });
    working.setMessage("Native label");
    assert.equal(rendered(working).includes("\u001b[96m"), false, "none restores native label styling");
    working.stop();
    toolLoader.stop();

    first.dispose();
    assert.equal(prototype.updateDisplay, patchedUpdate);
    assert.equal(prototype.stop, patchedStop);
  } finally {
    second.dispose();
  }
  assert.equal(prototype.updateDisplay, originalUpdate);
  assert.equal(prototype.render, originalRender);
  assert.equal(prototype.stop, originalStop);
});

test("label timer advances faster than a slow loader and stops cleanly", async () => {
  const handle = installCursorEffectPatch();
  handle.setTheme(theme);
  handle.setResolvedTheme({
    indicator: { frames: ["x", "y"], intervalMs: 500 },
    label: customLabel("pulse", { speed: "fast" }),
  });
  const working = new WorkingLoader("Independent timing");
  try {
    const first = rendered(working);
    // The label timer (60ms at fast speed) is independent of the 500ms loader
    // frames. Poll instead of sleeping a fixed window: unref'd timers can be
    // delayed past 85ms under CI scheduling pressure, which made a single
    // check flaky on shared runners.
    let second = first;
    const deadline = Date.now() + 2_000;
    while (second === first && Date.now() < deadline) {
      await delay(20);
      second = rendered(working);
    }
    assert.notEqual(first, second, "label advances without waiting for the loader frame");
  } finally {
    working.stop();
    handle.dispose();
  }
});

test("streaming label changes preserve phase without Loader frame catch-up", () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  const handle = installCursorEffectPatch();
  handle.setTheme(theme);
  handle.setResolvedTheme({
    indicator: { frames: ["0", "1"], intervalMs: 100 },
    label: customLabel("pulse", { speed: "fast" }),
  });
  const working = new WorkingLoader("Thinking");
  try {
    working.stop();
    assert.match(rendered(working), /^\n 0 /);

    now += 60;
    working.setMessage("Calling tool");
    const updated = rendered(working);
    assert.match(updated, /^\n 0 /, "Loader remains callback-driven");
    assert.match(updated, /\u001b\[96mCalling tool/, "label does not restart when its message changes");
  } finally {
    working.stop();
    handle.dispose();
    Date.now = originalNow;
  }
});

test("cursor-effect config migrates, normalizes, saves, and reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cursor-effect-"));
  const path = join(directory, "99extensions.json");
  try {
    assert.deepEqual(normalizeCursorEffectConfig({}), DEFAULT_CURSOR_EFFECT_CONFIG);
    const legacy = normalizeCursorEffectConfig({ style: "none" });
    assert.equal(legacy.theme, "custom");
    assert.equal(legacy.custom.label.style, "none");
    assert.equal(legacy.custom.label.direction, "left-to-right");
    assert.equal(legacy.custom.label.pause, "none");

    const config = {
      theme: "custom" as const,
      custom: {
        loader: { style: "orbit" as const, speed: "fast" as const, color: "text" as const },
        label: {
          style: "shimmer" as const,
          speed: "slow" as const,
          crestWidth: "wide" as const,
          palette: "thinking" as const,
          direction: "ping-pong" as const,
          pause: "long" as const,
        },
      },
    };
    saveCursorEffectConfig(config, path);
    assert.deepEqual(loadCursorEffectConfig(path), config);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      "cursor-effect": config,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
