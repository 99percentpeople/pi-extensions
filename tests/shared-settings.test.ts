import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  readSettingsNamespace,
  registerExtensionSettings,
  SHARED_SETTINGS_COMMAND,
  writeSettingsNamespace,
} from "../packages/shared-settings/index.ts";
import { SectionedSettingsList } from "../packages/shared-settings/sectioned-settings-list.ts";

interface FakePiResult {
  pi: ExtensionAPI;
  commands: string[];
  shutdown(): Promise<void>;
}

function fakePi(): FakePiResult {
  const commands: string[] = [];
  const shutdownHandlers: Array<(event: { type: "session_shutdown" }, ctx: never) => unknown> = [];
  const pi = {
    registerCommand(name: string) {
      commands.push(name);
    },
    on(type: string, handler: (event: { type: "session_shutdown" }, ctx: never) => unknown) {
      if (type === "session_shutdown") shutdownHandlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    commands,
    async shutdown() {
      for (const handler of shutdownHandlers) {
        await handler({ type: "session_shutdown" }, undefined as never);
      }
    },
  };
}

test("all installed extensions share one /99settings command registration", async () => {
  const runtime = fakePi();
  registerExtensionSettings(runtime.pi, {
    namespace: "thinking-fold",
    title: "Thinking Fold",
    settings: () => [],
  });
  registerExtensionSettings(runtime.pi, {
    namespace: "cursor-effect",
    title: "Cursor Effect",
    settings: () => [],
  });
  assert.deepEqual(runtime.commands, [SHARED_SETTINGS_COMMAND]);

  await runtime.shutdown();
  const reloaded = fakePi();
  registerExtensionSettings(reloaded.pi, {
    namespace: "todo",
    title: "Todo",
    settings: () => [],
  });
  assert.deepEqual(reloaded.commands, [SHARED_SETTINGS_COMMAND]);
  await reloaded.shutdown();
});

test("shared settings preserve independent namespaces and unknown data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-shared-settings-"));
  const path = join(directory, "99extensions.json");
  try {
    await writeFile(path, '{"unknown":{"keep":true}}\n', "utf8");
    writeSettingsNamespace("cursor-effect", { style: "wave" }, path);
    writeSettingsNamespace(
      "thinking-fold",
      { mode: "summary", previewLines: 5, autoCollapse: true },
      path,
    );

    const document = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(document, {
      unknown: { keep: true },
      "cursor-effect": { style: "wave" },
      "thinking-fold": { mode: "summary", previewLines: 5, autoCollapse: true },
    });
    assert.deepEqual(
      readSettingsNamespace("cursor-effect", (value) => value, path),
      { style: "wave" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("section headers keep short labels and values in one visual column", () => {
  const list = new SectionedSettingsList(
    [
      {
        id: "cursor:style",
        section: "Cursor Effect",
        label: "Style",
        currentValue: "wave",
        values: ["wave", "none"],
      },
      {
        id: "thinking:mode",
        section: "Thinking Fold",
        label: "Reasoning behavior",
        currentValue: "auto",
        values: ["auto", "trace", "summary"],
      },
      {
        id: "thinking:lines",
        section: "Thinking Fold",
        label: "预览行数",
        currentValue: "5",
        values: ["3", "5"],
      },
    ],
    20,
    {
      cursor: "→ ",
      header: (text) => text,
      label: (text) => text,
      value: (text) => text,
      description: (text) => text,
      hint: (text) => text,
    },
    () => {},
    () => {},
  );

  const output = list.render(60);
  assert.ok(output.includes("  Cursor Effect"));
  assert.ok(output.includes("  Thinking Fold"));
  assert.equal(output.includes("installed"), false);

  const expectedValues = ["wave", "auto", "5"];
  const valueColumns = expectedValues.map((value) => {
    const line = output.find((candidate) => candidate.endsWith(value));
    assert.ok(line, `missing row value ${value}`);
    return visibleWidth(line.slice(0, line.lastIndexOf(value)));
  });
  assert.deepEqual(
    [...new Set(valueColumns)],
    [22],
    "ASCII and wide-character labels share one aligned value column",
  );
});

test("sectioned settings open submenus and restore the parent selection", () => {
  let closeChild: (() => void) | undefined;
  const child = new SectionedSettingsList(
    [{ id: "speed", section: "Loader Effect", label: "Speed", currentValue: "normal" }],
    5,
    {
      cursor: "→ ",
      header: (text) => text,
      label: (text) => text,
      value: (text) => text,
      description: (text) => text,
      hint: (text) => text,
    },
    () => {},
    () => closeChild?.(),
  );
  const parent = new SectionedSettingsList(
    [
      { id: "first", section: "Cursor Effect", label: "First", currentValue: "one" },
      {
        id: "loader",
        section: "Cursor Effect",
        label: "Loader effect",
        currentValue: "Claude Code",
        submenu: (_current, done) => {
          closeChild = () => done("Claude Code");
          return child;
        },
      },
    ],
    5,
    {
      cursor: "→ ",
      header: (text) => text,
      label: (text) => text,
      value: (text) => text,
      description: (text) => text,
      hint: (text) => text,
    },
    () => {},
    () => {},
  );

  parent.handleInput("\u001b[B");
  parent.handleInput("\r");
  assert.ok(parent.render(60).includes("  Loader Effect"));
  child.handleInput("\u001b");
  assert.ok(parent.render(60).some((line) => line.includes("→ Loader effect")));
});

test("long sectioned menus scroll across headers with a bounded row window", () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    id: `setting-${index + 1}`,
    section: index < 2 ? "Alpha" : index < 4 ? "Beta" : "Gamma",
    label: `Setting ${index + 1}`,
    currentValue: String(index + 1),
  }));
  const list = new SectionedSettingsList(
    rows,
    3,
    {
      cursor: "→ ",
      header: (text) => text,
      label: (text) => text,
      value: (text) => text,
      description: (text) => text,
      hint: (text) => text,
    },
    () => {},
    () => {},
  );

  const first = list.render(50);
  assert.ok(first.some((line) => line.includes("Setting 1")));
  assert.equal(first.some((line) => line.includes("Setting 6")), false);
  assert.ok(first.some((line) => line.includes("(1/6)")));

  for (let index = 0; index < 5; index += 1) list.handleInput("\u001b[B");
  const last = list.render(50);
  assert.equal(last.some((line) => line.includes("Setting 1")), false);
  assert.ok(last.includes("  Gamma"));
  assert.ok(last.some((line) => line.includes("→ Setting 6")));
  assert.ok(last.some((line) => line.includes("(6/6)")));
});

test("shared settings reject invalid namespaces", () => {
  assert.throws(
    () => readSettingsNamespace("../outside", (value) => value, "/tmp/unused"),
    /Invalid settings namespace/,
  );
});
