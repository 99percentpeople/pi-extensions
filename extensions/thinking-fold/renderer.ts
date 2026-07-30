import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { resolveConfiguredThinkingBehavior } from "./model-behaviors.ts";

export type ThinkingFoldMode = "auto" | "trace" | "summary";
export type ThinkingStreamingBehavior = "auto" | "preview" | "collapse";
export type ThinkingCompletedBehavior = "auto" | "collapse" | "preview" | "full";
type EffectiveThinkingDisplayBehavior = Exclude<ThinkingCompletedBehavior, "auto">;

export interface ThinkingFoldOptions {
  mode: ThinkingFoldMode;
  previewLines: number;
  streamingBehavior: ThinkingStreamingBehavior;
  completedBehavior: ThinkingCompletedBehavior;
  /** @deprecated Use completedBehavior instead. */
  autoCollapse?: boolean;
  toggleKey: string;
}

export interface ThinkingTiming {
  startedAt: number;
  completedAt?: number;
}

export interface ThinkingDisplayState {
  timing?: ThinkingTiming;
  now?: number;
}

export const DEFAULT_THINKING_CURSOR_LABEL = "Thinking...";

export const DEFAULT_THINKING_FOLD_OPTIONS: ThinkingFoldOptions = {
  mode: "auto",
  previewLines: 5,
  streamingBehavior: "auto",
  completedBehavior: "auto",
  toggleKey: "ctrl+t",
};

interface ComponentState {
  fullMessage?: AssistantMessage;
  renderedMessage?: AssistantMessage;
  width?: number;
  dirty: boolean;
}

interface AssistantMessageInternals {
  hideThinkingBlock?: boolean;
  outputPad?: number;
}

interface PatchRecord {
  owners: number;
  expanded: boolean;
  now: number;
  options: ThinkingFoldOptions;
  originalUpdate: AssistantMessageComponent["updateContent"];
  originalRender: AssistantMessageComponent["render"];
  states: WeakMap<AssistantMessageComponent, ComponentState>;
  components: Set<WeakRef<AssistantMessageComponent>>;
  knownComponents: WeakSet<AssistantMessageComponent>;
  timings: Map<number, ThinkingTiming>;
  updateOptions(options: Partial<ThinkingFoldOptions>): void;
  setExpanded(expanded: boolean): void;
  setMessageTiming(timestamp: number, timing: ThinkingTiming): void;
  beginMessage(message: AssistantMessage, startedAt?: number): void;
  completeMessage(message: AssistantMessage, completedAt?: number): void;
  tick(now?: number): void;
  rerenderAll(): void;
  rerenderTimestamp(timestamp: number): void;
}

export interface ThinkingFoldPatchHandle {
  readonly expanded: boolean;
  readonly options: ThinkingFoldOptions;
  updateOptions(options: Partial<ThinkingFoldOptions>): void;
  setExpanded(expanded: boolean): void;
  toggle(): void;
  setMessageTiming(timestamp: number, timing: ThinkingTiming): void;
  beginMessage(message: AssistantMessage, startedAt?: number): void;
  completeMessage(message: AssistantMessage, completedAt?: number): void;
  tick(now?: number): void;
  dispose(): void;
}

const PATCH_SYMBOL = Symbol.for("@99percentpeople/pi-thinking-fold/assistant-message-patch");

function normalizedOptions(options: Partial<ThinkingFoldOptions>): ThinkingFoldOptions {
  const previewLines = options.previewLines ?? DEFAULT_THINKING_FOLD_OPTIONS.previewLines;
  const completedBehavior =
    options.completedBehavior === "auto" ||
    options.completedBehavior === "collapse" ||
    options.completedBehavior === "preview" ||
    options.completedBehavior === "full"
      ? options.completedBehavior
      : options.autoCollapse === false
        ? "preview"
        : options.autoCollapse === true
          ? "collapse"
          : DEFAULT_THINKING_FOLD_OPTIONS.completedBehavior;
  return {
    mode: options.mode ?? DEFAULT_THINKING_FOLD_OPTIONS.mode,
    previewLines:
      Number.isInteger(previewLines) && previewLines > 0
        ? previewLines
        : DEFAULT_THINKING_FOLD_OPTIONS.previewLines,
    streamingBehavior:
      options.streamingBehavior === "auto" ||
      options.streamingBehavior === "collapse" ||
      options.streamingBehavior === "preview"
        ? options.streamingBehavior
        : DEFAULT_THINKING_FOLD_OPTIONS.streamingBehavior,
    completedBehavior,
    toggleKey: options.toggleKey?.trim() || DEFAULT_THINKING_FOLD_OPTIONS.toggleKey,
  };
}

