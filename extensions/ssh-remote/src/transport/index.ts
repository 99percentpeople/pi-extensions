import { spawn } from "node:child_process";
import {
  OpenSshClient,
  type SshClientOptions,
  type SshDisconnectListener,
  type SshDisposeOptions,
  type SshRemoteClient,
  type SshRunOptions,
  type SshRunResult,
  type SshTransportPreference,
} from "./client.ts";
import { Ssh2Client, Ssh2ConnectionError } from "./ssh2-client.ts";
import {
  parseOpenSshConfig,
  runLocalCommand,
  Ssh2CompatibilityError,
} from "./ssh2-config.ts";
import {
  SshPasswordCancelledError,
  SshPasswordFailedError,
  type SshPasswordEndpoint,
} from "./password-resolver.ts";

export {
  SshPasswordCancelledError,
  SshPasswordFailedError,
  SshPasswordTimeoutError,
} from "./password-resolver.ts";

export interface SshPasswordProvider {
  /** Cached password for config resolution; keys still win at auth time. */
  cached(endpoint: SshPasswordEndpoint): string | undefined;
  /**
   * Fresh password after an authentication failure (rejects stale
   * caches). `error` carries the transport's real rejection message so
   * the prompt can tell the user what went wrong.
   */
  retry(endpoint: SshPasswordEndpoint, error?: unknown): Promise<string | undefined>;
}

export interface SshTransportFactoryOptions {
  platform?: NodeJS.Platform;
  preference?: SshTransportPreference;
  createOpenSsh?: (options: SshClientOptions) => SshRemoteClient;
  createSsh2?: (options: SshClientOptions) => SshRemoteClient;
  /** Password provider wired into the ssh2 client's auth retry loop. */
  passwordProvider?: SshPasswordProvider;
  /** Override the local `sshpass` availability probe (tests). */
  detectSshpass?: () => Promise<boolean>;
  /** Override effective ProxyJump detection before password fallback (tests). */
  detectProxyJump?: () => Promise<boolean>;
}

function detectSshpassDefault(platform: NodeJS.Platform): Promise<boolean> {
  if (platform === "win32") {
    // Windows has no sh; `where` resolves sshpass.exe from PATH.
    return new Promise((resolve) => {
      const child = spawn("where", ["sshpass"]);
      child.once("error", () => resolve(false));
      child.once("close", (code) => resolve(code === 0));
    });
  }
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", "command -v sshpass >/dev/null 2>&1"]);
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

async function detectProxyJumpDefault(
  options: SshClientOptions,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (!options.target || options.target.startsWith("-") || /[\s\0\r\n]/.test(options.target)) {
    return false;
  }
  const executable = options.executable ?? (platform === "win32" ? "ssh.exe" : "ssh");
  const args: string[] = [];
  if (options.configFile) args.push("-F", options.configFile);
  args.push("-G", "-o", "BatchMode=yes", options.target);
  try {
    const result = await runLocalCommand(executable, args, 15_000);
    if (result.exitCode !== 0) return false;
    const config = parseOpenSshConfig(result.stdout.toString("utf8"));
    const proxyJump = config.get("proxyjump")?.[0]?.trim();
    return !!proxyJump && proxyJump.toLowerCase() !== "none";
  } catch {
    // Keep the existing OpenSSH password flow when effective configuration
    // cannot be inspected; the original authentication error remains useful.
    return false;
  }
}

/**
 * Secret key for an OpenSSH target, matching the ssh2 resolver's
 * `user@host:port` format so one entered password is reused across both
 * transports. Targets without an explicit user keep the raw target (the
 * effective user is only known to ssh -G).
 */
function opensshHostLabel(target: string): string {
  let user: string | undefined;
  let rest = target;
  const at = rest.lastIndexOf("@");
  if (at !== -1) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  const colon = rest.lastIndexOf(":");
  let host = rest;
  let port = 22;
  if (colon !== -1 && /^\d+$/.test(rest.slice(colon + 1))) {
    host = rest.slice(0, colon);
    port = Number(rest.slice(colon + 1));
  }
  return user ? `${user}@${host}:${port}` : target;
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const singleLine = message.replace(/\s+/g, " ").trim();
  return singleLine.length <= 500 ? singleLine : `${singleLine.slice(0, 500)}…`;
}

/**
 * OpenSSH reports rejected authentication as
 * `Permission denied (publickey,password).` — the parenthesized list is the
 * set of methods the server actually accepts. Only prompt (or fall back to
 * ssh2) when password or keyboard-interactive is in that list; otherwise a
 * prompt could never succeed.
 */
function serverAcceptsPassword(text: string): boolean {
  const match = /permission denied \(([^)]*)\)/i.exec(text);
  if (!match) return false;
  const methods = match[1].toLowerCase().split(",").map((method) => method.trim());
  return methods.includes("password") || methods.includes("keyboard-interactive");
}

