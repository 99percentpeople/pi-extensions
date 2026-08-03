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
import { Markdown } from "@earendil-works/pi-tui";
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
