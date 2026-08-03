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

export interface SshPasswordResolverOptions {
  /** Persist passwords to the 0600 secrets file (for -r cross-process reuse). */
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
 * Resolves SSH passwords in order: in-process memory, the 0600 secrets
 * file, then the TUI prompt. Rejected passwords are removed from all
 * sources so the next attempt re-asks instead of looping on a bad secret.
 */
export class SshPasswordResolver {
  private readonly memory = new Map<string, string>();
  private readonly secretsPath: string;
  private ui?: SshPasswordPromptUI;
  private warnedAboutVisibility = false;
  private persist: boolean;

  constructor(private readonly options: SshPasswordResolverOptions) {
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
   * cached. Returns undefined when the user cancels or no UI is available.
   */
  async resolvePassword(endpoint: SshPasswordEndpoint): Promise<string | undefined> {
    const cached = this.cachedPassword(endpoint);
    if (cached !== undefined) return cached;
    if (!this.ui) return undefined;
    if (!this.warnedAboutVisibility) {
      this.warnedAboutVisibility = true;
      this.ui.notify(
        "SSH password input is plain text until Pi gains a masked input API",
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
  async retryPassword(endpoint: SshPasswordEndpoint): Promise<string | undefined> {
    this.rejectPassword(endpoint);
    return this.resolvePassword(endpoint);
  }

  /** Clears every password (memory and secrets file). */
  forgetAll(): void {
    this.memory.clear();
    if (this.persist && existsSync(this.secretsPath)) {
      writeSecrets(this.secretsPath, {});
    }
  }
}
