import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Loader, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { CursorMetrics, estimateOutputTokens, registerCursorMetrics } from "../extensions/cursor-effect/metrics.ts";
import { metricsSettingsSummary } from "../extensions/cursor-effect/settings.ts";
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

test("runtime metrics use monotonic task time and exclude tools and retry waits from throughput", () => {
  let now = 0;
  const metrics = new CursorMetrics(() => now);
  const config = DEFAULT_CURSOR_EFFECT_CONFIG.metrics;
  assert.equal(metrics.text(config), "");
  metrics.start();
  metrics.startResponse();
  now = 2000;
  metrics.addDelta("a".repeat(80));
  assert.equal(metrics.text(config), "2s ≈20 out ≈10.0 tok/s");
  metrics.endResponse(100, "toolUse");
  now = 12000; // Ten seconds of tool execution.
  assert.equal(metrics.text(config), "12s 100 out ≈10.0 tok/s");
  metrics.start(); // Continuation/retry must not reset the task clock.
  metrics.startResponse();
  now = 15000;
  metrics.endResponse(200, "stop");
  metrics.endResponse(200, "stop"); // Ignore duplicate finalization.
  metrics.finish();
  now = 30000;
  assert.equal(metrics.text(config), "Done 15s 300 out Avg 60.0 tok/s");
  metrics.start();
  assert.equal(metrics.text(config), "0s 0 out");
  metrics.reset();
  assert.equal(metrics.text(config), "");
});

test("live speed holds the latest display between calls and resets for a new task", () => {
  let now = 0;
  const metrics = new CursorMetrics(() => now);
  const config = DEFAULT_CURSOR_EFFECT_CONFIG.metrics;
  metrics.start();
  metrics.startResponse();
  now = 2000;
  assert.doesNotMatch(metrics.text(config), /tok\/s/);
  metrics.addDelta("abcd");
  assert.match(metrics.text(config), /≈0\.5 tok\/s/);
  metrics.endResponse(10, "toolUse");
  now = 2500;
  assert.match(metrics.text(config), /≈0\.5 tok\/s/);
  metrics.startResponse();
  now = 3500;
  assert.match(metrics.text(config), /≈0\.5 tok\/s/);
  metrics.addDelta("abcdefgh");
  assert.match(metrics.text(config), /≈2\.0 tok\/s/);
  metrics.endResponse(20, "toolUse");
  metrics.startResponse();
  metrics.addDelta("abcd");
  now += 100;
  assert.match(metrics.text(config), /≈2\.0 tok\/s/);
  assert.doesNotMatch(metrics.text({ ...config, liveSpeed: false }), /tok\/s/);
  metrics.endResponse(1, "stop");
  metrics.finish();
  metrics.start();
  metrics.startResponse();
  assert.doesNotMatch(metrics.text(config), /tok\/s/);
});

test("runtime metrics label estimates and do not invent usage for cancelled or incomplete responses", () => {
  let now = 0;
  const metrics = new CursorMetrics(() => now);
  const config = DEFAULT_CURSOR_EFFECT_CONFIG.metrics;
  assert.equal(estimateOutputTokens("abcd中文"), 3);
  for (const stop of ["aborted", "error", "stop"]) {
    metrics.start();
    metrics.startResponse();
    metrics.addDelta("not authoritative usage");
    now += 1000;
    metrics.endResponse(0, stop);
    metrics.finish();
    assert.match(metrics.text(config), /out — Avg — tok\/s/);
    assert.match(metrics.text(config), new RegExp(`^${stop === "aborted" ? "Cancelled" : stop === "error" ? "Error" : "Done"}`));
  }
  metrics.start();
  metrics.startResponse();
  metrics.addDelta("text");
  metrics.endResponse(Number.NaN, "stop");
  metrics.finish();
  assert.match(metrics.text(config), /Avg —/);
  metrics.start();
  metrics.startResponse();
  metrics.addDelta("fast");
  metrics.endResponse(1, "stop");
  metrics.finish();
  assert.match(metrics.text(config), /Avg —/); // No division by zero or extreme sub-500ms rates.
  metrics.start();
  metrics.startResponse();
  metrics.finish();
  assert.match(metrics.text(config), /out —/);
});

