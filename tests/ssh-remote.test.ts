import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  collectWorkspaceFile,
  resolveWorkspaceFiles,
} from "@99percentpeople/pi-workspace-files";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  selectRemoteAdapter,
  UnixBashAdapter,
  WindowsPowerShellAdapter,
  type RemoteAdapter,
  type RemoteWorkspace,
} from "../extensions/ssh-remote/adapters/index.ts";
import {
  buildPowerShellInvocation,
  buildWindowsPowerShellCommand,
  decodeWindowsToolPath,
  encodePowerShell,
  encodeWindowsToolPath,
  resolveWindowsRemotePath,
} from "../extensions/ssh-remote/adapters/windows.ts";
import { createSshBackgroundShellResolver } from "../extensions/ssh-remote/background.ts";
import {
  buildSshArguments,
  OpenSshClient,
  type SshClientOptions,
  type SshRemoteClient,
  type SshRunOptions,
  type SshRunResult,
} from "../extensions/ssh-remote/client.ts";
import { createSshRemoteExtension } from "../extensions/ssh-remote/index.ts";
import {
  buildRemoteBashCommand,
  createRemoteEditOperations,
  createRemoteReadOperations,
  createRemoteWriteOperations,
} from "../extensions/ssh-remote/operations.ts";
import {
  findSshSessionState,
  normalizeSshSessionState,
  SSH_SESSION_STATE_TYPE,
  type SshSessionState,
} from "../extensions/ssh-remote/session-state.ts";
import {
  mapCwdToRemote,
  normalizeRemoteToolPath,
  parseSshTarget,
  shellQuote,
} from "../extensions/ssh-remote/target.ts";

interface RecordedRun {
  command: string;
  options?: SshRunOptions;
  checked: boolean;
}

class FakeSshClient implements SshRemoteClient {
  readonly calls: RecordedRun[] = [];
  disposed = false;
  remoteFileExists = false;

  constructor(
    readonly options: Readonly<SshClientOptions>,
    private readonly workspace = { home: "/home/deploy", cwd: "/srv/project" },
    private readonly gitBranch?: string,
  ) {}

