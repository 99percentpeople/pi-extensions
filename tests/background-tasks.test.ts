import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { IPty } from "node-pty";
import backgroundTasks, {
  BACKGROUND_COLLAPSED_TASK_LIMIT_PRESETS,
  BACKGROUND_SEND_SIGNALS,
  DEFAULT_BACKGROUND_TASKS_CONFIG,
  MemoryLogStore,
  OUTPUT_PREVIEW_LABELS,
  loadBackgroundTasksConfig,
  normalizeBackgroundTasksConfig,
  saveBackgroundTasksConfig,
  type BackgroundTasksConfig,
} from "../extensions/background-tasks/index.ts";

initTheme("dark", false);

interface RegisteredTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: {
    properties?: Record<string, { description?: string; minimum?: number; maximum?: number; enum?: string[] }>;
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
  readonly killSignals: NodeJS.Signals[] = [];
  private closed = false;

  constructor(readonly pid: number) {
    super();
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("exit", code, signal);
    let endedStreams = 0;
    const emitClose = () => {
      endedStreams += 1;
      if (endedStreams === 2) this.emit("close", code, signal);
    };
    this.stdout.once("end", emitClose);
    this.stderr.once("end", emitClose);
    this.stdout.end();
    this.stderr.end();
  }

  exitWithoutClosingStreams(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("exit", code, signal);
  }

  emitCloseWithoutExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit("close", code, signal);
  }

  failToSpawn(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("error", error);
    this.emit("close", null, null);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
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

class FakeTerminalInput extends EventEmitter {
  isRaw = false;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }

  setEncoding(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  resume(): this {
    return this;
  }
}

class FakeTerminalOutput extends EventEmitter {
  columns = process.stdout.columns;
  rows = process.stdout.rows;
  writeHandler: (chunk: string | Uint8Array) => boolean = () => true;

  write(chunk: string | Uint8Array): boolean {
    return this.writeHandler(chunk);
  }
}

const harnessCleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  const cleanups = Array.from(harnessCleanups).reverse();
  harnessCleanups.clear();
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

function createHarness(
  config: BackgroundTasksConfig = DEFAULT_BACKGROUND_TASKS_CONFIG,
) {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, any>();
  const lifecycle = new Map<string, (...args: any[]) => Promise<void> | void>();
  const eventBus = new EventEmitter();
  const messages: SentMessage[] = [];
  const children: FakeChildProcess[] = [];
  const ptys: FakePty[] = [];
  const widgets = new Map<string, any>();
  const widgetUpdates: Array<{ key: string; widget: unknown; options?: unknown }> = [];
  const terminalInput = new FakeTerminalInput();
  const terminalOutput = new FakeTerminalOutput();
  let branch: unknown[] = [];
  let toolsExpanded = false;

  const pi = {
    events: {
      on: (name: string, handler: (...args: any[]) => void) => eventBus.on(name, handler),
      emit: (name: string, payload: unknown) => eventBus.emit(name, payload),
    },
    on: (name: string, handler: (...args: any[]) => Promise<void> | void) => lifecycle.set(name, handler),
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ type: "custom", customType, data });
    },
    sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    mode: "tui",
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => [...branch],
    },
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

  const testSpawn = () => {
    const child = new FakeChildProcess(90_000_000 + children.length);
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const testPtySpawn = (
    _file: string,
    _args: string[] | string,
    options: { cols?: number; rows?: number },
  ) => {
    const pty = new FakePty(91_000_000 + ptys.length, options.cols ?? 80, options.rows ?? 24);
    ptys.push(pty);
    return pty as unknown as IPty;
  };
  backgroundTasks(pi, {
    loadConfig: () => ({ ...config }),
    saveConfig: () => {},
    spawnProcess: testSpawn,
    ptySpawnProcess: testPtySpawn as typeof import("node-pty").spawn,
    killWindowsProcessTree: async (pid, signal) => {
      const child = children.find((candidate) => candidate.pid === pid);
      if (child) {
        child.kill(signal);
        return;
      }
      const pty = ptys.find((candidate) => candidate.pid === pid);
      if (pty) {
        pty.kill(signal);
        return;
      }
      throw new Error(`Fake process tree not found: ${pid}`);
    },
    terminalInput: terminalInput as unknown as NodeJS.ReadStream,
    terminalOutput: terminalOutput as unknown as NodeJS.WriteStream,
  });
  const registerTestProvider = (registration: Record<string, unknown>): void => {
    eventBus.emit("bg:register", {
      id: "test-default",
      priority: -100,
      spawn: testSpawn,
      ptySpawn: testPtySpawn,
      ...registration,
    });
  };
  registerTestProvider({
    resolveShell: (command: string) => ({
      file: "test-bash",
      args: ["-c", command],
      env: { ...process.env },
    }),
  });
  const registeredShutdown = lifecycle.get("session_shutdown");
  let cleaned = false;
  const cleanupAfterTest = async () => {
    await cleanup({}, ctx);
  };
  const cleanup = async (event: unknown = {}, shutdownCtx: ExtensionContext = ctx) => {
    if (cleaned) return;
    if ((event as { reason?: string }).reason === "reload") {
      await registeredShutdown?.(event, shutdownCtx);
      return;
    }
    cleaned = true;
    harnessCleanups.delete(cleanupAfterTest);
    await registeredShutdown?.(event, shutdownCtx);
  };
  lifecycle.set("session_shutdown", cleanup);
  harnessCleanups.add(cleanupAfterTest);
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
    terminalInput,
    terminalOutput,
    registerTestProvider,
    ctx,
    cleanup: cleanupAfterTest,
    getBranch: () => [...branch],
    setBranch: (entries: unknown[]) => { branch = [...entries]; },
    setToolsExpanded: (value: boolean) => { toolsExpanded = value; },
  };
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForRenderedText(chunks: string[], pattern: RegExp, timeoutMs = 2_000): Promise<void> {
  await waitForCondition(
    () => pattern.test(chunks.join("")),
    `rendered output matching ${pattern}; received ${JSON.stringify(chunks.join(""))}`,
    timeoutMs,
  );
}

