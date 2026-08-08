import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  renderDiff,
  SessionManager,
  type AgentToolResult,
  type BashOperations,
  type EditToolDetails,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  selectRemoteAdapter,
  type RemoteAdapter,
  type RemoteWorkspace,
  type SshShellPreference,
} from "./adapters/index.ts";
import { createSshBackgroundShellResolver, type BackgroundShellResolverContext } from "./background.ts";
import {
  OpenSshClient,
  type SshClientOptions,
  type SshRemoteClient,
  type SshTransportPreference,
} from "./client.ts";
import {
  loadSshRemoteConfig,
  normalizeSshRemoteConfig,
  saveSshRemoteConfig,
  type SshRemoteConfig,
} from "./config.ts";
import {
  createRemoteBashOperations,
  createRemoteEditOperations,
  createRemoteReadOperations,
  createRemoteWriteOperations,
} from "./operations.ts";
import {
  DEFAULT_REMOTE_FIND_LIMIT,
  DEFAULT_REMOTE_GREP_LIMIT,
  formatRemoteFindResult,
  formatRemoteGrepResult,
  formatRemoteLsResult,
  resolveRemoteLimit,
} from "./search-tools.ts";
import { registerRemoteWorkspaceFiles } from "./workspace-files.ts";
import {
  findSshEnvironmentState,
  findSshSessionState,
  formatRemoteLocation,
  SSH_LOCAL_SESSION_STATE,
  SSH_LOCAL_SESSION_STATE_TYPE,
  SSH_SESSION_STATE_TYPE,
  SSH_SESSION_STATE_VERSION,
  type SshSessionState,
} from "./session-state.ts";
import { registerSshRemoteSettings } from "./settings.ts";
import {
  expandLocalPath,
  parseSshTarget,
  type ParsedSshTarget,
} from "./target.ts";
import { createSshTransportClient, type SshPasswordProvider } from "./transport.ts";
import { SshPasswordResolver } from "./password-resolver.ts";

const STATUS_KEY = "ssh-remote";
const CONNECT_TIMEOUT_SECONDS = 10;
const BACKGROUND_TASK_CONTROL_PROTOCOL_VERSION = 2;
export const AI_SSH_PASSWORD_PROMPT_TIMEOUT_MS = 60_000;
export const SSH_ENVIRONMENT_EVENT = "ssh-remote:environment";
const SSH_ENVIRONMENT_CONTEXT_TYPE = "ssh-remote-environment";
const AI_CONTROL_TOOL_NAMES = [
  "ssh_connect",
  "ssh_exit",
  "ssh_cd",
  "ssh_status",
] as const;
const AI_CONTROL_TOOL_NAME_SET = new Set<string>(AI_CONTROL_TOOL_NAMES);

interface SshControlToolRenderContext {
  lastComponent?: unknown;
  argsComplete?: boolean;
  executionStarted?: boolean;
  isPartial?: boolean;
}

function renderSshControlToolCall(
  toolName: string,
  argumentValue: unknown,
  theme: Theme,
  context: SshControlToolRenderContext,
): Text {
  const text = context.lastComponent instanceof Text
    ? context.lastComponent
    : new Text("", 0, 0);
  const parameter = typeof argumentValue === "string" && argumentValue.length > 0
    ? theme.fg(
        "accent",
        /^[^\s\x00-\x1f\x7f]+$/.test(argumentValue)
          ? argumentValue
          : JSON.stringify(argumentValue),
      )
    : "";
  const argumentsComplete = context.argsComplete
    || context.executionStarted
    || !context.isPartial;
  text.setText(
    theme.fg("toolTitle", theme.bold(toolName))
      + (parameter ? ` ${parameter}` : "")
      + (argumentsComplete ? "" : theme.fg("dim", " …")),
  );
  return text;
}

export type SshEnvironmentAction = "connect" | "exit" | "change-cwd";
export type SshEnvironmentActionSource =
  | "startup"
  | "restore"
  | "tree"
  | "command"
  | "tool";
export type SshEnvironmentActionStatus = "started" | "succeeded" | "failed";

export interface SshEnvironmentEvent {
  action: SshEnvironmentAction;
  source: SshEnvironmentActionSource;
  status: SshEnvironmentActionStatus;
  target?: string;
  remoteCwd?: string;
  error?: string;
}

interface ConnectionIntent {
  target: string;
  requestedCwd?: string;
  configFile?: string;
  shellPreference?: SshShellPreference;
  storedState?: SshSessionState;
  persistOnSuccess: boolean;
}

interface ActiveConnection {
  kind: "active";
  intent: ConnectionIntent;
  client: SshRemoteClient;
  adapter: RemoteAdapter;
  workspace: RemoteWorkspace;
  session: SshSessionState;
  remoteGitBranch?: string;
}

type ConnectionAttemptResult =
  | { ok: true; active: ActiveConnection }
  | {
      ok: false;
      error: string;
      restoredPrevious?: ActiveConnection;
    };

type RuntimeState =
  | { kind: "disabled" }
  | { kind: "connecting"; intent: ConnectionIntent }
  | ActiveConnection
  | { kind: "failed"; intent?: ConnectionIntent; error: string };

export interface SshRemoteExtensionDependencies {
  platform?: NodeJS.Platform;
  createClient?: (options: SshClientOptions) => SshRemoteClient;
  /** Override the transport factory (tests). */
  createTransportClient?: typeof createSshTransportClient;
  selectRemote?: typeof selectRemoteAdapter;
  loadPreviousSessionState?: (path: string) => SshSessionState | undefined;
  loadConfig?: () => SshRemoteConfig;
  saveConfig?: (config: SshRemoteConfig) => void;
  /** Override the password secrets file path (tests). */
  secretsPath?: string;
  /** Override the AI password-prompt timeout (tests). */
  aiPasswordPromptTimeoutMs?: number;
}

function defaultLoadPreviousSessionState(
  path: string,
): SshSessionState | undefined {
  const manager = SessionManager.open(path);
  return findSshSessionState(manager.getBranch());
}

function parseTransportPreference(
  value: unknown,
  fallback: SshTransportPreference,
): SshTransportPreference {
  if (value === undefined || value === "") return fallback;
  if (value === "auto" || value === "openssh" || value === "ssh2") return value;
  throw new Error("--ssh-transport must be one of: auto, openssh, ssh2");
}

