import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IPty } from "node-pty";
import backgroundTasks from "../extensions/background-tasks/index.ts";

interface RegisteredTool {
  name: string;
  promptGuidelines?: string[];
  parameters: {
    properties?: Record<string, { minimum?: number; maximum?: number }>;
  };
  executionMode?: string;
  execute: (...args: any[]) => Promise<any>;
  renderCall?: (...args: any[]) => any;
  renderResult?: (...args: any[]) => any;
}

interface SentMessage {
  message: { customType: string; content: string; details?: unknown };
  options?: { deliverAs?: string; triggerTurn?: boolean };
}

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private closed = false;

  constructor(readonly pid: number) {
    super();
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", code, signal));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.finish(null, signal);
    return true;
  }
}

class FakePty {
  readonly process = "fake";
  readonly writes: Array<string | Buffer> = [];
  readonly onDataListeners = new Set<(data: string) => void>();
  readonly onExitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  handleFlowControl = false;
  closed = false;

  constructor(readonly pid: number, public cols: number, public rows: number) {}

  onData(listener: (data: string) => void) {
    this.onDataListeners.add(listener);
    return { dispose: () => this.onDataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.onExitListeners.add(listener);
    return { dispose: () => this.onExitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.onDataListeners) listener(data);
  }

  write(data: string | Buffer): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  clear(): void {}
  pause(): void {}
  resume(): void {}

  kill(signal?: string): void {
    this.finish(signal ? 1 : 0, signal ? 9 : undefined);
  }

  finish(exitCode: number, signal?: number): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => {
      for (const listener of this.onExitListeners) listener({ exitCode, signal });
    });
  }
}

function createHarness() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, any>();
  const lifecycle = new Map<string, (...args: any[]) => Promise<void> | void>();
  const eventBus = new EventEmitter();
  const messages: SentMessage[] = [];
  const children: FakeChildProcess[] = [];
  const ptys: FakePty[] = [];
  const widgets = new Map<string, any>();
  const widgetUpdates: Array<{ key: string; widget: unknown; options?: unknown }> = [];
  let toolsExpanded = false;

  const pi = {
    events: {
      on: (name: string, handler: (...args: any[]) => void) => eventBus.on(name, handler),
      emit: (name: string, payload: unknown) => eventBus.emit(name, payload),
    },
    on: (name: string, handler: (...args: any[]) => Promise<void> | void) => lifecycle.set(name, handler),
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    mode: "tui",
    isProjectTrusted: () => true,
    ui: {
      setWidget: (key: string, widget: unknown, options?: unknown) => {
        widgetUpdates.push({ key, widget, options });
        if (widget === undefined) widgets.delete(key);
        else widgets.set(key, widget);
      },
      notify: () => {},
      getToolsExpanded: () => toolsExpanded,
    },
  } as unknown as ExtensionContext;

  backgroundTasks(pi);
  eventBus.emit("bg:register", {
    spawn: () => {
      const child = new FakeChildProcess(90_000_000 + children.length);
      children.push(child);
      return child as unknown as ChildProcess;
    },
    ptySpawn: (_file: string, _args: string[] | string, options: { cols?: number; rows?: number }) => {
      const pty = new FakePty(91_000_000 + ptys.length, options.cols ?? 80, options.rows ?? 24);
      ptys.push(pty);
      return pty as unknown as IPty;
    },
    resolveShell: (command: string) => ({
      file: "test-bash",
      args: ["-c", command],
      env: { ...process.env },
    }),
  });
  return {
    tools,
    commands,
    lifecycle,
    eventBus,
    messages,
    children,
    ptys,
    widgets,
    widgetUpdates,
    ctx,
    setToolsExpanded: (value: boolean) => { toolsExpanded = value; },
  };
}

async function waitForRenderedText(chunks: string[], pattern: RegExp, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(chunks.join(""))) return true;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return false;
}

