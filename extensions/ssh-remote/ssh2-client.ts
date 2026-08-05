import ssh2, {
  type Client as RawSsh2Client,
  type ClientChannel,
} from "ssh2";
import {
  type SshClientOptions,
  type SshRemoteClient,
  type SshRunOptions,
  type SshRunResult,
} from "./client.ts";
import {
  resolveSsh2Connection,
  type ResolvedSsh2Connection,
  type ResolvedSsh2Endpoint,
  type Ssh2ConfigResolverOptions,
} from "./ssh2-config.ts";
import type { SshPasswordEndpoint } from "./password-resolver.ts";

const { Client } = ssh2;

function boundedErrorText(buffer: Buffer): string {
  const text = buffer.toString("utf8").trim();
  return text.length <= 4_000 ? text : `${text.slice(0, 4_000)}…`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthenticationFailure(
  error: Ssh2ConnectionError,
  endpoint: ResolvedSsh2Endpoint | SshPasswordEndpoint,
): boolean {
  // Host key problems are resolved before authentication; never ask for a
  // password for them.
  if ("verification" in endpoint && endpoint.verification.rejection) return false;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const level = (cause as { level?: unknown }).level;
    if (level === "client-authentication") return true;
  }
  return /all configured authentication methods failed|authentication failed/i.test(error.message);
}

export class Ssh2ConnectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "Ssh2ConnectionError";
  }
}

export interface Ssh2ClientDependencies {
  createClient?: () => RawSsh2Client;
  resolveConnection?: typeof resolveSsh2Connection;
  resolverOptions?: Ssh2ConfigResolverOptions;
  maxChannels?: number;
  /** Grace period before a stuck cancelled channel invalidates the connection. */
  terminationGraceMs?: number;
  /**
   * Called when an endpoint's authentication fails. Returns a password to
   * retry with, or undefined to abort (cancelled / no UI).
   */
  promptPassword?: (
    endpoint: SshPasswordEndpoint,
    error: Ssh2ConnectionError,
  ) => Promise<string | undefined>;
}

interface ChannelWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class Ssh2Client implements SshRemoteClient {
  readonly options: Readonly<SshClientOptions>;
  readonly transport = "ssh2" as const;
  readonly reusesConnection = true;
  private readonly createClient: () => RawSsh2Client;
  private readonly resolveConnection: typeof resolveSsh2Connection;
  private readonly resolverOptions: Ssh2ConfigResolverOptions;
  private readonly maxChannels: number;
  private readonly terminationGraceMs: number;
  private readonly promptPassword: Ssh2ClientDependencies["promptPassword"];
  private readonly channels = new Set<ClientChannel>();
  private readonly tunnelChannels = new Set<ClientChannel>();
  private readonly connectionClients = new Set<RawSsh2Client>();
  private readonly connectingClients = new Set<RawSsh2Client>();
  private readonly channelWaiters: ChannelWaiter[] = [];
  private connection?: RawSsh2Client;
  private connectPromise?: Promise<RawSsh2Client>;
  private activeChannels = 0;
  private warningList: string[] = [];
  private passwordPromptCancelled = false;
  private disposed = false;

  constructor(options: SshClientOptions, dependencies: Ssh2ClientDependencies = {}) {
    this.options = { ...options };
    this.createClient = dependencies.createClient ?? (() => new Client());
    this.resolveConnection = dependencies.resolveConnection ?? resolveSsh2Connection;
    this.resolverOptions = dependencies.resolverOptions ?? {};
    this.maxChannels = dependencies.maxChannels ?? 8;
    this.terminationGraceMs = dependencies.terminationGraceMs ?? 1_000;
    this.promptPassword = dependencies.promptPassword;
    if (!Number.isInteger(this.maxChannels) || this.maxChannels < 1 || this.maxChannels > 64) {
      throw new Error("ssh2 maxChannels must be an integer from 1 to 64");
    }
    if (
      !Number.isInteger(this.terminationGraceMs)
      || this.terminationGraceMs < 1
      || this.terminationGraceMs > 30_000
    ) {
      throw new Error("ssh2 terminationGraceMs must be an integer from 1 to 30000");
    }
  }

  get compatibilityWarnings(): readonly string[] {
    return this.warningList;
  }

  private invalidateConnection(source?: RawSsh2Client): void {
    if (source && !this.connectionClients.has(source)) return;
    this.connection = undefined;
    const clients = [
      ...this.connectionClients,
      ...this.connectingClients,
    ];
    this.connectionClients.clear();
    this.connectingClients.clear();
    for (const channel of this.tunnelChannels) {
      try {
        channel.close();
      } catch {}
    }
    this.tunnelChannels.clear();
    for (const client of clients) {
      if (client === source) continue;
      try {
        client.destroy();
      } catch {}
    }
  }

