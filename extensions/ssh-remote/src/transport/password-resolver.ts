import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Password source for an SSH endpoint (target or ProxyJump hop).
 */
export interface SshPasswordEndpoint {
  /** `user@host:port` — the key used for caching and the secrets file. */
  hostLabel: string;
  username: string;
  host: string;
  port?: number;
}

export interface SshPasswordPromptControls {
  /** Hard timeout and UI countdown in milliseconds. Omit for no timeout. */
  timeoutMs?: number;
  /** Abort the prompt when its owning tool call is cancelled. */
  signal?: AbortSignal;
}

export interface SshPasswordPromptUI {
  /** Prompt the user for a password. Resolves undefined when cancelled. */
  prompt(
    title: string,
    controls?: SshPasswordPromptControls,
  ): Promise<string | undefined>;
  /** Show a warning/info notification. */
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Thrown when the user dismisses a password prompt; aborts the whole
 *  connection flow (auto must not then fall back to another transport
 *  that would prompt again). */
export class SshPasswordCancelledError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SshPasswordCancelledError";
  }
}

/** Thrown when an AI-initiated password prompt reaches its hard timeout. */
export class SshPasswordTimeoutError extends SshPasswordCancelledError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SshPasswordTimeoutError";
  }
}

/** Thrown when password attempts were made but every one was rejected.
 *  Another transport would try the same secret and fail the same way, so
 *  the connection flow must stop instead of falling back. */
export class SshPasswordFailedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SshPasswordFailedError";
  }
}

export interface SshPasswordResolverOptions {
  /** Persist passwords to the restricted secrets file (for -r cross-process reuse). */
  persistPasswords: boolean;
  /** Override the secrets file path (tests). */
  secretsPath?: string;
}

const DEFAULT_SECRETS_FILE = () => join(getAgentDir(), "ssh-remote-secrets.json");

function readSecrets(path: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const secrets: Record<string, string> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry === "string" && entry.length > 0) secrets[key] = entry;
      }
      return secrets;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return {};
}