test("metrics settings summarize enabled switches", () => {
  const config = DEFAULT_CURSOR_EFFECT_CONFIG.metrics;
  assert.equal(metricsSettingsSummary(config), "4/4 On");
  assert.equal(metricsSettingsSummary({ ...config, elapsed: false }), "3/4 On");
  assert.equal(metricsSettingsSummary({ elapsed: false, outputTokens: false, liveSpeed: false,
    completionSummary: false }), "0/4 On");
});

test("metric switches are independent and non-working rows show only task time", () => {
  let now = 0;
  const metrics = new CursorMetrics(() => now);
  const config = DEFAULT_CURSOR_EFFECT_CONFIG.metrics;
  const off = { elapsed: false, outputTokens: false, liveSpeed: false, completionSummary: false };
  metrics.start();
  metrics.startResponse();
  metrics.addDelta("test");
  now = 65000;
  assert.equal(metrics.text(off), "");
  assert.equal(metrics.text({ ...off, elapsed: true }), "1m 5s");
  assert.equal(metrics.text({ ...off, outputTokens: true }), "≈1 out");
  for (const kind of ["retry", "compaction", "branchSummary"]) {
    assert.equal(metrics.text(config, kind), "1m 5s");
  }
  const normalized = normalizeCursorEffectConfig({ metrics: { elapsed: false, liveSpeed: "false", unknown: true } });
  assert.equal(normalized.metrics.elapsed, false);
  assert.equal(normalized.metrics.liveSpeed, true);
  assert.equal(Object.hasOwn(normalized.metrics, "unknown"), false);
});

test("completion metrics follow the same switches as working metrics and ignore legacy averageSpeed", () => {
  let now = 0;
  const metrics = new CursorMetrics(() => now);
  metrics.start();
  metrics.startResponse();
  now = 2_000;
  metrics.endResponse(100, "stop");
  metrics.finish();
  const off = { elapsed: false, outputTokens: false, liveSpeed: false, completionSummary: true };
  assert.equal(metrics.text(off), "");
  assert.equal(metrics.text({ ...off, elapsed: true }), "Done 2s");
  assert.equal(metrics.text({ ...off, outputTokens: true }), "Done 100 out");
  assert.equal(metrics.text({ ...off, liveSpeed: true }), "Done Avg 50.0 tok/s");
  for (const liveSpeed of [true, false]) {
    const config = normalizeCursorEffectConfig({ metrics: { ...off, liveSpeed, averageSpeed: !liveSpeed } });
    assert.equal(Object.hasOwn(config.metrics, "averageSpeed"), false);
    assert.equal(metrics.text(config.metrics), liveSpeed ? "Done Avg 50.0 tok/s" : "");
  }
});

test("metrics event wiring settles once, preserves raw events, clears on tree/reload and honors summary toggle", () => {
  const handlers = new Map<string, (event: any, ctx?: any) => void>();
  const notifications: string[] = [];
  let config = { ...DEFAULT_CURSOR_EFFECT_CONFIG.metrics };
  const controller = registerCursorMetrics({
    on: (name: string, handler: (event: any, ctx?: any) => void) => { handlers.set(name, handler); },
  } as unknown as ExtensionAPI, () => config);
  const ctx = { hasUI: true, ui: {
    notify: (text: string, level: string) => { assert.equal(level, "info"); notifications.push(text); },
    setStatus: () => assert.fail("metrics must not occupy the status bar"),
  } };
  handlers.get("session_start")!({}, ctx);
  handlers.get("agent_start")!({}, ctx);
  handlers.get("turn_start")!({});
  for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
    handlers.get("message_update")!({ assistantMessageEvent: { type, delta: "abcd" } });
  }
  assert.match(controller.suffix("working"), /≈3 out/);
  handlers.get("message_update")!({ assistantMessageEvent: { type: "text_end", content: "abcd" } });
  assert.match(controller.suffix("working"), /≈3 out/);
  handlers.get("message_end")!({ message: { role: "toolResult" } });
  const message = { role: "assistant", usage: { output: 20 }, stopReason: "stop" };
  handlers.get("message_end")!({ message });
  assert.deepEqual(message, { role: "assistant", usage: { output: 20 }, stopReason: "stop" });
  assert.equal(handlers.has("agent_end"), false);
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(controller.suffix("working"), "");
  assert.match(notifications[0], /Done.*20 out/);
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(notifications.length, 1, "duplicate settle must not notify twice");
  config = { ...config, completionSummary: false };
  handlers.get("agent_start")!({}, ctx);
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(notifications.length, 1);
  config = { ...config, completionSummary: true };
  handlers.get("agent_start")!({}, ctx);
  handlers.get("agent_settled")!({}, { hasUI: false });
  assert.equal(notifications.length, 1, "non-UI mode must not notify");
  handlers.get("agent_start")!({}, ctx);
  handlers.get("session_tree")!({});
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(notifications.length, 1);
  handlers.get("agent_start")!({}, ctx);
  handlers.get("session_shutdown")!({});
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(controller.suffix("working"), "");
  assert.equal(notifications.length, 1);
});