  async run(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    this.calls.push({ command, options, checked: false });
    if (command.includes("PI_SSH_UNIX_ENV")) {
      return {
        stdout: Buffer.from(`\u001ePI_SSH_UNIX_ENV\u001f${this.workspace.home}\u001f${this.workspace.cwd}\u001e`),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    }
    if (command.includes("PI_SSH_UNIX_CWD")) {
      return {
        stdout: Buffer.from(`\u001ePI_SSH_UNIX_CWD\u001f${this.workspace.cwd}\u001e`),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    }
    if (command.includes("git -c color.ui=false branch --show-current")) {
      const stdout = Buffer.from(this.gitBranch ? `${this.gitBranch}\n` : "");
      options?.onStdout?.(stdout);
      return {
        stdout,
        stderr: Buffer.alloc(0),
        exitCode: this.gitBranch ? 0 : 1,
      };
    }
    if (command.includes("file --mime-type")) {
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 1 };
    }
    if (command.startsWith("test -e ")) {
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: this.remoteFileExists ? 0 : 1,
      };
    }
    if (command.startsWith("cat ") && !command.includes(" > ")) {
      const stdout = Buffer.from("remote contents\n");
      options?.onStdout?.(stdout);
      return { stdout, stderr: Buffer.alloc(0), exitCode: 0 };
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
  }

  async runChecked(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    const result = await this.run(command, options);
    this.calls[this.calls.length - 1].checked = true;
    if (result.exitCode !== 0) throw new Error(`failed: ${command}`);
    return result;
  }

  dispose(): void {
    this.disposed = true;
  }
}

test("SSH targets use rsync-style syntax and robust shell quoting", () => {
  assert.deepEqual(parseSshTarget("devbox"), { target: "devbox", requestedCwd: undefined });
  assert.deepEqual(parseSshTarget("deploy@devbox:/srv/app"), {
    target: "deploy@devbox",
    requestedCwd: "/srv/app",
  });
  assert.deepEqual(parseSshTarget("deploy@[2001:db8::10]:~/app"), {
    target: "deploy@2001:db8::10",
    requestedCwd: "~/app",
  });
  assert.deepEqual(parseSshTarget("winbox:C:\\Users\\Admin\\project"), {
    target: "winbox",
    requestedCwd: "C:\\Users\\Admin\\project",
  });
  assert.throws(() => parseSshTarget("-oProxyCommand=bad"), /cannot start/);
  assert.throws(() => parseSshTarget("bad host:/tmp"), /whitespace/);
  assert.equal(shellQuote("a'b c"), "'a'\\''b c'");
  assert.equal(normalizeRemoteToolPath("@~/src/index.ts", "/home/deploy"), "/home/deploy/src/index.ts");
  assert.throws(() => normalizeRemoteToolPath("~other/file", "/home/deploy"), /~user/);
});

test("cwd mapping preserves paths relative to the local anchor", () => {
  assert.equal(mapCwdToRemote(".", "/local/project", "/srv/project"), "/srv/project");
  assert.equal(mapCwdToRemote("packages/api", "/local/project", "/srv/project"), "/srv/project/packages/api");
  assert.equal(mapCwdToRemote("/local/project/src", "/local/project", "/srv/project"), "/srv/project/src");
  assert.equal(mapCwdToRemote("/var/tmp", "/local/project", "/srv/project"), "/var/tmp");
});

test("OpenSSH arguments preserve config aliases and run non-interactively", () => {
  assert.deepEqual(
    buildSshArguments({
      target: "devbox",
      configFile: "/home/me/.ssh/work.conf",
      connectTimeoutSeconds: 12,
      batchMode: true,
    }),
    [
      "-F",
      "/home/me/.ssh/work.conf",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=12",
      "-T",
      "devbox",
    ],
  );
  assert.ok(buildSshArguments({ target: "devbox" }, true).includes("-tt"));
});

test("OpenSSH client probes remote home and canonical cwd through framed output", async () => {
  class FakeProcess extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    kill(): boolean {
      queueMicrotask(() => this.emit("close", null));
      return true;
    }
  }

  const commands: string[] = [];
  const spawn = (
    _file: string,
    args: readonly string[],
    _options: SpawnOptions,
  ): ChildProcess => {
    const child = new FakeProcess();
    const command = args.at(-1) ?? "";
    commands.push(command);
    queueMicrotask(() => {
      if (command.includes("PI_SSH_UNIX_ENV")) {
        child.stdout.write("login banner\\n\u001ePI_SSH_UNIX_ENV\u001f/home/deploy\u001f/home/deploy\u001e");
      } else {
        child.stdout.write("\u001ePI_SSH_UNIX_CWD\u001f/srv/project\u001e");
      }
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
    });
    return child as unknown as ChildProcess;
  };

  const client = new OpenSshClient({ target: "devbox" }, spawn);
  const adapter = new UnixBashAdapter(client);
  assert.deepEqual(await adapter.inspectWorkspace("~/project"), {
    platform: "unix",
    shell: "bash",
    home: "/home/deploy",
    cwd: "/srv/project",
  });
  assert.match(commands[1], /cd -- '\/home\/deploy\/project'/);
  client.dispose();
});

