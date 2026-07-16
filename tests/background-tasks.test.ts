import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import backgroundTasks from "../extensions/background-tasks/index.ts";

interface RegisteredTool {
  name: string;
  promptGuidelines?: string[];
  parameters: {
    properties?: Record<string, { minimum?: number; maximum?: number }>;
  };
  executionMode?: string;
  execute: (...args: any[]) => Promise<any>;
}

interface SentMessage {
  message: { customType: string; content: string; details?: unknown };
  options?: { deliverAs?: string; triggerTurn?: boolean };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

function createHarness() {
  const tools = new Map<string, RegisteredTool>();
  const lifecycle = new Map<string, (...args: any[]) => Promise<void> | void>();
  const eventBus = new EventEmitter();
  const messages: SentMessage[] = [];
  const children: FakeChildProcess[] = [];

  const pi = {
    events: {
      on: (name: string, handler: (...args: any[]) => void) => eventBus.on(name, handler),
      emit: (name: string, payload: unknown) => eventBus.emit(name, payload),
    },
    on: (name: string, handler: (...args: any[]) => Promise<void> | void) => lifecycle.set(name, handler),
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: () => {},
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
  });
  return { tools, lifecycle, messages, children, ctx };
}

test("background tasks notify once, discourage polling, and expose the latest log", async () => {
  const { tools, lifecycle, messages, children, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgStatus = tools.get("bg_status");
  const bgStop = tools.get("bg_stop");
  assert.ok(bgStart && bgStatus && bgStop);

  assert.equal(bgStatus.executionMode, "sequential");
  assert.match(bgStart.promptGuidelines?.join("\n") ?? "", /do not poll bg_status/i);
  assert.match(bgStatus.promptGuidelines?.join("\n") ?? "", /Do not poll bg_status/);
  assert.equal(bgStart.parameters.properties?.wait.minimum, 1);
  assert.equal(bgStart.parameters.properties?.wait.maximum, 3600);

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
  assert.match(first.content[0].text, /do not poll bg_status/i);
  setTimeout(() => {
    children[0].stdout.write("first\nlast\n");
    children[0].finish(0, null);
  }, 40);

  const startedAt = Date.now();
  const listResult = await bgStatus.execute("status-list", {}, undefined, undefined, ctx);
  assert.ok(Date.now() - startedAt >= 20, "the first status check should wait until the task changes or its delay expires");
  assert.match(listResult.content[0].text, /Latest log: \[stdout\] last/);

  await waitFor(() => messages.length === 1);
  assert.equal(messages[0].message.customType, "background-task-complete");
  assert.match(messages[0].message.content, /completed/);
  assert.match(messages[0].message.content, /Latest log: \[stdout\] last/);
  assert.deepEqual(messages[0].options, { deliverAs: "followUp", triggerTurn: true });

  const detailResult = await bgStatus.execute("status-detail", { id: firstId }, undefined, undefined, ctx);
  assert.match(detailResult.content[0].text, /Latest log: \[stdout\] last/);
  assert.equal(detailResult.details.latestLog.text, "last");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(messages.length, 1, "completion should be notified exactly once");

  const longRunning = await bgStart.execute(
    "start-2",
    { name: "cancel-status", command: "fake long-running command", wait: 5 },
    undefined,
    undefined,
    ctx,
  );
  const longRunningId = longRunning.details.id as string;
  const abortController = new AbortController();
  const statusPromise = bgStatus.execute("status-cancel", { id: longRunningId }, abortController.signal, undefined, ctx);
  setTimeout(() => abortController.abort(new Error("cancelled by test")), 30);
  await assert.rejects(statusPromise, /cancelled by test/);

  const stopResult = await bgStop.execute(
    "stop-2",
    { id: longRunningId, force: true },
    undefined,
    undefined,
    ctx,
  );
  assert.match(stopResult.content[0].text, /Status: stopped/);
  assert.equal(messages.length, 1, "an explicit stop should not enqueue a duplicate completion follow-up");

  await lifecycle.get("session_shutdown")?.({}, ctx);
});
