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
    ui: {
      setWidget: (key: string, widget: unknown) => {
        if (widget === undefined) widgets.delete(key);
        else widgets.set(key, widget);
      },
      notify: () => {},
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
  });
  return { tools, commands, lifecycle, messages, children, ptys, widgets, ctx };
}

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
  assert.equal(bgStart.parameters.properties?.wait.minimum, 1);
  assert.equal(bgStart.parameters.properties?.wait.maximum, 3600);
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
      wait: 1,
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
    { name: "cancel-status", command: "fake long-running command", wait: 5 },
    undefined,
    undefined,
    ctx,
  );
  const longRunningId = longRunning.details.id as string;
  const abortController = new AbortController();
  const waitPromise = bgWait.execute("wait-cancel", { id: longRunningId, timeout: 5 }, abortController.signal, undefined, ctx);
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

test("background task widget renders running tasks as a tree", async () => {
  const { tools, lifecycle, ptys, widgets, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  assert.ok(bgStart);

  const widgetCtx = { ...ctx, hasUI: true } as ExtensionContext;
  await lifecycle.get("session_start")?.({}, widgetCtx);
  await bgStart.execute(
    "widget-pty-pro",
    { name: "pi-debate-pro", command: "fake pro", pty: true, cols: 100, rows: 25 },
    undefined,
    undefined,
    widgetCtx,
  );
  await bgStart.execute(
    "widget-pty-con",
    { name: "pi-debate-con", command: "fake con", pty: true, cols: 100, rows: 25 },
    undefined,
    undefined,
    widgetCtx,
  );

  const widgetFactory = widgets.get("bg-tasks-widget");
  assert.ok(widgetFactory);
  const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const lines = widgetFactory({}, plainTheme).render(200).map((line: string) => line.trimEnd());
  assert.equal(lines[0], "2 background tasks");
  assert.match(lines[1], /^├─ pi-debate-pro \([a-z0-9]+\) \d+ms pty:100x25$/);
  assert.match(lines[2], /^└─ pi-debate-con \([a-z0-9]+\) \d+ms pty:100x25$/);

  ptys[0].finish(0);
  ptys[1].finish(0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await lifecycle.get("session_shutdown")?.({}, widgetCtx);
});

test("pipe tasks attach to live output without replaying historical logs", async () => {
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
  children[0].stdout.write("BEFORE_ATTACH\n");

  const completions = commands.get("bg-attach").getArgumentCompletions("");
  assert.ok(completions.some((item: { value: string; label: string }) => item.value === id && item.label.includes("[pipe]")));

  await new Promise<void>((resolve) => setImmediate(resolve));
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const notifications: string[] = [];
  const stdout = process.stdout as NodeJS.WriteStream;
  const stderr = process.stderr as NodeJS.WriteStream;
  const originalStdoutWrite = stdout.write;
  const originalStderrWrite = stderr.write;
  (stdout as any).write = (chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  (stderr as any).write = (chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
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
          process.stdin.emit("data", "IGNORED_INPUT");
          children[0].stdout.write("LIVE_STDOUT\n");
          children[0].stderr.write("LIVE_STDERR\n");
          setImmediate(() => {
            component.dispose();
            queueMicrotask(() => children[0].finish(0, null));
          });
        });
      }),
    },
  } as unknown as ExtensionContext;

  try {
    await commands.get("bg-attach").handler(id, attachCtx);
  } finally {
    (stdout as any).write = originalStdoutWrite;
    (stderr as any).write = originalStderrWrite;
  }

  const attachedStdout = stdoutChunks.join("");
  const attachedStderr = stderrChunks.join("");
  assert.match(attachedStdout, /Streaming new output/);
  assert.match(attachedStdout, /LIVE_STDOUT/);
  assert.doesNotMatch(attachedStdout, /BEFORE_ATTACH/);
  assert.match(attachedStderr, /LIVE_STDERR/);
  assert.equal(children[0].stdin.read(), null, "pipe attachment must not forward keyboard input");
  assert.deepEqual(notifications, ['Pipe task "pipe-attach" completed (exit code 0).']);

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
        setTimeout(() => component.dispose(), 10);
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

  assert.deepEqual(attachOrder, ["pause", "resize:80x24", "clear", "snapshot", "resume"]);
  assert.deepEqual(attachNotifications, ['Detached from "pty-demo".']);
  assert.equal(pty.cols, 80);
  assert.equal(pty.rows, 24);

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
    const collapsedCall = tool.renderCall?.(args, plainTheme, { lastComponent: undefined, expanded: false });
    assert.ok(collapsedCall);
    assert.match(stripVTControlCharacters(collapsedCall.render(120).join("\n")), /to expand/);

    const collapsedResult = tool.renderResult?.(
      result,
      { expanded: false, isPartial: false },
      plainTheme,
      { lastComponent: undefined },
    );
    assert.ok(collapsedResult);
    assert.doesNotMatch(stripVTControlCharacters(collapsedResult.render(120).join("\n")), /terminal snapshot/);

    const expandedResult = tool.renderResult?.(
      result,
      { expanded: true, isPartial: false },
      plainTheme,
      { lastComponent: collapsedResult },
    );
    assert.ok(expandedResult);
    assert.match(stripVTControlCharacters(expandedResult.render(120).join("\n")), /terminal snapshot/);
  }

  await lifecycle.get("session_shutdown")?.({}, ctx);
});
