import assert from "node:assert/strict";
import {
  spawn as spawnChild,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  collectWorkspaceFile,
  resolveWorkspaceFiles,
} from "@99percentpeople/pi-workspace-files";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
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
import {
  buildUnixBackgroundProbeCommand,
  buildUnixBackgroundShellCommand,
  buildUnixBackgroundSignalCommand,
  buildWindowsBackgroundProbeCommand,
  buildWindowsBackgroundShellCommand,
  buildWindowsBackgroundSignalCommand,
  createSshBackgroundShellResolver,
} from "../extensions/ssh-remote/background.ts";
import {
  buildSshArguments,
  OpenSshClient,
  type SshClientOptions,
  type SshDisposeOptions,
  type SshRemoteClient,
  type SshRunOptions,
  type SshRunResult,
} from "../extensions/ssh-remote/client.ts";
import {
  DEFAULT_SSH_REMOTE_CONFIG,
  normalizeSshRemoteConfig,
  saveSshRemoteConfig,
  loadSshRemoteConfig,
} from "../extensions/ssh-remote/config.ts";
import {
  AI_SSH_PASSWORD_PROMPT_TIMEOUT_MS,
  SSH_ENVIRONMENT_EVENT,
  createSshRemoteExtension as createSshRemoteExtensionBase,
} from "../extensions/ssh-remote/index.ts";
import { Ssh2Client, Ssh2ConnectionError } from "../extensions/ssh-remote/ssh2-client.ts";
import {
  SshPasswordResolver,
  SshPasswordTimeoutError,
} from "../extensions/ssh-remote/password-resolver.ts";
import {
  expandProxyJumpTokens,
  parseKnownHostSearchOutput,
  parseOpenSshConfig,
  parseProxyJump,
  resolveSsh2Connection,
  Ssh2CompatibilityError,
} from "../extensions/ssh-remote/ssh2-config.ts";
import {
  createSshTransportClient,
  type SshPasswordProvider,
} from "../extensions/ssh-remote/transport.ts";
import {
  buildRemoteBashCommand,
  createRemoteEditOperations,
  createRemoteReadOperations,
  createRemoteWriteOperations,
} from "../extensions/ssh-remote/operations.ts";
import {
  findSshEnvironmentState,
  findSshSessionState,
  normalizeSshSessionState,
  SSH_LOCAL_SESSION_STATE,
  SSH_LOCAL_SESSION_STATE_TYPE,
  SSH_SESSION_STATE_TYPE,
  type SshSessionState,
} from "../extensions/ssh-remote/session-state.ts";
import {
  mapCwdToRemote,
  normalizeRemoteToolPath,
  parseSshTarget,
  shellQuote,
} from "../extensions/ssh-remote/target.ts";

function createSshRemoteExtension(
  dependencies: Parameters<typeof createSshRemoteExtensionBase>[0] = {},
): ReturnType<typeof createSshRemoteExtensionBase> {
  return createSshRemoteExtensionBase({
    loadConfig: () => ({ ...DEFAULT_SSH_REMOTE_CONFIG }),
    saveConfig: () => {},
    ...dependencies,
  });
}

interface RecordedRun {
  command: string;
  options?: SshRunOptions;
  checked: boolean;
}

class FakeSshClient implements SshRemoteClient {
  readonly calls: RecordedRun[] = [];
  disposed = false;
  readonly disposeOptions: Array<SshDisposeOptions | undefined> = [];
  remoteFileExists = false;
  userShell = "";
  /** When set, `command -v <value>` probes answer yes for this command name. */
  availableCommands = new Set<string>();
  /** When set, existence probes fail (for example no sh on a Windows host). */
  probeFails = false;
  /** When set, `getent` is unavailable and the probe falls back to `sh`'s target. */
  getentUnavailable = false;
  /** Simulated `readlink -f /bin/sh` basename used by the fallback probe. */
  shTarget = "bash";
  /**
   * Shells that pass the adapter's `command -v` existence check during
   * inspectWorkspace. Defaults to a normal Unix host; clear "bash" to
   * simulate an ash-only host (OpenWrt/busybox).
   */
  inspectShells = new Set(["bash", "sh", "zsh"]);

  constructor(
    readonly options: Readonly<SshClientOptions>,
    private readonly workspace = { home: "/home/deploy", cwd: "/srv/project" },
    private readonly gitBranch?: string,
  ) {}

