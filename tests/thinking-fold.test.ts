import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown, getKeybindings, setKeybindings, KeybindingsManager,
  type Component, type TUI,
} from "@earendil-works/pi-tui";
import thinkingFoldExtension, {
  BUILT_IN_MODEL_BEHAVIORS,
  createThinkingCursorLabel,
  createThinkingDisplayMessage,
  DEFAULT_THINKING_FOLD_CONFIG,
  DEFAULT_THINKING_FOLD_OPTIONS,
  endsThinkingPhase,
  extractLatestSummaryHeadline,
  formatThinkingSeconds,
  installThinkingFoldPatch,
  loadThinkingFoldConfig,
  normalizeThinkingFoldConfig,
  parseModelBehaviorConfig,
  remainingSummaryCursorMs,
  resolveConfiguredThinkingBehavior,
  resolveThinkingBehavior,
  saveThinkingFoldConfig,
  type ThinkingDisplayState,
  type ThinkingFoldOptions,
} from "../extensions/thinking-fold/index.ts";

function assistant(
  thinking: string,
  api: AssistantMessage["api"] = "openai-completions",
  answer = "final answer",
  timestamp = 1_000,
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking },
      { type: "text", text: answer },
    ],
    api,
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

initTheme("dark", false);

const options: ThinkingFoldOptions = {
  ...DEFAULT_THINKING_FOLD_OPTIONS,
  previewLines: 3,
  toggleKey: "ctrl+t",
};

function thinkingText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking)
    .join("\n");
}

function streamingDisplay(startedAt = 1_000, now = 3_450): ThinkingDisplayState {
  return { timing: { startedAt }, now };
}

function cleanRenderedLines(lines: string[], pad = 1): string[] {
  return lines
    .map(stripVTControlCharacters)
    .map((line) => line.replace(new RegExp(`^ {0,${pad}}`), "").trimEnd());
}

/** Render source text through the same Markdown implementation Pi uses. */
function renderThinkingLines(text: string, width = 80, pad = 1): string[] {
  return cleanRenderedLines(
    new Markdown(text, pad, 0, getMarkdownTheme(), undefined).render(width),
    pad,
  );
}

function renderAssistantLines(
  component: AssistantMessageComponent,
  width = 80,
  pad = 1,
): string[] {
  return cleanRenderedLines(component.render(width), pad);
}

test("auto mode follows the built-in model behavior configuration", () => {
  assert.equal(BUILT_IN_MODEL_BEHAVIORS.version, 1);
  assert.equal(resolveThinkingBehavior(assistant("trace"), "auto"), "trace");
  assert.equal(resolveThinkingBehavior(assistant("summary", "openai-responses"), "auto"), "summary");
  assert.equal(
    resolveThinkingBehavior(assistant("summary", "google-generative-ai"), "auto"),
    "summary",
  );
  assert.equal(resolveThinkingBehavior(assistant("summary", "openai-responses"), "trace"), "trace");
  assert.equal(resolveThinkingBehavior(assistant("trace"), "summary"), "summary");

  const matrix = [
    ["openai-completions", "openrouter", "deepseek/deepseek-r1", "trace"],
    ["anthropic-messages", "kimi-coding", "kimi-for-coding", "trace"],
    ["anthropic-messages", "minimax", "MiniMax-M2.7", "trace"],
    ["bedrock-converse-stream", "amazon-bedrock", "amazon.nova-2-lite-v1:0", "trace"],
    ["mistral-conversations", "mistral", "magistral-medium-latest", "trace"],
    ["pi-messages", "custom-gateway", "reasoning-model", "trace"],
    ["anthropic-messages", "anthropic", "claude-opus-4-7", "summary"],
    ["openai-codex-responses", "openai-codex", "gpt-5.4", "summary"],
    ["azure-openai-responses", "azure-openai-responses", "gpt-5.4", "summary"],
    ["google-vertex", "google-vertex", "gemini-3.1-pro", "summary"],
  ] as const;
  for (const [api, provider, model, expected] of matrix) {
    assert.equal(
      resolveConfiguredThinkingBehavior({ api, provider, model }),
      expected,
      `${provider}/${model} should use ${expected}`,
    );
  }
  assert.equal(
    resolveConfiguredThinkingBehavior({ api: "future-api", provider: "future", model: "future-model" }),
    undefined,
  );
});

