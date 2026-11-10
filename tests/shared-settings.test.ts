import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, isFocusable, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import {
  readSettingsNamespace,
  registerExtensionSettings,
  SHARED_SETTINGS_COMMAND,
  writeSettingsNamespace,
} from "../packages/shared-settings/index.ts";
import {
  SectionedSettingsList,
  type SectionedSettingRow,
  type SectionedSettingsListTheme,
} from "../packages/shared-settings/sectioned-settings-list.ts";

interface FakePiResult {
  pi: ExtensionAPI;
  commands: string[];
  commandHandlers: Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>;
  shutdown(): Promise<void>;
}

function fakePi(): FakePiResult {
  const commands: string[] = [];
  const commandHandlers: FakePiResult["commandHandlers"] = new Map();
  const shutdownHandlers: Array<(event: { type: "session_shutdown" }, ctx: never) => unknown> = [];
  const pi = {
    registerCommand(name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) {
      commands.push(name);
      commandHandlers.set(name, options.handler);
    },
    on(type: string, handler: (event: { type: "session_shutdown" }, ctx: never) => unknown) {
      if (type === "session_shutdown") shutdownHandlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    commands,
    commandHandlers,
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
      { foldThreshold: 5, streamingBehavior: "preview", completedBehavior: "collapse" },
      path,
    );

    const document = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(document, {
      unknown: { keep: true },
      "cursor-effect": { style: "wave" },
      "thinking-fold": {
        foldThreshold: 5,
        streamingBehavior: "preview",
        completedBehavior: "collapse",
      },
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
        id: "thinking:threshold",
        section: "Thinking Fold",
        label: "Fold after lines",
        currentValue: "5",
        values: ["3", "5"],
      },
      {
        id: "thinking:completed",
        section: "Thinking Fold",
        label: "After thinking",
        currentValue: "collapse",
        values: ["collapse", "preview", "full"],
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

  const expectedValues = ["wave", "5", "collapse"];
  const valueColumns = expectedValues.map((value) => {
    const line = output.find((candidate) => candidate.endsWith(value));
    assert.ok(line, `missing row value ${value}`);
    return visibleWidth(line.slice(0, line.lastIndexOf(value)));
  });
  assert.deepEqual(
    [...new Set(valueColumns)],
    [20],
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

const searchTheme: SectionedSettingsListTheme = {
  cursor: "→ ",
  header: (text) => text,
  label: (text) => text,
  value: (text) => text,
  description: (text) => text,
  hint: (text) => text,
};

function searchRows(): SectionedSettingRow[] {
  return [
    { id: "alpha:first", section: "Alpha", label: "First", currentValue: "off", values: ["off", "on"] },
    { id: "beta:speed", section: "Beta", label: "Speed", currentValue: "normal", values: ["normal", "fast"] },
    { id: "beta:style", section: "Beta", label: "Style", description: "Choose animation", currentValue: "wave", values: ["wave", "none"] },
    { id: "gamma:color", section: "Gamma", label: "Color", currentValue: "blue" },
  ];
}

function renderedRows(list: SectionedSettingsList): string[] {
  return list.render(100).filter((line) => line.startsWith("→ ") || /^  (First|Speed|Style|Color)\s/.test(line));
}

test("settings search matches plugin names, labels, and descriptions without reordering groups", () => {
  const list = new SectionedSettingsList(searchRows(), 10, searchTheme, () => {}, () => {});
  assert.equal(renderedRows(list).length, 4);
  assert.ok(list.render(100).some((line) => line.includes("Type to search")));

  list.handleInput("BETA");
  assert.deepEqual(renderedRows(list).map((line) => line.trim().split(/\s+/).slice(-1)[0]), ["normal", "wave"]);
  assert.ok(list.render(100).includes("  Beta"));
  assert.ok(!list.render(100).includes("  Alpha"));
  assert.ok(!list.render(100).includes("  Gamma"));

  list.handleInput("\u0015"); // Ctrl+U clears the query.
  list.handleInput("spd"); // Non-contiguous fuzzy match.
  assert.equal(renderedRows(list).length, 1);
  assert.ok(renderedRows(list)[0]?.startsWith("→ Speed"));

  list.handleInput("\u0015");
  list.handleInput("animation");
  assert.equal(renderedRows(list).length, 1);
  assert.ok(renderedRows(list)[0]?.startsWith("→ Style"));

  list.handleInput("\u0015");
  list.handleInput("a");
  assert.deepEqual(list.render(100).filter((line) => ["  Alpha", "  Beta", "  Gamma"].includes(line)), ["  Alpha", "  Beta", "  Gamma"]);
});

test("search navigation and changes use filtered row IDs, with Pi-compatible space behavior", () => {
  const changes: string[] = [];
  const list = new SectionedSettingsList(searchRows(), 10, searchTheme, (id, value) => changes.push(`${id}=${value}`), () => {});
  list.handleInput(" ");
  assert.deepEqual(changes, ["alpha:first=on"]);

  list.handleInput("beta");
  list.handleInput(" "); // Search text, not an option change.
  list.handleInput("style");
  assert.equal(renderedRows(list).length, 1);
  list.handleInput("\r");
  assert.deepEqual(changes, ["alpha:first=on", "beta:style=none"]);

  list.handleInput("\u0015");
  list.handleInput("beta");
  list.handleInput("\u001b[A"); // Wrap to the last filtered row.
  assert.ok(renderedRows(list).some((line) => line.startsWith("→ Style")));
  list.handleInput("\u001b[B"); // Wrap back to the first.
  list.handleInput("\r");
  assert.equal(changes.at(-1), "beta:speed=fast");

  list.handleInput("\u001b[B");
  list.handleInput("\u001b[D"); // Editing cursor movement must not reset selection.
  assert.ok(renderedRows(list).some((line) => line.startsWith("→ Style")));
});

test("unmatched queries are safe and Backspace restores results; Escape still cancels", () => {
  let changed = false;
  let cancelled = false;
  const list = new SectionedSettingsList(searchRows(), 10, searchTheme, () => { changed = true; }, () => { cancelled = true; });
  list.handleInput("zzzzzz");
  assert.ok(list.render(100).includes("  No matching settings"));
  for (const input of ["\u001b[A", "\u001b[B", "\r", " "]) list.handleInput(input);
  assert.equal(changed, false);
  assert.equal(cancelled, false);
  for (let index = 0; index < 7; index += 1) list.handleInput("\u007f");
  assert.equal(renderedRows(list).length, 4);
  assert.ok(renderedRows(list)[0]?.startsWith("→ First"));
  list.handleInput("beta");
  list.handleInput("\u001b");
  assert.equal(cancelled, true, "Escape closes even when a query is present, like Pi settings");
});

test("row refreshes retain the query and filtered selection, even when rows disappear", () => {
  let rows = searchRows();
  let list: SectionedSettingsList;
  list = new SectionedSettingsList(rows, 10, searchTheme, (id, value) => {
    rows = rows.map((row) => ({ ...row, currentValue: row.id === id ? value : row.currentValue }));
    list.replaceRows(rows, id);
  }, () => {});
  list.handleInput("beta");
  list.handleInput("\u001b[B");
  list.handleInput("\r");
  assert.equal(renderedRows(list).length, 2);
  assert.ok(renderedRows(list).some((line) => line.startsWith("→ Style") && line.endsWith("none")));

  list.replaceRows(rows.map((row) => ({ ...row })));
  assert.ok(renderedRows(list).some((line) => line.startsWith("→ Style")), "restore by filtered ID, not the full-list index");
  list.updateValue("beta:style", "wave");
  assert.ok(renderedRows(list).some((line) => line.endsWith("wave")));
  rows = rows.filter((row) => row.id !== "beta:style");
  list.replaceRows(rows);
  assert.equal(renderedRows(list).length, 1);
  assert.ok(renderedRows(list)[0]?.startsWith("→ Speed"));
  list.replaceRows(rows.filter((row) => row.section !== "Beta"));
  assert.ok(list.render(100).includes("  No matching settings"));
  list.handleInput("\u0015");
  assert.equal(renderedRows(list).length, 2);
});

test("submenus search independently and restore the parent query, selection, and input focus", () => {
  let child: SectionedSettingsList | undefined;
  const changes: string[] = [];
  const rows = searchRows();
  rows[2]!.submenu = (_current, done) => {
    child = new SectionedSettingsList(searchRows(), 10, searchTheme, () => {}, () => done("none"));
    return child;
  };
  let parent: SectionedSettingsList;
  parent = new SectionedSettingsList(rows, 10, searchTheme, (id, value) => {
    changes.push(`${id}=${value}`);
    parent.replaceRows(rows.map((row) => ({ ...row })), id);
  }, () => {});
  parent.focused = true;
  parent.handleInput("beta");
  parent.handleInput("\u001b[B");
  parent.handleInput("\r");
  assert.ok(child);
  assert.equal(child.focused, true);
  assert.equal(renderedRows(parent).length, 4, "child starts with an empty query");
  parent.handleInput("color");
  assert.equal(renderedRows(parent).length, 1);
  assert.ok(renderedRows(parent)[0]?.startsWith("→ Color"));
  assert.equal(parent.render(100).join("").split(CURSOR_MARKER).length - 1, 1);
  parent.focused = false;
  assert.equal(child.focused, false);
  assert.ok(!parent.render(100).join("").includes(CURSOR_MARKER));
  parent.focused = true;
  parent.handleInput("\u001b");
  assert.deepEqual(changes, ["beta:style=none"]);
  assert.equal(child.focused, false);
  assert.ok(parent.render(100)[0]?.includes("beta"));
  assert.equal(renderedRows(parent).length, 2);
  assert.ok(renderedRows(parent).some((line) => line.startsWith("→ Style")));
  assert.equal(parent.render(100).join("").split(CURSOR_MARKER).length - 1, 1);
});

test("filtered scrolling counts matching rows and search changes reset selection", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    id: `row-${index}`,
    section: index < 6 ? "Alpha" : "Beta",
    label: `Option ${index}`,
    currentValue: "off",
  }));
  const list = new SectionedSettingsList(rows, 3, searchTheme, () => {}, () => {});
  list.handleInput("beta");
  for (let index = 0; index < 5; index += 1) list.handleInput("\u001b[B");
  assert.ok(list.render(100).includes("  (6/6)"));
  assert.ok(list.render(100).some((line) => line.startsWith("→ Option 11")));
  assert.equal(list.render(100).filter((line) => /^(→ |  )Option/.test(line)).length, 3);
  list.handleInput("\u0015");
  assert.ok(list.render(100).some((line) => line.startsWith("→ Option 0")));
  assert.ok(list.render(100).includes("  (1/12)"));
});

test("search supports Chinese input, bracketed paste, and narrow terminal rendering", () => {
  const rows = [
    { id: "cn", section: "动画插件", label: "显示速度", description: "选择动画速度", currentValue: "正常" },
    { id: "en", section: "Other", label: "Color", currentValue: "blue" },
  ];
  const list = new SectionedSettingsList(rows, 10, searchTheme, () => {}, () => {});
  list.focused = true;
  list.handleInput("\u001b[200~动画 ");
  list.handleInput("速度\u001b[201~");
  assert.ok(list.render(100).some((line) => line.startsWith("→ 显示速度")));
  assert.ok(!list.render(100).includes("  Other"));
  for (const width of [1, 2, 4, 10, 24, 80]) {
    for (const line of list.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line exceeds ${width} columns: ${JSON.stringify(line)}`);
    }
  }
  list.invalidate();
  assert.ok(list.render(100)[0]?.includes(CURSOR_MARKER));
  list.handleInput("\u0015");
  list.handleInput("zzzzzz");
  assert.ok(list.render(100).includes("  No matching settings"));
  list.replaceRows([]);
  assert.ok(list.render(100).includes("  No settings available"));
});

test("settings navigation honors the injected keybinding manager while searching", () => {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": "ctrl+j",
    "tui.select.confirm": "ctrl+o",
    "tui.select.cancel": "ctrl+q",
  });
  let changed: string | undefined;
  let cancelled = false;
  const list = new SectionedSettingsList(searchRows(), 10, searchTheme, (id) => { changed = id; }, () => { cancelled = true; }, keybindings);
  list.handleInput("beta");
  list.handleInput("\n");
  list.handleInput("\u000f");
  assert.equal(changed, "beta:style");
  list.handleInput("\u0011");
  assert.equal(cancelled, true);
});

test("/99settings wires searchable root and nested panels with focus and refresh support", async () => {
  initTheme("dark", false);
  const runtime = fakePi();
  const changes: string[] = [];
  let value = "off";
  let renders = 0;
  let closed = false;
  registerExtensionSettings(runtime.pi, {
    namespace: "test-settings",
    title: "Test Plugin",
    settings: () => [
      { id: "mode", label: "Mode", description: "Choose mode", currentValue: value, values: ["off", "on"] },
      {
        id: "panel", label: "Advanced", description: "Nested options", currentValue: "options",
        submenu: {
          title: "Advanced options",
          settings: () => [{ id: "speed", label: "Speed", description: "Animation speed", currentValue: value, values: ["off", "on"] }],
          onChange: (id, next) => { changes.push(`child:${id}=${next}`); value = next; },
          currentValue: () => value,
        },
      },
    ],
    onChange: (id, next) => { changes.push(`root:${id}=${next}`); value = next; },
  });
  try {
    const handler = runtime.commandHandlers.get(SHARED_SETTINGS_COMMAND);
    assert.ok(handler);
    await handler("", {
      mode: "tui",
      ui: {
        custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
          const component = await factory(
            { requestRender: () => { renders += 1; } } as never,
            { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
            new KeybindingsManager(TUI_KEYBINDINGS),
            () => { closed = true; },
          );
          assert.ok(isFocusable(component));
          component.focused = true;
          const output = () => component.render(100).join("\n");
          assert.ok(output().includes(CURSOR_MARKER));
          component.handleInput?.("mode");
          component.handleInput?.("\r");
          assert.deepEqual(changes, ["root:mode=on"]);
          assert.ok(!output().includes("Advanced"));
          component.handleInput?.("\u0015");
          component.handleInput?.("advanced");
          component.handleInput?.("\r");
          assert.ok(output().includes("Advanced options"));
          component.handleInput?.("speed");
          component.handleInput?.("\r");
          assert.deepEqual(changes, ["root:mode=on", "child:speed=off"]);
          assert.ok(output().includes("speed"), "panel query survives its settings refresh");
          component.handleInput?.("\u001b");
          assert.ok(output().includes("advanced"), "root query survives closing a panel");
          assert.ok(!output().includes("Choose mode"));
          component.focused = false;
          assert.ok(!output().includes(CURSOR_MARKER));
          component.focused = true;
          component.invalidate();
          assert.ok(output().includes(CURSOR_MARKER));
          component.handleInput?.("\u001b");
          return undefined;
        },
      },
    } as unknown as ExtensionCommandContext);
    assert.equal(closed, true);
    assert.ok(renders > 0);
  } finally {
    await runtime.shutdown();
  }
});

function heightRows(): SectionedSettingRow[] {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `height-${index}`,
    section: index < 6 ? "Alpha" : index === 6 ? "Beta" : index === 7 ? "Gamma" : "Delta",
    label: `Setting ${index + 1}`,
    description: index % 3 === 0
      ? undefined
      : index % 3 === 1
        ? "Short help"
        : "First help line\nLonger help with 中文字符 and enough words to wrap across several terminal lines.",
    currentValue: "off",
  }));
}

test("settings scrolling keeps the list, counter, help area, and footer at stable heights", () => {
  const theme = { ...searchTheme, description: (text: string) => `[help]${text}` };
  const list = new SectionedSettingsList(heightRows(), 4, theme, () => {}, () => {});
  for (const width of [24, 60, 100]) {
    const initial = list.render(width);
    const counterIndex = initial.findIndex((line) => /\(\d+\/12\)/.test(line));
    assert.ok(counterIndex >= 0);
    let helpIndex: number | undefined;
    for (const key of ["\u001b[B", "\u001b[A"]) {
      for (let step = 0; step <= 12; step += 1) {
        const output = list.render(width);
        assert.equal(output.length, initial.length, `height changed at width ${width}, step ${step}`);
        assert.equal(output.findIndex((line) => /\(\d+\/12\)/.test(line)), counterIndex);
        assert.equal(output.filter((line) => /^(→ |  )Setting \d+/.test(line)).length, 4);
        const firstHelp = output.findIndex((line) => line.startsWith("[help]"));
        if (firstHelp >= 0) {
          helpIndex ??= firstHelp;
          assert.equal(firstHelp, helpIndex, "help text starts on a fixed line");
        }
        list.handleInput(key);
      }
    }
    assert.ok(helpIndex !== undefined);
  }
});

test("viewport reserves exactly the maximum visible headers for small and large row limits", () => {
  const rows = heightRows().map((row) => ({ ...row, description: undefined }));
  for (const limit of [1, 2, 4, 10, 20]) {
    const count = Math.min(limit, rows.length);
    const headerCounts = Array.from({ length: rows.length - count + 1 }, (_, start) => {
      const window = rows.slice(start, start + count);
      return window.filter((row, index) => index === 0 || row.section !== window[index - 1]!.section).length;
    });
    // Search + spacer, padded body, optional counter, spacer + hint. No help area.
    const expectedHeight = 2 + count + Math.max(...headerCounts) + (rows.length > count ? 1 : 0) + 2;
    const list = new SectionedSettingsList(rows, limit, searchTheme, () => {}, () => {});
    for (let step = 0; step <= rows.length; step += 1) {
      const output = list.render(60);
      assert.equal(output.length, expectedHeight, `unexpected padding for limit ${limit}, step ${step}`);
      assert.equal(output.filter((line) => /^(→ |  )Setting \d+/.test(line)).length, count);
      list.handleInput("\u001b[B");
    }
  }
});

test("short and filtered menus reserve help space without forcing a full ten-row menu", () => {
  const rows = heightRows().slice(0, 3);
  const list = new SectionedSettingsList(rows, 10, searchTheme, () => {}, () => {});
  const initial = list.render(60);
  assert.ok(!initial.some((line) => /\(\d+\/\d+\)/.test(line)), "short lists need no counter");
  for (let step = 0; step < rows.length; step += 1) {
    assert.equal(list.render(60).length, initial.length);
    list.handleInput("\u001b[B");
  }
  list.handleInput("Setting 3");
  const filtered = list.render(60);
  assert.ok(filtered.length < initial.length, "search can compact the viewport");
  for (const key of ["\u001b[B", "\u001b[A"]) {
    list.handleInput(key);
    assert.equal(list.render(60).length, filtered.length);
  }
  list.handleInput("\u0015");
  assert.equal(list.render(60).length, initial.length);
});

test("filtered scrolling reserves only matching headers and complete wrapped descriptions", () => {
  const rows = heightRows();
  const list = new SectionedSettingsList(rows, 3, searchTheme, () => {}, () => {});
  list.handleInput("alpha");
  const initial = list.render(40);
  for (let step = 0; step <= 6; step += 1) {
    const output = list.render(40);
    assert.equal(output.length, initial.length);
    assert.ok(output.includes("  Alpha"));
    assert.ok(!output.includes("  Beta"));
    list.handleInput("\u001b[B");
  }
  list.handleInput("\u0015");
  list.handleInput("Setting 3");
  const output = list.render(40);
  assert.ok(output.some((line) => line.includes("First help line")));
  assert.ok(output.some((line) => line.endsWith("terminal lines.")), "long help is not truncated to a fixed preview");
});

test("layout reservations refresh after settings replacement, invalidation, and empty results", () => {
  const rows: SectionedSettingRow[] = [
    { id: "one", section: "Panel", label: "One", currentValue: "off" },
    { id: "two", section: "Panel", label: "Two", currentValue: "off" },
  ];
  const list = new SectionedSettingsList(rows, 10, searchTheme, () => {}, () => {});
  const withoutHelp = list.render(40).length;
  list.replaceRows(rows.map((row) => ({ ...row, description: row.id === "two" ? "Updated help" : undefined })));
  const withHelp = list.render(40).length;
  assert.ok(withHelp > withoutHelp);
  list.handleInput("\u001b[B");
  assert.equal(list.render(40).length, withHelp);
  assert.ok(list.render(40).includes("  Updated help"));
  list.replaceRows(rows);
  assert.equal(list.render(40).length, withoutHelp);
  rows[1]!.description = "New help after invalidation";
  list.invalidate();
  assert.ok(list.render(40).includes("  New help after invalidation"));
  list.handleInput("zzzzzz");
  assert.ok(list.render(40).includes("  No matching settings"));
  list.handleInput("\u0015");
  const restored = list.render(40).length;
  list.handleInput("\u001b[B");
  assert.equal(list.render(40).length, restored);
  list.replaceRows([]);
  assert.ok(list.render(40).includes("  No settings available"));
});

test("submenus preserve their own stable height and restore the parent's layout", () => {
  const rows = heightRows();
  let child: SectionedSettingsList | undefined;
  rows[0]!.submenu = (_value, done) => {
    child = new SectionedSettingsList(heightRows().slice(0, 3), 10, searchTheme, () => {}, () => done());
    return child;
  };
  const parent = new SectionedSettingsList(rows, 4, searchTheme, () => {}, () => {});
  const parentHeight = parent.render(40).length;
  parent.handleInput("\r");
  assert.ok(child);
  const childHeight = parent.render(40).length;
  for (let step = 0; step <= 3; step += 1) {
    assert.equal(parent.render(40).length, childHeight);
    parent.handleInput("\u001b[B");
  }
  parent.handleInput("\u001b");
  assert.equal(parent.render(40).length, parentHeight);
  parent.handleInput("\u001b[B");
  assert.equal(parent.render(40).length, parentHeight);
});

test("shared settings reject invalid namespaces", () => {
  assert.throws(
    () => readSettingsNamespace("../outside", (value) => value, "/tmp/unused"),
    /Invalid settings namespace/,
  );
});
