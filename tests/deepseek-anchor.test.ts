import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import deepSeekAnchorExtension, {
  inspectPayload,
} from "../extensions/deepseek-anchor/index.ts";
import {
  DEFAULT_CONFIG,
  DSH_SYSTEM_PROMPT,
  loadConfig,
  normalizeConfig,
  DEEPSEEK_ANCHOR_SETTINGS_NAMESPACE,
  saveConfig,
  type DeepSeekAnchorConfig,
} from "../extensions/deepseek-anchor/config.ts";
import { PersistentBashSession } from "../extensions/deepseek-anchor/persistent-bash.ts";
import {
  DSH_BASH_DESCRIPTION,
  DSH_BASH_PARAMETERS,
  DSH_EDITOR_DESCRIPTION,
  DSH_EDITOR_PARAMETERS,
  shapeAnchoredPayload,
  shapeBootstrapPayload,
} from "../extensions/deepseek-anchor/payload.ts";
import { loadHostBashOptions } from "../extensions/deepseek-anchor/host-bash.ts";
import {
  updateDeepSeekAnchorConfigSetting,
} from "../extensions/deepseek-anchor/settings.ts";
import {
  registerStrReplaceEditor,
  strReplaceEditorSchema,
} from "../extensions/deepseek-anchor/str-replace-editor.ts";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

interface MockHarness {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  handlers: Map<string, Handler[]>;
  branch: any[];
  allEntries: any[];
  notifications: Array<{ message: string; level: string }>;
  commandNames: string[];
  registeredToolNames: string[];
  getToolDefinition(name: string): any;
  emit(name: string, event?: unknown): Promise<unknown[]>;
  shape(payload: unknown): Promise<unknown>;
  payload(): Record<string, unknown>;
  activeTools(): string[];
}

function mockTool(name: string) {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: Type.Object({ value: Type.Optional(Type.String()) }),
    async execute() {
      return { content: [{ type: "text" as const, text: "ok" }], details: {} };
    },
  };
}

function createHarness(options: {
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  branch?: any[];
  allEntries?: any[];
} = {}): MockHarness {
  const handlers = new Map<string, Handler[]>();
  const definitions = new Map<string, any>();
  for (const name of ["read", "bash", "edit", "write", "grep"]) {
    definitions.set(name, mockTool(name));
  }
  let active = [...definitions.keys()];
  const commandNames: string[] = [];
  const registeredToolNames: string[] = [];
  let sequence = 0;
  const branch = options.branch ?? [];
  const allEntries = options.allEntries ?? branch;
  const notifications: Array<{ message: string; level: string }> = [];

  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(definition: any) {
      registeredToolNames.push(definition.name);
      const existed = definitions.has(definition.name);
      definitions.set(definition.name, definition);
      if (!existed) active.push(definition.name);
    },
    registerCommand(name: string) {
      commandNames.push(name);
    },
    registerEntryRenderer() {},
    appendEntry(customType: string, data: unknown) {
      const entry = {
        type: "custom",
        id: `entry-${++sequence}`,
        parentId: null,
        timestamp: new Date(sequence).toISOString(),
        customType,
        data,
      };
      branch.push(entry);
      if (allEntries !== branch) allEntries.push(entry);
    },
    getActiveTools() {
      return [...active];
    },
    getAllTools() {
      return [...definitions.values()].map((definition) => ({
        ...definition,
        sourceInfo: {
          path: `<mock:${definition.name}>`,
          source: "mock",
          scope: "temporary",
          origin: "top-level",
        },
      }));
    },
    setActiveTools(names: string[]) {
      active = [...new Set(names)].filter((name) => definitions.has(name));
    },
    events: { on() {}, emit() {} },
  } as unknown as ExtensionAPI;

  const ctx = {
    model: options.model ?? { provider: "deepseek", id: "deepseek-v4-pro" },
    thinkingLevel: options.thinkingLevel ?? "max",
    mode: "tui",
    hasUI: true,
    cwd: "/local/workspace",
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => allEntries,
      getSessionId: () => "session-id",
      getSessionFile: () => undefined,
    },
    ui: {
      notify(message: string, level: string) {
        // Mirror Pi's TUI behavior: consecutive info notifications update the
        // same status line, while warning/error append new lines.
        const previous = notifications.at(-1);
        if (level === "info" && previous?.level === "info") {
          notifications[notifications.length - 1] = { message, level };
        } else {
          notifications.push({ message, level });
        }
      },
    },
  } as unknown as ExtensionContext;

  const emit = async (name: string, event: unknown = {}) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) {
      results.push(await handler(event, ctx));
    }
    return results;
  };

  return {
    pi,
    ctx,
    handlers,
    branch,
    allEntries,
    notifications,
    commandNames,
    registeredToolNames,
    getToolDefinition: (name: string) => definitions.get(name),
    emit,
    async shape(payload: unknown) {
      let current = payload;
      for (const handler of handlers.get("before_provider_request") ?? []) {
        const result = await handler({ type: "before_provider_request", payload: current }, ctx);
        if (result !== undefined) current = result;
      }
      return current;
    },
    payload() {
      return {
        model: "deepseek-v4-pro",
        messages: [
          { role: "system", content: "normal Pi prompt" },
          { role: "user", content: "fix the project" },
        ],
        tools: active.map((name) => {
          const definition = definitions.get(name);
          return {
            type: "function",
            function: {
              name,
              description: definition.description,
              parameters: definition.parameters,
            },
          };
        }),
      };
    },
    activeTools: () => [...active],
  };
}