function isSshAuthenticationFailure(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current);
    const message = current instanceof Error ? current.message : String(current);
    if (
      /permission denied/i.test(message)
      || /authentication (?:failed|failure)/i.test(message)
      || /all configured authentication methods failed/i.test(message)
      || /no supported authentication methods/i.test(message)
      || /unable to authenticate/i.test(message)
      || /password authentication (?:is )?required/i.test(message)
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function parseShellPreference(value: unknown): SshShellPreference {
  if (value === undefined || value === "") return "auto";
  if (
    value === "auto"
    || value === "bash"
    || value === "zsh"
    || value === "pwsh"
    || value === "powershell"
  ) {
    return value;
  }
  throw new Error(
    "--ssh-shell must be one of: auto, bash, zsh, pwsh, powershell",
  );
}

function sameStoredTarget(
  parsed: ParsedSshTarget,
  configFile: string | undefined,
  stored: SshSessionState,
): boolean {
  if (parsed.target !== stored.target || configFile !== stored.configFile) return false;
  if (!parsed.requestedCwd) return true;
  return (
    parsed.requestedCwd === stored.requestedCwd
    || parsed.requestedCwd === stored.remoteCwd
  );
}

function textResult(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function unavailableBashOperations(message: string): BashOperations {
  return {
    exec: async () => {
      throw new Error(message);
    },
  };
}

async function detectRemoteGitBranch(
  adapter: RemoteAdapter,
  workspace: RemoteWorkspace,
): Promise<string | undefined> {
  const stdout: Buffer[] = [];
  try {
    const exitCode = await adapter.runShell(
      "git -c color.ui=false branch --show-current",
      workspace.cwd,
      {
        timeoutSeconds: 5,
        captureOutput: false,
        onStdout: (data) => stdout.push(Buffer.from(data)),
      },
    );
    if (exitCode !== 0) return undefined;
  } catch {
    return undefined;
  }
  const lines = Buffer.concat(stdout)
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const branch = lines.at(-1);
  if (!branch || branch.length > 200 || /[\0-\x1f\x7f]/.test(branch))
    return undefined;
  return branch;
}

function userMessageTitle(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as { role?: unknown; content?: unknown };
  if (value.role !== "user") return undefined;

  let text: string;
  if (typeof value.content === "string") {
    text = value.content;
  } else if (Array.isArray(value.content)) {
    text = value.content
      .filter((part): part is { type: "text"; text: string } =>
        Boolean(
          part &&
            typeof part === "object" &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string",
        ),
      )
      .map((part) => part.text)
      .join(" ");
  } else {
    return undefined;
  }

  const normalized = text
    .replace(/[\0-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

function firstUserMessageTitle(entries: readonly unknown[]): string | undefined {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as { type?: unknown; message?: unknown };
    if (value.type !== "message") continue;
    const title = userMessageTitle(value.message);
    if (title) return title;
  }
  return undefined;
}

function remoteSessionLabel(
  session: SshSessionState,
  branch?: string,
  title?: string,
): string {
  const location = `SSH ${formatRemoteLocation(session)}${branch ? ` (${branch})` : ""}`;
  return title ? `${location} • ${title}` : location;
}

function replacePath(
  value: string,
  toolPath: string,
  displayPath: string,
): string {
  return value.includes(toolPath)
    ? value.split(toolPath).join(displayPath)
    : value;
}

function isInsideLocalPath(root: string, value: string): boolean {
  const fromRoot = relative(root, value);
  return fromRoot === "" || (
    fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
}

/**
 * Skills are discovered and expanded by Pi on the local client. Their system-
 * prompt locations are therefore local absolute paths even in an SSH session.
 * Keep only registered skill directories on the local read backend; every
 * other path continues to target the remote workspace.
 */
function resolveLocalSkillReadPath(
  value: string,
  cwd: string,
  pi: Pick<ExtensionAPI, "getCommands">,
): string | undefined {
  const rawPath = value.startsWith("@") ? value.slice(1) : value;
  if (
    !isAbsolute(rawPath)
    && rawPath !== "~"
    && !rawPath.startsWith("~/")
    && !rawPath.startsWith("~\\")
  ) {
    return undefined;
  }
  const localPath = expandLocalPath(rawPath, cwd);
  for (const command of pi.getCommands()) {
    if (command.source !== "skill") continue;
    const skillFile = command.sourceInfo.path;
    if (!skillFile || skillFile.startsWith("<")) continue;
    const skillRoot = resolve(dirname(skillFile));
    if (isInsideLocalPath(skillRoot, localPath)) return localPath;
  }
  return undefined;
}

function restoreToolResultPath<T extends AgentToolResult<unknown>>(
  result: T,
  toolPath: string,
  displayPath: string,
): T {
  const content = result.content.map((item) =>
    item.type === "text"
      ? { ...item, text: replacePath(item.text, toolPath, displayPath) }
      : item,
  );
  let details: unknown = result.details;
  if (details && typeof details === "object") {
    const copied = { ...details } as Record<string, unknown>;
    if (typeof copied.patch === "string") {
      copied.patch = replacePath(copied.patch, toolPath, displayPath);
    }
    details = copied;
  }
  return { ...result, content, details } as T;
}

async function withRestoredErrorPath<T>(
  toolPath: string,
  displayPath: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && error.message.includes(toolPath)) {
      throw new Error(replacePath(error.message, toolPath, displayPath), {
        cause: error,
      });
    }
    throw error;
  }
}

export function createSshRemoteExtension(
  dependencies: SshRemoteExtensionDependencies = {},
): (pi: ExtensionAPI) => void {
  const platform = dependencies.platform ?? process.platform;
  const selectRemote = dependencies.selectRemote ?? selectRemoteAdapter;
  const loadPreviousSessionState =
    dependencies.loadPreviousSessionState ?? defaultLoadPreviousSessionState;

  return function sshRemoteExtension(pi: ExtensionAPI): void {
    let config = normalizeSshRemoteConfig(
      (dependencies.loadConfig ?? loadSshRemoteConfig)(),
    );
    const saveConfig = dependencies.saveConfig ?? saveSshRemoteConfig;
    const passwordResolver = new SshPasswordResolver({
      persistPasswords: config.persistPasswords,
      secretsPath: dependencies.secretsPath,
    });
    const aiPasswordPromptTimeoutMs =
      dependencies.aiPasswordPromptTimeoutMs ?? AI_SSH_PASSWORD_PROMPT_TIMEOUT_MS;
    if (
      !Number.isFinite(aiPasswordPromptTimeoutMs)
      || aiPasswordPromptTimeoutMs <= 0
    ) {
      throw new Error("AI SSH password prompt timeout must be a positive number");
    }
    let syncAiControlTools = (): void => {};
    registerSshRemoteSettings(pi, {
      getConfig: () => config,
      updateConfig: (next, ctx) => {
        const previous = config;
        config = normalizeSshRemoteConfig(next);
        passwordResolver.setPersistPasswords(config.persistPasswords);
        try {
          saveConfig(config);
          syncAiControlTools();
          if (previous.transport !== config.transport) {
            ctx.ui.notify(
              "SSH transport saved; use /ssh-reconnect to apply it to an active workspace",
              "info",
            );
          } else if (previous.aiControlTools !== config.aiControlTools) {
            ctx.ui.notify(
              `SSH AI control tools ${config.aiControlTools ? "enabled" : "disabled"}`,
              "info",
            );
          } else if (previous.aiPasswordAuth !== config.aiPasswordAuth) {
            ctx.ui.notify(
              `SSH AI password authentication ${config.aiPasswordAuth ? "enabled" : "disabled"}`,
              "info",
            );
          } else {
            ctx.ui.notify("SSH Remote settings saved", "info");
          }
        } catch (error) {
          ctx.ui.notify(
            `Failed to save SSH Remote settings: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      },
    });

    pi.registerFlag("ssh", {
      description:
        "SSH remote workspace: host or host:path (uses OpenSSH config)",
      type: "string",
    });
    pi.registerFlag("ssh-config", {
      description: "Alternate local OpenSSH config file used with --ssh",
      type: "string",
    });
    pi.registerFlag("ssh-shell", {
      description: "Remote shell: auto, bash, zsh, pwsh, or powershell",
      type: "string",
    });
    pi.registerFlag("ssh-transport", {
      description: "SSH transport: auto, openssh, or ssh2",
      type: "string",
    });

    let runtime: RuntimeState = { kind: "disabled" };
    let autoSessionName: string | undefined;
    let autoSessionTitle: string | undefined;
    let remoteBackendsRegistered = false;
    let backgroundBackendProtocolVersion = 0;
    let backgroundTaskControlSupported = false;

    const emitEnvironmentEvent = (event: SshEnvironmentEvent): void => {
      pi.events.emit(SSH_ENVIRONMENT_EVENT, event);
    };

    registerRemoteWorkspaceFiles(pi, () =>
      runtime.kind === "active" ? runtime : undefined,
    );

    const updateStatus = (ctx: ExtensionContext): void => {
      if (runtime.kind === "disabled") {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const prefix = ctx.ui.theme.fg("muted", "SSH:");
      const [color, label] =
        runtime.kind === "connecting"
          ? (["warning", "Connecting"] as const)
          : runtime.kind === "failed"
            ? (["error", "Disconnected"] as const)
            : (["success", "Connected"] as const);
      ctx.ui.setStatus(
        STATUS_KEY,
        `${prefix} ${ctx.ui.theme.fg(color, label)}`,
      );
    };

    const fail = (
      ctx: ExtensionContext,
      error: unknown,
      intent?: ConnectionIntent,
    ): void => {
      const message = error instanceof Error ? error.message : String(error);
      runtime = { kind: "failed", intent, error: message };
      updateStatus(ctx);
      ctx.ui.notify(`SSH remote unavailable: ${message}`, "error");
    };

    const emitBackgroundBackend = (
      ctx: ExtensionContext,
      force = false,
    ): void => {
      if (remoteBackendsRegistered && !force) return;
      remoteBackendsRegistered = true;
      // Registered for every session that requests an SSH workspace. The
      // resolver reads the live runtime state on each launch: active sessions
      // run tasks on the remote (reconnecting picks up the new connection),
      // failed/connecting sessions fail closed like the routed tools, and a
      // session without SSH falls through to lower-priority local providers.
      pi.events.emit("bg:register", {
        id: "ssh-remote",
        priority: 100,
        onRegistered: (capabilities: {
          protocolVersion?: unknown;
          taskControl?: unknown;
        }) => {
          if (
            typeof capabilities.protocolVersion === "number"
            && Number.isInteger(capabilities.protocolVersion)
          ) {
            backgroundBackendProtocolVersion = Math.max(
              backgroundBackendProtocolVersion,
              capabilities.protocolVersion,
            );
          }
          if (capabilities.taskControl === true) {
            backgroundTaskControlSupported = true;
          }
        },
        resolveShell: (
          command: string,
          interactive: boolean,
          context?: BackgroundShellResolverContext,
        ) => {
          if (runtime.kind === "active") {
            const active = runtime;
            return createSshBackgroundShellResolver({
              ssh: { ...active.client.options },
              adapter: active.adapter,
              workspace: active.workspace,
              localCwd: ctx.cwd,
              acquireControlLease: () => active.client.acquireBackgroundLease?.(),
            })(command, interactive, context);
          }
          if (runtime.kind === "failed") {
            throw new Error(`SSH remote is unavailable: ${runtime.error}`);
          }
          if (runtime.kind === "connecting") {
            throw new Error(
              `SSH remote is still connecting to ${runtime.intent.target}`,
            );
          }
          return undefined;
        },
      });

      // Bash delegation protocol: on Windows, pi-pwsh-adapter registers the
      // bash tool first (pi keeps the first registration per name), so the
      // remote bash backend is delivered through its tool instead of a
      // competing registration. The resolver is consulted on every execution
      // and follows the live runtime state, so registration order does not
      // matter: active sessions run bash on the remote, failed/connecting
      // sessions fail closed, and sessions without SSH keep the local
      // PowerShell backend.
      pi.events.emit("bash:delegate", {
        resolveOperations: () => {
          const active = runtime;
          if (active.kind === "active") {
            return createRemoteBashOperations(active.adapter, (cwd) =>
              active.adapter.mapCwd(cwd, ctx.cwd, active.workspace),
            );
          }
          if (active.kind === "failed") {
            return unavailableBashOperations(
              `SSH remote is unavailable: ${active.error}`,
            );
          }
          if (active.kind === "connecting") {
            return unavailableBashOperations(
              `SSH remote is still connecting to ${active.intent.target}`,
            );
          }
          return undefined;
        },
      });
    };

    const connect = async (
      intent: ConnectionIntent,
      ctx: ExtensionContext,
      source: SshEnvironmentActionSource,
      signal?: AbortSignal,
      onPasswordPrompt?: (title: string, timeoutMs: number) => void,
    ): Promise<ConnectionAttemptResult> => {
      const previousActive = runtime.kind === "active" ? runtime : undefined;
      const preservePreviousOnFailure = previousActive !== undefined
        && (source === "command" || source === "tool");
      const aiPasswordAuthDisabled = source === "tool" && !config.aiPasswordAuth;
      runtime = { kind: "connecting", intent };
      updateStatus(ctx);
      emitEnvironmentEvent({
        action: "connect",
        source,
        status: "started",
        target: intent.target,
        remoteCwd: intent.requestedCwd,
      });

      let client: SshRemoteClient | undefined;
      try {
        if (signal?.aborted) throw new Error("SSH connection cancelled");
        const transport = parseTransportPreference(
          pi.getFlag("ssh-transport"),
          config.transport,
        );
        const clientOptions: SshClientOptions = {
          target: intent.target,
          configFile: intent.configFile,
          executable: platform === "win32" ? "ssh.exe" : undefined,
          connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS,
          batchMode: true,
        };
        // Wire the TUI password prompt into the ssh2 auth retry loop. The
        // resolver keeps per-process memory plus an optional restricted
        // secrets file so /resume and -r reuse the password without re-asking.
        passwordResolver.setUI(ctx.hasUI
          ? {
              prompt: (title, controls) => {
                if (controls?.timeoutMs !== undefined) {
                  onPasswordPrompt?.(title, controls.timeoutMs);
                }
                return ctx.ui.input(
                  title,
                  "Enter the SSH password",
                  controls
                    ? {
                        timeout: controls.timeoutMs,
                        signal: controls.signal,
                      }
                    : undefined,
                );
              },
              notify: (message, type) => ctx.ui.notify(message, type),
            }
          : undefined);
        const passwordProvider: SshPasswordProvider | undefined =
          config.passwordPrompt && !aiPasswordAuthDisabled
          ? {
              cached: (endpoint) => passwordResolver.cachedPassword(endpoint),
              retry: (endpoint, error) => passwordResolver.retryPassword(
                endpoint,
                error instanceof Error ? error.message : undefined,
                source === "tool"
                  ? {
                      timeoutMs: aiPasswordPromptTimeoutMs,
                      signal,
                    }
                  : {},
              ),
            }
          : undefined;
        const shellPreference = intent.shellPreference;
        client = dependencies.createClient
          ? dependencies.createClient(clientOptions)
          : (dependencies.createTransportClient ?? createSshTransportClient)(
              clientOptions,
              {
                platform,
                preference: transport,
                passwordProvider,
              },
            );
        const requestedCwd = intent.storedState?.remoteCwd ?? intent.requestedCwd;
        const selected = await selectRemote(client, {
          localPlatform: platform,
          preference: shellPreference,
          expectedPlatform: intent.storedState?.remotePlatform,
          expectedShell: intent.storedState?.remoteShell,
          requestedCwd,
        });
        if (signal?.aborted) throw new Error("SSH connection cancelled");
        for (const warning of selected.warnings ?? []) {
          ctx.ui.notify(warning, "warning");
        }
        const session: SshSessionState = {
          version: SSH_SESSION_STATE_VERSION,
          target: intent.target,
          remotePlatform: selected.workspace.platform,
          remoteShell: selected.workspace.shell,
          remoteCwd: selected.workspace.cwd,
          remoteHome: selected.workspace.home,
          requestedCwd: intent.storedState?.requestedCwd ?? intent.requestedCwd,
          configFile: intent.configFile,
        };
        if (intent.persistOnSuccess) pi.appendEntry(SSH_SESSION_STATE_TYPE, session);
        const activeIntent: ConnectionIntent = {
          ...intent,
          storedState: session,
          persistOnSuccess: false,
        };
        const active: ActiveConnection = {
          kind: "active",
          intent: activeIntent,
          client,
          adapter: selected.adapter,
          workspace: selected.workspace,
          session,
        };
        runtime = active;
        const baseName = remoteSessionLabel(session);
        const currentName = pi.getSessionName();
        const bracketPrefix = `[${formatRemoteLocation(session)}]`;
        const ownsSessionName =
          !currentName ||
          currentName === autoSessionName ||
          currentName === baseName ||
          currentName.startsWith(`${baseName} (`) ||
          currentName.startsWith(`${baseName} • `) ||
          currentName === bracketPrefix ||
          currentName.startsWith(`${bracketPrefix} `);
        if (ownsSessionName) {
          autoSessionTitle = firstUserMessageTitle(
            ctx.sessionManager.getBranch(),
          );
          autoSessionName = remoteSessionLabel(
            session,
            undefined,
            autoSessionTitle,
          );
          pi.setSessionName(autoSessionName);
        } else {
          autoSessionName = undefined;
          autoSessionTitle = undefined;
        }
        updateStatus(ctx);
        active.remoteGitBranch = await detectRemoteGitBranch(
          active.adapter,
          active.workspace,
        );
        if (ownsSessionName && active.remoteGitBranch) {
          autoSessionName = remoteSessionLabel(
            session,
            active.remoteGitBranch,
            autoSessionTitle,
          );
          pi.setSessionName(autoSessionName);
        }
        if (client.fallbackReason) {
          // Unix auto falls back to ssh2; Windows auto falls back to
          // OpenSSH. Name the actual delegate transport.
          const fallbackTransport = client.transport === "ssh2"
            ? "ssh2"
            : client.transport === "openssh"
              ? "OpenSSH"
              : "another transport";
          ctx.ui.notify(
            `SSH transport auto fell back to ${fallbackTransport}: ${client.fallbackReason}`,
            "warning",
          );
        }
        for (const warning of client.compatibilityWarnings ?? []) {
          ctx.ui.notify(`ssh2 compatibility: ${warning}`, "warning");
        }
        const transportLabel = client.transport === "ssh2"
          ? "ssh2/persistent"
          : client.transport === "openssh"
            ? client.reusesConnection
              ? "OpenSSH/multiplexed"
              : "OpenSSH/single-use"
            : "custom transport";
        ctx.ui.notify(
          `SSH remote active: ${formatRemoteLocation(session)} `
            + `(${session.remotePlatform}/${session.remoteShell}; ${transportLabel})`,
          "info",
        );
        emitEnvironmentEvent({
          action: "connect",
          source,
          status: "succeeded",
          target: session.target,
          remoteCwd: session.remoteCwd,
        });
        if (previousActive && previousActive.client !== client) {
          try {
            await previousActive.client.dispose({ preserveBackgroundSessions: true });
          } catch (error) {
            ctx.ui.notify(
              `Previous SSH connection cleanup warning: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
          }
        }
        return { ok: true, active };
      } catch (error) {
        const connectionError = aiPasswordAuthDisabled
          && isSshAuthenticationFailure(error)
          ? new Error(
              `SSH password authentication is required for ${intent.target}, but AI password authentication is disabled. `
                + "Configure SSH key-based login (recommended), or enable AI password auth in /99settings.",
              { cause: error },
            )
          : error;
        const message = connectionError instanceof Error
          ? connectionError.message
          : String(connectionError);
        if (client && client !== previousActive?.client) {
          try {
            await client.dispose();
          } catch {
            // Keep the original connection error.
          }
        }
        if (preservePreviousOnFailure) {
          runtime = previousActive;
          updateStatus(ctx);
          ctx.ui.notify(
            `SSH switch to ${intent.target} failed; still connected to ${formatRemoteLocation(previousActive.session)}: ${message}`,
            "error",
          );
        } else {
          if (previousActive) {
            try {
              await previousActive.client.dispose({ preserveBackgroundSessions: true });
            } catch {
              // The requested branch must fail closed even if cleanup fails.
            }
          }
          fail(ctx, connectionError, intent);
        }
        emitEnvironmentEvent({
          action: "connect",
          source,
          status: "failed",
          target: intent.target,
          remoteCwd: intent.requestedCwd,
          error: message,
        });
        return {
          ok: false,
          error: message,
          restoredPrevious: preservePreviousOnFailure
            ? previousActive
            : undefined,
        };
      }
    };

    const disconnect = async (
      ctx: ExtensionContext,
      source: SshEnvironmentActionSource,
      options: { persist: boolean; notify?: boolean },
    ): Promise<boolean> => {
      if (runtime.kind === "disabled") {
        if (options.notify !== false) {
          ctx.ui.notify("The current workspace is already local", "info");
        }
        return false;
      }
      if (runtime.kind === "connecting") {
        throw new Error(`SSH is still connecting to ${runtime.intent.target}`);
      }

      const previous = runtime;
      const target = previous.kind === "active"
        ? previous.session.target
        : previous.intent?.target;
      const remoteCwd = previous.kind === "active"
        ? previous.session.remoteCwd
        : previous.intent?.requestedCwd;
      emitEnvironmentEvent({
        action: "exit",
        source,
        status: "started",
        target,
        remoteCwd,
      });

      let disposeError: string | undefined;
      if (previous.kind === "active") {
        try {
          await previous.client.dispose({ preserveBackgroundSessions: true });
        } catch (error) {
          disposeError = error instanceof Error ? error.message : String(error);
        }
      }
      runtime = { kind: "disabled" };
      // The named provider remains registered and now falls through locally.
      // Re-emitting on a later connect refreshes protocol acknowledgement after
      // an extension reload.
      remoteBackendsRegistered = false;
      passwordResolver.setUI(undefined);
      updateStatus(ctx);
      if (pi.getSessionName() === autoSessionName) pi.setSessionName("");
      autoSessionName = undefined;
      autoSessionTitle = undefined;
      if (options.persist) {
        pi.appendEntry(SSH_LOCAL_SESSION_STATE_TYPE, SSH_LOCAL_SESSION_STATE);
      }
      if (disposeError) {
        ctx.ui.notify(`SSH connection cleanup warning: ${disposeError}`, "warning");
      }
      if (options.notify !== false) {
        ctx.ui.notify(`Local workspace active: ${ctx.cwd}`, "info");
      }
      emitEnvironmentEvent({
        action: "exit",
        source,
        status: "succeeded",
        target,
        remoteCwd,
      });
      return true;
    };

    const changeRemoteCwd = async (
      value: string,
      ctx: ExtensionContext,
      source: SshEnvironmentActionSource,
      signal?: AbortSignal,
    ): Promise<ActiveConnection> => {
      if (runtime.kind !== "active") {
        if (runtime.kind === "failed") {
          throw new Error(`SSH remote is unavailable: ${runtime.error}`);
        }
        if (runtime.kind === "connecting") {
          throw new Error(`SSH is still connecting to ${runtime.intent.target}`);
        }
        throw new Error("The current workspace is local; use /ssh-connect first");
      }
      const active = runtime;
      // ssh_cd receives an explicitly remote path. Do not use mapCwd here:
      // mapCwd intentionally translates absolute paths under Pi's local cwd
      // into the remote workspace for delegated bash/background operations.
      const requested = active.adapter.fromToolPath(
        active.adapter.toToolPath(value, active.workspace),
      );
      emitEnvironmentEvent({
        action: "change-cwd",
        source,
        status: "started",
        target: active.session.target,
        remoteCwd: requested,
      });
      try {
        if (signal?.aborted) throw new Error("SSH cwd change cancelled");
        const workspace = await active.adapter.inspectWorkspace(requested);
        if (signal?.aborted) throw new Error("SSH cwd change cancelled");
        const session: SshSessionState = {
          ...active.session,
          remotePlatform: workspace.platform,
          remoteShell: workspace.shell,
          remoteCwd: workspace.cwd,
          remoteHome: workspace.home,
          requestedCwd: workspace.cwd,
        };
        const ownsSessionName = pi.getSessionName() === autoSessionName;
        active.workspace = workspace;
        active.session = session;
        active.intent = {
          ...active.intent,
          requestedCwd: workspace.cwd,
          storedState: session,
          persistOnSuccess: false,
        };
        pi.appendEntry(SSH_SESSION_STATE_TYPE, session);
        active.remoteGitBranch = await detectRemoteGitBranch(
          active.adapter,
          active.workspace,
        );
        if (ownsSessionName) {
          autoSessionName = remoteSessionLabel(
            session,
            active.remoteGitBranch,
            autoSessionTitle,
          );
          pi.setSessionName(autoSessionName);
        }
        updateStatus(ctx);
        ctx.ui.notify(
          `SSH remote cwd changed: ${formatRemoteLocation(session)}`,
          "info",
        );
        emitEnvironmentEvent({
          action: "change-cwd",
          source,
          status: "succeeded",
          target: session.target,
          remoteCwd: session.remoteCwd,
        });
        return active;
      } catch (error) {
        emitEnvironmentEvent({
          action: "change-cwd",
          source,
          status: "failed",
          target: active.session.target,
          remoteCwd: requested,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };

    const createExplicitIntent = (
      value: string,
      ctx: ExtensionContext,
    ): ConnectionIntent => {
      const parsed = parseSshTarget(value);
      const configFlag = pi.getFlag("ssh-config") as string | undefined;
      return {
        ...parsed,
        configFile: configFlag ? expandLocalPath(configFlag, ctx.cwd) : undefined,
        shellPreference: parseShellPreference(pi.getFlag("ssh-shell")),
        persistOnSuccess: true,
      };
    };

    const formatStatus = (ctx: ExtensionContext): string => {
      if (runtime.kind === "disabled") {
        return `Workspace: local\ncwd: ${ctx.cwd}`;
      }
      if (runtime.kind === "connecting") {
        return `Workspace: SSH connecting\ntarget: ${runtime.intent.target}`;
      }
      if (runtime.kind === "failed") {
        return [
          "Workspace: SSH unavailable",
          runtime.intent?.target ? `target: ${runtime.intent.target}` : undefined,
          `error: ${runtime.error}`,
        ].filter((line): line is string => Boolean(line)).join("\n");
      }
      return [
        "Workspace: SSH",
        `SSH target: ${runtime.session.target}`,
        `platform: ${runtime.session.remotePlatform}`,
        `shell: ${runtime.session.remoteShell}`,
        `transport: ${runtime.client.transport ?? "custom"}${runtime.client.reusesConnection === undefined ? "" : runtime.client.reusesConnection ? " (reused)" : " (single-use)"}`,
        runtime.client.fallbackReason
          ? `transport fallback: ${runtime.client.fallbackReason}`
          : undefined,
        `cwd: ${runtime.session.remoteCwd}`,
        `home: ${runtime.session.remoteHome}`,
        runtime.session.configFile
          ? `Config file: ${runtime.session.configFile}`
          : undefined,
      ].filter((line): line is string => Boolean(line)).join("\n");
    };

    const resolveIntent = (
      event: { reason: string; previousSessionFile?: string },
      ctx: ExtensionContext,
    ): ConnectionIntent | undefined => {
      const stored = findSshSessionState(ctx.sessionManager.getBranch());
      const sshFlag = pi.getFlag("ssh") as string | undefined;
      const configFlag = pi.getFlag("ssh-config") as string | undefined;
      const configFile = configFlag
        ? expandLocalPath(configFlag, ctx.cwd)
        : undefined;
      const shellPreference = parseShellPreference(pi.getFlag("ssh-shell"));
      if (stored) {
        const explicitShell = shellPreference !== "auto"
          ? shellPreference
          : undefined;
        if (sshFlag) {
          const parsed = parseSshTarget(sshFlag);
          const effectiveConfig = configFile ?? stored.configFile;
          if (!sameStoredTarget(parsed, effectiveConfig, stored)) {
            throw new Error(
              `The resumed session is bound to ${formatRemoteLocation(stored)}; `
                + "the current --ssh arguments select a different workspace.",
            );
          }
        } else if (configFile && configFile !== stored.configFile) {
          throw new Error("The resumed session uses a different OpenSSH config file");
        } else if (explicitShell && explicitShell !== stored.remoteShell) {
          throw new Error("The resumed session uses a different remote shell");
        }
        return {
          target: stored.target,
          requestedCwd: stored.remoteCwd,
          configFile: stored.configFile,
          shellPreference: explicitShell ?? stored.remoteShell,
          storedState: stored,
          persistOnSuccess: false,
        };
      }

      if (sshFlag) {
        const parsed = parseSshTarget(sshFlag);
        return {
          ...parsed,
          configFile,
          shellPreference,
          persistOnSuccess: true,
        };
      }

      if (configFile || shellPreference !== "auto") {
        throw new Error(
          "--ssh-config and --ssh-shell require --ssh for a new remote session",
        );
      }

      if (event.reason === "new" && event.previousSessionFile) {
        try {
          const inherited = loadPreviousSessionState(event.previousSessionFile);
          if (inherited) {
            return {
              target: inherited.target,
              requestedCwd: inherited.remoteCwd,
              configFile: inherited.configFile,
              shellPreference: inherited.remoteShell,
              storedState: inherited,
              persistOnSuccess: false,
            };
          }
        } catch {
          // A missing or unreadable previous session should not prevent /new.
        }
      }
      return undefined;
    };


    const requireActive = (): ActiveConnection | undefined => {
      if (runtime.kind === "disabled") return undefined;
      if (runtime.kind === "active") return runtime;
      if (runtime.kind === "connecting") {
        throw new Error(
          `SSH remote is still connecting to ${runtime.intent.target}`,
        );
      }
      throw new Error(`SSH remote is unavailable: ${runtime.error}`);
    };

    const toolCwd = (active: ActiveConnection): string =>
      active.adapter.toToolPath(active.workspace.cwd, active.workspace);

    const readTemplate = createReadToolDefinition(process.cwd());
    const writeTemplate = createWriteToolDefinition(process.cwd());
    const editTemplate = createEditToolDefinition(process.cwd());
    const bashTemplate = createBashToolDefinition(process.cwd());
    const grepTemplate = createGrepToolDefinition(process.cwd());
    const findTemplate = createFindToolDefinition(process.cwd());
    const lsTemplate = createLsToolDefinition(process.cwd());

    const remoteSearchPath = (
      active: ActiveConnection,
      value: string | undefined,
      localCwd: string,
    ): string => {
      const nativePath = active.adapter.mapCwd(
        value || ".",
        localCwd,
        active.workspace,
      );
      return active.adapter.toToolPath(nativePath, active.workspace);
    };

    const remoteReadTool: typeof readTemplate = {
      ...readTemplate,
      promptGuidelines: [
        ...(readTemplate.promptGuidelines ?? []),
        "When the SSH Remote environment context is present, read resolves paths in that remote workspace rather than Pi's local cwd.",
      ],
      async execute(id, params, signal, onUpdate, ctx) {
        const localSkillPath = resolveLocalSkillReadPath(
          params.path,
          ctx.cwd,
          pi,
        );
        if (runtime.kind === "disabled" || localSkillPath) {
          return createReadToolDefinition(ctx.cwd).execute(
            id,
            localSkillPath ? { ...params, path: localSkillPath } : params,
            signal,
            onUpdate,
            ctx,
          );
        }
        const active = requireActive();
        if (!active) {
          return createReadToolDefinition(ctx.cwd).execute(
            id,
            params,
            signal,
            onUpdate,
            ctx,
          );
        }
        const displayPath = params.path;
        const path = active.adapter.toToolPath(displayPath, active.workspace);
        return withRestoredErrorPath(path, displayPath, async () => {
          const result = await createReadToolDefinition(toolCwd(active), {
            operations: createRemoteReadOperations(active.adapter, signal),
          }).execute(id, { ...params, path }, signal, onUpdate, ctx);
          return restoreToolResultPath(result, path, displayPath);
        });
      },
    };

    const remoteWriteTool: typeof writeTemplate = {
      ...writeTemplate,
      promptGuidelines: [
        ...(writeTemplate.promptGuidelines ?? []),
        "When the SSH Remote environment context is present, write modifies files in that remote workspace rather than Pi's local cwd.",
      ],
      async execute(id, params, signal, onUpdate, ctx) {
        const active = requireActive();
        if (!active) {
          return createWriteToolDefinition(ctx.cwd).execute(
            id,
            params,
            signal,
            onUpdate,
            ctx,
          );
        }
        const displayPath = params.path;
        const path = active.adapter.toToolPath(displayPath, active.workspace);
        return withRestoredErrorPath(path, displayPath, async () => {
          const result = await createWriteToolDefinition(toolCwd(active), {
            operations: createRemoteWriteOperations(active.adapter, signal),
          }).execute(id, { ...params, path }, signal, onUpdate, ctx);
          return restoreToolResultPath(result, path, displayPath);
        });
      },
    };

    const remoteGrepTool: typeof grepTemplate = {
      ...grepTemplate,
      promptGuidelines: [
        ...(grepTemplate.promptGuidelines ?? []),
        "When the SSH Remote environment context is present, grep searches that remote workspace.",
      ],
      async execute(id, params, signal, onUpdate, ctx) {
        const active = requireActive();
        if (!active) {
          return createGrepToolDefinition(ctx.cwd).execute(
            id,
            params,
            signal,
            onUpdate,
            ctx,
          );
        }
        const path = remoteSearchPath(active, params.path, ctx.cwd);
        const limit = resolveRemoteLimit(
          params.limit,
          DEFAULT_REMOTE_GREP_LIMIT,
        );
        const matches = await active.adapter.grep(
          path,
          params.pattern,
          {
            glob: params.glob,
            ignoreCase: params.ignoreCase,
            literal: params.literal,
            limit,
          },
          signal,
        );
        return formatRemoteGrepResult(
          active.adapter,
          matches,
          limit,
          params.context,
          signal,
        );
      },
    };

    const remoteFindTool: typeof findTemplate = {
      ...findTemplate,
      promptGuidelines: [
        ...(findTemplate.promptGuidelines ?? []),
        "When the SSH Remote environment context is present, find searches that remote workspace.",
      ],
      async execute(id, params, signal, onUpdate, ctx) {
        const active = requireActive();
        if (!active) {
          return createFindToolDefinition(ctx.cwd).execute(
            id,
            params,
            signal,
            onUpdate,
            ctx,
          );
        }
        const path = remoteSearchPath(active, params.path, ctx.cwd);
        const limit = resolveRemoteLimit(
          params.limit,
          DEFAULT_REMOTE_FIND_LIMIT,
        );
        const entries = await active.adapter.findEntries(
          path,
          params.pattern,
          limit,
          signal,
        );
        return formatRemoteFindResult(entries, limit);
      },
    };

    const remoteLsTool: typeof lsTemplate = {
      ...lsTemplate,
      promptGuidelines: [
        ...(lsTemplate.promptGuidelines ?? []),
        "When the SSH Remote environment context is present, ls lists that remote workspace.",
      ],
      async execute(id, params, signal, onUpdate, ctx) {
        const active = requireActive();
        if (!active) {
          return createLsToolDefinition(ctx.cwd).execute(
            id,
            params,
            signal,
            onUpdate,
            ctx,
          );
        }
        const path = remoteSearchPath(active, params.path, ctx.cwd);
        const entries = await active.adapter.listDirectory(path, signal);
        return formatRemoteLsResult(entries, params.limit);
      },
    };

    const remoteEditTool: typeof editTemplate = {
      ...editTemplate,
      promptGuidelines: [
        ...(editTemplate.promptGuidelines ?? []),
        "When the SSH Remote environment context is present, edit modifies files in that remote workspace rather than Pi's local cwd.",
      ],
      async execute(id, params, signal, onUpdate, ctx) {
        const active = requireActive();
        if (!active) {
          return createEditToolDefinition(ctx.cwd).execute(
            id,
            params,
            signal,
            onUpdate,
            ctx,
          );
        }
        const displayPath = params.path;
        const path = active.adapter.toToolPath(displayPath, active.workspace);
        return withRestoredErrorPath(path, displayPath, async () => {
          const result = await createEditToolDefinition(toolCwd(active), {
            operations: createRemoteEditOperations(active.adapter, signal),
          }).execute(id, { ...params, path }, signal, onUpdate, ctx);
          return restoreToolResultPath(result, path, displayPath);
        });
      },
      renderCall(args, theme, context) {
        if (runtime.kind === "disabled") {
          return editTemplate.renderCall!(args, theme, context);
        }
        const state = context.state as unknown as { remoteCall?: Box };
        const box =
          state.remoteCall ??
          new Box(1, 1, (text) => theme.bg("toolPendingBg", text));
        state.remoteCall = box;
        box.setBgFn((text) => theme.bg("toolPendingBg", text));
        box.clear();
        const path = typeof args.path === "string" ? args.path : "";
        box.addChild(
          new Text(
            `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path)}`,
            0,
            0,
          ),
        );
        return box;
      },
      renderResult(result, options, theme, context) {
        const editResult = result as AgentToolResult<
          EditToolDetails | undefined
        >;
        if (runtime.kind === "disabled") {
          return editTemplate.renderResult!(
            editResult,
            options,
            theme,
            context,
          );
        }
        const state = context.state as unknown as { remoteCall?: Box };
        const box = state.remoteCall;
        if (box && !options.isPartial) {
          box.setBgFn((text) =>
            theme.bg(context.isError ? "toolErrorBg" : "toolSuccessBg", text),
          );
          box.clear();
          const path =
            typeof context.args.path === "string" ? context.args.path : "";
          box.addChild(
            new Text(
              `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path)}`,
              0,
              0,
            ),
          );
          const output = textResult(editResult);
          if (context.isError && output) {
            box.addChild(new Spacer(1));
            box.addChild(new Text(theme.fg("error", output), 0, 0));
          } else if (editResult.details?.diff) {
            box.addChild(new Spacer(1));
            box.addChild(
              new Text(
                renderDiff(editResult.details.diff, { filePath: path }),
                0,
                0,
              ),
            );
          }
        }
        const empty =
          context.lastComponent instanceof Container
            ? context.lastComponent
            : new Container();
        empty.clear();
        return empty;
      },
    };

    const remoteBashTool: typeof bashTemplate = {
      ...bashTemplate,
      description: bashTemplate.description.replace(
        "Execute a bash command in the current working directory.",
                "Execute a command in the active workspace shell. Local and remote Unix workspaces use the detected default shell (Bash, Zsh); remote Windows workspaces use PowerShell.",
      ),
      promptSnippet:
        "Execute commands in the active local or remote workspace shell",
      promptGuidelines: [
        ...(bashTemplate.promptGuidelines ?? []),
        "When the SSH Remote environment context is present, bash runs in that remote cwd and must use its stated shell syntax.",
      ],
      async execute(id, params, signal, onUpdate, ctx) {
        const active = requireActive();
        if (!active) {
          return createBashToolDefinition(ctx.cwd).execute(
            id,
            params,
            signal,
            onUpdate,
            ctx,
          );
        }
        return createBashToolDefinition(active.workspace.cwd, {
          operations: createRemoteBashOperations(active.adapter),
        }).execute(id, params, signal, onUpdate, ctx);
      },
    };

    let remoteToolsRegistered = false;
    const registerRemoteTools = (): void => {
      if (remoteToolsRegistered) return;
      remoteToolsRegistered = true;
      const activeTools = pi.getActiveTools();
      pi.registerTool(remoteReadTool);
      pi.registerTool(remoteWriteTool);
      pi.registerTool(remoteGrepTool);
      pi.registerTool(remoteFindTool);
      pi.registerTool(remoteLsTool);
      pi.registerTool(remoteEditTool);
      pi.registerTool(remoteBashTool);
      // Dynamic registration may refresh extension tools as active. Preserve
      // the exact pre-SSH selection, including optional grep/find/ls state.
      pi.setActiveTools(activeTools);
    };

    const ensureRemoteRouting = (ctx: ExtensionContext): void => {
      registerRemoteTools();
      emitBackgroundBackend(ctx);
    };

    pi.registerCommand("ssh-connect", {
      description: "Connect or switch the current session to an SSH workspace: /ssh-connect host[:path]",
      handler: async (args, ctx) => {
        await ctx.waitForIdle();
        const target = args.trim();
        if (!target) {
          ctx.ui.notify("Usage: /ssh-connect <host[:path]>", "warning");
          return;
        }
        if (runtime.kind === "connecting") {
          ctx.ui.notify(`SSH is still connecting to ${runtime.intent.target}`, "warning");
          return;
        }
        try {
          const intent = createExplicitIntent(target, ctx);
          ensureRemoteRouting(ctx);
          await connect(intent, ctx, "command");
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    });

    pi.registerCommand("ssh-exit", {
      description: "Exit the SSH workspace and return this session to its local workspace",
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        try {
          await disconnect(ctx, "command", { persist: true });
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    });

    pi.registerCommand("ssh-cd", {
      description: "Change the persistent cwd of the current SSH workspace",
      handler: async (args, ctx) => {
        await ctx.waitForIdle();
        const path = args.trim();
        if (!path) {
          ctx.ui.notify("Usage: /ssh-cd <remote-path>", "warning");
          return;
        }
        try {
          await changeRemoteCwd(path, ctx, "command");
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    });

    pi.registerCommand("ssh-status", {
      description: "Show the active local or SSH workspace status",
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          formatStatus(ctx),
          runtime.kind === "failed" ? "error" : "info",
        );
      },
    });

    pi.registerCommand("ssh-reconnect", {
      description: "Reconnect the current SSH remote workspace",
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        const intent =
          runtime.kind === "active" || runtime.kind === "connecting"
            ? runtime.intent
            : runtime.kind === "failed"
              ? runtime.intent
              : undefined;
        if (!intent) {
          ctx.ui.notify("This session has no SSH remote target", "warning");
          return;
        }
        ensureRemoteRouting(ctx);
        await connect(
          { ...intent, persistOnSuccess: intent.persistOnSuccess },
          ctx,
          "command",
        );
      },
    });

    pi.registerCommand("ssh-forget-password", {
      description: "Forget SSH passwords used by this session, or all cached passwords with: /ssh-forget-password all",
      handler: async (args, ctx) => {
        const scope = args.trim().toLowerCase();
        if (scope !== "" && scope !== "all") {
          ctx.ui.notify(
            "Usage: /ssh-forget-password [all]",
            "warning",
          );
          return;
        }
        await ctx.waitForIdle();
        if (scope === "all") {
          const count = passwordResolver.forgetAll();
          ctx.ui.notify(
            count === 0
              ? "No cached SSH passwords to forget"
              : `Forgot ${count} cached SSH password${count === 1 ? "" : "s"} across all sessions`,
            "info",
          );
          return;
        }
        const count = passwordResolver.forgetCurrentSession();
        ctx.ui.notify(
          count === 0
            ? "No cached SSH passwords were used by this session"
            : `Forgot ${count} cached SSH password${count === 1 ? "" : "s"} used by this session`,
          "info",
        );
      },
    });

    const assertAiControlToolsEnabled = (): void => {
      if (!config.aiControlTools) {
        throw new Error("SSH AI control tools are disabled in /99settings");
      }
    };

    let aiControlToolsRegistered = false;
    const ensureAiControlToolsRegistered = (): void => {
      if (aiControlToolsRegistered) return;
      aiControlToolsRegistered = true;

      pi.registerTool({
        name: "ssh_connect",
        label: "SSH Connect",
        description: "Connect the current Pi session to an SSH workspace, replacing an active SSH target without requiring ssh_exit first. The target accepts host or host:path syntax. When AI password authentication is enabled, each password required by the target or its ProxyJump chain must be entered by the user in Pi's UI within 60 seconds; otherwise key-based login is required.",
        promptSnippet: "Connect or switch the current session to an SSH workspace",
        promptGuidelines: [
          "Use ssh_connect when the user asks to enter an SSH workspace or switch directly from the active SSH target to another one; do not call ssh_exit before switching targets.",
          "Before calling ssh_connect, tell the user that Pi may show one or more SSH password prompts when AI password auth is enabled and that they must enter each password themselves within 60 seconds; never ask the user to send a password in chat.",
          "If AI password auth is disabled and key authentication fails, ssh_connect fails immediately and recommends configuring SSH key-based login; do not retry until the key or setting changes.",
          "If ssh_connect fails from a local workspace, it returns to local automatically; if a target switch fails, the previous SSH workspace remains active. Do not call ssh_exit just to clean up either failure.",
          "Do not combine ssh_connect with workspace file or shell operations in the same tool batch; connect first, then inspect the resulting SSH environment.",
        ],
        parameters: Type.Object({
          target: Type.String({
            description: "SSH target as host, user@host, or host:path",
            minLength: 1,
          }),
        }),
        executionMode: "sequential",
        renderCall(args, theme, context) {
          return renderSshControlToolCall(
            "ssh_connect",
            args.target,
            theme,
            context,
          );
        },
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          assertAiControlToolsEnabled();
          if (runtime.kind === "connecting") {
            throw new Error(`SSH is still connecting to ${runtime.intent.target}`);
          }
          const intent = createExplicitIntent(params.target, ctx);
          ensureRemoteRouting(ctx);
          const attempt = await connect(
            intent,
            ctx,
            "tool",
            signal,
            (title, timeoutMs) => {
              const seconds = Math.ceil(timeoutMs / 1000);
              onUpdate?.({
                content: [{
                  type: "text",
                  text:
                    `${title} requires user input. Enter the password in Pi's UI `
                    + `within ${seconds} second${seconds === 1 ? "" : "s"}; `
                    + "the model cannot enter it.",
                }],
                details: {
                  action: "connect",
                  phase: "waiting-password",
                  passwordPromptTimeoutMs: timeoutMs,
                },
              });
            },
          );
          if (!attempt.ok) {
            if (attempt.restoredPrevious) {
              throw new Error(
                `SSH switch to ${intent.target} failed; the previous workspace `
                  + `${formatRemoteLocation(attempt.restoredPrevious.session)} `
                  + `remains active: ${attempt.error}`,
              );
            }
            await disconnect(ctx, "tool", { persist: true, notify: false });
            throw new Error(
              "SSH connection failed and the session automatically returned "
                + `to its local workspace: ${attempt.error}`,
            );
          }
          const { active } = attempt;
          return {
            content: [{
              type: "text",
              text: `SSH workspace active: ${formatRemoteLocation(active.session)} (${active.session.remotePlatform}/${active.session.remoteShell})`,
            }],
            details: {
              action: "connect",
              target: active.session.target,
              cwd: active.session.remoteCwd,
            },
          };
        },
      });

      pi.registerTool({
        name: "ssh_exit",
        label: "SSH Exit",
        description: "Exit the active SSH workspace and route the current Pi session back to its local workspace.",
        promptSnippet: "Exit SSH and return the current session to its local workspace",
        promptGuidelines: [
          "Use ssh_exit only when the user asks to return the current session to its local workspace.",
          "Do not combine ssh_exit with workspace file or shell operations in the same tool batch; exit first, then inspect the local environment.",
        ],
        parameters: Type.Object({}),
        executionMode: "sequential",
        renderCall(_args, theme, context) {
          return renderSshControlToolCall(
            "ssh_exit",
            undefined,
            theme,
            context,
          );
        },
        async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
          assertAiControlToolsEnabled();
          if (signal?.aborted) throw new Error("SSH exit cancelled");
          const changed = await disconnect(ctx, "tool", { persist: true });
          return {
            content: [{
              type: "text",
              text: changed
                ? `Local workspace active: ${ctx.cwd}`
                : `Workspace already local: ${ctx.cwd}`,
            }],
            details: { action: "exit", cwd: ctx.cwd, changed },
          };
        },
      });

      pi.registerTool({
        name: "ssh_cd",
        label: "SSH Cwd",
        description: "Change the persistent working directory of the active SSH workspace. Relative paths resolve from the current remote cwd.",
        promptSnippet: "Change the cwd of the active SSH workspace",
        promptGuidelines: [
          "Use ssh_cd when the user asks to change the active SSH workspace directory; subsequent workspace tools use the resolved remote cwd.",
          "Do not combine ssh_cd with workspace file or shell operations in the same tool batch; change cwd first, then inspect it.",
        ],
        parameters: Type.Object({
          path: Type.String({ description: "Remote directory path", minLength: 1 }),
        }),
        executionMode: "sequential",
        renderCall(args, theme, context) {
          return renderSshControlToolCall(
            "ssh_cd",
            args.path,
            theme,
            context,
          );
        },
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          assertAiControlToolsEnabled();
          const active = await changeRemoteCwd(params.path, ctx, "tool", signal);
          return {
            content: [{
              type: "text",
              text: `SSH remote cwd active: ${formatRemoteLocation(active.session)}`,
            }],
            details: {
              action: "change-cwd",
              target: active.session.target,
              cwd: active.session.remoteCwd,
            },
          };
        },
      });

      pi.registerTool({
        name: "ssh_status",
        label: "SSH Status",
        description: "Report whether the current Pi session uses its local workspace or an SSH workspace, including target, cwd, shell, and transport.",
        promptSnippet: "Inspect the current local or SSH workspace environment",
        promptGuidelines: [
          "Use ssh_status when the current local or SSH workspace environment is unclear.",
        ],
        parameters: Type.Object({}),
        executionMode: "parallel",
        renderCall(_args, theme, context) {
          return renderSshControlToolCall(
            "ssh_status",
            undefined,
            theme,
            context,
          );
        },
        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
          assertAiControlToolsEnabled();
          return {
            content: [{ type: "text", text: formatStatus(ctx) }],
            details: {
              kind: runtime.kind,
              session: runtime.kind === "active" ? runtime.session : undefined,
            },
          };
        },
      });
    };

    syncAiControlTools = (): void => {
      if (config.aiControlTools) {
        // Register the live local/remote wrappers before the model can emit an
        // ssh_connect call alongside workspace tools in the same response.
        // The sequential connect runs first; later wrappers in that batch then
        // consult the updated runtime instead of using captured local tools.
        registerRemoteTools();
        ensureAiControlToolsRegistered();
      }
      if (!aiControlToolsRegistered) return;
      const withoutAiTools = pi.getActiveTools().filter(
        (name) => !AI_CONTROL_TOOL_NAME_SET.has(name),
      );
      const next = config.aiControlTools
        ? [...withoutAiTools, ...AI_CONTROL_TOOL_NAMES]
        : withoutAiTools;
      const current = pi.getActiveTools();
      if (
        current.length !== next.length
        || current.some((name, index) => name !== next[index])
      ) {
        pi.setActiveTools(next);
      }
    };

    pi.on("session_start", async (event, ctx) => {
      runtime = { kind: "disabled" };
      autoSessionName = undefined;
      autoSessionTitle = undefined;
      syncAiControlTools();
      let intent: ConnectionIntent | undefined;
      try {
        intent = resolveIntent(event, ctx);
      } catch (error) {
        ensureRemoteRouting(ctx);
        fail(ctx, error);
        return;
      }
      if (!intent) {
        updateStatus(ctx);
        return;
      }
      ensureRemoteRouting(ctx);
      await connect(
        intent,
        ctx,
        event.reason === "startup" ? "startup" : "restore",
      );
    });

    pi.on("session_tree", async (_event, ctx) => {
      const environment = findSshEnvironmentState(ctx.sessionManager.getBranch());
      try {
        if (environment?.mode === "remote") {
          const stored = environment.session;
          if (
            runtime.kind === "active"
            && runtime.session.target === stored.target
            && runtime.session.remotePlatform === stored.remotePlatform
            && runtime.session.remoteShell === stored.remoteShell
            && runtime.session.remoteCwd === stored.remoteCwd
            && runtime.session.configFile === stored.configFile
          ) {
            return;
          }
          ensureRemoteRouting(ctx);
          await connect({
            target: stored.target,
            requestedCwd: stored.remoteCwd,
            configFile: stored.configFile,
            shellPreference: stored.remoteShell,
            storedState: stored,
            persistOnSuccess: false,
          }, ctx, "tree");
          return;
        }
        if (runtime.kind !== "disabled") {
          await disconnect(ctx, "tree", { persist: false });
        }
      } catch (error) {
        ctx.ui.notify(
          `Could not restore SSH environment for this branch: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    });

    pi.on("message_end", (event) => {
      if (
        runtime.kind !== "active" ||
        autoSessionTitle ||
        pi.getSessionName() !== autoSessionName
      ) {
        return;
      }
      const title = userMessageTitle(event.message);
      if (!title) return;
      autoSessionTitle = title;
      autoSessionName = remoteSessionLabel(
        runtime.session,
        runtime.remoteGitBranch,
        autoSessionTitle,
      );
      pi.setSessionName(autoSessionName);
    });

    pi.on("tool_call", (event, ctx) => {
      // Background Tasks protocol v2 keeps named providers instead of relying
      // on last-writer registration. Re-emit only when a dynamically loaded or
      // outdated Background Tasks extension has not acknowledged that protocol.
      if (event.toolName !== "bg_start") return;
      if (runtime.kind === "active") {
        if (
          backgroundBackendProtocolVersion < BACKGROUND_TASK_CONTROL_PROTOCOL_VERSION
          || !backgroundTaskControlSupported
        ) {
          emitBackgroundBackend(ctx, true);
        }
        if (
          backgroundBackendProtocolVersion < BACKGROUND_TASK_CONTROL_PROTOCOL_VERSION
          || !backgroundTaskControlSupported
        ) {
          return {
            block: true,
            reason:
              "SSH background tasks require @99percentpeople/pi-background-tasks with task-control protocol v2 support. Update Background Tasks and reload Pi.",
          };
        }
        return undefined;
      }
      if (runtime.kind === "failed") {
        return { block: true, reason: `SSH remote is unavailable: ${runtime.error}` };
      }
      if (runtime.kind === "connecting") {
        return {
          block: true,
          reason: `SSH remote is still connecting to ${runtime.intent.target}`,
        };
      }
      return undefined;
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      if (runtime.kind === "active") await runtime.client.dispose();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      runtime = { kind: "disabled" };
    });

    pi.on("user_bash", (_event, ctx) => {
      if (runtime.kind === "disabled") return;
      if (runtime.kind !== "active") {
        const message =
          runtime.kind === "failed"
            ? `SSH remote is unavailable: ${runtime.error}`
            : `SSH remote is still connecting to ${runtime.intent.target}`;
        return { operations: unavailableBashOperations(message) };
      }
      const active = runtime;
      return {
        operations: createRemoteBashOperations(active.adapter, (cwd) =>
          active.adapter.mapCwd(cwd, ctx.cwd, active.workspace),
        ),
      };
    });

    pi.on("context", (event, ctx) => {
      const messages = event.messages.filter((message) =>
        !(message.role === "custom" && message.customType === SSH_ENVIRONMENT_CONTEXT_TYPE)
      );
      let content: string | undefined;
      let details: Record<string, unknown> | undefined;
      if (runtime.kind === "active") {
        const shellGuidance =
          runtime.session.remotePlatform === "windows"
            ? "The bash tool and user ! commands execute PowerShell syntax, not Bash syntax."
            : runtime.session.remoteShell === "zsh"
              ? "The bash tool and user ! commands execute Zsh syntax."
              : runtime.session.remoteShell === "sh"
                ? "The bash tool and user ! commands execute POSIX sh syntax."
                : "The bash tool and user ! commands execute Bash syntax.";
        content =
          `SSH Remote workspace context (authoritative): ${formatRemoteLocation(runtime.session)} `
          + `(${runtime.session.remotePlatform}/${runtime.session.remoteShell}). `
          + "The read, write, edit, bash, optional grep/find/ls, workspace-file providers, and user ! commands operate on this remote workspace. "
          + `${shellGuidance} Pi's local cwd (${ctx.cwd}) is only the local session anchor; do not treat it as the project filesystem.`;
        details = { kind: "active", session: runtime.session };
      } else if (runtime.kind === "failed") {
        content =
          `SSH Remote workspace is unavailable: ${runtime.error}. `
          + "Workspace tools fail closed and must not fall back to Pi's local cwd. Reconnect or explicitly exit SSH before continuing with local files.";
        details = { kind: "failed", error: runtime.error, intent: runtime.intent };
      } else if (runtime.kind === "connecting") {
        content =
          `SSH Remote is still connecting to ${runtime.intent.target}. `
          + "Do not use workspace tools until the connection finishes.";
        details = { kind: "connecting", intent: runtime.intent };
      }
      if (!content) {
        return messages.length === event.messages.length ? undefined : { messages };
      }
      return {
        messages: [...messages, {
          role: "custom",
          customType: SSH_ENVIRONMENT_CONTEXT_TYPE,
          content,
          display: false,
          details,
          timestamp: Date.now(),
        }],
      };
    });

  };
}

export default createSshRemoteExtension();

export {
  createSshBackgroundShellResolver,
  createSshTransportClient,
  OpenSshClient,
  parseSshTarget,
  selectRemoteAdapter,
};
export { Ssh2Client, Ssh2ConnectionError } from "./ssh2-client.ts";
export {
  Ssh2CompatibilityError,
  expandProxyJumpTokens,
  parseKnownHostSearchOutput,
  parseOpenSshConfig,
  parseProxyJump,
  resolveSsh2Connection,
  type ParsedProxyJump,
  type ResolvedSsh2Connection,
  type ResolvedSsh2Endpoint,
} from "./ssh2-config.ts";
export {
  DEFAULT_SSH_REMOTE_CONFIG,
  SSH_REMOTE_SETTINGS_NAMESPACE,
  getSshRemoteConfigPath,
  loadSshRemoteConfig,
  normalizeSshRemoteConfig,
  saveSshRemoteConfig,
  type SshRemoteConfig,
} from "./config.ts";
export type {
  RemoteAdapter,
  RemotePlatform,
  RemoteShell,
  RemoteWorkspace,
  SshShellPreference,
} from "./adapters/index.ts";
export type {
  SshBackgroundLease,
  SshClientOptions,
  SshDisposeOptions,
  SshRemoteClient,
  SshTransportKind,
  SshTransportPreference,
} from "./client.ts";
export {
  findSshEnvironmentState,
  findSshSessionState,
  SSH_LOCAL_SESSION_STATE,
  SSH_LOCAL_SESSION_STATE_TYPE,
  SSH_SESSION_STATE_TYPE,
  type SshEnvironmentState,
  type SshLocalSessionState,
  type SshSessionState,
} from "./session-state.ts";
