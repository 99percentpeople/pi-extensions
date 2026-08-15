import {
  createBashToolDefinition,
  type BashOperations,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  bootstrapToolsFor,
  loadConfig,
  saveConfig,
  systemPromptFor,
  targetKey,
  type AnchorProfile,
  type DeepSeekAnchorConfig,
} from "./config.ts";
import { PersistentBashSession } from "./persistent-bash.ts";
import {
  extractSystemText,
  listPayloadToolNames,
  shapeAnchoredPayload,
  shapeBootstrapPayload,
} from "./payload.ts";
import { registerDeepSeekAnchorSettings } from "./settings.ts";
import { registerStrReplaceEditor } from "./str-replace-editor.ts";

export type AnchorPhase = "bootstrap" | "anchored";

const GATE_ENTRY = "deepseek-anchor-gate";
const TRANSITION_ENTRY = "deepseek-anchor-transition";
const EXACT_ONLY_TOOLS = new Set(["str_replace_editor"]);
const DEBUG = /^(?:1|true|yes)$/i.test(process.env.DEEPSEEK_ANCHOR_DEBUG ?? "");

interface GateData {
  version?: number;
  eligible?: boolean;
  profile?: AnchorProfile;
  targetKey?: string;
}

interface PhaseData {
  version?: number;
  phase?: AnchorPhase;
  profile?: AnchorProfile;
  targetKey?: string;
  scope?: "session" | "prompt";
  tools?: string[];
}

interface Runtime {
  config: DeepSeekAnchorConfig;
  phase: AnchorPhase;
  active: boolean;
  conversationEligible: boolean;
  gateReason: string;
  restoreTools: string[];
  toolsRestricted: boolean;
  requestCount: number;
  bootstrapResponsePending: boolean;
  bootstrapToolCallCount: number;
  maxWarningShown: boolean;
  payloadReason: string;
  reasoningBuffer: string;
  reasoningLogged: boolean;
  exactSupported: boolean;
  exactBash?: PersistentBashSession;
}

function debug(...values: unknown[]): void {
  if (DEBUG) console.log("[deepseek-anchor:debug]", ...values);
}

