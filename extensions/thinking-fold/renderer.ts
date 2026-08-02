import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  type Component,
  type DefaultTextStyle,
  type MarkdownOptions,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
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
}

interface AssistantMessageInternals {
  contentContainer?: { children?: Component[] };
  hideThinkingBlock?: boolean;
}

interface MarkdownInternals {
  text?: string;
  paddingX?: number;
  paddingY?: number;
  defaultTextStyle?: DefaultTextStyle;
  theme?: MarkdownTheme;
  options?: MarkdownOptions;
}

interface PatchRecord {
  owners: number;
  expanded: boolean;
  now: number;
  options: ThinkingFoldOptions;
  originalUpdate: AssistantMessageComponent["updateContent"];
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
  const stableText = text
    .replace(/\r\n|\r/g, "\n")
    .replace(/\t/g, "   ")
    .replace(/\n+$/, "");
  const result = truncateToVisualLines(stableText, previewLines, availableWidth);
  return result.visualLines.map((line) => line.trimEnd()).join("\n").replace(/\n+$/, "");
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

interface NativeThinkingRun {
  start: number;
  end: number;
  text: string;
}

interface MarkedThinkingSection {
  marker: string;
  text: string;
  showLabel: boolean;
}

interface MarkedThinkingMessage {
  message: AssistantMessage;
  sections: MarkedThinkingSection[];
}

/**
 * Shared render state for all thinking sections in one assistant message.
 * Every section is rendered first; only then do we decide whether content is
 * actually hidden and whether the expansion hint belongs in the header.
 */
class RenderedThinkingContext {
  readonly sections: RenderedThinkingSection[] = [];
  canExpand = false;
  private preparedWidth?: number;

  constructor(
    readonly behavior: EffectiveThinkingDisplayBehavior,
    readonly previewLines: number,
    readonly collapseCanExpand: boolean,
    readonly labelFor: (canExpand: boolean) => string,
  ) {}

  add(section: RenderedThinkingSection): void {
    this.sections.push(section);
  }

  prepare(width: number): void {
    if (this.preparedWidth === width) return;
    for (const section of this.sections) section.prepare(width);
    this.canExpand =
      this.behavior === "collapse"
        ? this.collapseCanExpand
        : this.behavior === "preview"
          ? this.sections.some((section) => section.renderedLineCount > this.previewLines)
          : false;
    this.preparedWidth = width;
  }

  invalidate(): void {
    this.preparedWidth = undefined;
  }
}

/** Render Pi's native Markdown first, then retain its final terminal rows. */
class RenderedThinkingSection implements Component {
  private fullLines: string[] = [];
  private preparedWidth?: number;
  private labelText?: string;

  constructor(
    private readonly content: Markdown,
    private readonly label: Markdown | undefined,
    private readonly context: RenderedThinkingContext,
  ) {
    context.add(this);
  }

  get renderedLineCount(): number {
    return this.fullLines.length;
  }

  prepare(width: number): void {
    if (this.preparedWidth === width) return;
    this.fullLines = this.content.render(width);
    this.preparedWidth = width;
  }

  render(width: number): string[] {
    this.context.prepare(width);
    const contentLines =
      this.context.behavior === "collapse"
        ? []
        : this.context.behavior === "preview"
          ? this.fullLines.slice(-this.context.previewLines)
          : this.fullLines;
    if (!this.label) return contentLines;

    const labelText = this.context.labelFor(this.context.canExpand);
    if (labelText !== this.labelText) {
      this.label.setText(labelText);
      this.labelText = labelText;
    }
    return [...this.label.render(width), ...contentLines];
  }

