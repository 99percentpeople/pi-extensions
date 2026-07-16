import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function readPackage(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("extensions are independently publishable workspace packages", async () => {
  const root = await readPackage("../package.json");
  const background = await readPackage("../extensions/background-tasks/package.json");
  const pwsh = await readPackage("../extensions/pwsh-adapter/package.json");

  assert.equal(root.private, true, "the workspace root must never be published");
  assert.equal(root.pi, undefined, "the workspace root must not aggregate Pi resources");
  assert.deepEqual(root.workspaces, [
    "extensions/background-tasks",
    "extensions/pwsh-adapter",
  ]);

  assert.equal(background.name, "@99percentpeople/pi-background-tasks");
  assert.deepEqual(background.pi?.extensions, ["./index.ts"]);
  assert.equal(background.dependencies?.["node-pty"], "1.1.0");
  assert.equal(background.dependencies?.["@xterm/headless"], "6.0.0");
  assert.equal(background.publishConfig?.access, "public");

  assert.equal(pwsh.name, "@99percentpeople/pi-pwsh-adapter");
  assert.deepEqual(pwsh.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(pwsh.os, ["win32"]);
  assert.equal(pwsh.dependencies?.["@99percentpeople/pi-background-tasks"], undefined);
  assert.equal(pwsh.publishConfig?.access, "public");
});
