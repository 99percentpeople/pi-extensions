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
      setWidget: () => {},
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
  return { tools, commands, lifecycle, messages, children, ptys, ctx };
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

  assert.equal(bgWait.executionMode, "sequential");
  assert.equal(bgStatus.executionMode, "sequential");
  assert.match(bgStart.promptGuidelines?.join("\n") ?? "", /instead of polling bg_status or bg_logs/i);
  assert.match(bgStatus.promptGuidelines?.join("\n") ?? "", /Do not poll bg_status/);
  assert.match(bgLogs.promptGuidelines?.join("\n") ?? "", /Do not repeatedly call bg_logs/);
  assert.match(bgWait.promptGuidelines?.join("\n") ?? "", /instead of polling bg_status\/bg_logs/i);
  assert.equal(bgStart.parameters.properties?.wait.minimum, 1);
  assert.equal(bgStart.parameters.properties?.wait.maximum, 3600);
  assert.equal(bgWait.parameters.properties?.timeout.minimum, 1);
  assert.equal(bgWait.parameters.properties?.timeout.maximum, 3600);

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

  const killResult = await bgKill.execute(
    "kill-2",
    { id: longRunningId, force: true },
    undefined,
    undefined,
    ctx,
  );
  assert.match(killResult.content[0].text, /Status: stopped/);
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
  const ctrlResult = await bgSend.execute(
    "send-ctrl-c",
    { id: ctrlTaskId, text: "ctrl+c" },
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

  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("PTY tasks preserve terminal state and use terminal input semantics", async () => {
  const { tools, lifecycle, ptys, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgWait = tools.get("bg_wait");
  const bgLogs = tools.get("bg_logs");
  const bgSend = tools.get("bg_send");
  const bgKill = tools.get("bg_kill");
  assert.ok(bgStart && bgWait && bgLogs && bgSend && bgKill);

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
    { id, text: "Alice" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(sent.content[0].text, /Sent to/);
  assert.equal(Buffer.from(ptys[0].writes.at(-1) as Buffer).toString("utf8"), "Alice\r");

  const interrupted = await bgSend.execute(
    "pty-ctrl-c",
    { id, text: "ctrl+c" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(interrupted.content[0].text, /Sent ctrl\+c/);
  assert.deepEqual(Buffer.from(ptys[0].writes.at(-1) as Buffer), Buffer.from([0x03]));
  assert.equal(ptys[0].closed, false, "PTY Ctrl+C should be terminal input, not an immediate kill");

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
  assert.match(waited.content[0].text, /Latest log: \[terminal\] DONE/);

  const killStarted = await bgStart.execute(
    "pty-kill-start",
    { name: "pty-kill", command: "fake persistent tui", pty: true },
    undefined,
    undefined,
    ctx,
  );
  const killed = await bgKill.execute(
    "pty-kill",
    { id: killStarted.details.id, force: true },
    undefined,
    undefined,
    ctx,
  );
  assert.match(killed.content[0].text, /Status: stopped/);

  await lifecycle.get("session_shutdown")?.({}, ctx);
});