function cleanSummaryHeadline(value: string): string {
  const cleaned = value
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\*\*(.*?)\*\*$/, "$1")
    .replace(/^__(.*?)__$/, "$1")
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).length > 96
    ? `${Array.from(cleaned).slice(0, 95).join("")}…`
    : cleaned;
}

function latestSummaryHeadlineFromText(text: string): string | undefined {
  const boldHeadings = [...text.matchAll(/^\s*\*\*(.+?)\*\*\s*$/gm)];
  const boldHeadline = boldHeadings.at(-1)?.[1];
  if (boldHeadline?.trim()) return cleanSummaryHeadline(boldHeadline);

  const latestParagraph = text
    .trim()
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.trim())
    .at(-1);
  const latestLine = latestParagraph
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const headline = latestLine ? cleanSummaryHeadline(latestLine) : "";
  return headline || undefined;
}

export function extractLatestSummaryHeadline(message: AssistantMessage): string | undefined {
  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    const block = message.content[index];
    if (block?.type !== "thinking" || !block.thinking.trim()) continue;
    return latestSummaryHeadlineFromText(block.thinking);
  }
  return undefined;
}

export function resolveThinkingBehavior(
  message: AssistantMessage,
  mode: ThinkingFoldMode,
): Exclude<ThinkingFoldMode, "auto"> {
  if (mode !== "auto") return mode;

  return resolveConfiguredThinkingBehavior(message) ?? "trace";
}

export function resolveThinkingDisplayBehavior(
  message: AssistantMessage,
  options: Pick<
    ThinkingFoldOptions,
    "mode" | "streamingBehavior" | "completedBehavior"
  >,
  completed: boolean,
): EffectiveThinkingDisplayBehavior {
  if (completed) {
    return options.completedBehavior === "auto" ? "collapse" : options.completedBehavior;
  }
  if (options.streamingBehavior !== "auto") return options.streamingBehavior;
  return resolveThinkingBehavior(message, options.mode) === "summary" ? "collapse" : "preview";
}

export function formatThinkingSeconds(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
}

export function formatStreamingThinkingSeconds(milliseconds: number): string {
  return `${Math.floor(Math.max(0, milliseconds) / 1000)}s`;
}

export function createThinkingCursorLabel(
  message: AssistantMessage,
  mode: ThinkingFoldMode,
): string {
  const headline =
    resolveThinkingBehavior(message, mode) === "summary"
      ? extractLatestSummaryHeadline(message)
      : undefined;
  return headline ?? DEFAULT_THINKING_CURSOR_LABEL;
}

function foldThinkingText(
  text: string,
  previewLines: number,
  width: number,
  outputPad: number,
): string {
  const availableWidth = Math.max(10, width - outputPad * 2);
  const result = truncateToVisualLines(text, previewLines, availableWidth);
  return result.visualLines.map((line) => line.trimEnd()).join("\n");
}

function hasFoldedThinkingContent(
  message: AssistantMessage,
  previewLines: number,
  width: number,
  outputPad: number,
): boolean {
  const availableWidth = Math.max(10, width - outputPad * 2);
  return message.content.some(
    (block) =>
      block.type === "thinking" &&
      truncateToVisualLines(block.thinking, previewLines, availableWidth).skippedCount > 0,
  );
}

function createStreamingThinkingLabel(
  options: ThinkingFoldOptions,
  timing: ThinkingTiming | undefined,
  now: number,
  canExpand: boolean,
): string {
  const duration = timing ? formatThinkingSeconds(now - timing.startedAt) : "0.0s";
  return `Thinking ${duration}${canExpand ? `  (${options.toggleKey} to expand)` : ""}`;
}

