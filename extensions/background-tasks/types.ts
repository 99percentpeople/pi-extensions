import type { ChildProcess, spawn } from "node:child_process";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import type { SerializeAddon as XtermSerializeAddon } from "@xterm/addon-serialize";
import type * as nodePty from "node-pty";
import type { BackgroundTasksConfig } from "./config.ts";

export type BackgroundSignal = NodeJS.Signals | "SIGBREAK";
export type BackgroundControlProbeResult = "running" | "finished" | "unknown";

export interface BackgroundControlOptions {
  abortSignal?: AbortSignal;
}

export type BackgroundTransportExitDisposition =
  | { state: "finished" }
  | { state: "stopped"; signal?: string }
  | { state: "disconnected"; error: string };

export interface BackgroundTaskControl {
  /** Signals accepted by this execution environment, independent of Pi's local OS. */
  supportedSignals?: readonly BackgroundSignal[];
  /** Signals that should classify a later task exit as an intentional stop. */
  terminatingSignals?: readonly BackgroundSignal[];
  /** Human-readable destination used in bg_send results. */
  signalTarget?: "process" | "process group" | "process tree";
  /** False when an adapter launch deliberately detached stdin (for example ssh -n). */
  stdinAvailable?: boolean;
  sendSignal(
    signal: BackgroundSignal,
    options?: BackgroundControlOptions,
  ): void | Promise<void>;
  /** Probe adapter-owned state after the local transport has disappeared. */
  probe(options?: BackgroundControlOptions): Promise<BackgroundControlProbeResult>;
  /** Reconcile an unexpected local transport exit with the real task. */
  onTransportExit(
    event: { exitCode: number | null; signal: string | null },
    options?: BackgroundControlOptions,
  ): Promise<BackgroundTransportExitDisposition>;
  /** Release adapter resources such as a ControlMaster task lease. */
  dispose(): void | Promise<void>;
}

export interface PipeTaskProcess {
  kind: "pipe";
  pid: number;
  child: ChildProcess;
}

export interface PtyTaskProcess {
  kind: "pty";
  pid: number;
  pty: nodePty.IPty;
}

export type BackgroundProcess = PipeTaskProcess | PtyTaskProcess;

export type ConsoleData = string | Buffer;
export type MouseEncodingMode = "default" | "utf8" | "sgr" | "urxvt" | "sgr-pixels";

export interface ConsoleSession {
  terminal: XtermTerminal;
  serializer: XtermSerializeAddon;
  parsed: Promise<void>;
  catchUpBuffer: ConsoleData[] | null;
  mouseEncodingMode: MouseEncodingMode;
  subscriber?: (data: ConsoleData) => void;
}

export type AttachmentReason = "detached" | "shutdown";

export interface AttachmentState {
  detach?: (reason: AttachmentReason) => void;
  taskExited?: () => void;
}

export interface ShellLaunch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Local cwd for the launched shell process; adapters may map context.cwd elsewhere. */
  cwd?: string;
  initialStdin?: string;
  /** Adapter-owned lifecycle and signaling, independent of the local launcher. */
  control?: BackgroundTaskControl;
  /** Immutable execution location captured on the task at launch time. */
  taskEnvironment?: string;
  /** Provider-scoped launch functions; omitted by normal shell adapters. */
  spawnProcess?: typeof spawn;
  ptySpawnProcess?: typeof nodePty.spawn;
}

export interface ShellResolverContext {
  cwd: string;
  projectTrusted: boolean;
}

export type ShellResolver = (
  command: string,
  interactive: boolean,
  context?: ShellResolverContext,
) => ShellLaunch | undefined;

export interface BgTask {
  id: string;
  name: string;
  command: string;
  mode: "pipe" | "pty";
  environment: string | null;
  process: BackgroundProcess | null;
  control: BackgroundTaskControl | null;
  controlDisposed: boolean;
  transportExitPending: Promise<void> | null;
  console: ConsoleSession;
  attachment: AttachmentState;
  status: "running" | "disconnected" | "completed" | "failed" | "stopped";
  statusDetail: string | null;
  exitCode: number | null;
  signal: string | null;
  order: number;
  startedAt: number;
  endedAt: number | null;
  stdoutLogKey: string;
  stderrLogKey: string;
  stdoutLines: number;
  stderrLines: number;
  done: AbortController;
  latestLog: LatestLog | null;
  retainForNextAgentTurn: boolean;
  stdoutPending: string;
  stderrPending: string;
  requestedStopSignal: BackgroundSignal | null;
}

export interface LatestLog {
  stream: "stdout" | "stderr" | "terminal";
  text: string;
  at: number;
}

export type FinishedTaskStatus = "completed" | "failed" | "stopped";

export interface PersistedFinishedTask {
  id: string;
  name: string;
  command: string;
  mode: BgTask["mode"];
  /** Optional for backward compatibility with schema-v1 snapshots. */
  environment?: string | null;
  status: FinishedTaskStatus;
  exitCode: number | null;
  signal: string | null;
  order: number;
  startedAt: number;
  endedAt: number;
  stdoutLines: number;
  stderrLines: number;
  latestLog: LatestLog | null;
  retainForNextAgentTurn: boolean;
  cols: number;
  rows: number;
  consoleSnapshot: string;
  stdout?: string;
  stderr?: string;
}

export interface PersistedTaskUpsert {
  schemaVersion: 1;
  action: "upsert";
  task: PersistedFinishedTask;
}

export interface PersistedTaskReconcile {
  schemaVersion: 1;
  action: "reconcile";
  removed: string[];
  clearedRetention: string[];
}

export type PersistedTaskEvent = PersistedTaskUpsert | PersistedTaskReconcile;

export interface BgWaitRenderState {
  startedAt?: number;
  interval?: ReturnType<typeof setInterval>;
}

export type WindowsProcessTreeKiller = (
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
) => Promise<void>;

export interface BackgroundTasksExtensionDependencies {
  loadConfig?: () => BackgroundTasksConfig;
  saveConfig?: (config: BackgroundTasksConfig) => void;
  /** Explicit process factories and terminal streams for tests or embedded runtimes. */
  spawnProcess?: typeof spawn;
  ptySpawnProcess?: typeof nodePty.spawn;
  /** Test/embedding seam for native Windows taskkill process-tree control. */
  killWindowsProcessTree?: WindowsProcessTreeKiller;
  terminalInput?: NodeJS.ReadStream;
  terminalOutput?: NodeJS.WriteStream;
}

export interface OrderedToolCall {
  predecessor: Promise<void>;
  release: () => void;
}

export interface BackgroundShellProviderRegistration {
  id?: unknown;
  priority?: unknown;
  spawn?: typeof spawn;
  ptySpawn?: typeof nodePty.spawn;
  resolveShell?: ShellResolver;
  onRegistered?: (capabilities: {
    protocolVersion: number;
    providers: boolean;
    taskControl: boolean;
  }) => void;
}