test("remote file operations quote paths and stream write content over stdin", async () => {
  const client = new FakeSshClient({ target: "devbox" });
  const adapter = new UnixBashAdapter(client);
  const read = createRemoteReadOperations(adapter);
  const write = createRemoteWriteOperations(adapter);
  const edit = createRemoteEditOperations(adapter);

  assert.equal((await read.readFile("/srv/a file.txt")).toString(), "remote contents\n");
  assert.equal(await adapter.fileExists("/srv/missing.png"), false);
  await read.access("/srv/a file.txt");
  assert.equal(await read.detectImageMimeType?.("/srv/a file.txt"), null);
  await write.mkdir("/srv/new dir");
  await write.writeFile("/srv/new dir/value.txt", "secret ' content");
  await edit.access("/srv/edit.ts");

  const writeCall = client.calls.find((call) => call.command.startsWith("cat >"));
  assert.ok(writeCall);
  assert.equal(writeCall.options?.input, "secret ' content");
  assert.doesNotMatch(writeCall.command, /secret/);
  assert.match(writeCall.command, /'\/srv\/new dir\/value\.txt'/);
  assert.match(client.calls.find((call) => call.command.startsWith("test -r"))?.command ?? "", /'\/srv\/a file\.txt'/);
});

test("remote Bash exports safe session metadata but not the local session path", () => {
  const command = buildRemoteBashCommand("printf '%s' ok", "/srv/project", {
    PI_SESSION_ID: "session-1",
    PI_SESSION_FILE: "/local/private/session.jsonl",
    PI_PROVIDER: "provider",
    PI_MODEL: "model",
  });
  assert.match(command, /^cd -- '\/srv\/project' && export /);
  assert.match(command, /PI_SESSION_ID='session-1'/);
  assert.match(command, /PI_PROVIDER='provider'/);
  assert.doesNotMatch(command, /PI_SESSION_FILE|session\.jsonl/);
  assert.match(command, /exec bash -lc/);
});

test("background resolver maps remote cwd while launching ssh from a local directory", () => {
  const client = new FakeSshClient({ target: "devbox" });
  const adapter = new UnixBashAdapter(client);
  const resolver = createSshBackgroundShellResolver({
    ssh: { target: "devbox", configFile: "/tmp/ssh.conf" },
    adapter,
    workspace: {
      platform: "unix",
      shell: "bash",
      home: "/home/deploy",
      cwd: "/srv/project",
    },
    localCwd: "/local/project",
    env: { PATH: "/usr/bin" },
  });
  const launch = resolver("npm test", true, {
    cwd: "/local/project/packages/api",
    projectTrusted: true,
  });
  assert.equal(launch.file, "ssh");
  assert.equal(launch.cwd, "/local/project");
  assert.ok(launch.args.includes("-tt"));
  assert.ok(launch.args.includes("devbox"));
  assert.match(launch.args.at(-1) ?? "", /cd -- '\/srv\/project\/packages\/api'/);
  assert.match(launch.args.at(-1) ?? "", /npm test/);
});

function decodePowerShellInvocation(command: string): string {
  const encoded = command.trim().split(/\s+/).at(-1) ?? "";
  return Buffer.from(encoded, "base64").toString("utf16le");
}

class FakeWindowsSshClient implements SshRemoteClient {
  readonly calls: RecordedRun[] = [];
  disposed = false;
  remoteFileExists = false;

  constructor(readonly options: Readonly<SshClientOptions> = { target: "winbox" }) {}