async function withAgentDirectory<T>(
  config: DeepSeekAnchorConfig | undefined,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-deepseek-anchor-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    if (config) saveConfig(config);
    return await operation(directory);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function config(overrides: Partial<DeepSeekAnchorConfig> = {}): DeepSeekAnchorConfig {
  return {
    ...DEFAULT_CONFIG,
    nativeBootstrapTools: [...DEFAULT_CONFIG.nativeBootstrapTools],
    ...overrides,
  };
}

test("shared settings map labels to durable DeepSeek Anchor values", () => {
  const initial = config();
  const exact = updateDeepSeekAnchorConfigSetting(initial, "profile", "Exact DSH");
  assert.equal(exact?.profile, "exact-dsh");
  const minimal = updateDeepSeekAnchorConfigSetting(exact!, "mode", "Minimal");
  assert.equal(minimal?.mode, "minimal");
  const tools = updateDeepSeekAnchorConfigSetting(minimal!, "nativeBootstrapTools", "bash + read");
  assert.deepEqual(tools?.nativeBootstrapTools, ["bash", "read"]);
  assert.equal(updateDeepSeekAnchorConfigSetting(initial, "profile", "unknown"), undefined);
  assert.equal(updateDeepSeekAnchorConfigSetting(initial, "scope", "Every prompt"), undefined);
});

test("configuration normalizes and persists only durable settings", async () => {
  const normalized = normalizeConfig({
    mode: "minimal",
    scope: "prompt",
    nativeBootstrapTools: ["bash", "edit", "bash", "bad tool"],
    nativeSystemPrompt: "Custom prompt",
    fullTools: ["must", "not", "persist"],
  });
  assert.equal(normalized.mode, "minimal");
  assert.equal("scope" in normalized, false, "the removed scope field must not survive normalization");
  assert.deepEqual(normalized.nativeBootstrapTools, ["bash", "edit"]);
  assert.equal(normalized.nativeSystemPrompt, "Custom prompt");
  assert.equal("fullTools" in normalized, false);

  const directory = await mkdtemp(join(tmpdir(), "pi-deepseek-anchor-config-"));
  const path = join(directory, "99extensions.json");
  try {
    const expected = config({ profile: "exact-dsh" });
    saveConfig(expected, path);
    assert.deepEqual(loadConfig(path), expected);
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(raw[DEEPSEEK_ANCHOR_SETTINGS_NAMESPACE], expected);
    assert.equal(raw[DEEPSEEK_ANCHOR_SETTINGS_NAMESPACE].fullTools, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native profile keeps the system anchor after expanding the bootstrap tools", async () => {
  await withAgentDirectory(config(), async () => {
    const harness = createHarness();
    deepSeekAnchorExtension(harness.pi);
    assert.deepEqual(harness.commandNames, ["99settings"]);
    assert.equal(harness.commandNames.includes("deepseek-anchor"), false);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "fix" });
    assert.deepEqual(harness.activeTools(), ["bash", "edit"]);

    const shaped = await harness.shape(harness.payload());
    assert.deepEqual(inspectPayload(shaped), {
      system: DSH_SYSTEM_PROMPT,
      tools: ["bash", "edit"],
    });

    await harness.emit("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "call-1", input: {} });
    assert.deepEqual(harness.activeTools(), ["bash", "edit"], "catalog stays stable during the tool batch");
    await harness.emit("turn_end", { type: "turn_end", toolResults: [] });
    assert.deepEqual(harness.activeTools(), ["read", "bash", "edit", "write", "grep"]);

    const normal = harness.payload();
    const after = await harness.shape(normal);
    assert.notEqual(after, normal, "later provider requests retain the session system anchor");
    assert.deepEqual(inspectPayload(after), {
      system: DSH_SYSTEM_PROMPT,
      tools: ["read", "bash", "edit", "write", "grep"],
    });
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });
});

test("non-target models stay unrestricted and no private command is registered", async () => {
  await withAgentDirectory(config(), async () => {
    const harness = createHarness({ model: { provider: "other", id: "model" } });
    deepSeekAnchorExtension(harness.pi);
    assert.equal(harness.commandNames.includes("deepseek-anchor"), false);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual(harness.activeTools(), ["read", "bash", "edit", "write", "grep"]);
    await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "continue" });
    assert.deepEqual(harness.activeTools(), ["read", "bash", "edit", "write", "grep"]);
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });
});