test("model behavior rules support layered regex matching and deterministic priority", () => {
  const config = parseModelBehaviorConfig({
    version: 1,
    rules: [
      { api: "responses$", behavior: "summary" },
      { provider: "^test$", behavior: "trace" },
      { provider: "^test$", model: "^special-(?:v1|v2)$", behavior: "summary" },
      { provider: "^tie$", behavior: "trace" },
      { provider: "^tie$", behavior: "summary" },
    ],
  });

  assert.equal(
    resolveConfiguredThinkingBehavior(
      { api: "openai-responses", provider: "other", model: "model" },
      config,
    ),
    "summary",
  );
  assert.equal(
    resolveConfiguredThinkingBehavior(
      { api: "openai-responses", provider: "test", model: "ordinary" },
      config,
    ),
    "trace",
  );
  assert.equal(
    resolveConfiguredThinkingBehavior(
      { api: "openai-responses", provider: "test", model: "special-v2" },
      config,
    ),
    "summary",
  );
  assert.equal(
    resolveConfiguredThinkingBehavior({ api: "custom", provider: "tie", model: "model" }, config),
    "summary",
  );
  assert.equal(
    resolveConfiguredThinkingBehavior({ api: "custom", provider: "unknown", model: "model" }, config),
    undefined,
  );
  assert.throws(
    () => parseModelBehaviorConfig({ version: 1, rules: [{ behavior: "summary" }] }),
    /needs api, provider, or model/,
  );
  assert.throws(
    () =>
      parseModelBehaviorConfig({
        version: 1,
        rules: [{ model: "[invalid", behavior: "trace" }],
      }),
    /invalid model regex/,
  );
});

test("empty thinking_start still creates a timed Item before summary text arrives", () => {
  const source = assistant("", "openai-responses");
  const display = createThinkingDisplayMessage(source, options, false, 80, 1, streamingDisplay());
  assert.equal(thinkingText(display), "Thinking 2.5s");
});

test("instant summaries receive a minimum cursor visibility window", () => {
  assert.equal(remainingSummaryCursorMs(1_000, 1_018), 982);
  assert.equal(remainingSummaryCursorMs(1_000, 2_500), 0);
  assert.equal(remainingSummaryCursorMs(2_000, 1_000), 1000);
});

test("actual output events end thinking even when provider thinking_end is late", () => {
  assert.equal(endsThinkingPhase("thinking_start"), false);
  assert.equal(endsThinkingPhase("thinking_delta"), false);
  assert.equal(endsThinkingPhase("text_start"), true);
  assert.equal(endsThinkingPhase("text_delta"), true);
  assert.equal(endsThinkingPhase("toolcall_start"), true);
  assert.equal(endsThinkingPhase("thinking_end"), true);
});

test("trace and summary models without visible reasoning use the normal responding row", async () => {
  const handlers = new Map<
    string,
    Array<(event: any, ctx: ExtensionContext) => unknown>
  >();
  const pi = {
    registerCommand() {},
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
  } as unknown as ExtensionAPI;
  const workingMessages: Array<string | undefined> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    model: { reasoning: true },
    ui: {
      setWorkingMessage: (message?: string) => workingMessages.push(message),
      setStatus: (key: string, value?: string) => statuses.push([key, value]),
    },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };

  thinkingFoldExtension(pi);
  try {
    for (const api of ["openai-completions", "openai-responses"] as const) {
      const message: AssistantMessage = {
        ...assistant("", api),
        content: [{ type: "text", text: "answer" }],
      };
      await emit("message_start", { message });
      await emit("message_update", {
        message,
        assistantMessageEvent: { type: "text_delta" },
      });

      assert.equal(workingMessages.at(-1), "Responding...");
      assert.deepEqual(statuses, []);
      await emit("message_end", { message });
    }
  } finally {
    await emit("session_shutdown", {});
  }

  assert.doesNotMatch(
    workingMessages.filter((message): message is string => message !== undefined).join("\n"),
    /reasoning details unavailable/,
  );
});