function checkedFailureText(result: SshRunResult): string {
  const detail = result.stderr.toString("utf8").trim();
  const bounded = detail.length <= 4_000 ? detail : `${detail.slice(0, 4_000)}…`;
  return `SSH command failed (${result.exitCode ?? "signal"})${bounded ? `: ${bounded}` : ""}`;
}

function checkedResult(result: SshRunResult): SshRunResult {
  if (result.exitCode === 0) return result;
  throw new Error(checkedFailureText(result));
}

function isMaskedProxyJumpFailure(value: unknown): boolean {
  const message = value && typeof value === "object" && "stderr" in value
    ? (value as SshRunResult).stderr.toString("utf8")
    : boundedReason(value);
  return /kex_exchange_identification:\s*connection closed by remote host|connection closed by unknown port 65535/i
    .test(message);
}

class AutoWindowsSshClient implements SshRemoteClient {
  private readonly openSshOptions: SshClientOptions;
  private readonly createOpenSsh: (options: SshClientOptions) => SshRemoteClient;
  private delegate: SshRemoteClient;
  private fallbackPromise?: Promise<void>;
  private ssh2OpenedChannel = false;
  private reason?: string;
  private disposed = false;

  constructor(
    ssh2: SshRemoteClient,
    openSshOptions: SshClientOptions,
    createOpenSsh: (options: SshClientOptions) => SshRemoteClient,
  ) {
    this.delegate = ssh2;
    this.openSshOptions = openSshOptions;
    this.createOpenSsh = createOpenSsh;
  }

  get options(): Readonly<SshClientOptions> {
    return this.delegate.options;
  }

  get transport() {
    return this.delegate.transport;
  }

  get reusesConnection(): boolean | undefined {
    return this.delegate.reusesConnection;
  }

  get fallbackReason(): string | undefined {
    return this.reason;
  }

  get compatibilityWarnings(): readonly string[] | undefined {
    return this.delegate.compatibilityWarnings;
  }

  private canFallback(error: unknown): boolean {
    return !this.ssh2OpenedChannel
      && (error instanceof Ssh2CompatibilityError || error instanceof Ssh2ConnectionError);
  }

  private async fallback(error: unknown): Promise<void> {
    if (this.fallbackPromise) return this.fallbackPromise;
    const previous = this.delegate;
    this.reason = boundedReason(error);
    const pending = (async () => {
      await previous.dispose();
      if (this.disposed) throw new Error("SSH client is closed");
      if (this.delegate === previous) this.delegate = this.createOpenSsh(this.openSshOptions);
    })();
    this.fallbackPromise = pending;
    try {
      await pending;
    } finally {
      if (this.fallbackPromise === pending) this.fallbackPromise = undefined;
    }
  }

  async run(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    if (this.disposed) throw new Error("SSH client is closed");
    const selected = this.delegate;
    try {
      const result = await selected.run(command, options);
      if (selected.transport === "ssh2") this.ssh2OpenedChannel = true;
      return result;
    } catch (error) {
      if (selected !== this.delegate && this.reason) {
        await this.fallbackPromise?.catch(() => {});
        return this.delegate.run(command, options);
      }
      if (!this.canFallback(error)) throw error;
      await this.fallback(error);
      try {
        return await this.delegate.run(command, options);
      } catch (fallbackError) {
        throw new Error(
          `ssh2 was unavailable (${this.reason}); OpenSSH fallback failed: ${boundedReason(fallbackError)}`,
          { cause: fallbackError },
        );
      }
    }
  }