test("fresh-conversation gates use the active branch, not abandoned entries", async () => {
  await withAgentDirectory(config(), async () => {
    const abandonedGate = {
      type: "custom",
      customType: "deepseek-anchor-gate",
      data: {
        eligible: true,
        profile: "pi-native",
        targetKey: "deepseek/deepseek-v4-pro",
      },
    };
    const activeMessage = {
      type: "message",
      message: { role: "user", content: "resumed work" },
    };
    const branch = [activeMessage];
    const harness = createHarness({ branch, allEntries: [abandonedGate, activeMessage] });
    deepSeekAnchorExtension(harness.pi);
    await harness.emit("session_start", { type: "session_start", reason: "resume" });
    await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "continue" });
    assert.deepEqual(harness.activeTools(), ["read", "bash", "edit", "write", "grep"]);
    assert.equal(branch.length, 1, "an abandoned gate must not activate the current branch");
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });
});

test("session phase entries prevent re-anchoring after reload", async () => {
  await withAgentDirectory(config(), async () => {
    const branch = [
      {
        type: "custom",
        customType: "deepseek-anchor-gate",
        data: {
          eligible: true,
          profile: "pi-native",
          targetKey: "deepseek/deepseek-v4-pro",
        },
      },
      {
        type: "custom",
        customType: "deepseek-anchor-transition",
        data: {
          phase: "anchored",
          profile: "pi-native",
          targetKey: "deepseek/deepseek-v4-pro",
          tools: ["read", "bash", "edit", "write", "grep"],
        },
      },
      { type: "message", message: { role: "user", content: "prior work" } },
    ];
    const harness = createHarness({ branch });
    deepSeekAnchorExtension(harness.pi);
    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "continue" });
    const payload = harness.payload();
    const shaped = await harness.shape(payload);
    assert.notEqual(shaped, payload);
    assert.deepEqual(inspectPayload(shaped), {
      system: DSH_SYSTEM_PROMPT,
      tools: ["read", "bash", "edit", "write", "grep"],
    });
    assert.deepEqual(harness.activeTools(), ["read", "bash", "edit", "write", "grep"]);
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });
});

