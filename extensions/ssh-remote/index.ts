import { registerExtensionSettings } from "@99percentpeople/pi-shared-settings";
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
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
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
} from "./client.ts";
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
  findSshSessionState,
  formatRemoteLocation,
  SSH_SESSION_STATE_TYPE,
  SSH_SESSION_STATE_VERSION,
  type SshSessionState,
} from "./session-state.ts";
import {
  expandLocalPath,
  parseSshTarget,
  type ParsedSshTarget,
} from "./target.ts";

const STATUS_KEY = "ssh-remote";
const CONNECT_TIMEOUT_SECONDS = 10;

interface ConnectionIntent {
  target: string;
  requestedCwd?: string;
  configFile?: string;
  shellPreference: SshShellPreference;
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

type RuntimeState =
  | { kind: "disabled" }
  | { kind: "connecting"; intent: ConnectionIntent }
  | ActiveConnection
  | { kind: "failed"; intent?: ConnectionIntent; error: string };

export interface SshRemoteExtensionDependencies {
  platform?: NodeJS.Platform;
  createClient?: (options: SshClientOptions) => SshRemoteClient;
  selectRemote?: typeof selectRemoteAdapter;
  loadPreviousSessionState?: (path: string) => SshSessionState | undefined;
}

function defaultLoadPreviousSessionState(
  path: string,
): SshSessionState | undefined {
  const manager = SessionManager.open(path);
  return findSshSessionState(manager.getBranch());
}

function parseShellPreference(value: unknown): SshShellPreference {
  if (value === undefined || value === "") return "auto";
  if (
    value === "auto" ||
    value === "bash" ||
    value === "pwsh" ||
    value === "powershell"
  ) {
    return value;
  }
  throw new Error("--ssh-shell must be one of: auto, bash, pwsh, powershell");
}

function sameStoredTarget(
  parsed: ParsedSshTarget,
  configFile: string | undefined,
  shellPreference: SshShellPreference,
  stored: SshSessionState,
): boolean {
  if (parsed.target !== stored.target || configFile !== stored.configFile)
    return false;
  if (shellPreference !== "auto" && shellPreference !== stored.remoteShell)
    return false;
  if (!parsed.requestedCwd) return true;
  return (
    parsed.requestedCwd === stored.requestedCwd ||
    parsed.requestedCwd === stored.remoteCwd
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
  const createClient =
    dependencies.createClient ??
    ((options: SshClientOptions) => new OpenSshClient(options));
  const selectRemote = dependencies.selectRemote ?? selectRemoteAdapter;
  const loadPreviousSessionState =
    dependencies.loadPreviousSessionState ?? defaultLoadPreviousSessionState;

  return function sshRemoteExtension(pi: ExtensionAPI): void {
    registerExtensionSettings(pi, {
      namespace: "ssh-remote",
      title: "SSH Remote",
      settings: () => [],
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
      description: "Remote shell: auto, bash, pwsh, or powershell",
      type: "string",
    });

    let runtime: RuntimeState = { kind: "disabled" };
    let autoSessionName: string | undefined;
    let autoSessionTitle: string | undefined;

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

    const emitBackgroundBackend = (ctx: ExtensionContext): void => {
      // Registered for every session that requests an SSH workspace. The
      // resolver reads the live runtime state on each launch: active sessions
      // run tasks on the remote (reconnecting picks up the new connection),
      // failed/connecting sessions fail closed like the routed tools, and a
      // session without SSH falls back to the default local shell backend.
      pi.events.emit("bg:register", {
        resolveShell: (
          command: string,
          interactive: boolean,
          context?: BackgroundShellResolverContext,
        ) => {
          if (runtime.kind === "active") {
            return createSshBackgroundShellResolver({
              ssh: { ...runtime.client.options },
              adapter: runtime.adapter,
              workspace: runtime.workspace,
              localCwd: ctx.cwd,
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
    ): Promise<void> => {
      if (runtime.kind === "active") runtime.client.dispose();
      runtime = { kind: "connecting", intent };
      updateStatus(ctx);

      let client: SshRemoteClient | undefined;
      try {
        client = createClient({
          target: intent.target,
          configFile: intent.configFile,
          executable: platform === "win32" ? "ssh.exe" : undefined,
          connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS,
          batchMode: true,
        });
        const requestedCwd =
          intent.storedState?.remoteCwd ?? intent.requestedCwd;
        const selected = await selectRemote(client, {
          localPlatform: platform,
          preference: intent.shellPreference,
          expectedPlatform: intent.storedState?.remotePlatform,
          expectedShell: intent.storedState?.remoteShell,
          requestedCwd,
        });
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
        if (intent.persistOnSuccess)
          pi.appendEntry(SSH_SESSION_STATE_TYPE, session);
        const activeIntent: ConnectionIntent = {
          ...intent,
          storedState: session,
          shellPreference: session.remoteShell,
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
        ctx.ui.notify(
          `SSH remote active: ${formatRemoteLocation(session)} (${session.remotePlatform}/${session.remoteShell})`,
          "info",
        );
      } catch (error) {
        client?.dispose();
        fail(ctx, error, intent);
      }
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
        if (sshFlag) {
          const parsed = parseSshTarget(sshFlag);
          const effectiveConfig = configFile ?? stored.configFile;
          if (
            !sameStoredTarget(parsed, effectiveConfig, shellPreference, stored)
          ) {
            throw new Error(
              `The resumed session is bound to ${formatRemoteLocation(stored)}; ` +
                "the current --ssh arguments select a different workspace or shell.",
            );
          }
        } else if (configFile && configFile !== stored.configFile) {
          throw new Error(
            "The resumed session uses a different OpenSSH config file",
          );
        } else if (
          shellPreference !== "auto" &&
          shellPreference !== stored.remoteShell
        ) {
          throw new Error("The resumed session uses a different remote shell");
        }
        return {
          target: stored.target,
          requestedCwd: stored.remoteCwd,
          configFile: stored.configFile,
          shellPreference: stored.remoteShell,
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
              persistOnSuccess: true,
            };
          }
        } catch {
          // A missing or unreadable previous session should not prevent /new.
        }
      }

      return undefined;
    };

    let sshCommandsRegistered = false;
    const registerSshCommands = (): void => {
      if (sshCommandsRegistered) return;
      sshCommandsRegistered = true;

      pi.registerCommand("ssh-status", {
        description: "Show the SSH remote workspace status",
        handler: async (_args, ctx) => {
          if (runtime.kind === "disabled") {
            ctx.ui.notify("SSH remote mode is disabled for this session", "info");
          } else if (runtime.kind === "connecting") {
            ctx.ui.notify(
              `SSH is connecting to ${runtime.intent.target}`,
              "info",
            );
          } else if (runtime.kind === "failed") {
            ctx.ui.notify(`SSH remote unavailable: ${runtime.error}`, "error");
          } else {
            ctx.ui.notify(
              [
                `SSH target: ${runtime.session.target}`,
                `platform: ${runtime.session.remotePlatform}`,
                `shell: ${runtime.session.remoteShell}`,
                `cwd: ${runtime.session.remoteCwd}`,
                `home: ${runtime.session.remoteHome}`,
                runtime.session.configFile
                  ? `Config file: ${runtime.session.configFile}`
                  : undefined,
              ].join("\n"),
              "info",
            );
          }
        },
      });

      pi.registerCommand("ssh-reconnect", {
        description: "Reconnect the current SSH remote workspace",
        handler: async (_args, ctx) => {
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
          await connect(
            { ...intent, persistOnSuccess: intent.persistOnSuccess },
            ctx,
          );
        },
      });
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
      async execute(id, params, signal, onUpdate, ctx) {
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
        "Execute a command in the active workspace shell. Local and remote Unix workspaces use Bash; remote Windows workspaces use PowerShell.",
      ),
      promptSnippet:
        "Execute commands in the active local or remote workspace shell",
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

    pi.on("session_start", async (event, ctx) => {
      runtime = { kind: "disabled" };
      autoSessionName = undefined;
      autoSessionTitle = undefined;
      let intent: ConnectionIntent | undefined;
      try {
        intent = resolveIntent(event, ctx);
      } catch (error) {
        registerRemoteTools();
        emitBackgroundBackend(ctx);
        fail(ctx, error);
        return;
      }
      if (!intent) {
        updateStatus(ctx);
        return;
      }
      registerRemoteTools();
      registerSshCommands();
      emitBackgroundBackend(ctx);
      await connect(intent, ctx);
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

    pi.on("tool_call", (event) => {
      // Background task backends are registered through a shared "bg:register"
      // bus where the last registrant wins (for example pi-pwsh-adapter
      // re-registers a local PowerShell backend on session start). That makes
      // bg_start silently run on the local machine while the SSH workspace is
      // unavailable. Fail closed here instead, independent of registration
      // order, so background tasks match the routed tools.
      if (event.toolName !== "bg_start") return;
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
      if (runtime.kind === "active") runtime.client.dispose();
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

    pi.on("before_agent_start", (event, ctx) => {
      if (runtime.kind !== "active") return;
      const location = formatRemoteLocation(runtime.session);
      const localLine = `Current working directory: ${ctx.cwd}`;
      const remoteLine = `Current working directory: ${runtime.session.remoteCwd} (SSH ${runtime.session.target})`;
      const base = event.systemPrompt.includes(localLine)
        ? event.systemPrompt.replace(localLine, remoteLine)
        : `${event.systemPrompt}\n\n${remoteLine}`;
      const shellGuidance =
        runtime.session.remotePlatform === "windows"
          ? "The bash tool and user ! commands execute PowerShell syntax, not Bash syntax."
          : "The bash tool and user ! commands execute Bash syntax.";
      return {
        systemPrompt:
          `${base}\n\nSSH remote workspace is active at ${location} ` +
          `(${runtime.session.remotePlatform}/${runtime.session.remoteShell}). ` +
          "The read, write, edit, bash, optional grep/find/ls, and user ! commands operate on that remote workspace. " +
          `${shellGuidance} Do not treat the local Pi working directory as the project filesystem.`,
      };
    });

  };
}

export default createSshRemoteExtension();

export {
  createSshBackgroundShellResolver,
  OpenSshClient,
  parseSshTarget,
  selectRemoteAdapter,
};
export type {
  RemoteAdapter,
  RemoteWorkspace,
  SshClientOptions,
  SshRemoteClient,
  SshSessionState,
  SshShellPreference,
};