  async runChecked(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    return checkedResult(await this.run(command, options));
  }

  onDisconnect(listener: SshDisconnectListener): () => void {
    return this.delegate.onDisconnect?.(listener) ?? (() => {});
  }

  acquireBackgroundLease() {
    return this.delegate.acquireBackgroundLease?.();
  }

  async dispose(options?: SshDisposeOptions): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.fallbackPromise?.catch(() => {});
    await this.delegate.dispose(options);
  }
}

class ProxyJumpPasswordRequiredError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "OpenSSH ProxyJump setup requires per-hop handling; switching to ssh2 for password authentication or connection diagnostics",
      options,
    );
    this.name = "ProxyJumpPasswordRequiredError";
  }
}

class SshpassRetryClient implements SshRemoteClient {
  private readonly openSshOptionsValue: SshClientOptions;
  private readonly createOpenSsh: (options: SshClientOptions) => SshRemoteClient;
  private readonly passwordProvider?: SshPasswordProvider;
  private readonly detectSshpass: () => Promise<boolean>;
  private readonly deferPasswordRetry?: () => Promise<boolean>;
  private deferPasswordRetryPromise?: Promise<boolean>;
  private delegate: SshRemoteClient;
  private openedChannel = false;
  private sshpassAvailable?: boolean;
  private tryCached = true;
  private cancelled = false;
  private triedPassword = false;
  private disposed = false;

  constructor(
    openSshOptions: SshClientOptions,
    createOpenSsh: (options: SshClientOptions) => SshRemoteClient,
    passwordProvider: SshPasswordProvider | undefined,
    detectSshpass: () => Promise<boolean>,
    deferPasswordRetry?: () => Promise<boolean>,
  ) {
    this.delegate = createOpenSsh(openSshOptions);
    this.openSshOptionsValue = openSshOptions;
    this.createOpenSsh = createOpenSsh;
    this.passwordProvider = passwordProvider;
    this.detectSshpass = detectSshpass;
    this.deferPasswordRetry = deferPasswordRetry;
  }

  get options(): Readonly<SshClientOptions> {
    return this.delegate.options;
  }

  get transport() {
    return this.delegate.transport;
  }

  get reusesConnection(): boolean | undefined {
    return this.delegate.reusesConnection;
  }

  get compatibilityWarnings(): readonly string[] | undefined {
    return this.delegate.compatibilityWarnings;
  }

  private endpoint(): SshPasswordEndpoint {
    const label = opensshHostLabel(this.openSshOptionsValue.target);
    return {
      hostLabel: label,
      username: label.includes("@") ? label.slice(0, label.lastIndexOf("@")) : "",
      host: this.openSshOptionsValue.target,
      port: 22,
    };
  }

  /** A cached password makes the sshpass retry start without prompting. */
  private cachedPassword(): string | undefined {
    return this.passwordProvider?.cached(this.endpoint());
  }

  private async promptPassword(error: unknown): Promise<string | undefined> {
    // Authentication failures arrive either as thrown errors (runChecked)
    // or as 255 results (run). Normalize the result so the resolver can
    // surface the real ssh rejection in the next prompt.
    const failure = error instanceof Error
      ? error
      : error && typeof error === "object" && "exitCode" in error
        ? new Error(checkedFailureText(error as SshRunResult))
        : undefined;
    return this.passwordProvider?.retry(this.endpoint(), failure);
  }

  private canRetry(error: unknown): boolean {
    if (this.cancelled || this.openedChannel || !this.passwordProvider) return false;
    if (this.sshpassAvailable === false) return false;
    const message = boundedReason(error);
    return /permission denied/i.test(message) && serverAcceptsPassword(message);
  }

  private canRetryResult(result: SshRunResult): boolean {
    if (this.cancelled || this.openedChannel || !this.passwordProvider) return false;
    if (this.sshpassAvailable === false) return false;
    const stderr = result.stderr.toString("utf8");
    return result.exitCode !== 0
      && /permission denied/i.test(stderr)
      && serverAcceptsPassword(stderr);
  }