test("non-max thinking emits one warning without changing the level", async () => {
  await withAgentDirectory(config(), async () => {
    const harness = createHarness({ thinkingLevel: "high" });
    deepSeekAnchorExtension(harness.pi);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "one" });
    await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "two" });
    const warnings = harness.notifications.filter(({ message }) => /reference runs used max/.test(message));
    assert.equal(warnings.length, 1);
    assert.equal(harness.ctx.thinkingLevel, "high");
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });
});

test("exact profile emits the fixed DSH prompt and schemas, then removes its editor", {
  skip: process.platform === "win32" ? "exact-dsh requires POSIX" : false,
}, async () => {
  await withAgentDirectory(config({ profile: "exact-dsh" }), async () => {
    const harness = createHarness();
    deepSeekAnchorExtension(harness.pi);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.equal(harness.activeTools().includes("str_replace_editor"), false);

    await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "fix" });
    assert.deepEqual(harness.activeTools(), ["bash", "str_replace_editor"]);
    const shaped = await harness.shape(harness.payload()) as any;
    assert.deepEqual(inspectPayload(shaped), {
      system: DSH_SYSTEM_PROMPT,
      tools: ["bash", "str_replace_editor"],
    });
    assert.equal(shaped.messages.filter((message: any) => message.role === "system").length, 1);
    assert.deepEqual(shaped.tools[0].function, {
      name: "bash",
      description: DSH_BASH_DESCRIPTION,
      parameters: DSH_BASH_PARAMETERS,
    });
    assert.deepEqual(shaped.tools[1].function, {
      name: "str_replace_editor",
      description: DSH_EDITOR_DESCRIPTION,
      parameters: DSH_EDITOR_PARAMETERS,
    });

    await harness.emit("tool_call", {
      type: "tool_call",
      toolName: "str_replace_editor",
      toolCallId: "editor-1",
      input: {},
    });
    await harness.emit("turn_end", { type: "turn_end", toolResults: [] });
    assert.equal(harness.activeTools().includes("str_replace_editor"), false);
    assert.deepEqual(harness.activeTools(), ["read", "bash", "edit", "write", "grep"]);
    const anchored = await harness.shape(harness.payload());
    assert.deepEqual(inspectPayload(anchored), {
      system: DSH_SYSTEM_PROMPT,
      tools: ["read", "bash", "edit", "write", "grep"],
    });
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });
});

test("pi-native never registers the Bash compatibility wrapper", async () => {
  await withAgentDirectory(config(), async () => {
    const harness = createHarness();
    deepSeekAnchorExtension(harness.pi);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.equal(harness.registeredToolNames.includes("bash"), false);
    assert.equal(
      harness.registeredToolNames.includes("str_replace_editor"),
      process.platform !== "win32",
      "the exact editor should only be registered on POSIX hosts",
    );
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });
});

test("exact profile fails closed when another extension owns the bash tool", {
  skip: process.platform === "win32" ? "exact-dsh requires POSIX" : false,
}, async () => {
  await withAgentDirectory(config({ profile: "exact-dsh" }), async () => {
    const harness = createHarness();
    deepSeekAnchorExtension(harness.pi);

    // Simulate Pi's first-registration-wins registry being owned by another
    // extension: our wrapper is registered, but a foreign bash definition is
    // what the tool registry resolves for the model.
    harness.pi.registerTool(mockTool("bash"));

    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "fix" });
    assert.deepEqual(harness.activeTools(), ["read", "bash", "edit", "write", "grep"]);

    const payload = harness.payload();
    const shaped = await harness.shape(payload);
    assert.equal(shaped, payload, "requests must stay untouched while ownership is unresolved");
    assert.deepEqual(inspectPayload(shaped), {
      system: "normal Pi prompt",
      tools: ["read", "bash", "edit", "write", "grep"],
    });
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });
});

