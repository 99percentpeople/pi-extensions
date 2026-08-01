/**
 * End-to-end smoke test for the SSH remote extension against a real Windows
 * host. Exercises the WindowsPowerShellAdapter over a live OpenSSH connection:
 * probing, read/write (unicode + binary), ls, find, grep, runShell, long
 * command gzip transport, timeouts, and path encoding round trips.
 *
 * Usage: bun run e2e/remote-windows-smoke.ts <host> [shell]
 * See e2e/README.md for full documentation.
 */
import { OpenSshClient } from "../extensions/ssh-remote/client.ts";
import {
  buildPowerShellInvocation,
  decodeWindowsToolPath,
  encodeWindowsToolPath,
  WindowsPowerShellAdapter,
} from "../extensions/ssh-remote/adapters/windows.ts";
import { selectRemoteAdapter } from "../extensions/ssh-remote/adapters/index.ts";

const host = process.argv[2] ?? process.env.PI_SSH_TEST_HOST;
const shellPref = (process.argv[3] ?? "auto") as
  | "auto"
  | "pwsh"
  | "powershell"
  | "bash";

if (!host) {
  console.error(
    "Usage: bun run e2e/remote-windows-smoke.ts <host> [shell]\n" +
      "  host  SSH target from ~/.ssh/config or host:path\n" +
      "  shell auto | pwsh | powershell | bash (default: auto)\n" +
      "Alternatively set PI_SSH_TEST_HOST.",
  );
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(
      `FAIL  ${name}${detail !== undefined ? `\n      detail: ${JSON.stringify(detail)}` : ""}`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`== targeting ${host}, shell preference: ${shellPref} ==`);
  const client = new OpenSshClient({
    target: host,
    connectTimeoutSeconds: 10,
    batchMode: true,
  });

  // --- path encoding round trips ---
  console.log("\n-- path encode/decode round trip --");
  const samples = [
    "C:\\Users\\dev\\π 测试\\file ü.txt",
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "\\\\server\\share\\dir\\file.txt",
    "C:\\",
  ];
  for (const s of samples) {
    try {
      const enc = encodeWindowsToolPath(s, "linux");
      const dec = decodeWindowsToolPath(enc);
      check(`roundtrip ${JSON.stringify(s)}`, dec === s, { enc, dec });
    } catch (e) {
      check(`roundtrip ${JSON.stringify(s)}`, false, String(e));
    }
  }
  const encLocal = encodeWindowsToolPath("C:\\Users\\dev\\a b.txt", "win32");
  check(
    "win32-local encoding",
    encLocal.startsWith("C:\\__pi_ssh_remote_windows__"),
    encLocal,
  );
  check(
    "win32-local decode",
    decodeWindowsToolPath(encLocal) === "C:\\Users\\dev\\a b.txt",
    decodeWindowsToolPath(encLocal),
  );

  // --- select adapter (auto probe) ---
  console.log("\n-- selectRemoteAdapter --");
  let selected: Awaited<ReturnType<typeof selectRemoteAdapter>>;
  try {
    selected = await selectRemoteAdapter(client, {
      localPlatform: "linux",
      preference: shellPref,
    });
    check(
      `selected ${selected.workspace.shell}`,
      selected.workspace.platform === "windows",
      selected.workspace,
    );
  } catch (e) {
    check("select adapter", false, String(e));
    return;
  }
  const adapter = selected.adapter as WindowsPowerShellAdapter;
  const ws = selected.workspace;
  console.log("  workspace:", ws);

  check("home is absolute", /^[A-Za-z]:\\/.test(ws.home), ws.home);
  check("cwd is absolute", /^[A-Za-z]:\\/.test(ws.cwd), ws.cwd);

  const testRoot = `${ws.home}\\pi-ssh-test`;
  const subDir = `${testRoot}\\sub dir`;
  const file1 = `${testRoot}\\hello.txt`;
  const file2 = `${subDir}\\中文 文件.txt`;

  // --- mkdir / write / read ---
  console.log("\n-- write/read --");
  try {
    await adapter.mkdir(adapter.toToolPath(testRoot, ws));
    await adapter.mkdir(adapter.toToolPath(subDir, ws));
    check("mkdir", true);

    const content = "Hello from SSH remote test\n第二行 中文内容\nline3\r\n";
    await adapter.writeFile(adapter.toToolPath(file1, ws), content);
    check("writeFile", true);

    const readBack = (
      await adapter.readFile(adapter.toToolPath(file1, ws))
    ).toString("utf8");
    check("readFile roundtrip", readBack === content, readBack);

    await adapter.writeFile(
      adapter.toToolPath(file2, ws),
      "中文文件名内容 ünïcode\n",
    );
    const readBack2 = (
      await adapter.readFile(adapter.toToolPath(file2, ws))
    ).toString("utf8");
    check("unicode filename read", readBack2 === "中文文件名内容 ünïcode\n", readBack2);

    const bin = Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0x80, 0x7f]);
    await adapter.writeFile(adapter.toToolPath(`${testRoot}\\bin.dat`, ws), bin);
    const binBack = await adapter.readFile(
      adapter.toToolPath(`${testRoot}\\bin.dat`, ws),
    );
    check("binary roundtrip", binBack.equals(bin), binBack);
  } catch (e) {
    check("write/read", false, String(e));
  }

  // --- fileExists / access ---
  console.log("\n-- exists/access --");
  try {
    check(
      "exists hello.txt",
      await adapter.fileExists(adapter.toToolPath(file1, ws)),
    );
    check(
      "!exists missing",
      !(await adapter.fileExists(
        adapter.toToolPath(`${testRoot}\\nope.txt`, ws),
      )),
    );
    await adapter.access(adapter.toToolPath(file1, ws), "read");
    check("access read", true);
    await adapter.access(adapter.toToolPath(file1, ws), "write");
    check("access write", true);
  } catch (e) {
    check("exists/access", false, String(e));
  }

  // --- listDirectory ---
  console.log("\n-- listDirectory --");
  try {
    const entries = await adapter.listDirectory(adapter.toToolPath(subDir, ws));
    const names = entries
      .map((e) => `${e.isDirectory ? "D" : "F"} ${e.name}`)
      .sort();
    console.log("  entries:", names);
    check("unicode name listed", names.includes("F 中文 文件.txt"), names);
    const rootEntries = await adapter.listDirectory(
      adapter.toToolPath(testRoot, ws),
    );
    check(
      "dir entry",
      rootEntries.some((e) => e.isDirectory && e.name === "sub dir"),
      rootEntries,
    );
  } catch (e) {
    check("listDirectory", false, String(e));
  }

  // --- findEntries ---
  console.log("\n-- findEntries --");
  try {
    const found = await adapter.findEntries(
      adapter.toToolPath(testRoot, ws),
      "*.txt",
      50,
    );
    console.log("  found:", found);
    check(
      "find *.txt",
      found.length >= 2 && found.every((f) => f.path.endsWith(".txt")),
      found,
    );
    const all = await adapter.findEntries(
      adapter.toToolPath(testRoot, ws),
      "*",
      100,
    );
    check(
      "find * includes subdir files",
      all.some((f) => f.path.includes("sub dir")),
      all,
    );
  } catch (e) {
    check("findEntries", false, String(e));
  }

  // --- grep ---
  console.log("\n-- grep --");
  try {
    const matches = await adapter.grep(
      adapter.toToolPath(testRoot, ws),
      "中文内容",
      { ignoreCase: true, literal: true, limit: 50 },
    );
    console.log("  literal match:", matches);
    check(
      "grep literal unicode",
      matches.some((m) => m.path === "hello.txt" && m.lineNumber === 2),
      matches,
    );

    const regex = await adapter.grep(
      adapter.toToolPath(testRoot, ws),
      "Hello|line3",
      { ignoreCase: false, literal: false, limit: 50 },
    );
    check("grep regex", regex.length >= 2, regex);

    const glob = await adapter.grep(
      adapter.toToolPath(testRoot, ws),
      "内容",
      { glob: "sub dir/*", literal: true, limit: 50 },
    );
    check("grep glob sub dir", glob.some((m) => m.path.startsWith("sub dir/")), glob);

    const single = await adapter.grep(
      adapter.toToolPath(file1, ws),
      "Hello",
      { limit: 10 },
    );
    check("grep single file", single.length === 1 && single[0].lineNumber === 1, single);
  } catch (e) {
    check("grep", false, String(e));
  }

  // --- runShell (bash tool path) ---
  console.log("\n-- runShell --");
  try {
    // No options argument: exercises the default-parameter fix.
    const rc = await adapter.runShell(
      "Write-Output 'hello from pwsh'; $env:PI_SESSION_ID = 'abc123'; Get-ChildItem Env:PI_SESSION_ID | Select-Object -ExpandProperty Value",
      ws.cwd,
    );
    check("runShell exit 0 (no options)", rc === 0, rc);

    const rcFail = await adapter.runShell("exit 3", ws.cwd);
    check("runShell propagates explicit exit code", rcFail === 3, rcFail);
    // PowerShell errors are terminating under EAP=Stop: exit 1 with the
    // message on stderr (the adapter's designed error model).
    const rcErr = await adapter.runShell("Write-Error 'boom'", ws.cwd);
    check("runShell surfaces errors as exit 1", rcErr === 1, rcErr);

    const chunks: string[] = [];
    await adapter.runShell(
      "1..100 | ForEach-Object { Write-Output \"line $_\" }",
      ws.cwd,
      {
        captureOutput: false,
        onStdout: (d) => chunks.push(d.toString("utf8")),
      },
    );
    check(
      "streamed output",
      chunks.join("").split("\n").filter((l) => l.trim()).length === 100,
      chunks.length,
    );

    const interactiveCmd = adapter.buildShellCommand(
      "Write-Output 'interactive'",
      ws.cwd,
      undefined,
      true,
    );
    check(
      "interactive invocation has no -NonInteractive",
      !interactiveCmd.includes(" -NonInteractive"),
      interactiveCmd.slice(0, 80),
    );
  } catch (e) {
    check("runShell", false, String(e));
  }

  // --- long command (gzip transport path) ---
  console.log("\n-- long command gzip --");
  try {
    const longCmd = `'${"x".repeat(7000)}' | ForEach-Object { $_.Length }`;
    const rc = await adapter.runShell(longCmd, ws.cwd);
    check("long command runs", rc === 0, rc);
  } catch (e) {
    check("long command gzip", false, String(e));
  }

  // --- stderr cleanliness on PowerShell 5.1 (ProgressPreference fix) ---
  console.log("\n-- stderr noise --");
  try {
    const r = await client.run(
      adapter.buildShellCommand(
        "Get-ChildItem . | Select-Object -First 3 Name",
        ws.cwd,
      ),
      { timeoutSeconds: 30 },
    );
    const stderr = r.stderr.toString("utf8");
    check("no CLIXML progress noise on stderr", !stderr.includes("CLIXML"), stderr.slice(0, 120));
  } catch (e) {
    check("stderr noise", false, String(e));
  }

  // --- misc ---
  console.log("\n-- misc --");
  check(
    "png mime",
    (await adapter.detectImageMimeType(adapter.toToolPath(`${testRoot}\\x.png`, ws))) ===
      "image/png",
  );
  check(
    "unknown mime",
    (await adapter.detectImageMimeType(adapter.toToolPath(`${testRoot}\\x.xyz`, ws))) ===
      null,
  );

  // --- buildPowerShellInvocation size guard for incompressible scripts ---
  try {
    // Incompressible random data well over the 7500-char encoded limit.
    const huge = Array.from({ length: 12_000 }, () =>
      Math.random().toString(36).slice(2),
    ).join("");
    buildPowerShellInvocation("pwsh", huge);
    check("huge incompressible script rejected", false);
  } catch (e) {
    check(
      "huge incompressible script rejected (>7500)",
      /command-line limit/.test(String(e)),
      String(e).slice(0, 100),
    );
  }

  // --- cleanup ---
  try {
    await adapter.runShell(
      `Remove-Item -Recurse -Force '${testRoot}' -ErrorAction SilentlyContinue; exit 0`,
      ws.cwd,
    );
  } catch {}

  client.dispose();
  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
