import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { createSshBackgroundShellResolver } from "../extensions/ssh-remote/background.ts";
import {
  buildSshArguments,
  OpenSshClient,
  type SshClientOptions,
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
import { createSshRemoteExtension } from "../extensions/ssh-remote/index.ts";
import { Ssh2Client, Ssh2ConnectionError } from "../extensions/ssh-remote/ssh2-client.ts";
import { SshPasswordResolver } from "../extensions/ssh-remote/password-resolver.ts";
import {
  expandProxyJumpTokens,
  parseKnownHostSearchOutput,
  parseOpenSshConfig,
  parseProxyJump,
  resolveSsh2Connection,
  Ssh2CompatibilityError,
} from "../extensions/ssh-remote/ssh2-config.ts";
import { createSshTransportClient } from "../extensions/ssh-remote/transport.ts";
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

test("SSH Remote transport settings normalize and persist", () => {
  assert.deepEqual(normalizeSshRemoteConfig(undefined), DEFAULT_SSH_REMOTE_CONFIG);
  assert.deepEqual(normalizeSshRemoteConfig({ transport: "ssh2" }), {
    transport: "ssh2",
    passwordPrompt: true,
    persistPasswords: true,
  });
  assert.deepEqual(normalizeSshRemoteConfig({ transport: "invalid" }), {
    transport: "auto",
    passwordPrompt: true,
    persistPasswords: true,
  });
  assert.deepEqual(normalizeSshRemoteConfig({
    transport: "ssh2",
    passwordPrompt: false,
    persistPasswords: false,
  }), { transport: "ssh2", passwordPrompt: false, persistPasswords: false });

  const directory = mkdtempSync(join(tmpdir(), "pi-ssh-settings-test-"));
  const path = join(directory, "settings.json");
  try {
    writeFileSync(path, JSON.stringify({ unrelated: { enabled: true } }));
    saveSshRemoteConfig({ transport: "openssh" }, path);
    assert.deepEqual(loadSshRemoteConfig(path), {
      transport: "openssh",
      passwordPrompt: true,
      persistPasswords: true,
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
      createOpenSsh: () => failingOpenSsh,
      createSsh2: () => passwordSsh2,
      passwordProvider: provider,
    },
  );

  assert.equal(client.transport, "openssh");
  const result = await client.runChecked("whoami");
  assert.equal(result.exitCode, 0);
  assert.equal(openSshRuns, 1);
  assert.equal(ssh2Runs, 1);
  assert.equal(client.transport, "ssh2");
  assert.match(client.fallbackReason ?? "", /Permission denied/);
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
        run: async () => { throw new Error("SSH command failed (255): Permission denied"); },
        runChecked: async () => { throw new Error("SSH command failed (255): Permission denied"); },
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
  // Unix auto wraps OpenSSH so an authentication failure can fall back
  // to ssh2 for the TUI password prompt.
  assert.equal((unix as { delegate?: SshRemoteClient }).delegate, unixClient);
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

test("remote Unix paths use a Windows-safe logical namespace", () => {
  const adapter = new UnixBashAdapter(
    new FakeSshClient({ target: "devbox" }),
    "win32",
  );
  const workspace: RemoteWorkspace = {
    platform: "unix",
    shell: "bash",
    home: "/home/deploy",
    cwd: "/srv/project",
  };
  const logical = adapter.toToolPath("src/a file.ts", workspace);
  assert.match(logical, /^C:\\__pi_ssh_remote_unix__\\root\\/);
  assert.equal(adapter.fromToolPath(logical), "/srv/project/src/a file.ts");
  assert.equal(
    adapter.fromToolPath(adapter.toToolPath("~/notes.txt", workspace)),
    "/home/deploy/notes.txt",
  );
});

test("remote file operations quote paths and stream write content over stdin", async () => {
  const client = new FakeSshClient({ target: "devbox" });
  const adapter = new UnixBashAdapter(client, "linux");
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
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  const compressed = /\$data = \[Convert\]::FromBase64String\('([^']+)'\)/.exec(script)?.[1];
  return compressed
    ? gunzipSync(Buffer.from(compressed, "base64")).toString("utf8")
    : script;
}

class FakeWindowsSshClient implements SshRemoteClient {
  readonly calls: RecordedRun[] = [];
  disposed = false;
  remoteFileExists = false;
  /** Commands reported by the PowerShell Get-Command probe. */
  availablePowerShellCommands = new Set<string>();

  constructor(readonly options: Readonly<SshClientOptions> = { target: "winbox" }) {}

  async run(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    this.calls.push({ command, options, checked: false });
    if (command.startsWith("command -v bash")) {
      return { stdout: Buffer.alloc(0), stderr: Buffer.from("bash missing"), exitCode: 127 };
    }
    if (command.includes("getent passwd") || /sh -c 'command -v [a-z0-9_.-]+ /.test(command)) {
      // A Windows host without sh cannot run POSIX probes: exit 1, no output.
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 1 };
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
  transportFlag?: string;
  branch?: unknown[];
  sessionName?: string;
  cwd?: string;
  activeTools?: string[];
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
  let shutdowns = 0;
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
    getActiveTools: () => [...activeTools],
    getShutdowns: () => shutdowns,
  };
}

function sessionEntry(state: unknown) {
  return { type: "custom", customType: SSH_SESSION_STATE_TYPE, data: state };
}

test("SSH commands stay hidden in local sessions", async () => {
  const harness = createExtensionHarness();
  createSshRemoteExtension({ platform: "linux" })(harness.pi);

  assert.deepEqual(harness.getActiveTools(), ["read", "bash", "edit", "write"]);
  assert.equal(harness.tools.has("grep"), false);
  assert.equal(harness.tools.has("find"), false);
  assert.equal(harness.tools.has("ls"), false);
  assert.equal(harness.commands.has("ssh-status"), false);
  assert.equal(harness.commands.has("ssh-reconnect"), false);
  await harness.emit("session_start", { reason: "startup" });
  assert.deepEqual(harness.getActiveTools(), ["read", "bash", "edit", "write"]);
  assert.equal(harness.tools.has("grep"), false);
  assert.equal(harness.tools.has("find"), false);
  assert.equal(harness.tools.has("ls"), false);
  assert.equal(harness.commands.has("ssh-status"), false);
  assert.equal(harness.commands.has("ssh-reconnect"), false);
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
  assert.match(harness.notifications.at(-1)?.message ?? "", /SSH target: devbox/);

  await harness.commands.get("ssh-reconnect").handler("", harness.ctx);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].disposed, true);
  assert.equal(clients[1].options.target, "devbox");
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

  // A failed reconnect keeps the session alive for another attempt.
  failNextProbe = true;
  await harness.commands.get("ssh-reconnect").handler("", harness.ctx);
  assert.equal(harness.getShutdowns(), 0);
  assert.ok(
    harness.notifications.some((n) => n.message.includes("temporary failure")),
  );

  // Recovery works once the remote is reachable again.
  failNextProbe = false;
  await harness.commands.get("ssh-reconnect").handler("", harness.ctx);
  assert.equal(harness.getShutdowns(), 0);
  assert.ok(
    harness.notifications.some((n) => n.message.includes("SSH remote active")),
  );
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

  const prompt = await harness.emit("before_agent_start", {
    systemPrompt: "Current working directory: /local/project",
  }) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /Current working directory: C:\\Users\\Admin/);
  assert.match(prompt.systemPrompt, /PowerShell syntax, not Bash syntax/);
  assert.doesNotMatch(prompt.systemPrompt, /compatible|bg_\*|codex_image/);
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
      ) => { file: string; cwd?: string };
    };
  const launch = background.resolveShell("pwd", false, {
    cwd: "C:\\local\\project\\src",
    projectTrusted: true,
  });
  assert.equal(launch.file, "ssh.exe");
  assert.equal(launch.cwd, "C:\\local\\project");
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

  // Secrets file is written with 0600 and readable by a fresh resolver
  // (simulates a -r restart reusing the password).
  const mode = statSync(secretsPath).mode & 0o777;
  assert.equal(mode, 0o600);
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

  // forgetAll clears everything, including the persisted file.
  resolver.forgetAll();
  assert.equal(resolver.cachedPassword(endpoint), undefined);
  assert.deepEqual(
    JSON.parse(readFileSync(secretsPath, "utf8")),
    {},
  );
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