  private async shouldDeferPasswordRetry(): Promise<boolean> {
    if (!this.passwordProvider || !this.deferPasswordRetry) return false;
    if (!this.deferPasswordRetryPromise) {
      this.deferPasswordRetryPromise = this.deferPasswordRetry().catch(() => false);
    }
    return this.deferPasswordRetryPromise;
  }

  private async retryWithPassword(error: unknown): Promise<boolean> {
    // Returns true when a retry delegate was rebuilt; throws when the
    // user cancels or sshpass is missing.
    if (this.sshpassAvailable === undefined) {
      this.sshpassAvailable = await this.detectSshpass();
      if (!this.sshpassAvailable) {
        throw new Error(
          "The remote host requires a password, but sshpass is not installed; "
            + "install it for your platform (apt install sshpass, or pacman -S sshpass "
            + "in Git Bash on Windows) or use --ssh-transport ssh2",
          { cause: error },
        );
      }
    }
    if (this.tryCached) {
      this.tryCached = false;
      const cached = this.cachedPassword();
      if (cached !== undefined) {
        await this.rebuildWithPassword(cached);
        this.triedPassword = true;
        return true;
      }
    }
    const password = await this.promptPassword(error);
    if (password === undefined) {
      this.cancelled = true;
      throw new SshPasswordCancelledError(
        `OpenSSH password authentication for ${this.openSshOptionsValue.target} was cancelled`,
        { cause: error },
      );
    }
    await this.rebuildWithPassword(password);
    this.triedPassword = true;
    return true;
  }

  private async rebuildWithPassword(password: string): Promise<void> {
    const previous = this.delegate;
    await previous.dispose();
    if (this.disposed) throw new Error("SSH client is closed");
    if (this.delegate === previous) {
      this.delegate = this.createOpenSsh({
        ...this.openSshOptionsValue,
        sshpassPassword: password,
      });
    }
  }

  async run(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    if (this.disposed) throw new Error("SSH client is closed");
    for (let attempt = 0; ; attempt++) {
      if (this.cancelled) {
        // The user dismissed the prompt: fail fast so no later candidate
        // (or the ssh2 fallback) prompts again.
        throw new SshPasswordCancelledError(
          `OpenSSH password authentication for ${this.openSshOptionsValue.target} was cancelled; reconnect with /ssh-reconnect to try again`,
        );
      }
      const selected = this.delegate;
      try {
        const result = await selected.run(command, options);
        if (!this.canRetryResult(result)) {
          if (isMaskedProxyJumpFailure(result) && await this.shouldDeferPasswordRetry()) {
            throw new ProxyJumpPasswordRequiredError({ cause: result });
          }
          this.openedChannel = true;
          return result;
        }
        if (await this.shouldDeferPasswordRetry()) {
          throw new ProxyJumpPasswordRequiredError({ cause: result });
        }
        // OpenSshClient resolves authentication failures as a 255 result
        // (only runChecked throws), so treat them like the catch branch.
        if (attempt >= 20) {
          if (this.triedPassword) {
            throw new SshPasswordFailedError(
              `OpenSSH password authentication for ${this.openSshOptionsValue.target} was rejected after ${attempt} attempts`,
              { cause: result },
            );
          }
          return result;
        }
        await this.retryWithPassword(result);
      } catch (error) {
        if (selected !== this.delegate) continue;
        if (error instanceof ProxyJumpPasswordRequiredError) throw error;
        if (!this.canRetry(error)) {
          if (isMaskedProxyJumpFailure(error) && await this.shouldDeferPasswordRetry()) {
            throw new ProxyJumpPasswordRequiredError({ cause: error });
          }
          throw error;
        }
        if (await this.shouldDeferPasswordRetry()) {
          throw new ProxyJumpPasswordRequiredError({ cause: error });
        }
        if (attempt >= 20) {
          if (this.triedPassword) {
            throw new SshPasswordFailedError(
              `OpenSSH password authentication for ${this.openSshOptionsValue.target} was rejected after ${attempt} attempts`,
              { cause: error },
            );
          }
          throw error;
        }
        await this.retryWithPassword(error);
      }
    }
  }

  async runChecked(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    return checkedResult(await this.run(command, options));
  }

