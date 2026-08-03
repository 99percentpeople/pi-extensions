import {
  OpenSshClient,
  type SshClientOptions,
  type SshRemoteClient,
  type SshRunOptions,
  type SshRunResult,
  type SshTransportPreference,
} from "./client.ts";
import { Ssh2Client, Ssh2ConnectionError, type Ssh2ClientDependencies } from "./ssh2-client.ts";
import { Ssh2CompatibilityError } from "./ssh2-config.ts";
import type { SshPasswordEndpoint } from "./password-resolver.ts";

export interface SshPasswordProvider {
  /** Cached password for config resolution; keys still win at auth time. */
  cached(endpoint: SshPasswordEndpoint): string | undefined;
  /** Fresh password after an authentication failure (rejects stale caches). */
  retry(endpoint: SshPasswordEndpoint): Promise<string | undefined>;
}

export interface SshTransportFactoryOptions {
  platform?: NodeJS.Platform;
  preference?: SshTransportPreference;
  createOpenSsh?: (options: SshClientOptions) => SshRemoteClient;
  createSsh2?: (options: SshClientOptions) => SshRemoteClient;
  /** Password provider wired into the ssh2 client's auth retry loop. */
  passwordProvider?: SshPasswordProvider;
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const singleLine = message.replace(/\s+/g, " ").trim();
  return singleLine.length <= 500 ? singleLine : `${singleLine.slice(0, 500)}…`;
}

function checkedResult(result: SshRunResult): SshRunResult {
  if (result.exitCode === 0) return result;
  const detail = result.stderr.toString("utf8").trim();
  const bounded = detail.length <= 4_000 ? detail : `${detail.slice(0, 4_000)}…`;
  throw new Error(
    `SSH command failed (${result.exitCode ?? "signal"})${bounded ? `: ${bounded}` : ""}`,
  );
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.fallbackPromise?.catch(() => {});
    await this.delegate.dispose();
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
  ) {
    this.delegate = createOpenSsh(openSshOptions);
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
    // OpenSSH never prompts for a password (BatchMode=yes), so a
    // Permission denied from the first command means key/agent auth
    // failed. Fall back to ssh2, which can prompt for a password, but
    // only while password prompting is enabled and no OpenSSH channel has
    // opened yet (authentication would already have succeeded then).
    return !this.opensshOpenedChannel
      && !!this.passwordProvider
      && /permission denied/i.test(boundedReason(error));
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
      if (selected.transport === "openssh") this.opensshOpenedChannel = true;
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
          `OpenSSH was unavailable (${this.reason}); ssh2 fallback failed: ${boundedReason(fallbackError)}`,
          { cause: fallbackError },
        );
      }
    }
  }

  async runChecked(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    return checkedResult(await this.run(command, options));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.fallbackPromise?.catch(() => {});
    await this.delegate.dispose();
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
    // Unix auto: multiplexed OpenSSH first, falling back to ssh2 when the
    // host rejects key/agent auth so the TUI password prompt can run.
    return new AutoUnixSshClient(
      openSshOptions,
      createOpenSsh,
      createSsh2ForFallback,
      factoryOptions.passwordProvider,
    );
  }
  if (preference === "openssh") {
    return createOpenSsh(openSshOptions);
  }

  const ssh2 = createSsh2(ssh2Options);
  if (preference === "ssh2") return ssh2;
  return new AutoWindowsSshClient(ssh2, openSshOptions, createOpenSsh);
}