  async run(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    this.calls.push({ command, options, checked: false });
    if (command.startsWith("command -v bash")) {
      return { stdout: Buffer.alloc(0), stderr: Buffer.from("bash missing"), exitCode: 127 };
    }
    const script = decodePowerShellInvocation(command);
    if (script.includes("PI_SSH_WINDOWS_ENV")) {
      return {
        stdout: Buffer.from("\u001ePI_SSH_WINDOWS_ENV\u001fC:\\Users\\Admin\u001fC:\\Users\\Admin\u001e"),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    }
    if (script.includes("PI_SSH_WINDOWS_CWD")) {
      return {
        stdout: Buffer.from("\u001ePI_SSH_WINDOWS_CWD\u001fC:\\Users\\Admin\\project\u001e"),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    }
    if (script.includes("$exists = [IO.File]::Exists")) {
      return {
        stdout: Buffer.from(this.remoteFileExists ? "1" : "0"),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    }
    if (script.includes("ReadAllBytes")) {
      return { stdout: Buffer.from("windows contents\r\n"), stderr: Buffer.alloc(0), exitCode: 0 };
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
  }

  async runChecked(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    const result = await this.run(command, options);
    this.calls[this.calls.length - 1].checked = true;
    if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8") || "failed");
    return result;
  }

  dispose(): void {
    this.disposed = true;
  }
}

test("Windows paths round-trip through Pi's logical POSIX namespace", () => {
  const drivePath = "C:\\Users\\Admin\\source file.txt";
  const uncPath = "\\\\server\\share\\folder\\file.txt";
  assert.equal(decodeWindowsToolPath(encodeWindowsToolPath(drivePath)), drivePath);
  assert.equal(decodeWindowsToolPath(encodeWindowsToolPath(uncPath)), uncPath);
  assert.equal(
    resolveWindowsRemotePath("~\\project\\src", "C:\\Users\\Admin", "D:\\work"),
    "C:\\Users\\Admin\\project\\src",
  );
  assert.throws(
    () => resolveWindowsRemotePath("C:relative", "C:\\Users\\Admin", "C:\\work"),
    /Drive-relative/,
  );
});

test("PowerShell scripts use EncodedCommand and keep user commands out of SSH arguments", () => {
  assert.equal(Buffer.from(encodePowerShell("Write-Output ok"), "base64").toString("utf16le"), "Write-Output ok");
  const invocation = buildPowerShellInvocation("pwsh", "Write-Output ok");
  assert.match(invocation, /^pwsh\.exe .* -EncodedCommand /);
  assert.match(decodePowerShellInvocation(invocation), /Write-Output ok/);

  const shellCommand = buildWindowsPowerShellCommand(
    "powershell",
    "Get-Content 'secret.txt'",
    "C:\\Users\\Admin",
    { PI_SESSION_ID: "session-1", PI_SESSION_FILE: "/local/session.jsonl" },
  );
  assert.match(shellCommand, /^powershell\.exe /);
  assert.doesNotMatch(shellCommand, /Get-Content|secret\.txt|PI_SESSION_FILE/);
  const decoded = decodePowerShellInvocation(shellCommand);
  assert.match(decoded, /PI_SESSION_ID/);
  assert.doesNotMatch(decoded, /PI_SESSION_FILE|local\/session/);
});

test("remote adapter auto-detects Windows PowerShell and streams file content over stdin", async () => {
  const client = new FakeWindowsSshClient();
  const { adapter, workspace } = await selectRemoteAdapter(client, {
    preference: "auto",
    requestedCwd: "~\\project",
  });
  assert.ok(adapter instanceof WindowsPowerShellAdapter);
  assert.deepEqual(workspace, {
    platform: "windows",
    shell: "pwsh",
    home: "C:\\Users\\Admin",
    cwd: "C:\\Users\\Admin\\project",
  });

  assert.equal(
    adapter.mapCwd("/local/project", "/local/project", workspace),
    "C:\\Users\\Admin\\project",
  );
  assert.equal(
    adapter.mapCwd("/local/project/src", "/local/project", workspace),
    "C:\\Users\\Admin\\project\\src",
  );
  const resolver = createSshBackgroundShellResolver({
    ssh: { target: "winbox" },
    adapter,
    workspace,
    localCwd: "/local/project",
  });
  const pipeLaunch = resolver("Get-Location", false, {
    cwd: "/local/project/src",
    projectTrusted: true,
  });
  const ptyLaunch = resolver("Get-Location", true, {
    cwd: "C:\\Users\\Admin\\project",
    projectTrusted: true,
  });
  assert.match(pipeLaunch.args.at(-1) ?? "", / -NonInteractive /);
  assert.doesNotMatch(ptyLaunch.args.at(-1) ?? "", / -NonInteractive /);
  assert.ok(ptyLaunch.args.includes("-tt"));

  const path = adapter.toToolPath("notes.txt", workspace);
  assert.equal(adapter.fromToolPath(path), "C:\\Users\\Admin\\project\\notes.txt");
  assert.equal((await adapter.readFile(path)).toString("utf8"), "windows contents\r\n");
  assert.equal(await adapter.fileExists(path), false);
  await adapter.writeFile(path, "secret file content");
  const writeCall = client.calls.at(-1);
  assert.equal(writeCall?.options?.input, "secret file content");
  assert.doesNotMatch(writeCall?.command ?? "", /secret file content/);
});

interface HarnessOptions {
  flag?: string;
  configFlag?: string;
  branch?: unknown[];
  sessionName?: string;
  cwd?: string;
}

function createExtensionHarness(options: HarnessOptions = {}) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const flags = new Map<string, unknown>();
  const eventBus = new EventEmitter();
  const events: Array<{ name: string; payload: any }> = [];
  const entries = [...(options.branch ?? [])];
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses = new Map<string, unknown>();
  const themeCalls: Array<{ color: string; text: string }> = [];
  let sessionName: string | undefined = options.sessionName;
  if (options.flag) flags.set("ssh", options.flag);
  if (options.configFlag) flags.set("ssh-config", options.configFlag);

  const pi = {
    registerFlag: (name: string, definition: { default?: unknown }) => {
      if (!flags.has(name) && definition.default !== undefined) flags.set(name, definition.default);
    },
    getFlag: (name: string) => flags.get(name),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: (...args: any[]) => any) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
    getSessionName: () => sessionName,
    setSessionName: (name: string) => { sessionName = name.trim() || undefined; },
    events: {
      on: (name: string, handler: (...args: any[]) => void) => eventBus.on(name, handler),
      emit: (name: string, payload: unknown) => {
        events.push({ name, payload });
        return eventBus.emit(name, payload);
      },
    },
  } as unknown as ExtensionAPI;

  const theme = {
    fg: (color: string, text: string) => {
      themeCalls.push({ color, text });
      return text;
    },
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ctx = {
    cwd: options.cwd ?? "/local/project",
    hasUI: true,
    mode: "tui",
    model: undefined,
    thinkingLevel: "off",
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => [...entries],
      getSessionId: () => "session-id",
      getSessionFile: () => "/local/session.jsonl",
    },
    ui: {
      theme,
      setStatus: (key: string, value: unknown) => {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      notify: (message: string, level?: string) => notifications.push({ message, level }),
    },
  } as unknown as ExtensionContext;

  const emit = async (name: string, event: unknown, eventCtx = ctx) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      const next = await handler(event, eventCtx);
      if (next !== undefined) result = next;
    }
    return result;
  };

  return {
    pi,
    ctx,
    tools,
    commands,
    events,
    entries,
    notifications,
    statuses,
    themeCalls,
    emit,
    getSessionName: () => sessionName,
  };
}

function sessionEntry(state: unknown) {
  return { type: "custom", customType: SSH_SESSION_STATE_TYPE, data: state };
}

test("SSH commands stay hidden in local sessions", async () => {
  const harness = createExtensionHarness();
  createSshRemoteExtension({ platform: "linux" })(harness.pi);

  assert.equal(harness.commands.has("ssh-status"), false);
  assert.equal(harness.commands.has("ssh-reconnect"), false);
  await harness.emit("session_start", { reason: "startup" });
  assert.equal(harness.commands.has("ssh-status"), false);
  assert.equal(harness.commands.has("ssh-reconnect"), false);
});

test("SSH commands appear for remote sessions and reconnect the active target", async () => {
  const clients: FakeSshClient[] = [];
  const harness = createExtensionHarness({ flag: "devbox:/srv/project" });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeSshClient(options);
      clients.push(client);
      return client;
    },
  })(harness.pi);

  await harness.emit("session_start", { reason: "startup" });
  await harness.commands.get("ssh-status").handler("", harness.ctx);
  assert.match(harness.notifications.at(-1)?.message ?? "", /SSH target: devbox/);

  await harness.commands.get("ssh-reconnect").handler("", harness.ctx);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].disposed, true);
  assert.equal(clients[1].options.target, "devbox");
});