  onDisconnect(listener: SshDisconnectListener): () => void {
    return this.delegate.onDisconnect?.(listener) ?? (() => {});
  }

  acquireBackgroundLease() {
    return this.delegate.acquireBackgroundLease?.();
  }

  async dispose(options?: SshDisposeOptions): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.delegate.dispose(options);
  }
}

class AutoUnixSshClient implements SshRemoteClient {
  private readonly openSshOptionsValue: SshClientOptions;
  private readonly createSsh2: (options: SshClientOptions) => SshRemoteClient;
  private readonly passwordProvider?: SshPasswordProvider;
  private delegate: SshRemoteClient;
  private fallbackPromise?: Promise<void>;
  private opensshOpenedChannel = false;
  private reason?: string;
  private disposed = false;

  constructor(
    openSshOptions: SshClientOptions,
    createOpenSsh: (options: SshClientOptions) => SshRemoteClient,
    createSsh2: (options: SshClientOptions) => SshRemoteClient,
    passwordProvider?: SshPasswordProvider,
    detectSshpass?: () => Promise<boolean>,
    detectProxyJump?: () => Promise<boolean>,
  ) {
    // Direct-host OpenSSH retries a rejected password through sshpass
    // (cached secret first, then a prompt). Effective ProxyJump failures
    // are deferred before prompting so ssh2 can authenticate each hop.
    this.delegate = new SshpassRetryClient(
      openSshOptions,
      createOpenSsh,
      passwordProvider,
      detectSshpass ?? (() => Promise.resolve(false)),
      detectProxyJump,
    );
    this.openSshOptionsValue = openSshOptions;
    this.createSsh2 = createSsh2;
    this.passwordProvider = passwordProvider;
  }

  get options(): Readonly<SshClientOptions> {
    return this.delegate.options;
  }

  get transport() {
    return this.delegate.transport;
  }

  get reusesConnection(): boolean | undefined {
    return this.delegate.reusesConnection;
  }

  get fallbackReason(): string | undefined {
    return this.reason;
  }

  get compatibilityWarnings(): readonly string[] | undefined {
    return this.delegate.compatibilityWarnings;
  }

  private canFallback(error: unknown): boolean {
    // A ProxyJump deferral, Permission denied, or missing sshpass means
    // key/agent auth failed and the password flow could not complete in
    // place; ssh2 is the remaining password-capable transport. Never
    // after an OpenSSH channel has opened (authentication already succeeded), after
    // password attempts were rejected (ssh2 would fail the same way), or
    // when the server does not accept password auth at all (ssh2 would
    // only prompt in a loop).
    const message = boundedReason(error);
    return !this.opensshOpenedChannel
      && !!this.passwordProvider
      && (error instanceof ProxyJumpPasswordRequiredError
        || (/permission denied/i.test(message) && serverAcceptsPassword(message))
        || /sshpass is not installed/i.test(message));
  }

  private canFallbackResult(result: SshRunResult): boolean {
    const stderr = result.stderr.toString("utf8");
    return !this.opensshOpenedChannel
      && !!this.passwordProvider
      && result.exitCode !== 0
      && /permission denied/i.test(stderr)
      && serverAcceptsPassword(stderr);
  }

  private async fallback(error: unknown): Promise<void> {
    if (this.fallbackPromise) return this.fallbackPromise;
    const previous = this.delegate;
    this.reason = boundedReason(error);
    const pending = (async () => {
      await previous.dispose();
      if (this.disposed) throw new Error("SSH client is closed");
      if (this.delegate === previous) this.delegate = this.createSsh2(this.openSshOptionsValue);
    })();
    this.fallbackPromise = pending;
    try {
      await pending;
    } finally {
      if (this.fallbackPromise === pending) this.fallbackPromise = undefined;
    }
  }