  private connectEndpoint(
    endpoint: ResolvedSsh2Endpoint,
    socket?: ClientChannel,
  ): Promise<RawSsh2Client> {
    if (this.disposed) return Promise.reject(new Error("SSH client is closed"));
    const client = this.createClient();
    this.connectingClients.add(client);
    return new Promise<RawSsh2Client>((resolve, reject) => {
      let ready = false;
      let settled = false;
      const rejectSetup = (error: unknown) => {
        if (settled) return;
        settled = true;
        this.connectingClients.delete(client);
        try {
          client.destroy();
        } catch {}
        const verification = endpoint.verification.rejection;
        const detail = verification ?? errorText(error);
        reject(new Ssh2ConnectionError(`ssh2 connection to ${endpoint.hostLabel} failed: ${detail}`, {
          cause: error,
        }));
      };
      const onError = (error: Error) => {
        if (!ready) rejectSetup(error);
      };
      const onClose = () => {
        this.connectingClients.delete(client);
        if (this.connectionClients.has(client)) this.invalidateConnection(client);
        if (!ready) rejectSetup(new Error("connection closed before authentication completed"));
      };

      client.on("error", onError);
      client.on("close", onClose);
      client.once("ready", () => {
        if (settled) return;
        if (this.disposed) {
          rejectSetup(new Error("SSH client is closed"));
          return;
        }
        ready = true;
        settled = true;
        this.connectingClients.delete(client);
        this.connectionClients.add(client);
        resolve(client);
      });
      try {
        client.connect(socket ? { ...endpoint.config, sock: socket } : endpoint.config);
      } catch (error) {
        rejectSetup(error);
      }
    });
  }

