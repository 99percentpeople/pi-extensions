import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { after, before, test } from "node:test";
import { selectRemoteAdapter } from "../extensions/ssh-remote/adapters/index.ts";
import type { RemoteWorkspace } from "../extensions/ssh-remote/adapters/types.ts";
import { WindowsPowerShellAdapter } from "../extensions/ssh-remote/adapters/windows.ts";
import { OpenSshClient } from "../extensions/ssh-remote/client.ts";

/**
 * Integration tests for the SSH remote extension against a real Windows host
 * (OpenSSH + PowerShell 7 / Windows PowerShell 5.1).
 *
 * All tests are skipped unless PI_SSH_TEST_HOST names a reachable SSH target:
 *   PI_SSH_TEST_HOST=user@host        (default shell preference: auto)
 *   PI_SSH_TEST_HOST=user@host:path   (also selects the remote cwd)
 *   PI_SSH_TEST_SHELL=pwsh|powershell|auto   (optional, default: auto)
 */
const host = process.env.PI_SSH_TEST_HOST;

let client: OpenSshClient | undefined;
let adapter: WindowsPowerShellAdapter;
let workspace: RemoteWorkspace;
let probeError: string | undefined;
let root = "";

before(async () => {
  if (!host) {
    probeError = "PI_SSH_TEST_HOST is not set (set it to a Windows SSH target to run)";
    return;
  }
  client = new OpenSshClient({
    target: host,
    connectTimeoutSeconds: 8,
    batchMode: true,
  });
  try {
    const preference =
      process.env.PI_SSH_TEST_SHELL === "pwsh" ||
        process.env.PI_SSH_TEST_SHELL === "powershell" ||
        process.env.PI_SSH_TEST_SHELL === "bash"
        ? process.env.PI_SSH_TEST_SHELL
        : "auto";
    const selected = await selectRemoteAdapter(client, {
      localPlatform: "linux",
      preference,
    });
    adapter = selected.adapter as WindowsPowerShellAdapter;
    workspace = selected.workspace;
    root = `${workspace.home}\\pi-ssh-integration`;
    await adapter.runShell(
      `Remove-Item -Recurse -Force '${root}' -ErrorAction SilentlyContinue; exit 0`,
      workspace.cwd,
    );
    await adapter.mkdir(adapter.toToolPath(`${root}\\sub dir`, workspace));
  } catch (error) {
    probeError = error instanceof Error ? error.message : String(error);
  }
});

after(async () => {
  if (adapter && workspace && root) {
    try {
      await adapter.runShell(
        `Remove-Item -Recurse -Force '${root}' -ErrorAction SilentlyContinue; exit 0`,
        workspace.cwd,
      );
    } catch {
      // best-effort cleanup
    }
  }
  client?.dispose();
});

/** Skip the current test when no Windows SSH host is available. */
function requireHost(t: TestContext): boolean {
  if (!probeError) return true;
  t.skip(`Windows SSH integration host unavailable: ${probeError}`);
  return false;
}

const opts = { timeout: 60_000 };

const file1 = (): string => `${root}\\hello.txt`;
const file2 = (): string => `${root}\\sub dir\\中文 文件.txt`;

test("selects a Windows workspace with absolute home and cwd", opts, (t) => {
  if (!requireHost(t)) return;
  assert.equal(workspace.platform, "windows");
  assert.ok(workspace.shell === "pwsh" || workspace.shell === "powershell");
  assert.match(workspace.home, /^[A-Za-z]:\\/);
  assert.match(workspace.cwd, /^[A-Za-z]:\\/);
});

test("write/read round trip preserves unicode, CRLF, and binary content", opts, async (t) => {
  if (!requireHost(t)) return;
  const content = "Hello from integration\n第二行 中文内容\nline3\r\n";
  await adapter.writeFile(adapter.toToolPath(file1(), workspace), content);
  const readBack = (
    await adapter.readFile(adapter.toToolPath(file1(), workspace))
  ).toString("utf8");
  assert.equal(readBack, content);

  await adapter.writeFile(adapter.toToolPath(file2(), workspace), "中文文件名 ünïcode\n");
  const readBack2 = (
    await adapter.readFile(adapter.toToolPath(file2(), workspace))
  ).toString("utf8");
  assert.equal(readBack2, "中文文件名 ünïcode\n");

  const bin = Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0x80, 0x7f]);
  await adapter.writeFile(adapter.toToolPath(`${root}\\bin.dat`, workspace), bin);
  const binBack = await adapter.readFile(
    adapter.toToolPath(`${root}\\bin.dat`, workspace),
  );
  assert.ok(binBack.equals(bin));
});

test("fileExists and access report correct results", opts, async (t) => {
  if (!requireHost(t)) return;
  assert.equal(await adapter.fileExists(adapter.toToolPath(file1(), workspace)), true);
  assert.equal(
    await adapter.fileExists(adapter.toToolPath(`${root}\\missing.txt`, workspace)),
    false,
  );
  await adapter.access(adapter.toToolPath(file1(), workspace), "read");
  await adapter.access(adapter.toToolPath(file1(), workspace), "write");
});