test("extension persists, routes, prompts, and restores an SSH workspace", async () => {
  const clients: FakeSshClient[] = [];
  const extension = createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeSshClient(
        options,
        { home: "/home/deploy", cwd: "/srv/project" },
        "main",
      );
      clients.push(client);
      return client;
    },
  });
  const harness = createExtensionHarness({ flag: "devbox:/srv/project" });
  extension(harness.pi);

  assert.equal(harness.commands.has("ssh-status"), false);
  assert.equal(harness.commands.has("ssh-reconnect"), false);
  await harness.emit("session_start", { reason: "startup" });
  assert.equal(harness.commands.has("ssh-status"), true);
  assert.equal(harness.commands.has("ssh-reconnect"), true);
  assert.equal(clients.length, 1);
  const saved = findSshSessionState(harness.entries);
  assert.equal(saved?.target, "devbox");
  assert.equal(saved?.remoteCwd, "/srv/project");
  assert.equal(harness.getSessionName(), "SSH devbox:/srv/project (main)");
  assert.equal(harness.statuses.get("ssh-remote"), "SSH: Connected");
  assert.ok(harness.themeCalls.some((call) => call.color === "muted" && call.text === "SSH:"));
  assert.ok(harness.themeCalls.some((call) => call.color === "warning" && call.text === "Connecting"));
  assert.ok(harness.themeCalls.some((call) => call.color === "success" && call.text === "Connected"));
  assert.ok(harness.events.some((event) => event.name === "bg:register"));
  const bash = harness.tools.get("bash");
  assert.match(bash.parameters.properties.timeout.description, /no default timeout/i);
  assert.match(bash.description, /Optionally provide a timeout/);
  assert.equal(typeof bash.renderCall, "function");
  assert.equal(typeof bash.renderResult, "function");

  await harness.emit("message_end", {
    message: {
      role: "user",
      content: [{ type: "text", text: "Fix the remote build\nwithout changing releases" }],
    },
  });
  assert.equal(
    harness.getSessionName(),
    "SSH devbox:/srv/project (main) • Fix the remote build without changing releases",
  );
  harness.pi.setSessionName("Pinned workspace");
  await harness.emit("message_end", {
    message: { role: "user", content: "A later message" },
  });
  assert.equal(harness.getSessionName(), "Pinned workspace");

  const read = harness.tools.get("read");
  assert.ok(read);
  const result = await read.execute(
    "read-1",
    { path: "~/notes.txt" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(result.content[0].text, "remote contents\n");
  assert.ok(clients[0].calls.some((call) => call.command.includes("/home/deploy/notes.txt")));

  const prompt = await harness.emit("before_agent_start", {
    systemPrompt: "Current working directory: /local/project",
  }) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /Current working directory: \/srv\/project \(SSH devbox\)/);
  assert.match(prompt.systemPrompt, /SSH remote workspace is active/);

  await harness.emit("session_shutdown", { reason: "quit" });
  assert.equal(clients[0].disposed, true);
});