function writeSecrets(path: string, secrets: Record<string, string>): void {
  const target = path;
  const temporary = `${target}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

/**
 * Resolves SSH passwords in order: in-process memory, the restricted secrets
 * file, then the TUI prompt. Rejected passwords are removed from all
 * sources so the next attempt re-asks instead of looping on a bad secret.
 */
export class SshPasswordResolver {
  private readonly memory = new Map<string, string>();
  private readonly sessionHostLabels = new Set<string>();
  private readonly secretsPath: string;
  private ui?: SshPasswordPromptUI;
  private persist: boolean;

  constructor(options: SshPasswordResolverOptions) {
    this.secretsPath = options.secretsPath ?? DEFAULT_SECRETS_FILE();
    this.persist = options.persistPasswords;
  }

  setPersistPasswords(enabled: boolean): void {
    this.persist = enabled;
  }

  setUI(ui: SshPasswordPromptUI | undefined): void {
    this.ui = ui;
  }

  get hasUI(): boolean {
    return this.ui !== undefined;
  }

  /**
   * Returns a cached password (memory or secrets file) without prompting.
   * Used while resolving connection configs so key auth still wins.
   */
  cachedPassword(endpoint: SshPasswordEndpoint): string | undefined {
    this.sessionHostLabels.add(endpoint.hostLabel);
    return this.memory.get(endpoint.hostLabel)
      ?? (this.persist ? readSecrets(this.secretsPath)[endpoint.hostLabel] : undefined);
  }

  private async promptPassword(
    title: string,
    controls: SshPasswordPromptControls,
  ): Promise<string | undefined> {
    const ui = this.ui;
    if (!ui) return undefined;
    const { timeoutMs, signal } = controls;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error("SSH password prompt timeout must be a positive number");
    }
    if (timeoutMs === undefined && !signal) {
      return ui.prompt(title);
    }

    const promptController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener = (): void => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      const abort = (): void => {
        const error = new SshPasswordCancelledError(
          `${title} was cancelled`,
          { cause: signal?.reason },
        );
        reject(error);
        promptController.abort(error);
      };
      if (signal?.aborted) {
        abort();
      } else if (signal) {
        signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          const seconds = Math.ceil(timeoutMs / 1000);
          const error = new SshPasswordTimeoutError(
            `${title} timed out after ${seconds} second${seconds === 1 ? "" : "s"}`,
          );
          reject(error);
          promptController.abort(error);
        }, timeoutMs);
      }
    });

    try {
      const prompt = Promise.resolve().then(() => ui.prompt(title, {
        timeoutMs,
        signal: promptController.signal,
      }));
      return await Promise.race([prompt, interrupted]);
    } finally {
      if (timeout) clearTimeout(timeout);
      removeAbortListener();
      if (!promptController.signal.aborted) promptController.abort();
    }
  }

  /**
   * Returns a usable password for the endpoint, prompting when nothing is
   * cached. `failureInfo` (the transport's real rejection message) is
   * surfaced in the prompt so the user knows the previous attempt failed.
   * Returns undefined when the user cancels or no UI is available.
   */
  async resolvePassword(
    endpoint: SshPasswordEndpoint,
    failureInfo?: string,
    controls: SshPasswordPromptControls = {},
  ): Promise<string | undefined> {
    const cached = this.cachedPassword(endpoint);
    if (cached !== undefined) return cached;
    if (!this.ui) return undefined;
    if (failureInfo) {
      this.ui.notify(
        `SSH password rejected: ${failureInfo.replace(/\s+/g, " ").trim().slice(0, 500)}`,
        "warning",
      );
    }
    const password = await this.promptPassword(
      `SSH password for ${endpoint.hostLabel}`,
      controls,
    );
    if (password === undefined || password === "") return undefined;
    this.memory.set(endpoint.hostLabel, password);
    if (this.persist) {
      const secrets = readSecrets(this.secretsPath);
      secrets[endpoint.hostLabel] = password;
      writeSecrets(this.secretsPath, secrets);
    }
    return password;
  }

  /**
   * Removes the endpoint's password after a rejected authentication
   * attempt so the next resolve re-asks instead of looping on the bad
   * secret.
   */
  rejectPassword(endpoint: SshPasswordEndpoint): void {
    this.memory.delete(endpoint.hostLabel);
    if (!this.persist) return;
    const secrets = readSecrets(this.secretsPath);
    if (!(endpoint.hostLabel in secrets)) return;
    delete secrets[endpoint.hostLabel];
    writeSecrets(this.secretsPath, secrets);
  }

  /**
   * Called after an authentication failure: rejects any cached secret for
   * the endpoint, then resolves a fresh password (prompting if needed).
   * Returns undefined when the user cancels or no UI is available.
   */
  async retryPassword(
    endpoint: SshPasswordEndpoint,
    failureInfo?: string,
    controls: SshPasswordPromptControls = {},
  ): Promise<string | undefined> {
    // Surface the rejection only when a secret was actually tried (typed
    // by the user or a cached one): the first prompt on a key-less host
    // has nothing to reject yet.
    const hadSecret = this.cachedPassword(endpoint) !== undefined;
    this.rejectPassword(endpoint);
    return this.resolvePassword(
      endpoint,
      hadSecret ? failureInfo : undefined,
      controls,
    );
  }

  /** Clears passwords used by this Pi session from memory and persisted storage. */
  forgetCurrentSession(): number {
    const labels = [...this.sessionHostLabels];
    let removed = 0;
    const secrets = existsSync(this.secretsPath)
      ? readSecrets(this.secretsPath)
      : undefined;
    let changedSecrets = false;
    for (const label of labels) {
      let found = this.memory.delete(label);
      if (secrets && label in secrets) {
        delete secrets[label];
        changedSecrets = true;
        found = true;
      }
      if (found) removed += 1;
    }
    if (changedSecrets && secrets) writeSecrets(this.secretsPath, secrets);
    this.sessionHostLabels.clear();
    return removed;
  }

  /** Clears every password from this process and persisted storage. */
  forgetAll(): number {
    const labels = new Set(this.memory.keys());
    if (existsSync(this.secretsPath)) {
      const secrets = readSecrets(this.secretsPath);
      for (const label of Object.keys(secrets)) labels.add(label);
      writeSecrets(this.secretsPath, {});
    }
    this.memory.clear();
    this.sessionHostLabels.clear();
    return labels.size;
  }
}
