/**
 * Windows-local adapter smoke test: run this ON a Windows machine where Pi is
 * installed, against a Windows SSH target (use `localhost` with loopback auth
 * for a self-contained check). Exercises the Windows client's temp-file stdio
 * path (ssh.exe spawned with files instead of anonymous pipes).
 *
 * Usage: bun run e2e/local-windows-smoke.ts [host] [shell]
 *   host  SSH target (default: localhost)
 *   shell pwsh | powershell | auto (default: pwsh)
 * See e2e/README.md (scenario B) for the full manual e2e guide.
 */
import { OpenSshClient } from "../extensions/ssh-remote/client.ts";
import { WindowsPowerShellAdapter } from "../extensions/ssh-remote/adapters/windows.ts";

const host = process.argv[2] ?? "localhost";
const shell = (process.argv[3] ?? "pwsh") as "pwsh" | "powershell" | "auto";

const client = new OpenSshClient({
  target: host,
  executable: "ssh.exe",
  multiplex: false,
  connectTimeoutSeconds: 10,
  batchMode: true,
});
const adapter = new WindowsPowerShellAdapter(client, shell === "auto" ? "pwsh" : shell, "win32");

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name} (${Date.now() - t0}ms): ${String(e).slice(0, 120)}`);
  }
}

const ws = await adapter.inspectWorkspace();
console.log("workspace:", JSON.stringify(ws));
const root = `${ws.home}\\pi-ssh-win-local-smoke`;
const sub = `${root}\\sub dir`;

await check("mkdir", () => adapter.mkdir(adapter.toToolPath(sub, ws)));
const content = "win local 中文内容\r\nline2\n";
await check("writeFile", () => adapter.writeFile(adapter.toToolPath(`${sub}\\文件 ü.txt`, ws), content));
const readBack = await adapter.readFile(adapter.toToolPath(`${sub}\\文件 ü.txt`, ws));
await check("readFile roundtrip", async () => {
  if (readBack.toString("utf8") !== content) throw new Error("content mismatch");
});
const bin = Buffer.from([0, 1, 2, 255]);
await check("writeFile bin", () => adapter.writeFile(adapter.toToolPath(`${root}\\b.dat`, ws), bin));
const binBack = await adapter.readFile(adapter.toToolPath(`${root}\\b.dat`, ws));
await check("readFile bin", async () => {
  if (!binBack.equals(bin)) throw new Error("binary mismatch");
});
await check("fileExists", async () => {
  if (!(await adapter.fileExists(adapter.toToolPath(`${sub}\\文件 ü.txt`, ws)))) throw new Error("missing");
});
await check("access", () => adapter.access(adapter.toToolPath(`${sub}\\文件 ü.txt`, ws), "read"));
await check("listDirectory", async () => {
  const entries = await adapter.listDirectory(adapter.toToolPath(sub, ws));
  if (!entries.some((e) => e.name === "文件 ü.txt")) throw new Error("unicode entry missing");
});
await check("findEntries", async () => {
  const entries = await adapter.findEntries(adapter.toToolPath(root, ws), "*.txt", 50);
  if (entries.length < 1) throw new Error("no matches");
});
await check("grep", async () => {
  const matches = await adapter.grep(adapter.toToolPath(sub, ws), "中文内容", { literal: true, limit: 10 });
  if (matches.length !== 1) throw new Error(`matches=${matches.length}`);
});
await check("runShell", () => adapter.runShell("Write-Output 'shell-ok'", ws.cwd));
await check("runShell exit code", async () => {
  const rc = await adapter.runShell("exit 3", ws.cwd);
  if (rc !== 3) throw new Error(`rc=${rc}`);
});
await check("runShell streaming", async () => {
  const chunks: string[] = [];
  const rc = await adapter.runShell("1..50 | % { Write-Output \"l $_\" }", ws.cwd, {
    captureOutput: false,
    onStdout: (d) => chunks.push(d.toString("utf8")),
  });
  if (rc !== 0 || chunks.join("").split("\n").filter(Boolean).length !== 50) {
    throw new Error(`rc=${rc} lines=${chunks.length}`);
  }
});
await check("long gzip command", async () => {
  const rc = await adapter.runShell(`'${"y".repeat(7000)}'.Length`, ws.cwd);
  if (rc !== 0) throw new Error(`rc=${rc}`);
});
await check("cleanup", () =>
  adapter.runShell(`Remove-Item -Recurse -Force '${root}' -ErrorAction SilentlyContinue; exit 0`, ws.cwd));

client.dispose();
console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
process.exit(fail > 0 ? 1 : 0);