test("background tasks can pass commands through Pi's stdin shell transport", async () => {
  const { tools, lifecycle, eventBus, children, ctx } = createHarness();
  eventBus.emit("bg:register", {
    resolveShell: (command: string) => ({
      file: "legacy-wsl-bash",
      args: ["-s"],
      env: { ...process.env },
      initialStdin: command,
    }),
  });

  const bgStart = tools.get("bg_start");
  assert.ok(bgStart);
  await bgStart.execute(
    "start-stdin-shell",
    { name: "stdin-shell", command: "echo $HOME" },
    undefined,
    undefined,
    ctx,
  );

  assert.deepEqual(children[0].stdin.read(), Buffer.from("echo $HOME"));
  assert.equal(children[0].stdin.writableEnded, true);
  children[0].finish(0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("background tasks wait explicitly, discourage polling, and expose the latest log", async () => {
  const { tools, commands, lifecycle, messages, children, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgWait = tools.get("bg_wait");
  const bgStatus = tools.get("bg_status");
  const bgLogs = tools.get("bg_logs");
  const bgSend = tools.get("bg_send");
  const bgKill = tools.get("bg_kill");
  assert.ok(bgStart && bgWait && bgStatus && bgLogs && bgSend && bgKill);
  assert.equal(tools.has("bg_stop"), false);
  assert.ok(commands.has("bg-attach"));
  assert.ok(commands.has("bg-kill"));
  assert.equal(commands.has("kill"), false);

  assert.equal(bgWait.executionMode, "parallel");
  assert.equal(bgStatus.executionMode, "sequential");
  assert.match(bgStart.promptGuidelines?.join("\n") ?? "", /instead of polling bg_status or bg_logs/i);
  assert.match(bgStatus.promptGuidelines?.join("\n") ?? "", /Do not poll bg_status/);
  assert.match(bgLogs.promptGuidelines?.join("\n") ?? "", /Do not repeatedly call bg_logs/);
  assert.match(bgWait.promptGuidelines?.join("\n") ?? "", /instead of polling bg_status\/bg_logs/i);
  assert.match(bgWait.promptGuidelines?.join("\n") ?? "", /independent waits execute in parallel/i);
  assert.match(bgSend.promptGuidelines?.join("\n") ?? "", /Terminal keys always use input/i);
  assert.equal(bgStart.parameters.properties?.wait, undefined);
  assert.equal(bgWait.parameters.properties?.timeout.minimum, 1);
  assert.equal(bgWait.parameters.properties?.timeout.maximum, 3600);
  assert.ok(bgWait.parameters.properties?.terminal_snapshot);
  assert.ok(bgStatus.parameters.properties?.terminal_snapshot);
  assert.ok(bgKill.parameters.properties?.terminal_snapshot);
  assert.ok(bgSend.parameters.properties?.input);
  assert.equal(bgSend.parameters.properties?.text, undefined);
  assert.equal(bgSend.parameters.properties?.key, undefined);
  assert.equal(bgSend.parameters.properties?.sequence, undefined);
  assert.equal(bgSend.parameters.properties?.enter, undefined);
  assert.equal(bgSend.parameters.properties?.raw, undefined);
  assert.equal(bgKill.parameters.properties?.tail_lines, undefined);

  const first = await bgStart.execute(
    "start-1",
    {
      name: "latest-log",
      command: "fake latest-log command",
    },
    undefined,
    undefined,
    ctx,
  );
  const firstId = first.details.id as string;
  assert.match(first.content[0].text, /Use bg_wait once/i);
  setTimeout(() => {
    children[0].stdout.write("first\nlast\n");
    children[0].finish(0, null);
  }, 40);

  const startedAt = Date.now();
  const waitResult = await bgWait.execute("wait-1", { id: firstId, timeout: 1 }, undefined, undefined, ctx);
  assert.ok(Date.now() - startedAt >= 20, "bg_wait should wait until the task finishes");
  assert.match(waitResult.content[0].text, /completed/);
  assert.match(waitResult.content[0].text, /Latest log: \[stdout\] last/);
  assert.equal(waitResult.details.timedOut, false);
  assert.equal(messages.length, 0, "completion should not enqueue an AI follow-up notification");

  const detailResult = await bgStatus.execute("status-detail", { id: firstId }, undefined, undefined, ctx);
  assert.match(detailResult.content[0].text, /Latest log: \[stdout\] last/);
  assert.equal(detailResult.details.latestLog.text, "last");

  const longRunning = await bgStart.execute(
    "start-2",
    { name: "cancel-status", command: "fake long-running command" },
    undefined,
    undefined,
    ctx,
  );
  const longRunningId = longRunning.details.id as string;
  const firstStatusStartedAt = Date.now();
  const firstStatus = await bgStatus.execute("status-first", { id: longRunningId }, undefined, undefined, ctx);
  assert.equal(firstStatus.details.status, "running");
  assert.ok(Date.now() - firstStatusStartedAt < 500, "status snapshots should return immediately");
  const repeatedStatusStartedAt = Date.now();
  const repeatedStatus = await bgStatus.execute("status-repeated", { id: longRunningId }, undefined, undefined, ctx);
  assert.equal(repeatedStatus.details.status, "running");
  assert.ok(Date.now() - repeatedStatusStartedAt < 500, "repeated status snapshots should not be throttled");
  const abortController = new AbortController();
  const waitUpdates: unknown[] = [];
  const waitPromise = bgWait.execute(
    "wait-cancel",
    { id: longRunningId, timeout: 5 },
    abortController.signal,
    (update: unknown) => waitUpdates.push(update),
    ctx,
  );
  assert.deepEqual(waitUpdates, [{
    content: [],
    details: { id: longRunningId, name: "cancel-status", status: "running" },
  }]);
  setTimeout(() => abortController.abort(new Error("cancelled by test")), 30);
  await assert.rejects(waitPromise, /cancelled by test/);

  const timeoutStartedAt = Date.now();
  const timeoutResult = await bgWait.execute("wait-timeout", { id: longRunningId, timeout: 0.02 }, undefined, undefined, ctx);
  assert.ok(Date.now() - timeoutStartedAt >= 10, "bg_wait should wait until its timeout");
  assert.match(timeoutResult.content[0].text, /Timed out/);
  assert.match(timeoutResult.content[0].text, /timeout did not stop it/);
  assert.equal(timeoutResult.details.timedOut, true);
  assert.equal(timeoutResult.details.status, "running");

  children[1].stdout.write("older kill output\nlatest kill output\n");
  const killResult = await bgKill.execute(
    "kill-2",
    { id: longRunningId, force: true },
    undefined,
    undefined,
    ctx,
  );
  assert.match(killResult.content[0].text, /Status: stopped/);
  assert.match(killResult.content[0].text, /Latest log: \[stdout\] latest kill output/);
  assert.doesNotMatch(killResult.content[0].text, /older kill output|── stdout/);
  assert.equal(killResult.details.latestLog.text, "latest kill output");
  assert.equal(messages.length, 0, "stopping should not enqueue an AI follow-up notification");

  const signalTask = await bgStart.execute(
    "start-3",
    { name: "signal-task", command: "fake signal task" },
    undefined,
    undefined,
    ctx,
  );
  const signalTaskId = signalTask.details.id as string;
  const signalResult = await bgSend.execute(
    "send-signal",
    { id: signalTaskId, signal: "SIGTERM" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(signalResult.content[0].text, /Sent SIGTERM/);
  const signalWait = await bgWait.execute("wait-signal", { id: signalTaskId, timeout: 1 }, undefined, undefined, ctx);
  assert.match(signalWait.content[0].text, /stopped/);
  assert.equal(signalWait.details.signal, "SIGTERM");

  const ctrlTask = await bgStart.execute(
    "start-4",
    { name: "ctrl-task", command: "fake ctrl task" },
    undefined,
    undefined,
    ctx,
  );
  const ctrlTaskId = ctrlTask.details.id as string;
  const pipeInput = await bgSend.execute(
    "send-pipe-input",
    { id: ctrlTaskId, input: "hello<Enter>" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(pipeInput.content[0].text, /6 bytes \(1 key tokens\)/);
  assert.deepEqual(children[3].stdin.read(), Buffer.from("hello\n"));

  const pipeSpaces = await bgSend.execute(
    "send-pipe-spaces",
    { id: ctrlTaskId, input: "<Space*2>" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(pipeSpaces.content[0].text, /2 bytes \(2 key tokens\)/);
  assert.deepEqual(children[3].stdin.read(), Buffer.from("  "));

  const rejectedPipeKey = await bgSend.execute(
    "reject-pipe-key",
    { id: ctrlTaskId, input: "before<Up>" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(rejectedPipeKey.content[0].text, /requires a PTY task/);
  assert.equal(children[3].stdin.read(), null, "invalid input must not be partially written");

  const escapedPipeKey = await bgSend.execute(
    "send-escaped-pipe-key",
    { id: ctrlTaskId, input: "\\<C-d>" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(escapedPipeKey.content[0].text, /5 bytes/);
  assert.deepEqual(children[3].stdin.read(), Buffer.from("<C-d>"));
  assert.equal(children[3].stdin.writableEnded, false);

  const pipeEof = await bgSend.execute(
    "send-pipe-eof",
    { id: ctrlTaskId, input: "<Ctrl+d>" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(pipeEof.content[0].text, /Closed stdin/);
  assert.equal(children[3].stdin.writableEnded, true);

  const ctrlResult = await bgSend.execute(
    "send-ctrl-c",
    { id: ctrlTaskId, signal: "SIGINT" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(ctrlResult.content[0].text, /Sent SIGINT/);
  const ctrlWait = await bgWait.execute("wait-ctrl", { id: ctrlTaskId, timeout: 1 }, undefined, undefined, ctx);
  assert.equal(ctrlWait.details.signal, "SIGINT");
  assert.equal(messages.length, 0);

  const logTask = await bgStart.execute(
    "start-5",
    { name: "formatted-logs", command: "fake formatted logs" },
    undefined,
    undefined,
    ctx,
  );
  const logTaskId = logTask.details.id as string;
  children[4].stdout.write("\x1b[31mout\x1b[0m\r\n");
  children[4].stderr.write("\x1b[33merr\x1b[0m\n");
  children[4].finish(0, null);
  await bgWait.execute("wait-logs", { id: logTaskId, timeout: 1 }, undefined, undefined, ctx);

  const logsResult = await bgLogs.execute(
    "logs-formatted",
    { id: logTaskId, stream: "both", tail: 5 },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(logsResult.content[0].text, "── stdout ──\nout\n── stderr ──\nerr");
  assert.doesNotMatch(logsResult.content[0].text, /\x1b/);

  const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const collapsedCall = bgLogs.renderCall?.(
    { id: logTaskId, stream: "both", tail: 5 },
    plainTheme,
    { lastComponent: undefined, expanded: false },
  );
  assert.ok(collapsedCall);
  assert.match(stripVTControlCharacters(collapsedCall.render(80).join("\n")), /to expand/);

  const expandedCall = bgLogs.renderCall?.(
    { id: logTaskId, stream: "both", tail: 5 },
    plainTheme,
    { lastComponent: collapsedCall, expanded: true },
  );
  assert.ok(expandedCall);
  assert.match(stripVTControlCharacters(expandedCall.render(80).join("\n")), /to collapse/);

  const collapsed = bgLogs.renderResult?.(
    logsResult,
    { expanded: false, isPartial: false },
    plainTheme,
    { lastComponent: undefined },
  );
  assert.ok(collapsed);
  assert.deepEqual(collapsed.render(80), []);

  const expanded = bgLogs.renderResult?.(
    logsResult,
    { expanded: true, isPartial: false },
    plainTheme,
    { lastComponent: collapsed },
  );
  assert.ok(expanded);
  const expandedLines = expanded.render(80);
  assert.ok(expandedLines.some((line: string) => line.includes("── stdout ──")));
  assert.ok(expandedLines.some((line: string) => line.includes("── stderr ──")));

  const canonicalEofTask = await bgStart.execute(
    "start-canonical-eof",
    { name: "canonical-eof", command: "fake canonical eof" },
    undefined,
    undefined,
    ctx,
  );
  const canonicalEof = await bgSend.execute(
    "send-canonical-eof",
    { id: canonicalEofTask.details.id, input: "<EOF>" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(canonicalEof.content[0].text, /Closed stdin/);
  assert.equal(children[5].stdin.writableEnded, true);
  children[5].finish(0, null);

  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("bg_wait renderer shows elapsed time while waiting", async () => {
  const { tools } = createHarness();
  const bgWait = tools.get("bg_wait");
  assert.ok(bgWait?.renderCall && bgWait.renderResult);

  const originalDateNow = Date.now;
  let now = 10_000;
  let invalidations = 0;
  const state: Record<string, unknown> = {};
  const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

  try {
    Date.now = () => now;
    bgWait.renderCall(
      { id: "wait-render", timeout: 30 },
      plainTheme,
      { state, executionStarted: true, lastComponent: undefined, expanded: false },
    );
    const partialResult = { content: [{ type: "text", text: "" }], details: {} };
    const partial = bgWait.renderResult(
      partialResult,
      { expanded: false, isPartial: true },
      plainTheme,
      { state, lastComponent: undefined, isError: false, invalidate: () => { invalidations += 1; } },
    );
    assert.match(partial.render(120).map((line: string) => line.trimEnd()).join("\n"), /Elapsed 0\.0s/);

    now += 2200;
    await new Promise<void>((resolve) => setTimeout(resolve, 1050));
    assert.ok(invalidations >= 1);
    const updated = bgWait.renderResult(
      partialResult,
      { expanded: false, isPartial: true },
      plainTheme,
      { state, lastComponent: partial, isError: false, invalidate: () => { invalidations += 1; } },
    );
    assert.match(updated.render(120).map((line: string) => line.trimEnd()).join("\n"), /Elapsed 2\.2s/);

    bgWait.renderResult(
      { content: [{ type: "text", text: "done" }], details: { status: "completed" } },
      { expanded: false, isPartial: false },
      plainTheme,
      { state, lastComponent: updated, isError: false, invalidate: () => { invalidations += 1; } },
    );
    assert.equal(state.interval, undefined);
  } finally {
    Date.now = originalDateNow;
  }
});

test("background task widget renders live state without re-registering every tick", async () => {
  const { tools, lifecycle, children, ptys, widgets, widgetUpdates, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgStatus = tools.get("bg_status");
  const bgLogs = tools.get("bg_logs");
  const bgWait = tools.get("bg_wait");
  assert.ok(bgStart && bgStatus && bgLogs && bgWait);

  const widgetCtx = { ...ctx, hasUI: true } as ExtensionContext;
  await lifecycle.get("session_start")?.({}, widgetCtx);
  const ptyStarted = await bgStart.execute(
    "widget-pty-pro",
    { name: "pi-debate-pro", command: "fake pro", pty: true, cols: 100, rows: 25 },
    undefined,
    undefined,
    widgetCtx,
  );
  const pipeStarted = await bgStart.execute(
    "widget-pipe-build",
    { name: "pi-build", command: "fake build" },
    undefined,
    undefined,
    widgetCtx,
  );

  const widgetFactory = widgets.get("bg-tasks-widget");
  assert.ok(widgetFactory);
  const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  let renderRequests = 0;
  const component = widgetFactory({ requestRender: () => { renderRequests += 1; } }, plainTheme);
  const lines = component.render(200).map((line: string) => line.trimEnd());
  assert.equal(lines[0], "2 background tasks · 2 running · 0 finished");
  assert.match(lines[1], /^├─ ◐ pi-debate-pro \([a-z0-9]+\) 0s pty:100x25$/);
  assert.match(lines[2], /^└─ ◐ pi-build \([a-z0-9]+\) 0s stdout:0 stderr:0$/);
  assert.equal(widgetUpdates.length, 1, "the TUI widget should be registered once");

  children[0].stdout.write("first\nsecond\n");
  children[0].stderr.write("warning\n");
  assert.match(component.render(200)[2], / stdout:2 stderr:1$/);
  assert.equal(widgetUpdates.length, 1, "output changes should not replace the widget component");

  await new Promise<void>((resolve) => setTimeout(resolve, 1050));
  assert.ok(renderRequests >= 1, "the one-second ticker should request a render");
  assert.equal(widgetUpdates.length, 1, "ticker refreshes should not replace the widget component");
  assert.match(component.render(200)[1], / \d+s pty:100x25$/);

  ptys[0].emitData("PTY FINAL\r\n");
  ptys[0].finish(0);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const mixedLines = component.render(200).map((line: string) => line.trimEnd());
  assert.equal(mixedLines[0], "2 background tasks · 1 running · 1 finished");
  assert.match(mixedLines[1], /^├─ ✓ pi-debate-pro \([a-z0-9]+\) completed \d+s exit=0$/);
  assert.equal(mixedLines[2], "│  └─ [terminal] PTY FINAL");
  assert.match(mixedLines[3], /^└─ ◐ pi-build \([a-z0-9]+\) \d+s stdout:2 stderr:1$/);

  await lifecycle.get("before_agent_start")?.({}, widgetCtx);
  const nextTurnLines = component.render(200).map((line: string) => line.trimEnd());
  assert.equal(nextTurnLines[0], "1 background task · 1 running · 0 finished");
  assert.match(nextTurnLines[1], /^└─ ◐ pi-build \([a-z0-9]+\) \d+s stdout:2 stderr:1$/);

  children[0].finish(0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(widgets.has("bg-tasks-widget"), true, "the final task result should remain visible for this turn");
  const finishedLines = component.render(200).map((line: string) => line.trimEnd());
  assert.equal(finishedLines[0], "1 background task · 0 running · 1 finished");
  assert.match(finishedLines[1], /^└─ ✓ pi-build \([a-z0-9]+\) completed \d+s exit=0$/);
  assert.equal(finishedLines[2], "   └─ [stderr] warning");
  assert.equal(widgetUpdates.length, 1, "finishing should update the existing TUI component");

  const rendersAfterExit = renderRequests;
  await new Promise<void>((resolve) => setTimeout(resolve, 1050));
  assert.equal(renderRequests, rendersAfterExit, "the ticker should stop after the last task exits");

  await lifecycle.get("session_start")?.({ reason: "reload" }, widgetCtx);
  const restoredFactory = widgets.get("bg-tasks-widget");
  assert.ok(restoredFactory, "session_start within the same runtime must not archive final output");
  const restoredComponent = restoredFactory({ requestRender: () => {} }, plainTheme);
  assert.match(restoredComponent.render(200).join("\n"), /\[stderr\] warning/);

  const currentList = await bgStatus.execute("status-current", {}, undefined, undefined, widgetCtx);
  assert.equal(currentList.details.tasks.length, 1);
  assert.equal(currentList.details.tasks[0].id, pipeStarted.details.id);

  const retainedLogs = await bgLogs.execute(
    "logs-retained-id",
    { id: pipeStarted.details.id, stream: "both" },
    undefined,
    undefined,
    widgetCtx,
  );
  assert.match(retainedLogs.content[0].text, /first\nsecond/);
  assert.match(retainedLogs.content[0].text, /warning/);

  const retainedWait = await bgWait.execute(
    "wait-retained-id",
    { id: pipeStarted.details.id, timeout: 1 },
    undefined,
    undefined,
    widgetCtx,
  );
  assert.equal(retainedWait.details.status, "completed");

  await lifecycle.get("before_agent_start")?.({}, widgetCtx);
  assert.equal(widgets.has("bg-tasks-widget"), false, "the next turn should discard the retained final result");

  const emptyList = await bgStatus.execute("status-empty", {}, undefined, undefined, widgetCtx);
  assert.deepEqual(emptyList.details.tasks, []);
  assert.equal(emptyList.content[0].text, "No background tasks.");

  const discardedStatus = await bgStatus.execute(
    "status-discarded-id",
    { id: ptyStarted.details.id },
    undefined,
    undefined,
    widgetCtx,
  );
  assert.deepEqual(discardedStatus.details, {});
  assert.match(discardedStatus.content[0].text, /Task not found/);

  const discardedLogs = await bgLogs.execute(
    "logs-discarded-id",
    { id: pipeStarted.details.id, stream: "both" },
    undefined,
    undefined,
    widgetCtx,
  );
  assert.deepEqual(discardedLogs.details, {});
  assert.match(discardedLogs.content[0].text, /Task not found/);

  const discardedWait = await bgWait.execute(
    "wait-discarded-id",
    { id: pipeStarted.details.id, timeout: 1 },
    undefined,
    undefined,
    widgetCtx,
  );
  assert.deepEqual(discardedWait.details, {});
  assert.match(discardedWait.content[0].text, /Task not found/);
  await lifecycle.get("session_shutdown")?.({}, widgetCtx);
});

test("background task widget previews three items and prioritizes running tasks", async () => {
  const { tools, lifecycle, children, widgets, ctx, setToolsExpanded } = createHarness();
  const bgStart = tools.get("bg_start");
  assert.ok(bgStart);

  const widgetCtx = { ...ctx, hasUI: true } as ExtensionContext;
  await lifecycle.get("session_start")?.({}, widgetCtx);
  for (const name of ["finished-one", "finished-two", "finished-three", "running-four", "running-five"]) {
    await bgStart.execute(
      `start-${name}`,
      { name, command: `fake ${name}` },
      undefined,
      undefined,
      widgetCtx,
    );
  }

  for (let index = 0; index < 3; index++) {
    children[index].stdout.write(`OUTPUT ${index + 1}\n`);
    children[index].finish(0, null);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));

  const widgetFactory = widgets.get("bg-tasks-widget");
  assert.ok(widgetFactory);
  const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const component = widgetFactory({ requestRender: () => {} }, plainTheme);
  const collapsed = component.render(200).join("\n");
  assert.match(collapsed, /5 background tasks · 2 running · 3 finished.*to expand/);
  assert.match(collapsed, /running-four/);
  assert.match(collapsed, /running-five/);
  assert.match(collapsed, /finished-one/);
  assert.doesNotMatch(collapsed, /finished-two|finished-three/);
  assert.ok(collapsed.indexOf("running-four") < collapsed.indexOf("finished-one"));

  const colorTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<bold>${text}</bold>`,
  };
  const coloredHeader = widgetFactory({ requestRender: () => {} }, colorTheme).render(300)[0];
  assert.match(coloredHeader, /<accent><bold>5 background tasks<\/bold><\/accent>/);
  assert.match(coloredHeader, /<warning>2 running<\/warning>/);
  assert.match(coloredHeader, /<muted> · 3 finished/);
  assert.doesNotMatch(coloredHeader, /<warning>5 background tasks|3 finished<\/warning>/);

  setToolsExpanded(true);
  const expanded = component.render(200).join("\n");
  assert.match(expanded, /to collapse/);
  for (const name of ["finished-one", "finished-two", "finished-three", "running-four", "running-five"]) {
    assert.match(expanded, new RegExp(name));
  }

  children[3].finish(0, null);
  children[4].finish(0, null);
  await lifecycle.get("session_shutdown")?.({}, widgetCtx);
});

test("tasks finishing while the agent is idle survive the next inspection turn", async () => {
  const { tools, lifecycle, children, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgStatus = tools.get("bg_status");
  const bgLogs = tools.get("bg_logs");
  assert.ok(bgStart && bgStatus && bgLogs);

  const idleStarted = await bgStart.execute(
    "idle-finish-start",
    { name: "idle-finish", command: "fake idle completion" },
    undefined,
    undefined,
    ctx,
  );
  const activeStarted = await bgStart.execute(
    "active-finish-start",
    { name: "active-finish", command: "fake active completion" },
    undefined,
    undefined,
    ctx,
  );
  const idleId = idleStarted.details.id as string;
  const activeId = activeStarted.details.id as string;

  await lifecycle.get("agent_settled")?.({}, ctx);
  children[0].stdout.write("FINISHED WHILE IDLE\n");
  children[0].finish(0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));

  await lifecycle.get("before_agent_start")?.({}, ctx);
  const inspectionList = await bgStatus.execute("idle-inspection-list", {}, undefined, undefined, ctx);
  assert.equal(inspectionList.details.tasks.length, 2);
  assert.equal(
    inspectionList.details.tasks.find((task: { id: string }) => task.id === idleId)?.status,
    "completed",
  );
  assert.equal(
    inspectionList.details.tasks.find((task: { id: string }) => task.id === activeId)?.status,
    "running",
  );

  const idleLogs = await bgLogs.execute(
    "idle-inspection-logs",
    { id: idleId, stream: "both" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(idleLogs.content[0].text, /FINISHED WHILE IDLE/);

  children[1].stdout.write("FINISHED DURING INSPECTION TURN\n");
  children[1].finish(0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await lifecycle.get("agent_settled")?.({}, ctx);

  await lifecycle.get("before_agent_start")?.({}, ctx);
  const expiredList = await bgStatus.execute("idle-expired-list", {}, undefined, undefined, ctx);
  assert.deepEqual(expiredList.details.tasks, []);
  assert.equal(expiredList.content[0].text, "No background tasks.");
  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("background task widget uses serializable lines in RPC mode", async () => {
  const { tools, lifecycle, children, widgets, widgetUpdates, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  assert.ok(bgStart);

  const rpcCtx = { ...ctx, hasUI: true, mode: "rpc" } as ExtensionContext;
  await lifecycle.get("session_start")?.({}, rpcCtx);
  const originalDateNow = Date.now;
  const startedAt = originalDateNow();
  try {
    Date.now = () => startedAt;
    await bgStart.execute(
      "widget-rpc",
      { name: "rpc-build", command: "fake rpc build" },
      undefined,
      undefined,
      rpcCtx,
    );

    const widgetLines = widgets.get("bg-tasks-widget");
    assert.ok(Array.isArray(widgetLines));
    assert.equal(widgetLines[0], "1 background task · 1 running · 0 finished");
    assert.match(widgetLines[1], /^└─ ◐ rpc-build \([a-z0-9]+\) 0s stdout:0 stderr:0$/);
    assert.deepEqual(widgetUpdates.at(-1)?.options, { placement: "belowEditor" });

    Date.now = () => startedAt + 3_725_000;
    await lifecycle.get("tool_execution_end")?.({ toolName: "bg_status" }, rpcCtx);
    assert.match(widgets.get("bg-tasks-widget")[1], / 1h02m05s stdout:0 stderr:0$/);
  } finally {
    Date.now = originalDateNow;
  }

  children[0].stderr.write("RPC FINAL ERROR\n");
  children[0].finish(2, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(widgets.has("bg-tasks-widget"), true);
  const finishedWidget = widgets.get("bg-tasks-widget");
  assert.equal(finishedWidget[0], "1 background task · 0 running · 1 finished");
  assert.match(finishedWidget[1], /^└─ × rpc-build \([a-z0-9]+\) failed \d+s exit=2$/);
  assert.equal(finishedWidget[2], "   └─ [stderr] RPC FINAL ERROR");
  await lifecycle.get("before_agent_start")?.({}, rpcCtx);
  assert.equal(widgets.has("bg-tasks-widget"), false);
  await lifecycle.get("session_shutdown")?.({}, rpcCtx);
});

test("pipe tasks replay retained output before continuing with live output", async () => {
  const { tools, commands, lifecycle, children, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  assert.ok(bgStart);

  const started = await bgStart.execute(
    "pipe-attach-start",
    { name: "pipe-attach", command: "fake streaming command" },
    undefined,
    undefined,
    ctx,
  );
  const id = started.details.id as string;
  assert.match(started.content[0].text, new RegExp(`/bg-attach ${id}`));
  children[0].stdout.write("BEFORE_ATTACH_STDOUT_A\nBEFORE_ATTACH_STDOUT_B\n");
  children[0].stderr.write("BEFORE_ATTACH_STDERR\n");

  const completions = commands.get("bg-attach").getArgumentCompletions("");
  assert.ok(completions.some((item: { value: string; label: string }) => item.value === id && item.label.includes("[pipe]")));

  await new Promise<void>((resolve) => setImmediate(resolve));
  let childStreamPauseCalls = 0;
  for (const stream of [children[0].stdout, children[0].stderr]) {
    const originalPause = stream.pause.bind(stream);
    (stream as any).pause = () => {
      childStreamPauseCalls += 1;
      return originalPause();
    };
  }
  const stdoutChunks: string[] = [];
  const notifications: string[] = [];
  const stdout = process.stdout as NodeJS.WriteStream;
  const originalStdoutWrite = stdout.write;
  (stdout as any).write = (chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };

  const attachCtx = {
    ...ctx,
    hasUI: true,
    mode: "tui",
    ui: {
      setWidget: () => {},
      notify: (message: string) => notifications.push(message),
      custom: (factory: any) => new Promise((resolve) => {
        const tui = { stop: () => {}, start: () => {}, requestRender: () => {} };
        const component = factory(tui, {}, {}, resolve);
        queueMicrotask(() => {
          void (async () => {
            await waitForRenderedText(stdoutChunks, /BEFORE_ATTACH_STDERR/);
            process.stdin.emit("data", "IGNORED_INPUT");
            children[0].stdout.write("LIVE_STDOUT\n");
            children[0].stderr.write("LIVE_STDERR\n");
            await waitForRenderedText(stdoutChunks, /LIVE_STDERR/);
            component.dispose();
          })();
        });
      }),
    },
  } as unknown as ExtensionContext;

  try {
    await commands.get("bg-attach").handler(id, attachCtx);
  } finally {
    (stdout as any).write = originalStdoutWrite;
  }

  const attachedStdout = stdoutChunks.join("");
  assert.match(attachedStdout, /BEFORE_ATTACH_STDOUT_A\r\nBEFORE_ATTACH_STDOUT_B/);
  assert.match(attachedStdout, /BEFORE_ATTACH_STDERR/);
  assert.match(attachedStdout, /LIVE_STDOUT/);
  assert.match(attachedStdout, /LIVE_STDERR/);
  assert.ok(attachedStdout.indexOf("BEFORE_ATTACH_STDERR") < attachedStdout.indexOf("LIVE_STDOUT"));
  assert.equal(attachedStdout.match(/LIVE_STDOUT/g)?.length, 1);
  assert.equal(attachedStdout.match(/LIVE_STDERR/g)?.length, 1);
  assert.equal(children[0].stdin.read(), null, "pipe attachment must not forward keyboard input");
  assert.deepEqual(notifications, ['Detached from "pipe-attach".']);

  const reattachedChunks: string[] = [];
  (stdout as any).write = (chunk: string | Uint8Array) => {
    reattachedChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  const reattachCtx = {
    ...attachCtx,
    ui: {
      ...attachCtx.ui,
      custom: (factory: any) => new Promise((resolve) => {
        const tui = { stop: () => {}, start: () => {}, requestRender: () => {} };
        const component = factory(tui, {}, {}, resolve);
        queueMicrotask(() => {
          void (async () => {
            await waitForRenderedText(reattachedChunks, /LIVE_STDERR/);
            children[0].stdout.write("AFTER_REATTACH\n");
            await waitForRenderedText(reattachedChunks, /AFTER_REATTACH/);
            component.dispose();
            queueMicrotask(() => children[0].finish(0, null));
          })();
        });
      }),
    },
  } as unknown as ExtensionContext;

  try {
    await commands.get("bg-attach").handler(id, reattachCtx);
  } finally {
    (stdout as any).write = originalStdoutWrite;
  }

  const reattachedStdout = reattachedChunks.join("");
  assert.match(reattachedStdout, /LIVE_STDOUT/);
  assert.match(reattachedStdout, /LIVE_STDERR/);
  assert.match(reattachedStdout, /AFTER_REATTACH/);
  assert.ok(reattachedStdout.indexOf("LIVE_STDERR") < reattachedStdout.indexOf("AFTER_REATTACH"));
  assert.equal(reattachedStdout.match(/AFTER_REATTACH/g)?.length, 1);
  assert.equal(childStreamPauseCalls, 0, "pipe attach must keep draining the child streams");
  assert.deepEqual(notifications, [
    'Detached from "pipe-attach".',
    'Pipe task "pipe-attach" completed (exit code 0).',
  ]);

  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("finished tasks expose a read-only attach snapshot until the next turn", async () => {
  const { tools, commands, lifecycle, children, ptys, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgLogs = tools.get("bg_logs");
  assert.ok(bgStart && bgLogs);

  const pipeStarted = await bgStart.execute(
    "finished-pipe-start",
    { name: "finished-pipe", command: "fake finished pipe" },
    undefined,
    undefined,
    ctx,
  );
  const ptyStarted = await bgStart.execute(
    "finished-pty-start",
    { name: "finished-pty", command: "fake finished pty", pty: true, cols: 60, rows: 10 },
    undefined,
    undefined,
    ctx,
  );
  const pipeId = pipeStarted.details.id as string;
  const ptyId = ptyStarted.details.id as string;

  children[0].stdout.write("PIPE FINAL SNAPSHOT\n");
  ptys[0].emitData("\x1b[2J\x1b[HPTY FINAL SNAPSHOT\r\n");
  children[0].finish(0, null);
  ptys[0].finish(0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const attachCommand = commands.get("bg-attach");
  assert.match(attachCommand.description, /read-only final snapshot/);
  const completions = attachCommand.getArgumentCompletions("");
  assert.ok(completions.some((item: { value: string; label: string }) =>
    item.value === pipeId && item.label.includes("(completed)")));
  assert.ok(completions.some((item: { value: string; label: string }) =>
    item.value === ptyId && item.label.includes("(completed)")));

  const cases = [
    { id: pipeId, mode: "Pipe", name: "finished-pipe", expected: /PIPE FINAL SNAPSHOT/ },
    { id: ptyId, mode: "PTY", name: "finished-pty", expected: /PTY FINAL SNAPSHOT/ },
  ];
  for (const attachCase of cases) {
    const stdoutChunks: string[] = [];
    const notifications: string[] = [];
    const stdout = process.stdout as NodeJS.WriteStream;
    const originalStdoutWrite = stdout.write;
    (stdout as any).write = (chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    const attachCtx = {
      ...ctx,
      hasUI: true,
      mode: "tui",
      ui: {
        setWidget: () => {},
        notify: (message: string) => notifications.push(message),
        custom: (factory: any) => new Promise((resolve) => {
          const tui = { stop: () => {}, start: () => {}, requestRender: () => {} };
          factory(tui, {}, {}, resolve);
          setImmediate(() => process.stdin.emit("data", "\x1d"));
        }),
      },
    } as unknown as ExtensionContext;

    try {
      await attachCommand.handler(attachCase.id, attachCtx);
    } finally {
      (stdout as any).write = originalStdoutWrite;
    }

    const attachedOutput = stdoutChunks.join("");
    assert.match(attachedOutput, attachCase.expected);
    assert.match(attachedOutput, /Task finished - Ctrl\+\] to return/);
    assert.deepEqual(notifications, [
      `${attachCase.mode} task "${attachCase.name}" completed (exit code 0).`,
    ]);

    const retainedOutput = await bgLogs.execute(
      `logs-${attachCase.id}`,
      { id: attachCase.id, stream: attachCase.mode === "PTY" ? "terminal" : "both" },
      undefined,
      undefined,
      ctx,
    );
    assert.doesNotMatch(retainedOutput.content[0].text, /Task finished - Ctrl\+\] to return/);
  }

  await lifecycle.get("before_agent_start")?.({}, ctx);
  const discardedCompletions = attachCommand.getArgumentCompletions("");
  assert.ok(!discardedCompletions.some((item: { value: string }) => item.value === pipeId || item.value === ptyId));

  const missingNotifications: string[] = [];
  const missingCtx = {
    ...ctx,
    ui: { ...ctx.ui, notify: (message: string) => missingNotifications.push(message) },
  } as ExtensionContext;
  await attachCommand.handler(pipeId, missingCtx);
  assert.deepEqual(missingNotifications, [`Task not found: ${pipeId}`]);

  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("attached tasks stay open and show a user-only hint after they exit", async () => {
  const { tools, commands, lifecycle, children, ptys, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgLogs = tools.get("bg_logs");
  assert.ok(bgStart && bgLogs);

  const pipeStarted = await bgStart.execute(
    "attached-exit-pipe-start",
    { name: "attached-exit-pipe", command: "fake attached pipe" },
    undefined,
    undefined,
    ctx,
  );
  const ptyStarted = await bgStart.execute(
    "attached-exit-pty-start",
    { name: "attached-exit-pty", command: "fake attached pty", pty: true, cols: 60, rows: 10 },
    undefined,
    undefined,
    ctx,
  );
  const pipeId = pipeStarted.details.id as string;
  const ptyId = ptyStarted.details.id as string;
  const attachCommand = commands.get("bg-attach");

  const cases = [
    {
      id: pipeId,
      mode: "Pipe",
      name: "attached-exit-pipe",
      finish: () => {
        children[0].stdout.write("PIPE OUTPUT AT EXIT\n");
        children[0].finish(0, null);
      },
      output: /PIPE OUTPUT AT EXIT/,
    },
    {
      id: ptyId,
      mode: "PTY",
      name: "attached-exit-pty",
      finish: () => {
        ptys[0].emitData("\x1b[2J\x1b[HPTY OUTPUT AT EXIT\r\n");
        ptys[0].finish(0);
      },
      output: /PTY OUTPUT AT EXIT/,
    },
  ];

  for (const attachCase of cases) {
    const stdoutChunks: string[] = [];
    const notifications: string[] = [];
    let detachSent = false;
    const stdout = process.stdout as NodeJS.WriteStream;
    const originalStdoutWrite = stdout.write;
    (stdout as any).write = (chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    const attachCtx = {
      ...ctx,
      hasUI: true,
      mode: "tui",
      ui: {
        setWidget: () => {},
        notify: (message: string) => notifications.push(message),
        custom: (factory: any) => new Promise((resolve) => {
          const tui = { stop: () => {}, start: () => {}, requestRender: () => {} };
          factory(tui, {}, {}, resolve);
          setImmediate(() => {
            attachCase.finish();
            setTimeout(() => {
              process.stdin.emit("data", "IGNORED AFTER EXIT");
              detachSent = true;
              process.stdin.emit("data", "\x1d");
            }, 30);
          });
        }),
      },
    } as unknown as ExtensionContext;

    try {
      await attachCommand.handler(attachCase.id, attachCtx);
    } finally {
      (stdout as any).write = originalStdoutWrite;
    }

    assert.equal(detachSent, true, "task exit must not resolve the attachment before Ctrl+]");
    const attachedOutput = stdoutChunks.join("");
    assert.match(attachedOutput, attachCase.output);
    assert.match(attachedOutput, /Task finished - Ctrl\+\] to return/);
    if (attachCase.mode === "Pipe") {
      assert.match(attachedOutput, /\r\n\[Task finished - Ctrl\+\] to return\]\r\n/);
    } else {
      assert.match(attachedOutput, /\x1b\[\d+;\d+H\x1b\[7m Task finished - Ctrl\+\] to return /);
      assert.ok(!ptys[0].writes.some((write) => Buffer.from(write).toString("utf8").includes("IGNORED AFTER EXIT")));
    }
    assert.deepEqual(notifications, [
      `${attachCase.mode} task "${attachCase.name}" completed (exit code 0).`,
    ]);

    const retainedOutput = await bgLogs.execute(
      `logs-${attachCase.id}`,
      { id: attachCase.id, stream: attachCase.mode === "PTY" ? "terminal" : "both" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(retainedOutput.content[0].text, attachCase.output);
    assert.doesNotMatch(retainedOutput.content[0].text, /Task finished - Ctrl\+\] to return/);
  }

  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("PTY tasks preserve terminal state and use terminal input semantics", async () => {
  const { tools, commands, lifecycle, ptys, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgWait = tools.get("bg_wait");
  const bgStatus = tools.get("bg_status");
  const bgLogs = tools.get("bg_logs");
  const bgSend = tools.get("bg_send");
  const bgKill = tools.get("bg_kill");
  assert.ok(bgStart && bgWait && bgStatus && bgLogs && bgSend && bgKill);

  const started = await bgStart.execute(
    "pty-start",
    { name: "pty-demo", command: "fake tui", pty: true, cols: 40, rows: 8 },
    undefined,
    undefined,
    ctx,
  );
  const id = started.details.id as string;
  assert.equal(started.details.mode, "pty");
  assert.match(started.content[0].text, new RegExp(`/bg-attach ${id}`));
  assert.equal(ptys[0].cols, 40);
  assert.equal(ptys[0].rows, 8);

  ptys[0].emitData("\x1b[2J\x1b[HPTY_READY\r\n");
  ptys[0].emitData("name: ");

  const snapshot = await bgLogs.execute(
    "pty-logs",
    { id, stream: "terminal", tail: 10 },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(snapshot.details.mode, "pty");
  assert.match(snapshot.content[0].text, /── terminal ──/);
  assert.match(snapshot.content[0].text, /PTY_READY/);
  assert.match(snapshot.content[0].text, /name:/);

  const sent = await bgSend.execute(
    "pty-send",
    { id, input: "Alice" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(sent.content[0].text, /Sent to/);
  assert.equal(Buffer.from(ptys[0].writes.at(-1) as Buffer).toString("utf8"), "Alice");

  const entered = await bgSend.execute(
    "pty-enter",
    { id, input: "<Enter>" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(entered.content[0].text, /1 key tokens/);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from("\r"));

  await bgSend.execute("pty-text-enter", { id, input: "Bob<Enter>" }, undefined, undefined, ctx);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from("Bob\r"));

  const interrupted = await bgSend.execute(
    "pty-ctrl-c",
    { id, input: "<C-c>" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(interrupted.content[0].text, /1 key tokens/);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from([0x03]));
  assert.equal(ptys[0].closed, false, "PTY Ctrl+C should be terminal input, not an immediate kill");

  const ctrlCases: Array<[string, number]> = [
    ["<C-b>", 0x02], ["<C-f>", 0x06], ["<C-n>", 0x0e], ["<C-o>", 0x0f],
    ["<C-p>", 0x10], ["<C-w>", 0x17], ["<C-x>", 0x18],
    ["<C-Backslash>", 0x1c], ["<C-]>", 0x1d], ["<C-?>", 0x7f],
  ];
  for (const [input, byte] of ctrlCases) {
    await bgSend.execute(`pty-${input}`, { id, input }, undefined, undefined, ctx);
    assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from([byte]), `${input} byte`);
  }

  for (const input of ["<Ctrl+d>", "<Control-D>", "<C+D>", "<Ctrl + d>"]) {
    await bgSend.execute(`pty-alias-${input}`, { id, input }, undefined, undefined, ctx);
    assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from([0x04]), `${input} Ctrl+D byte`);
  }

  await bgSend.execute("pty-literal-bare-ctrl", { id, input: "Ctrl+d" }, undefined, undefined, ctx);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from("Ctrl+d"));

  await bgSend.execute("pty-escaped-ctrl", { id, input: "\\<C-d>" }, undefined, undefined, ctx);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from("<C-d>"));

  await bgSend.execute("pty-escaped-backslash-before-key", { id, input: "\\\\<C-d>" }, undefined, undefined, ctx);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from([0x5c, 0x04]));

  await bgSend.execute("pty-preserve-ordinary-backslash", { id, input: "C:\\temp\\file" }, undefined, undefined, ctx);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from("C:\\temp\\file"));

  await bgSend.execute("pty-literal-ctrl-text", { id, input: "press Ctrl+d now" }, undefined, undefined, ctx);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from("press Ctrl+d now"));

  const namedKeyCases: Array<[string, string]> = [
    ["<Up>", "\x1b[A"], ["<Down>", "\x1b[B"], ["<Right>", "\x1b[C"], ["<Left>", "\x1b[D"],
    ["<Home>", "\x1b[H"], ["<End>", "\x1b[F"], ["<PageUp>", "\x1b[5~"], ["<PageDown>", "\x1b[6~"],
    ["<F1>", "\x1bOP"], ["<F2>", "\x1bOQ"], ["<F3>", "\x1bOR"], ["<F4>", "\x1bOS"],
    ["<F5>", "\x1b[15~"], ["<F6>", "\x1b[17~"], ["<F7>", "\x1b[18~"], ["<F8>", "\x1b[19~"],
    ["<F9>", "\x1b[20~"], ["<F10>", "\x1b[21~"], ["<F11>", "\x1b[23~"], ["<F12>", "\x1b[24~"],
  ];
  for (const [input, expected] of namedKeyCases) {
    await bgSend.execute(`pty-${input}`, { id, input }, undefined, undefined, ctx);
    assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from(expected), `${input} sequence`);
  }

  const altKeyCases: Array<[string, string]> = [
    ["<A-f>", "\x1bf"], ["<Alt+b>", "\x1bb"], ["<M-x>", "\x1bx"], ["<Meta+1>", "\x1b1"],
    ["<A-Space>", "\x1b "], ["<Alt-Enter>", "\x1b\r"], ["<M-Tab>", "\x1b\t"],
    ["<A-Up>", "\x1b[1;3A"], ["<Alt-Left>", "\x1b[1;3D"],
    ["<M-Delete>", "\x1b[3;3~"], ["<Meta-F1>", "\x1b[1;3P"], ["<A-F10>", "\x1b[21;3~"],
    ["<C-A-d>", "\x1b\x04"], ["<A-C-d>", "\x1b\x04"], ["<A-S-a>", "\x1bA"],
    ["<C-A-Left>", "\x1b[1;7D"], ["<S-A-Left>", "\x1b[1;4D"],
    ["<C-Right>", "\x1b[1;5C"], ["<S-F10>", "\x1b[21;2~"], ["<S-Tab>", "\x1b[Z"],
  ];
  for (const [input, expected] of altKeyCases) {
    await bgSend.execute(`pty-${input}`, { id, input }, undefined, undefined, ctx);
    assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from(expected), `${input} sequence`);
  }

  await bgSend.execute("pty-space", { id, input: "<Space*3>" }, undefined, undefined, ctx);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from("   "));

  await bgSend.execute("pty-alt-repeat", { id, input: "<A-Right*2>" }, undefined, undefined, ctx);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from("\x1b[1;3C\x1b[1;3C"));

  const combined = await bgSend.execute(
    "pty-sequence",
    { id, input: "<Esc>iHello<Enter>" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(combined.content[0].text, /2 key tokens/);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from("\x1biHello\r"));

  await bgSend.execute("pty-repeat", { id, input: "<Down*3>" }, undefined, undefined, ctx);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from("\x1b[B\x1b[B\x1b[B"));

  await bgSend.execute("pty-literal-lt", { id, input: "a <lt> b" }, undefined, undefined, ctx);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from("a < b"));

  const writesBeforeInvalidInput = ptys[0].writes.length;
  const invalidInput = await bgSend.execute(
    "pty-invalid-input",
    { id, input: "before<Unknown>" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(invalidInput.content[0].text, /Unknown input token <Unknown> at offset 6/);
  assert.equal(ptys[0].writes.length, writesBeforeInvalidInput, "invalid DSL must be atomic");

  ptys[0].emitData("\x1b[?1h");
  await bgLogs.execute("pty-flush-application-mode", { id, stream: "terminal" }, undefined, undefined, ctx);
  await bgSend.execute("pty-application-up", { id, input: "<Up>" }, undefined, undefined, ctx);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from("\x1bOA"));
  ptys[0].emitData("\x1b[?1002h\x1b[?100");
  ptys[0].emitData("6h");
  await bgLogs.execute("pty-flush-mouse-mode", { id, stream: "terminal" }, undefined, undefined, ctx);

  const attachOrder: string[] = [];
  const attachNotifications: string[] = [];
  const pty = ptys[0];
  const originalPtyResize = pty.resize.bind(pty);
  pty.pause = () => attachOrder.push("pause");
  pty.resize = (cols, rows) => {
    attachOrder.push(`resize:${cols}x${rows}`);
    originalPtyResize(cols, rows);
  };
  pty.resume = () => attachOrder.push("resume");

  const stdout = process.stdout as NodeJS.WriteStream;
  const originalWrite = stdout.write;
  const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, "columns");
  const rowsDescriptor = Object.getOwnPropertyDescriptor(stdout, "rows");
  Object.defineProperty(stdout, "columns", { configurable: true, value: 80 });
  Object.defineProperty(stdout, "rows", { configurable: true, value: 24 });
  (stdout as any).write = (chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (text === "\x1b[2J\x1b[H") attachOrder.push("clear");
    else if (text.includes("PTY_READY")) attachOrder.push("snapshot");
    else if (text === "\x1b[?1006h") attachOrder.push("mouse-sgr");
    else if (text.includes("DURING_ATTACH")) attachOrder.push("catchup");
    else if (text.includes("\x1b[?1016l")) attachOrder.push("mouse-reset");
    return true;
  };

  const attachCtx = {
    ...ctx,
    hasUI: true,
    mode: "tui",
    ui: {
      setWidget: () => {},
      notify: (message: string) => attachNotifications.push(message),
      custom: (factory: any) => new Promise((resolve) => {
        const tui = { stop: () => {}, start: () => {}, requestRender: () => {} };
        const component = factory(tui, {}, {}, resolve);
        queueMicrotask(() => pty.emitData("DURING_ATTACH\r\n"));
        setTimeout(() => {
          process.stdin.emit("data", "\x1b[<0;12;8M");
          Object.defineProperty(stdout, "columns", { configurable: true, value: 90 });
          Object.defineProperty(stdout, "rows", { configurable: true, value: 28 });
          stdout.emit("resize");
          Object.defineProperty(stdout, "columns", { configurable: true, value: 1000 });
          Object.defineProperty(stdout, "rows", { configurable: true, value: 1 });
          stdout.emit("resize");
        }, 5);
        setTimeout(() => component.dispose(), 70);
      }),
    },
  } as unknown as ExtensionContext;

  try {
    await commands.get("bg-attach").handler(id, attachCtx);
  } finally {
    (stdout as any).write = originalWrite;
    if (columnsDescriptor) Object.defineProperty(stdout, "columns", columnsDescriptor);
    else delete (stdout as any).columns;
    if (rowsDescriptor) Object.defineProperty(stdout, "rows", rowsDescriptor);
    else delete (stdout as any).rows;
  }

  assert.deepEqual(attachOrder, [
    "resize:80x24",
    "clear",
    "snapshot",
    "mouse-sgr",
    "catchup",
    "resize:500x5",
    "mouse-reset",
  ]);
  assert.equal(attachOrder.filter((event) => event === "catchup").length, 1);
  assert.ok(!attachOrder.includes("pause"), "PTY attach must not pause the background task");
  assert.ok(!attachOrder.includes("resume"), "PTY attach must not resume a task it did not pause");
  assert.deepEqual(attachNotifications, ['Detached from "pty-demo".']);
  assert.equal(pty.cols, 500);
  assert.equal(pty.rows, 5);
  assert.equal(pty.writes.at(-1), "\x1b[<0;12;8M", "PTY attach must forward SGR mouse input unchanged");

  const stderr = await bgLogs.execute(
    "pty-stderr",
    { id, stream: "stderr" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(stderr.content[0].text, /combines stdout and stderr/);

  ptys[0].emitData("Alice\r\nDONE\r\n");
  ptys[0].finish(0);
  const waited = await bgWait.execute("pty-wait", { id, timeout: 1 }, undefined, undefined, ctx);
  assert.equal(waited.details.status, "completed");
  assert.equal(waited.details.mode, "pty");
  assert.match(waited.content[0].text, /Mode:\s+pty/);
  assert.doesNotMatch(waited.content[0].text, /Latest log:|terminal snapshot|DONE/);
  assert.equal(waited.details.latestLog, null);
  assert.equal(waited.details.terminalSnapshot, false);

  const waitedSnapshot = await bgWait.execute(
    "pty-wait-snapshot",
    { id, timeout: 1, terminal_snapshot: true },
    undefined,
    undefined,
    ctx,
  );
  assert.match(waitedSnapshot.content[0].text, /── terminal snapshot ──/);
  assert.match(waitedSnapshot.content[0].text, /DONE/);
  assert.doesNotMatch(waitedSnapshot.content[0].text, /Latest log:/);
  assert.equal(waitedSnapshot.details.terminalSnapshot, true);

  const status = await bgStatus.execute("pty-status", { id }, undefined, undefined, ctx);
  assert.match(status.content[0].text, /Mode:\s+pty/);
  assert.doesNotMatch(status.content[0].text, /Latest log:/);
  assert.equal(status.details.latestLog, null);

  const statusSnapshot = await bgStatus.execute(
    "pty-status-snapshot",
    { id, terminal_snapshot: true },
    undefined,
    undefined,
    ctx,
  );
  assert.match(statusSnapshot.content[0].text, /── terminal snapshot ──/);
  assert.match(statusSnapshot.content[0].text, /DONE/);
  assert.doesNotMatch(statusSnapshot.content[0].text, /Latest log:/);

  const statusList = await bgStatus.execute("pty-status-list", {}, undefined, undefined, ctx);
  const listedPty = statusList.details.tasks.find((task: { id: string }) => task.id === id);
  assert.ok(listedPty);
  assert.equal(listedPty.latestLog, null);
  assert.doesNotMatch(statusList.content[0].text, new RegExp(`\\[${id}\\].*pty.*\\n  Latest log:`));

  const statusListSnapshot = await bgStatus.execute(
    "pty-status-list-snapshot",
    { terminal_snapshot: true },
    undefined,
    undefined,
    ctx,
  );
  assert.match(statusListSnapshot.content[0].text, /── terminal snapshot:/);
  assert.match(statusListSnapshot.content[0].text, /DONE/);

  const killStarted = await bgStart.execute(
    "pty-kill-start",
    { name: "pty-kill", command: "fake persistent tui", pty: true },
    undefined,
    undefined,
    ctx,
  );
  ptys[1].emitData("FIRST SCREEN ROW\r\nLAST SCREEN ROW\r\n");
  const killed = await bgKill.execute(
    "pty-kill",
    { id: killStarted.details.id, force: true },
    undefined,
    undefined,
    ctx,
  );
  assert.match(killed.content[0].text, /Status: stopped/);
  assert.doesNotMatch(killed.content[0].text, /Latest log:|terminal|FIRST SCREEN ROW|LAST SCREEN ROW/);
  assert.equal(killed.details.latestLog, null);

  const snapshotKillStarted = await bgStart.execute(
    "pty-kill-snapshot-start",
    { name: "pty-kill-snapshot", command: "fake persistent tui", pty: true },
    undefined,
    undefined,
    ctx,
  );
  ptys[2].emitData("SNAPSHOT FIRST ROW\r\nSNAPSHOT FINAL ROW\r\n");
  const snapshotKilled = await bgKill.execute(
    "pty-kill-snapshot",
    { id: snapshotKillStarted.details.id, force: true, terminal_snapshot: true },
    undefined,
    undefined,
    ctx,
  );
  assert.match(snapshotKilled.content[0].text, /Status: stopped/);
  assert.match(snapshotKilled.content[0].text, /── terminal snapshot ──/);
  assert.match(snapshotKilled.content[0].text, /SNAPSHOT FINAL ROW/);
  assert.doesNotMatch(snapshotKilled.content[0].text, /Latest log:/);

  const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const renderCases = [
    { tool: bgWait, args: { id, timeout: 1, terminal_snapshot: true }, result: waitedSnapshot },
    { tool: bgStatus, args: { id, terminal_snapshot: true }, result: statusSnapshot },
    { tool: bgStatus, args: { terminal_snapshot: true }, result: statusListSnapshot },
    { tool: bgKill, args: { id: snapshotKillStarted.details.id, force: true, terminal_snapshot: true }, result: snapshotKilled },
  ];
  for (const { tool, args, result } of renderCases) {
    const renderState = {};
    const collapsedCall = tool.renderCall?.(args, plainTheme, {
      lastComponent: undefined,
      expanded: false,
      executionStarted: false,
      state: renderState,
    });
    assert.ok(collapsedCall);
    assert.match(stripVTControlCharacters(collapsedCall.render(120).join("\n")), /to expand/);

    const collapsedResult = tool.renderResult?.(
      result,
      { expanded: false, isPartial: false },
      plainTheme,
      { lastComponent: undefined, state: renderState, isError: false, invalidate: () => {} },
    );
    assert.ok(collapsedResult);
    assert.doesNotMatch(stripVTControlCharacters(collapsedResult.render(120).join("\n")), /terminal snapshot/);

    const expandedResult = tool.renderResult?.(
      result,
      { expanded: true, isPartial: false },
      plainTheme,
      { lastComponent: collapsedResult, state: renderState, isError: false, invalidate: () => {} },
    );
    assert.ok(expandedResult);
    assert.match(stripVTControlCharacters(expandedResult.render(120).join("\n")), /terminal snapshot/);
  }

  await lifecycle.get("session_shutdown")?.({}, ctx);
});