test("extension routes Windows workspaces through PowerShell without exposing logical paths", async () => {
  const clients: FakeWindowsSshClient[] = [];
  const extension = createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeWindowsSshClient(options);
      clients.push(client);
      return client;
    },
  });
  const harness = createExtensionHarness({ flag: "winbox" });
  extension(harness.pi);

  await harness.emit("session_start", { reason: "startup" });
  const saved = findSshSessionState(harness.entries);
  assert.equal(harness.getSessionName(), "SSH winbox:C:\\Users\\Admin");
  await harness.emit("message_end", {
    message: { role: "user", content: "Review the Windows workspace" },
  });
  assert.equal(
    harness.getSessionName(),
    "SSH winbox:C:\\Users\\Admin • Review the Windows workspace",
  );
  assert.deepEqual(saved && {
    version: saved.version,
    target: saved.target,
    platform: saved.remotePlatform,
    shell: saved.remoteShell,
    cwd: saved.remoteCwd,
    home: saved.remoteHome,
  }, {
    version: 2,
    target: "winbox",
    platform: "windows",
    shell: "pwsh",
    cwd: "C:\\Users\\Admin",
    home: "C:\\Users\\Admin",
  });

  const writeResult = await harness.tools.get("write").execute(
    "write-win",
    { path: "notes.txt", content: "windows value" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(writeResult.content[0].text, "Successfully wrote 13 bytes to notes.txt");
  assert.doesNotMatch(writeResult.content[0].text, /__pi_ssh_remote_windows__/);
  const writeCall = clients[0].calls.find((call) => call.options?.input === "windows value");
  assert.ok(writeCall);
  assert.doesNotMatch(writeCall.command, /windows value/);

  const prompt = await harness.emit("before_agent_start", {
    systemPrompt: "Current working directory: /local/project",
  }) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /Current working directory: C:\\Users\\Admin/);
  assert.match(prompt.systemPrompt, /PowerShell syntax, not Bash syntax/);
  assert.ok(harness.events.some((event) => event.name === "bg:register"));

  await harness.emit("session_shutdown", { reason: "quit" });
  assert.equal(clients[0].disposed, true);

  const resumedClients: FakeWindowsSshClient[] = [];
  const resumed = createExtensionHarness({ branch: [sessionEntry(saved)] });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeWindowsSshClient(options);
      resumedClients.push(client);
      return client;
    },
  })(resumed.pi);
  await resumed.emit("session_start", { reason: "resume" });
  assert.equal(resumedClients[0].options.target, "winbox");
  assert.equal(findSshSessionState(resumed.entries)?.remoteShell, "pwsh");
  await resumed.emit("session_shutdown", { reason: "quit" });
});