function createAttachCustom(
  drive: (component: { dispose(): void }) => Promise<void> | void,
): (factory: any) => Promise<unknown> {
  return (factory: any) => new Promise((resolve, reject) => {
    const tui = { stop: () => {}, start: () => {}, requestRender: () => {} };
    const component = factory(tui, {}, {}, resolve);
    queueMicrotask(async () => {
      try {
        await drive(component);
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("memory log store retains only its configured capacity", () => {
  const logStore = new MemoryLogStore(12);
  const key = "task:stdout";

  logStore.append(key, "one\ntwo\n");
  logStore.append(key, Buffer.from("three\n"));
  assert.equal(logStore.size(key), 12);
  assert.equal(logStore.read(key), "e\ntwo\nthree\n");

  logStore.append(key, "abcdefghijklmnop");
  assert.equal(logStore.size(key), 12);
  assert.equal(logStore.read(key), "efghijklmnop");

  logStore.delete(key);
  assert.equal(logStore.read(key), "");
  assert.throws(() => new MemoryLogStore(0), /positive integer/);
});

test("background task settings normalize and persist widget display options", async () => {
  assert.deepEqual(BACKGROUND_COLLAPSED_TASK_LIMIT_PRESETS, [0, 1, 3, 5]);
  assert.deepEqual(OUTPUT_PREVIEW_LABELS, {
    off: "Off",
    failures: "Failures",
    finished: "Finished",
    all: "All pipe tasks",
  });
  assert.deepEqual(
    normalizeBackgroundTasksConfig(undefined),
    DEFAULT_BACKGROUND_TASKS_CONFIG,
  );
  assert.deepEqual(normalizeBackgroundTasksConfig({
    collapsedTaskLimit: 3,
    outputPreview: "all",
  }), {
    collapsedTaskLimit: 3,
    outputPreview: "all",
  });
  assert.deepEqual(normalizeBackgroundTasksConfig({
    collapsedTaskLimit: 11,
    outputPreview: "unknown",
  }), DEFAULT_BACKGROUND_TASKS_CONFIG);

  const directory = await mkdtemp(join(tmpdir(), "pi-background-settings-"));
  const path = join(directory, "99extensions.json");
  try {
    await writeFile(path, '{"unknown":{"keep":true}}\n', "utf8");
    saveBackgroundTasksConfig({ collapsedTaskLimit: 1, outputPreview: "failures" }, path);
    assert.deepEqual(loadBackgroundTasksConfig(path), {
      collapsedTaskLimit: 1,
      outputPreview: "failures",
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      unknown: { keep: true },
      "background-tasks": {
        collapsedTaskLimit: 1,
        outputPreview: "failures",
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("background tasks can pass commands through Pi's stdin shell transport", async () => {
  const { tools, lifecycle, registerTestProvider, children, ctx } = createHarness();
  registerTestProvider({
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

test("shell adapters can separate a logical task cwd from the local launch cwd", async () => {
  const { tools, lifecycle, registerTestProvider, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  assert.ok(bgStart);

  let resolverCwd: string | undefined;
  let launchCwd: string | undefined;
  const child = new FakeChildProcess(92_000_000);
  registerTestProvider({
    resolveShell: (
      command: string,
      _interactive: boolean,
      context?: { cwd: string },
    ) => {
      resolverCwd = context?.cwd;
      return {
        file: "ssh",
        args: ["remote", command],
        env: { ...process.env },
        cwd: "/local/ssh-anchor",
      };
    },
    spawn: (
      _file: string,
      _args: readonly string[],
      options: { cwd?: string },
    ) => {
      launchCwd = options.cwd;
      return child as unknown as ChildProcess;
    },
  });

  await bgStart.execute(
    "remote-cwd-start",
    { name: "remote-cwd", command: "pwd", cwd: "/srv/remote-only" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(resolverCwd, "/srv/remote-only");
  assert.equal(launchCwd, "/local/ssh-anchor");

  child.finish(0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("adapter controls target remote tasks instead of local transport processes", async () => {
  const { tools, lifecycle, registerTestProvider, children, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgSend = tools.get("bg_send");
  const bgKill = tools.get("bg_kill");
  const bgStatus = tools.get("bg_status");
  const bgWait = tools.get("bg_wait");
  assert.ok(bgStart && bgSend && bgKill && bgStatus && bgWait);

  const remoteSignals: NodeJS.Signals[] = [];
  registerTestProvider({
    resolveShell: (command: string) => ({
      file: "ssh",
      args: ["remote", command],
      env: { ...process.env },
      control: {
        sendSignal: async (signal: NodeJS.Signals) => {
          remoteSignals.push(signal);
          if (signal === "SIGTERM" || signal === "SIGKILL") {
            children[0]?.finish(143, null);
          }
        },
        probe: async () => "running" as const,
        onTransportExit: async () => ({ state: "finished" as const }),
        dispose: async () => {},
      },
      taskEnvironment: "SSH devbox:/srv/project",
    }),
  });

  const started = await bgStart.execute(
    "remote-signal-start",
    { name: "remote-signal", command: "sleep 30" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(children.length, 1);

  const sent = await bgSend.execute(
    "remote-signal-send",
    { id: started.details.id, signal: "SIGUSR1" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(sent.content[0].text, /Sent SIGUSR1/);
  assert.deepEqual(remoteSignals, ["SIGUSR1"]);
  assert.deepEqual(
    children[0].killSignals,
    [],
    "the local ssh launcher must not receive the remote signal",
  );
  const running = await bgStatus.execute(
    "remote-signal-status",
    { id: started.details.id },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(running.details.status, "running");

  const killed = await bgKill.execute(
    "remote-signal-kill",
    { id: started.details.id },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(remoteSignals, ["SIGUSR1", "SIGTERM"]);
  assert.deepEqual(children[0].killSignals, []);
  assert.equal(killed.details.status, "stopped");
  assert.equal(killed.details.signal, "SIGTERM");

  const waited = await bgWait.execute(
    "remote-signal-wait",
    { id: started.details.id, timeout: 1 },
    undefined,
    undefined,
    ctx,
  );
  assert.match(waited.content[0].text, /\n  Environment: SSH devbox:\/srv\/project/);
  assert.match(waited.content[0].text, /\n  Status:      stopped/);
  assert.match(waited.content[0].text, /\n  Duration:    \S+/);
  assert.match(waited.content[0].text, /\n  Exit code:   143/);
  assert.match(waited.content[0].text, /\n  Signal:      SIGTERM/);

  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("adapter controls survive a lost local transport and can finish a disconnected task", async () => {
  const { tools, lifecycle, eventBus, children, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgStatus = tools.get("bg_status");
  const bgSend = tools.get("bg_send");
  const bgKill = tools.get("bg_kill");
  assert.ok(bgStart && bgStatus && bgSend && bgKill);

  const remoteSignals: string[] = [];
  let remoteRunning = true;
  let controlDisposals = 0;
  eventBus.emit("bg:register", {
    id: "remote-control-test",
    priority: 100,
    spawn: () => {
      const child = new FakeChildProcess(92_500_000 + children.length);
      children.push(child);
      return child as unknown as ChildProcess;
    },
    resolveShell: (command: string) => ({
      file: "ssh",
      args: ["remote", command],
      env: { ...process.env },
      taskEnvironment: "SSH devbox:/srv/project",
      control: {
        supportedSignals: ["SIGTERM", "SIGKILL"],
        terminatingSignals: ["SIGTERM", "SIGKILL"],
        signalTarget: "process tree",
        stdinAvailable: false,
        sendSignal: async (signal: string, options?: { abortSignal?: AbortSignal }) => {
          assert.notEqual(options?.abortSignal?.aborted, true);
          remoteSignals.push(signal);
          if (signal === "SIGKILL") remoteRunning = false;
        },
        probe: async () => remoteRunning ? "running" : "finished",
        onTransportExit: async () => ({
          state: "disconnected",
          error: "test transport unavailable",
        }),
        dispose: async () => {
          controlDisposals += 1;
        },
      },
    }),
  });

  const started = await bgStart.execute(
    "transport-loss-start",
    { name: "transport-loss", command: "sleep 30" },
    undefined,
    undefined,
    ctx,
  );
  children[0].finish(255, null);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const disconnected = await bgStatus.execute(
    "transport-loss-status",
    { id: started.details.id },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(disconnected.details.status, "disconnected");
  assert.match(disconnected.content[0].text, /test transport unavailable/);
  await lifecycle.get("before_agent_start")?.({}, ctx);
  const retainedDisconnected = await bgStatus.execute(
    "transport-loss-retained-status",
    { id: started.details.id },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(
    retainedDisconnected.details.status,
    "disconnected",
    "unconfirmed remote tasks must not be expired or persisted as finished",
  );

  const input = await bgSend.execute(
    "transport-loss-input",
    { id: started.details.id, input: "still there" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(input.content[0].text, /only adapter signals remain available/);

  const unsupported = await bgSend.execute(
    "transport-loss-unsupported-signal",
    { id: started.details.id, signal: "SIGUSR1" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(unsupported.content[0].text, /not supported by the process tree/);

  const killed = await bgKill.execute(
    "transport-loss-kill",
    { id: started.details.id, force: true },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(remoteSignals, ["SIGKILL"]);
  assert.equal(killed.details.status, "stopped");
  assert.equal(killed.details.signal, "SIGKILL");
  assert.deepEqual(children[0].killSignals, []);
  await waitForCondition(() => controlDisposals === 1, "adapter control disposal");

  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("adapter task environments stay bound to their launch and appear in bg tool results", async () => {
  const {
    tools,
    lifecycle,
    registerTestProvider,
    children,
    ctx,
    getBranch,
  } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgWait = tools.get("bg_wait");
  const bgStatus = tools.get("bg_status");
  const bgLogs = tools.get("bg_logs");
  const bgSend = tools.get("bg_send");
  const bgKill = tools.get("bg_kill");
  assert.ok(bgStart && bgWait && bgStatus && bgLogs && bgSend && bgKill);

  const registerSsh = (target: string, cwd: string) => {
    registerTestProvider({
      resolveShell: (command: string) => ({
        file: "ssh",
        args: [target, command],
        env: { ...process.env },
        taskEnvironment: `SSH ${target}:${cwd}`,
      }),
    });
  };
  const hostAEnvironment = "SSH host-a:/srv/a";
  registerSsh("host-a", "/srv/a");

  const first = await bgStart.execute(
    "environment-host-a-start",
    { name: "remote-a", command: "fake remote a" },
    undefined,
    undefined,
    ctx,
  );
  const firstId = first.details.id as string;
  assert.deepEqual(first.details.environment, hostAEnvironment);
  assert.match(first.content[0].text, /Environment: SSH host-a:\/srv\/a/);

  const list = await bgStatus.execute(
    "environment-host-a-list",
    {},
    undefined,
    undefined,
    ctx,
  );
  assert.match(list.content[0].text, /\[SSH host-a:\/srv\/a\]/);
  assert.deepEqual(list.details.tasks[0].environment, hostAEnvironment);

  const detail = await bgStatus.execute(
    "environment-host-a-detail",
    { id: firstId },
    undefined,
    undefined,
    ctx,
  );
  assert.match(detail.content[0].text, /Environment: SSH host-a:\/srv\/a/);
  assert.deepEqual(detail.details.environment, hostAEnvironment);

  children[0].stdout.write("REMOTE A OUTPUT\n");
  const logs = await bgLogs.execute(
    "environment-host-a-logs",
    { id: firstId, stream: "both" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(
    logs.content[0].text,
    /^Environment: SSH host-a:\/srv\/a\n── stdout ──\nREMOTE A OUTPUT$/,
  );
  assert.deepEqual(logs.details.environment, hostAEnvironment);

  const sent = await bgSend.execute(
    "environment-host-a-send",
    { id: firstId, input: "continue" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(sent.content[0].text, /on SSH host-a:\/srv\/a/);
  assert.deepEqual(sent.details.environment, hostAEnvironment);

  // Re-register another backend before host A finishes. Existing tasks must
  // retain their immutable launch environment while new tasks follow host B.
  registerSsh("host-b", "/srv/b");
  const afterSwitch = await bgStatus.execute(
    "environment-host-a-after-switch",
    { id: firstId },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(afterSwitch.details.environment, hostAEnvironment);

  children[0].finish(0, null);
  const waited = await bgWait.execute(
    "environment-host-a-wait",
    { id: firstId, timeout: 1 },
    undefined,
    undefined,
    ctx,
  );
  assert.match(waited.content[0].text, /Environment: SSH host-a:\/srv\/a/);
  assert.deepEqual(waited.details.environment, hostAEnvironment);

  const second = await bgStart.execute(
    "environment-host-b-start",
    { name: "remote-b", command: "fake remote b" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(second.details.environment, "SSH host-b:/srv/b");
  const killed = await bgKill.execute(
    "environment-host-b-kill",
    { id: second.details.id, force: true },
    undefined,
    undefined,
    ctx,
  );
  assert.match(killed.content[0].text, /on SSH host-b:\/srv\/b/);
  assert.equal(killed.details.environment, "SSH host-b:/srv/b");

  await waitForCondition(
    () => getBranch().some((entry: any) =>
      entry.data?.action === "upsert"
      && entry.data.task?.id === firstId
      && entry.data.task?.environment === hostAEnvironment),
    "persisted task environment",
  );
  await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  await lifecycle.get("session_start")?.({ reason: "reload" }, ctx);
  const restored = await bgStatus.execute(
    "environment-host-a-restored",
    { id: firstId },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(restored.details.environment, hostAEnvironment);

  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("background task widget shows compact adapter environment labels", async () => {
  const {
    tools,
    lifecycle,
    registerTestProvider,
    children,
    widgets,
    ctx,
  } = createHarness({
    collapsedTaskLimit: 1,
    outputPreview: "off",
  });
  const widgetCtx = { ...ctx, hasUI: true } as ExtensionContext;
  await lifecycle.get("session_start")?.({}, widgetCtx);
  registerTestProvider({
    resolveShell: (command: string) => ({
      file: "ssh",
      args: ["devbox", command],
      env: { ...process.env },
      taskEnvironment: "SSH devbox:/srv/project",
    }),
  });

  const bgStart = tools.get("bg_start");
  assert.ok(bgStart);
  await bgStart.execute(
    "widget-environment-start",
    { name: "remote-widget", command: "fake remote widget" },
    undefined,
    undefined,
    widgetCtx,
  );

  const widgetFactory = widgets.get("bg-tasks-widget");
  assert.ok(widgetFactory);
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const lines = widgetFactory({ requestRender: () => {} }, plainTheme)
    .render(200)
    .map((line: string) => stripVTControlCharacters(line).trimEnd());
  assert.match(lines[1], /^└─ ◐ remote-widget \([a-z0-9]+\) 0s stdout:0 stderr:0 @ SSH devbox:\/srv\/project$/);

  children[0].finish(0, null);
  await lifecycle.get("session_shutdown")?.({}, widgetCtx);
});

test("bg_start falls back to the default shell when the resolver returns undefined", async () => {
  const { tools, lifecycle, children, ctx, registerTestProvider } = createHarness();
  const bgStart = tools.get("bg_start");
  assert.ok(bgStart);
  registerTestProvider({
    resolveShell: () => undefined,
    spawn: () => {
      const child = new FakeChildProcess(92_000_000 + children.length);
      children.push(child);
      return child as unknown as ChildProcess;
    },
  });

  const result = await bgStart.execute(
    "fallback-default",
    { name: "fallback-default", command: "echo local" },
    undefined,
    undefined,
    ctx,
  );
  const text = result.content.map((item) => item.text ?? "").join(" ");
  assert.match(text, /fallback-default/i);
  assert.equal(children.length, 1);

  children[0].finish(0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("background backend registration rejects unnamed v1 providers", async () => {
  const { eventBus } = createHarness();
  assert.throws(
    () => eventBus.emit("bg:register", {
      resolveShell: () => ({
        file: "legacy-shell",
        args: [],
        env: { ...process.env },
      }),
    }),
    /requires protocol v2 with a valid id/,
  );
});

test("background backend registration validates optional provider callbacks", async () => {
  const { eventBus } = createHarness();
  assert.throws(
    () => eventBus.emit("bg:register", {
      id: "invalid-provider",
      resolveShell: () => undefined,
      spawn: "not-a-function",
    }),
    /provider spawn must be a function/,
  );
});

test("background task controls require the complete v2 lifecycle", async () => {
  const { tools, registerTestProvider, children, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  assert.ok(bgStart);
  registerTestProvider({
    resolveShell: (command: string) => ({
      file: "incomplete-control-shell",
      args: ["-c", command],
      env: { ...process.env },
      control: {
        sendSignal: async () => {},
      },
    }),
  });
  await assert.rejects(
    () => bgStart.execute(
      "incomplete-control",
      { name: "incomplete-control", command: "sleep 30" },
      undefined,
      undefined,
      ctx,
    ),
    /must implement probe\(\)/,
  );
  assert.equal(children.length, 0);
});

test("named shell providers use priority and fall through across environment transitions", async () => {
  const { tools, lifecycle, eventBus, children, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  assert.ok(bgStart);

  let remoteState: "active" | "disabled" | "failed" = "active";
  let acknowledgedProtocol = 0;
  const providerSpawns: string[] = [];
  const createProviderSpawn = (label: string) => () => {
    providerSpawns.push(label);
    const child = new FakeChildProcess(93_000_000 + children.length);
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const localProviderSpawn = createProviderSpawn("pwsh");
  const remoteProviderSpawn = createProviderSpawn("ssh");
  eventBus.emit("bg:register", {
    id: "pwsh-adapter",
    priority: 10,
    spawn: localProviderSpawn,
    resolveShell: (command: string) => ({
      file: "pwsh.exe",
      args: ["-Command", command],
      env: { ...process.env },
      taskEnvironment: "LOCAL PowerShell",
    }),
  });
  eventBus.emit("bg:register", {
    id: "ssh-remote",
    priority: 100,
    spawn: remoteProviderSpawn,
    resolveShell: (command: string) => {
      if (remoteState === "failed") throw new Error("SSH remote is unavailable");
      if (remoteState === "disabled") return undefined;
      return {
        file: "ssh",
        args: ["devbox", command],
        env: { ...process.env },
        taskEnvironment: "SSH devbox:/srv/project",
      };
    },
    onRegistered: (capabilities: { protocolVersion: number }) => {
      acknowledgedProtocol = capabilities.protocolVersion;
    },
  });
  assert.equal(acknowledgedProtocol, 2);

  // A later lower-priority registration must not steal an active SSH launch.
  eventBus.emit("bg:register", {
    id: "pwsh-adapter",
    priority: 10,
    spawn: localProviderSpawn,
    resolveShell: (command: string) => ({
      file: "pwsh.exe",
      args: ["-Command", command],
      env: { ...process.env },
      taskEnvironment: "LOCAL PowerShell",
    }),
  });
  const remote = await bgStart.execute(
    "provider-remote",
    { name: "provider-remote", command: "pwd" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(remote.details.environment, "SSH devbox:/srv/project");
  assert.deepEqual(providerSpawns, ["ssh"]);
  children[0].finish(0, null);

  remoteState = "disabled";
  const local = await bgStart.execute(
    "provider-local",
    { name: "provider-local", command: "Get-Location" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(local.details.environment, "LOCAL PowerShell");
  assert.deepEqual(providerSpawns, ["ssh", "pwsh"]);
  children[1].finish(0, null);

  remoteState = "failed";
  await assert.rejects(
    bgStart.execute(
      "provider-failed",
      { name: "provider-failed", command: "pwd" },
      undefined,
      undefined,
      ctx,
    ),
    /SSH remote is unavailable/,
  );

  eventBus.emit("bg:unregister", { id: "ssh-remote" });
  const afterUnregister = await bgStart.execute(
    "provider-unregistered",
    { name: "provider-unregistered", command: "Get-Location" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(afterUnregister.details.environment, "LOCAL PowerShell");
  assert.deepEqual(providerSpawns, ["ssh", "pwsh", "pwsh"]);
  children[2].finish(0, null);

  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("background task names are unique among retained tasks", async () => {
  const { tools, lifecycle, children, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  assert.ok(bgStart);

  const first = await bgStart.execute(
    "unique-name-first",
    { name: "  Build Server  ", command: "fake first build server" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(first.details.name, "Build Server", "task names should be trimmed before storage");

  await assert.rejects(
    bgStart.execute(
      "unique-name-running-duplicate",
      { name: "build server", command: "fake duplicate while running" },
      undefined,
      undefined,
      ctx,
    ),
    new RegExp(`name "build server" is already in use by task ${first.details.id} \\(running\\)`, "i"),
  );
  assert.equal(children.length, 1, "a duplicate name must be rejected before spawning");

  children[0].finish(0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    bgStart.execute(
      "unique-name-retained-duplicate",
      { name: "BUILD SERVER", command: "fake duplicate while retained" },
      undefined,
      undefined,
      ctx,
    ),
    /already in use.*completed/i,
  );
  assert.equal(children.length, 1, "a retained finished task should continue reserving its name");

  await lifecycle.get("before_agent_start")?.({}, ctx);
  const reused = await bgStart.execute(
    "unique-name-reused",
    { name: "build server", command: "fake reused build server" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(reused.details.name, "build server");
  assert.equal(children.length, 2, "the name may be reused after the old task expires");
  children[1].finish(0, null);
  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("pipe task status follows process exit rather than stdio close", async () => {
  const { tools, lifecycle, children, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgStatus = tools.get("bg_status");
  const bgKill = tools.get("bg_kill");
  assert.ok(bgStart && bgStatus && bgKill);

  const started = await bgStart.execute(
    "exit-with-open-stdio-start",
    { name: "exit-with-open-stdio", command: "fake inherited stdio handles" },
    undefined,
    undefined,
    ctx,
  );
  const id = started.details.id as string;
  children[0].stdout.write("final output before shell exit\n");
  children[0].exitWithoutClosingStreams(0, null);

  const status = await bgStatus.execute("exit-with-open-stdio-status", { id }, undefined, undefined, ctx);
  assert.equal(status.details.status, "completed");
  assert.equal(status.details.exitCode, 0);
  assert.doesNotMatch(status.content[0].text, /Use bg_wait to await completion/);

  const killed = await bgKill.execute("exit-with-open-stdio-kill", { id }, undefined, undefined, ctx);
  assert.match(killed.content[0].text, /already completed/);
  assert.doesNotMatch(killed.content[0].text, /Failed to send|process.*not found/i);

  const closeOnly = await bgStart.execute(
    "close-without-exit-start",
    { name: "close-without-exit", command: "fake close before exit" },
    undefined,
    undefined,
    ctx,
  );
  const closeOnlyId = closeOnly.details.id as string;
  children[1].emitCloseWithoutExit(0, null);
  const stillRunning = await bgStatus.execute(
    "close-without-exit-status",
    { id: closeOnlyId },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(stillRunning.details.status, "running", "close must not drive process state");
  children[1].finish(0, null);

  const failedSpawn = await bgStart.execute(
    "spawn-error-start",
    { name: "spawn-error", command: "fake spawn error" },
    undefined,
    undefined,
    ctx,
  );
  const failedSpawnId = failedSpawn.details.id as string;
  children[2].failToSpawn(new Error("spawn ENOENT"));
  const failedStatus = await bgStatus.execute(
    "spawn-error-status",
    { id: failedSpawnId },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(failedStatus.details.status, "failed", "a pre-spawn error must be terminal without exit");
  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("empty logs only say yet while a task is still running", async () => {
  const { tools, lifecycle, children, ptys, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgLogs = tools.get("bg_logs");
  assert.ok(bgStart && bgLogs);

  const pipe = await bgStart.execute(
    "empty-pipe-start",
    { name: "empty-pipe", command: "exit 3" },
    undefined,
    undefined,
    ctx,
  );
  const runningPipeLogs = await bgLogs.execute(
    "empty-pipe-running-logs",
    { id: pipe.details.id },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(runningPipeLogs.content[0].text, "(no output yet)");

  children[0].finish(3, null);
  const failedPipeLogs = await bgLogs.execute(
    "empty-pipe-failed-logs",
    { id: pipe.details.id },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(failedPipeLogs.details.status, "failed");
  assert.equal(failedPipeLogs.content[0].text, "(no output)");

  const pty = await bgStart.execute(
    "empty-pty-start",
    { name: "empty-pty", command: "exit 3", pty: true },
    undefined,
    undefined,
    ctx,
  );
  const runningPtyLogs = await bgLogs.execute(
    "empty-pty-running-logs",
    { id: pty.details.id },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(runningPtyLogs.content[0].text, "(no terminal output yet)");

  ptys[0].finish(3);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const failedPtyLogs = await bgLogs.execute(
    "empty-pty-failed-logs",
    { id: pty.details.id },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(failedPtyLogs.details.status, "failed");
  assert.equal(failedPtyLogs.content[0].text, "(no terminal output)");

  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("background tool calls never render undefined while arguments stream", () => {
  const { tools } = createHarness();
  const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const names = ["bg_start", "bg_wait", "bg_status", "bg_logs", "bg_send", "bg_kill"];

  for (const name of names) {
    const tool = tools.get(name);
    assert.ok(tool?.renderCall);
    const initial = tool.renderCall(
      {},
      plainTheme,
      {
        lastComponent: undefined,
        expanded: false,
        argsComplete: false,
        executionStarted: false,
        state: {},
      },
    );
    const initialText = stripVTControlCharacters(initial.render(160).join("\n"));
    assert.doesNotMatch(initialText, /undefined|null/, `${name} should hide missing streamed arguments`);
    assert.doesNotMatch(initialText, /\.\.\./, `${name} should omit missing streamed arguments`);

    const partialArgs = name === "bg_start" ? { name: "streamed-task" } : { id: "draft-id" };
    const updated = tool.renderCall(
      partialArgs,
      plainTheme,
      {
        lastComponent: initial,
        expanded: false,
        argsComplete: false,
        executionStarted: false,
        state: {},
      },
    );
    assert.strictEqual(updated, initial, `${name} should update its existing streamed component`);
    assert.doesNotMatch(
      stripVTControlCharacters(updated.render(160).join("\n")),
      /undefined|null/,
      `${name} should remain safe after a sparse argument update`,
    );
  }

  const status = tools.get("bg_status");
  assert.ok(status?.renderCall);
  const completeList = status.renderCall(
    {},
    plainTheme,
    {
      lastComponent: undefined,
      expanded: false,
      argsComplete: true,
      executionStarted: false,
      state: {},
    },
  );
  assert.match(stripVTControlCharacters(completeList.render(160).join("\n")), /bg_status all/);
});

test("background task tools return latest pipe summaries while keeping full output separate", async () => {
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

  const registeredTools = [bgStart, bgWait, bgStatus, bgLogs, bgSend, bgKill];
  for (const tool of registeredTools) {
    assert.equal(tool.executionMode, "parallel");
    for (const guideline of tool.promptGuidelines ?? []) {
      assert.match(guideline, /\bbg_(?:start|wait|status|logs|send|kill)\b/, `${tool.name} guidelines must name their tool context`);
    }
  }
  const allGuidelines = registeredTools.flatMap((tool) => tool.promptGuidelines ?? []);
  const bgStartGuidance = bgStart.promptGuidelines?.join("\n") ?? "";
  assert.match(bgStart.description ?? "", /only when background execution is genuinely needed/i);
  assert.match(bgStart.promptSnippet ?? "", /genuinely asynchronous.*concurrent work.*later interaction/i);
  assert.match(
    bgStartGuidance,
    /only when.*explicitly requests background execution.*remain available for later interaction.*independent useful work concurrently/i,
  );
  assert.match(
    bgStartGuidance,
    /do not use bg_start merely because.*slow.*bash tool.*appropriate timeout.*instead of bg_start.*bg_wait.*bg_logs/i,
  );
  assert.match(
    bgWait.promptGuidelines?.join("\n") ?? "",
    /never create a bg_start task solely so you can wait on it/i,
  );
  const orderingRules = allGuidelines.filter((guideline) => /strictly in source order/i.test(guideline));
  assert.equal(orderingRules.length, 1, "same-task ordering should be explained by one shared rule");
  assert.match(orderingRules[0], /compose complete bg_\* workflows in one assistant response/i);
  assert.match(orderingRules[0], /task ID or unique name/i);
  assert.match(orderingRules[0], /bg_start\(name=.*bg_wait\(id=.*bg_logs\(id=/i);
  assert.match(orderingRules[0], /different tasks execute in parallel/i);
  assert.match(orderingRules[0], /bg_status without id is independent/i);
  const lifecycleRules = allGuidelines.filter((guideline) => /survives ordinary agent runs/i.test(guideline));
  assert.equal(lifecycleRules.length, 1, "task lifetime and snapshot retention should use one shared rule");
  assert.match(lifecycleRules[0], /session reload or shutdown terminates it/i);
  assert.match(lifecycleRules[0], /finishing during a run.*retained through that run/i);
  assert.match(lifecycleRules[0], /still running when the agent settled.*finishes while idle.*retained through the next run/i);
  assert.match(
    bgStart.promptGuidelines?.join("\n") ?? "",
    /bg_wait includes the latest pipe log line.*place bg_logs.*only when full or multiline pipe output or PTY terminal output/i,
  );
  assert.match(
    bgStatus.promptGuidelines?.join("\n") ?? "",
    /includes the latest pipe log line.*bg_logs.*full or multiline pipe output.*PTY terminal output/i,
  );
  assert.match(
    bgLogs.promptGuidelines?.join("\n") ?? "",
    /more than the latest pipe log line returned by bg_wait or bg_status.*PTY terminal output/i,
  );
  assert.match(bgLogs.promptGuidelines?.join("\n") ?? "", /fuller finite output.*bg_wait followed by bg_logs/i);
  assert.match(
    bgWait.promptGuidelines?.join("\n") ?? "",
    /completion status plus the latest pipe log line.*only when full or multiline pipe output or PTY terminal output.*do not wait for the bg_wait result/i,
  );
  assert.match(bgWait.promptGuidelines?.join("\n") ?? "", /timeout leaves the task running.*latest pipe log line/i);
  assert.match(bgSend.promptGuidelines?.join("\n") ?? "", /Use bg_send input for terminal keys/i);
  assert.match(bgKill.promptGuidelines?.join("\n") ?? "", /termination status only.*bg_kill followed by bg_logs/i);
  for (const tool of [bgWait, bgStatus, bgLogs, bgSend, bgKill]) {
    assert.match(tool.parameters.properties?.id?.description ?? "", /Task ID or unique name/i);
  }
  assert.equal(bgStart.parameters.properties?.wait, undefined);
  assert.equal(bgWait.parameters.properties?.timeout.minimum, 1);
  assert.equal(bgWait.parameters.properties?.timeout.maximum, 3600);
  assert.equal(bgWait.parameters.properties?.terminal_snapshot, undefined);
  assert.equal(bgStatus.parameters.properties?.terminal_snapshot, undefined);
  assert.equal(bgKill.parameters.properties?.terminal_snapshot, undefined);
  assert.ok(bgSend.parameters.properties?.input);
  assert.deepEqual(
    bgSend.parameters.properties?.signal.enum,
    BACKGROUND_SEND_SIGNALS,
    "bg_send should expose the portable local/remote signal vocabulary",
  );
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
  assert.match(first.content[0].text, /bg_wait.*includes the latest pipe log line.*bg_logs only for full or PTY output/i);
  let firstWaitSettled = false;
  const firstWait = bgWait.execute("wait-1", { id: firstId, timeout: 1 }, undefined, undefined, ctx)
    .then((result) => {
      firstWaitSettled = true;
      return result;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstWaitSettled, false, "bg_wait should remain pending while the task is running");
  children[0].stdout.write("first\nlast\n");
  children[0].finish(0, null);
  const waitResult = await firstWait;
  assert.match(waitResult.content[0].text, /completed/);
  assert.match(waitResult.content[0].text, /Latest log:\s+\[stdout\] last/);
  assert.doesNotMatch(waitResult.content[0].text, /\bfirst\b/);
  assert.equal(waitResult.details.timedOut, false);
  assert.equal(waitResult.details.latestLog.stream, "stdout");
  assert.equal(waitResult.details.latestLog.text, "last");
  assert.equal(typeof waitResult.details.latestLog.at, "number");
  assert.equal(messages.length, 0, "completion should not enqueue an AI follow-up notification");

  const detailResult = await bgStatus.execute("status-detail", { id: firstId }, undefined, undefined, ctx);
  assert.match(detailResult.content[0].text, /Status:\s+completed/);
  assert.match(detailResult.content[0].text, /Latest log:\s+\[stdout\] last/);
  assert.doesNotMatch(detailResult.content[0].text, /\bfirst\b/);
  assert.equal(detailResult.details.latestLog.stream, "stdout");
  assert.equal(detailResult.details.latestLog.text, "last");

  const listResult = await bgStatus.execute("status-list", {}, undefined, undefined, ctx);
  const listedPipe = listResult.details.tasks.find((task: { id: string }) => task.id === firstId);
  assert.ok(listedPipe);
  assert.match(listResult.content[0].text, /Latest log:\s+\[stdout\] last/);
  assert.equal(listedPipe.latestLog.stream, "stdout");
  assert.equal(listedPipe.latestLog.text, "last");

  const longRunning = await bgStart.execute(
    "start-2",
    { name: "cancel-status", command: "fake long-running command" },
    undefined,
    undefined,
    ctx,
  );
  const longRunningId = longRunning.details.id as string;
  const firstStatus = await bgStatus.execute("status-first", { id: longRunningId }, undefined, undefined, ctx);
  assert.equal(firstStatus.details.status, "running");
  const repeatedStatus = await bgStatus.execute("status-repeated", { id: longRunningId }, undefined, undefined, ctx);
  assert.equal(repeatedStatus.details.status, "running");
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
  await new Promise<void>((resolve) => setImmediate(resolve));
  abortController.abort(new Error("cancelled by test"));
  await assert.rejects(waitPromise, /cancelled by test/);

  children[1].stderr.write("still working\n");
  const timeoutResult = await bgWait.execute("wait-timeout", { id: longRunningId, timeout: 0.02 }, undefined, undefined, ctx);
  assert.match(timeoutResult.content[0].text, /Timed out/);
  assert.match(timeoutResult.content[0].text, /timeout did not stop it/);
  assert.match(timeoutResult.content[0].text, /Latest log:\s+\[stderr\] still working/);
  assert.equal(timeoutResult.details.timedOut, true);
  assert.equal(timeoutResult.details.status, "running");
  assert.equal(timeoutResult.details.latestLog.stream, "stderr");
  assert.equal(timeoutResult.details.latestLog.text, "still working");

  children[1].stdout.write("older kill output\nlatest kill output\n");
  const killResult = await bgKill.execute(
    "kill-2",
    { id: longRunningId, force: true },
    undefined,
    undefined,
    ctx,
  );
  assert.match(killResult.content[0].text, /Status: stopped/);
  assert.doesNotMatch(killResult.content[0].text, /older kill output|latest kill output|Latest log|stdout|terminal/i);
  assert.equal(killResult.details.latestLog, undefined);
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

  const rangeResult = await bgLogs.execute(
    "logs-formatted-range",
    { id: logTaskId, stream: "stdout", from_line: 0, max_lines: 1 },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(rangeResult.content[0].text, "out");

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

test("start, wait, and logs compose in one response by unique task name", async () => {
  const { tools, lifecycle, children, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  assert.ok(bgStart);

  const preflight = async (toolName: string, toolCallId: string, input: Record<string, unknown>) => {
    await lifecycle.get("tool_call")?.({ type: "tool_call", toolName, toolCallId, input }, ctx);
  };
  const execute = async (toolName: string, toolCallId: string, input: Record<string, unknown>) => {
    const tool = tools.get(toolName);
    assert.ok(tool);
    try {
      return await tool.execute(toolCallId, input, undefined, undefined, ctx);
    } finally {
      await lifecycle.get("tool_execution_end")?.({ type: "tool_execution_end", toolName, toolCallId }, ctx);
    }
  };

  await lifecycle.get("turn_start")?.({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);
  await preflight("bg_start", "composed-start", {
    name: "Composed Flow",
    command: "fake composed flow",
  });
  await preflight("bg_wait", "composed-wait", { id: "composed flow", timeout: 1 });
  await preflight("bg_logs", "composed-logs", { id: "COMPOSED FLOW", tail: 10 });

  let waitSettled = false;
  let logsSettled = false;
  const started = execute("bg_start", "composed-start", {
    name: "Composed Flow",
    command: "fake composed flow",
  });
  const waited = execute("bg_wait", "composed-wait", { id: "composed flow", timeout: 1 })
    .then((result) => {
      waitSettled = true;
      return result;
    });
  const logged = execute("bg_logs", "composed-logs", { id: "COMPOSED FLOW", tail: 10 })
    .then((result) => {
      logsSettled = true;
      return result;
    });

  const startResult = await started;
  const generatedId = startResult.details.id as string;
  assert.equal(children.length, 1, "bg_start should execute before its same-name successors");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(waitSettled, false, "bg_wait should remain pending until the newly started task exits");
  assert.equal(logsSettled, false, "bg_logs should remain ordered after bg_wait");

  children[0].stdout.write("COMPOSED FINAL\n");
  children[0].finish(0, null);
  const [waitResult, logsResult] = await Promise.all([waited, logged]);
  assert.equal(waitResult.details.id, generatedId);
  assert.equal(logsResult.details.id, generatedId);
  assert.match(logsResult.content[0].text, /COMPOSED FINAL/);

  await lifecycle.get("turn_end")?.({ type: "turn_end", turnIndex: 1 }, ctx);
  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("same-task tool calls follow source order while different task chains stay parallel", async () => {
  const { tools, lifecycle, children, ctx } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgWait = tools.get("bg_wait");
  const bgLogs = tools.get("bg_logs");
  assert.ok(bgStart && bgWait && bgLogs);

  const preflight = async (toolName: string, toolCallId: string, input: Record<string, unknown>) => {
    await lifecycle.get("tool_call")?.({ type: "tool_call", toolName, toolCallId, input }, ctx);
  };
  const execute = async (toolName: string, toolCallId: string, input: Record<string, unknown>) => {
    const tool = tools.get(toolName);
    assert.ok(tool);
    try {
      return await tool.execute(toolCallId, input, undefined, undefined, ctx);
    } finally {
      await lifecycle.get("tool_execution_end")?.({ type: "tool_execution_end", toolName, toolCallId }, ctx);
    }
  };

  const currentFirst = await bgStart.execute(
    "ordered-current-start",
    { name: "ordered-current", command: "fake ordered current" },
    undefined,
    undefined,
    ctx,
  );
  const currentId = currentFirst.details.id as string;
  children[0].stdout.write("BEFORE WAIT\n");

  await lifecycle.get("turn_start")?.({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);
  await preflight("bg_logs", "ordered-current-logs", { id: currentId });
  await preflight("bg_wait", "ordered-current-wait", { id: currentId, timeout: 1 });

  let currentWaitSettled = false;
  const currentLogs = execute("bg_logs", "ordered-current-logs", { id: currentId });
  const currentWait = execute("bg_wait", "ordered-current-wait", { id: currentId, timeout: 1 })
    .then((result) => {
      currentWaitSettled = true;
      return result;
    });
  const currentOutput = await currentLogs;
  assert.match(currentOutput.content[0].text, /BEFORE WAIT/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(currentWaitSettled, false, "logs before wait must read immediately, then release the wait call");
  children[0].stdout.write("AFTER WAIT\n");
  children[0].finish(0, null);
  await currentWait;
  await lifecycle.get("turn_end")?.({ type: "turn_end", turnIndex: 1 }, ctx);

  const first = await bgStart.execute(
    "ordered-first-start",
    { name: "ordered-first", command: "fake ordered first" },
    undefined,
    undefined,
    ctx,
  );
  const second = await bgStart.execute(
    "ordered-second-start",
    { name: "ordered-second", command: "fake ordered second" },
    undefined,
    undefined,
    ctx,
  );
  const firstId = first.details.id as string;
  const secondId = second.details.id as string;

  await lifecycle.get("turn_start")?.({ type: "turn_start", turnIndex: 2, timestamp: Date.now() }, ctx);
  await preflight("bg_wait", "ordered-first-wait", { id: firstId, timeout: 1 });
  await preflight("bg_logs", "ordered-first-logs", { id: firstId });
  await preflight("bg_wait", "ordered-second-wait", { id: secondId, timeout: 1 });
  await preflight("bg_logs", "ordered-second-logs", { id: secondId });

  let firstLogsSettled = false;
  let secondLogsSettled = false;
  const firstWait = execute("bg_wait", "ordered-first-wait", { id: firstId, timeout: 1 });
  const firstLogs = execute("bg_logs", "ordered-first-logs", { id: firstId })
    .then((result) => {
      firstLogsSettled = true;
      return result;
    });
  const secondWait = execute("bg_wait", "ordered-second-wait", { id: secondId, timeout: 1 });
  const secondLogs = execute("bg_logs", "ordered-second-logs", { id: secondId })
    .then((result) => {
      secondLogsSettled = true;
      return result;
    });

  children[2].stdout.write("SECOND FINAL\n");
  children[2].finish(0, null);
  const secondOutput = await secondLogs;
  assert.match(secondOutput.content[0].text, /SECOND FINAL/);
  assert.equal(secondLogsSettled, true);
  assert.equal(firstLogsSettled, false, "the unfinished task must not block a different task chain");

  children[1].stdout.write("FIRST FINAL\n");
  children[1].finish(0, null);
  const [, firstOutput] = await Promise.all([firstWait, firstLogs]);
  await secondWait;
  assert.match(firstOutput.content[0].text, /FIRST FINAL/);
  await lifecycle.get("turn_end")?.({ type: "turn_end", turnIndex: 2 }, ctx);
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
  const { tools, lifecycle, children, ptys, widgets, widgetUpdates, ctx, setToolsExpanded } = createHarness();
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
  const collapsedLines = component.render(200).map((line: string) =>
    stripVTControlCharacters(line).trimEnd()
  );
  assert.match(collapsedLines[0], /^2 background tasks · 2 running.*to expand$/);
  assert.doesNotMatch(collapsedLines[0], /0 finished/);
  assert.equal(collapsedLines.length, 1, "the collapsed widget should hide the task list");

  setToolsExpanded(true);
  const lines = component.render(200).map((line: string) =>
    stripVTControlCharacters(line).trimEnd()
  );
  assert.match(lines[0], /^2 background tasks · 2 running.*to collapse$/);
  assert.doesNotMatch(lines[0], /0 finished/);
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
  await waitForCondition(
    () => {
      const rendered = component.render(200);
      return Boolean(
        rendered[0]?.includes("1 running · 1 finished") &&
        rendered.some((line: string) => line.includes("pi-debate-pro") && line.includes("completed")),
      );
    },
    "PTY task completion in the widget",
  );
  const mixedLines = component.render(200).map((line: string) =>
    stripVTControlCharacters(line).trimEnd()
  );
  assert.match(mixedLines[0], /^2 background tasks · 1 running · 1 finished.*to collapse$/);
  assert.match(mixedLines[1], /^├─ ✓ pi-debate-pro \([a-z0-9]+\) completed \d+s exit=0$/);
  assert.match(mixedLines[2], /^└─ ◐ pi-build \([a-z0-9]+\) \d+s stdout:2 stderr:1$/);
  assert.doesNotMatch(mixedLines.join("\n"), /PTY FINAL|\[terminal\]/);

  await lifecycle.get("before_agent_start")?.({}, widgetCtx);
  const nextTurnLines = component.render(200).map((line: string) =>
    stripVTControlCharacters(line).trimEnd()
  );
  assert.match(nextTurnLines[0], /^1 background task · 1 running.*to collapse$/);
  assert.doesNotMatch(nextTurnLines[0], /0 finished/);
  assert.match(nextTurnLines[1], /^└─ ◐ pi-build \([a-z0-9]+\) \d+s stdout:2 stderr:1$/);

  children[0].finish(0, null);
  await waitForCondition(
    () => component.render(200)[0]?.includes(" · 1 finished") ?? false,
    "pipe task completion in the widget",
  );
  assert.equal(widgets.has("bg-tasks-widget"), true, "the final task result should remain visible for this turn");
  const finishedLines = component.render(200).map((line: string) =>
    stripVTControlCharacters(line).trimEnd()
  );
  assert.match(finishedLines[0], /^1 background task · 1 finished.*to collapse$/);
  assert.doesNotMatch(finishedLines[0], /0 running/);
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

test("background task widget hides entries until expanded and preserves task order", async () => {
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
  for (const name of ["finished-one", "finished-two", "finished-three", "running-four", "running-five"]) {
    assert.doesNotMatch(collapsed, new RegExp(name));
  }

  const colorTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<bold>${text}</bold>`,
  };
  const coloredHeader = widgetFactory({ requestRender: () => {} }, colorTheme).render(300)[0];
  assert.match(coloredHeader, /<accent><bold>5 background tasks<\/bold><\/accent>/);
  assert.match(coloredHeader, /<warning>2 running<\/warning>/);
  assert.match(coloredHeader, /<muted> · <\/muted><muted>3 finished<\/muted>/);
  assert.doesNotMatch(coloredHeader, /<warning>5 background tasks|3 finished<\/warning>/);

  setToolsExpanded(true);
  const expanded = component.render(200).join("\n");
  assert.match(expanded, /to collapse/);
  const orderedNames = ["finished-one", "finished-two", "finished-three", "running-four", "running-five"];
  for (const name of orderedNames) {
    assert.match(expanded, new RegExp(name));
  }
  for (let index = 1; index < orderedNames.length; index++) {
    assert.ok(expanded.indexOf(orderedNames[index - 1]) < expanded.indexOf(orderedNames[index]));
  }

  children[3].finish(0, null);
  children[4].finish(0, null);
  await lifecycle.get("session_shutdown")?.({}, widgetCtx);
});

test("background task settings control collapsed rows and running output previews", async () => {
  const { tools, lifecycle, children, widgets, ctx, setToolsExpanded } = createHarness({
    collapsedTaskLimit: 1,
    outputPreview: "all",
  });
  const bgStart = tools.get("bg_start");
  assert.ok(bgStart);

  const widgetCtx = { ...ctx, hasUI: true } as ExtensionContext;
  await lifecycle.get("session_start")?.({}, widgetCtx);
  await bgStart.execute(
    "settings-first",
    { name: "settings-first", command: "fake first" },
    undefined,
    undefined,
    widgetCtx,
  );
  await bgStart.execute(
    "settings-second",
    { name: "settings-second", command: "fake second" },
    undefined,
    undefined,
    widgetCtx,
  );
  children[0].stdout.write("first output\n");
  children[1].stderr.write("second output\n");
  await new Promise<void>((resolve) => setImmediate(resolve));

  const widgetFactory = widgets.get("bg-tasks-widget");
  assert.ok(widgetFactory);
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const component = widgetFactory({ requestRender: () => {} }, plainTheme);
  const collapsed = component.render(200).join("\n");
  assert.match(collapsed, /2 background tasks · 2 running.*to expand/);
  assert.match(collapsed, /settings-second/);
  assert.match(collapsed, /\[stderr\] second output/);
  assert.doesNotMatch(collapsed, /settings-first|first output/);

  setToolsExpanded(true);
  const expanded = component.render(200).join("\n");
  assert.match(expanded, /settings-first/);
  assert.match(expanded, /\[stdout\] first output/);
  assert.match(expanded, /settings-second/);
  assert.match(expanded, /\[stderr\] second output/);

  children[0].finish(0, null);
  children[1].finish(0, null);
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
  const { tools, lifecycle, children, widgets, widgetUpdates, ctx, setToolsExpanded } = createHarness();
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
    assert.match(widgetLines[0], /^1 background task · 1 running.*to expand$/);
    assert.doesNotMatch(widgetLines[0], /0 finished/);
    assert.equal(widgetLines.length, 1);
    assert.deepEqual(widgetUpdates.at(-1)?.options, { placement: "belowEditor" });

    setToolsExpanded(true);
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
  assert.match(finishedWidget[0], /^1 background task · 1 finished.*to collapse$/);
  assert.doesNotMatch(finishedWidget[0], /0 running/);
  assert.match(finishedWidget[1], /^└─ × rpc-build \([a-z0-9]+\) failed \d+s exit=2$/);
  assert.equal(finishedWidget[2], "   └─ [stderr] RPC FINAL ERROR");
  await lifecycle.get("before_agent_start")?.({}, rpcCtx);
  assert.equal(widgets.has("bg-tasks-widget"), false);
  await lifecycle.get("session_shutdown")?.({}, rpcCtx);
});

test("pipe tasks replay retained output before continuing with live output", async () => {
  const { tools, commands, lifecycle, children, terminalInput, terminalOutput, ctx } = createHarness();
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
  const originalWriteHandler = terminalOutput.writeHandler;
  terminalOutput.writeHandler = (chunk: string | Uint8Array) => {
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
      custom: createAttachCustom(async (component) => {
        await waitForRenderedText(stdoutChunks, /BEFORE_ATTACH_STDERR/);
        terminalInput.emit("data", "IGNORED_INPUT");
        children[0].stdout.write("LIVE_STDOUT\n");
        children[0].stderr.write("LIVE_STDERR\n");
        await waitForRenderedText(stdoutChunks, /LIVE_STDERR/);
        component.dispose();
      }),
    },
  } as unknown as ExtensionContext;

  try {
    await commands.get("bg-attach").handler(id, attachCtx);
  } finally {
    terminalOutput.writeHandler = originalWriteHandler;
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
  terminalOutput.writeHandler = (chunk: string | Uint8Array) => {
    reattachedChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  const reattachCtx = {
    ...attachCtx,
    ui: {
      ...attachCtx.ui,
      custom: createAttachCustom(async (component) => {
        await waitForRenderedText(reattachedChunks, /LIVE_STDERR/);
        children[0].stdout.write("AFTER_REATTACH\n");
        await waitForRenderedText(reattachedChunks, /AFTER_REATTACH/);
        component.dispose();
        children[0].finish(0, null);
      }),
    },
  } as unknown as ExtensionContext;

  try {
    await commands.get("bg-attach").handler(id, reattachCtx);
  } finally {
    terminalOutput.writeHandler = originalWriteHandler;
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
  const { tools, commands, lifecycle, children, ptys, terminalInput, terminalOutput, ctx } = createHarness();
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
  children[0].finish(2, null);
  ptys[0].finish(0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const attachCommand = commands.get("bg-attach");
  assert.match(attachCommand.description, /read-only final snapshot/);
  const completions = attachCommand.getArgumentCompletions("");
  assert.ok(completions.some((item: { value: string; label: string }) =>
    item.value === pipeId && item.label.includes("(failed)")));
  assert.ok(completions.some((item: { value: string; label: string }) =>
    item.value === ptyId && item.label.includes("(completed)")));

  const cases = [
    { id: pipeId, mode: "Pipe", name: "finished-pipe", expected: /PIPE FINAL SNAPSHOT/ },
    { id: ptyId, mode: "PTY", name: "finished-pty", expected: /PTY FINAL SNAPSHOT/ },
  ];
  for (const attachCase of cases) {
    const stdoutChunks: string[] = [];
    const notifications: string[] = [];
    const originalWriteHandler = terminalOutput.writeHandler;
    terminalOutput.writeHandler = (chunk: string | Uint8Array) => {
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
        custom: createAttachCustom(async () => {
          await waitForRenderedText(stdoutChunks, /Task finished - Ctrl\+\] to return/);
          terminalInput.emit("data", "\x1d");
        }),
      },
    } as unknown as ExtensionContext;

    try {
      await attachCommand.handler(attachCase.id, attachCtx);
    } finally {
      terminalOutput.writeHandler = originalWriteHandler;
    }

    const attachedOutput = stdoutChunks.join("");
    assert.match(attachedOutput, attachCase.expected);
    assert.match(attachedOutput, /Task finished - Ctrl\+\] to return/);
    assert.deepEqual(notifications, [], "detaching from a finished snapshot should not repeat its task outcome");

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

test("finished pipe and PTY snapshots replay across reload and stay deleted after cleanup", async () => {
  const {
    tools,
    commands,
    lifecycle,
    children,
    ptys,
    terminalInput,
    terminalOutput,
    ctx,
    getBranch,
    setBranch,
  } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgStatus = tools.get("bg_status");
  const bgLogs = tools.get("bg_logs");
  assert.ok(bgStart && bgStatus && bgLogs);

  await lifecycle.get("session_start")?.({ reason: "startup" }, ctx);
  const pipeStarted = await bgStart.execute(
    "reload-pipe-start",
    { name: "reload-pipe", command: "fake reload pipe" },
    undefined,
    undefined,
    ctx,
  );
  const ptyStarted = await bgStart.execute(
    "reload-pty-start",
    { name: "reload-pty", command: "fake reload pty", pty: true, cols: 70, rows: 12 },
    undefined,
    undefined,
    ctx,
  );
  const pipeId = pipeStarted.details.id as string;
  const ptyId = ptyStarted.details.id as string;

  children[0].stdout.write("PIPE SNAPSHOT BEFORE RELOAD\n");
  children[0].stderr.write("PIPE ERROR BEFORE RELOAD\n");
  ptys[0].emitData("\x1b[2J\x1b[HPTY SNAPSHOT BEFORE RELOAD\r\n");
  children[0].finish(2, null);
  ptys[0].finish(0);
  await waitForCondition(
    () => getBranch().filter((entry: any) => entry.data?.action === "upsert").length === 2,
    "finished task snapshot entries",
  );
  const branchWithSnapshots = getBranch();

  await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  await lifecycle.get("session_start")?.({ reason: "reload" }, ctx);

  const restoredStatus = await bgStatus.execute("reload-status", {}, undefined, undefined, ctx);
  assert.deepEqual(
    restoredStatus.details.tasks.map((task: { id: string; status: string; mode: string }) => [task.id, task.status, task.mode]),
    [[pipeId, "failed", "pipe"], [ptyId, "completed", "pty"]],
  );
  const restoredPipeLogs = await bgLogs.execute(
    "reload-pipe-logs",
    { id: pipeId, stream: "both" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(restoredPipeLogs.content[0].text, /PIPE SNAPSHOT BEFORE RELOAD/);
  assert.match(restoredPipeLogs.content[0].text, /PIPE ERROR BEFORE RELOAD/);
  const restoredPtyLogs = await bgLogs.execute(
    "reload-pty-logs",
    { id: ptyId, stream: "terminal" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(restoredPtyLogs.content[0].text, /PTY SNAPSHOT BEFORE RELOAD/);

  const attachCommand = commands.get("bg-attach");
  for (const attachCase of [
    { id: pipeId, expected: /PIPE SNAPSHOT BEFORE RELOAD/ },
    { id: ptyId, expected: /PTY SNAPSHOT BEFORE RELOAD/ },
  ]) {
    const chunks: string[] = [];
    const notifications: string[] = [];
    const previousWriteHandler = terminalOutput.writeHandler;
    terminalOutput.writeHandler = (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    const attachCtx = {
      ...ctx,
      hasUI: true,
      ui: {
        ...ctx.ui,
        notify: (message: string) => notifications.push(message),
        custom: createAttachCustom(async () => {
          await waitForRenderedText(chunks, /Task finished - Ctrl\+\] to return/);
          terminalInput.emit("data", "\x1d");
        }),
      },
    } as unknown as ExtensionContext;
    try {
      await attachCommand.handler(attachCase.id, attachCtx);
    } finally {
      terminalOutput.writeHandler = previousWriteHandler;
    }
    assert.match(chunks.join(""), attachCase.expected);
    assert.deepEqual(notifications, []);
  }

  await lifecycle.get("before_agent_start")?.({}, ctx);
  const clearedStatus = await bgStatus.execute("reload-cleared", {}, undefined, undefined, ctx);
  assert.deepEqual(clearedStatus.details.tasks, []);
  assert.ok(getBranch().some((entry: any) =>
    entry.data?.action === "reconcile" &&
    entry.data.removed?.includes(pipeId) &&
    entry.data.removed?.includes(ptyId)));
  const branchAfterCleanup = getBranch();

  setBranch(branchWithSnapshots);
  await lifecycle.get("session_tree")?.({}, ctx);
  const branchRestoredStatus = await bgStatus.execute("tree-restored", {}, undefined, undefined, ctx);
  assert.deepEqual(branchRestoredStatus.details.tasks.map((task: { id: string }) => task.id), [pipeId, ptyId]);
  setBranch(branchAfterCleanup);
  await lifecycle.get("session_tree")?.({}, ctx);
  const branchClearedStatus = await bgStatus.execute("tree-cleared", {}, undefined, undefined, ctx);
  assert.deepEqual(branchClearedStatus.details.tasks, []);

  await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  await lifecycle.get("session_start")?.({ reason: "reload" }, ctx);
  const replayedClearedStatus = await bgStatus.execute("reload-still-cleared", {}, undefined, undefined, ctx);
  assert.deepEqual(replayedClearedStatus.details.tasks, []);
  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("tasks finishing while idle preserve their extra inspection turn across reload", async () => {
  const { tools, lifecycle, children, ctx, getBranch } = createHarness();
  const bgStart = tools.get("bg_start");
  const bgStatus = tools.get("bg_status");
  assert.ok(bgStart && bgStatus);

  await lifecycle.get("session_start")?.({ reason: "startup" }, ctx);
  const started = await bgStart.execute(
    "idle-reload-start",
    { name: "idle-reload", command: "fake idle reload" },
    undefined,
    undefined,
    ctx,
  );
  const id = started.details.id as string;
  await lifecycle.get("agent_settled")?.({}, ctx);
  children[0].stdout.write("IDLE SNAPSHOT BEFORE RELOAD\n");
  children[0].finish(0, null);
  await waitForCondition(
    () => getBranch().some((entry: any) =>
      entry.data?.action === "upsert" && entry.data.task?.id === id && entry.data.task?.retainForNextAgentTurn === true),
    "idle retained snapshot entry",
  );

  await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  await lifecycle.get("session_start")?.({ reason: "reload" }, ctx);
  await lifecycle.get("before_agent_start")?.({}, ctx);
  const firstInspection = await bgStatus.execute("idle-reload-first", { id }, undefined, undefined, ctx);
  assert.equal(firstInspection.details.status, "completed");
  assert.ok(getBranch().some((entry: any) =>
    entry.data?.action === "reconcile" && entry.data.clearedRetention?.includes(id)));

  await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  await lifecycle.get("session_start")?.({ reason: "reload" }, ctx);
  const restoredInspection = await bgStatus.execute("idle-reload-restored", { id }, undefined, undefined, ctx);
  assert.equal(restoredInspection.details.status, "completed");

  await lifecycle.get("before_agent_start")?.({}, ctx);
  const expired = await bgStatus.execute("idle-reload-expired", { id }, undefined, undefined, ctx);
  assert.deepEqual(expired.details, {});
  await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  await lifecycle.get("session_start")?.({ reason: "reload" }, ctx);
  const replayedExpired = await bgStatus.execute("idle-reload-still-expired", { id }, undefined, undefined, ctx);
  assert.deepEqual(replayedExpired.details, {});
  await lifecycle.get("session_shutdown")?.({}, ctx);
});

test("attached tasks stay open and show a user-only hint after they exit", async () => {
  const { tools, commands, lifecycle, children, ptys, terminalInput, terminalOutput, ctx } = createHarness();
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
    const originalWriteHandler = terminalOutput.writeHandler;
    terminalOutput.writeHandler = (chunk: string | Uint8Array) => {
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
        custom: createAttachCustom(async () => {
          await waitForRenderedText(stdoutChunks, /\x1b\[2J\x1b\[H/);
          attachCase.finish();
          await waitForRenderedText(stdoutChunks, /Task finished - Ctrl\+\] to return/);
          terminalInput.emit("data", "IGNORED AFTER EXIT");
          detachSent = true;
          terminalInput.emit("data", "\x1d");
        }),
      },
    } as unknown as ExtensionContext;

    try {
      await attachCommand.handler(attachCase.id, attachCtx);
    } finally {
      terminalOutput.writeHandler = originalWriteHandler;
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
  const { tools, commands, lifecycle, ptys, terminalInput, terminalOutput, ctx } = createHarness();
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

  const originalWriteHandler = terminalOutput.writeHandler;
  const originalColumns = terminalOutput.columns;
  const originalRows = terminalOutput.rows;
  terminalOutput.columns = 80;
  terminalOutput.rows = 24;
  terminalOutput.writeHandler = (chunk: string | Uint8Array) => {
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
      custom: createAttachCustom(async (component) => {
        pty.emitData("DURING_ATTACH\r\n");
        await waitForCondition(
          () => attachOrder.includes("catchup") && attachOrder.includes("mouse-sgr"),
          "PTY attach snapshot, mouse mode, and catch-up output",
        );
        terminalInput.emit("data", "\x1b[<0;12;8M");
        terminalOutput.columns = 90;
        terminalOutput.rows = 28;
        terminalOutput.emit("resize");
        terminalOutput.columns = 1000;
        terminalOutput.rows = 1;
        terminalOutput.emit("resize");
        await waitForCondition(
          () => attachOrder.includes("resize:500x5"),
          "debounced PTY resize",
        );
        component.dispose();
      }),
    },
  } as unknown as ExtensionContext;

  try {
    await commands.get("bg-attach").handler(id, attachCtx);
  } finally {
    terminalOutput.writeHandler = originalWriteHandler;
    terminalOutput.columns = originalColumns;
    terminalOutput.rows = originalRows;
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
  assert.doesNotMatch(waited.content[0].text, /terminal|DONE|Alice/i);
  assert.equal(waited.details.latestLog, undefined);
  assert.equal(waited.details.terminalSnapshot, undefined);

  const status = await bgStatus.execute("pty-status", { id }, undefined, undefined, ctx);
  assert.match(status.content[0].text, /Mode:\s+pty/);
  assert.doesNotMatch(status.content[0].text, /DONE|Alice|terminal snapshot|Latest log/i);
  assert.equal(status.details.latestLog, undefined);

  const statusList = await bgStatus.execute("pty-status-list", {}, undefined, undefined, ctx);
  const listedPty = statusList.details.tasks.find((task: { id: string }) => task.id === id);
  assert.ok(listedPty);
  assert.equal(listedPty.latestLog, undefined);
  assert.doesNotMatch(statusList.content[0].text, /DONE|Alice|terminal snapshot|Latest log/i);

  const finalLogs = await bgLogs.execute(
    "pty-final-logs",
    { id, tail: 10 },
    undefined,
    undefined,
    ctx,
  );
  assert.match(finalLogs.content[0].text, /Alice/);
  assert.match(finalLogs.content[0].text, /DONE/);

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
  assert.doesNotMatch(killed.content[0].text, /terminal|FIRST SCREEN ROW|LAST SCREEN ROW/i);
  assert.equal(killed.details.latestLog, undefined);

  const killedLogs = await bgLogs.execute(
    "pty-killed-logs",
    { id: killStarted.details.id, tail: 10 },
    undefined,
    undefined,
    ctx,
  );
  assert.match(killedLogs.content[0].text, /FIRST SCREEN ROW/);
  assert.match(killedLogs.content[0].text, /LAST SCREEN ROW/);

  await lifecycle.get("session_shutdown")?.({}, ctx);
});
