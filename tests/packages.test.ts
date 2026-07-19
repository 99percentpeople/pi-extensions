import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createBgShellResolver,
  selectPowerShellRuntime,
} from "../extensions/pwsh-adapter/index.ts";

async function readPackage(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("extensions are independently publishable workspace packages", async () => {
  const root = await readPackage("../package.json");
  const background = await readPackage(
    "../extensions/background-tasks/package.json",
  );
  const pwsh = await readPackage("../extensions/pwsh-adapter/package.json");
  const todo = await readPackage("../extensions/todo/package.json");

  assert.equal(
    root.private,
    true,
    "the workspace root must never be published",
  );
  assert.equal(
    root.pi,
    undefined,
    "the workspace root must not aggregate Pi resources",
  );
  assert.deepEqual(root.workspaces, [
    "extensions/background-tasks",
    "extensions/pwsh-adapter",
    "extensions/todo",
  ]);

  assert.equal(background.name, "@99percentpeople/pi-background-tasks");
  assert.equal(background.version, "1.1.2");
  assert.deepEqual(background.pi?.extensions, ["./index.ts"]);
  assert.equal(background.dependencies?.["node-pty"], "1.1.0");
  assert.equal(background.dependencies?.["@xterm/headless"], "6.0.0");
  assert.equal(background.publishConfig?.access, "public");

  assert.equal(pwsh.name, "@99percentpeople/pi-pwsh-adapter");
  assert.equal(pwsh.version, "1.0.1");
  assert.deepEqual(pwsh.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(pwsh.os, ["win32"]);
  assert.equal(
    pwsh.dependencies?.["@99percentpeople/pi-background-tasks"],
    undefined,
  );
  assert.equal(pwsh.publishConfig?.access, "public");

  assert.equal(todo.name, "@99percentpeople/pi-todo");
  assert.equal(todo.version, "1.0.2");
  assert.deepEqual(todo.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(todo.files, [
    "index.ts",
    "state.ts",
    "README.md",
    "LICENSE",
  ]);
  assert.equal(todo.publishConfig?.access, "public");
  assert.equal(todo.dependencies, undefined);
});

test("PowerShell runtime prefers version 7 and falls back to Windows PowerShell 5.1", () => {
  const powerShell7 = selectPowerShellRuntime((file) =>
    file === "pwsh.exe" ? "7.5.2" : "5.1.26100.2161",
  );
  assert.equal(powerShell7.file, "pwsh.exe");
  assert.equal(powerShell7.kind, "powershell-7");
  assert.equal(powerShell7.label, "PowerShell 7.5.2");
  assert.equal(
    createBgShellResolver(powerShell7)("Write-Output pty", true).file,
    "pwsh.exe",
  );

  const windowsPowerShell = selectPowerShellRuntime((file) =>
    file === "pwsh.exe" ? null : "5.1.26100.2161",
  );
  assert.equal(windowsPowerShell.file, "powershell.exe");
  assert.equal(windowsPowerShell.kind, "windows-powershell");
  assert.equal(windowsPowerShell.label, "Windows PowerShell 5.1.26100.2161");

  const oldPwshFallback = selectPowerShellRuntime((file) =>
    file === "pwsh.exe" ? "6.2.7" : "5.1.19041.1",
  );
  assert.equal(oldPwshFallback.file, "powershell.exe");

  assert.throws(
    () => selectPowerShellRuntime(() => null),
    /No supported PowerShell runtime was found/,
  );

  const resolveShell = createBgShellResolver(windowsPowerShell);
  const pipe = resolveShell("Write-Output pipe", false);
  const pty = resolveShell("Write-Output pty", true);

  assert.equal(pipe.file, "powershell.exe");
  assert.equal(pty.file, "powershell.exe");
  assert.ok(pipe.args.includes("-NonInteractive"));
  assert.ok(!pty.args.includes("-NonInteractive"));
});
