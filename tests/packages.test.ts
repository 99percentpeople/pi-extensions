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

function assertBuiltExtensionPackage(packageJson: Record<string, any>): void {
  assert.deepEqual(packageJson.pi?.extensions, ["./dist/index.ts"]);
  assert.equal(
    packageJson.scripts?.build,
    "bun run ../../scripts/build-package.ts",
  );
  assert.equal(packageJson.scripts?.prepack, "bun run build");
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
  assert.equal(root.scripts?.build, "bun run build:all");
  assert.equal(
    root.scripts?.["build:all"],
    "bun run build:packages && bun run build:extensions",
  );
  assert.equal(
    root.scripts?.["build:packages"],
    "bun run --cwd packages/shared-settings build",
  );

  assert.equal(background.name, "@99percentpeople/pi-background-tasks");
  assert.equal(background.version, "1.2.5");
  assertBuiltExtensionPackage(background);
  assert.deepEqual(background.files, ["dist", "README.md", "LICENSE"]);
  assert.equal(background.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.2");
  assert.equal(background.dependencies?.["node-pty"], "1.2.0-beta.14");
  assert.equal(background.dependencies?.["@xterm/headless"], "6.0.0");
  assert.equal(background.publishConfig?.access, "public");

  assert.equal(codexApi.name, "@99percentpeople/pi-codex-api");
  assert.equal(codexApi.version, "0.1.4");
  assertBuiltExtensionPackage(codexApi);
  assert.deepEqual(codexApi.pi?.skills, ["./skills"]);
  assert.deepEqual(codexApi.files, [
    "dist",
    "skills",
    "README.md",
    "LICENSE",
  ]);
  assert.equal(codexApi.publishConfig?.access, "public");
  assert.equal(codexApi.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.2");
  assert.equal(codexApi.peerDependencies?.["@earendil-works/pi-tui"], "*");
  assert.match(codexApiSkill, /^---\nname: gpt-image-prompts\n/m);
  assert.match(codexApiSkill, /Craft and refine production-ready prompts for GPT Image 2/);
  assert.match(codexApiSkill, /prompt-writing skill only/);
  assert.doesNotMatch(codexApiSkill, /codex_search|codex_image|output_path|referenced_image_paths/);

  assert.equal(cursorEffect.name, "@99percentpeople/pi-cursor-effect");
  assert.equal(cursorEffect.version, "0.1.3");
  assertBuiltExtensionPackage(cursorEffect);
  assert.deepEqual(cursorEffect.files, ["dist", "README.md", "LICENSE"]);
  assert.equal(cursorEffect.publishConfig?.access, "public");
  assert.equal(cursorEffect.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.2");

  assert.equal(pwsh.name, "@99percentpeople/pi-pwsh-adapter");
  assert.equal(pwsh.version, "1.0.4");
  assertBuiltExtensionPackage(pwsh);
  assert.deepEqual(pwsh.files, ["dist", "README.md", "LICENSE"]);
  assert.deepEqual(pwsh.os, ["win32"]);
  assert.equal(
    pwsh.dependencies?.["@99percentpeople/pi-background-tasks"],
    undefined,
  );
  assert.equal(pwsh.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.2");
  assert.equal(pwsh.publishConfig?.access, "public");

  assert.equal(thinkingFold.name, "@99percentpeople/pi-thinking-fold");
  assert.equal(thinkingFold.version, "0.1.4");
  assertBuiltExtensionPackage(thinkingFold);
  assert.deepEqual(thinkingFold.files, ["dist", "README.md", "LICENSE"]);
  assert.deepEqual(thinkingFold.piBuild?.assets, ["model-behaviors.json"]);
  assert.equal(thinkingFold.publishConfig?.access, "public");
  assert.equal(thinkingFold.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.2");

  assert.equal(todo.name, "@99percentpeople/pi-todo");
  assert.equal(todo.version, "1.2.3");
  assertBuiltExtensionPackage(todo);
  assert.deepEqual(todo.files, ["dist", "README.md", "LICENSE"]);
  assert.equal(todo.publishConfig?.access, "public");
  assert.equal(todo.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.2");

  assert.equal(sharedSettings.name, "@99percentpeople/pi-shared-settings");
  assert.equal(sharedSettings.version, "0.1.2");
  assert.equal(sharedSettings.pi, undefined);
  assert.equal(sharedSettings.main, "./dist/index.ts");
  assert.equal(sharedSettings.types, "./dist/index.d.ts");
  assert.deepEqual(sharedSettings.files, ["dist", "README.md", "LICENSE"]);
  assert.equal(
    sharedSettings.scripts?.build,
    "bun run ../../scripts/build-package.ts && tsc -p tsconfig.build.json",
  );
  assert.equal(sharedSettings.scripts?.prepack, "bun run build");
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