function createCompletedThinkingLabel(
  options: ThinkingFoldOptions,
  timing: ThinkingTiming,
  canExpand: boolean,
): string {
  const duration = formatThinkingSeconds(timing.completedAt! - timing.startedAt);
  return `Thought for ${duration}${canExpand ? `  (${options.toggleKey} to expand)` : ""}`;
}

export function createThinkingDisplayMessage(
  message: AssistantMessage,
  options: ThinkingFoldOptions,
  expanded: boolean,
  width: number,
  outputPad = 1,
  display: ThinkingDisplayState = {},
): AssistantMessage {
  if (expanded) return message;

  const firstThinkingIndex = message.content.findIndex((block) => block.type === "thinking");
  if (firstThinkingIndex === -1) return message;

  const timing = display.timing;
  const completed = timing?.completedAt !== undefined;
  const displayBehavior = resolveThinkingDisplayBehavior(message, options, completed);
  const hasThinkingContent = message.content.some(
    (block) => block.type === "thinking" && block.thinking.trim(),
  );
  const canExpand =
    displayBehavior === "collapse"
      ? hasThinkingContent
      : displayBehavior === "preview" &&
        hasFoldedThinkingContent(message, options.previewLines, width, outputPad);
  const label =
    completed && timing
      ? createCompletedThinkingLabel(options, timing, canExpand)
      : createStreamingThinkingLabel(options, timing, display.now ?? Date.now(), canExpand);
  let changed = false;
  const content = message.content.map((block, index) => {
    if (block.type !== "thinking") return block;

    const visibleThinking =
      displayBehavior === "collapse"
        ? ""
        : displayBehavior === "preview"
          ? foldThinkingText(block.thinking, options.previewLines, width, outputPad)
          : block.thinking;
    const thinking =
      index === firstThinkingIndex
        ? visibleThinking
          ? `${label}\n${visibleThinking}`
          : label
        : visibleThinking;

    if (thinking === block.thinking) return block;
    changed = true;
    return { ...block, thinking };
  });

  return changed ? { ...message, content } : message;
}

function getPatchRecord(): PatchRecord | undefined {
  return (AssistantMessageComponent.prototype as unknown as Record<PropertyKey, unknown>)[
    PATCH_SYMBOL
  ] as PatchRecord | undefined;
}

function setPatchRecord(record: PatchRecord | undefined): void {
  const prototype = AssistantMessageComponent.prototype as unknown as Record<PropertyKey, unknown>;
  if (record) prototype[PATCH_SYMBOL] = record;
  else delete prototype[PATCH_SYMBOL];
}

function rebuild(
  component: AssistantMessageComponent,
  state: ComponentState,
  record: PatchRecord,
): void {
  if (!state.fullMessage) return;

  const internals = component as unknown as AssistantMessageInternals;
  const width = state.width ?? 120;
  const outputPad = internals.outputPad ?? 1;
  const renderedMessage = createThinkingDisplayMessage(
    state.fullMessage,
    record.options,
    record.expanded,
    width,
    outputPad,
    { timing: record.timings.get(state.fullMessage.timestamp), now: record.now },
  );

  state.renderedMessage = renderedMessage;
  state.dirty = false;

  // Pi's native hidden mode replaces thinking with a static label. The plugin
  // temporarily disables that branch and gives the native renderer a display-only
  // message, while preserving Pi's setting and the original session message.
  const nativeHidden = internals.hideThinkingBlock;
  internals.hideThinkingBlock = false;
  try {
    record.originalUpdate.call(component, renderedMessage);
  } finally {
    internals.hideThinkingBlock = nativeHidden;
  }
}

function forEachLiveComponent(
  record: PatchRecord,
  callback: (component: AssistantMessageComponent, state: ComponentState) => void,
): void {
  for (const reference of record.components) {
    const component = reference.deref();
    if (!component) {
      record.components.delete(reference);
      continue;
    }
    const state = record.states.get(component);
    if (state) callback(component, state);
  }
}

