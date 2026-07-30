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
  const codexApi = await readPackage("../extensions/codex-api/package.json");
  const cursorEffect = await readPackage("../extensions/cursor-effect/package.json");
  const pwsh = await readPackage("../extensions/pwsh-adapter/package.json");
  const thinkingFold = await readPackage(
    "../extensions/thinking-fold/package.json",
  );
  const todo = await readPackage("../extensions/todo/package.json");
  const sharedSettings = await readPackage("../packages/shared-settings/package.json");
  const codexApiSkill = await readFile(
    new URL("../extensions/codex-api/skills/gpt-image-prompts/SKILL.md", import.meta.url),
    "utf8",
  );

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
    "extensions/codex-api",
    "extensions/cursor-effect",
    "extensions/pwsh-adapter",
    "extensions/thinking-fold",
    "extensions/todo",
    "packages/shared-settings",
  ]);

  assert.equal(background.name, "@99percentpeople/pi-background-tasks");
  assert.equal(background.version, "1.2.3");
  assert.deepEqual(background.pi?.extensions, ["./index.ts"]);
  assert.equal(background.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.0");
  assert.equal(background.dependencies?.["node-pty"], "1.2.0-beta.14");
  assert.equal(background.dependencies?.["@xterm/headless"], "6.0.0");
  assert.equal(background.publishConfig?.access, "public");

  assert.equal(codexApi.name, "@99percentpeople/pi-codex-api");
  assert.equal(codexApi.version, "0.1.1");
  assert.deepEqual(codexApi.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(codexApi.pi?.skills, ["./skills"]);
  assert.deepEqual(codexApi.files, [
    "index.ts",
    "client.ts",
    "config.ts",
    "image.ts",
    "render.ts",
    "search-display.ts",
    "search.ts",
    "settings.ts",
    "usage.ts",
    "skills",
    "README.md",
    "LICENSE",
  ]);
  assert.equal(codexApi.publishConfig?.access, "public");
  assert.equal(codexApi.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.0");
  assert.equal(codexApi.peerDependencies?.["@earendil-works/pi-tui"], "*");
  assert.match(codexApiSkill, /^---\nname: gpt-image-prompts\n/m);
  assert.match(codexApiSkill, /Craft and refine production-ready prompts for GPT Image 2/);
  assert.match(codexApiSkill, /prompt-writing skill only/);
  assert.doesNotMatch(codexApiSkill, /codex_search|codex_image|output_path|referenced_image_paths/);

  assert.equal(cursorEffect.name, "@99percentpeople/pi-cursor-effect");
  assert.equal(cursorEffect.version, "0.1.1");
  assert.deepEqual(cursorEffect.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(cursorEffect.files, [
    "index.ts",
    "config.ts",
    "runtime-patch.ts",
    "settings.ts",
    "effects",
    "README.md",
    "LICENSE",
  ]);
  assert.equal(cursorEffect.publishConfig?.access, "public");
  assert.equal(cursorEffect.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.0");

  assert.equal(pwsh.name, "@99percentpeople/pi-pwsh-adapter");
  assert.equal(pwsh.version, "1.0.2");
  assert.deepEqual(pwsh.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(pwsh.os, ["win32"]);
  assert.equal(
    pwsh.dependencies?.["@99percentpeople/pi-background-tasks"],
    undefined,
  );
  assert.equal(pwsh.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.0");
  assert.equal(pwsh.publishConfig?.access, "public");

  assert.equal(thinkingFold.name, "@99percentpeople/pi-thinking-fold");
  assert.equal(thinkingFold.version, "0.1.2");
  assert.deepEqual(thinkingFold.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(thinkingFold.files, [
    "index.ts",
    "renderer.ts",
    "config.ts",
    "model-behaviors.ts",
    "model-behaviors.json",
    "README.md",
    "LICENSE",
  ]);
  assert.equal(thinkingFold.publishConfig?.access, "public");
  assert.equal(thinkingFold.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.0");

  assert.equal(todo.name, "@99percentpeople/pi-todo");
  assert.equal(todo.version, "1.2.1");
  assert.deepEqual(todo.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(todo.files, [
    "index.ts",
    "state.ts",
    "README.md",
    "LICENSE",
  ]);
  assert.equal(todo.publishConfig?.access, "public");
  assert.equal(todo.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.0");

  assert.equal(sharedSettings.name, "@99percentpeople/pi-shared-settings");
  assert.equal(sharedSettings.version, "0.1.0");
  assert.equal(sharedSettings.pi, undefined);
  assert.deepEqual(sharedSettings.files, [
    "index.ts",
    "sectioned-settings-list.ts",
    "README.md",
    "LICENSE",
  ]);
  assert.equal(sharedSettings.publishConfig?.access, "public");
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