test("workspace files provider routes Windows binary reads and writes through SSH", async () => {
  const client = new FakeWindowsSshClient({ target: "winbox" });
  const harness = createExtensionHarness({ flag: "winbox" });
  createSshRemoteExtension({
    platform: "linux",
    createClient: () => client,
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });

  const files = resolveWorkspaceFiles(harness.pi, harness.ctx.cwd);
  const output = files.resolvePath("Desktop\\wallpaper.png");
  const reference = files.resolvePath("Desktop\\reference.jpg");
  assert.equal(output, "C:\\Users\\Admin\\Desktop\\wallpaper.png");
  assert.equal(files.extname(reference), ".jpg");
  assert.equal(files.dirname(output), "C:\\Users\\Admin\\Desktop");
  assert.equal(await files.exists(output), false);
  assert.equal(
    (await collectWorkspaceFile(await files.readFile(reference))).toString("utf8"),
    "windows contents\r\n",
  );

  const png = Buffer.from("generated png bytes");
  async function* pngChunks() {
    yield png.subarray(0, 7);
    yield png.subarray(7);
  }
  await files.mkdir(files.dirname(output));
  await files.writeFile(output, pngChunks());
  assert.ok(client.calls.some((call) =>
    Buffer.isBuffer(call.options?.input) && call.options.input.equals(png)
  ));
  assert.throws(
    () => files.resolvePath("C:\\Windows\\outside.png"),
    /must stay inside the remote workspace/,
  );
  await harness.emit("session_shutdown", { reason: "quit" });
});