  async run(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    if (this.disposed) throw new Error("SSH client is closed");
    const selected = this.delegate;
    try {
      const result = await selected.run(command, options);
      if (this.canFallbackResult(result)) {
        // OpenSshClient resolves authentication failures as a 255 result
        // (only runChecked throws); route them through the same fallback.
        await this.fallback(new Error(
          `SSH command failed (${result.exitCode ?? "signal"}): ${result.stderr.toString("utf8").trim()}`,
        ));
        return await this.delegate.run(command, options);
      }
      if (selected.transport === "openssh") this.opensshOpenedChannel = true;
      return result;
    } catch (error) {
      if (selected !== this.delegate && this.reason) {
        await this.fallbackPromise?.catch(() => {});
        return this.delegate.run(command, options);
      }
      if (error instanceof SshPasswordCancelledError) {
        // The user dismissed the password prompt; another transport would
        // only prompt again.
        throw error;
      }
      if (error instanceof SshPasswordFailedError) {
        // Every password attempt was rejected; ssh2 would fail with the
        // same secret, so stop instead of falling back.
        throw error;
      }
      if (!this.canFallback(error)) throw error;
      await this.fallback(error);
      try {
        return await this.delegate.run(command, options);
      } catch (fallbackError) {
        throw new Error(
          `OpenSSH was unavailable (${this.reason}); ssh2 fallback failed: ${boundedReason(fallbackError)}`,
          { cause: fallbackError },
        );
      }
    }
  }

  async runChecked(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    return checkedResult(await this.run(command, options));
  }

  onDisconnect(listener: SshDisconnectListener): () => void {
    return this.delegate.onDisconnect?.(listener) ?? (() => {});
  }

  acquireBackgroundLease() {
    return this.delegate.acquireBackgroundLease?.();
  }

  async dispose(options?: SshDisposeOptions): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.fallbackPromise?.catch(() => {});
    await this.delegate.dispose(options);
  }
}

export function createSshTransportClient(
  options: SshClientOptions,
  factoryOptions: SshTransportFactoryOptions = {},
): SshRemoteClient {
  const platform = factoryOptions.platform ?? process.platform;
  const preference = factoryOptions.preference ?? "auto";
  const createOpenSsh = factoryOptions.createOpenSsh ?? ((value) => new OpenSshClient(value));
  const createSsh2 = factoryOptions.createSsh2 ?? ((value) => new Ssh2Client(value, {
    resolverOptions: {
      platform,
      passwordFor: factoryOptions.passwordProvider?.cached,
      allowPasswordPrompt: factoryOptions.passwordProvider !== undefined,
    },
    promptPassword: factoryOptions.passwordProvider?.retry,
  }));
  const openSshOptions: SshClientOptions = {
    ...options,
    executable: options.executable ?? (platform === "win32" ? "ssh.exe" : undefined),
    multiplex: platform === "win32" ? false : true,
  };

  const ssh2Options: SshClientOptions = {
    ...options,
    executable: options.executable ?? (platform === "win32" ? "ssh.exe" : undefined),
    // Background jobs still launch OpenSSH directly. Explicitly suppress an
    // unsupported ControlMaster inherited by the native Windows client.
    multiplex: platform === "win32" ? false : undefined,
  };
  const createSsh2ForFallback = (value: SshClientOptions): SshRemoteClient => createSsh2(value);

  if (preference === "auto" && platform !== "win32") {
    // Unix auto: multiplexed OpenSSH first, retrying a rejected password
    // through sshpass when installed, and only then falling back to ssh2.
    return new AutoUnixSshClient(
      openSshOptions,
      createOpenSsh,
      createSsh2ForFallback,
      factoryOptions.passwordProvider,
      factoryOptions.detectSshpass ?? (() => detectSshpassDefault(platform)),
      factoryOptions.detectProxyJump
        ?? (() => detectProxyJumpDefault(openSshOptions, platform)),
    );
  }
  if (preference === "openssh") {
    // Explicit OpenSSH stays non-interactive; with sshpass installed the
    // wrapper retries a failed authentication with a prompted password
    // (sshpass.exe exists for Windows via MSYS2/Git Bash/Cygwin).
    return new SshpassRetryClient(
      openSshOptions,
      createOpenSsh,
      factoryOptions.passwordProvider,
      factoryOptions.detectSshpass ?? (() => detectSshpassDefault(platform)),
    );
  }

  const ssh2 = createSsh2(ssh2Options);
  if (preference === "ssh2") return ssh2;
  return new AutoWindowsSshClient(ssh2, openSshOptions, createOpenSsh);
}
