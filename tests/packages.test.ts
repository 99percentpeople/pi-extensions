import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import type {
  BashOperations,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBgShellResolver,
  createPowerShellBashToolDefinition,
  selectPowerShellRuntime,
} from "../extensions/pwsh-adapter/index.ts";

async function readPackage(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

function assertSourceExtensionPackage(packageJson: Record<string, any>): void {
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.files, undefined);
  assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(packageJson.scripts, {
    build: "bun run ../../scripts/build-package.ts",
  });
}

async function listRelativeFiles(
  directory: URL,
  prefix = "",
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await listRelativeFiles(
        new URL(`${entry.name}/`, directory),
        `${relativePath}/`,
      ));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

test("extensions are independently publishable workspace packages", async () => {
  const root = await readPackage("../package.json");
  const background = await readPackage(
    "../extensions/background-tasks/package.json",
  );
  const codexApi = await readPackage("../extensions/codex-api/package.json");
  const cursorEffect = await readPackage("../extensions/cursor-effect/package.json");
  const pwsh = await readPackage("../extensions/pwsh-adapter/package.json");
  const sshRemote = await readPackage("../extensions/ssh-remote/package.json");
  const thinkingFold = await readPackage(
    "../extensions/thinking-fold/package.json",
  );
  const todo = await readPackage("../extensions/todo/package.json");
  const sharedSettings = await readPackage("../packages/shared-settings/package.json");
  const workspaceFiles = await readPackage("../packages/workspace-files/package.json");
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
    "extensions/ssh-remote",
    "extensions/thinking-fold",
    "extensions/todo",
    "packages/shared-settings",
    "packages/workspace-files",
  ]);
  assert.equal(root.scripts?.build, "bun run build:all");
  assert.equal(
    root.scripts?.["build:all"],
    "bun run clean:dist && bun run build:packages && bun run build:extensions",
  );
  assert.equal(root.scripts?.["clean:dist"], "bun run scripts/clean-build.ts");
  assert.match(root.scripts?.test, /^bun run build:all && /);
  assert.equal(
    root.scripts?.["build:packages"],
    "bun run --cwd packages/shared-settings build && bun run --cwd packages/workspace-files build",
  );

  assert.equal(background.name, "@99percentpeople/pi-background-tasks");
  assert.equal(background.version, "2.1.0");
  assertSourceExtensionPackage(background);
  assert.equal(background.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.3");
  assert.equal(background.dependencies?.["node-pty"], "1.2.0-beta.14");
  assert.equal(background.dependencies?.["@xterm/headless"], "6.0.0");
  assert.equal(background.publishConfig?.access, "public");

  assert.equal(codexApi.name, "@99percentpeople/pi-codex-api");
  assert.equal(codexApi.version, "0.2.9");
  assertSourceExtensionPackage(codexApi);
  assert.deepEqual(codexApi.pi?.skills, ["./skills"]);
  assert.deepEqual(codexApi.piBuild?.assets, ["skills"]);
  assert.equal(codexApi.publishConfig?.access, "public");
  assert.equal(codexApi.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.3");
  assert.equal(codexApi.dependencies?.["@99percentpeople/pi-workspace-files"], "0.1.1");
  assert.equal(codexApi.peerDependencies?.["@earendil-works/pi-tui"], "*");
  assert.match(codexApiSkill, /^---\nname: gpt-image-prompts\n/m);
  assert.match(codexApiSkill, /Craft and refine production-ready prompts for GPT Image 2/);
  assert.match(codexApiSkill, /prompt-writing skill only/);
  assert.doesNotMatch(codexApiSkill, /codex_search|codex_image|output_path|referenced_image_paths/);

  assert.equal(cursorEffect.name, "@99percentpeople/pi-cursor-effect");
  assert.equal(cursorEffect.version, "0.1.5");
  assertSourceExtensionPackage(cursorEffect);
  assert.equal(cursorEffect.publishConfig?.access, "public");
  assert.equal(cursorEffect.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.3");

  assert.equal(pwsh.name, "@99percentpeople/pi-pwsh-adapter");
  assert.equal(pwsh.version, "1.1.1");
  assertSourceExtensionPackage(pwsh);
  assert.deepEqual(pwsh.os, ["win32"]);
  assert.equal(
    pwsh.dependencies?.["@99percentpeople/pi-background-tasks"],
    undefined,
  );
  assert.equal(pwsh.dependencies?.["@99percentpeople/pi-shared-settings"], undefined);
  assert.equal(pwsh.publishConfig?.access, "public");

  assert.equal(sshRemote.name, "@99percentpeople/pi-ssh-remote");
  assert.equal(sshRemote.version, "0.5.5");
  assertSourceExtensionPackage(sshRemote);
  assert.equal(sshRemote.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.3");
  assert.equal(sshRemote.dependencies?.["@99percentpeople/pi-workspace-files"], "0.1.1");
  assert.equal(sshRemote.publishConfig?.access, "public");

  assert.equal(thinkingFold.name, "@99percentpeople/pi-thinking-fold");
  assert.equal(thinkingFold.version, "0.1.8");
  assertSourceExtensionPackage(thinkingFold);
  assert.deepEqual(thinkingFold.piBuild?.assets, ["model-behaviors.json"]);
  assert.equal(thinkingFold.publishConfig?.access, "public");
  assert.equal(thinkingFold.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.3");

  assert.equal(todo.name, "@99percentpeople/pi-todo");
  assert.equal(todo.version, "1.2.6");
  assertSourceExtensionPackage(todo);
  assert.equal(todo.publishConfig?.access, "public");
  assert.equal(todo.dependencies?.["@99percentpeople/pi-shared-settings"], "0.1.3");

  assert.equal(sharedSettings.name, "@99percentpeople/pi-shared-settings");
  assert.equal(sharedSettings.version, "0.1.3");
  assert.equal(sharedSettings.private, true);
  assert.equal(sharedSettings.pi, undefined);
  assert.equal(sharedSettings.main, "./index.ts");
  assert.equal(sharedSettings.types, "./index.ts");
  assert.equal(sharedSettings.files, undefined);
  assert.deepEqual(sharedSettings.scripts, {
    build: "bun run ../../scripts/build-package.ts",
  });
  assert.equal(sharedSettings.publishConfig?.access, "public");

  assert.equal(workspaceFiles.name, "@99percentpeople/pi-workspace-files");
  assert.equal(workspaceFiles.version, "0.1.1");
  assert.equal(workspaceFiles.private, true);
  assert.equal(workspaceFiles.pi, undefined);
  assert.equal(workspaceFiles.main, "./index.ts");
  assert.equal(workspaceFiles.types, "./index.ts");
  assert.equal(workspaceFiles.files, undefined);
  assert.deepEqual(workspaceFiles.scripts, {
    build: "bun run ../../scripts/build-package.ts",
  });
  assert.equal(workspaceFiles.publishConfig?.access, "public");
});

test("root dist contains complete minified publish staging packages", async () => {
  const packages = [
    { slug: "background-tasks", source: "extensions/background-tasks", extension: true },
    { slug: "codex-api", source: "extensions/codex-api", extension: true },
    { slug: "cursor-effect", source: "extensions/cursor-effect", extension: true },
    { slug: "pwsh-adapter", source: "extensions/pwsh-adapter", extension: true },
    { slug: "ssh-remote", source: "extensions/ssh-remote", extension: true },
    { slug: "thinking-fold", source: "extensions/thinking-fold", extension: true },
    { slug: "todo", source: "extensions/todo", extension: true },
    { slug: "shared-settings", source: "packages/shared-settings", extension: false },
    { slug: "workspace-files", source: "packages/workspace-files", extension: false },
  ] as const;
  const buildScript = await readFile(
    new URL("../scripts/build-package.ts", import.meta.url),
    "utf8",
  );

  assert.match(buildScript, /packages: "external"/);
  assert.match(buildScript, /naming: "\[name\]\.min\.\[ext\]"/);
  assert.match(buildScript, /sourcemap: "linked"/);
  assert.match(buildScript, /minify: true/);

  for (const packageInfo of packages) {
    const source = await readPackage(`../${packageInfo.source}/package.json`);
    const stageDirectory = new URL(`../dist/${packageInfo.slug}/`, import.meta.url);
    const stage = await readPackage(`../dist/${packageInfo.slug}/package.json`);
    const actualFiles = await listRelativeFiles(stageDirectory);
    const publishedFiles = actualFiles.filter((file) => file !== "package.json");
    const jsFiles = actualFiles.filter((file) => file.endsWith(".js"));
    const sourceMaps = actualFiles.filter((file) => file.endsWith(".js.map"));
    const runtime = await readFile(new URL("index.min.js", stageDirectory), "utf8");
    const sourceMap = JSON.parse(
      await readFile(new URL("index.min.js.map", stageDirectory), "utf8"),
    ) as { sources?: string[]; sourcesContent?: Array<string | null> };

    assert.equal(stage.name, source.name);
    assert.equal(stage.version, source.version);
    assert.equal(stage.private, undefined);
    assert.equal(stage.scripts, undefined);
    assert.equal(stage.piBuild, undefined);
    assert.deepEqual(stage.files, publishedFiles);
    assert.deepEqual(jsFiles, ["index.min.js"]);
    assert.deepEqual(sourceMaps, ["index.min.js.map"]);
    assert.ok(actualFiles.includes("README.md"));
    assert.ok(actualFiles.includes("LICENSE"));
    assert.match(runtime, /\/\/# sourceMappingURL=index\.min\.js\.map/);
    assert.doesNotMatch(runtime, /(?:from|import\()["'][^"']+\.ts["']/);
    assert.ok((sourceMap.sources?.length ?? 0) > 0);
    assert.equal(sourceMap.sourcesContent?.length, sourceMap.sources?.length);
    for (const sourcePath of sourceMap.sources ?? []) {
      assert.ok(!sourcePath.startsWith("/"), `absolute source-map path: ${sourcePath}`);
      assert.doesNotMatch(sourcePath, /^[A-Za-z]:[\\/]/);
    }
    await assert.rejects(
      access(new URL(`../${packageInfo.source}/dist/`, import.meta.url)),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );

    if (packageInfo.extension) {
      assert.deepEqual(stage.pi?.extensions, ["./index.min.js"]);
      assert.equal(stage.main, undefined);
      assert.equal(stage.types, undefined);
      assert.match(runtime, /@earendil-works\//);
      assert.equal(actualFiles.some((file) => file.endsWith(".d.ts")), false);
      const extensionModule = await import(
        `${new URL("index.min.js", stageDirectory).href}?package-test=${packageInfo.slug}`
      );
      assert.equal(typeof extensionModule.default, "function");
    } else {
      assert.equal(stage.pi, undefined);
      assert.equal(stage.main, "./index.min.js");
      assert.equal(stage.types, "./index.d.ts");
      assert.ok(actualFiles.includes("index.d.ts"));
    }
  }

  const codexStage = await readPackage("../dist/codex-api/package.json");
  const thinkingStage = await readPackage("../dist/thinking-fold/package.json");
  const sharedStageFiles = await listRelativeFiles(
    new URL("../dist/shared-settings/", import.meta.url),
  );
  assert.deepEqual(codexStage.pi?.skills, ["./skills"]);
  assert.ok(
    (codexStage.files as string[]).includes("skills/gpt-image-prompts/SKILL.md"),
  );
  assert.ok((thinkingStage.files as string[]).includes("model-behaviors.json"));
  assert.ok(sharedStageFiles.includes("sectioned-settings-list.d.ts"));
});

test("PowerShell bash tool preserves Pi's built-in timeout and output behavior", async () => {
  const runtime = {
    file: "pwsh.exe",
    kind: "powershell-7" as const,
    version: "7.5.2",
    label: "PowerShell 7.5.2",
  };
  let captured: {
    command?: string;
    cwd?: string;
    timeout?: number;
  } = {};
  const operations: BashOperations = {
    async exec(command, cwd, options) {
      captured = { command, cwd, timeout: options.timeout };
      options.onData(Buffer.from("PowerShell output\n"));
      return { exitCode: 0 };
    },
  };
  const definition = createPowerShellBashToolDefinition(
    runtime,
    "C:\\workspace",
    operations,
  );
  const properties = (definition.parameters as any).properties;
  assert.match(properties.timeout.description, /no default timeout/i);
  assert.match(definition.description, /Output is truncated/);
  assert.match(definition.description, /Optionally provide a timeout/);
  assert.equal(typeof definition.renderCall, "function");
  assert.equal(typeof definition.renderResult, "function");

  const ctx = {
    model: undefined,
    thinkingLevel: "off",
    sessionManager: {
      getSessionId: () => "session-id",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext;
  const result = await definition.execute(
    "pwsh-call",
    { command: "Get-Location", timeout: 7 },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(captured, {
    command: "Get-Location",
    cwd: "C:\\workspace",
    timeout: 7,
  });
  assert.equal(result.content[0].text, "PowerShell output\n");

  const timeoutDefinition = createPowerShellBashToolDefinition(
    runtime,
    "C:\\workspace",
    {
      async exec(_command, _cwd, options) {
        options.onData(Buffer.from("partial output"));
        throw new Error("timeout:2");
      },
    },
  );
  await assert.rejects(
    () => timeoutDefinition.execute(
      "pwsh-timeout",
      { command: "Start-Sleep 10", timeout: 2 },
      undefined,
      undefined,
      ctx,
    ),
    /partial output\n\nCommand timed out after 2 seconds/,
  );
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