test("workspace files provider maps Unix paths and reports existing files", async () => {
  const client = new FakeSshClient({ target: "devbox" });
  const harness = createExtensionHarness({ flag: "devbox:/srv/project" });
  createSshRemoteExtension({
    platform: "linux",
    createClient: () => client,
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });

  const files = resolveWorkspaceFiles(harness.pi, harness.ctx.cwd);
  const output = files.resolvePath("output/codex-images/image.png");
  assert.equal(output, "/srv/project/output/codex-images/image.png");
  assert.equal(await files.exists(output), false);
  client.remoteFileExists = true;
  assert.equal(await files.exists(output), true);
  await harness.emit("session_shutdown", { reason: "quit" });
});

test("Windows clients leave core tools to the local PowerShell adapter", async () => {
  const harness = createExtensionHarness({ flag: "winbox" });
  createSshRemoteExtension({ platform: "win32" })(harness.pi);
  assert.equal(harness.tools.size, 0);
  await harness.emit("session_start", { reason: "startup" });
  assert.match(harness.notifications.at(-1)?.message ?? "", /Linux and macOS clients only/);
});

test("session state migrates Unix v1 entries and validates Windows v2 paths", () => {
  assert.deepEqual(normalizeSshSessionState({
    version: 1,
    target: "devbox",
    remoteCwd: "/srv/project",
    remoteHome: "/home/deploy",
  }), {
    version: 2,
    target: "devbox",
    remotePlatform: "unix",
    remoteShell: "bash",
    remoteCwd: "/srv/project",
    remoteHome: "/home/deploy",
    requestedCwd: undefined,
    configFile: undefined,
  });
  assert.equal(normalizeSshSessionState({
    version: 2,
    target: "winbox",
    remotePlatform: "windows",
    remoteShell: "pwsh",
    remoteCwd: "C:\\Users\\Admin",
    remoteHome: "C:\\Users\\Admin",
  })?.remotePlatform, "windows");
  assert.equal(normalizeSshSessionState({
    version: 2,
    target: "winbox",
    remotePlatform: "windows",
    remoteShell: "bash",
    remoteCwd: "C:\\Users\\Admin",
    remoteHome: "C:\\Users\\Admin",
  }), undefined);
});

test("resumed sessions reconnect without --ssh and reject a different target", async () => {
  const stored = {
    version: 1,
    target: "devbox",
    remoteCwd: "/srv/project",
    remoteHome: "/home/deploy",
  };
  const restoredClients: FakeSshClient[] = [];
  const restored = createExtensionHarness({
    branch: [
      sessionEntry(stored),
      {
        type: "message",
        message: { role: "user", content: "Resume the deployment review" },
      },
    ],
    sessionName: "[devbox:/srv/project] Existing prompt title",
  });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeSshClient(options);
      restoredClients.push(client);
      return client;
    },
  })(restored.pi);
  await restored.emit("session_start", { reason: "resume" });
  assert.equal(restoredClients[0].options.target, "devbox");
  assert.equal(findSshSessionState(restored.entries)?.remoteCwd, "/srv/project");
  assert.equal(
    restored.getSessionName(),
    "SSH devbox:/srv/project • Resume the deployment review",
  );
  await restored.emit("session_shutdown", { reason: "quit" });

  const conflicting = createExtensionHarness({
    flag: "production:/srv/project",
    branch: [sessionEntry(stored)],
  });
  createSshRemoteExtension({ platform: "linux" })(conflicting.pi);
  await conflicting.emit("session_start", { reason: "resume" });
  assert.match(conflicting.notifications.at(-1)?.message ?? "", /bound to devbox:\/srv\/project/);
  assert.equal(conflicting.statuses.get("ssh-remote"), "SSH: Disconnected");
  assert.ok(conflicting.themeCalls.some((call) => call.color === "error" && call.text === "Disconnected"));
  await assert.rejects(
    conflicting.tools.get("read").execute(
      "blocked-read",
      { path: "README.md" },
      undefined,
      undefined,
      conflicting.ctx,
    ),
    /SSH remote is unavailable/,
  );
  await conflicting.emit("session_shutdown", { reason: "quit" });
});