  async run(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    this.calls.push({ command, options, checked: false });
    const probe = /sh -c 'command -v ([a-z0-9_.-]+) /.exec(command);
    if (probe) {
      if (this.probeFails) throw new Error("probe failed");
      return {
        stdout: Buffer.from(this.availableCommands.has(probe[1]) ? "ok" : ""),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    }
    if (command.includes("getent passwd")) {
      if (this.getentUnavailable) {
        // No getent on the host: the probe falls back to the sh symlink target.
        return {
          stdout: Buffer.from(`unix:${this.shTarget}`),
          stderr: Buffer.alloc(0),
          exitCode: 0,
        };
      }
      return {
        stdout: Buffer.from(`unix:${this.userShell}`),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    }
    // inspectWorkspace validates the adapter shell with a bare command -v
    // (no sh -c wrapper, unlike the probe regex above) and carries the
    // HOME/cwd payload on the same command.
    const shellCheck = /^command -v ([a-z0-9_.-]+) >/.exec(command);
    if (shellCheck) {
      const present = this.inspectShells.has(shellCheck[1]);
      if (command.includes("PI_SSH_UNIX_ENV")) {
        return {
          stdout: Buffer.from(
            `\u001ePI_SSH_UNIX_ENV\u001f${this.workspace.home}\u001f${this.workspace.cwd}\u001e`,
          ),
          stderr: Buffer.alloc(0),
          exitCode: present ? 0 : 127,
        };
      }
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: present ? 0 : 127,
      };
    }
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
    if (command.includes("PI_SSH_REMOTE_LS")) {
      return {
        stdout: Buffer.from("D\0src\0F\0README.md\0"),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    }
    if (command.includes("PI_SSH_REMOTE_FIND")) {
      return {
        stdout: Buffer.from("F\0src/index.ts\0F\0src/util.ts\0"),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    }
    if (command.includes("PI_SSH_REMOTE_GREP")) {
      return {
        stdout: Buffer.from("G\x00src/index.ts\x0012\x00remoteMatch()\x00"),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
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

  dispose(options?: SshDisposeOptions): void {
    this.disposeOptions.push(options);
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

test("cwd mapping preserves paths relative to POSIX and Windows local anchors", () => {
  assert.equal(mapCwdToRemote(".", "/local/project", "/srv/project"), "/srv/project");
  assert.equal(mapCwdToRemote("packages/api", "/local/project", "/srv/project"), "/srv/project/packages/api");
  assert.equal(mapCwdToRemote("/local/project/src", "/local/project", "/srv/project"), "/srv/project/src");
  assert.equal(mapCwdToRemote("/var/tmp", "/local/project", "/srv/project"), "/var/tmp");
  assert.equal(
    mapCwdToRemote("C:\\local\\project\\src", "C:\\local\\project", "/srv/project"),
    "/srv/project/src",
  );
  assert.equal(
    mapCwdToRemote("/var/tmp", "C:\\local\\project", "/srv/project"),
    "/var/tmp",
  );
  assert.throws(
    () => mapCwdToRemote("D:\\other", "C:\\local\\project", "/srv/project"),
    /Cannot map local absolute cwd/,
  );
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
  assert.deepEqual(
    buildSshArguments({ target: "devbox" }, true).includes("-tt"),
    true,
  );
  assert.deepEqual(
    buildSshArguments({ target: "devbox" }, false, true),
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", "-n", "devbox"],
  );
});

test("OpenSSH multiplex arguments reuse Unix connections and disable Windows ControlMaster", () => {
  const multiplexed = buildSshArguments({
    target: "devbox",
    multiplex: true,
    controlPath: "/tmp/pi-ssh/mux",
  });
  assert.ok(multiplexed.includes("ControlMaster=auto"));
  assert.ok(multiplexed.includes("ControlPersist=10m"));
  assert.ok(multiplexed.includes("/tmp/pi-ssh/mux"));

  const singleUse = buildSshArguments({ target: "winbox", multiplex: false });
  assert.ok(singleUse.includes("ControlMaster=no"));
  assert.ok(singleUse.includes("ControlPath=none"));
});

test("OpenSSH client owns and closes its generated ControlMaster", async () => {
  class FakeProcess extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    kill(): boolean {
      queueMicrotask(() => this.emit("close", null));
      return true;
    }
  }

  const spawned: string[][] = [];
  const spawn = (
    _file: string,
    args: readonly string[],
    _options: SpawnOptions,
  ): ChildProcess => {
    spawned.push([...args]);
    const child = new FakeProcess();
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
    });
    return child as unknown as ChildProcess;
  };

  const client = new OpenSshClient({ target: "devbox", multiplex: true }, spawn);
  assert.ok(client.options.controlPath);
  assert.equal(client.reusesConnection, true);
  await client.run("echo ok");
  await client.dispose();
  assert.ok(spawned[0].includes("ControlMaster=auto"));
  assert.ok(spawned[0].includes(client.options.controlPath!));
  assert.ok(spawned[1].includes("-O"));
  assert.ok(spawned[1].includes("exit"));

  const graceful = new OpenSshClient(
    { target: "devbox", multiplex: true },
    spawn,
  );
  await graceful.run("watch build");
  await graceful.dispose({ preserveBackgroundSessions: true });
  assert.ok(spawned[3].includes("-O"));
  assert.ok(spawned[3].includes("stop"));
  assert.ok(!spawned[3].includes("exit"));

  const leased = new OpenSshClient(
    { target: "devbox", multiplex: true },
    spawn,
  );
  const lease = leased.acquireBackgroundLease();
  assert.ok(lease);
  const beforeDispose = spawned.length;
  await leased.dispose();
  assert.equal(
    spawned.length,
    beforeDispose,
    "disposing the workspace must not close a ControlMaster with a live task lease",
  );
  await lease.release();
  assert.equal(spawned.length, beforeDispose + 1);
  assert.ok(spawned.at(-1)?.includes("-O"));
  assert.ok(spawned.at(-1)?.includes("exit"));
});

test("SSH task leases keep signal control available when workspace shutdown runs first", async () => {
  class FakeProcess extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    kill(): boolean {
      queueMicrotask(() => this.emit("close", null, "SIGKILL"));
      return true;
    }
  }

  const spawned: string[][] = [];
  const spawn = (
    _file: string,
    args: readonly string[],
    _options: SpawnOptions,
  ): ChildProcess => {
    spawned.push([...args]);
    const child = new FakeProcess();
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child as unknown as ChildProcess;
  };
  const client = new OpenSshClient({ target: "devbox", multiplex: true }, spawn);
  const resolver = createSshBackgroundShellResolver({
    ssh: { ...client.options },
    adapter: new UnixBashAdapter(new FakeSshClient({ target: "devbox" })),
    workspace: {
      platform: "unix",
      shell: "bash",
      home: "/home/deploy",
      cwd: "/srv/project",
    },
    localCwd: "/local/project",
    spawnControl: spawn,
    createControlToken: () => "00112233445566778899aabbccddeeff",
    acquireControlLease: () => client.acquireBackgroundLease(),
  });
  const launch = resolver("sleep 30", false, {
    cwd: "/local/project",
    projectTrusted: true,
  });

  await client.dispose();
  assert.equal(spawned.length, 0, "workspace disposal must defer ControlMaster exit");
  await launch.control?.sendSignal("SIGTERM");
  assert.ok(spawned[0].includes(client.options.controlPath!));
  assert.ok(!spawned[0].includes("-O"));

  await launch.control?.dispose?.();
  assert.ok(spawned.at(-1)?.includes("-O"));
  assert.ok(spawned.at(-1)?.includes("exit"));
});

test("Windows ssh.exe adds -n for no-stdin commands and uses a temp file for input", async () => {
  class FakeProcess extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    kill(): boolean {
      queueMicrotask(() => this.emit("close", 0));
      return true;
    }
  }

  const spawned: Array<{ args: readonly string[]; options: SpawnOptions }> = [];
  const spawn = (
    _file: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess => {
    spawned.push({ args, options });
    const child = new FakeProcess();
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
      child.emit("close", 0);
    });
    return child as unknown as ChildProcess;
  };

  // No input: args gain -n, stdin is ignored, stdout/stderr are temp files.
  const client = new OpenSshClient(
    { target: "winbox", executable: "ssh.exe" },
    spawn,
  );
  await client.run("echo ok");
  assert.ok(spawned[0].args.includes("-n"));
  const stdio0 = spawned[0].options.stdio as Array<string | number>;
  assert.equal(stdio0[0], "ignore");
  assert.equal(typeof stdio0[1], "number");
  assert.equal(typeof stdio0[2], "number");

  // With input: no -n, stdin is a temp file handle, and all files are
  // removed afterwards.
  await client.run("cat", { input: "payload" });
  assert.ok(!spawned[1].args.includes("-n"));
  const stdio1 = spawned[1].options.stdio as Array<string | number>;
  assert.equal(typeof stdio1[0], "number");
  assert.equal(typeof stdio1[1], "number");
  assert.equal(typeof stdio1[2], "number");
  client.dispose();
  const leftovers = readdirSync(tmpdir()).filter((name) =>
    name.startsWith("pi-ssh-stdin-"),
  );
  assert.deepEqual(leftovers, []);
});

test("OpenSSH rejects an invalid timeout before spawning or creating stdio files", async () => {
  let spawnCalls = 0;
  const client = new OpenSshClient(
    { target: "winbox", executable: "ssh.exe" },
    () => {
      spawnCalls += 1;
      throw new Error("must not spawn");
    },
  );

  await assert.rejects(
    client.run("echo never", { input: "payload", timeoutSeconds: 0 }),
    /positive number of seconds/,
  );
  assert.equal(spawnCalls, 0);
  const leftovers = readdirSync(tmpdir()).filter((name) =>
    name.startsWith(`pi-ssh-stdin-${process.pid}-`)
      || name.startsWith(`pi-ssh-stdio-${process.pid}-`)
  );
  assert.deepEqual(leftovers, []);
  await client.dispose();
});

test("OpenSSH timeout rejects even when the local ssh process never closes", async () => {
  class HungProcess extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly signals: string[] = [];
    kill(signal?: string): boolean {
      this.signals.push(signal ?? "SIGTERM");
      return true;
    }
  }

  const process = new HungProcess();
  const client = new OpenSshClient(
    { target: "winbox", executable: "ssh.exe" },
    () => process as unknown as ChildProcess,
  );
  const started = Date.now();
  await assert.rejects(
    client.run("hung powershell command", { timeoutSeconds: 0.01 }),
    /timeout:0\.01/,
  );
  assert.ok(Date.now() - started < 2_500);
  assert.deepEqual(process.signals, ["SIGTERM", "SIGKILL"]);
  await client.dispose();
});

test("SSH Remote transport settings normalize and persist", () => {
  assert.deepEqual(normalizeSshRemoteConfig(undefined), DEFAULT_SSH_REMOTE_CONFIG);
  assert.deepEqual(normalizeSshRemoteConfig({ transport: "ssh2" }), {
    transport: "ssh2",
    passwordPrompt: true,
    persistPasswords: true,
    aiControlTools: false,
    aiPasswordAuth: true,
  });
  assert.deepEqual(normalizeSshRemoteConfig({ transport: "invalid" }), {
    transport: "auto",
    passwordPrompt: true,
    persistPasswords: true,
    aiControlTools: false,
    aiPasswordAuth: true,
  });
  assert.deepEqual(normalizeSshRemoteConfig({
    transport: "ssh2",
    passwordPrompt: false,
    persistPasswords: false,
    aiControlTools: true,
    aiPasswordAuth: false,
  }), {
    transport: "ssh2",
    passwordPrompt: false,
    persistPasswords: false,
    aiControlTools: true,
    aiPasswordAuth: false,
  });

  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-settings-test-"));
  const path = join(directory, "settings.json");
  try {
    writeFileSync(path, JSON.stringify({ unrelated: { enabled: true } }));
    saveSshRemoteConfig({
      transport: "openssh",
      passwordPrompt: true,
      persistPasswords: true,
      aiControlTools: false,
      aiPasswordAuth: false,
    }, path);
    assert.deepEqual(loadSshRemoteConfig(path), {
      transport: "openssh",
      passwordPrompt: true,
      persistPasswords: true,
      aiControlTools: false,
      aiPasswordAuth: false,
    });
    const document = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(document.unrelated, { enabled: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ssh2 config uses ssh -G, OpenSSH known_hosts, agent auth, and algorithm intersections", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ssh2-config-test-"));
  const knownHosts = join(directory, "known_hosts");
  writeFileSync(knownHosts, "placeholder\n");
  const hostKey = Buffer.from("test-host-key-blob");
  const encodedHostKey = hostKey.toString("base64");
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  try {
    const resolved = await resolveSsh2Connection(
      { target: "alias", connectTimeoutSeconds: 10 },
      {
        platform: "linux",
        home: directory,
        env: { SSH_AUTH_SOCK: "/tmp/test-agent" },
        runLocal: async (executable, args) => {
          calls.push({ executable, args });
          if (args.includes("-G")) {
            return {
              stdout: Buffer.from([
                "user deploy",
                "hostname server.example.test",
                "port 2222",
                "identityagent SSH_AUTH_SOCK",
                `userknownhostsfile ${knownHosts}`,
                "globalknownhostsfile none",
                "kexalgorithms curve25519-sha256,sntrup761x25519-sha512",
                "ciphers aes256-ctr",
                "macs hmac-sha2-256",
                "hostkeyalgorithms ssh-ed25519,sk-ssh-ed25519@openssh.com",
                "compression no",
                "connecttimeout 10",
                "serveraliveinterval 15",
                "serveralivecountmax 2",
                "pubkeyauthentication true",
                "identitiesonly no",
              ].join("\n") + "\n"),
              stderr: Buffer.alloc(0),
              exitCode: 0,
            };
          }
          return {
            stdout: Buffer.from(`[server.example.test]:2222 ssh-ed25519 ${encodedHostKey}\n`),
            stderr: Buffer.alloc(0),
            exitCode: 0,
          };
        },
      },
    );

    assert.equal(resolved.config.host, "server.example.test");
    assert.equal(resolved.config.port, 2222);
    assert.equal(resolved.config.username, "deploy");
    assert.equal(resolved.config.readyTimeout, 10_000);
    assert.equal(resolved.config.keepaliveInterval, 15_000);
    assert.deepEqual(resolved.config.algorithms?.kex, ["curve25519-sha256"]);
    assert.deepEqual(resolved.config.algorithms?.serverHostKey, ["ssh-ed25519"]);
    assert.ok(Array.isArray(resolved.config.authHandler));
    const verify = resolved.config.hostVerifier as (key: Buffer) => boolean;
    assert.equal(verify(hostKey), true);
    assert.equal(verify(Buffer.from("different-host-key")), false);
    assert.match(resolved.verification.rejection ?? "", /does not match/);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes("-G"));
    assert.ok(calls[1].args.includes("-F"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ssh2 resolves multi-hop ProxyJump endpoints with per-hop OpenSSH settings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ssh2-jump-config-test-"));
  const knownHosts = join(directory, "known_hosts");
  writeFileSync(knownHosts, "placeholder\n");
  const configCalls: string[][] = [];
  try {
    const resolved = await resolveSsh2Connection(
      { target: "private-host", connectTimeoutSeconds: 12 },
      {
        platform: "linux",
        home: directory,
        env: { SSH_AUTH_SOCK: "/tmp/test-agent" },
        runLocal: async (_executable, args) => {
          if (args.includes("-G")) {
            configCalls.push([...args]);
            const target = args.at(-1);
            const common = [
              `userknownhostsfile ${knownHosts}`,
              "globalknownhostsfile none",
              "identityagent SSH_AUTH_SOCK",
              "pubkeyauthentication true",
              "identitiesonly no",
            ];
            if (target === "private-host") {
              return {
                stdout: Buffer.from([
                  "host private-host",
                  "user deploy",
                  "hostname private.internal",
                  "port 22",
                  "proxyjump jumpuser@jump:2200,jump2",
                  ...common,
                ].join("\n") + "\n"),
                stderr: Buffer.alloc(0),
                exitCode: 0,
              };
            }
            if (target === "jump") {
              return {
                stdout: Buffer.from([
                  "host jump",
                  "user jumpuser",
                  "hostname jump.internal",
                  "port 2200",
                  "proxyjump none",
                  ...common,
                ].join("\n") + "\n"),
                stderr: Buffer.alloc(0),
                exitCode: 0,
              };
            }
            return {
              stdout: Buffer.from([
                "host jump2",
                "user relay",
                "hostname jump2.internal",
                "port 22",
                "proxyjump none",
                ...common,
              ].join("\n") + "\n"),
              stderr: Buffer.alloc(0),
              exitCode: 0,
            };
          }

          const lookup = args[args.indexOf("-F") + 1];
          const key = Buffer.from(`host-key:${lookup}`).toString("base64");
          return {
            stdout: Buffer.from(`${lookup} ssh-ed25519 ${key}\n`),
            stderr: Buffer.alloc(0),
            exitCode: 0,
          };
        },
      },
    );

    assert.equal(resolved.hostLabel, "deploy@private.internal:22");
    assert.equal(resolved.proxyJumps?.length, 2);
    assert.equal(resolved.proxyJumps?.[0].hostLabel, "jumpuser@jump.internal:2200");
    assert.equal(resolved.proxyJumps?.[1].hostLabel, "relay@jump2.internal:22");
    assert.equal(resolved.proxyJumps?.[0].config.port, 2200);
    assert.ok(configCalls[1].includes("ProxyJump=none"));
    assert.deepEqual(configCalls[1].slice(-5), ["-l", "jumpuser", "-p", "2200", "jump"]);
    assert.ok(configCalls[2].includes("ProxyJump=none"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ssh2 reports unsupported arbitrary OpenSSH proxy commands before connecting", async () => {
  await assert.rejects(
    () => resolveSsh2Connection(
      { target: "private-host" },
      {
        platform: "linux",
        runLocal: async () => ({
          stdout: Buffer.from("user deploy\nhostname private.example\nport 22\nproxycommand nc proxy 22\n"),
          stderr: Buffer.alloc(0),
          exitCode: 0,
        }),
      },
    ),
    (error: unknown) => error instanceof Ssh2CompatibilityError
      && error.unsupported.includes("ProxyCommand"),
  );
});

test("OpenSSH config, ProxyJump, and known_hosts parsers preserve effective values", () => {
  const config = parseOpenSshConfig("identityfile ~/.ssh/a\nidentityfile ~/.ssh/b key\nuser deploy\n");
  assert.deepEqual(config.get("identityfile"), ["~/.ssh/a", "~/.ssh/b key"]);
  assert.deepEqual(config.get("user"), ["deploy"]);

  assert.deepEqual(parseProxyJump("alice@jump:2200,ssh://bob@[2001:db8::1]:2222"), [
    { host: "jump", username: "alice", port: 2200, source: "alice@jump:2200" },
    { host: "2001:db8::1", username: "bob", port: 2222, source: "ssh://bob@[2001:db8::1]:2222" },
  ]);
  assert.equal(expandProxyJumpTokens("%r@jump-%n,ssh://relay@[%h]:%p,percent-%%", {
    host: "private.internal",
    originalHost: "private-host",
    port: 2222,
    username: "deploy",
  }), "deploy@jump-private-host,ssh://relay@[private.internal]:2222,percent-%");
  assert.throws(() => parseProxyJump("jump:invalid"), /Invalid ProxyJump port/);

  const parsed = parseKnownHostSearchOutput([
    "host ssh-ed25519 aG9zdC1rZXk=",
    "@revoked host ssh-rsa cmV2b2tlZA==",
    "@cert-authority *.example ssh-ed25519 Y2E=",
  ].join("\n"));
  assert.ok(parsed.accepted.has("aG9zdC1rZXk="));
  assert.ok(parsed.revoked.has("cmV2b2tlZA=="));
  assert.equal(parsed.hasCertificateAuthority, true);
});

class FakeSsh2Channel extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  input = Buffer.alloc(0);
  private closed = false;

  end(input?: string | Buffer): void {
    this.input = input === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(input) ? input : Buffer.from(input);
    queueMicrotask(() => {
      if (this.closed) return;
      this.emit("data", Buffer.from("stdout:"));
      this.stderr.write(Buffer.from("stderr:"));
      this.emit("exit", 0);
      this.closed = true;
      this.emit("close");
    });
  }

  signal(value: string): void {
    this.signals.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
  }
}

class FakeSsh2Tunnel extends PassThrough {
  close(): void {
    this.destroy();
  }
}

class FakeRawSsh2Client extends EventEmitter {
  readonly channels: FakeSsh2Channel[] = [];
  readonly connectConfigs: Array<Record<string, unknown>> = [];
  readonly forwardCalls: Array<{
    sourceHost: string;
    sourcePort: number;
    destinationHost: string;
    destinationPort: number;
    channel: FakeSsh2Tunnel;
  }> = [];
  connectCalls = 0;
  closed = false;

  connect(config: Record<string, unknown> = {}): void {
    this.connectCalls++;
    this.connectConfigs.push(config);
    queueMicrotask(() => this.emit("ready"));
  }

  forwardOut(
    sourceHost: string,
    sourcePort: number,
    destinationHost: string,
    destinationPort: number,
    callback: (error: Error | undefined, channel: FakeSsh2Tunnel) => void,
  ): void {
    const channel = new FakeSsh2Tunnel();
    this.forwardCalls.push({ sourceHost, sourcePort, destinationHost, destinationPort, channel });
    queueMicrotask(() => callback(undefined, channel));
  }

  exec(_command: string, callback: (error: Error | undefined, channel: FakeSsh2Channel) => void): void {
    const channel = new FakeSsh2Channel();
    this.channels.push(channel);
    callback(undefined, channel);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
  }

  destroy(): void {
    this.end();
  }
}

class FakeAuthFailClient extends FakeRawSsh2Client {
  constructor(readonly failAuthTimes = 1) {
    super();
  }

  connect(config: Record<string, unknown> = {}): void {
    this.connectCalls++;
    this.connectConfigs.push(config);
    if (this.connectCalls <= this.failAuthTimes) {
      const error = new Error("All configured authentication methods failed");
      (error as { level?: string }).level = "client-authentication";
      queueMicrotask(() => this.emit("error", error));
      return;
    }
    queueMicrotask(() => this.emit("ready"));
  }
}

test("Ssh2Client reuses one authenticated connection for multiple command channels", async () => {
  const raw = new FakeRawSsh2Client();
  let created = 0;
  const client = new Ssh2Client(
    { target: "devbox" },
    {
      createClient: () => {
        created++;
        return raw as any;
      },
      resolveConnection: async () => ({
        config: { host: "devbox", username: "deploy" },
        hostLabel: "deploy@devbox:22",
        warnings: [],
        verification: {},
      }),
    },
  );
  const streamed: string[] = [];
  const first = await client.run("one", {
    input: Buffer.from("payload"),
    onStdout: (data) => streamed.push(data.toString("utf8")),
  });
  const second = await client.run("two");

  assert.equal(created, 1);
  assert.equal(raw.connectCalls, 1);
  assert.equal(raw.channels.length, 2);
  assert.equal(raw.channels[0].input.toString("utf8"), "payload");
  assert.equal(first.stdout.toString("utf8"), "stdout:");
  assert.equal(first.stderr.toString("utf8"), "stderr:");
  assert.equal(second.exitCode, 0);
  assert.deepEqual(streamed, ["stdout:"]);
  await client.dispose();
  assert.equal(raw.closed, true);
});

test("Ssh2Client hard-aborts a channel that ignores SSH signals and close", async () => {
  class HungChannel extends FakeSsh2Channel {
    override end(input?: string | Buffer): void {
      this.input = input === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(input) ? input : Buffer.from(input);
    }
    override close(): void {}
    destroy(): void {}
  }
  class HungClient extends FakeRawSsh2Client {
    override exec(
      _command: string,
      callback: (error: Error | undefined, channel: HungChannel) => void,
    ): void {
      const channel = new HungChannel();
      this.channels.push(channel);
      callback(undefined, channel);
    }
  }

  const raw = new HungClient();
  const client = new Ssh2Client(
    { target: "winbox" },
    {
      createClient: () => raw as any,
      terminationGraceMs: 10,
      resolveConnection: async () => ({
        config: { host: "winbox", username: "deploy" },
        hostLabel: "deploy@winbox:22",
        warnings: [],
        verification: {},
      }),
    },
  );
  const controller = new AbortController();
  const running = client.run("hung powershell command", {
    signal: controller.signal,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(running, /aborted/);
  assert.deepEqual(raw.channels[0].signals, ["TERM", "KILL"]);
  assert.equal(raw.closed, true, "a stuck channel must invalidate its ssh2 connection");
  await client.dispose();
});

test("Ssh2Client closes an exec channel that arrives after forced cancellation", async () => {
  class LateChannel extends FakeSsh2Channel {
    closeCalls = 0;
    destroyCalls = 0;
    override close(): void {
      this.closeCalls += 1;
      throw new Error("late close rejected");
    }
    destroy(): void {
      this.destroyCalls += 1;
    }
  }
  class DelayedClient extends FakeRawSsh2Client {
    delayedExec?: (error: Error | undefined, channel: LateChannel) => void;
    override exec(
      _command: string,
      callback: (error: Error | undefined, channel: LateChannel) => void,
    ): void {
      this.delayedExec = callback;
    }
  }

  const raw = new DelayedClient();
  const client = new Ssh2Client(
    { target: "winbox" },
    {
      createClient: () => raw as any,
      terminationGraceMs: 10,
      resolveConnection: async () => ({
        config: { host: "winbox", username: "deploy" },
        hostLabel: "deploy@winbox:22",
        warnings: [],
        verification: {},
      }),
    },
  );
  const controller = new AbortController();
  const running = client.run("delayed channel", { signal: controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(raw.delayedExec);
  controller.abort();
  await assert.rejects(running, /aborted/);

  const lateChannel = new LateChannel();
  raw.delayedExec(undefined, lateChannel);
  assert.equal(lateChannel.closeCalls, 1);
  assert.equal(lateChannel.destroyCalls, 1);
  await client.dispose();
});

test("Ssh2Client enforces timeout when a channel never closes", async () => {
  class HungChannel extends FakeSsh2Channel {
    override end(): void {}
    override close(): void {}
    destroy(): void {}
  }
  class HungClient extends FakeRawSsh2Client {
    override exec(
      _command: string,
      callback: (error: Error | undefined, channel: HungChannel) => void,
    ): void {
      const channel = new HungChannel();
      this.channels.push(channel);
      callback(undefined, channel);
    }
  }

  const raw = new HungClient();
  const client = new Ssh2Client(
    { target: "winbox" },
    {
      createClient: () => raw as any,
      terminationGraceMs: 10,
      resolveConnection: async () => ({
        config: { host: "winbox", username: "deploy" },
        hostLabel: "deploy@winbox:22",
        warnings: [],
        verification: {},
      }),
    },
  );

  await assert.rejects(
    client.run("hung powershell command", { timeoutSeconds: 0.01 }),
    /timeout:0\.01/,
  );
  assert.deepEqual(raw.channels[0].signals, ["TERM", "KILL"]);
  assert.equal(raw.closed, true);
  await client.dispose();
});

test("Ssh2Client prompts on key-less hosts via the empty-password placeholder", async () => {
  // No keys, no agent, no cached password: buildAuthentication must not
  // reject early; the empty password method reaches the auth phase, fails,
  // and the retry loop prompts.
  const raw = new FakeAuthFailClient();
  let created = 0;
  const prompts: string[] = [];
  const cachedPasswords = new Map<string, string>();
  const endpoint = {
    hostLabel: "root@router:22",
    username: "root",
    host: "router",
    port: 22,
  };
  const client = new Ssh2Client(
    { target: "router" },
    {
      createClient: () => {
        created++;
        return raw as any;
      },
      resolverOptions: {
        passwordFor: async (ep) => cachedPasswords.get(ep.hostLabel),
        allowPasswordPrompt: true,
      },
      resolveConnection: async (_options, resolverOptions) => {
        const password = resolverOptions.passwordFor
          ? await resolverOptions.passwordFor(endpoint)
          : undefined;
        return {
          config: {
            host: "router",
            username: "root",
            authHandler: [
              { type: "none", username: "root" },
              // The placeholder arrives when nothing is available; the
              // retry resolves the real password afterwards.
              { type: "password", username: "root", password: password ?? "" },
            ],
          },
          hostLabel: "root@router:22",
          warnings: [],
          verification: {},
        };
      },
      promptPassword: async (ep) => {
        prompts.push(ep.hostLabel);
        cachedPasswords.set(ep.hostLabel, "real-pw");
        return "real-pw";
      },
    },
  );
  const result = await client.run("probe");
  assert.equal(result.exitCode, 0);
  assert.equal(created, 2);
  assert.deepEqual(prompts, ["root@router:22"]);
  const retried = raw.connectConfigs[1].authHandler as Array<Record<string, unknown>>;
  assert.ok(retried.some((method) => method.type === "password" && method.password === "real-pw"));
});

test("Ssh2Client asks for a password on authentication failure and retries", async () => {
  const raw = new FakeAuthFailClient();
  let created = 0;
  const prompts: string[] = [];
  const cachedPasswords = new Map<string, string>();
  const endpoint = {
    hostLabel: "deploy@devbox:22",
    username: "deploy",
    host: "devbox",
    port: 22,
  };
  const client = new Ssh2Client(
    { target: "devbox" },
    {
      createClient: () => {
        created++;
        return raw as any;
      },
      resolverOptions: {
        passwordFor: async (ep) => cachedPasswords.get(ep.hostLabel),
      },
      resolveConnection: async (_options, resolverOptions) => {
        const password = resolverOptions.passwordFor
          ? await resolverOptions.passwordFor(endpoint)
          : undefined;
        return {
          config: {
            host: "devbox",
            username: "deploy",
            authHandler: password
              ? [
                  { type: "none", username: "deploy" },
                  { type: "password", username: "deploy", password },
                ]
              : [{ type: "none", username: "deploy" }],
          },
          hostLabel: "deploy@devbox:22",
          warnings: [],
          verification: {},
        };
      },
      promptPassword: async (ep) => {
        prompts.push(ep.hostLabel);
        cachedPasswords.set(ep.hostLabel, "s3cret");
        return "s3cret";
      },
    },
  );
  await client.run("whoami");

  assert.equal(created, 2);
  assert.equal(raw.connectCalls, 2);
  assert.deepEqual(prompts, ["deploy@devbox:22"]);
  const retried = raw.connectConfigs[1].authHandler as Array<Record<string, unknown>>;
  assert.ok(retried.some((method) => method.type === "password" && method.password === "s3cret"));
});

test("cancelled password prompts do not re-prompt for later candidates", async () => {
  // ssh2 path: after cancellation the client fails fast instead of asking
  // again for the next shell candidate.
  const raw = new FakeAuthFailClient();
  let prompts = 0;
  const client = new Ssh2Client(
    { target: "devbox" },
    {
      createClient: () => raw as any,
      resolveConnection: async () => ({
        config: { host: "devbox", username: "deploy" },
        hostLabel: "deploy@devbox:22",
        warnings: [],
        verification: {},
      }),
      promptPassword: async () => {
        prompts++;
        return undefined;
      },
    },
  );
  await assert.rejects(client.run("whoami"), /cancelled/);
  await assert.rejects(client.run("whoami"), /cancelled/);
  assert.equal(prompts, 1);
});

test("explicit openssh does not re-prompt after the user cancelled", async () => {
  let prompts = 0;
  const client = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "openssh",
      createOpenSsh: () => ({
        options: { target: "devbox" },
        transport: "openssh",
        reusesConnection: false,
        run: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("Permission denied (publickey,password)."),
          exitCode: 255,
        }),
        runChecked: async () => {
          throw new Error("SSH command failed (255): Permission denied (publickey,password)");
        },
        dispose: () => {},
      }),
      passwordProvider: {
        cached: () => undefined,
        retry: async () => {
          prompts++;
          return undefined;
        },
      },
      detectSshpass: async () => true,
    },
  );
  await assert.rejects(client.runChecked("whoami"), /cancelled/);
  // After cancellation every later call fails fast with the same
  // cancellation; it must not return the 255 result (which would make the
  // auto fallback prompt again) nor re-prompt.
  await assert.rejects(client.runChecked("whoami"), /cancelled/);
  assert.equal(prompts, 1);
});

test("Ssh2Client reports cancellation when the password prompt is dismissed", async () => {
  const raw = new FakeAuthFailClient();
  const client = new Ssh2Client(
    { target: "devbox" },
    {
      createClient: () => raw as any,
      resolveConnection: async () => ({
        config: { host: "devbox", username: "deploy" },
        hostLabel: "deploy@devbox:22",
        warnings: [],
        verification: {},
      }),
      promptPassword: async () => undefined,
    },
  );
  await assert.rejects(client.run("whoami"), /password authentication was cancelled/);
  assert.equal(raw.connectCalls, 1);
});

class FakeHostKeyFailClient extends FakeRawSsh2Client {
  connect(config: Record<string, unknown> = {}): void {
    this.connectCalls++;
    this.connectConfigs.push(config);
    queueMicrotask(() => this.emit("error", new Error("Host verification failed")));
  }
}

test("Ssh2Client does not ask for a password on host key failures", async () => {
  const raw = new FakeHostKeyFailClient();
  let prompts = 0;
  const client = new Ssh2Client(
    { target: "devbox" },
    {
      createClient: () => raw as any,
      resolveConnection: async () => ({
        config: { host: "devbox", username: "deploy" },
        hostLabel: "deploy@devbox:22",
        warnings: [],
        verification: { rejection: "host key mismatch" },
      }),
      promptPassword: async () => {
        prompts++;
        return "x";
      },
    },
  );
  const error = await client.run("whoami").then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof Ssh2ConnectionError);
  assert.match(error.message, /host key mismatch/);
  assert.equal(prompts, 0);
});

test("Ssh2Client builds and disposes a recursive ProxyJump connection chain", async () => {
  const rawClients = Array.from({ length: 6 }, () => new FakeRawSsh2Client());
  let created = 0;
  const endpoint = (host: string, username: string) => ({
    config: { host, port: 22, username },
    hostLabel: `${username}@${host}:22`,
    warnings: [],
    verification: {},
  });
  const client = new Ssh2Client(
    { target: "target" },
    {
      createClient: () => rawClients[created++] as any,
      resolveConnection: async () => ({
        ...endpoint("target.internal", "deploy"),
        proxyJumps: [
          endpoint("jump1.internal", "relay1"),
          endpoint("jump2.internal", "relay2"),
        ],
      }),
    },
  );

  const result = await client.run("echo through jumps");
  const second = await client.run("echo reuse chain");
  assert.equal(result.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(created, 3);
  assert.equal(rawClients[2].channels.length, 2);
  assert.equal(rawClients[0].forwardCalls[0].destinationHost, "jump2.internal");
  assert.equal(rawClients[1].forwardCalls[0].destinationHost, "target.internal");
  assert.equal(rawClients[0].forwardCalls[0].destinationPort, 22);
  assert.equal(rawClients[0].connectConfigs[0].sock, undefined);
  assert.equal(rawClients[1].connectConfigs[0].sock, rawClients[0].forwardCalls[0].channel);
  assert.equal(rawClients[2].connectConfigs[0].sock, rawClients[1].forwardCalls[0].channel);

  rawClients[0].end();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(rawClients.slice(0, 3).map((raw) => raw.closed), [true, true, true]);

  assert.equal((await client.run("echo reconnect chain")).exitCode, 0);
  assert.equal(created, 6);
  await client.dispose();
  assert.deepEqual(rawClients.map((raw) => raw.closed), [true, true, true, true, true, true]);
});

test("explicit openssh wraps sshpass retry on Windows too", async () => {
  const created: Array<{ sshpassPassword?: string }> = [];
  const client = createSshTransportClient(
    { target: "winbox" },
    {
      platform: "win32",
      preference: "openssh",
      createOpenSsh: (options) => {
        created.push(options);
        const { sshpassPassword } = options;
        return {
          options,
          transport: "openssh",
          reusesConnection: false,
          run: async () => {
            if (!sshpassPassword) throw new Error("SSH command failed (255): Permission denied (publickey,password)");
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          runChecked: async () => {
            if (!sshpassPassword) throw new Error("SSH command failed (255): Permission denied (publickey,password)");
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          dispose: () => {},
        };
      },
      passwordProvider: { cached: () => "win-pw", retry: async () => "win-pw" },
      detectSshpass: async () => true,
    },
  );
  const result = await client.runChecked("whoami");
  assert.equal(result.exitCode, 0);
  assert.equal(created.length, 2);
  assert.equal(created[1].sshpassPassword, "win-pw");
  assert.equal(created[1].executable, "ssh.exe");
  await client.dispose();
});

test("OpenSshClient runs sshpass -e with SSHPASS and a single prompt when a password is set", async () => {
  class FakeProcess extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    kill(): boolean {
      queueMicrotask(() => this.emit("close", null));
      return true;
    }
  }

  const spawned: Array<{ file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  const spawn = (
    file: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess => {
    spawned.push({ file, args, env: options.env });
    const child = new FakeProcess();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("ok\n"));
      child.emit("close", 0);
    });
    return child;
  };
  const client = new OpenSshClient({ target: "devbox", sshpassPassword: "s3cret" }, spawn);
  const result = await client.runChecked("whoami");
  assert.equal(result.exitCode, 0);

  assert.equal(spawned.length, 1);
  const call = spawned[0];
  assert.equal(call.file, "sshpass");
  assert.equal(call.args[0], "-e");
  assert.equal(call.args[1], "ssh");
  assert.ok(call.args.includes("-o"));
  assert.ok(call.args.includes("NumberOfPasswordPrompts=1"));
  assert.ok(call.args.includes("BatchMode=no"));
  assert.ok(call.args.includes("-T"));
  assert.equal(call.env?.SSHPASS, "s3cret");
});

test("255-result rejections surface the ssh error in the retry callback", async () => {
  const received: unknown[] = [];
  const client = createSshTransportClient(
    { target: "root@router" },
    {
      platform: "linux",
      preference: "openssh",
      createOpenSsh: (options) => {
        const { sshpassPassword } = options;
        return {
          options,
          transport: "openssh",
          reusesConnection: false,
          run: async () => {
            if (!sshpassPassword) {
              return {
                stdout: Buffer.alloc(0),
                stderr: Buffer.from("root@router: Permission denied (publickey,password)."),
                exitCode: 255,
              };
            }
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          runChecked: async () => {
            if (!sshpassPassword) {
              throw new Error("SSH command failed (255): Permission denied (publickey,password)");
            }
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          dispose: () => {},
        };
      },
      passwordProvider: {
        cached: () => undefined,
        retry: async (_endpoint, error) => {
          received.push(error);
          return "pw";
        },
      },
      detectSshpass: async () => true,
    },
  );
  await client.runChecked("whoami");
  assert.equal(received.length, 1);
  assert.ok(received[0] instanceof Error);
  assert.match((received[0] as Error).message, /Permission denied \(publickey,password\)/);
});

test("explicit openssh retries when auth failure arrives as a 255 result, not an exception", async () => {
  const prompts: string[] = [];
  const created: Array<{ sshpassPassword?: string }> = [];
  const client = createSshTransportClient(
    { target: "root@router" },
    {
      platform: "linux",
      preference: "openssh",
      createOpenSsh: (options) => {
        created.push(options);
        const { sshpassPassword } = options;
        return {
          options,
          transport: "openssh",
          reusesConnection: false,
          run: async () => {
            if (!sshpassPassword) {
              return {
                stdout: Buffer.alloc(0),
                stderr: Buffer.from("root@router: Permission denied (publickey,password)."),
                exitCode: 255,
              };
            }
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          runChecked: async () => {
            if (!sshpassPassword) {
              throw new Error("SSH command failed (255): Permission denied (publickey,password)");
            }
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          dispose: () => {},
        };
      },
      passwordProvider: {
        cached: () => undefined,
        retry: async (endpoint) => {
          prompts.push(endpoint.hostLabel);
          return "pw";
        },
      },
      detectSshpass: async () => true,
    },
  );
  // runChecked throws on the 255 result; the retry must still happen.
  const result = await client.runChecked("probe");
  assert.equal(result.exitCode, 0);
  // The secret key matches the ssh2 format (user@host:port) so both
  // transports share one cached password.
  assert.deepEqual(prompts, ["root@router:22"]);
  assert.equal(created[1].sshpassPassword, "pw");
});

test("Unix auto falls back on a 255 permission-denied result", async () => {
  let ssh2Runs = 0;
  const client = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "auto",
      detectSshpass: async () => false,
      createOpenSsh: () => ({
        options: { target: "devbox", multiplex: true },
        transport: "openssh",
        reusesConnection: true,
        run: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("devbox: Permission denied (publickey,password)."),
          exitCode: 255,
        }),
        runChecked: async () => {
          throw new Error("SSH command failed (255): Permission denied (publickey,password)");
        },
        dispose: () => {},
      }),
      createSsh2: () => ({
        options: { target: "devbox" },
        transport: "ssh2",
        reusesConnection: true,
        run: async () => {
          ssh2Runs++;
          return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
        runChecked: async () => {
          ssh2Runs++;
          return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
        dispose: () => {},
      }),
      passwordProvider: { cached: () => "pw", retry: async () => "pw" },
    },
  );
  const result = await client.runChecked("probe");
  assert.equal(result.exitCode, 0);
  assert.equal(ssh2Runs, 1);
  assert.match(client.fallbackReason ?? "", /sshpass is not installed|Permission denied/);
  assert.equal(client.transport, "ssh2");
});

test("selectRemoteAdapter aborts on password cancellation instead of repeating it per candidate", async () => {
  const client = new FakeSshClient({ target: "router" });
  const originalRunChecked = client.runChecked.bind(client);
  (client as any).runChecked = async (command: string, options?: SshRunOptions) => {
    if (command.includes("PI_SSH_UNIX_ENV")) {
      throw new Error("password authentication was cancelled; reconnect with /ssh-reconnect to try again");
    }
    return originalRunChecked(command, options);
  };
  await assert.rejects(
    selectRemoteAdapter(client, { preference: "auto" }),
    /password authentication was cancelled/,
  );
});

test("selectRemoteAdapter fails fast and condenses SSH banner timeouts", async () => {
  const client = new FakeSshClient({ target: "devbox" });
  let attempts = 0;
  (client as any).run = async () => {
    attempts++;
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(
        "Connection timed out during banner exchange\nConnection to devbox port 6000 timed out\n",
      ),
      exitCode: 255,
    };
  };

  await assert.rejects(
    selectRemoteAdapter(client, { preference: "auto" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "SSH connection timed out during banner exchange. Check the configured host, port, proxy settings, and sshd.",
      );
      assert.doesNotMatch(error.message, /Probe results|bash|pwsh/);
      return true;
    },
  );
  assert.equal(attempts, 1, "a terminal connection failure must not be retried per shell");
});

test("selectRemoteAdapter fails fast when its SSH probe hits the hard timeout", async () => {
  const client = new FakeSshClient({ target: "devbox" });
  let attempts = 0;
  (client as any).run = async () => {
    attempts++;
    throw new Error("timeout:10");
  };

  await assert.rejects(
    selectRemoteAdapter(client, { preference: "auto" }),
    /SSH connection probe timed out after 10 seconds.*host, port, proxy settings, and sshd/,
  );
  assert.equal(attempts, 1);
});

test("selectRemoteAdapter reports authentication rejection once", async () => {
  const client = new FakeSshClient({ target: "devbox" });
  let attempts = 0;
  (client as any).run = async () => {
    attempts++;
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("deploy@devbox: Permission denied (publickey,password)."),
      exitCode: 255,
    };
  };

  await assert.rejects(
    selectRemoteAdapter(client, { preference: "auto" }),
    /SSH authentication failed: deploy@devbox: Permission denied \(publickey,password\)/,
  );
  assert.equal(attempts, 1);
});

test("explicit openssh retries a rejected password through sshpass and prompts until cancelled", async () => {
  const prompts: string[] = [];
  const provider = {
    cached: () => undefined,
    retry: async (endpoint: { hostLabel: string }) => {
      prompts.push(endpoint.hostLabel);
      return "pw1";
    },
  };
  const created: Array<{ sshpassPassword?: string }> = [];
  let authFails = 1;
  const client = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "openssh",
      createOpenSsh: (options) => {
        created.push(options);
        const { sshpassPassword } = options;
        return {
          options,
          transport: "openssh",
          reusesConnection: false,
          run: async () => {
            if (!sshpassPassword && authFails-- > 0) {
              throw new Error("SSH command failed (255): Permission denied (publickey,password)");
            }
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          runChecked: async () => {
            if (!sshpassPassword && authFails-- > 0) {
              throw new Error("SSH command failed (255): Permission denied (publickey,password)");
            }
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          dispose: () => {},
        };
      },
      passwordProvider: provider,
      detectSshpass: async () => true,
    },
  );

  const result = await client.runChecked("whoami");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(prompts, ["devbox"]);
  // First client without a password, then one rebuilt with the secret.
  assert.equal(created.length, 2);
  assert.equal(created[0].sshpassPassword, undefined);
  assert.equal(created[1].sshpassPassword, "pw1");
  await client.dispose();
});

test("explicit openssh uses a cached password without prompting", async () => {
  const prompts: string[] = [];
  const created: Array<{ sshpassPassword?: string }> = [];
  const client = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "openssh",
      createOpenSsh: (options) => {
        created.push(options);
        const { sshpassPassword } = options;
        return {
          options,
          transport: "openssh",
          reusesConnection: false,
          run: async () => {
            if (!sshpassPassword) throw new Error("SSH command failed (255): Permission denied (publickey,password)");
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          runChecked: async () => {
            if (!sshpassPassword) throw new Error("SSH command failed (255): Permission denied (publickey,password)");
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          dispose: () => {},
        };
      },
      passwordProvider: {
        cached: () => "cached-pw",
        retry: async () => {
          prompts.push("should not prompt");
          return "x";
        },
      },
      detectSshpass: async () => true,
    },
  );
  await client.runChecked("whoami");
  assert.deepEqual(prompts, []);
  assert.equal(created[1].sshpassPassword, "cached-pw");
});

test("servers that reject password auth never trigger the prompt or the ssh2 fallback", async () => {
  // OpenSSH reports the accepted methods in parentheses; without password
  // or keyboard-interactive a prompt could never succeed.
  let prompts = 0;
  let ssh2Runs = 0;
  const client = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "auto",
      createOpenSsh: () => ({
        options: { target: "devbox", multiplex: true },
        transport: "openssh",
        reusesConnection: true,
        run: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("devbox: Permission denied (publickey)."),
          exitCode: 255,
        }),
        runChecked: async () => {
          throw new Error("SSH command failed (255): devbox: Permission denied (publickey).");
        },
        dispose: () => {},
      }),
      createSsh2: () => ({
        options: { target: "devbox" },
        transport: "ssh2",
        reusesConnection: true,
        run: async () => {
          ssh2Runs++;
          return { stdout: Buffer.from("x"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
        runChecked: async () => {
          ssh2Runs++;
          return { stdout: Buffer.from("x"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
        dispose: () => {},
      }),
      passwordProvider: {
        cached: () => undefined,
        retry: async () => {
          prompts++;
          return "pw";
        },
      },
      detectSshpass: async () => true,
    },
  );
  await assert.rejects(client.runChecked("probe"), /Permission denied \(publickey\)/);
  assert.equal(prompts, 0, "no prompt when the server does not accept passwords");
  assert.equal(ssh2Runs, 0, "no ssh2 fallback when it could only prompt in a loop");
  assert.equal(client.fallbackReason, undefined);
});

test("keyboard-interactive counts as password support", async () => {
  let prompts = 0;
  const client = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "openssh",
      createOpenSsh: (options) => {
        const { sshpassPassword } = options;
        return {
          options,
          transport: "openssh",
          reusesConnection: false,
          run: async () => {
            if (!sshpassPassword) {
              return {
                stdout: Buffer.alloc(0),
                stderr: Buffer.from("devbox: Permission denied (gssapi-keyex,gssapi-with-mic,publickey,keyboard-interactive)."),
                exitCode: 255,
              };
            }
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          runChecked: async () => {
            if (!sshpassPassword) {
              throw new Error("SSH command failed (255): Permission denied (keyboard-interactive).");
            }
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          dispose: () => {},
        };
      },
      passwordProvider: {
        cached: () => undefined,
        retry: async () => {
          prompts++;
          return "pw";
        },
      },
      detectSshpass: async () => true,
    },
  );
  const result = await client.runChecked("probe");
  assert.equal(result.exitCode, 0);
  assert.equal(prompts, 1);
});

test("explicit openssh explains when sshpass is missing and cancels cleanly", async () => {
  const missing = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "openssh",
      createOpenSsh: () => ({
        options: { target: "devbox" },
        transport: "openssh",
        reusesConnection: false,
        run: async () => { throw new Error("SSH command failed (255): Permission denied (publickey,password)"); },
        runChecked: async () => { throw new Error("SSH command failed (255): Permission denied (publickey,password)"); },
        dispose: () => {},
      }),
      passwordProvider: { cached: () => undefined, retry: async () => "x" },
      detectSshpass: async () => false,
    },
  );
  await assert.rejects(missing.runChecked("whoami"), /sshpass is not installed.*ssh2/);

  const cancelled = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "openssh",
      createOpenSsh: () => ({
        options: { target: "devbox" },
        transport: "openssh",
        reusesConnection: false,
        run: async () => { throw new Error("SSH command failed (255): Permission denied (publickey,password)"); },
        runChecked: async () => { throw new Error("SSH command failed (255): Permission denied (publickey,password)"); },
        dispose: () => {},
      }),
      passwordProvider: { cached: () => undefined, retry: async () => undefined },
      detectSshpass: async () => true,
    },
  );
  await assert.rejects(cancelled.runChecked("whoami"), /was cancelled/);
});

test("Unix auto reports rejected passwords instead of falling back to ssh2", async () => {
  // sshpass installed, prompts answered, but the server keeps rejecting:
  // ssh2 would fail with the same secret, so the flow must stop.
  let ssh2Runs = 0;
  let prompts = 0;
  const client = createSshTransportClient(
    { target: "root@router" },
    {
      platform: "linux",
      preference: "auto",
      createOpenSsh: () => ({
        options: { target: "root@router", multiplex: true },
        transport: "openssh",
        reusesConnection: true,
        run: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("root@router: Permission denied (publickey,password)."),
          exitCode: 255,
        }),
        runChecked: async () => {
          throw new Error("SSH command failed (255): Permission denied (publickey,password)");
        },
        dispose: () => {},
      }),
      createSsh2: () => ({
        options: { target: "root@router" },
        transport: "ssh2",
        reusesConnection: true,
        run: async () => {
          ssh2Runs++;
          return { stdout: Buffer.from("x"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
        runChecked: async () => {
          ssh2Runs++;
          return { stdout: Buffer.from("x"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
        dispose: () => {},
      }),
      passwordProvider: {
        cached: () => "stale-pw",
        retry: async () => {
          prompts++;
          return "fresh-pw";
        },
      },
      detectSshpass: async () => true,
    },
  );
  await assert.rejects(client.runChecked("probe"), /was rejected after 20 attempts/);
  assert.equal(ssh2Runs, 0, "rejected passwords must not fall back to ssh2");
  assert.ok(prompts >= 1, "the stale cached password triggered a re-prompt");
});

test("Unix auto retries OpenSSH through sshpass before falling back to ssh2", async () => {
  // Cached password + sshpass installed: the OpenSSH delegate is rebuilt
  // with the secret and succeeds; ssh2 never runs.
  let ssh2Runs = 0;
  let prompts = 0;
  const created: Array<{ sshpassPassword?: string }> = [];
  const client = createSshTransportClient(
    { target: "root@router" },
    {
      platform: "linux",
      preference: "auto",
      createOpenSsh: (options) => {
        created.push(options);
        const { sshpassPassword } = options;
        return {
          options,
          transport: "openssh",
          reusesConnection: true,
          run: async () => {
            if (!sshpassPassword) {
              return {
                stdout: Buffer.alloc(0),
                stderr: Buffer.from("root@router: Permission denied (publickey,password)."),
                exitCode: 255,
              };
            }
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          runChecked: async () => {
            if (!sshpassPassword) {
              throw new Error("SSH command failed (255): Permission denied (publickey,password)");
            }
            return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
          },
          dispose: () => {},
        };
      },
      createSsh2: () => ({
        options: { target: "root@router" },
        transport: "ssh2",
        reusesConnection: true,
        run: async () => {
          ssh2Runs++;
          return { stdout: Buffer.from("should not run"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
        runChecked: async () => {
          ssh2Runs++;
          return { stdout: Buffer.from("should not run"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
        dispose: () => {},
      }),
      passwordProvider: {
        cached: () => "cached-pw",
        retry: async () => {
          prompts++;
          return "never";
        },
      },
      detectSshpass: async () => true,
    },
  );
  const result = await client.runChecked("probe");
  assert.equal(result.exitCode, 0);
  assert.equal(ssh2Runs, 0, "ssh2 must not run when sshpass succeeds");
  assert.equal(prompts, 0, "cached password must not prompt");
  assert.equal(created[1].sshpassPassword, "cached-pw");
  assert.equal(client.fallbackReason, undefined);
  assert.equal(client.transport, "openssh");
});

test("Unix auto stays cancelled for later calls after the user dismissed the prompt", async () => {
  let ssh2Runs = 0;
  let prompts = 0;
  const client = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "auto",
      createOpenSsh: () => ({
        options: { target: "devbox", multiplex: true },
        transport: "openssh",
        reusesConnection: true,
        run: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("Permission denied (publickey,password)."),
          exitCode: 255,
        }),
        runChecked: async () => {
          throw new Error("SSH command failed (255): Permission denied (publickey,password)");
        },
        dispose: () => {},
      }),
      createSsh2: () => ({
        options: { target: "devbox" },
        transport: "ssh2",
        reusesConnection: true,
        run: async () => {
          ssh2Runs++;
          return { stdout: Buffer.from("x"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
        runChecked: async () => {
          ssh2Runs++;
          return { stdout: Buffer.from("x"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
        dispose: () => {},
      }),
      passwordProvider: { cached: () => undefined, retry: async () => {
        prompts++;
        return undefined;
      } },
      detectSshpass: async () => true,
    },
  );
  // First call: prompt once, user cancels, flow aborts.
  await assert.rejects(client.runChecked("probe"), /was cancelled/);
  // The shell candidate loop keeps calling the same client; every later
  // call must fail fast with the cancellation, never falling back to ssh2
  // (which would prompt again) and never re-prompting.
  await assert.rejects(client.runChecked("probe"), /was cancelled/);
  await assert.rejects(client.runChecked("probe"), /was cancelled/);
  assert.equal(ssh2Runs, 0);
  assert.equal(prompts, 1);
});

test("Unix auto does not fall back to ssh2 after the user cancelled the password prompt", async () => {
  let ssh2Runs = 0;
  const client = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "auto",
      createOpenSsh: () => ({
        options: { target: "devbox", multiplex: true },
        transport: "openssh",
        reusesConnection: true,
        run: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("Permission denied (publickey,password)."),
          exitCode: 255,
        }),
        runChecked: async () => {
          throw new Error("SSH command failed (255): Permission denied (publickey,password)");
        },
        dispose: () => {},
      }),
      createSsh2: () => ({
        options: { target: "devbox" },
        transport: "ssh2",
        reusesConnection: true,
        run: async () => {
          ssh2Runs++;
          return { stdout: Buffer.from("x"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
        runChecked: async () => {
          ssh2Runs++;
          return { stdout: Buffer.from("x"), stderr: Buffer.alloc(0), exitCode: 0 };
        },
        dispose: () => {},
      }),
      passwordProvider: { cached: () => undefined, retry: async () => undefined },
      detectSshpass: async () => true,
    },
  );
  await assert.rejects(client.runChecked("probe"), /was cancelled/);
  assert.equal(ssh2Runs, 0, "cancellation must abort the whole flow");
});

test("Unix auto falls back to ssh2 for passwords when OpenSSH auth fails", async () => {
  let openSshRuns = 0;
  let ssh2Runs = 0;
  const failingOpenSsh: SshRemoteClient = {
    options: { target: "devbox", multiplex: true },
    transport: "openssh",
    reusesConnection: true,
    run: async () => {
      openSshRuns++;
      throw new Error("SSH command failed (255): Permission denied (publickey,password)");
    },
    runChecked: async () => {
      openSshRuns++;
      throw new Error("SSH command failed (255): Permission denied (publickey,password)");
    },
    dispose: () => {},
  };
  const passwordSsh2: SshRemoteClient = {
    options: { target: "devbox" },
    transport: "ssh2",
    reusesConnection: true,
    run: async () => {
      ssh2Runs++;
      return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
    },
    runChecked: async () => {
      ssh2Runs++;
      return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
    },
    dispose: () => {},
  };
  const provider = { cached: () => "pw", retry: async () => "pw" };
  const client = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "auto",
      detectSshpass: async () => false,
      createOpenSsh: () => failingOpenSsh,
      createSsh2: () => passwordSsh2,
      passwordProvider: provider,
    },
  );

  assert.equal(client.transport, "openssh");
  const result = await client.runChecked("whoami");
  assert.equal(result.exitCode, 0);
  // No sshpass on this host: the failure falls straight back to ssh2
  // without a retry loop.
  assert.equal(openSshRuns, 1);
  assert.equal(ssh2Runs, 1);
  assert.equal(client.transport, "ssh2");
  assert.match(client.fallbackReason ?? "", /sshpass is not installed|Permission denied/);
  await client.dispose();
});

test("Unix auto does not fall back without a password provider or on non-auth errors", async () => {
  const providerless = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "auto",
      createOpenSsh: () => ({
        options: { target: "devbox" },
        transport: "openssh",
        reusesConnection: true,
        run: async () => { throw new Error("SSH command failed (255): Permission denied (publickey,password)"); },
        runChecked: async () => { throw new Error("SSH command failed (255): Permission denied (publickey,password)"); },
        dispose: () => {},
      }),
      createSsh2: () => ({
        options: { target: "devbox" },
        transport: "ssh2",
        reusesConnection: true,
        run: async () => { throw new Error("should not run"); },
        runChecked: async () => { throw new Error("should not run"); },
        dispose: () => {},
      }),
    },
  );
  await assert.rejects(providerless.runChecked("whoami"), /Permission denied/);
  assert.equal(providerless.fallbackReason, undefined);

  const networkError = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "auto",
      createOpenSsh: () => ({
        options: { target: "devbox" },
        transport: "openssh",
        reusesConnection: true,
        run: async () => { throw new Error("ssh: connect to host devbox port 22: Connection refused"); },
        runChecked: async () => { throw new Error("ssh: connect to host devbox port 22: Connection refused"); },
        dispose: () => {},
      }),
      createSsh2: () => ({
        options: { target: "devbox" },
        transport: "ssh2",
        reusesConnection: true,
        run: async () => { throw new Error("should not run"); },
        runChecked: async () => { throw new Error("should not run"); },
        dispose: () => {},
      }),
      passwordProvider: { cached: () => "pw", retry: async () => "pw" },
    },
  );
  await assert.rejects(networkError.runChecked("whoami"), /Connection refused/);
  assert.equal(networkError.fallbackReason, undefined);
});

test("transport wires the password provider into the ssh2 client", async () => {
  const provider = {
    cached: (endpoint: { hostLabel: string }) => endpoint.hostLabel === "u@h:22" ? "cached-pw" : undefined,
    retry: async () => "fresh-pw",
  };
  const client = createSshTransportClient(
    { target: "h" },
    { platform: "win32", preference: "ssh2", passwordProvider: provider },
  ) as unknown as { promptPassword?: unknown; resolverOptions?: { passwordFor?: unknown } };
  assert.equal(typeof client.promptPassword, "function");
  assert.equal(typeof client.resolverOptions?.passwordFor, "function");
  assert.equal(
    await (client.resolverOptions!.passwordFor as (ep: { hostLabel: string }) => string | undefined)(
      { hostLabel: "u@h:22", username: "u", host: "h", port: 22 },
    ),
    "cached-pw",
  );
  await client.dispose();
});

test("transport auto selects multiplexed OpenSSH on Unix and falls back on Windows ssh2 setup errors", async () => {
  const unixOptions: SshClientOptions[] = [];
  const unixClient = new FakeSshClient({ target: "devbox" });
  const unix = createSshTransportClient(
    { target: "devbox" },
    {
      platform: "linux",
      preference: "auto",
      createOpenSsh: (options) => {
        unixOptions.push(options);
        return unixClient;
      },
    },
  );
  // Unix auto wraps OpenSSH (inside an sshpass retry layer) so a rejected
  // password is retried in place before falling back to ssh2.
  const unixDelegate = (unix as { delegate?: SshRemoteClient }).delegate as unknown as {
    delegate?: SshRemoteClient;
  };
  assert.equal(unixDelegate.delegate, unixClient);
  assert.equal(unixOptions[0].multiplex, true);

  let openSshRuns = 0;
  const failedSsh2: SshRemoteClient = {
    options: { target: "winbox", executable: "ssh.exe", multiplex: false },
    transport: "ssh2",
    reusesConnection: true,
    run: async () => { throw new Ssh2ConnectionError("agent unavailable"); },
    runChecked: async () => { throw new Ssh2ConnectionError("agent unavailable"); },
    dispose: () => {},
  };
  const fallbackOpenSsh: SshRemoteClient = {
    options: { target: "winbox", executable: "ssh.exe", multiplex: false },
    transport: "openssh",
    reusesConnection: false,
    run: async () => {
      openSshRuns++;
      return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
    },
    runChecked: async () => {
      openSshRuns++;
      return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0 };
    },
    dispose: () => {},
  };
  const windows = createSshTransportClient(
    { target: "winbox" },
    {
      platform: "win32",
      preference: "auto",
      createSsh2: () => failedSsh2,
      createOpenSsh: (options) => {
        assert.equal(options.multiplex, false);
        return fallbackOpenSsh;
      },
    },
  );
  const result = await windows.run("echo ok");
  assert.equal(result.stdout.toString("utf8"), "ok");
  assert.equal(windows.transport, "openssh");
  assert.match(windows.fallbackReason ?? "", /agent unavailable/);
  assert.equal(openSshRuns, 1);
  await windows.dispose();
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
  let spawnOptions: SpawnOptions | undefined;
  const spawn = (
    _file: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess => {
    spawnOptions = options;
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
  assert.deepEqual(spawnOptions?.stdio, ["pipe", "pipe", "pipe"]);
  client.dispose();
});

test("remote Unix paths use platform-safe logical namespaces", () => {
  const client = new FakeSshClient({ target: "devbox" });
  const workspace: RemoteWorkspace = {
    platform: "unix",
    shell: "bash",
    home: "/home/deploy",
    cwd: "/srv/project",
  };

  const posixAdapter = new UnixBashAdapter(client, "linux");
  const posixLogical = posixAdapter.toToolPath("src/a file.ts", workspace);
  assert.match(posixLogical, /^\/__pi_ssh_remote_unix__\/root\//);
  assert.doesNotMatch(posixLogical, /\/srv\/project/);
  assert.equal(
    posixAdapter.fromToolPath(posixLogical),
    "/srv/project/src/a file.ts",
  );
  assert.equal(
    posixAdapter.fromToolPath(posixAdapter.toToolPath("~/notes.txt", workspace)),
    "/home/deploy/notes.txt",
  );
  assert.throws(
    () => posixAdapter.fromToolPath("/srv/project/src/a file.ts"),
    /Invalid logical Unix tool path/,
  );

  const windowsAdapter = new UnixBashAdapter(client, "win32");
  const windowsLogical = windowsAdapter.toToolPath("src/a file.ts", workspace);
  assert.match(windowsLogical, /^C:\\__pi_ssh_remote_unix__\\root\\/);
  assert.equal(
    windowsAdapter.fromToolPath(windowsLogical),
    "/srv/project/src/a file.ts",
  );
});

test("remote file operations decode logical paths, quote native paths, and stream writes", async () => {
  const client = new FakeSshClient({ target: "devbox" });
  const adapter = new UnixBashAdapter(client, "linux");
  const workspace: RemoteWorkspace = {
    platform: "unix",
    shell: "bash",
    home: "/home/deploy",
    cwd: "/srv/project",
  };
  const toolPath = (path: string): string => adapter.toToolPath(path, workspace);
  const read = createRemoteReadOperations(adapter);
  const write = createRemoteWriteOperations(adapter);
  const edit = createRemoteEditOperations(adapter);

  assert.equal((await read.readFile(toolPath("/srv/a file.txt"))).toString(), "remote contents\n");
  assert.equal(await adapter.fileExists(toolPath("/srv/missing.png")), false);
  await read.access(toolPath("/srv/a file.txt"));
  assert.equal(await read.detectImageMimeType?.(toolPath("/srv/a file.txt")), null);
  await write.mkdir(toolPath("/srv/new dir"));
  await write.writeFile(toolPath("/srv/new dir/value.txt"), "secret ' content");
  await edit.access(toolPath("/srv/edit.ts"));

  const writeCall = client.calls.find((call) => call.command.startsWith("cat >"));
  assert.ok(writeCall);
  assert.equal(writeCall.options?.input, "secret ' content");
  assert.doesNotMatch(writeCall.command, /secret/);
  assert.match(writeCall.command, /'\/srv\/new dir\/value\.txt'/);
  assert.match(client.calls.find((call) => call.command.startsWith("test -r"))?.command ?? "", /'\/srv\/a file\.txt'/);
});

test("Pi write and edit mutation queues never realpath protected Unix remote paths locally", async () => {
  const client = new FakeSshClient(
    { target: "router" },
    { home: "/root", cwd: "/root" },
  );
  const adapter = new UnixBashAdapter(client, "linux");
  const workspace: RemoteWorkspace = {
    platform: "unix",
    shell: "sh",
    home: "/root",
    cwd: "/root",
  };
  const logicalCwd = adapter.toToolPath(workspace.cwd, workspace);
  const logicalPath = adapter.toToolPath("/root/tool-test.txt", workspace);
  assert.match(logicalPath, /^\/__pi_ssh_remote_unix__\/root\//);
  assert.doesNotMatch(logicalPath, /^\/root\//);

  const harness = createExtensionHarness();
  const writeResult = await createWriteToolDefinition(logicalCwd, {
    operations: createRemoteWriteOperations(adapter),
  }).execute(
    "write-protected-remote",
    { path: logicalPath, content: "new contents\n" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.match(writeResult.content[0].text, /Successfully wrote/);

  const editResult = await createEditToolDefinition(logicalCwd, {
    operations: createRemoteEditOperations(adapter),
  }).execute(
    "edit-protected-remote",
    {
      path: logicalPath,
      edits: [{ oldText: "remote contents", newText: "updated contents" }],
    },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.match(editResult.content[0].text, /Successfully replaced 1 block/);
  assert.ok(
    client.calls.some((call) => call.command.includes("'/root/tool-test.txt'")),
  );
  assert.ok(
    client.calls.every((call) => !call.command.includes("__pi_ssh_remote_unix__")),
  );
});

test("extension writes and edits protected Unix paths without exposing its logical namespace", async () => {
  const clients: FakeSshClient[] = [];
  const harness = createExtensionHarness({ flag: "router:/root" });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeSshClient(
        options,
        { home: "/root", cwd: "/root" },
      );
      clients.push(client);
      return client;
    },
    selectRemote: async () => ({
      adapter: new UnixBashAdapter(clients.at(-1)!, "linux", "sh"),
      workspace: {
        platform: "unix",
        shell: "sh",
        home: "/root",
        cwd: "/root",
      },
    }),
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });

  const writeResult = await harness.tools.get("write").execute(
    "write-root-remote",
    { path: "/root/tool-test.txt", content: "new contents\n" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(
    writeResult.content[0].text,
    "Successfully wrote 13 bytes to /root/tool-test.txt",
  );

  const editResult = await harness.tools.get("edit").execute(
    "edit-root-remote",
    {
      path: "/root/tool-test.txt",
      edits: [{ oldText: "remote contents", newText: "updated contents" }],
    },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(
    editResult.content[0].text,
    "Successfully replaced 1 block(s) in /root/tool-test.txt.",
  );
  assert.doesNotMatch(
    `${writeResult.content[0].text}\n${editResult.content[0].text}\n${editResult.details?.patch ?? ""}`,
    /__pi_ssh_remote_unix__/,
  );
  assert.ok(
    clients[0].calls.some((call) => call.command.includes("'/root/tool-test.txt'")),
  );
});

test("registered skill files and references stay local in SSH sessions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-skill-test-"));
  const references = join(directory, "references");
  const skillPath = join(directory, "SKILL.md");
  const referencePath = join(references, "guide.md");
  mkdirSync(references);
  writeFileSync(
    skillPath,
    "---\nname: test-skill\ndescription: Test local skill routing\n---\n\nLocal skill body\n",
  );
  writeFileSync(referencePath, "Local reference body\n");

  const clients: FakeSshClient[] = [];
  const harness = createExtensionHarness({
    flag: "router:/root",
    skillPaths: [skillPath],
  });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeSshClient(
        options,
        { home: "/root", cwd: "/root" },
      );
      clients.push(client);
      return client;
    },
    selectRemote: async () => ({
      adapter: new UnixBashAdapter(clients.at(-1)!, "linux", "sh"),
      workspace: {
        platform: "unix",
        shell: "sh",
        home: "/root",
        cwd: "/root",
      },
    }),
  })(harness.pi);

  try {
    await harness.emit("session_start", { reason: "startup" });
    const read = harness.tools.get("read");
    const callsBeforeSkillReads = clients[0].calls.length;

    const skillResult = await read.execute(
      "read-local-skill",
      { path: `@${skillPath}` },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.match(skillResult.content[0].text, /Local skill body/);

    const referenceResult = await read.execute(
      "read-local-skill-reference",
      { path: referencePath },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(referenceResult.content[0].text, "Local reference body\n");
    assert.equal(
      clients[0].calls.length,
      callsBeforeSkillReads,
      "skill reads must not open a remote SSH channel",
    );

    const remoteResult = await read.execute(
      "read-remote-file",
      { path: "/root/remote.txt" },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(remoteResult.content[0].text, "remote contents\n");
    assert.ok(
      clients[0].calls.some((call) => call.command.includes("'/root/remote.txt'")),
      "non-skill reads must remain remote",
    );
  } finally {
    await harness.emit("session_shutdown", { reason: "quit" });
    rmSync(directory, { recursive: true, force: true });
  }
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

test("background resolver maps remote cwd and signals the immutable SSH host", async () => {
  class FakeControlProcess extends EventEmitter {
    readonly stderr = new PassThrough();
    kill(): boolean {
      queueMicrotask(() => this.emit("close", null, "SIGKILL"));
      return true;
    }
  }

  const controlLaunches: Array<{
    file: string;
    args: readonly string[];
    options: SpawnOptions;
  }> = [];
  const spawnControl = (
    file: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess => {
    controlLaunches.push({ file, args: [...args], options });
    const child = new FakeControlProcess();
    const exitCode = controlLaunches.length === 1 ? 255 : 0;
    queueMicrotask(() => {
      child.stderr.end();
      child.emit("close", exitCode, null);
    });
    return child as unknown as ChildProcess;
  };

  const token = "0123456789abcdef0123456789abcdef";
  const client = new FakeSshClient({ target: "devbox" });
  const adapter = new UnixBashAdapter(client);
  const resolver = createSshBackgroundShellResolver({
    ssh: {
      target: "devbox",
      configFile: "/tmp/ssh.conf",
      multiplex: true,
      controlPath: "/tmp/old-master/mux",
      sshpassPassword: "must-not-be-forwarded",
    },
    adapter,
    workspace: {
      platform: "unix",
      shell: "bash",
      home: "/home/deploy",
      cwd: "/srv/project",
    },
    localCwd: "/local/project",
    env: { PATH: "/usr/bin" },
    spawnControl,
    createControlToken: () => token,
  });
  const launch = resolver("npm test", true, {
    cwd: "/local/project/packages/api",
    projectTrusted: true,
  });
  assert.equal(launch.file, "ssh");
  assert.equal(launch.env.SSHPASS, undefined);
  assert.equal(launch.cwd, "/local/project");
  assert.ok(launch.args.includes("-tt"));
  assert.ok(launch.args.includes("devbox"));
  assert.ok((launch.args.at(-1) ?? "").includes("/srv/project/packages/api"));
  assert.match(launch.args.at(-1) ?? "", /npm test/);
  assert.match(launch.args.at(-1) ?? "", new RegExp(`pi-ssh-bg-${token}`));
  assert.equal("sendSignal" in launch, false);
  assert.equal(typeof launch.control.sendSignal, "function");

  await launch.control.sendSignal("SIGTERM");
  assert.equal(controlLaunches.length, 2);
  assert.equal(controlLaunches[0].file, "ssh");
  assert.equal(controlLaunches[0].options.cwd, "/local/project");
  assert.ok(controlLaunches[0].args.includes("ControlMaster=auto"));
  assert.ok(controlLaunches[0].args.includes("/tmp/old-master/mux"));
  assert.ok(controlLaunches[0].args.includes("-n"));
  assert.ok(controlLaunches[0].args.includes("devbox"));

  assert.ok(controlLaunches[1].args.includes("ControlMaster=no"));
  assert.ok(controlLaunches[1].args.includes("ControlPath=none"));
  assert.ok(controlLaunches[1].args.includes("-n"));
  assert.ok(!controlLaunches[1].args.includes("/tmp/old-master/mux"));
  assert.match(controlLaunches[1].args.at(-1) ?? "", /signal_name=TERM/);
  assert.match(controlLaunches[1].args.at(-1) ?? "", new RegExp(`pi-ssh-bg-${token}`));
});

test("SSH background probe accepts a framed status after login banner output", async () => {
  class ProbeProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    kill(): boolean {
      return true;
    }
  }
  const resolver = createSshBackgroundShellResolver({
    ssh: { target: "devbox", batchMode: true },
    adapter: new UnixBashAdapter(new FakeSshClient({ target: "devbox" })),
    workspace: {
      platform: "unix",
      shell: "bash",
      home: "/home/deploy",
      cwd: "/srv/project",
    },
    localCwd: "/local/project",
    createControlToken: () => "102030405060708090a0b0c0d0e0f000",
    spawnControl: () => {
      const child = new ProbeProcess();
      queueMicrotask(() => {
        child.stdout.end("unexpected banner\nPI_SSH_BG_STATUS=running\n");
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child as unknown as ChildProcess;
    },
  });
  const launch = resolver("sleep 30", false, {
    cwd: "/local/project",
    projectTrusted: true,
  });
  assert.equal(await launch.control?.probe?.(), "running");
  await launch.control?.dispose?.();
});

test("SSH background control aborts its short-lived signal connection", async () => {
  class HangingControlProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    killedWith: string | undefined;
    kill(signal?: string): boolean {
      this.killedWith = signal;
      queueMicrotask(() => this.emit("close", null, signal ?? null));
      return true;
    }
  }

  let controlProcess: HangingControlProcess | undefined;
  const resolver = createSshBackgroundShellResolver({
    ssh: { target: "devbox", batchMode: true },
    adapter: new UnixBashAdapter(new FakeSshClient({ target: "devbox" })),
    workspace: {
      platform: "unix",
      shell: "bash",
      home: "/home/deploy",
      cwd: "/srv/project",
    },
    localCwd: "/local/project",
    createControlToken: () => "abcdef0123456789abcdef0123456789",
    spawnControl: () => {
      controlProcess = new HangingControlProcess();
      return controlProcess as unknown as ChildProcess;
    },
  });
  const launch = resolver("sleep 30", false, {
    cwd: "/local/project",
    projectTrusted: true,
  });
  const abortController = new AbortController();
  const sending = launch.control?.sendSignal("SIGTERM", {
    abortSignal: abortController.signal,
  });
  abortController.abort(new Error("cancel signal control"));
  await assert.rejects(Promise.resolve(sending), /cancel signal control/);
  assert.equal(controlProcess?.killedWith, "SIGKILL");
  await launch.control?.dispose?.();
});

test("Unix SSH background control preserves Bash traps and does not orphan children", {
  skip: process.platform === "win32" ? "requires POSIX process groups" : false,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-signal-test-"));
  const pidFile = join(directory, "child.pid");
  const inputFile = join(directory, "stdin.txt");
  const trapFile = join(directory, "trap.txt");
  const token = Buffer.from(`${process.pid}-${Date.now()}`).toString("hex");
  const controlDirectory = join(
    process.env.TMPDIR || "/tmp",
    `pi-ssh-bg-${token}`,
  );
  const trapAction = `printf trapped > ${shellQuote(trapFile)}; exit 42`;
  const bashScript = `trap ${shellQuote(trapAction)} INT; printf '%s\\n' $$ > ${shellQuote(pidFile)}; IFS= read -r input; printf '%s\\n' "$input" > ${shellQuote(inputFile)}; while :; do sleep 1; done`;
  const userCommand = `exec bash -c ${shellQuote(bashScript)}`;
  const wrapped = buildUnixBackgroundShellCommand(userCommand, token);
  const child = spawnChild("sh", ["-c", wrapped], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.on("error", () => {});
  child.stdin.write("forwarded over ssh stdin\n");
  const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  let commandPid = 0;

  try {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (existsSync(pidFile) && existsSync(inputFile)) {
        commandPid = Number(readFileSync(pidFile, "utf8").trim());
        if (Number.isInteger(commandPid) && commandPid > 0) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(commandPid > 0, "wrapped command should publish its child PID");
    assert.equal(readFileSync(inputFile, "utf8"), "forwarded over ssh stdin\n");

    const controller = spawnChild(
      "sh",
      ["-c", buildUnixBackgroundSignalCommand(token, "SIGINT")],
      { stdio: "ignore" },
    );
    const controlCode = await new Promise<number | null>((resolve, reject) => {
      controller.once("error", reject);
      controller.once("exit", resolve);
    });
    assert.equal(controlCode, 0);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("wrapped command did not exit after remote SIGINT")),
        5_000,
      );
      childExit.then(
        () => {
          clearTimeout(timeout);
          resolve();
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });

    assert.equal(readFileSync(trapFile, "utf8"), "trapped");

    let commandAlive = true;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        process.kill(commandPid, 0);
      } catch {
        commandAlive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(commandAlive, false, "the command child must not survive as an orphan");
  } finally {
    if (commandPid > 0) {
      try {
        process.kill(commandPid, "SIGKILL");
      } catch {}
    }
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    rmSync(controlDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Unix background control handles immediate kill and TERM-to-KILL escalation", {
  skip: process.platform === "win32" ? "requires POSIX signals" : false,
  timeout: 20_000,
}, async () => {
  const waitForExit = (child: ChildProcess, timeoutMs = 5_000) => new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("process did not exit")), timeoutMs);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  const immediateToken = Buffer.from(`${process.pid}-${Date.now()}-immediate`).toString("hex");
  const immediate = spawnChild(
    "sh",
    ["-c", buildUnixBackgroundShellCommand("while :; do sleep 1; done", immediateToken)],
    { detached: true, stdio: "ignore" },
  );
  const immediateExit = waitForExit(immediate);
  const immediateControl = spawnChild(
    "sh",
    ["-c", buildUnixBackgroundSignalCommand(immediateToken, "SIGKILL")],
    { stdio: "ignore" },
  );
  assert.equal((await waitForExit(immediateControl)).code, 0);
  await immediateExit;
  assert.equal(
    existsSync(join(process.env.TMPDIR || "/tmp", `pi-ssh-bg-${immediateToken}`)),
    false,
  );

  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-escalation-"));
  const pidFile = join(directory, "command.pid");
  const escalationToken = Buffer.from(`${process.pid}-${Date.now()}-escalation`).toString("hex");
  const ignored = spawnChild(
    "sh",
    [
      "-c",
      buildUnixBackgroundShellCommand(
        `trap '' TERM; printf '%s' $$ > ${shellQuote(pidFile)}; while :; do sleep 1; done`,
        escalationToken,
      ),
    ],
    { detached: true, stdio: "ignore" },
  );
  const ignoredExit = waitForExit(ignored, 10_000);
  let commandPid = 0;
  try {
    const deadline = Date.now() + 3_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    commandPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(commandPid > 0);

    const term = spawnChild(
      "sh",
      ["-c", buildUnixBackgroundSignalCommand(escalationToken, "SIGTERM")],
      { stdio: "ignore" },
    );
    assert.equal((await waitForExit(term)).code, 0);
    assert.doesNotThrow(() => process.kill(commandPid, 0));

    const kill = spawnChild(
      "sh",
      ["-c", buildUnixBackgroundSignalCommand(escalationToken, "SIGKILL")],
      { stdio: "ignore" },
    );
    assert.equal((await waitForExit(kill)).code, 0);
    await ignoredExit;
    assert.throws(() => process.kill(commandPid, 0));
  } finally {
    if (commandPid > 0) {
      try {
        process.kill(commandPid, "SIGKILL");
      } catch {}
    }
    if (ignored.pid) {
      try {
        process.kill(-ignored.pid, "SIGKILL");
      } catch {}
    }
    rmSync(join(process.env.TMPDIR || "/tmp", `pi-ssh-bg-${escalationToken}`), {
      recursive: true,
      force: true,
    });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Unix background control falls back correctly under BusyBox sh", {
  skip: process.platform === "win32" ? "requires BusyBox on POSIX" : false,
  timeout: 10_000,
}, async (t) => {
  const busybox = (process.env.PATH ?? "")
    .split(":")
    .map((directory) => join(directory, "busybox"))
    .find(existsSync);
  if (!busybox) {
    t.skip("busybox is unavailable");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-busybox-"));
  const shell = join(directory, "sh");
  symlinkSync(busybox, shell);
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` };
  const token = Buffer.from(`${process.pid}-${Date.now()}-busybox`).toString("hex");
  const task = spawnChild(
    "sh",
    ["-c", buildUnixBackgroundShellCommand("while :; do sleep 1; done", token)],
    { env, detached: true, stdio: "ignore" },
  );
  const taskExit = new Promise<void>((resolve, reject) => {
    task.once("error", reject);
    task.once("exit", () => resolve());
  });
  try {
    const control = spawnChild(
      "sh",
      ["-c", buildUnixBackgroundSignalCommand(token, "SIGKILL")],
      { env, stdio: "ignore" },
    );
    const controlCode = await new Promise<number | null>((resolve, reject) => {
      control.once("error", reject);
      control.once("exit", resolve);
    });
    assert.equal(controlCode, 0);
    await taskExit;
  } finally {
    if (task.pid) {
      try {
        process.kill(-task.pid, "SIGKILL");
      } catch {}
    }
    rmSync(join(process.env.TMPDIR || "/tmp", `pi-ssh-bg-${token}`), {
      recursive: true,
      force: true,
    });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real localhost OpenSSH preserves all supported Bash traps in pipe and PTY modes", {
  skip: process.platform === "win32" ? "requires a POSIX localhost SSH server" : false,
  timeout: 120_000,
}, async (t) => {
  const waitForExit = (
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => new Promise(
    (resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`process ${child.pid ?? "unknown"} did not exit`)),
        timeoutMs,
      );
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    },
  );
  const probe = spawnChild(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=2", "-T", "localhost", "true"],
    { stdio: "ignore" },
  );
  let probeResult: { code: number | null; signal: NodeJS.Signals | null };
  try {
    probeResult = await waitForExit(probe, 5_000);
  } catch (error) {
    t.skip(`localhost OpenSSH unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (probeResult.code !== 0) {
    t.skip("localhost OpenSSH key authentication is unavailable");
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-trap-matrix-"));
  const adapter = new UnixBashAdapter(
    new FakeSshClient({ target: "localhost" }),
    process.platform,
    "bash",
  );
  const signals = [
    "SIGINT",
    "SIGTERM",
    "SIGHUP",
    "SIGQUIT",
    "SIGUSR1",
    "SIGUSR2",
    "SIGALRM",
    "SIGPIPE",
  ] as const;

  try {
    for (const interactive of [false, true]) {
      for (const signal of signals) {
        const stem = `${interactive ? "pty" : "pipe"}-${signal.toLowerCase()}`;
        const readyFile = join(directory, `${stem}.ready`);
        const trapFile = join(directory, `${stem}.trap`);
        const token = Buffer.from(
          `${process.pid}-${Date.now()}-${stem}`,
        ).toString("hex").slice(0, 96);
        const trapAction = `printf '%s' ${shellQuote(signal)} > ${shellQuote(trapFile)}; exit 42`;
        const script = [
          `trap ${shellQuote(trapAction)} ${signal}`,
          `printf ready > ${shellQuote(readyFile)}`,
          "while :; do sleep 1; done",
        ].join("; ");
        const resolver = createSshBackgroundShellResolver({
          ssh: {
            target: "localhost",
            batchMode: true,
            connectTimeoutSeconds: 3,
          },
          adapter,
          workspace: {
            platform: "unix",
            shell: "bash",
            home: process.env.HOME ?? "/tmp",
            cwd: directory,
          },
          localCwd: process.cwd(),
          createControlToken: () => token,
        });
        const launch = resolver(
          `exec bash -c ${shellQuote(script)}`,
          interactive,
          { cwd: directory, projectTrusted: true },
        );
        const child = spawnChild(launch.file, launch.args, {
          cwd: launch.cwd,
          env: launch.env,
          detached: true,
          stdio: ["pipe", "ignore", "ignore"],
        });
        const exited = waitForExit(child, 8_000);
        try {
          const deadline = Date.now() + 5_000;
          while (!existsSync(readyFile) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.ok(existsSync(readyFile), `${stem} did not become ready`);
          await launch.control?.sendSignal(signal);
          const result = await exited;
          assert.equal(result.code, 42, `${stem} should preserve the Bash trap exit code`);
          assert.equal(readFileSync(trapFile, "utf8"), signal);
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              await launch.control?.sendSignal("SIGKILL");
            } catch {}
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {}
            }
          }
          await launch.control?.dispose?.();
          rmSync(join(process.env.TMPDIR || "/tmp", `pi-ssh-bg-${token}`), {
            recursive: true,
            force: true,
          });
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real localhost OpenSSH cleans the remote tree after its local transport dies", {
  skip: process.platform === "win32" ? "requires a POSIX localhost SSH server" : false,
  timeout: 30_000,
}, async (t) => {
  const probe = spawnChild(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=2", "-T", "localhost", "true"],
    { stdio: "ignore" },
  );
  const probeCode = await new Promise<number | null>((resolve) => {
    probe.once("error", () => resolve(null));
    probe.once("exit", resolve);
  });
  if (probeCode !== 0) {
    t.skip("localhost OpenSSH key authentication is unavailable");
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-transport-exit-"));
  const pidFile = join(directory, "remote.pid");
  const token = Buffer.from(`${process.pid}-${Date.now()}-transport`).toString("hex");
  const adapter = new UnixBashAdapter(new FakeSshClient({ target: "localhost" }));
  const launch = createSshBackgroundShellResolver({
    ssh: { target: "localhost", batchMode: true, connectTimeoutSeconds: 3 },
    adapter,
    workspace: {
      platform: "unix",
      shell: "bash",
      home: process.env.HOME ?? "/tmp",
      cwd: directory,
    },
    localCwd: process.cwd(),
    createControlToken: () => token,
  })(`printf '%s' $$ > ${shellQuote(pidFile)}; while :; do sleep 1; done`, false, {
    cwd: directory,
    projectTrusted: true,
  });
  const child = spawnChild(launch.file, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  let remotePid = 0;
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    remotePid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(remotePid > 0);
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const disposition = await launch.control?.onTransportExit?.({
      exitCode: null,
      signal: "SIGKILL",
    });
    assert.deepEqual(disposition, {
      state: "stopped",
      signal: "SSH transport exit",
    });
    let alive = true;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        process.kill(remotePid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(alive, false, "transport recovery must not leave a remote orphan");
  } finally {
    if (remotePid > 0) {
      try {
        process.kill(remotePid, "SIGKILL");
      } catch {}
    }
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    await launch.control?.dispose?.();
    rmSync(join(process.env.TMPDIR || "/tmp", `pi-ssh-bg-${token}`), {
      recursive: true,
      force: true,
    });
    rmSync(directory, { recursive: true, force: true });
  }
});

function decodePowerShellInvocation(command: string): string {
  const encoded = command.trim().split(/\s+/).at(-1) ?? "";
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  const compressed = /\$data = \[Convert\]::FromBase64String\('([^']+)'\)/.exec(script)?.[1];
  return compressed
    ? gunzipSync(Buffer.from(compressed, "base64")).toString("utf8")
    : script;
}

function createHangingWindowsExecutor() {
  const calls: Array<{ command: string; options: SshRunOptions }> = [];
  const run = (command: string, options: SshRunOptions = {}): Promise<SshRunResult> => {
    calls.push({ command, options });
    if (calls.length > 1) {
      return Promise.resolve({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      });
    }
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error("aborted"));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  return {
    calls,
    executor: {
      run,
      async runChecked(command: string, options?: SshRunOptions): Promise<SshRunResult> {
        const result = await run(command, options);
        if (result.exitCode !== 0) throw new Error(`exit:${result.exitCode}`);
        return result;
      },
    },
  };
}

test("Windows runShell aborts the recorded remote process tree on Esc", async () => {
  const { calls, executor } = createHangingWindowsExecutor();
  const adapter = new WindowsPowerShellAdapter(executor, "powershell", "win32");
  const controller = new AbortController();
  const running = adapter.runShell(
    "Start-Process ssh.exe -ArgumentList 'winbox', 'exit' -Wait",
    "C:\\Remote\\Project",
    { signal: controller.signal },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(running, /aborted/);
  assert.equal(calls.length, 2);
  const primary = decodePowerShellInvocation(calls[0].command);
  const cleanup = decodePowerShellInvocation(calls[1].command);
  assert.match(primary, /rootStartedAt/);
  assert.match(cleanup, /taskkill\.exe \/PID \$rootProcessId \/T \/F/);
  const primaryToken = /pi-ssh-bg-[a-f0-9]+/.exec(primary)?.[0];
  assert.ok(primaryToken);
  assert.equal(cleanup.includes(primaryToken), true);
  assert.equal(calls[1].options.signal, undefined);
});

test("Windows runShell timeout aborts the recorded remote process tree", async () => {
  const { calls, executor } = createHangingWindowsExecutor();
  const adapter = new WindowsPowerShellAdapter(executor, "powershell", "win32");

  await assert.rejects(
    adapter.runShell("Start-Sleep -Seconds 30", "C:\\Remote\\Project", {
      timeoutSeconds: 0.01,
    }),
    /timeout:0\.01/,
  );
  assert.equal(calls.length, 2);
  assert.match(
    decodePowerShellInvocation(calls[1].command),
    /taskkill\.exe \/PID \$rootProcessId \/T \/F/,
  );
});

class FakeWindowsSshClient implements SshRemoteClient {
  readonly calls: RecordedRun[] = [];
  disposed = false;
  remoteFileExists = false;
  /** Commands reported by the PowerShell Get-Command probe. */
  availablePowerShellCommands = new Set<string>();
  /** Windows OpenSSH may use 255 when its remote launcher cannot find sh. */
  posixProbeExitCode = 1;
  posixProbeStderr = Buffer.alloc(0);

  constructor(readonly options: Readonly<SshClientOptions> = { target: "winbox" }) {}

  async run(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    this.calls.push({ command, options, checked: false });
    if (command.startsWith("command -v bash")) {
      return { stdout: Buffer.alloc(0), stderr: Buffer.from("bash missing"), exitCode: 127 };
    }
    if (command.includes("getent passwd") || /sh -c 'command -v [a-z0-9_.-]+ /.test(command)) {
      // A Windows host without sh cannot run POSIX probes. Depending on the
      // OpenSSH/default-shell combination this is either 1 or 255.
      return {
        stdout: Buffer.alloc(0),
        stderr: this.posixProbeStderr,
        exitCode: this.posixProbeExitCode,
      };
    }
    const psProbe = /powershell -NoProfile -NonInteractive -Command "if \(Get-Command '([a-z0-9_.-]+)'/.exec(command);
    if (psProbe) {
      return {
        stdout: Buffer.from(this.availablePowerShellCommands.has(psProbe[1]) ? "ok" : ""),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
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
    if (script.includes("PI_SSH_REMOTE_LS")) {
      return {
        stdout: Buffer.from(`D\t${Buffer.from("src").toString("base64")}\r\nF\t${Buffer.from("README.md").toString("base64")}\r\n`),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    }
    if (script.includes("PI_SSH_REMOTE_FIND")) {
      return {
        stdout: Buffer.from(`F\t${Buffer.from("src/main.ts").toString("base64")}\r\n`),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    }
    if (script.includes("PI_SSH_REMOTE_GREP")) {
      const relative = Buffer.from("src/main.ts").toString("base64");
      const text = Buffer.from("RemoteMatch()").toString("base64");
      const full = Buffer.from("C:\\Users\\Admin\\src\\main.ts").toString("base64");
      return {
        stdout: Buffer.from(`${relative}\t8\t${text}\t${full}\r\n`),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
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
  const windowsLogical = encodeWindowsToolPath(drivePath, "win32");
  assert.match(windowsLogical, /^C:\\__pi_ssh_remote_windows__\\drive\\/);
  assert.equal(decodeWindowsToolPath(windowsLogical), drivePath);
  assert.equal(
    resolveWindowsRemotePath("~\\project\\src", "C:\\Users\\Admin", "D:\\work"),
    "C:\\Users\\Admin\\project\\src",
  );
  assert.throws(
    () => resolveWindowsRemotePath("C:relative", "C:\\Users\\Admin", "C:\\work"),
    /Drive-relative/,
  );
});

test("Pi file tools resolve remote logical paths on native Windows", {
  skip: process.platform !== "win32" ? "requires Windows path semantics" : false,
}, async () => {
  const harness = createExtensionHarness({ cwd: process.cwd() });

  const unixClient = new FakeSshClient({ target: "devbox" });
  const unixAdapter = new UnixBashAdapter(unixClient, "win32");
  const unixWorkspace: RemoteWorkspace = {
    platform: "unix",
    shell: "bash",
    home: "/home/deploy",
    cwd: "/srv/project",
  };
  const unixRoot = unixAdapter.toToolPath(unixWorkspace.cwd, unixWorkspace);
  const unixPath = unixAdapter.toToolPath("notes.txt", unixWorkspace);
  const readResult = await createReadToolDefinition(unixRoot, {
    operations: createRemoteReadOperations(unixAdapter),
  }).execute(
    "read-native-windows",
    { path: unixPath },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(readResult.content[0].text, "remote contents\n");

  const windowsClient = new FakeWindowsSshClient();
  const windowsAdapter = new WindowsPowerShellAdapter(
    windowsClient,
    "pwsh",
    "win32",
  );
  const windowsWorkspace: RemoteWorkspace = {
    platform: "windows",
    shell: "pwsh",
    home: "C:\\Users\\Admin",
    cwd: "C:\\Users\\Admin\\project",
  };
  const windowsRoot = windowsAdapter.toToolPath(
    windowsWorkspace.cwd,
    windowsWorkspace,
  );
  const windowsPath = windowsAdapter.toToolPath("notes.txt", windowsWorkspace);
  const writeResult = await createWriteToolDefinition(windowsRoot, {
    operations: createRemoteWriteOperations(windowsAdapter),
  }).execute(
    "write-native-windows",
    { path: windowsPath, content: "windows value" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.match(writeResult.content[0].text, /Successfully wrote 13 bytes/);
});

test("PowerShell scripts use EncodedCommand and keep user commands out of SSH arguments", () => {
  assert.equal(Buffer.from(encodePowerShell("Write-Output ok"), "base64").toString("utf16le"), "Write-Output ok");
  const invocation = buildPowerShellInvocation("pwsh", "Write-Output ok");
  assert.match(invocation, /^pwsh\.exe .* -EncodedCommand /);
  assert.match(decodePowerShellInvocation(invocation), /Write-Output ok/);
  const longScript = `Write-Output ok\n${"# repeated control script\n".repeat(1_000)}`;
  const compressedInvocation = buildPowerShellInvocation("pwsh", longScript);
  assert.ok(compressedInvocation.length < 8_000);
  assert.equal(decodePowerShellInvocation(compressedInvocation), longScript);

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

test("auto mode reuses the remote login shell (zsh)", async () => {
  const zshClient = new FakeSshClient({ target: "devbox" });
  zshClient.userShell = "zsh";
  const zshSelection = await selectRemoteAdapter(zshClient, { preference: "auto" });
  assert.equal(zshSelection.adapter.shell, "zsh");
  assert.equal(zshSelection.workspace.shell, "zsh");
  assert.equal(zshSelection.warnings?.length ?? 0, 0);
  assert.match(
    zshSelection.adapter.buildShellCommand("echo $0", "/srv/project"),
    /exec zsh -lc/,
  );

  // Unknown login shells keep the deterministic Bash-first order.
  const plainClient = new FakeSshClient({ target: "devbox" });
  const selected = await selectRemoteAdapter(plainClient, { preference: "auto" });
  assert.equal(selected.adapter.shell, "bash");
});

test("selectRemoteAdapter aggregates only genuine shell incompatibilities", async () => {
  const client = new FakeSshClient({ target: "devbox" });
  client.inspectShells.clear();

  await assert.rejects(
    selectRemoteAdapter(client, { preference: "auto" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^Could not find a supported remote shell\./);
      assert.match(error.message, /Unix Bash, Zsh, or POSIX sh/);
      assert.match(error.message, /Probe results:/);
      assert.doesNotMatch(error.message, /SSH connection (?:failed|timed out)/);
      assert.ok(error.message.length <= 1_100, "shell diagnostics should stay bounded");
      return true;
    },
  );
});

test("auto mode falls back to the sh symlink target when getent is missing", async () => {
  // No getent (Alpine/busybox): the probe uses readlink -f /bin/sh instead.
  const busyboxLike = new FakeSshClient({ target: "devbox" });
  busyboxLike.getentUnavailable = true;
  const selected = await selectRemoteAdapter(busyboxLike, { preference: "auto" });
  assert.equal(selected.adapter.shell, "bash");

  // sh points at zsh: the fallback still detects a Zsh login shell.
  const shToZsh = new FakeSshClient({ target: "devbox" });
  shToZsh.getentUnavailable = true;
  shToZsh.shTarget = "zsh";
  const zshFallback = await selectRemoteAdapter(shToZsh, { preference: "auto" });
  assert.equal(zshFallback.adapter.shell, "zsh");
  assert.equal(zshFallback.warnings?.length ?? 0, 0);
});

test("auto mode falls back to sh on ash-only hosts (OpenWrt)", async () => {
  // No bash or zsh anywhere: the deterministic order tries bash, fails,
  // and lands on the POSIX control shell sh.
  const openWrt = new FakeSshClient({ target: "router" });
  openWrt.userShell = "ash";
  openWrt.inspectShells = new Set(["sh"]);
  const selected = await selectRemoteAdapter(openWrt, { preference: "auto" });
  assert.equal(selected.adapter.shell, "sh");
  assert.equal(selected.workspace.shell, "sh");
  assert.match(selected.adapter.buildShellCommand("echo $0", "/etc"), /exec sh -lc/);
  assert.equal(selected.warnings?.length ?? 0, 0);

  // Control scripts run through sh on every Unix host, even when the user
  // shell is bash.
  const withBash = new FakeSshClient({ target: "devbox" });
  const bashSelection = await selectRemoteAdapter(withBash, { preference: "auto" });
  assert.equal(bashSelection.adapter.shell, "bash");
  // Windows adapters require the encoded logical tool path, so route the
  // directory through toToolPath like the extension's tools do.
  const bashAdapter = bashSelection.adapter as UnixBashAdapter;
  const control = await bashAdapter.listDirectory(
    bashAdapter.toToolPath("/srv/project", bashSelection.workspace),
  );
  assert.equal(control.length, 2);
  assert.ok(withBash.calls.some((call) => call.command.includes("exec sh -lc")));
});

test("explicit --ssh-shell probes existence and falls back to sh", async () => {
  // zsh installed: used directly.
  const zshClient = new FakeSshClient({ target: "devbox" });
  zshClient.availableCommands.add("zsh");
  const zshSelection = await selectRemoteAdapter(zshClient, { preference: "zsh" });
  assert.equal(zshSelection.adapter.shell, "zsh");

  // zsh missing: warning plus sh fallback keeps the session usable.
  const missing = new FakeSshClient({ target: "devbox" });
  const fallback = await selectRemoteAdapter(missing, { preference: "zsh" });
  assert.equal(fallback.adapter.shell, "sh");
  assert.ok(
    (fallback.warnings ?? []).some((warning) => /does not provide zsh/.test(warning)),
  );

  // Windows PowerShell: pwsh missing falls back to powershell with a warning.
  const windows = new FakeWindowsSshClient({ target: "winbox" });
  const pwshFallback = await selectRemoteAdapter(windows, { preference: "pwsh" });
  assert.equal(pwshFallback.adapter.shell, "powershell");
  assert.ok(
    (pwshFallback.warnings ?? []).some((warning) => /falling back to powershell/.test(warning)),
  );

  // Windows without sh: the POSIX probe cannot run and the PowerShell probe
  // answers; the preference stays in charge and inspectWorkspace validates it.
  const noSh = new FakeWindowsSshClient({ target: "winbox" });
  noSh.availablePowerShellCommands.add("pwsh");
  const noShSelection = await selectRemoteAdapter(noSh, { preference: "pwsh" });
  assert.equal(noShSelection.adapter.shell, "pwsh");
  assert.equal(noShSelection.warnings?.length ?? 0, 0);

  // Windows without sh and without the command: PowerShell probe says no,
  // the fallback fires with a warning.
  const noShMissing = new FakeWindowsSshClient({ target: "winbox" });
  const missingSelection = await selectRemoteAdapter(noShMissing, { preference: "pwsh" });
  assert.equal(missingSelection.adapter.shell, "powershell");
  assert.ok(
    (missingSelection.warnings ?? []).some((warning) => /falling back to powershell/.test(warning)),
  );
});

test("Windows shell discovery tolerates an unclassified exit 255 when sh is unavailable", async () => {
  const automatic = new FakeWindowsSshClient();
  automatic.posixProbeExitCode = 255;
  automatic.posixProbeStderr = Buffer.from("The system cannot find the path specified.");
  const automaticSelection = await selectRemoteAdapter(automatic, { preference: "auto" });
  assert.equal(automaticSelection.adapter.shell, "pwsh");
  assert.equal(automaticSelection.workspace.platform, "windows");

  const explicit = new FakeWindowsSshClient();
  explicit.posixProbeExitCode = 255;
  explicit.posixProbeStderr = Buffer.from("The system cannot find the path specified.");
  explicit.availablePowerShellCommands.add("pwsh");
  const explicitSelection = await selectRemoteAdapter(explicit, { preference: "pwsh" });
  assert.equal(explicitSelection.adapter.shell, "pwsh");
  assert.equal(explicitSelection.warnings?.length ?? 0, 0);
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
  assert.equal(
    adapter.mapCwd(
      "C:\\local\\project\\src",
      "C:\\local\\project",
      workspace,
    ),
    "C:\\Users\\Admin\\project\\src",
  );
  assert.equal(
    adapter.mapCwd("D:\\remote", "C:\\local\\project", workspace),
    "D:\\remote",
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
  assert.match(
    decodePowerShellInvocation(pipeLaunch.args.at(-1) ?? ""),
    /\$controlDirectory.*\$statePath/s,
  );
  assert.equal(typeof pipeLaunch.control.sendSignal, "function");
  const windowsSignal = decodePowerShellInvocation(
    buildWindowsBackgroundSignalCommand(
      "0123456789abcdef0123456789abcdef",
      "SIGTERM",
      "pwsh",
    ),
  );
  assert.match(windowsSignal, /taskkill\.exe \/PID \$rootProcessId \/T \/F/);
  const windowsProbe = decodePowerShellInvocation(
    buildWindowsBackgroundProbeCommand(
      "0123456789abcdef0123456789abcdef",
      "pwsh",
    ),
  );
  assert.match(windowsProbe, /Get-Process -Id \$rootProcessId/);
  assert.match(windowsProbe, /WriteLine\('PI_SSH_BG_STATUS=running'\)/);
  const unixProbe = buildUnixBackgroundProbeCommand(
    "0123456789abcdef0123456789abcdef",
  );
  assert.match(unixProbe, /PI_SSH_BG_STATUS=running/);
  assert.throws(
    () => buildWindowsBackgroundSignalCommand(
      "0123456789abcdef0123456789abcdef",
      "SIGUSR1",
      "pwsh",
    ),
    /cannot be delivered to a Windows SSH process tree/,
  );

  const path = adapter.toToolPath("notes.txt", workspace);
  assert.equal(adapter.fromToolPath(path), "C:\\Users\\Admin\\project\\notes.txt");
  assert.equal((await adapter.readFile(path)).toString("utf8"), "windows contents\r\n");
  assert.equal(await adapter.fileExists(path), false);
  await adapter.writeFile(path, "secret file content");
  const writeCall = client.calls.at(-1);
  assert.equal(writeCall?.options?.input, "secret file content");
  assert.doesNotMatch(writeCall?.command ?? "", /secret file content/);
});

test("Windows background control terminates the real local PowerShell process tree", {
  skip: process.platform !== "win32" ? "requires Windows taskkill semantics" : false,
  timeout: 30_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-windows-bg-"));
  const pidFile = join(directory, "child.pid");
  const token = Buffer.from(`${process.pid}-${Date.now()}-windows-tree`).toString("hex");
  const quotePowerShell = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const command = [
    "$child = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoLogo -NoProfile -Command \"Start-Sleep -Seconds 120\"' -PassThru",
    `[IO.File]::WriteAllText(${quotePowerShell(pidFile)}, [string]$child.Id)`,
    "while ($true) { Start-Sleep -Milliseconds 200 }",
  ].join("\n");
  const launchCommand = buildWindowsBackgroundShellCommand(
    command,
    directory,
    "powershell",
    token,
    false,
  );
  const [launchFile, ...launchArgs] = launchCommand.split(" ");
  const task = spawnChild(launchFile, launchArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const launchOutput: Buffer[] = [];
  task.stdout?.on("data", (chunk: Buffer | string) => {
    launchOutput.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  task.stderr?.on("data", (chunk: Buffer | string) => {
    launchOutput.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  let taskExitCode: number | null | undefined;
  let taskError: Error | undefined;
  const taskExit = new Promise<void>((resolve) => {
    task.once("error", (error) => {
      taskError = error;
      resolve();
    });
    task.once("exit", (code) => {
      taskExitCode = code;
      resolve();
    });
  });
  let childPid = 0;
  try {
    const deadline = Date.now() + 20_000;
    while (
      !existsSync(pidFile)
      && taskExitCode === undefined
      && taskError === undefined
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!existsSync(pidFile)) {
      const output = Buffer.concat(launchOutput).toString("utf8").replace(/\s+/g, " ").trim();
      assert.fail(
        `PowerShell launcher did not publish its child PID (exit=${taskExitCode ?? "running"}`
          + `${taskError ? `, error=${taskError.message}` : ""}`
          + `${output ? `, output=${output.slice(0, 1_000)}` : ""})`,
      );
    }
    childPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(childPid > 0, "PowerShell child PID should be published");

    const controlCommand = buildWindowsBackgroundSignalCommand(
      token,
      "SIGTERM",
      "powershell",
    );
    const [controlFile, ...controlArgs] = controlCommand.split(" ");
    const control = spawnChild(controlFile, controlArgs, {
      stdio: "ignore",
      windowsHide: true,
    });
    const controlCode = await new Promise<number | null>((resolve, reject) => {
      control.once("error", reject);
      control.once("exit", resolve);
    });
    assert.equal(controlCode, 0);
    await taskExit;

    let childAlive = true;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        process.kill(childPid, 0);
      } catch {
        childAlive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(childAlive, false, "taskkill /T /F must remove descendants");
  } finally {
    if (childPid > 0) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    try {
      task.kill("SIGKILL");
    } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

interface HarnessOptions {
  flag?: string;
  configFlag?: string;
  transportFlag?: string;
  branch?: unknown[];
  sessionName?: string;
  cwd?: string;
  activeTools?: string[];
  skillPaths?: string[];
  backgroundProtocolVersion?: number | null;
  input?: (
    title: string,
    placeholder?: string,
    options?: { timeout?: number; signal?: AbortSignal },
  ) => Promise<string | undefined>;
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
  const inputCalls: Array<{
    title: string;
    placeholder?: string;
    options?: { timeout?: number; signal?: AbortSignal };
  }> = [];
  const statuses = new Map<string, unknown>();
  const themeCalls: Array<{ color: string; text: string }> = [];
  let shutdowns = 0;
  let idleWaits = 0;
  let sessionName: string | undefined = options.sessionName;
  let activeTools = [...(options.activeTools ?? ["read", "bash", "edit", "write"])];
  if (options.flag) flags.set("ssh", options.flag);
  if (options.configFlag) flags.set("ssh-config", options.configFlag);
  if (options.transportFlag) flags.set("ssh-transport", options.transportFlag);

  const pi = {
    registerFlag: (name: string, definition: { default?: unknown }) => {
      if (!flags.has(name) && definition.default !== undefined) flags.set(name, definition.default);
    },
    getFlag: (name: string) => flags.get(name),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getCommands: () => (options.skillPaths ?? []).map((path, index) => ({
      name: `skill:test-${index}`,
      description: "Test skill",
      source: "skill",
      sourceInfo: {
        path,
        source: "local",
        scope: "user",
        origin: "top-level",
        baseDir: join(path, ".."),
      },
    })),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
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
        if (
          name === "bg:register"
          && typeof (payload as { onRegistered?: unknown })?.onRegistered === "function"
        ) {
          if (options.backgroundProtocolVersion !== null) {
            (payload as {
              onRegistered: (capabilities: {
                protocolVersion: number;
                providers: boolean;
                taskControl: boolean;
              }) => void;
            }).onRegistered({
              protocolVersion: options.backgroundProtocolVersion ?? 2,
              providers: true,
              taskControl: (options.backgroundProtocolVersion ?? 2) >= 2,
            });
          }
        }
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
    shutdown: () => {
      shutdowns++;
    },
    waitForIdle: async () => {
      idleWaits++;
    },
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
      input: async (
        title: string,
        placeholder?: string,
        inputOptions?: { timeout?: number; signal?: AbortSignal },
      ) => {
        inputCalls.push({ title, placeholder, options: inputOptions });
        return options.input?.(title, placeholder, inputOptions);
      },
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
    inputCalls,
    statuses,
    themeCalls,
    emit,
    getSessionName: () => sessionName,
    getActiveTools: () => [...activeTools],
    getShutdowns: () => shutdowns,
    getIdleWaits: () => idleWaits,
    setBranch: (branch: unknown[]) => {
      entries.splice(0, entries.length, ...branch);
    },
  };
}

function sessionEntry(state: unknown) {
  return { type: "custom", customType: SSH_SESSION_STATE_TYPE, data: state };
}

function localSessionEntry() {
  return {
    type: "custom",
    customType: SSH_LOCAL_SESSION_STATE_TYPE,
    data: SSH_LOCAL_SESSION_STATE,
  };
}

test("SSH commands stay available while local sessions keep AI controls disabled", async () => {
  const harness = createExtensionHarness();
  createSshRemoteExtension({ platform: "linux" })(harness.pi);

  assert.deepEqual(harness.getActiveTools(), ["read", "bash", "edit", "write"]);
  assert.equal(harness.tools.has("grep"), false);
  assert.equal(harness.tools.has("find"), false);
  assert.equal(harness.tools.has("ls"), false);
  for (const name of [
    "ssh-connect",
    "ssh-exit",
    "ssh-cd",
    "ssh-status",
    "ssh-reconnect",
    "ssh-forget-password",
  ]) {
    assert.equal(harness.commands.has(name), true, `${name} should be registered`);
  }
  await harness.emit("session_start", { reason: "startup" });
  assert.deepEqual(harness.getActiveTools(), ["read", "bash", "edit", "write"]);
  for (const name of ["ssh_connect", "ssh_exit", "ssh_cd", "ssh_status"]) {
    assert.equal(harness.tools.has(name), false);
  }
  await harness.commands.get("ssh-status").handler("", harness.ctx);
  assert.match(harness.notifications.at(-1)?.message ?? "", /Workspace: local/);
});

test("ssh-forget-password scopes deletion to this session unless all is requested", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-forget-command-test-"));
  const secretsPath = join(directory, "secrets.json");
  const currentEndpoint = {
    hostLabel: "deploy@devbox:22",
    username: "deploy",
    host: "devbox",
    port: 22,
  };
  const initialSecrets = {
    [currentEndpoint.hostLabel]: "current-pw",
    "admin@other-host:22": "other-pw",
  };
  writeFileSync(secretsPath, `${JSON.stringify(initialSecrets)}\n`);

  try {
    const harness = createExtensionHarness({ flag: "deploy@devbox" });
    createSshRemoteExtension({
      platform: "linux",
      secretsPath,
      createTransportClient: (options, factoryOptions) => {
        factoryOptions.passwordProvider?.cached(currentEndpoint);
        return new FakeSshClient(options);
      },
    })(harness.pi);
    assert.equal(harness.commands.has("ssh-forget-password"), true);
    assert.equal(harness.commands.has("ssh-forget-passwords"), false);
    await harness.emit("session_start", { reason: "startup" });

    await harness.commands.get("ssh-forget-password").handler(
      "unexpected",
      harness.ctx,
    );
    assert.deepEqual(JSON.parse(readFileSync(secretsPath, "utf8")), initialSecrets);
    assert.match(
      harness.notifications.at(-1)?.message ?? "",
      /Usage: \/ssh-forget-password \[all\]/,
    );

    await harness.commands.get("ssh-forget-password").handler("", harness.ctx);
    assert.deepEqual(JSON.parse(readFileSync(secretsPath, "utf8")), {
      "admin@other-host:22": "other-pw",
    });
    assert.match(
      harness.notifications.at(-1)?.message ?? "",
      /Forgot 1 cached SSH password used by this session/,
    );

    await harness.commands.get("ssh-forget-password").handler("all", harness.ctx);
    assert.deepEqual(JSON.parse(readFileSync(secretsPath, "utf8")), {});
    assert.match(
      harness.notifications.at(-1)?.message ?? "",
      /Forgot 1 cached SSH password across all sessions/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid SSH transport flags fail closed before creating a client", async () => {
  let clients = 0;
  const harness = createExtensionHarness({
    flag: "devbox",
    transportFlag: "invalid",
  });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      clients++;
      return new FakeSshClient(options);
    },
  })(harness.pi);

  await harness.emit("session_start", { reason: "startup" });
  assert.equal(clients, 0);
  assert.match(
    harness.notifications.at(-1)?.message ?? "",
    /--ssh-transport must be one of: auto, openssh, ssh2/,
  );
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
  assert.match(harness.notifications.at(-1)?.message ?? "", /target: devbox/);

  await harness.commands.get("ssh-reconnect").handler("", harness.ctx);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].disposed, true);
  assert.equal(clients[1].options.target, "devbox");
});

test("local sessions can connect and explicitly exit without resuming the old SSH target", async () => {
  const clients: FakeSshClient[] = [];
  const harness = createExtensionHarness();
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeSshClient(options);
      clients.push(client);
      return client;
    },
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });

  await harness.commands.get("ssh-connect").handler(
    "devbox:/srv/project",
    harness.ctx,
  );
  assert.equal(harness.getIdleWaits(), 1);
  assert.equal(clients.length, 1);
  assert.equal(findSshSessionState(harness.entries)?.target, "devbox");
  assert.equal(harness.statuses.get("ssh-remote"), "SSH: Connected");

  await harness.commands.get("ssh-exit").handler("", harness.ctx);
  assert.equal(harness.getIdleWaits(), 2);
  assert.equal(clients[0].disposed, true);
  assert.deepEqual(clients[0].disposeOptions, [{
    preserveBackgroundSessions: true,
  }]);
  assert.equal(harness.statuses.has("ssh-remote"), false);
  assert.equal(findSshSessionState(harness.entries), undefined);
  assert.equal(findSshEnvironmentState(harness.entries)?.mode, "local");
  assert.equal(await harness.emit("user_bash", {
    command: "pwd",
    cwd: "/local/project",
    excludeFromContext: false,
  }), undefined);

  const resumedClients: FakeSshClient[] = [];
  const resumed = createExtensionHarness({ branch: [...harness.entries] });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeSshClient(options);
      resumedClients.push(client);
      return client;
    },
  })(resumed.pi);
  await resumed.emit("session_start", { reason: "resume" });
  assert.equal(resumedClients.length, 0);
  assert.equal(resumed.statuses.has("ssh-remote"), false);
});

test("session tree navigation restores the branch-specific local or SSH environment", async () => {
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
  const remoteBranch = [...harness.entries];

  harness.setBranch([localSessionEntry()]);
  await harness.emit("session_tree", { newLeafId: "local", oldLeafId: "remote" });
  assert.equal(clients[0].disposed, true);
  assert.equal(harness.statuses.has("ssh-remote"), false);

  harness.setBranch(remoteBranch);
  await harness.emit("session_tree", { newLeafId: "remote", oldLeafId: "local" });
  assert.equal(clients.length, 2);
  assert.equal(harness.statuses.get("ssh-remote"), "SSH: Connected");
  assert.equal(findSshSessionState(harness.entries)?.remoteCwd, "/srv/project");
});

test("failed session-tree host switches fail closed instead of restoring the old branch host", async () => {
  const clients: FakeSshClient[] = [];
  const harness = createExtensionHarness({ flag: "host-a:/srv/a" });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeSshClient(options);
      clients.push(client);
      return client;
    },
    selectRemote: async (client, options) => {
      if (client.options.target === "host-b") {
        throw new Error("host-b is offline");
      }
      return {
        adapter: new UnixBashAdapter(client, "linux", "bash"),
        workspace: {
          platform: "unix",
          shell: "bash",
          home: "/home/deploy",
          cwd: options.requestedCwd ?? "/srv/a",
        },
      };
    },
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });

  harness.setBranch([sessionEntry({
    version: 2,
    target: "host-b",
    remotePlatform: "unix",
    remoteShell: "bash",
    remoteCwd: "/srv/b",
    remoteHome: "/home/deploy",
    requestedCwd: "/srv/b",
  })]);
  await harness.emit("session_tree", {
    newLeafId: "host-b-branch",
    oldLeafId: "host-a-branch",
  });

  assert.equal(clients.length, 2);
  assert.equal(clients[0].disposed, true, "the old branch connection must be closed");
  assert.equal(clients[1].disposed, true, "the failed candidate must be closed");
  assert.equal(harness.statuses.get("ssh-remote"), "SSH: Disconnected");
  await assert.rejects(
    () => harness.tools.get("bash").execute(
      "bash-after-tree-switch-failure",
      { command: "pwd" },
      undefined,
      undefined,
      harness.ctx,
    ),
    /SSH remote is unavailable: host-b is offline/,
  );
});

test("AI control setting exposes sequential SSH environment tools without built-in permission prompts", async () => {
  assert.equal(AI_SSH_PASSWORD_PROMPT_TIMEOUT_MS, 60_000);
  const clients: FakeSshClient[] = [];
  const harness = createExtensionHarness();
  createSshRemoteExtension({
    platform: "linux",
    loadConfig: () => ({
      ...DEFAULT_SSH_REMOTE_CONFIG,
      aiControlTools: true,
    }),
    saveConfig: () => {},
    createClient: (options) => {
      const client = new FakeSshClient(options);
      clients.push(client);
      return client;
    },
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });

  for (const name of ["ssh_connect", "ssh_exit", "ssh_cd", "ssh_status"]) {
    assert.equal(harness.tools.has(name), true);
    assert.ok(harness.getActiveTools().includes(name));
  }
  assert.equal(
    harness.tools.has("read"),
    true,
    "state-aware workspace wrappers must exist before ssh_connect can share a tool batch",
  );
  assert.equal(harness.tools.get("ssh_connect").executionMode, "sequential");
  assert.equal(harness.tools.get("ssh_exit").executionMode, "sequential");
  assert.equal(harness.tools.get("ssh_cd").executionMode, "sequential");
  assert.ok(harness.tools.get("ssh_connect").promptGuidelines.some(
    (guideline: string) =>
      /tell the user.*password.*within 60 seconds/i.test(guideline),
  ));
  assert.ok(harness.tools.get("ssh_connect").promptGuidelines.some(
    (guideline: string) =>
      /switch directly.*do not call ssh_exit before switching/i.test(guideline),
  ));
  assert.ok(harness.tools.get("ssh_connect").promptGuidelines.some(
    (guideline: string) =>
      /returns to local automatically.*previous SSH workspace remains active.*Do not call ssh_exit/is.test(guideline),
  ));
  assert.ok(harness.tools.get("ssh_connect").promptGuidelines.some(
    (guideline: string) =>
      /AI password auth is disabled.*fails immediately.*key-based login/i.test(guideline),
  ));

  const renderTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const renderComponent = (component: { render(width: number): string[] }): string =>
    component.render(200).map((line) => line.trimEnd()).join("\n");
  const renderToolCall = (name: string, args: Record<string, unknown>): string => {
    const component = harness.tools.get(name).renderCall(
      args,
      renderTheme,
      {
        lastComponent: undefined,
        argsComplete: true,
        executionStarted: false,
        isPartial: false,
      },
    );
    return renderComponent(component);
  };
  assert.equal(
    renderToolCall("ssh_connect", { target: "devbox:/srv/project" }),
    "ssh_connect devbox:/srv/project",
  );
  assert.equal(
    renderToolCall("ssh_cd", { path: "../service api" }),
    'ssh_cd "../service api"',
  );
  assert.equal(renderToolCall("ssh_cd", { path: "/tmp" }), "ssh_cd /tmp");
  assert.equal(renderToolCall("ssh_exit", {}), "ssh_exit");
  assert.equal(renderToolCall("ssh_status", {}), "ssh_status");

  const partialConnectCall = harness.tools.get("ssh_connect").renderCall(
    { target: "dev" },
    renderTheme,
    {
      lastComponent: undefined,
      argsComplete: false,
      executionStarted: false,
      isPartial: true,
    },
  );
  assert.equal(
    renderComponent(partialConnectCall),
    "ssh_connect dev …",
  );
  const completedConnectCall = harness.tools.get("ssh_connect").renderCall(
    { target: "devbox:/srv/project" },
    renderTheme,
    {
      lastComponent: partialConnectCall,
      argsComplete: true,
      executionStarted: false,
      isPartial: false,
    },
  );
  assert.equal(completedConnectCall, partialConnectCall);
  assert.equal(
    renderComponent(completedConnectCall),
    "ssh_connect devbox:/srv/project",
  );

  const connected = await harness.tools.get("ssh_connect").execute(
    "ssh-connect-ai",
    { target: "devbox:/srv/project" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.match(connected.content[0].text, /SSH workspace active/);
  assert.equal(clients.length, 1);

  const status = await harness.tools.get("ssh_status").execute(
    "ssh-status-ai",
    {},
    undefined,
    undefined,
    harness.ctx,
  );
  assert.match(status.content[0].text, /Workspace: SSH/);
  assert.match(status.content[0].text, /target: devbox/);

  const exited = await harness.tools.get("ssh_exit").execute(
    "ssh-exit-ai",
    {},
    undefined,
    undefined,
    harness.ctx,
  );
  assert.match(exited.content[0].text, /Local workspace active/);
  assert.equal(findSshEnvironmentState(harness.entries)?.mode, "local");
  assert.ok(harness.events.some((event) =>
    event.name === "ssh-remote:environment"
      && event.payload.action === "connect"
      && event.payload.source === "tool"
      && event.payload.status === "succeeded"
  ));
});

test("ssh-connect switches active hosts directly and preserves the old host on failure", async () => {
  const clients: FakeSshClient[] = [];
  const harness = createExtensionHarness({ flag: "host-a:/srv/a" });
  createSshRemoteExtension({
    platform: "linux",
    loadConfig: () => ({
      ...DEFAULT_SSH_REMOTE_CONFIG,
      aiControlTools: true,
    }),
    createClient: (options) => {
      const client = new FakeSshClient(options);
      clients.push(client);
      return client;
    },
    selectRemote: async (client, options) => {
      if (client.options.target === "broken-host") {
        throw new Error("target rejected the connection");
      }
      const cwd = options.requestedCwd
        ?? (client.options.target === "host-a" ? "/srv/a" : "/srv/default");
      return {
        adapter: new UnixBashAdapter(client, "linux", "bash"),
        workspace: {
          platform: "unix",
          shell: "bash",
          home: "/home/deploy",
          cwd,
        },
      };
    },
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });
  assert.equal(findSshSessionState(harness.entries)?.target, "host-a");

  const aiSwitch = await harness.tools.get("ssh_connect").execute(
    "ssh-switch-host-b",
    { target: "host-b:/srv/b" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.match(aiSwitch.content[0].text, /host-b:\/srv\/b/);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].disposed, true);
  assert.deepEqual(clients[0].disposeOptions, [{
    preserveBackgroundSessions: true,
  }]);
  assert.equal(clients[1].disposed, false);
  assert.equal(findSshSessionState(harness.entries)?.target, "host-b");
  assert.equal(findSshSessionState(harness.entries)?.remoteCwd, "/srv/b");

  await harness.commands.get("ssh-connect").handler(
    "host-c:/srv/c",
    harness.ctx,
  );
  assert.equal(clients.length, 3);
  assert.equal(clients[1].disposed, true);
  assert.deepEqual(clients[1].disposeOptions, [{
    preserveBackgroundSessions: true,
  }]);
  assert.equal(clients[2].disposed, false);
  assert.equal(findSshSessionState(harness.entries)?.target, "host-c");
  assert.equal(findSshSessionState(harness.entries)?.remoteCwd, "/srv/c");

  const stateEntriesBeforeFailure = harness.entries.filter((entry: any) =>
    entry.customType === SSH_SESSION_STATE_TYPE
  ).length;
  await assert.rejects(
    () => harness.tools.get("ssh_connect").execute(
      "ssh-switch-broken",
      { target: "broken-host:/srv/broken" },
      undefined,
      undefined,
      harness.ctx,
    ),
    /switch to broken-host failed;.*host-c:\/srv\/c remains active: target rejected/is,
  );
  assert.equal(clients.length, 4);
  assert.equal(clients[2].disposed, false, "the previous connection must remain usable");
  assert.equal(clients[3].disposed, true, "the failed candidate must be disposed");
  assert.deepEqual(clients[3].disposeOptions, [undefined]);
  assert.equal(findSshSessionState(harness.entries)?.target, "host-c");
  assert.equal(findSshSessionState(harness.entries)?.remoteCwd, "/srv/c");
  assert.equal(harness.statuses.get("ssh-remote"), "SSH: Connected");
  assert.equal(
    harness.entries.filter((entry: any) =>
      entry.customType === SSH_SESSION_STATE_TYPE
    ).length,
    stateEntriesBeforeFailure,
  );
  assert.equal(
    harness.events.some((event) =>
      event.name === "ssh-remote:environment"
        && event.payload.action === "exit"
    ),
    false,
    "host switches must not require or emit an intermediate exit",
  );
  const status = await harness.tools.get("ssh_status").execute(
    "ssh-status-after-failed-switch",
    {},
    undefined,
    undefined,
    harness.ctx,
  );
  assert.match(status.content[0].text, /target: host-c/);
  assert.match(status.content[0].text, /cwd: \/srv\/c/);
});

test("AI password auth setting fails immediately while manual password prompts remain available", async () => {
  const providers = new Map<SshRemoteClient, SshPasswordProvider | undefined>();
  const updates: unknown[] = [];
  const endpoint = {
    hostLabel: "deploy@devbox:22",
    username: "deploy",
    host: "devbox",
    port: 22,
  };
  const harness = createExtensionHarness({
    input: async () => "manual-pw",
  });
  createSshRemoteExtension({
    platform: "linux",
    loadConfig: () => ({
      ...DEFAULT_SSH_REMOTE_CONFIG,
      persistPasswords: false,
      aiControlTools: true,
      aiPasswordAuth: false,
    }),
    createTransportClient: (options, factoryOptions) => {
      const client = new FakeSshClient(options);
      providers.set(client, factoryOptions.passwordProvider);
      return client;
    },
    selectRemote: async (client, options) => {
      const provider = providers.get(client);
      if (!provider) {
        throw new Error("Permission denied (publickey,password)");
      }
      assert.equal(
        await provider.retry(
          endpoint,
          new Error("Permission denied (publickey,password)"),
        ),
        "manual-pw",
      );
      return {
        adapter: new UnixBashAdapter(client, "linux", "bash"),
        workspace: {
          platform: "unix",
          shell: "bash",
          home: "/home/deploy",
          cwd: options.requestedCwd ?? "/srv/project",
        },
      };
    },
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });

  await assert.rejects(
    () => harness.tools.get("ssh_connect").execute(
      "ssh-connect-ai-password-disabled",
      { target: "deploy@devbox:/srv/project" },
      undefined,
      (update: unknown) => updates.push(update),
      harness.ctx,
    ),
    /password authentication is required.*AI password authentication is disabled.*key-based login \(recommended\).*AI password auth in \/99settings/is,
  );
  assert.equal(harness.inputCalls.length, 0);
  assert.equal(updates.length, 0);
  assert.equal(findSshEnvironmentState(harness.entries)?.mode, "local");
  assert.equal(harness.statuses.has("ssh-remote"), false);

  await harness.commands.get("ssh-connect").handler(
    "deploy@devbox:/srv/project",
    harness.ctx,
  );
  assert.equal(harness.inputCalls.length, 1);
  assert.equal(harness.inputCalls[0].options, undefined);
  assert.equal(harness.statuses.get("ssh-remote"), "SSH: Connected");
  assert.equal(findSshSessionState(harness.entries)?.target, "deploy@devbox");
});

test("AI ssh_connect times password input out and automatically restores local", async () => {
  const endpoint = {
    hostLabel: "deploy@password-host:22",
    username: "deploy",
    host: "password-host",
    port: 22,
  };
  let passwordProvider: SshPasswordProvider | undefined;
  const updates: any[] = [];
  const harness = createExtensionHarness({
    input: async (_title, _placeholder, options) =>
      new Promise<string | undefined>((resolve) => {
        if (options?.signal?.aborted) {
          resolve(undefined);
          return;
        }
        options?.signal?.addEventListener(
          "abort",
          () => resolve(undefined),
          { once: true },
        );
      }),
  });
  createSshRemoteExtension({
    platform: "linux",
    aiPasswordPromptTimeoutMs: 10,
    loadConfig: () => ({
      ...DEFAULT_SSH_REMOTE_CONFIG,
      persistPasswords: false,
      aiControlTools: true,
    }),
    createTransportClient: (options, factoryOptions) => {
      passwordProvider = factoryOptions.passwordProvider;
      return new FakeSshClient(options);
    },
    selectRemote: async () => {
      await passwordProvider!.retry(
        endpoint,
        new Error("Permission denied (publickey,password)"),
      );
      throw new Error("password prompt unexpectedly returned");
    },
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });

  await assert.rejects(
    () => harness.tools.get("ssh_connect").execute(
      "ssh-connect-password-timeout",
      { target: "deploy@password-host:/srv/project" },
      undefined,
      (update: unknown) => updates.push(update),
      harness.ctx,
    ),
    /automatically returned to its local workspace:.*timed out after 1 second/,
  );

  assert.equal(harness.inputCalls.length, 1);
  assert.equal(
    harness.inputCalls[0].title,
    "SSH password for deploy@password-host:22",
  );
  assert.equal(harness.inputCalls[0].placeholder, "Enter the SSH password");
  assert.equal(harness.inputCalls[0].options?.timeout, 10);
  assert.equal(harness.inputCalls[0].options?.signal?.aborted, true);
  assert.ok(updates.some((update) =>
    /requires user input.*within 1 second.*model cannot enter it/.test(
      update.content[0].text,
    )
  ));
  assert.equal(harness.statuses.has("ssh-remote"), false);
  assert.equal(findSshEnvironmentState(harness.entries)?.mode, "local");
  assert.ok(harness.events.some((event) =>
    event.name === "ssh-remote:environment"
      && event.payload.action === "connect"
      && event.payload.status === "failed"
  ));
  assert.ok(harness.events.some((event) =>
    event.name === "ssh-remote:environment"
      && event.payload.action === "exit"
      && event.payload.source === "tool"
      && event.payload.status === "succeeded"
  ));
  const status = await harness.tools.get("ssh_status").execute(
    "ssh-status-after-timeout",
    {},
    undefined,
    undefined,
    harness.ctx,
  );
  assert.match(status.content[0].text, /Workspace: local/i);
});

test("manual ssh-connect password prompts have no timeout and stay disconnected on failure", async () => {
  const endpoint = {
    hostLabel: "deploy@password-host:22",
    username: "deploy",
    host: "password-host",
    port: 22,
  };
  let passwordProvider: SshPasswordProvider | undefined;
  const harness = createExtensionHarness({
    input: async () => "typed-password",
  });
  createSshRemoteExtension({
    platform: "linux",
    loadConfig: () => ({
      ...DEFAULT_SSH_REMOTE_CONFIG,
      persistPasswords: false,
      aiControlTools: true,
    }),
    createTransportClient: (options, factoryOptions) => {
      passwordProvider = factoryOptions.passwordProvider;
      return new FakeSshClient(options);
    },
    selectRemote: async () => {
      assert.equal(
        await passwordProvider!.retry(
          endpoint,
          new Error("Permission denied (publickey,password)"),
        ),
        "typed-password",
      );
      throw new Error("remote workspace probe failed");
    },
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });

  await harness.commands.get("ssh-connect").handler(
    "deploy@password-host:/srv/project",
    harness.ctx,
  );

  assert.equal(harness.inputCalls.length, 1);
  assert.equal(harness.inputCalls[0].options, undefined);
  assert.equal(harness.statuses.get("ssh-remote"), "SSH: Disconnected");
  assert.notEqual(findSshEnvironmentState(harness.entries)?.mode, "local");
  assert.equal(
    harness.events.some((event) =>
      event.name === "ssh-remote:environment"
        && event.payload.action === "exit"
        && event.payload.source === "tool"
    ),
    false,
  );
});

test("ssh-cd updates the virtual remote cwd and persists it without reconnecting", async () => {
  const clients: FakeSshClient[] = [];
  const harness = createExtensionHarness({ flag: "devbox:/srv/project" });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeSshClient(options);
      clients.push(client);
      return client;
    },
    selectRemote: async (client) => {
      const adapter = new UnixBashAdapter(client, "linux", "bash");
      adapter.inspectWorkspace = async (requestedCwd) => ({
        platform: "unix",
        shell: "bash",
        home: "/home/deploy",
        cwd: requestedCwd ?? "/srv/project",
      });
      return {
        adapter,
        workspace: {
          platform: "unix",
          shell: "bash",
          home: "/home/deploy",
          cwd: "/srv/project",
        },
      };
    },
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });

  await harness.commands.get("ssh-cd").handler("src", harness.ctx);
  assert.equal(clients.length, 1, "changing cwd must reuse the SSH connection");
  assert.equal(findSshSessionState(harness.entries)?.remoteCwd, "/srv/project/src");
  assert.match(harness.getSessionName() ?? "", /devbox:\/srv\/project\/src/);

  await harness.tools.get("read").execute(
    "read-new-cwd",
    { path: "README.md" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.ok(clients[0].calls.some((call) =>
    call.command.includes("'/srv/project/src/README.md'")
  ));
  const backgroundResolver = harness.events.find((event) =>
    event.name === "bg:register"
  )?.payload.resolveShell;
  assert.equal(typeof backgroundResolver, "function");
  const backgroundLaunch = backgroundResolver("pwd", false, {
    cwd: "/local/project",
    projectTrusted: true,
  });
  assert.match(backgroundLaunch.args.at(-1) ?? "", /\/srv\/project\/src/);
  assert.equal(
    backgroundLaunch.taskEnvironment,
    "SSH devbox:/srv/project/src",
  );

  const context = await harness.emit("context", { messages: [] }) as {
    messages: Array<{ content: string }>;
  };
  assert.match(context.messages.at(-1)?.content ?? "", /devbox:\/srv\/project\/src/);
});

test("ssh-cd treats absolute paths as remote and preserves cwd on failure", async () => {
  const clients: FakeSshClient[] = [];
  const inspectedCwds: string[] = [];
  const harness = createExtensionHarness({
    flag: "devbox:/tmp",
    cwd: "/local/workspace",
  });
  createSshRemoteExtension({
    platform: "linux",
    loadConfig: () => ({
      ...DEFAULT_SSH_REMOTE_CONFIG,
      aiControlTools: true,
    }),
    createClient: (options) => {
      const client = new FakeSshClient(options);
      clients.push(client);
      return client;
    },
    selectRemote: async (client) => {
      const adapter = new UnixBashAdapter(client, "linux", "bash");
      adapter.inspectWorkspace = async (requestedCwd) => {
        const cwd = requestedCwd ?? "/tmp";
        inspectedCwds.push(cwd);
        if (cwd === "/does-not-exist") {
          throw new Error(`Remote directory does not exist: ${cwd}`);
        }
        return {
          platform: "unix",
          shell: "bash",
          home: "/home/deploy",
          cwd,
        };
      };
      return {
        adapter,
        workspace: {
          platform: "unix",
          shell: "bash",
          home: "/home/deploy",
          cwd: "/tmp",
        },
      };
    },
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });

  const sshCd = harness.tools.get("ssh_cd");
  const change = (path: string) => sshCd.execute(
    `ssh-cd-${path}`,
    { path },
    undefined,
    undefined,
    harness.ctx,
  );

  await change("/remote/example");
  assert.equal(findSshSessionState(harness.entries)?.remoteCwd, "/remote/example");
  await change("/remote/example/Desktop");
  assert.equal(
    findSshSessionState(harness.entries)?.remoteCwd,
    "/remote/example/Desktop",
  );
  await change("../../..");
  assert.equal(findSshSessionState(harness.entries)?.remoteCwd, "/");
  await change("remote/example");
  assert.equal(findSshSessionState(harness.entries)?.remoteCwd, "/remote/example");
  assert.deepEqual(inspectedCwds, [
    "/remote/example",
    "/remote/example/Desktop",
    "/",
    "/remote/example",
  ]);
  assert.equal(clients.length, 1, "cwd changes must reuse the SSH connection");

  const stateEntriesBeforeFailure = harness.entries.filter((entry: any) =>
    entry.customType === SSH_SESSION_STATE_TYPE
  ).length;
  const sessionNameBeforeFailure = harness.getSessionName();
  await assert.rejects(
    () => change("/does-not-exist"),
    /Remote directory does not exist: \/does-not-exist/,
  );
  assert.equal(
    findSshSessionState(harness.entries)?.remoteCwd,
    "/remote/example",
    "a failed change must preserve the previous remote cwd",
  );
  assert.equal(harness.getSessionName(), sessionNameBeforeFailure);
  assert.equal(harness.statuses.get("ssh-remote"), "SSH: Connected");
  assert.equal(
    harness.entries.filter((entry: any) =>
      entry.customType === SSH_SESSION_STATE_TYPE
    ).length,
    stateEntriesBeforeFailure,
    "a failed change must not persist a new session state",
  );
  assert.ok(harness.events.some((event) =>
    event.name === "ssh-remote:environment"
      && event.payload.action === "change-cwd"
      && event.payload.status === "failed"
      && event.payload.remoteCwd === "/does-not-exist"
  ));
});

test("ssh-cd keeps Windows remote absolute paths independent of the local cwd", async () => {
  const inspectedCwds: string[] = [];
  const harness = createExtensionHarness({
    flag: "winbox:C:\\Temp",
    cwd: "C:\\Local\\Workspace",
  });
  createSshRemoteExtension({
    platform: "win32",
    loadConfig: () => ({
      ...DEFAULT_SSH_REMOTE_CONFIG,
      aiControlTools: true,
    }),
    createClient: (options) => new FakeWindowsSshClient(options),
    selectRemote: async (client) => {
      const adapter = new WindowsPowerShellAdapter(client, "pwsh", "win32");
      adapter.inspectWorkspace = async (requestedCwd) => {
        const cwd = requestedCwd ?? "C:\\Temp";
        inspectedCwds.push(cwd);
        return {
          platform: "windows",
          shell: "pwsh",
          home: "C:\\Users\\Admin",
          cwd,
        };
      };
      return {
        adapter,
        workspace: {
          platform: "windows",
          shell: "pwsh",
          home: "C:\\Users\\Admin",
          cwd: "C:\\Temp",
        },
      };
    },
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });

  const sshCd = harness.tools.get("ssh_cd");
  await sshCd.execute(
    "ssh-cd-windows-absolute",
    { path: "D:\\Remote\\Example\\Desktop" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(
    findSshSessionState(harness.entries)?.remoteCwd,
    "D:\\Remote\\Example\\Desktop",
  );
  await sshCd.execute(
    "ssh-cd-windows-relative",
    { path: ".." },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(
    findSshSessionState(harness.entries)?.remoteCwd,
    "D:\\Remote\\Example",
  );
  assert.deepEqual(inspectedCwds, [
    "D:\\Remote\\Example\\Desktop",
    "D:\\Remote\\Example",
  ]);
});

test("optional grep, find, and ls tools stay opt-in and route through SSH", async () => {
  const client = new FakeSshClient({ target: "devbox" });
  const activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  const harness = createExtensionHarness({
    flag: "devbox:/srv/project",
    activeTools,
  });
  createSshRemoteExtension({
    platform: "linux",
    createClient: () => client,
  })(harness.pi);

  assert.deepEqual(harness.getActiveTools(), activeTools);
  await harness.emit("session_start", { reason: "startup" });

  const lsResult = await harness.tools.get("ls").execute(
    "ls-remote",
    {},
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(lsResult.content[0].text, "README.md\nsrc/");

  const findResult = await harness.tools.get("find").execute(
    "find-remote",
    { pattern: "**/*.ts" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(findResult.content[0].text, "src/index.ts\nsrc/util.ts");

  const grepResult = await harness.tools.get("grep").execute(
    "grep-remote",
    { pattern: "remoteMatch" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(grepResult.content[0].text, "src/index.ts:12: remoteMatch()");
  assert.ok(client.calls.some((call) => call.command.includes("PI_SSH_REMOTE_LS")));
  assert.ok(client.calls.some((call) => call.command.includes("PI_SSH_REMOTE_FIND")));
  assert.ok(client.calls.some((call) => call.command.includes("PI_SSH_REMOTE_GREP")));
});

test("optional search tools fail closed when SSH is unavailable", async () => {
  const harness = createExtensionHarness({
    flag: "offline-host",
    activeTools: ["read", "grep", "find", "ls"],
  });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => new FakeSshClient(options),
    selectRemote: async () => { throw new Error("connection refused"); },
  })(harness.pi);

  await harness.emit("session_start", { reason: "startup" });
  for (const name of ["grep", "find", "ls"]) {
    await assert.rejects(
      () => harness.tools.get(name).execute(
        `${name}-offline`,
        name === "grep"
          ? { pattern: "secret" }
          : name === "find"
            ? { pattern: "*.ts" }
            : {},
        undefined,
        undefined,
        harness.ctx,
      ),
      /SSH remote is unavailable: connection refused/,
    );
  }
});

test("startup connection failure leaves the session alive for reconnect", async () => {
  // A failed connection during session_start keeps the session running in a
  // failed state so /ssh-reconnect and /ssh-status stay available.
  const clients: FakeSshClient[] = [];
  let failNextProbe = false;
  const harness = createExtensionHarness({ flag: "devbox:/srv/project" });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeSshClient(options);
      clients.push(client);
      return client;
    },
    selectRemote: async () => {
      if (failNextProbe) throw new Error("temporary failure");
      return {
        adapter: new UnixBashAdapter(clients.at(-1)!, "linux"),
        workspace: {
          platform: "unix",
          shell: "bash",
          home: "/home/deploy",
          cwd: "/srv/project",
        },
      };
    },
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });
  assert.equal(harness.getShutdowns(), 0);
  assert.equal(harness.statuses.has("ssh-remote"), true);

  // A failed reconnect keeps the established connection active.
  failNextProbe = true;
  await harness.commands.get("ssh-reconnect").handler("", harness.ctx);
  assert.equal(harness.getShutdowns(), 0);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].disposed, false);
  assert.equal(clients[1].disposed, true);
  assert.equal(harness.statuses.get("ssh-remote"), "SSH: Connected");
  assert.ok(
    harness.notifications.some((n) => n.message.includes("temporary failure")),
  );

  // Recovery works once the remote is reachable again.
  failNextProbe = false;
  await harness.commands.get("ssh-reconnect").handler("", harness.ctx);
  assert.equal(harness.getShutdowns(), 0);
  assert.equal(clients.length, 3);
  assert.equal(clients[0].disposed, true);
  assert.equal(clients[2].disposed, false);
  assert.ok(
    harness.notifications.some((n) => n.message.includes("SSH remote active")),
  );
});

test("background provider registry follows SSH transitions without last-writer races", async () => {
  const clients: FakeSshClient[] = [];
  const harness = createExtensionHarness({ flag: "host-a:/srv/a" });
  type TestBackgroundResolver = (
    command: string,
    interactive: boolean,
    context: { cwd: string; projectTrusted: boolean },
  ) => {
    file: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    taskEnvironment?: string;
  } | undefined;
  const providers = new Map<string, {
    priority: number;
    resolveShell: TestBackgroundResolver;
  }>();
  harness.pi.events.on("bg:register", (data: unknown) => {
    const registration = data as {
      id?: unknown;
      priority?: unknown;
      resolveShell?: TestBackgroundResolver;
    };
    if (typeof registration.id !== "string" || !registration.resolveShell) return;
    providers.set(registration.id, {
      priority: typeof registration.priority === "number" ? registration.priority : 0,
      resolveShell: registration.resolveShell,
    });
  });
  const localResolver = (command: string) => ({
    file: "pwsh.exe",
    args: ["-Command", command],
    env: { ...process.env },
  });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeSshClient(options);
      clients.push(client);
      return client;
    },
    selectRemote: async (client, options) => {
      if (client.options.target === "broken-host") {
        throw new Error("broken host");
      }
      return {
        adapter: new UnixBashAdapter(client, "linux", "bash"),
        workspace: {
          platform: "unix",
          shell: "bash",
          home: "/home/deploy",
          cwd: options.requestedCwd ?? "/srv/default",
        },
      };
    },
  })(harness.pi);
  const resolve = () => {
    for (const provider of Array.from(providers.values()).sort(
      (left, right) => right.priority - left.priority,
    )) {
      const launch = provider.resolveShell("pwd", false, {
        cwd: "/local/project",
        projectTrusted: true,
      });
      if (launch) return launch;
    }
    return undefined;
  };

  await harness.emit("session_start", { reason: "startup" });
  assert.ok(resolve()?.args.includes("host-a"));
  assert.match(resolve()?.args.at(-1) ?? "", /\/srv\/a/);
  assert.equal(resolve()?.taskEnvironment, "SSH host-a:/srv/a");

  // A lower-priority local provider can register later without stealing an
  // active SSH launch. No tool_call-time resolver reclaim is needed.
  harness.pi.events.emit("bg:register", {
    id: "pwsh-adapter",
    priority: 10,
    resolveShell: localResolver,
  });
  assert.equal(resolve()?.file, "ssh");
  assert.ok(resolve()?.args.includes("host-a"));

  await harness.commands.get("ssh-connect").handler("host-b:/srv/b", harness.ctx);
  assert.ok(resolve()?.args.includes("host-b"));
  assert.match(resolve()?.args.at(-1) ?? "", /\/srv\/b/);
  assert.equal(resolve()?.taskEnvironment, "SSH host-b:/srv/b");

  await harness.commands.get("ssh-connect").handler(
    "broken-host:/srv/broken",
    harness.ctx,
  );
  assert.ok(resolve()?.args.includes("host-b"), "a failed switch must keep the old backend");
  assert.ok(!resolve()?.args.includes("broken-host"));

  await harness.commands.get("ssh-exit").handler("", harness.ctx);
  assert.equal(resolve()?.file, "pwsh.exe");

  await harness.commands.get("ssh-connect").handler("host-c:/srv/c", harness.ctx);
  assert.equal(resolve()?.file, "ssh");
  assert.ok(resolve()?.args.includes("host-c"));
  assert.match(resolve()?.args.at(-1) ?? "", /\/srv\/c/);
  assert.equal(resolve()?.taskEnvironment, "SSH host-c:/srv/c");
});

test("active SSH blocks outdated Background Tasks without task-control support", async () => {
  const harness = createExtensionHarness({
    flag: "devbox:/srv/project",
    backgroundProtocolVersion: null,
  });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => new FakeSshClient(options),
    selectRemote: async (client, options) => ({
      adapter: new UnixBashAdapter(client, "linux", "bash"),
      workspace: {
        platform: "unix",
        shell: "bash",
        home: "/home/deploy",
        cwd: options.requestedCwd ?? "/srv/project",
      },
    }),
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });
  const decision = await harness.emit("tool_call", {
    toolName: "bg_start",
    toolCallId: "outdated-background-tasks",
    input: { name: "unsafe-remote", command: "sleep 30" },
  }) as { block?: boolean; reason?: string };
  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /task-control protocol v2.*Update Background Tasks/i);
  await harness.emit("session_shutdown", { reason: "quit" });
});

test("background resolver fails closed while SSH is unavailable", async () => {
  // A session whose SSH connection failed registers a state-aware background
  // resolver: bg tasks fail with the probe error instead of silently running
  // on the local machine.
  const harness = createExtensionHarness({ flag: "offline-host" });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => new FakeSshClient(options),
    selectRemote: async () => {
      throw new Error("connection refused");
    },
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });
  const register = harness.events.find((event) => event.name === "bg:register");
  assert.ok(register);
  const resolveShell = register.payload.resolveShell;
  assert.throws(
    () => resolveShell("pwd", false, { cwd: "/local/project", projectTrusted: true }),
    /SSH remote is unavailable: connection refused/,
  );

  // Sessions without any SSH intent never register a resolver, so background
  // tasks keep using the default local shell backend.
  const local = createExtensionHarness();
  createSshRemoteExtension({ platform: "linux" })(local.pi);
  await local.emit("session_start", { reason: "startup" });
  assert.equal(local.events.filter((event) => event.name === "bg:register").length, 0);
});

test("bg_start is blocked while the SSH workspace is unavailable", async () => {
  const harness = createExtensionHarness({ flag: "offline-host" });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => new FakeSshClient(options),
    selectRemote: async () => {
      throw new Error("connection refused");
    },
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });

  const blocked = await harness.emit("tool_call", {
    toolName: "bg_start",
    toolCallId: "bg-1",
    input: { name: "x", command: "echo hi" },
  });
  assert.deepEqual(blocked, {
    block: true,
    reason: "SSH remote is unavailable: connection refused",
  });

  // Non-bg tools and active sessions are unaffected.
  const other = await harness.emit("tool_call", {
    toolName: "bash",
    toolCallId: "b-1",
    input: { command: "pwd" },
  });
  assert.equal(other, undefined);
});

test("bash delegation follows the SSH runtime state", async () => {
  // Active SSH sessions expose remote BashOperations through the
  // bash:delegate protocol (consumed by pi-pwsh-adapter on Windows).
  const clients: FakeSshClient[] = [];
  const harness = createExtensionHarness({ flag: "devbox:/srv/project" });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeSshClient(options);
      clients.push(client);
      return client;
    },
    selectRemote: async () => ({
      adapter: new UnixBashAdapter(clients.at(-1)!, "linux"),
      workspace: {
        platform: "unix",
        shell: "bash",
        home: "/home/deploy",
        cwd: "/srv/project",
      },
    }),
  })(harness.pi);
  await harness.emit("session_start", { reason: "startup" });
  const delegate = harness.events.find((event) => event.name === "bash:delegate");
  assert.ok(delegate);
  const resolveOperations = delegate.payload.resolveOperations;
  const ops = resolveOperations();
  assert.ok(ops, "active session must expose remote operations");
  const execResult = await ops.exec("pwd", "/local/project", {
    onData: () => {},
  });
  assert.equal(execResult.exitCode, 0);

  // Failed sessions fail closed instead of silently running locally.
  const failed = createExtensionHarness({ flag: "offline-host" });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => new FakeSshClient(options),
    selectRemote: async () => {
      throw new Error("connection refused");
    },
  })(failed.pi);
  await failed.emit("session_start", { reason: "startup" });
  const failedDelegate = failed.events.find(
    (event) => event.name === "bash:delegate",
  );
  assert.ok(failedDelegate);
  await assert.rejects(
    () => failedDelegate.payload.resolveOperations().exec("pwd", "/local", { onData: () => {} }),
    /SSH remote is unavailable: connection refused/,
  );

  // Sessions without SSH never emit the delegate, so the local backend stays.
  const local = createExtensionHarness();
  createSshRemoteExtension({ platform: "linux" })(local.pi);
  await local.emit("session_start", { reason: "startup" });
  assert.equal(
    local.events.filter((event) => event.name === "bash:delegate").length,
    0,
  );
});

test("extension persists, routes, prompts, and restores an SSH workspace", async () => {
  const clients: FakeSshClient[] = [];
  const extension = createSshRemoteExtension({
    platform: process.platform,
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

  assert.equal(harness.commands.has("ssh-connect"), true);
  assert.equal(harness.commands.has("ssh-exit"), true);
  assert.equal(harness.commands.has("ssh-status"), true);
  assert.equal(harness.commands.has("ssh-reconnect"), true);
  await harness.emit("session_start", { reason: "startup" });
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

  const context = await harness.emit("context", { messages: [] }) as {
    messages: Array<{ role: string; content: string }>;
  };
  assert.match(context.messages.at(-1)?.content ?? "", /devbox:\/srv\/project/);
  assert.match(context.messages.at(-1)?.content ?? "", /authoritative/);
  assert.match(context.messages.at(-1)?.content ?? "", /local cwd \(\/local\/project\).*only the local session anchor/);

  await harness.emit("session_shutdown", { reason: "quit" });
  assert.equal(clients[0].disposed, true);
  assert.deepEqual(clients[0].disposeOptions, [undefined]);
});

test("extension routes Windows workspaces through PowerShell without exposing logical paths", async () => {
  const clients: FakeWindowsSshClient[] = [];
  const extension = createSshRemoteExtension({
    platform: process.platform,
    createClient: (options) => {
      const client = new FakeWindowsSshClient(options);
      clients.push(client);
      return client;
    },
  });
  const harness = createExtensionHarness({
    flag: "winbox",
    activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  });
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

  const context = await harness.emit("context", { messages: [] }) as {
    messages: Array<{ role: string; content: string }>;
  };
  const environmentMessage = context.messages.at(-1)?.content ?? "";
  assert.match(environmentMessage, /winbox:C:\\Users\\Admin/);
  assert.match(environmentMessage, /PowerShell syntax, not Bash syntax/);
  assert.doesNotMatch(environmentMessage, /compatible|bg_\*|codex_image/);
  assert.equal(
    clients[0].options.executable,
    process.platform === "win32" ? "ssh.exe" : undefined,
  );
  assert.ok(harness.events.some((event) => event.name === "bg:register"));

  const lsResult = await harness.tools.get("ls").execute(
    "ls-win",
    {},
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(lsResult.content[0].text, "README.md\nsrc/");
  const findResult = await harness.tools.get("find").execute(
    "find-win",
    { pattern: "**/*.ts" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(findResult.content[0].text, "src/main.ts");
  const grepResult = await harness.tools.get("grep").execute(
    "grep-win",
    { pattern: "RemoteMatch" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(grepResult.content[0].text, "src/main.ts:8: RemoteMatch()");

  await harness.emit("session_shutdown", { reason: "quit" });
  assert.equal(clients[0].disposed, true);

  const resumedClients: FakeWindowsSshClient[] = [];
  const resumed = createExtensionHarness({ branch: [sessionEntry(saved)] });
  createSshRemoteExtension({
    platform: process.platform,
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

test("Windows local sessions leave core tools to the PowerShell adapter", async () => {
  const harness = createExtensionHarness({ cwd: "C:\\local\\project" });
  createSshRemoteExtension({ platform: "win32" })(harness.pi);
  assert.equal(harness.tools.size, 0);
  await harness.emit("session_start", { reason: "startup" });
  assert.equal(harness.tools.size, 0);
  assert.equal(harness.notifications.length, 0);
});

test("Windows clients route Unix workspaces through ssh.exe", async () => {
  const clients: FakeSshClient[] = [];
  const harness = createExtensionHarness({
    flag: "devbox:/srv/project",
    cwd: "C:\\local\\project",
  });
  createSshRemoteExtension({
    platform: "win32",
    createClient: (options) => {
      const client = new FakeSshClient(options);
      clients.push(client);
      return client;
    },
  })(harness.pi);

  await harness.emit("session_start", { reason: "startup" });
  assert.equal(clients[0].options.executable, "ssh.exe");
  const result = await harness.tools.get("bash").execute(
    "bash-win-client",
    { command: "pwd" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(result.content[0].text, "(no output)");
  assert.ok(clients[0].calls.some((call) => call.command.includes("exec bash -lc")));
  const background = harness.events.find((event) => event.name === "bg:register")
    ?.payload as {
      resolveShell: (
        command: string,
        interactive: boolean,
        context: { cwd: string; projectTrusted: boolean },
      ) => {
        file: string;
        cwd?: string;
        taskEnvironment?: string;
      };
    };
  const launch = background.resolveShell("pwd", false, {
    cwd: "C:\\local\\project\\src",
    projectTrusted: true,
  });
  assert.equal(launch.file, "ssh.exe");
  assert.equal(launch.cwd, "C:\\local\\project");
  assert.equal(
    launch.taskEnvironment,
    "SSH devbox:/srv/project/src",
  );
});

test("Windows clients route Windows shells through ssh.exe", async () => {
  const clients: FakeWindowsSshClient[] = [];
  const harness = createExtensionHarness({
    flag: "winbox",
    cwd: "C:\\local\\project",
  });
  createSshRemoteExtension({
    platform: "win32",
    createClient: (options) => {
      const client = new FakeWindowsSshClient(options);
      clients.push(client);
      return client;
    },
  })(harness.pi);

  await harness.emit("session_start", { reason: "startup" });
  assert.equal(clients[0].options.executable, "ssh.exe");
  const result = await harness.tools.get("bash").execute(
    "pwsh-win-client",
    { command: "Get-Location" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(result.content[0].text, "(no output)");
  assert.ok(clients[0].calls.some((call) =>
    decodePowerShellInvocation(call.command).includes("Get-Location")
  ));
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
  assert.equal(normalizeSshSessionState({
    version: 2,
    target: "winbox",
    remotePlatform: "windows",
    remoteShell: "zsh",
    remoteCwd: "C:\\Users\\Admin",
    remoteHome: "C:\\Users\\Admin",
  }), undefined);
  assert.equal(normalizeSshSessionState({
    version: 2,
    target: "router",
    remotePlatform: "unix",
    remoteShell: "sh",
    remoteCwd: "/etc",
    remoteHome: "/root",
  })?.remoteShell, "sh");
});

test("local session tombstones override earlier remote state per branch", () => {
  const remote: SshSessionState = {
    version: 2,
    target: "devbox",
    remotePlatform: "unix",
    remoteShell: "bash",
    remoteCwd: "/srv/project",
    remoteHome: "/home/deploy",
  };
  const remoteBranch = [sessionEntry(remote)];
  assert.equal(findSshEnvironmentState(remoteBranch)?.mode, "remote");
  assert.equal(findSshSessionState(remoteBranch)?.target, "devbox");

  const localBranch = [...remoteBranch, localSessionEntry()];
  assert.equal(findSshEnvironmentState(localBranch)?.mode, "local");
  assert.equal(findSshSessionState(localBranch), undefined);

  const reconnectedBranch = [...localBranch, sessionEntry({
    ...remote,
    remoteCwd: "/srv/other",
  })];
  assert.equal(findSshEnvironmentState(reconnectedBranch)?.mode, "remote");
  assert.equal(findSshSessionState(reconnectedBranch)?.remoteCwd, "/srv/other");
});

test("ash-only sh sessions survive resume", async () => {
  const stored: SshSessionState = {
    version: 2,
    target: "router",
    remotePlatform: "unix",
    remoteShell: "sh",
    remoteCwd: "/etc",
    remoteHome: "/root",
  };
  const clients: FakeSshClient[] = [];
  const harness = createExtensionHarness({ branch: [sessionEntry(stored)] });
  createSshRemoteExtension({
    platform: "linux",
    createClient: (options) => {
      const client = new FakeSshClient(
        options,
        { home: "/root", cwd: "/etc" },
      );
      client.inspectShells = new Set(["sh"]);
      clients.push(client);
      return client;
    },
  })(harness.pi);

  await harness.emit("session_start", { reason: "resume" });
  assert.equal(clients.length, 1);
  assert.ok(
    clients[0].calls.some((call) => call.command.startsWith("command -v sh")),
  );
  assert.equal(findSshSessionState(harness.entries)?.remoteShell, "sh");
  assert.equal(harness.statuses.get("ssh-remote"), "SSH: Connected");
  const context = await harness.emit("context", { messages: [] }) as {
    messages: Array<{ content: string }>;
  };
  const environmentMessage = context.messages.at(-1)?.content ?? "";
  assert.match(environmentMessage, /POSIX sh syntax/);
  assert.doesNotMatch(environmentMessage, /execute Bash syntax/);
  await harness.emit("session_shutdown", { reason: "quit" });
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
  createSshRemoteExtension({
    platform: "linux",
  })(conflicting.pi);
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

test("password resolver caches, persists, rejects, and forgets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-secrets-test-"));
  const secretsPath = join(directory, "secrets.json");
  const endpoint = {
    hostLabel: "deploy@devbox:22",
    username: "deploy",
    host: "devbox",
    port: 22,
  };
  const otherEndpoint = {
    hostLabel: "admin@other-host:22",
    username: "admin",
    host: "other-host",
    port: 22,
  };
  const prompts: string[] = [];
  const resolver = new SshPasswordResolver({ persistPasswords: true, secretsPath });
  resolver.setUI({
    prompt: async (title) => {
      prompts.push(title);
      return "pw1";
    },
    notify: () => {},
  });

  // Prompt on first use, then serve from memory.
  assert.equal(await resolver.resolvePassword(endpoint), "pw1");
  assert.equal(resolver.cachedPassword(endpoint), "pw1");
  assert.deepEqual(prompts, ["SSH password for deploy@devbox:22"]);
  assert.equal(await resolver.resolvePassword(endpoint), "pw1");
  assert.deepEqual(prompts, ["SSH password for deploy@devbox:22"]);

  // POSIX creates the secrets file with 0600. Windows uses inherited ACLs
  // and Node reports synthetic POSIX mode bits, so only persistence is
  // portable there.
  if (process.platform !== "win32") {
    const mode = statSync(secretsPath).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  const fresh = new SshPasswordResolver({ persistPasswords: true, secretsPath });
  assert.equal(fresh.cachedPassword(endpoint), "pw1");

  // Rejecting clears memory and the file so the next attempt re-asks.
  resolver.rejectPassword(endpoint);
  assert.equal(resolver.cachedPassword(endpoint), undefined);
  assert.equal(fresh.cachedPassword(endpoint), undefined);

  // retryPassword rejects then re-prompts with the fresh secret.
  resolver.setUI({
    prompt: async () => "pw2",
    notify: () => {},
  });
  assert.equal(await resolver.retryPassword(endpoint), "pw2");
  assert.equal(resolver.cachedPassword(endpoint), "pw2");

  // Session-scoped forgetting removes only endpoints touched by this resolver.
  const otherResolver = new SshPasswordResolver({
    persistPasswords: true,
    secretsPath,
  });
  otherResolver.setUI({
    prompt: async () => "other-pw",
    notify: () => {},
  });
  assert.equal(await otherResolver.resolvePassword(otherEndpoint), "other-pw");
  assert.equal(resolver.forgetCurrentSession(), 1);
  const afterSessionForget = new SshPasswordResolver({
    persistPasswords: true,
    secretsPath,
  });
  assert.equal(afterSessionForget.cachedPassword(endpoint), undefined);
  assert.equal(afterSessionForget.cachedPassword(otherEndpoint), "other-pw");

  // forgetAll clears every persisted entry, including other sessions' hosts.
  assert.equal(resolver.forgetAll(), 1);
  const afterForgetAll = new SshPasswordResolver({
    persistPasswords: true,
    secretsPath,
  });
  assert.equal(afterForgetAll.cachedPassword(otherEndpoint), undefined);
  assert.deepEqual(
    JSON.parse(readFileSync(secretsPath, "utf8")),
    {},
  );
  rmSync(directory, { recursive: true, force: true });
});

test("password resolver surfaces the transport rejection in the prompt and a notify", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-secrets-test-"));
  const secretsPath = join(directory, "secrets.json");
  const endpoint = {
    hostLabel: "root@router:22",
    username: "root",
    host: "router",
    port: 22,
  };
  const prompts: string[] = [];
  const notifications: Array<[string, string | undefined]> = [];
  const resolver = new SshPasswordResolver({ persistPasswords: false, secretsPath });
  resolver.setUI({
    prompt: async (title) => {
      prompts.push(title);
      return "pw";
    },
    notify: (message, type) => notifications.push([message, type]),
  });
  // First failure: nothing was tried yet, so no "rejected" notify and a
  // clean prompt title.
  await resolver.retryPassword(
    endpoint,
    "root@router: Permission denied (publickey,password).",
  );
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0], "SSH password for root@router:22");
  assert.equal(notifications.length, 0);

  // Second failure: the typed password was rejected, so the rejection is
  // surfaced before the next prompt.
  await resolver.retryPassword(
    endpoint,
    "root@router: Permission denied (publickey,password).",
  );
  assert.ok(
    notifications.some(
      ([message, type]) => type === "warning" && /SSH password rejected:.*Permission denied/.test(message),
    ),
  );
  rmSync(directory, { recursive: true, force: true });
});

test("password rejection messages reach the provider retry callback", async () => {
  const raw = new FakeAuthFailClient();
  const errors: unknown[] = [];
  const client = new Ssh2Client(
    { target: "devbox" },
    {
      createClient: () => raw as any,
      resolveConnection: async () => ({
        config: { host: "devbox", username: "deploy" },
        hostLabel: "deploy@devbox:22",
        warnings: [],
        verification: {},
      }),
      promptPassword: async (_endpoint, error) => {
        errors.push(error);
        return "pw";
      },
    },
  );
  await client.run("whoami");
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Ssh2ConnectionError);
});

test("password resolver hard-times out prompts even when the UI does not resolve", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-secrets-test-"));
  const secretsPath = join(directory, "secrets.json");
  const endpoint = {
    hostLabel: "deploy@slow-host:22",
    username: "deploy",
    host: "slow-host",
    port: 22,
  };
  let promptControls: { timeoutMs?: number; signal?: AbortSignal } | undefined;
  const resolver = new SshPasswordResolver({
    persistPasswords: false,
    secretsPath,
  });
  resolver.setUI({
    prompt: async (_title, controls) => {
      promptControls = controls;
      return new Promise<string | undefined>(() => {});
    },
    notify: () => {},
  });

  await assert.rejects(
    () => resolver.resolvePassword(endpoint, undefined, { timeoutMs: 5 }),
    (error: unknown) =>
      error instanceof SshPasswordTimeoutError
      && /timed out after 1 second/.test(error.message),
  );
  assert.equal(promptControls?.timeoutMs, 5);
  assert.equal(promptControls?.signal?.aborted, true);
  rmSync(directory, { recursive: true, force: true });
});

test("password resolver stays silent without a UI or when persistence is off", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-secrets-test-"));
  const secretsPath = join(directory, "secrets.json");
  const endpoint = {
    hostLabel: "deploy@devbox:22",
    username: "deploy",
    host: "devbox",
    port: 22,
  };

  // No UI (headless): resolve never prompts and returns undefined.
  const headless = new SshPasswordResolver({ persistPasswords: true, secretsPath });
  assert.equal(await headless.resolvePassword(endpoint), undefined);
  assert.equal(headless.hasUI, false);

  // Persistence off: passwords stay in memory only, no file is written.
  const memoryOnly = new SshPasswordResolver({ persistPasswords: false, secretsPath });
  memoryOnly.setUI({ prompt: async () => "tmp", notify: () => {} });
  assert.equal(await memoryOnly.resolvePassword(endpoint), "tmp");
  assert.equal(memoryOnly.cachedPassword(endpoint), "tmp");
  const fresh = new SshPasswordResolver({ persistPasswords: false, secretsPath });
  assert.equal(fresh.cachedPassword(endpoint), undefined);
  assert.equal(existsSync(secretsPath), false);
  rmSync(directory, { recursive: true, force: true });
});
