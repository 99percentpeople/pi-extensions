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

export interface SshPasswordPromptUI {
  /** Prompt the user for a password. Resolves undefined when cancelled. */
  prompt(title: string): Promise<string | undefined>;
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
    return this.memory.get(endpoint.hostLabel)
      ?? (this.persist ? readSecrets(this.secretsPath)[endpoint.hostLabel] : undefined);
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
    const password = await this.ui.prompt(
      `SSH password for ${endpoint.hostLabel}`,
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
  ): Promise<string | undefined> {
    // Surface the rejection only when a secret was actually tried (typed
    // by the user or a cached one): the first prompt on a key-less host
    // has nothing to reject yet.
    const hadSecret = this.cachedPassword(endpoint) !== undefined;
    this.rejectPassword(endpoint);
    return this.resolvePassword(endpoint, hadSecret ? failureInfo : undefined);
  }

  /** Clears every password (memory and secrets file). */
  forgetAll(): void {
    this.memory.clear();
    if (this.persist && existsSync(this.secretsPath)) {
      writeSecrets(this.secretsPath, {});
    }
  }
}