  private openForward(
    client: RawSsh2Client,
    from: ResolvedSsh2Endpoint,
    to: ResolvedSsh2Endpoint,
  ): Promise<ClientChannel> {
    if (this.disposed) return Promise.reject(new Error("SSH client is closed"));
    const host = to.config.host;
    const port = to.config.port ?? 22;
    if (!host || port < 1 || port > 65_535) {
      return Promise.reject(new Ssh2ConnectionError(`Invalid ProxyJump destination ${to.hostLabel}`));
    }
    const timeoutMilliseconds = Math.max(1_000, to.config.readyTimeout ?? 10_000);
    return new Promise<ClientChannel>((resolve, reject) => {
      let settled = false;
      const finishReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Ssh2ConnectionError(
          `ssh2 ProxyJump through ${from.hostLabel} could not forward to ${to.hostLabel}: ${errorText(error)}. `
            + "Ensure the jump server permits TCP forwarding to this destination.",
          { cause: error },
        ));
      };
      const timeout = setTimeout(() => {
        finishReject(new Error("forwarding request timed out"));
      }, timeoutMilliseconds);
      timeout.unref?.();
      try {
        client.forwardOut("127.0.0.1", 0, host, port, (error, channel) => {
          if (error) {
            finishReject(error);
            return;
          }
          if (settled || this.disposed || !this.connectionClients.has(client)) {
            try {
              channel?.close();
            } catch {}
            if (!settled) finishReject(new Error("jump connection closed"));
            return;
          }
          settled = true;
          clearTimeout(timeout);
          channel.on("error", () => {});
          this.tunnelChannels.add(channel);
          resolve(channel);
        });
      } catch (error) {
        finishReject(error);
      }
    });
  }

  private async openConnection(): Promise<RawSsh2Client> {
    // One-shot connect chain. On authentication failure the optional
    // promptPassword callback supplies a password (asking the user when
    // nothing is cached) and the whole chain is rebuilt and retried until
    // success, cancellation, or the attempt cap.
    for (let attempt = 0; ; attempt++) {
      if (this.passwordPromptCancelled) {
        throw new Ssh2ConnectionError(
          "password authentication was cancelled; reconnect with /ssh-reconnect to try again",
        );
      }
      try {
        return await this.openConnectionAttempt();
      } catch (error) {
        const failedEndpoint = (error as Ssh2ConnectionError & { ssh2Endpoint?: SshPasswordEndpoint })
          .ssh2Endpoint;
        if (
          !(error instanceof Ssh2ConnectionError)
          || !this.promptPassword
          || !failedEndpoint
          || !isAuthenticationFailure(error, failedEndpoint)
        ) {
          throw error;
        }
        if (attempt >= 20) {
          throw new Ssh2ConnectionError(
            `ssh2 connection to ${failedEndpoint.hostLabel} failed: too many password retries`,
            { cause: error },
          );
        }
        const password = await this.promptPassword(failedEndpoint, error);
        if (password === undefined) {
          this.passwordPromptCancelled = true;
          throw new Ssh2ConnectionError(
            `ssh2 connection to ${failedEndpoint.hostLabel} failed: password authentication was cancelled`,
            { cause: error },
          );
        }
      }
    }
  }

  private async openConnectionAttempt(): Promise<RawSsh2Client> {
    let resolved: ResolvedSsh2Connection;
    try {
      resolved = await this.resolveConnection(this.options, this.resolverOptions);
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Ssh2ConnectionError(`Could not resolve ssh2 configuration: ${String(error)}`);
    }
    if (this.disposed) throw new Error("SSH client is closed");
    const jumps = [...(resolved.proxyJumps ?? [])];
    this.warningList = [
      ...jumps.flatMap((jump, index) => jump.warnings.map(
        (warning) => `ProxyJump ${index + 1} (${jump.hostLabel}): ${warning}`,
      )),
      ...resolved.warnings,
    ];

    const endpoints: ResolvedSsh2Endpoint[] = [...jumps, resolved];
    const clients: RawSsh2Client[] = [];
    let socket: ClientChannel | undefined;
    try {
      for (let index = 0; index < endpoints.length; index++) {
        const endpoint = endpoints[index];
        let client: RawSsh2Client;
        try {
          client = await this.connectEndpoint(endpoint, socket);
        } catch (error) {
          if (error instanceof Ssh2ConnectionError) {
            (error as Ssh2ConnectionError & { ssh2Endpoint?: SshPasswordEndpoint }).ssh2Endpoint = {
              hostLabel: endpoint.hostLabel,
              username: endpoint.config.username ?? "",
              host: endpoint.config.host ?? "",
              port: endpoint.config.port ?? 22,
            };
          }
          throw error;
        }
        clients.push(client);
        const next = endpoints[index + 1];
        if (next) socket = await this.openForward(client, endpoint, next);
      }
      if (this.disposed) throw new Error("SSH client is closed");
      if (clients.some((client) => !this.connectionClients.has(client))) {
        throw new Ssh2ConnectionError("SSH connection chain closed during setup");
      }
      const finalClient = clients.at(-1)!;
      this.connection = finalClient;
      return finalClient;
    } catch (error) {
      this.invalidateConnection();
      throw error;
    }
  }

  private ensureConnection(): Promise<RawSsh2Client> {
    if (this.disposed) return Promise.reject(new Error("SSH client is closed"));
    if (this.connection) return Promise.resolve(this.connection);
    if (this.connectPromise) return this.connectPromise;
    const pending = this.openConnection();
    this.connectPromise = pending;
    void pending.finally(() => {
      if (this.connectPromise === pending) this.connectPromise = undefined;
    }).catch(() => {});
    return pending;
  }

  private acquireChannel(signal?: AbortSignal): Promise<() => void> {
    if (this.disposed) return Promise.reject(new Error("SSH client is closed"));
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    if (this.activeChannels < this.maxChannels) {
      this.activeChannels++;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter: ChannelWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.channelWaiters.indexOf(waiter);
          if (index >= 0) this.channelWaiters.splice(index, 1);
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.channelWaiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.channelWaiters.length > 0) {
        const waiter = this.channelWaiters.shift()!;
        if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
        if (waiter.signal?.aborted) {
          waiter.reject(new Error("aborted"));
          continue;
        }
        waiter.resolve(this.makeRelease());
        return;
      }
      this.activeChannels--;
    };
  }

  async run(command: string, options: SshRunOptions = {}): Promise<SshRunResult> {
    if (this.disposed) throw new Error("SSH client is closed");
    if (options.signal?.aborted) throw new Error("aborted");
    if (options.timeoutSeconds !== undefined
        && (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0)) {
      throw new Error("SSH timeout must be a positive number of seconds");
    }

    const release = await this.acquireChannel(options.signal);
    let connection: RawSsh2Client;
    try {
      connection = await this.ensureConnection();
    } catch (error) {
      release();
      throw error;
    }
    if (options.signal?.aborted) {
      release();
      throw new Error("aborted");
    }

    return new Promise<SshRunResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stream: ClientChannel | undefined;
      let exitCode: number | null = null;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let forceCloseHandle: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let settled = false;
      let terminationRequested = false;
      let terminationApplied = false;

      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (forceCloseHandle) clearTimeout(forceCloseHandle);
        options.signal?.removeEventListener("abort", onAbort);
        connection.removeListener("close", onConnectionClose);
        if (stream) this.channels.delete(stream);
        release();
      };
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        try {
          stream?.close();
        } catch {}
        cleanup();
        reject(error);
      };
      const cancellationError = (): Error => options.signal?.aborted
        ? new Error("aborted")
        : timedOut
          ? new Error(`timeout:${options.timeoutSeconds}`)
          : new Error("SSH command cancellation did not close the channel");
      const forceTermination = () => {
        if (settled) return;
        try {
          stream?.signal("KILL");
        } catch {}
        try {
          stream?.close();
        } catch {}
        try {
          stream?.destroy();
        } catch {}
        finishReject(cancellationError());
        // A Windows OpenSSH server can ignore channel signals and keep a
        // PowerShell tree alive after channel.close(). Tear down the stuck
        // persistent connection so Esc/timeout cannot wait indefinitely.
        try {
          connection.destroy();
        } catch {}
        this.invalidateConnection(connection);
      };
      const applyTermination = () => {
        if (!stream || terminationApplied) return;
        terminationApplied = true;
        try {
          stream.signal("TERM");
        } catch {}
      };
      const requestTermination = () => {
        if (!terminationRequested) {
          terminationRequested = true;
          forceCloseHandle = setTimeout(forceTermination, this.terminationGraceMs);
          forceCloseHandle.unref?.();
        }
        applyTermination();
      };
      const onAbort = () => requestTermination();
      const onConnectionClose = () => finishReject(
        terminationRequested
          ? cancellationError()
          : new Ssh2ConnectionError("ssh2 connection closed while a command was running"),
      );

      connection.once("close", onConnectionClose);
      if (options.timeoutSeconds !== undefined) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          requestTermination();
        }, options.timeoutSeconds * 1_000);
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        connection.exec(command, (error, channel) => {
          if (error) {
            finishReject(new Ssh2ConnectionError(`Could not open an ssh2 command channel: ${error.message}`, {
              cause: error,
            }));
            return;
          }
          // A forced cancellation can settle the command and invalidate the
          // connection before ssh2 invokes this callback. Never resurrect a
          // late channel after its semaphore slot and connection were released.
          if (settled) {
            channel.on("error", () => {});
            try {
              channel.close();
            } catch {}
            try {
              channel.destroy();
            } catch {}
            return;
          }
          stream = channel;
          this.channels.add(channel);

          channel.on("data", (chunk: Buffer | string) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (options.captureOutput !== false) stdout.push(data);
            options.onStdout?.(data);
          });
          channel.stderr.on("data", (chunk: Buffer | string) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (options.captureOutput !== false) stderr.push(data);
            options.onStderr?.(data);
          });
          channel.on("exit", (code: number | null) => {
            exitCode = typeof code === "number" ? code : null;
          });
          channel.once("error", (streamError: Error) => finishReject(streamError));
          channel.once("close", () => {
            if (settled) return;
            settled = true;
            cleanup();
            if (options.signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            if (timedOut) {
              reject(new Error(`timeout:${options.timeoutSeconds}`));
              return;
            }
            resolve({
              stdout: Buffer.concat(stdout),
              stderr: Buffer.concat(stderr),
              exitCode,
            });
          });
          channel.on("error", () => {});
          channel.end(options.input);
          if (options.signal?.aborted || timedOut || terminationRequested) {
            requestTermination();
          }
        });
      } catch (error) {
        finishReject(new Ssh2ConnectionError(`Could not execute an ssh2 command: ${errorText(error)}`, {
          cause: error,
        }));
      }
    });
  }

  async runChecked(command: string, options?: SshRunOptions): Promise<SshRunResult> {
    const result = await this.run(command, options);
    if (result.exitCode === 0) return result;
    const detail = boundedErrorText(result.stderr);
    throw new Error(
      `SSH command failed (${result.exitCode ?? "signal"})${detail ? `: ${detail}` : ""}`,
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.channelWaiters.splice(0)) {
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("SSH client is closed"));
    }
    for (const channel of this.channels) {
      try {
        channel.close();
      } catch {}
    }
    this.channels.clear();

    const clients = [...new Set([
      ...this.connectionClients,
      ...this.connectingClients,
    ])];
    this.connection = undefined;
    this.connectionClients.clear();
    this.connectingClients.clear();
    for (const channel of this.tunnelChannels) {
      try {
        channel.close();
      } catch {}
    }
    this.tunnelChannels.clear();
    if (clients.length === 0) return;

    await new Promise<void>((resolve) => {
      const pending = new Set(clients);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        for (const client of pending) {
          try {
            client.destroy();
          } catch {}
        }
        finish();
      }, 1_000);
      timeout.unref?.();
      for (const client of clients) {
        client.once("close", () => {
          pending.delete(client);
          if (pending.size === 0) finish();
        });
      }
      for (const client of [...clients].reverse()) {
        try {
          client.end();
        } catch {
          pending.delete(client);
        }
      }
      if (pending.size === 0) finish();
    });
  }
}
