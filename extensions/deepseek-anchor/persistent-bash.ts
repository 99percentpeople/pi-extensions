import { randomUUID } from "node:crypto";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

const TRUNCATED_MESSAGE = "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";
const SHELL_RESET_MESSAGE = "The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.";

export interface PersistentBashOptions {
  cwd: string;
  shell?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface PersistentBashRunOptions {
  signal?: AbortSignal;
}

function quoteForBash(value: string): string {
  return `$'${value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")}'`;
}

function removeOneTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function maybeTruncate(value: string, maxOutputChars: number): string {
  return value.length <= maxOutputChars
    ? value
    : value.slice(0, maxOutputChars) + TRUNCATED_MESSAGE;
}

function appendMarker(value: string, marker: string): string {
  return value.length > 0 ? `${value}\n${marker}` : marker;
}

function shellExitMarker(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `[shell killed by signal: ${signal}]`;
  if (code !== null) return `[shell exited: code ${code}]`;
  return "[shell exited]";
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timeout) clearTimeout(timeout);
      child.removeListener("exit", finish);
      resolve();
    };
    child.once("exit", finish);
    timeout = setTimeout(finish, timeoutMs);
  });
}

export class PersistentBashSession {
  private readonly cwd: string;
  private readonly shell: string;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private child: ChildProcessWithoutNullStreams | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: PersistentBashOptions) {
    this.cwd = options.cwd;
    this.shell = options.shell ?? "bash";
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.maxOutputChars = options.maxOutputChars ?? 16_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Persistent Bash timeoutMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxOutputChars) || this.maxOutputChars <= 0) {
      throw new Error("Persistent Bash maxOutputChars must be a positive safe integer");
    }
  }

  run(command: string, options: PersistentBashRunOptions = {}): Promise<string> {
    const operation = this.queue.then(
      () => this.runExclusive(command, options.signal),
      () => this.runExclusive(command, options.signal),
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (child) await this.resetChild(child);
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.closed) throw new Error("Persistent Bash session is closed");
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      return this.child;
    }

    const child = spawn(this.shell, ["--noprofile", "--norc"], {
      cwd: this.cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Keep a permanent listener so a late spawn error after command cleanup is
    // never promoted to an unhandled EventEmitter error.
    child.on("error", () => {});
    this.child = child;
    return child;
  }

  private runExclusive(command: string, signal?: AbortSignal): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Persistent Bash session is closed"));
    if (command.trim().length === 0) {
      return Promise.reject(new Error("command must be a non-empty string"));
    }
    if (signal?.aborted) return Promise.reject(new Error("aborted"));

    const child = this.ensureChild();
    const nonce = randomUUID();
    const startMarker = `__DEEPSEEK_ANCHOR_BASH_START_${nonce}__`;
    const endMarker = `__DEEPSEEK_ANCHOR_BASH_END_${nonce}:`;
    const wrapped = [
      `printf '%s\\n' ${quoteForBash(startMarker)}`,
      `eval -- ${quoteForBash(command)} 2>&1`,
      "__deepseek_anchor_status=$?",
      `printf '%s%s\\n' ${quoteForBash(endMarker)} "$__deepseek_anchor_status"`,
    ].join("; ") + "\n";

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let buffer = "";
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
        child.stdout.removeListener("data", onData);
        child.stderr.removeListener("data", onData);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
      };

      const outputAfterStart = (): string => {
        const start = buffer.indexOf(startMarker);
        if (start < 0) return buffer;
        let offset = start + startMarker.length;
        if (buffer.startsWith("\r\n", offset)) offset += 2;
        else if (buffer[offset] === "\n") offset += 1;
        const end = buffer.indexOf(endMarker, offset);
        return removeOneTrailingNewline(buffer.slice(offset, end < 0 ? undefined : end));
      };

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };

      const tryComplete = () => {
        const start = buffer.indexOf(startMarker);
        if (start < 0) return;
        const end = buffer.indexOf(endMarker, start + startMarker.length);
        if (end < 0) return;
        const statusText = buffer.slice(end + endMarker.length);
        const statusMatch = /^(\d+)\r?\n/.exec(statusText);
        if (!statusMatch) return;
        const status = Number(statusMatch[1]);
        let output = maybeTruncate(outputAfterStart(), this.maxOutputChars);
        if (status !== 0) output = appendMarker(output, `[exit code: ${status}]`);
        settle(() => resolve(output));
      };

      const onData = (chunk: string | Buffer) => {
        if (settled) return;
        buffer += chunk.toString();
        tryComplete();
      };

      const onError = (error: Error) => {
        if (this.child === child) this.child = undefined;
        settle(() => reject(error));
      };

      const onExit = (code: number | null, childSignal: NodeJS.Signals | null) => {
        if (this.child === child) this.child = undefined;
        const partial = maybeTruncate(outputAfterStart(), this.maxOutputChars);
        const text = [
          appendMarker(partial, shellExitMarker(code, childSignal)),
          SHELL_RESET_MESSAGE,
        ].join("\n");
        settle(() => resolve(text));
      };

      const onAbort = () => {
        const finish = async () => {
          await this.resetChild(child);
          reject(new Error("aborted"));
        };
        settle(() => void finish());
      };

      const onTimeout = () => {
        const partial = maybeTruncate(outputAfterStart(), this.maxOutputChars);
        const seconds = Math.round(this.timeoutMs / 1000);
        const text = [
          `Your command timed out after ${seconds} seconds or experienced an OOM error. Below is partial output:`,
          partial,
          SHELL_RESET_MESSAGE,
        ].filter((part) => part.length > 0).join("\n");
        const finish = async () => {
          await this.resetChild(child);
          resolve(text);
        };
        settle(() => void finish());
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
      timeoutHandle = setTimeout(onTimeout, this.timeoutMs);

      try {
        child.stdin.write(wrapped, "utf8");
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async resetChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.child === child) this.child = undefined;
    try {
      child.stdin.destroy();
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null) return;

    const pid = child.pid;
    try {
      if (pid && process.platform !== "win32") process.kill(-pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {}
    await waitForExit(child, 100);
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (pid && process.platform !== "win32") process.kill(-pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {}
    await waitForExit(child, 100);
  }
}

export const DSH_BASH_TRUNCATED_MESSAGE = TRUNCATED_MESSAGE;
export const DSH_BASH_RESET_MESSAGE = SHELL_RESET_MESSAGE;