test("plain working labels get an ellipsis without changing source or custom labels", () => {
  const handle = installCursorEffectPatch({ style: "none" });
  handle.setTheme(theme);
  handle.setResolvedTheme({ indicator: { frames: [] }, label: { style: "none" } });
  const working = new WorkingLoader("Working");
  const retry = new StatusLoader("retry", "Working");
  const tool = new Loader(ui, (text) => text, muted, "Working", { frames: [] });
  try {
    assert.match(stripVTControlCharacters(rendered(working)), /Working\.\.\./);
    assert.equal((working as unknown as { message: string }).message, "Working");
    assert.doesNotMatch(stripVTControlCharacters(rendered(retry)), /Working\.\.\./);
    assert.doesNotMatch(stripVTControlCharacters(rendered(tool)), /Working\.\.\./);
    handle.setMetrics(() => "2s");
    handle.setLabelEffect({ style: "none" });
    working.setMessage("Working");
    assert.match(stripVTControlCharacters(rendered(working)), /Working\.\.\. 2s/);
    working.setMessage("Working (esc to interrupt)");
    assert.match(stripVTControlCharacters(rendered(working)), /Working\.\.\. \(esc to interrupt\) 2s/);
    assert.equal((working as unknown as { message: string }).message, "Working (esc to interrupt)");
    for (const label of ["Working...", "Working on tests", "Thinking..."]) {
      working.setMessage(label);
      assert.ok(stripVTControlCharacters(rendered(working)).includes(`${label} 2s`));
      assert.doesNotMatch(stripVTControlCharacters(rendered(working)), /\.{4}/);
    }
  } finally {
    working.stop();
    retry.stop();
    tool.stop();
    handle.dispose();
  }
});

test("metrics append without taking over labels and refresh with both animations disabled", async () => {
  const handle = installCursorEffectPatch({ style: "none" });
  handle.setTheme(theme);
  handle.setResolvedTheme({ indicator: { frames: [] }, label: { style: "none" } });
  let suffix = "1s ≈10 tok/s";
  handle.setMetrics(() => suffix);
  const loader = new WorkingLoader("Thinking...");
  const other = new Loader(ui, (text) => text, muted, "Tool loader", { frames: [] });
  try {
    assert.match(stripVTControlCharacters(rendered(loader)), /Thinking\.\.\. 1s ≈10 tok\/s/);
    assert.doesNotMatch(rendered(other), /tok\/s/);
    assert.equal((loader as unknown as { message: string }).message, "Thinking...");
    suffix = "2s ≈12 tok/s";
    await delay(300);
    assert.match(stripVTControlCharacters(rendered(loader)), /2s ≈12 tok\/s/);
    loader.setMessage("New thinking-fold label");
    assert.match(stripVTControlCharacters(rendered(loader)), /New thinking-fold label 2s/);
    loader.setMessage("\u001b[31mPrestyled\u001b[0m");
    assert.match(stripVTControlCharacters(rendered(loader)), /Prestyled 2s/);
    for (const width of [12, 40, 120]) {
      for (const line of loader.render(width)) assert.ok(visibleWidth(line) <= width);
    }
    suffix = "";
    await delay(300);
    assert.doesNotMatch(rendered(loader), /tok\/s/);
  } finally {
    loader.stop();
    other.stop();
    handle.dispose();
  }
});

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
      ...structuredClone(DEFAULT_CURSOR_EFFECT_CONFIG),
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