function log(...values: unknown[]): void {
  console.log("[deepseek-anchor]", ...values);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function modelKey(model?: { provider?: string; id?: string } | null): string {
  return model ? `${model.provider}/${model.id}` : "none";
}

function branchEntries(ctx: ExtensionContext): ReturnType<ExtensionContext["sessionManager"]["getBranch"]> {
  return ctx.sessionManager.getBranch();
}

function hasConversationMessages(ctx: ExtensionContext): boolean {
  return branchEntries(ctx).some((entry) => {
    if (entry.type !== "message") return false;
    return entry.message.role === "user" || entry.message.role === "assistant";
  });
}

function matchingGate(ctx: ExtensionContext, config: DeepSeekAnchorConfig): boolean {
  const expectedTarget = targetKey(config);
  return branchEntries(ctx).some((entry) => {
    if (entry.type !== "custom" || entry.customType !== GATE_ENTRY) return false;
    const data = entry.data as GateData | undefined;
    return (
      data?.eligible === true
      && data.profile === config.profile
      && data.targetKey === expectedTarget
    );
  });
}

function latestRecordedPhase(ctx: ExtensionContext, config: DeepSeekAnchorConfig): AnchorPhase | undefined {
  const expectedTarget = targetKey(config);
  const entry = branchEntries(ctx).findLast((candidate) => {
    if (candidate.type !== "custom" || candidate.customType !== TRANSITION_ENTRY) return false;
    const data = candidate.data as PhaseData | undefined;
    return (
      (data?.phase === "bootstrap" || data?.phase === "anchored")
      && data.profile === config.profile
      && data.targetKey === expectedTarget
      && data.scope === config.scope
    );
  });
  if (!entry || entry.type !== "custom") return undefined;
  return (entry.data as PhaseData).phase;
}

export default function deepSeekAnchorExtension(pi: ExtensionAPI): void {
  const initialConfig = loadConfig();
  const runtime: Runtime = {
    config: initialConfig,
    phase: "bootstrap",
    active: false,
    conversationEligible: false,
    gateReason: "not evaluated",
    restoreTools: [],
    toolsRestricted: false,
    requestCount: 0,
    bootstrapResponsePending: false,
    bootstrapToolCallCount: 0,
    maxWarningShown: false,
    payloadReason: "",
    reasoningBuffer: "",
    reasoningLogged: false,
    exactSupported: process.platform !== "win32",
  };

  let bashDelegate: (() => BashOperations | undefined) | undefined;
  pi.events.on("bash:delegate", (data: unknown) => {
    bashDelegate = (data as { resolveOperations?: () => BashOperations | undefined })
      ?.resolveOperations;
  });

  // Register the compatibility definitions once on POSIX so profile changes in
  // /99settings are hot and never require a private reload command. The editor
  // remains inactive outside exact bootstrap, while the Bash wrapper delegates
  // to Pi (or an active SSH backend) for every non-exact call.
  const exactToolsRegistered = runtime.exactSupported;
  if (exactToolsRegistered) {
    const standardBash = createBashToolDefinition(process.cwd());
    pi.registerTool({
      ...standardBash,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const exactBootstrap =
          runtime.config.profile === "exact-dsh"
          && runtime.active
          && runtime.phase === "bootstrap"
          && runtime.bootstrapResponsePending;
        if (!exactBootstrap) {
          const delegated = bashDelegate?.();
          return createBashToolDefinition(
            ctx.cwd,
            delegated ? { operations: delegated } : undefined,
          ).execute(toolCallId, params, signal, onUpdate, ctx);
        }
        runtime.exactBash ??= new PersistentBashSession({ cwd: ctx.cwd });
        const text = await runtime.exactBash.run(params.command, { signal });
        return { content: [{ type: "text", text }], details: undefined };
      },
    });
    registerStrReplaceEditor(pi);
  }

  function configuredTools(): string[] {
    return bootstrapToolsFor(runtime.config);
  }

  function availableToolNames(): Set<string> {
    return new Set(pi.getAllTools().map((tool) => tool.name));
  }

  function isOwnedExactOnlyTool(name: string): boolean {
    return exactToolsRegistered && EXACT_ONLY_TOOLS.has(name);
  }

  function withoutExactOnly(names: string[]): string[] {
    return names.filter((name) => !isOwnedExactOnlyTool(name));
  }

  function captureRestoreTools(): void {
    if (runtime.toolsRestricted) return;
    runtime.restoreTools = withoutExactOnly(pi.getActiveTools());
  }

  function expand(): void {
    const registered = availableToolNames();
    const bootstrap = new Set(configuredTools());
    const liveExtras = pi.getActiveTools().filter((name) =>
      !bootstrap.has(name) && !isOwnedExactOnlyTool(name));
    let restored = unique([...runtime.restoreTools, ...liveExtras])
      .filter((name) => registered.has(name) && !isOwnedExactOnlyTool(name));
    if (restored.length === 0) {
      restored = pi.getAllTools()
        .map((tool) => tool.name)
        .filter((name) => !isOwnedExactOnlyTool(name));
    }
    pi.setActiveTools(restored);
    runtime.restoreTools = pi.getActiveTools();
    runtime.toolsRestricted = false;
  }

  function applyBootstrap(): boolean {
    const requested = configuredTools();
    const registered = availableToolNames();
    const missing = requested.filter((name) => !registered.has(name));
    if (missing.length > 0) {
      runtime.active = false;
      runtime.gateReason = `missing bootstrap tools: ${missing.join(", ")}`;
      expand();
      return false;
    }
    captureRestoreTools();
    pi.setActiveTools(requested);
    const actual = pi.getActiveTools();
    const unavailable = requested.filter((name) => !actual.includes(name));
    if (unavailable.length > 0) {
      runtime.active = false;
      runtime.gateReason = `failed to activate tools: ${unavailable.join(", ")}`;
      expand();
      return false;
    }
    runtime.toolsRestricted = true;
    return true;
  }

  function recordPhase(phase: AnchorPhase): void {
    pi.appendEntry(TRANSITION_ENTRY, {
      version: 1,
      phase,
      profile: runtime.config.profile,
      targetKey: targetKey(runtime.config),
      scope: runtime.config.scope,
      timestamp: Date.now(),
      tools: phase === "bootstrap" ? configuredTools() : runtime.restoreTools,
    } satisfies PhaseData & { timestamp: number });
  }

  function setPhase(
    phase: AnchorPhase,
    options: { forceRecord?: boolean } = {},
  ): void {
    const changed = runtime.phase !== phase;
    runtime.phase = phase;
    if (phase === "anchored") expand();
    else if (runtime.active && runtime.config.mode !== "off") applyBootstrap();
    if (changed || options.forceRecord) recordPhase(phase);
  }

  function modelMatches(model?: { provider?: string; id?: string } | null): boolean {
    return !!model
      && model.provider === runtime.config.targetProvider
      && model.id === runtime.config.targetModelId;
  }

  function ensureConversationGate(
    model: { provider?: string; id?: string } | null | undefined,
    ctx: ExtensionContext,
  ): boolean {
    if (matchingGate(ctx, runtime.config)) return true;
    if (
      runtime.config.mode !== "off"
      && !hasConversationMessages(ctx)
      && modelMatches(model)
    ) {
      pi.appendEntry(GATE_ENTRY, {
        version: 1,
        eligible: true,
        profile: runtime.config.profile,
        targetKey: targetKey(runtime.config),
        timestamp: Date.now(),
      } satisfies GateData & { timestamp: number });
      return true;
    }
    return false;
  }

  function exactHasExternalBash(): boolean {
    if (runtime.config.profile !== "exact-dsh") return false;
    try {
      return bashDelegate?.() !== undefined;
    } catch {
      return true;
    }
  }

  function recomputeActive(
    model: { provider?: string; id?: string } | null | undefined,
    ctx: ExtensionContext,
  ): void {
    const modelOk = modelMatches(model);
    const profileSupported = runtime.config.profile !== "exact-dsh" || runtime.exactSupported;
    const localEnvironment = !exactHasExternalBash();
    runtime.conversationEligible = profileSupported && localEnvironment
      ? ensureConversationGate(model, ctx)
      : matchingGate(ctx, runtime.config);
    runtime.active =
      modelOk
      && runtime.conversationEligible
      && profileSupported
      && localEnvironment;
    if (!profileSupported) {
      runtime.gateReason = "exact-dsh requires a POSIX host";
    } else if (!localEnvironment) {
      runtime.gateReason = "exact-dsh requires a local session without Bash delegation";
    } else if (!modelOk) {
      runtime.gateReason = `model ${modelKey(model)} ≠ ${targetKey(runtime.config)}`;
    } else if (!runtime.conversationEligible) {
      runtime.gateReason = "conversation was not started fresh with this profile and model; use /new";
    } else {
      runtime.gateReason = "";
    }
    if (!runtime.active) expand();
  }

  function initializePhase(ctx: ExtensionContext): void {
    if (runtime.config.mode === "minimal") {
      runtime.phase = "bootstrap";
      return;
    }
    if (runtime.config.mode === "off") {
      runtime.phase = "anchored";
      return;
    }
    if (runtime.config.scope === "prompt") {
      runtime.phase = "bootstrap";
      return;
    }
    runtime.phase = latestRecordedPhase(ctx, runtime.config) ?? "bootstrap";
  }

  function applySettingsConfig(next: DeepSeekAnchorConfig, ctx: ExtensionContext): void {
    const previous = runtime.config;
    try {
      saveConfig(next);
    } catch (error) {
      ctx.ui.notify(
        `Failed to save DeepSeek Anchor settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }

    // Restore the catalog under the old profile before changing which tools
    // count as bootstrap-only.
    expand();
    runtime.config = next;
    runtime.phase = next.mode === "off" ? "anchored" : "bootstrap";
    runtime.bootstrapResponsePending = false;
    runtime.bootstrapToolCallCount = 0;
    runtime.payloadReason = "";
    runtime.maxWarningShown = false;
    if (previous.profile !== next.profile || next.mode === "off") {
      void runtime.exactBash?.close();
      runtime.exactBash = undefined;
    }

    recomputeActive(ctx.model, ctx);
    if (runtime.active && next.mode !== "off") {
      applyBootstrap();
      recordPhase("bootstrap");
    } else {
      expand();
    }

    const changedProfile = previous.profile !== next.profile;
    const suffix = changedProfile && !runtime.active
      ? `; ${runtime.gateReason}`
      : "";
    ctx.ui.notify(`DeepSeek Anchor settings updated${suffix}`, runtime.active || next.mode === "off" ? "info" : "warning");
  }

  registerDeepSeekAnchorSettings(pi, {
    getConfig: () => runtime.config,
    updateConfig: applySettingsConfig,
  });

  pi.on("session_start", async (_event, ctx) => {
    runtime.config = loadConfig();
    runtime.requestCount = 0;
    runtime.bootstrapResponsePending = false;
    runtime.bootstrapToolCallCount = 0;
    runtime.maxWarningShown = false;
    runtime.payloadReason = "";
    runtime.reasoningBuffer = "";
    runtime.reasoningLogged = false;
    runtime.toolsRestricted = false;
    runtime.exactSupported = process.platform !== "win32";
    await runtime.exactBash?.close();
    runtime.exactBash = undefined;

    // Exact-only compatibility tools are registered for bootstrap execution but
    // must not leak into the normal Pi catalog.
    const initialActive = withoutExactOnly(pi.getActiveTools());
    if (initialActive.length !== pi.getActiveTools().length) pi.setActiveTools(initialActive);
    runtime.restoreTools = pi.getActiveTools();

    initializePhase(ctx);
    recomputeActive(ctx.model, ctx);
    if (runtime.phase === "anchored" || runtime.config.mode === "off" || !runtime.active) {
      expand();
    }
    log(
      `session · profile=${runtime.config.profile} · mode=${runtime.config.mode}/${runtime.config.scope} · target=${targetKey(runtime.config)} · model=${modelKey(ctx.model)} · active=${runtime.active} · phase=${runtime.phase}`,
    );
  });

  pi.on("session_shutdown", async () => {
    expand();
    await runtime.exactBash?.close();
    runtime.exactBash = undefined;
  });

  pi.on("model_select", async (event, ctx) => {
    recomputeActive(event.model, ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    recomputeActive(ctx.model, ctx);
    runtime.requestCount = 0;
    runtime.bootstrapResponsePending = false;
    runtime.bootstrapToolCallCount = 0;
    runtime.payloadReason = "";
    runtime.reasoningBuffer = "";
    runtime.reasoningLogged = false;

    if (runtime.config.mode === "off" || !runtime.active) {
      expand();
      return;
    }

    if (ctx.thinkingLevel !== "max" && !runtime.maxWarningShown) {
      runtime.maxWarningShown = true;
      const warning = `deepseek-anchor: reference runs used max thinking; current level is ${ctx.thinkingLevel ?? "unknown"}`;
      if (ctx.hasUI) ctx.ui.notify(warning, "warning");
      else console.warn(warning);
    }

    if (runtime.config.mode === "minimal") {
      runtime.phase = "bootstrap";
    } else if (runtime.config.scope === "prompt") {
      setPhase("bootstrap", { forceRecord: runtime.phase !== "bootstrap" });
    }

    if (runtime.phase === "bootstrap") applyBootstrap();
    else expand();
  });

  pi.on("before_provider_request", (event) => {
    runtime.requestCount += 1;
    runtime.bootstrapResponsePending = false;
    if (runtime.config.mode === "off" || !runtime.active) return;

    const payload = event.payload as Record<string, unknown> | undefined;
    const payloadModel = payload?.model;
    const payloadModelOk =
      typeof payloadModel !== "string"
      || payloadModel === runtime.config.targetModelId
      || payloadModel === targetKey(runtime.config);
    if (!payloadModelOk) {
      runtime.active = false;
      runtime.gateReason = `provider payload model ${String(payloadModel)} ≠ ${targetKey(runtime.config)}`;
      runtime.payloadReason = runtime.gateReason;
      expand();
      return;
    }

    // The RL-aligned system prompt is the session anchor. Only the tool catalog
    // transitions: bootstrap requests use the minimal profile catalog, while
    // anchored requests retain the same complete prompt with restored Pi tools.
    const systemPrompt = systemPromptFor(runtime.config);
    const shaped = runtime.phase === "bootstrap"
      ? shapeBootstrapPayload(event.payload, {
        profile: runtime.config.profile,
        systemPrompt,
        bootstrapTools: configuredTools(),
      })
      : shapeAnchoredPayload(event.payload, { systemPrompt });
    if (!shaped.applied) {
      runtime.active = false;
      runtime.payloadReason = shaped.reason ?? "payload shaping failed";
      runtime.gateReason = runtime.payloadReason;
      expand();
      return;
    }

    runtime.bootstrapResponsePending = runtime.phase === "bootstrap";
    debug(
      `request #${runtime.requestCount} · phase=${runtime.phase} · profile=${runtime.config.profile} · tools=[${shaped.toolNames.join(", ")}] · system=${JSON.stringify(extractSystemText(shaped.payload))}`,
    );
    return shaped.payload;
  });

  pi.on("tool_call", async (event) => {
    if (!runtime.active || !runtime.bootstrapResponsePending) return;
    const bootstrapTools = configuredTools();
    if (!bootstrapTools.includes(event.toolName)) {
      return {
        block: true,
        reason: `deepseek-anchor: ${event.toolName} is not available in the bootstrap response`,
      };
    }
    runtime.bootstrapToolCallCount += 1;
  });

  pi.on("turn_end", async () => {
    if (
      runtime.bootstrapResponsePending
      && runtime.bootstrapToolCallCount > 0
      && runtime.config.mode === "anchored"
      && runtime.phase === "bootstrap"
    ) {
      setPhase("anchored");
    }
    runtime.bootstrapResponsePending = false;
    runtime.bootstrapToolCallCount = 0;
  });

  pi.on("message_update", async (event) => {
    if (!DEBUG || runtime.requestCount !== 1 || runtime.reasoningLogged) return;
    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type === "thinking_delta") {
      runtime.reasoningBuffer += streamEvent.delta;
      if (runtime.reasoningBuffer.length >= 120) {
        runtime.reasoningLogged = true;
        debug(`first reasoning prefix: ${JSON.stringify(runtime.reasoningBuffer.replace(/\s+/g, " ").trim().slice(0, 120))}`);
      }
    } else if (streamEvent.type === "thinking_end") {
      if (runtime.reasoningBuffer.length === 0) runtime.reasoningBuffer = streamEvent.content;
      runtime.reasoningLogged = true;
      debug(`first reasoning prefix: ${JSON.stringify(runtime.reasoningBuffer.replace(/\s+/g, " ").trim().slice(0, 120))}`);
    }
  });

  pi.registerEntryRenderer(TRANSITION_ENTRY, (entry, _options, theme) => {
    const data = entry.data as PhaseData | undefined;
    const phase = data?.phase ?? "bootstrap";
    const profile = data?.profile === "exact-dsh" ? "DSH" : "native";
    const tools = data?.tools?.length ?? 0;
    const label = phase === "anchored"
      ? `⚓ ${profile} anchored — full tool set`
      : `⚓ ${profile} bootstrap — minimal request`;
    return new Text(
      theme.fg(phase === "anchored" ? "accent" : "warning", `${label} (${tools})`),
      0,
      0,
    );
  });

  if (DEBUG) {
    debug(
      `loaded profile=${initialConfig.profile} exactToolsRegistered=${exactToolsRegistered} target=${targetKey(initialConfig)}`,
    );
  }
}

export {
  bootstrapToolsFor,
  loadConfig,
  saveConfig,
  shapeAnchoredPayload,
  shapeBootstrapPayload,
  targetKey,
};

export function inspectPayload(payload: unknown): {
  system?: string;
  tools: string[];
} {
  return {
    system: extractSystemText(payload),
    tools: listPayloadToolNames(payload),
  };
}