  invalidate(): void {
    this.content.invalidate();
    this.label?.invalidate();
    this.preparedWidth = undefined;
    this.context.invalidate();
  }
}

function collectThinkingRuns(message: AssistantMessage): NativeThinkingRun[] {
  const runs: NativeThinkingRun[] = [];
  let index = 0;
  while (index < message.content.length) {
    const block = message.content[index];
    if (!block || block.type !== "thinking") {
      index++;
      continue;
    }

    const start = index;
    const fragments: string[] = [];
    while (index < message.content.length) {
      const thinkingBlock = message.content[index];
      if (!thinkingBlock || thinkingBlock.type !== "thinking") break;
      const text = thinkingBlock.thinking.trim();
      if (text) fragments.push(text);
      index++;
    }
    runs.push({ start, end: index, text: fragments.join("\n\n") });
  }
  return runs;
}

function createMarkedThinkingMessage(
  message: AssistantMessage,
  behavior: EffectiveThinkingDisplayBehavior,
): MarkedThinkingMessage | undefined {
  const runs = collectThinkingRuns(message);
  const firstRun = runs[0];
  if (!firstRun) return undefined;

  const content = [...message.content];
  const sections: MarkedThinkingSection[] = [];
  const clearRun = (run: NativeThinkingRun) => {
    for (let index = run.start; index < run.end; index++) {
      const block = content[index];
      if (block?.type === "thinking") content[index] = { ...block, thinking: "" };
    }
  };
  const markRun = (run: NativeThinkingRun, runIndex: number, showLabel: boolean) => {
    clearRun(run);
    const block = content[run.start];
    if (!block || block.type !== "thinking") return;
    const marker = `\uE000thinking-fold:${message.timestamp}:${runIndex}\uE001`;
    content[run.start] = { ...block, thinking: marker };
    sections.push({ marker, text: run.text, showLabel });
  };

  if (behavior === "collapse") {
    for (const run of runs) clearRun(run);
    markRun(firstRun, 0, true);
  } else if (behavior === "preview") {
    for (const run of runs) clearRun(run);
    runs.forEach((run, runIndex) => {
      if (runIndex === 0 || run.text) markRun(run, runIndex, runIndex === 0);
    });
  } else {
    markRun(firstRun, 0, true);
  }

  return { message: { ...message, content }, sections };
}

function getMarkdownInternals(component: Component): MarkdownInternals | undefined {
  if (!(component instanceof Markdown)) return undefined;
  const internals = component as unknown as MarkdownInternals;
  return typeof internals.text === "string" &&
    typeof internals.paddingX === "number" &&
    typeof internals.paddingY === "number" &&
    internals.theme
    ? internals
    : undefined;
}

function cloneNativeMarkdown(component: Component, text: string): Markdown | undefined {
  const internals = getMarkdownInternals(component);
  if (!internals?.theme || internals.paddingX === undefined || internals.paddingY === undefined) {
    return undefined;
  }
  return new Markdown(
    text,
    internals.paddingX,
    internals.paddingY,
    internals.theme,
    internals.defaultTextStyle,
    internals.options,
  );
}

function replaceMarkedThinkingSections(
  component: AssistantMessageComponent,
  marked: MarkedThinkingMessage,
  behavior: EffectiveThinkingDisplayBehavior,
  previewLines: number,
  collapseCanExpand: boolean,
  labelFor: (canExpand: boolean) => string,
): boolean {
  const internals = component as unknown as AssistantMessageInternals;
  const children = internals.contentContainer?.children;
  if (!children) return false;

  const pending = new Map(marked.sections.map((section) => [section.marker, section]));
  const context = new RenderedThinkingContext(
    behavior,
    previewLines,
    collapseCanExpand,
    labelFor,
  );
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (!child) continue;
    const markdown = getMarkdownInternals(child);
    const section = markdown?.text ? pending.get(markdown.text) : undefined;
    if (!section) continue;

    const content = cloneNativeMarkdown(child, section.text);
    const label = section.showLabel ? cloneNativeMarkdown(child, "") : undefined;
    if (!content || (section.showLabel && !label)) return false;
    children[index] = new RenderedThinkingSection(content, label, context);
    pending.delete(section.marker);
  }
  return pending.size === 0;
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

/**
 * @deprecated Preview folding now happens after native Markdown rendering and
 * cannot be represented faithfully as an AssistantMessage. Use
 * installThinkingFoldPatch() for the TUI behavior; this source-level helper is
 * retained for compatibility with existing consumers.
 */
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
  const message = state.fullMessage;
  if (!message) return;

  const internals = component as unknown as AssistantMessageInternals;
  const nativeHidden = internals.hideThinkingBlock;
  internals.hideThinkingBlock = false;
  try {
    if (record.expanded || !message.content.some((block) => block.type === "thinking")) {
      state.renderedMessage = message;
      record.originalUpdate.call(component, message);
      return;
    }

    const timing = record.timings.get(message.timestamp);
    const completed = timing?.completedAt !== undefined;
    const behavior = resolveThinkingDisplayBehavior(message, record.options, completed);
    const marked = createMarkedThinkingMessage(message, behavior);
    if (!marked) {
      state.renderedMessage = message;
      record.originalUpdate.call(component, message);
      return;
    }

    const hasThinkingContent = message.content.some(
      (block) => block.type === "thinking" && block.thinking.trim(),
    );
    const labelFor = (canExpand: boolean) =>
      completed && timing
        ? createCompletedThinkingLabel(record.options, timing, canExpand)
        : createStreamingThinkingLabel(record.options, timing, record.now, canExpand);

    state.renderedMessage = marked.message;
    record.originalUpdate.call(component, marked.message);
    const replaced = replaceMarkedThinkingSections(
      component,
      marked,
      behavior,
      record.options.previewLines,
      hasThinkingContent,
      labelFor,
    );
    if (!replaced) {
      // Pi changed its internal child layout. Never leak markers or damage the
      // message: fall back to the complete native rendering for this component.
      state.renderedMessage = message;
      record.originalUpdate.call(component, message);
    }
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
  const record: PatchRecord = {
    owners: 0,
    expanded: false,
    now: Date.now(),
    options: normalizedOptions(options),
    originalUpdate,
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
        rebuild(component, state, this);
      });
    },
    rerenderAll() {
      forEachLiveComponent(this, (component, state) => rebuild(component, state, this));
    },
    rerenderTimestamp(timestamp) {
      forEachLiveComponent(this, (component, state) => {
        if (state.fullMessage?.timestamp === timestamp) rebuild(component, state, this);
      });
    },
  };

  prototype.updateContent = function (message: AssistantMessage): void {
    const state = record.states.get(this) ?? {};

    // Container.invalidate() passes Pi's last display-only marker clone back
    // through updateContent(). Never mistake that clone for session source data.
    if (message !== state.renderedMessage) state.fullMessage = message;

    record.states.set(this, state);
    if (!record.knownComponents.has(this)) {
      record.knownComponents.add(this);
      record.components.add(new WeakRef(this));
    }
    rebuild(this, state, record);
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
      setPatchRecord(undefined);
    },
  };
}