function createPatchRecord(options: Partial<ThinkingFoldOptions>): PatchRecord {
  const prototype = AssistantMessageComponent.prototype;
  const originalUpdate = prototype.updateContent;
  const originalRender = prototype.render;
  const record: PatchRecord = {
    owners: 0,
    expanded: false,
    now: Date.now(),
    options: normalizedOptions(options),
    originalUpdate,
    originalRender,
    states: new WeakMap(),
    components: new Set(),
    knownComponents: new WeakSet(),
    timings: new Map(),
    updateOptions(next) {
      this.options = normalizedOptions({ ...this.options, ...next });
      this.rerenderAll();
    },
    setExpanded(expanded) {
      if (this.expanded === expanded) return;
      this.expanded = expanded;
      this.rerenderAll();
    },
    setMessageTiming(timestamp, timing) {
      this.timings.set(timestamp, { ...timing });
      this.rerenderTimestamp(timestamp);
    },
    beginMessage(message, startedAt = Date.now()) {
      this.timings.set(message.timestamp, { startedAt });
      this.now = startedAt;
      this.rerenderTimestamp(message.timestamp);
    },
    completeMessage(message, completedAt = Date.now()) {
      const timing = this.timings.get(message.timestamp) ?? {
        startedAt: Math.min(message.timestamp, completedAt),
      };
      if (timing.completedAt !== undefined) return;
      this.timings.set(message.timestamp, { ...timing, completedAt });
      this.now = completedAt;
      // Ctrl+T is a persistent global display preference. Auto-collapse only
      // controls the folded representation; completing a later turn must not
      // override an explicit expanded choice.
      this.rerenderTimestamp(message.timestamp);
    },
    tick(now = Date.now()) {
      this.now = now;
      forEachLiveComponent(this, (component, state) => {
        const timestamp = state.fullMessage?.timestamp;
        if (timestamp === undefined || this.timings.get(timestamp)?.completedAt !== undefined) return;
        state.dirty = true;
        rebuild(component, state, this);
      });
    },
    rerenderAll() {
      forEachLiveComponent(this, (component, state) => {
        state.dirty = true;
        rebuild(component, state, this);
      });
    },
    rerenderTimestamp(timestamp) {
      forEachLiveComponent(this, (component, state) => {
        if (state.fullMessage?.timestamp !== timestamp) return;
        state.dirty = true;
        rebuild(component, state, this);
      });
    },
  };

  prototype.updateContent = function (message: AssistantMessage): void {
    const state = record.states.get(this) ?? { dirty: true };

    // Container.invalidate() passes Pi's last rendered message back through
    // updateContent(). Do not mistake that display-only clone for source data.
    if (message !== state.renderedMessage) {
      state.fullMessage = message;
      state.dirty = true;
    }

    record.states.set(this, state);
    if (!record.knownComponents.has(this)) {
      record.knownComponents.add(this);
      record.components.add(new WeakRef(this));
    }
    rebuild(this, state, record);
  };

  prototype.render = function (width: number): string[] {
    const state = record.states.get(this);
    if (state && (state.width !== width || state.dirty)) {
      state.width = width;
      rebuild(this, state, record);
    }
    return originalRender.call(this, width);
  };

  setPatchRecord(record);
  return record;
}

export function installThinkingFoldPatch(
  options: Partial<ThinkingFoldOptions> = {},
): ThinkingFoldPatchHandle {
  const prototype = AssistantMessageComponent.prototype;
  if (typeof prototype.updateContent !== "function" || typeof prototype.render !== "function") {
    throw new Error("Pi's AssistantMessageComponent rendering API is unavailable");
  }

  const record = getPatchRecord() ?? createPatchRecord(options);
  record.owners += 1;
  record.updateOptions(options);
  let disposed = false;

  return {
    get expanded() {
      return record.expanded;
    },
    get options() {
      return { ...record.options };
    },
    updateOptions(next) {
      record.updateOptions(next);
    },
    setExpanded(expanded) {
      record.setExpanded(expanded);
    },
    toggle() {
      record.setExpanded(!record.expanded);
    },
    setMessageTiming(timestamp, timing) {
      record.setMessageTiming(timestamp, timing);
    },
    beginMessage(message, startedAt) {
      record.beginMessage(message, startedAt);
    },
    completeMessage(message, completedAt) {
      record.completeMessage(message, completedAt);
    },
    tick(now) {
      record.tick(now);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      record.owners -= 1;
      if (record.owners > 0 || getPatchRecord() !== record) return;

      prototype.updateContent = record.originalUpdate;
      prototype.render = record.originalRender;
      setPatchRecord(undefined);
    },
  };
}