test("Ctrl+T redraws completed messages while idle and releases the render bridge on shutdown", async () => {
  const previousKeys = getKeybindings();
  setKeybindings(new KeybindingsManager({
    "app.thinking.toggle": { defaultKeys: "ctrl+t" },
  }));
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const pi = {
    registerCommand() {},
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let bridge: (Component & { dispose?(): void }) | undefined;
  let component: AssistantMessageComponent | undefined;
  let frame = "";
  let renders = 0;
  const tui = {
    requestRender() {
      renders++;
      if (component) frame = renderAssistantLines(component).join("\n");
    },
  } as unknown as TUI;
  const source = assistant("first reasoning line\nlast reasoning line");
  const ctx = {
    mode: "tui", hasUI: true,
    sessionManager: {
      getEntries: () => [{ type: "message", message: source, timestamp: new Date(2_000).toISOString() }],
    },
    ui: {
      setWorkingMessage() {},
      setWidget(_key: string, factory: ((tui: TUI) => Component) | undefined, options?: { placement: string }) {
        bridge?.dispose?.();
        bridge = factory?.(tui);
        if (factory) assert.equal(options?.placement, "belowEditor");
      },
      onTerminalInput(handler: typeof input) {
        input = handler;
        return () => { input = undefined; };
      },
    },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  thinkingFoldExtension(pi);
  try {
    await emit("session_start");
    assert.deepEqual(bridge?.render(80), [], "render bridge must not add visible rows");
    component = new AssistantMessageComponent(source);
    tui.requestRender();
    assert.match(frame, /Thought for 1\.0s/);
    assert.doesNotMatch(frame, /first reasoning line/);
    const before = renders;
    assert.equal(input?.("x"), undefined);
    assert.equal(renders, before);
    assert.deepEqual(input?.("\x14"), { consume: true });
    assert.equal(renders, before + 1);
    assert.match(frame, /first reasoning line/);
    assert.deepEqual(input?.("\x14"), { consume: true });
    assert.equal(renders, before + 2);
    assert.doesNotMatch(frame, /first reasoning line/);
    // Also cover an actually completed turn without any streaming/loader timer.
    await emit("message_start", { message: source });
    await emit("message_update", {
      message: source,
      assistantMessageEvent: { type: "thinking_end" },
    });
    await emit("message_end", { message: source });
    await emit("agent_end");
    const idleRenders = renders;
    input?.("\x14");
    assert.equal(renders, idleRenders + 1);
    assert.match(frame, /first reasoning line/);
    input?.("\x14");
    assert.doesNotMatch(frame, /first reasoning line/);
  } finally {
    await emit("session_shutdown");
    setKeybindings(previousKeys);
  }
  assert.equal(input, undefined);
  assert.equal(bridge, undefined);
});

test("trace Item shows a timed header while the cursor keeps a Thinking... label", () => {
  const source = assistant(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
  const display = createThinkingDisplayMessage(source, options, false, 80, 1, streamingDisplay());
  const renderedThinking = thinkingText(display);

  assert.notEqual(display, source);
  assert.equal(createThinkingCursorLabel(source, "auto"), "Thinking...");
  assert.doesNotMatch(renderedThinking, /line 1(?:\n|$)/);
  assert.equal(
    renderedThinking,
    "Thinking 2.5s  (ctrl+t to expand)\nline 8\nline 9\nline 10",
  );
  assert.equal(thinkingText(source).startsWith("line 1\n"), true);
  assert.equal(display.content.at(-1), source.content.at(-1), "answer blocks stay untouched");
});

test("visual truncation accounts for wrapped wide text", () => {
  const source = assistant("一二三四五六七八九十一二三四五六七八九十");
  const display = createThinkingDisplayMessage(
    source,
    { ...options, previewLines: 2 },
    false,
    12,
    1,
    streamingDisplay(),
  );
  assert.match(thinkingText(display), /^Thinking 2\.5s  \(ctrl\+t to expand\)\n/);
  assert.ok(thinkingText(display).split("\n").length <= 3);
});

test("trailing newlines do not make the folded preview jump rows", () => {
  const base = Array.from({ length: 6 }, (_, index) => `line ${index + 1}`).join("\n");
  // A streaming chunk boundary that ends with a newline must render the same
  // folded tail as the same text without it (the Text component would otherwise
  // count the trailing break as an extra empty row).
  const plain = createThinkingDisplayMessage(
    assistant(base),
    { ...options, previewLines: 3 },
    false,
    80,
    1,
    streamingDisplay(),
  );
  const trailingNewline = createThinkingDisplayMessage(
    assistant(`${base}\n`),
    { ...options, previewLines: 3 },
    false,
    80,
    1,
    streamingDisplay(),
  );
  const trailingBlanks = createThinkingDisplayMessage(
    assistant(`${base}\n\n`),
    { ...options, previewLines: 3 },
    false,
    80,
    1,
    streamingDisplay(),
  );
  const plainText = thinkingText(plain);
  assert.equal(thinkingText(trailingNewline), plainText);
  assert.equal(thinkingText(trailingBlanks), plainText);
  assert.match(plainText, /\nline 4\nline 5\nline 6$/);
  assert.doesNotMatch(plainText, /\n\n$/);
});

test("markdown is rendered before the trace preview is folded", () => {
  const traces = [
    "start\n```python\nimport os\nprint('x')\n```\nmore\n",
    "start\n# Heading\nparagraph\nmore text\nlast line\n",
    "start\n| a | b |\n|---|---|\n| 1 | 2 |\nnext\n",
    "start\n\n    indented = 1\n    more = 2\n\nfinish\n",
    "start\n> quote\n> more quote\nplain\nlast line\n",
    "start\n- one\n- two\n- three\nlast\n",
    "start\n1. one\n2. two\n3. three\nlast\n",
    "start\n***\nplain\nlast line\nmore\n",
    "start\n[1]: http://example.com\nplain\nmore lines\nlast line\n",
  ];
  const patch = installThinkingFoldPatch({ ...options, previewLines: 3 });
  try {
    traces.forEach((trace, index) => {
      const source = assistant(trace, "openai-completions", "", 10_000 + index);
      patch.beginMessage(source, 1_000);
      patch.tick(3_450);
      const component = new AssistantMessageComponent(source);
      const actual = renderAssistantLines(component).slice(1);
      const fullMarkdown = renderThinkingLines(trace.trim());
      assert.deepEqual(actual, [
        `Thinking 2.5s${fullMarkdown.length > 3 ? "  (ctrl+t to expand)" : ""}`,
        ...fullMarkdown.slice(-3),
      ]);
      assert.equal(actual.length <= 4, true, `${JSON.stringify(trace.slice(0, 24))} exceeded 4 rows`);
    });
  } finally {
    patch.dispose();
  }
});

test("the folded preview height stays pinned while markdown streams", () => {
  const trace = [
    "# Analyzing the request",
    "Let me break this down:",
    "```python",
    "import os",
    "print(os.getcwd())",
    "```",
    "",
    "| step | result |",
    "|------|--------|",
    "| 1    | ok     |",
    "| 2    | fail   |",
    "",
    "> **Note:** retry needed",
    "",
    "    retries = 3",
    "    timeout = 30",
    "",
    "- first attempt",
    "- second attempt",
    "- third attempt",
    "",
    "## Summary",
    "Done with analysis",
  ];
  const first = assistant(trace[0]!, "openai-completions", "", 20_000);
  const patch = installThinkingFoldPatch({ ...options, previewLines: 3 });
  try {
    patch.beginMessage(first, 1_000);
    patch.tick(3_450);
    const component = new AssistantMessageComponent(first);
    let previousHeight = 0;
    for (let end = 1; end <= trace.length; end++) {
      component.updateContent(
        assistant(trace.slice(0, end).join("\n"), "openai-completions", "", 20_000),
      );
      const height = component.render(80).length - 1; // native leading assistant spacer
      assert.ok(height <= 4, `folded height ${height} exceeds 4 rows at line ${end}`);
      if (previousHeight >= 4) {
        assert.equal(height, 4, `folded height dropped from 4 to ${height} at line ${end}`);
      }
      previousHeight = height;
    }
  } finally {
    patch.dispose();
  }
});

test("rendered markdown overflow controls the hint and expansion", () => {
  // Three source rows fit the raw threshold, but a native Markdown table renders
  // five terminal rows. The post-render fold must hide two rows and advertise
  // expansion; Ctrl+T must restore the exact native table.
  const trace = "| name | value |\n|---|---|\n| alpha | beta |";
  const source = assistant(trace, "openai-completions", "", 30_000);
  const nativeTable = renderThinkingLines(trace);
  assert.ok(nativeTable.length > 3);
  assert.ok(nativeTable.some((line) => line.includes("┌")));

  const patch = installThinkingFoldPatch({ ...options, previewLines: 3 });
  try {
    patch.beginMessage(source, 1_000);
    patch.tick(3_450);
    const component = new AssistantMessageComponent(source);
    const folded = renderAssistantLines(component).slice(1);
    assert.deepEqual(folded, [
      "Thinking 2.5s  (ctrl+t to expand)",
      ...nativeTable.slice(-3),
    ]);
    assert.doesNotMatch(folded.join("\n"), /\|---\||thinking-fold:/);
    assert.equal(thinkingText(source), trace, "display markers must never modify source content");

    component.invalidate();
    assert.deepEqual(
      renderAssistantLines(component).slice(1),
      folded,
      "native invalidation must rebuild from source rather than marker text",
    );

    patch.setExpanded(true);
    const expanded = renderAssistantLines(component).slice(1);
    assert.deepEqual(expanded, nativeTable);
  } finally {
    patch.dispose();
  }
});

test("automatic streaming hides summaries while the cursor shows their headline", () => {
  const summary = assistant(
    "**Inspecting the implementation**\n\n**Running focused tests**",
    "openai-responses",
  );
  const display = createThinkingDisplayMessage(summary, options, false, 80, 1, streamingDisplay());
  const preview = createThinkingDisplayMessage(
    summary,
    { ...options, streamingBehavior: "preview" },
    false,
    80,
    1,
    streamingDisplay(),
  );
  assert.equal(extractLatestSummaryHeadline(summary), "Running focused tests");
  assert.equal(thinkingText(display), "Thinking 2.5s  (ctrl+t to expand)");
  assert.equal(
    thinkingText(preview),
    "Thinking 2.5s\n**Inspecting the implementation**\n\n**Running focused tests**",
  );
  assert.equal(createThinkingCursorLabel(summary, "auto"), "Running focused tests");
});

test("explicit summary mode uses the newest plain-text headline for any provider", () => {
  const summary = assistant(
    "Analyzing the information bound.\n\nChecking physical decision-tree constraints.",
  );
  const summaryOptions = { ...options, mode: "summary" as const };
  const display = createThinkingDisplayMessage(
    summary,
    summaryOptions,
    false,
    80,
    1,
    streamingDisplay(),
  );
  assert.equal(extractLatestSummaryHeadline(summary), "Checking physical decision-tree constraints.");
  assert.equal(thinkingText(display), "Thinking 2.5s  (ctrl+t to expand)");
  assert.equal(
    createThinkingCursorLabel(summary, "summary"),
    "Checking physical decision-tree constraints.",
  );
});

test("completed untruncated thinking does not advertise expansion", () => {
  const completed: ThinkingDisplayState = { timing: { startedAt: 1_000, completedAt: 2_000 } };
  const shortTrace = createThinkingDisplayMessage(
    assistant("one\ntwo", "openai-completions"),
    { ...options, completedBehavior: "preview" },
    false,
    80,
    1,
    completed,
  );
  const summary = createThinkingDisplayMessage(
    assistant("Searching Pi provider URL and auth storage", "openai-responses"),
    { ...options, completedBehavior: "preview" },
    false,
    80,
    1,
    completed,
  );

  assert.equal(thinkingText(shortTrace), "Thought for 1.0s\none\ntwo");
  assert.equal(
    thinkingText(summary),
    "Thought for 1.0s\nSearching Pi provider URL and auth storage",
  );
});

test("completed overflowed summaries retain only the configured tail", () => {
  const summary = assistant(
    Array.from({ length: 6 }, (_, index) => `summary ${index + 1}`).join("\n"),
    "openai-responses",
  );
  const display = createThinkingDisplayMessage(
    summary,
    { ...options, completedBehavior: "preview" },
    false,
    80,
    1,
    { timing: { startedAt: 1_000, completedAt: 2_000 } },
  );

  assert.equal(
    thinkingText(display),
    "Thought for 1.0s  (ctrl+t to expand)\nsummary 4\nsummary 5\nsummary 6",
  );
});

test("display strategies control streaming and completed thinking independently", () => {
  const source = assistant("one\ntwo\nthree\nfour");
  const streaming = createThinkingDisplayMessage(
    source,
    { ...options, streamingBehavior: "collapse" },
    false,
    80,
    1,
    streamingDisplay(),
  );
  const full = createThinkingDisplayMessage(
    source,
    { ...options, completedBehavior: "full" },
    false,
    80,
    1,
    { timing: { startedAt: 1_000, completedAt: 2_000 } },
  );

  assert.equal(thinkingText(streaming), "Thinking 2.5s  (ctrl+t to expand)");
  assert.equal(thinkingText(full), "Thought for 1.0s\none\ntwo\nthree\nfour");
});

test("automatic completion collapses traces and summaries", () => {
  const trace = assistant("one\ntwo\nthree\nfour");
  const summary = assistant("Checking the implementation", "openai-responses");
  const completed: ThinkingDisplayState = {
    timing: { startedAt: 1_000, completedAt: 4_780 },
    now: 5_000,
  };
  const collapsedTrace = createThinkingDisplayMessage(trace, options, false, 80, 1, completed);
  const collapsedSummary = createThinkingDisplayMessage(summary, options, false, 80, 1, completed);
  assert.equal(thinkingText(collapsedTrace), "Thought for 3.8s  (ctrl+t to expand)");
  assert.equal(thinkingText(collapsedSummary), "Thought for 3.8s  (ctrl+t to expand)");
  assert.equal(createThinkingDisplayMessage(trace, options, true, 80, 1, completed), trace);
  assert.equal(formatThinkingSeconds(-100), "0.0s");
});

test("component patch times, folds, preserves expansion across turns, and restores", () => {
  const originalUpdate = AssistantMessageComponent.prototype.updateContent;
  const originalRender = AssistantMessageComponent.prototype.render;
  const patch = installThinkingFoldPatch(options);
  const source = assistant(Array.from({ length: 8 }, (_, index) => `step ${index + 1}`).join("\n"));

  try {
    patch.beginMessage(source, 1_000);
    const component = new AssistantMessageComponent(source);
    patch.tick(3_400);
    const streaming = stripVTControlCharacters(component.render(80).join("\n"));
    assert.match(streaming, /Thinking 2\.4s/);
    assert.doesNotMatch(streaming, /step 1(?:\n|$)/);
    assert.match(streaming, /step 8/);

    patch.setExpanded(true);
    patch.completeMessage(source, 4_700);
    patch.completeMessage(source, 14_700); // Late provider thinking_end must not include answer output.
    assert.equal(patch.expanded, true, "an explicit expansion survives completion");
    const expanded = stripVTControlCharacters(component.render(80).join("\n"));
    assert.match(expanded, /step 1/);
    assert.match(expanded, /step 8/);

    const nextSource = assistant("next step 1\nnext step 2", "openai-completions", "next answer", 2_000);
    patch.beginMessage(nextSource, 5_000);
    const nextComponent = new AssistantMessageComponent(nextSource);
    patch.completeMessage(nextSource, 6_000);
    assert.equal(patch.expanded, true, "Ctrl+T expansion persists into the next turn");
    assert.match(stripVTControlCharacters(nextComponent.render(80).join("\n")), /next step 1/);

    patch.setExpanded(false);
    const completed = stripVTControlCharacters(component.render(80).join("\n"));
    assert.match(completed, /Thought for 3\.7s/);
    assert.doesNotMatch(completed, /step 8/);
  } finally {
    patch.dispose();
  }

  assert.equal(AssistantMessageComponent.prototype.updateContent, originalUpdate);
  assert.equal(AssistantMessageComponent.prototype.render, originalRender);
});

test("completed preview keeps a truncated tail", () => {
  const disabledOptions = { ...options, completedBehavior: "preview" as const };
  const source = assistant("one\ntwo\nthree\nfour");
  const display = createThinkingDisplayMessage(source, disabledOptions, false, 80, 1, {
    timing: { startedAt: 1_000, completedAt: 2_000 },
  });
  assert.match(thinkingText(display), /^Thought for 1\.0s/);
  assert.match(thinkingText(display), /two\nthree\nfour$/);

  const patch = installThinkingFoldPatch(disabledOptions);
  try {
    patch.beginMessage(source, 1_000);
    patch.setExpanded(true);
    patch.completeMessage(source, 2_000);
    assert.equal(patch.expanded, true);
  } finally {
    patch.dispose();
  }
});

test("Pi 0.85 mouse-wrapped thinking folds and shares the keyboard expansion state", () => {
  // Exercise the new layout even when CI installs Pi 0.83.
  class MouseRegionFixture implements Component {
    constructor(public child: Component) {}
    render(width: number) { return this.child.render(width); }
    invalidate() { this.child.invalidate(); }
    handleMouse(_event: { type: string; button?: string }): { handled: true } | undefined {
      throw new Error("native visibility toggle must not fight thinking-fold");
    }
  }
  type Internals = {
    contentContainer: { children: Component[] };
    thinkingVisibilityOverrides: Map<number, boolean>;
  };
  const prototype = AssistantMessageComponent.prototype;
  const original = prototype.updateContent;
  prototype.updateContent = function (message) {
    original.call(this, message);
    const children = (this as unknown as Internals).contentContainer.children;
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (child instanceof Markdown &&
          (child as unknown as { defaultTextStyle?: { italic?: boolean } }).defaultTextStyle?.italic) {
        children[index] = new MouseRegionFixture(child);
      }
    }
  };
  const patch = installThinkingFoldPatch(options);
  const source = assistant("one\ntwo\nthree\nfour", "openai-completions", "answer");
  try {
    patch.beginMessage(source, 1_000);
    const component = new AssistantMessageComponent(source, true);
    const internals = component as unknown as Internals;
    const overrides = new Map([[0, true]]);
    internals.thinkingVisibilityOverrides = overrides;
    patch.tick(2_000);
    assert.equal(internals.thinkingVisibilityOverrides, overrides);
    const folded = renderAssistantLines(component).join("\n");
    assert.match(folded, /Thinking 1\.0s/);
    assert.doesNotMatch(folded, /\bone\b|thinking-fold:/);
    assert.match(folded, /four/);
    const click = () => {
      const region = internals.contentContainer.children.find(
        (child) => typeof (child as MouseRegionFixture).handleMouse === "function",
      ) as MouseRegionFixture;
      assert.ok(region);
      assert.equal(region.handleMouse({ type: "move" }), undefined);
      assert.deepEqual(region.handleMouse({ type: "click", button: "left" }), { handled: true });
    };
    click();
    assert.equal(patch.expanded, true);
    assert.match(renderAssistantLines(component).join("\n"), /one/);
    click();
    assert.equal(patch.expanded, false);
    component.invalidate();
    assert.equal(renderAssistantLines(component).join("\n"), folded);
    patch.completeMessage(source, 3_000);
    assert.match(renderAssistantLines(component).join("\n"), /Thought for 2\.0s/);
    assert.equal(thinkingText(source), "one\ntwo\nthree\nfour");
  } finally {
    patch.dispose();
    prototype.updateContent = original;
  }
});

test("streaming flag survives native updates, timer ticks, toggles, and invalidation", () => {
  const prototype = AssistantMessageComponent.prototype;
  const original = prototype.updateContent;
  const flags: Array<boolean | undefined> = [];
  prototype.updateContent = function (message, isStreaming?: boolean) {
    flags.push(isStreaming);
    (original as (message: AssistantMessage, isStreaming?: boolean) => void).call(this, message, isStreaming);
  };
  const patch = installThinkingFoldPatch(options);
  try {
    const source = assistant("one\ntwo\nthree\nfour");
    const component = new AssistantMessageComponent(source);
    const update = component.updateContent as (message: AssistantMessage, isStreaming?: boolean) => void;
    update.call(component, source, true);
    patch.tick();
    patch.toggle();
    component.invalidate();
    assert.deepEqual(flags.slice(-4), [true, true, true, true]);
    update.call(component, source, false);
    patch.toggle();
    component.invalidate();
    assert.deepEqual(flags.slice(-3), [false, false, false]);
  } finally {
    patch.dispose();
    prototype.updateContent = original;
  }
});

test("disposing restores native content instead of retaining markers and mouse callbacks", () => {
  const source = assistant("one\ntwo\nthree\nfour");
  const native = renderAssistantLines(new AssistantMessageComponent(source));
  const patch = installThinkingFoldPatch(options);
  let component: AssistantMessageComponent;
  try {
    component = new AssistantMessageComponent(source);
    assert.notDeepEqual(renderAssistantLines(component), native);
  } finally {
    patch.dispose();
  }
  assert.deepEqual(renderAssistantLines(component!), native);
  component!.invalidate();
  assert.deepEqual(renderAssistantLines(component!), native);
});

test("Pi markdown transformers receive the streaming flag and original thinking text", (t) => {
  if (!("markdownTransformers" in new AssistantMessageComponent())) {
    t.skip("This Pi version predates markdown transformers");
    return;
  }
  type TransformContext = { messageType: string; isStreaming: boolean; availableWidth: number };
  type Transformer = (markdown: string, context: TransformContext) => string;
  const NativeComponent = AssistantMessageComponent as unknown as new (
    message: AssistantMessage | undefined, hide: boolean, theme: ReturnType<typeof getMarkdownTheme>,
    label: string, pad: number, transformers: Transformer[],
  ) => AssistantMessageComponent;
  const seen: Array<{ markdown: string; context: TransformContext }> = [];
  const patch = installThinkingFoldPatch(options);
  try {
    const source = assistant("one\ntwo\nthree\nfour");
    const component = new NativeComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [
      (markdown, context) => {
        seen.push({ markdown, context });
        return markdown.replace("four", "transformed tail");
      },
    ]);
    const update = component.updateContent as (message: AssistantMessage, isStreaming?: boolean) => void;
    update.call(component, source, true);
    assert.match(renderAssistantLines(component).join("\n"), /transformed tail/);
    const thinking = seen.find((item) => item.markdown === thinkingText(source));
    assert.equal(thinking?.context.messageType, "assistant-thinking");
    assert.equal(thinking?.context.isStreaming, true);
    assert.equal(thinking?.context.availableWidth, 78);
    assert.ok(seen.every((item) => !item.markdown.includes("thinking-fold:")));
    seen.length = 0;
    update.call(component, source, false);
    component.render(40);
    assert.ok(seen.length > 0);
    assert.ok(seen.every((item) => item.context.isStreaming === false));
  } finally {
    patch.dispose();
  }
});

test("patch acquisition is idempotent", () => {
  const originalUpdate = AssistantMessageComponent.prototype.updateContent;
  const first = installThinkingFoldPatch(options);
  const patchedUpdate = AssistantMessageComponent.prototype.updateContent;
  const second = installThinkingFoldPatch({ previewLines: 4 });

  assert.equal(AssistantMessageComponent.prototype.updateContent, patchedUpdate);
  assert.equal(second.options.previewLines, 4);

  first.dispose();
  assert.equal(AssistantMessageComponent.prototype.updateContent, patchedUpdate);
  second.dispose();
  assert.equal(AssistantMessageComponent.prototype.updateContent, originalUpdate);
});

test("global config normalizes, saves, and reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-thinking-fold-"));
  const path = join(directory, "99extensions.json");
  try {
    assert.deepEqual(normalizeThinkingFoldConfig({ foldThreshold: 999 }), {
      ...DEFAULT_THINKING_FOLD_CONFIG,
    });
    assert.deepEqual(normalizeThinkingFoldConfig({ previewLines: 8, autoCollapse: false }), {
      foldThreshold: 8,
      streamingBehavior: "auto",
      completedBehavior: "preview",
    });
    assert.deepEqual(normalizeThinkingFoldConfig({ autoCollapse: true }), {
      foldThreshold: 5,
      streamingBehavior: "auto",
      completedBehavior: "collapse",
    });

    const config = {
      foldThreshold: 8,
      streamingBehavior: "collapse" as const,
      completedBehavior: "full" as const,
    };
    saveThinkingFoldConfig(config, path);
    assert.deepEqual(loadThinkingFoldConfig(path), config);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      "thinking-fold": config,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