test("listDirectory handles unicode names and directory entries", opts, async (t) => {
  if (!requireHost(t)) return;
  const entries = await adapter.listDirectory(
    adapter.toToolPath(`${root}\\sub dir`, workspace),
  );
  assert.ok(entries.some((e) => e.name === "中文 文件.txt"));
  const rootEntries = await adapter.listDirectory(
    adapter.toToolPath(root, workspace),
  );
  assert.ok(rootEntries.some((e) => e.isDirectory && e.name === "sub dir"));
});

test("findEntries matches globs and recurses into subdirectories", opts, async (t) => {
  if (!requireHost(t)) return;
  const found = await adapter.findEntries(
    adapter.toToolPath(root, workspace),
    "*.txt",
    50,
  );
  assert.ok(found.length >= 2);
  assert.ok(found.every((f) => f.path.endsWith(".txt")));
  const all = await adapter.findEntries(
    adapter.toToolPath(root, workspace),
    "*",
    100,
  );
  assert.ok(all.some((f) => f.path.includes("sub dir")));
});

test("grep supports literal, regex, glob, and single-file modes", opts, async (t) => {
  if (!requireHost(t)) return;
  const literal = await adapter.grep(adapter.toToolPath(root, workspace), "中文内容", {
    ignoreCase: true,
    literal: true,
    limit: 50,
  });
  assert.ok(
    literal.some((m) => m.path === "hello.txt" && m.lineNumber === 2),
  );

  const regex = await adapter.grep(adapter.toToolPath(root, workspace), "Hello|line3", {
    ignoreCase: false,
    literal: false,
    limit: 50,
  });
  assert.ok(regex.length >= 2);

  const glob = await adapter.grep(adapter.toToolPath(root, workspace), "中文文件名", {
    glob: "sub dir/*",
    literal: true,
    limit: 50,
  });
  assert.ok(glob.some((m) => m.path.startsWith("sub dir/")), JSON.stringify(glob));

  const single = await adapter.grep(adapter.toToolPath(file1(), workspace), "Hello", {
    limit: 10,
  });
  assert.equal(single.length, 1);
  assert.equal(single[0].lineNumber, 1);
});

test("runShell returns exit codes, streams stdout, and works without options", opts, async (t) => {
  if (!requireHost(t)) return;
  // No options argument: exercises the default-parameter fix.
  assert.equal(
    await adapter.runShell("Write-Output 'ok'", workspace.cwd),
    0,
  );
  assert.equal(await adapter.runShell("exit 3", workspace.cwd), 3);
  // PowerShell errors are terminating under EAP=Stop and surface as exit 1
  // with the message on stderr (the adapter's designed error model).
  assert.equal(await adapter.runShell("Write-Error 'boom'", workspace.cwd), 1);

  const chunks: string[] = [];
  const rc = await adapter.runShell(
    "1..50 | ForEach-Object { Write-Output \"line $_\" }",
    workspace.cwd,
    {
      captureOutput: false,
      onStdout: (d) => chunks.push(d.toString("utf8")),
    },
  );
  assert.equal(rc, 0);
  const lines = chunks.join("").split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 50);

  // Session env passthrough.
  const envResult = await adapter.runShell(
    "Get-ChildItem Env:PI_SESSION_ID | Select-Object -ExpandProperty Value",
    workspace.cwd,
    { env: { PI_SESSION_ID: "it-session-1" } },
  );
  assert.equal(envResult, 0);
});

test("runShell streams unicode output without corruption", opts, async (t) => {
  if (!requireHost(t)) return;
  const chunks: string[] = [];
  const rc = await adapter.runShell(
    "Write-Output '输出中文测试'",
    workspace.cwd,
    { captureOutput: false, onStdout: (d) => chunks.push(d.toString("utf8")) },
  );
  assert.equal(rc, 0);
  assert.ok(chunks.join("").includes("输出中文测试"));
});

test("long commands use the gzip transport and still run", opts, async (t) => {
  if (!requireHost(t)) return;
  const longCmd = `'${"x".repeat(7_000)}' | ForEach-Object { $_.Length }`;
  assert.equal(await adapter.runShell(longCmd, workspace.cwd), 0);
});

test("PowerShell stderr stays free of CLIXML progress noise", opts, async (t) => {
  if (!requireHost(t)) return;
  const result = await client!.run(
    adapter.buildShellCommand(
      "Get-ChildItem . | Select-Object -First 3 Name",
      workspace.cwd,
    ),
    { timeoutSeconds: 30 },
  );
  assert.equal(result.exitCode, 0);
  assert.ok(
    !result.stderr.toString("utf8").includes("CLIXML"),
    `stderr contained CLIXML noise: ${result.stderr.toString("utf8").slice(0, 200)}`,
  );
});

test("runShell aborts hung commands on timeout", opts, async (t) => {
  if (!requireHost(t)) return;
  const started = Date.now();
  await assert.rejects(
    adapter.runShell("Start-Sleep -Seconds 30", workspace.cwd, {
      timeoutSeconds: 5,
    }),
    /timeout:5/,
  );
  assert.ok(Date.now() - started < 20_000, "timeout did not abort promptly");
});
