import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  loadCursorEffectConfig,
  normalizeCursorEffectConfig,
  renderWaveEffect,
  resolveCursorTheme,
  saveCursorEffectConfig,
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

test("wave renderer starts visibly, preserves text, and advances every 100ms", () => {
  const first = renderWaveEffect("Thinking...", 0, theme);
  const second = renderWaveEffect("Thinking...", 1, theme);
  assert.equal(stripVTControlCharacters(first), "Thinking...");
  assert.equal(stripVTControlCharacters(second), "Thinking...");
  assert.notEqual(first, second);
  assert.match(first, /\u001b\[97mT/);
  assert.match(first, /\u001b\[90minking\.\.\./);
  assert.equal(cursorEffectFrame(1_000, 1_099), 0);
  assert.equal(cursorEffectFrame(1_000, 1_100), 1);
});

test("theme presets and custom loader combinations resolve independently", () => {
  const piDefault = createLoaderIndicator(DEFAULT_CUSTOM_CURSOR_EFFECTS, theme);
  assert.equal(piDefault.frames?.length, 10);
  assert.equal(piDefault.intervalMs, 80);
  assert.match(piDefault.frames?.[0] ?? "", /\u001b\[96m⠋/);

  const hidden = createLoaderIndicator(
    {
      ...DEFAULT_CUSTOM_CURSOR_EFFECTS,
      loader: { style: "none", speed: "normal", color: "accent" },
      label: { ...DEFAULT_CUSTOM_CURSOR_EFFECTS.label, style: "none" },
    },
    theme,
  );
  assert.deepEqual(hidden.frames, []);
  const hiddenWithWave = createLoaderIndicator(
    {
      ...DEFAULT_CUSTOM_CURSOR_EFFECTS,
      loader: { style: "none", speed: "normal", color: "accent" },
    },
    theme,
  );
  assert.deepEqual(hiddenWithWave.frames, ["", ""]);

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
  const claude = resolveCursorTheme(
    { ...DEFAULT_CURSOR_EFFECT_CONFIG, theme: "claude-code" },
    theme,
  );
  assert.equal(claude.indicator?.frames?.length, 144);
  assert.equal(claude.indicator?.intervalMs, 50);
  assert.match(claude.indicator?.frames?.[0] ?? "", /\u001b\[38;5;174m·/);
  assert.equal(claude.label.style, "claude");
  const codex = resolveCursorTheme(
    { ...DEFAULT_CURSOR_EFFECT_CONFIG, theme: "codex" },
    theme,
  );
  assert.equal(codex.indicator?.frames?.length, 63);
  assert.equal(codex.indicator?.intervalMs, 32);
  assert.equal(codex.label.style, "codex");
});

test("patch affects every main status cursor, excludes tool loaders, and restores", () => {
  const prototype = Loader.prototype as unknown as { updateDisplay(): void; render(width: number): string[] };
  const originalUpdate = prototype.updateDisplay;
  const originalRender = prototype.render;
  const first = installCursorEffectPatch(DEFAULT_CUSTOM_CURSOR_EFFECTS.label);
  const patched = prototype.updateDisplay;
  const second = installCursorEffectPatch(DEFAULT_CUSTOM_CURSOR_EFFECTS.label);
  first.setTheme(theme);
  first.setResolvedTheme({
    indicator: { frames: [] },
    label: { ...DEFAULT_CUSTOM_CURSOR_EFFECTS.label, style: "wave" },
  });

  try {
    const working = new WorkingLoader("Thinking...");
    const toolLoader = new Loader(ui, (text) => text, muted, "Running tool...", { frames: [] });
    const workingOutput = rendered(working);
    const toolOutput = rendered(toolLoader);

    assert.equal(stripVTControlCharacters(workingOutput).trim(), "Thinking...");
    assert.match(workingOutput, /\u001b\[97mT/);
    assert.equal(stripVTControlCharacters(toolOutput).trim(), "Running tool...");
    assert.equal(toolOutput.includes("\u001b[97m"), false, "tool loaders stay outside plugin scope");

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
    assert.equal(rendered(working).includes("\u001b[97m"), false, "pre-styled labels stay untouched");

    second.setLabelConfig({ ...DEFAULT_CUSTOM_CURSOR_EFFECTS.label, style: "none" });
    working.setMessage("Native label");
    assert.equal(rendered(working).includes("\u001b[97m"), false, "none restores native label styling");
    working.stop();
    toolLoader.stop();

    first.dispose();
    assert.equal(prototype.updateDisplay, patched);
  } finally {
    second.dispose();
  }
  assert.equal(prototype.updateDisplay, originalUpdate);
  assert.equal(prototype.render, originalRender);
});

test("cursor-effect config normalizes, saves, and reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cursor-effect-"));
  const path = join(directory, "99extensions.json");
  try {
    assert.deepEqual(normalizeCursorEffectConfig({}), DEFAULT_CURSOR_EFFECT_CONFIG);
    const legacy = normalizeCursorEffectConfig({ style: "none" });
    assert.equal(legacy.theme, "custom");
    assert.equal(legacy.custom.label.style, "none");
    const config = {
      theme: "claude-code" as const,
      custom: {
        loader: { style: "claude" as const, speed: "fast" as const, color: "text" as const },
        label: {
          style: "wave" as const,
          speed: "slow" as const,
          crestWidth: "wide" as const,
          palette: "thinking" as const,
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