test("tweaking settings on an anchored session neither re-stages nor spams", async () => {
  await withAgentDirectory(config(), async () => {
    const harness = createHarness();
    deepSeekAnchorExtension(harness.pi);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "fix" });
    await harness.shape(harness.payload());
    await harness.emit("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "call-1", input: {} });
    await harness.emit("turn_end", { type: "turn_end", toolResults: [] });
    assert.deepEqual(harness.activeTools(), ["read", "bash", "edit", "write", "grep"]);

    const registry = (globalThis as any)[Symbol.for("@99percentpeople/pi-shared-settings/registry-v1")];
    const section = registry?.sections.get("deepseek-anchor");
    assert.ok(section?.onChange, "the registered settings section must expose onChange");

    const transitionsBefore = harness.branch.filter(
      (entry: any) => entry.customType === "deepseek-anchor-transition",
    ).length;
    const noticesBefore = harness.notifications.length;

    section.onChange("nativeBootstrapTools", "bash + read", harness.ctx);
    section.onChange("nativeBootstrapTools", "bash + edit", harness.ctx);

    assert.equal(
      harness.notifications.length,
      noticesBefore + 1,
      "consecutive settings changes should keep a single status notification",
    );
    assert.equal(
      harness.branch.filter((entry: any) => entry.customType === "deepseek-anchor-transition").length,
      transitionsBefore,
      "an anchored session must not re-stage on unrelated setting changes",
    );
    assert.deepEqual(harness.activeTools(), ["read", "bash", "edit", "write", "grep"]);
    assert.deepEqual(loadConfig().nativeBootstrapTools, ["bash", "edit"]);
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });
});

