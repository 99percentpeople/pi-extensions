export type BackgroundSignal = NodeJS.Signals | "SIGBREAK";

export interface BackgroundControlOptions {
  abortSignal?: AbortSignal;
}

export type BackgroundTransportExitDisposition =
  | { state: "finished" }
  | { state: "stopped"; signal?: string }
  | { state: "disconnected"; error: string };

export interface BackgroundTaskControl {
  supportedSignals?: readonly BackgroundSignal[];
  terminatingSignals?: readonly BackgroundSignal[];
  signalTarget?: "process" | "process group" | "process tree";
  stdinAvailable?: boolean;
  sendSignal(
    signal: BackgroundSignal,
    options?: BackgroundControlOptions,
  ): void | Promise<void>;
  probe(options?: BackgroundControlOptions): Promise<"running" | "finished" | "unknown">;
  onTransportExit(
    event: { exitCode: number | null; signal: string | null },
    options?: BackgroundControlOptions,
  ): Promise<BackgroundTransportExitDisposition>;
  dispose(): void | Promise<void>;
}

const CONTROL_PREFIX = "pi-ssh-bg-";

export const UNIX_BACKGROUND_SIGNALS: readonly BackgroundSignal[] = [
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE",
  "SIGHUP", "SIGILL", "SIGINT", "SIGIO", "SIGIOT", "SIGKILL",
  "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV",
  "SIGSTKFLT", "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP",
  "SIGTTIN", "SIGTTOU", "SIGURG", "SIGUSR1", "SIGUSR2", "SIGVTALRM",
  "SIGWINCH", "SIGXCPU", "SIGXFSZ",
];

export const UNIX_TERMINATING_SIGNALS: readonly BackgroundSignal[] = [
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL",
  "SIGINT", "SIGIO", "SIGIOT", "SIGKILL", "SIGPIPE", "SIGPOLL",
  "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV", "SIGSTKFLT", "SIGSYS",
  "SIGTERM", "SIGTRAP", "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGXCPU",
  "SIGXFSZ",
];

export const WINDOWS_BACKGROUND_SIGNALS: readonly BackgroundSignal[] = [
  "SIGHUP",
  "SIGINT",
  "SIGKILL",
  "SIGQUIT",
  "SIGTERM",
  "SIGBREAK",
];

export function validateControlToken(token: string): string {
  if (!/^[a-f0-9]{16,128}$/.test(token)) {
    throw new Error("Invalid SSH background control token");
  }
  return token;
}

export function remoteSignalName(signal: BackgroundSignal): string {
  if (!/^SIG[A-Z0-9]+$/.test(signal)) {
    throw new Error(`Unsupported SSH process signal: ${signal}`);
  }
  return signal.slice(3);
}

export function controlDirectoryName(token: string): string {
  return `${CONTROL_PREFIX}${validateControlToken(token)}`;
}