test("host Bash options merge global and trusted project settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-deepseek-anchor-host-"));
  const project = await mkdtemp(join(tmpdir(), "pi-deepseek-anchor-project-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    await writeFile(join(directory, "settings.json"), JSON.stringify({
      shellPath: "/global/shell",
      shellCommandPrefix: "global prefix",
    }));
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({
      shellPath: "/project/shell",
    }));

    assert.deepEqual(loadHostBashOptions(project, true), {
      shellPath: "/project/shell",
      commandPrefix: "global prefix",
    });
    assert.deepEqual(loadHostBashOptions(project, false), {
      shellPath: "/global/shell",
      commandPrefix: "global prefix",
    });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("exact wrapper preserves host Bash settings outside bootstrap", {
  skip: process.platform === "win32" ? "exact-dsh requires POSIX" : false,
}, async () => {
  await withAgentDirectory(config({ profile: "exact-dsh" }), async (directory) => {
    await writeFile(join(directory, "settings.json"), JSON.stringify({
      shellCommandPrefix: "export DEEPSEEK_ANCHOR_HOST_MARKER=preserved",
    }));

    const harness = createHarness();
    deepSeekAnchorExtension(harness.pi);
    harness.ctx.cwd = directory;
    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    const bash = harness.getToolDefinition("bash");
    assert.ok(bash);
    const result = await bash.execute(
      "bash-call",
      { command: 'printf "%s" "$DEEPSEEK_ANCHOR_HOST_MARKER"' },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(result.content[0].text, "preserved");
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });
});

test("payload shaping keeps one complete system anchor and rejects incomplete bootstrap catalogs", () => {
  const payload = {
    model: "deepseek-v4-pro",
    messages: [
      { role: "system", content: "old" },
      { role: "developer", content: "also old" },
      { role: "user", content: "task" },
    ],
    tools: [
      { type: "function", function: { name: "bash", parameters: {} } },
      { type: "function", function: { name: "edit", parameters: {} } },
      { type: "function", function: { name: "write", parameters: {} } },
    ],
  };
  const exact = shapeBootstrapPayload(payload, {
    profile: "exact-dsh",
    systemPrompt: DSH_SYSTEM_PROMPT,
    bootstrapTools: ["bash", "str_replace_editor"],
  });
  assert.equal(exact.applied, true);
  const exactPayload = exact.payload as any;
  assert.deepEqual(exactPayload.messages, [
    { role: "system", content: DSH_SYSTEM_PROMPT },
    { role: "user", content: "task" },
  ]);

  const anchored = shapeAnchoredPayload(payload, { systemPrompt: DSH_SYSTEM_PROMPT });
  assert.equal(anchored.applied, true);
  assert.deepEqual(inspectPayload(anchored.payload), {
    system: DSH_SYSTEM_PROMPT,
    tools: ["bash", "edit", "write"],
  });

  const missing = shapeBootstrapPayload({ ...payload, tools: payload.tools.slice(0, 1) }, {
    profile: "pi-native",
    systemPrompt: DSH_SYSTEM_PROMPT,
    bootstrapTools: ["bash", "edit"],
  });
  assert.equal(missing.applied, false);
  assert.match(missing.reason ?? "", /missing bootstrap tools: edit/);
});

test("str_replace_editor matches canonical create, view, replace, and insert behavior", async () => {
  let definition: any;
  registerStrReplaceEditor({
    registerTool(value: unknown) {
      definition = value;
    },
  } as unknown as ExtensionAPI);
  assert.ok(definition);
  assert.deepEqual(strReplaceEditorSchema.required, ["command", "path"]);
  assert.deepEqual(strReplaceEditorSchema.properties.command.enum, [
    "view",
    "create",
    "str_replace",
    "insert",
  ]);

  const directory = await mkdtemp(join(tmpdir(), "pi-deepseek-anchor-editor-"));
  const path = join(directory, "sample.txt");
  const execute = (input: Record<string, unknown>) => definition.execute(
    "editor-call",
    input,
    undefined,
    undefined,
    { cwd: directory },
  );
  try {
    assert.equal(
      (await execute({ command: "create", path, file_text: "one\ntwo\n" })).content[0].text,
      `New file created successfully at: ${path}`,
    );
    assert.match(
      (await execute({ command: "view", path, view_range: [2, -1] })).content[0].text,
      /     2  two\n     3  /,
    );
    await execute({ command: "str_replace", path, old_str: "two", new_str: "TWO" });
    await execute({ command: "insert", path, insert_line: 1, new_str: "between" });
    assert.equal(await readFile(path, "utf8"), "one\nbetween\nTWO\n");
    await assert.rejects(
      () => execute({ command: "view", path: "relative.txt" }),
      /absolute path/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistent Bash preserves cwd and environment and recovers after timeout", {
  skip: process.platform === "win32" ? "requires POSIX bash" : false,
  timeout: 5_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-deepseek-anchor-bash-"));
  const shell = new PersistentBashSession({ cwd: directory, timeoutMs: 50 });
  try {
    assert.equal(await shell.run("export KEEP=state; mkdir nested; cd nested"), "");
    // Bash resolves the starting cwd to its canonical path. On macOS /var
    // is a symlink to /private/var, so compare against realpath() rather
    // than the logical tmpdir() spelling.
    assert.equal(
      await shell.run('printf "%s:%s\\n" "$KEEP" "$PWD"'),
      `state:${realpathSync(join(directory, "nested"))}`,
    );
    assert.equal(await shell.run("false"), "[exit code: 1]");
    const timedOut = await shell.run("printf partial; sleep 5");
    assert.match(timedOut, /timed out/);
    assert.match(timedOut, /partial/);
    assert.equal(
      await shell.run('printf "%s" "$PWD"'),
      realpathSync(directory),
    );
  } finally {
    await shell.close();
    await rm(directory, { recursive: true, force: true });
  }
});
