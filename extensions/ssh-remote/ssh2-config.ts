import { spawn } from "node:child_process";
import { getCiphers } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import ssh2, {
  type Algorithms,
  type AnyAuthMethod,
  type CipherAlgorithm,
  type CompressionAlgorithm,
  type ConnectConfig,
  type KexAlgorithm,
  type MacAlgorithm,
  type ServerHostKeyAlgorithm,
} from "ssh2";
import type { SshClientOptions } from "./client.ts";

const { createAgent, utils } = ssh2;
const MAX_LOCAL_OUTPUT_BYTES = 2 * 1024 * 1024;

const SUPPORTED_KEX = new Set<KexAlgorithm>([
  "curve25519-sha256",
  "curve25519-sha256@libssh.org",
  "ecdh-sha2-nistp256",
  "ecdh-sha2-nistp384",
  "ecdh-sha2-nistp521",
  "diffie-hellman-group-exchange-sha256",
  "diffie-hellman-group14-sha256",
  "diffie-hellman-group15-sha512",
  "diffie-hellman-group16-sha512",
  "diffie-hellman-group17-sha512",
  "diffie-hellman-group18-sha512",
  "diffie-hellman-group-exchange-sha1",
  "diffie-hellman-group14-sha1",
  "diffie-hellman-group1-sha1",
]);
// ssh2 only exposes chacha20-poly1305@openssh.com when the host crypto
// backend reports chacha20-poly1305 (its canUseCipher filter). Bun does not
// implement it, so requesting it there makes ssh2 throw "Unsupported
// algorithm". Mirror the runtime check so the negotiated cipher list always
// matches what ssh2 can actually use.
const chacha20Supported = getCiphers().includes("chacha20-poly1305");
const SUPPORTED_CIPHERS = new Set<CipherAlgorithm>([
  ...(chacha20Supported
    ? ["chacha20-poly1305@openssh.com" as CipherAlgorithm]
    : []),
  "aes128-gcm",
  "aes128-gcm@openssh.com",
  "aes256-gcm",
  "aes256-gcm@openssh.com",
  "aes128-ctr",
  "aes192-ctr",
  "aes256-ctr",
  "aes256-cbc",
  "aes192-cbc",
  "aes128-cbc",
  "blowfish-cbc",
  "3des-cbc",
  "arcfour256",
  "arcfour128",
  "cast128-cbc",
  "arcfour",
]);
const SUPPORTED_MACS = new Set<MacAlgorithm>([
  "hmac-sha2-256-etm@openssh.com",
  "hmac-sha2-512-etm@openssh.com",
  "hmac-sha1-etm@openssh.com",
  "hmac-sha2-256",
  "hmac-sha2-512",
  "hmac-sha1",
  "hmac-md5",
  "hmac-sha2-256-96",
  "hmac-sha2-512-96",
  "hmac-ripemd160",
  "hmac-sha1-96",
  "hmac-md5-96",
]);
const SUPPORTED_HOST_KEYS = new Set<ServerHostKeyAlgorithm>([
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-512",
  "rsa-sha2-256",
  "ssh-rsa",
  "ssh-dss",
]);

export interface LocalCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

export type LocalCommandRunner = (
  executable: string,
  args: readonly string[],
  timeoutMilliseconds: number,
) => Promise<LocalCommandResult>;

export interface Ssh2ConfigResolverOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  runLocal?: LocalCommandRunner;
}

export interface ResolvedSsh2Endpoint {
  config: ConnectConfig;
  hostLabel: string;
  warnings: string[];
  verification: { rejection?: string };
}

export interface ResolvedSsh2Connection extends ResolvedSsh2Endpoint {
  /** Ordered outermost-to-innermost, before the final endpoint. */
  proxyJumps?: readonly ResolvedSsh2Endpoint[];
}

export interface ParsedProxyJump {
  host: string;
  username?: string;
  port?: number;
  source: string;
}

export class Ssh2CompatibilityError extends Error {
  readonly unsupported: readonly string[];

  constructor(message: string, unsupported: readonly string[] = []) {
    super(message);
    this.name = "Ssh2CompatibilityError";
    this.unsupported = unsupported;
  }
}

export async function runLocalCommand(
  executable: string,
  args: readonly string[],
  timeoutMilliseconds: number,
): Promise<LocalCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += data.length;
      if (outputBytes > MAX_LOCAL_OUTPUT_BYTES) {
        try {
          child.kill("SIGKILL");
        } catch {}
        finishReject(new Error(`${executable} produced too much configuration output`));
        return;
      }
      target.push(data);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMilliseconds);
    timer.unref?.();

    child.stdout?.on("data", (chunk) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", finishReject);
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${executable} timed out while resolving SSH configuration`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode,
      });
    });
  });
}

export type ParsedOpenSshConfig = Map<string, string[]>;

export function parseOpenSshConfig(text: string): ParsedOpenSshConfig {
  const values: ParsedOpenSshConfig = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.search(/\s/);
    if (separator < 1) continue;
    const key = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator).trim();
    if (!value) continue;
    const current = values.get(key) ?? [];
    current.push(value);
    values.set(key, current);
  }
  return values;
}

function first(config: ParsedOpenSshConfig, key: string): string | undefined {
  return config.get(key)?.[0];
}

function enabled(value: string | undefined): boolean {
  return value === "yes" || value === "true";
}

function isNone(value: string | undefined): boolean {
  return value === undefined || value === "" || value.toLowerCase() === "none";
}

function parseJumpPort(value: string, source: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Ssh2CompatibilityError(`Invalid ProxyJump port in ${JSON.stringify(source)}`, ["ProxyJump"]);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Ssh2CompatibilityError(`Invalid ProxyJump port in ${JSON.stringify(source)}`, ["ProxyJump"]);
  }
  return port;
}

function decodeJumpUsername(value: string, source: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Ssh2CompatibilityError(
      `Invalid percent encoding in ProxyJump username ${JSON.stringify(source)}`,
      ["ProxyJump"],
    );
  }
}

export function parseProxyJump(value: string | undefined): ParsedProxyJump[] {
  if (isNone(value)) return [];
  const entries = value!.split(",");
  if (entries.length > 16) {
    throw new Ssh2CompatibilityError("ssh2 supports at most 16 ProxyJump hops", ["ProxyJump"]);
  }

  return entries.map((rawEntry) => {
    const source = rawEntry.trim();
    if (!source || /[\s\0\r\n]/.test(source)) {
      throw new Ssh2CompatibilityError(`Invalid ProxyJump destination ${JSON.stringify(rawEntry)}`, ["ProxyJump"]);
    }

    let host: string;
    let username: string | undefined;
    let port: number | undefined;
    if (/^ssh:\/\//i.test(source)) {
      let uri: URL;
      try {
        uri = new URL(source);
      } catch {
        throw new Ssh2CompatibilityError(`Invalid ProxyJump SSH URI ${JSON.stringify(source)}`, ["ProxyJump"]);
      }
      if (uri.protocol !== "ssh:" || uri.password || (uri.pathname && uri.pathname !== "/")
          || uri.search || uri.hash) {
        throw new Ssh2CompatibilityError(`Unsupported ProxyJump SSH URI ${JSON.stringify(source)}`, ["ProxyJump"]);
      }
      host = uri.hostname.replace(/^\[|\]$/g, "");
      username = uri.username ? decodeJumpUsername(uri.username, source) : undefined;
      port = uri.port ? parseJumpPort(uri.port, source) : undefined;
    } else {
      let destination = source;
      const at = destination.lastIndexOf("@");
      if (at >= 0) {
        username = destination.slice(0, at);
        destination = destination.slice(at + 1);
      }
      if (destination.startsWith("[")) {
        const close = destination.indexOf("]");
        if (close < 2) {
          throw new Ssh2CompatibilityError(`Invalid ProxyJump IPv6 destination ${JSON.stringify(source)}`, ["ProxyJump"]);
        }
        host = destination.slice(1, close);
        const suffix = destination.slice(close + 1);
        if (suffix) {
          if (!suffix.startsWith(":")) {
            throw new Ssh2CompatibilityError(`Invalid ProxyJump destination ${JSON.stringify(source)}`, ["ProxyJump"]);
          }
          port = parseJumpPort(suffix.slice(1), source);
        }
      } else {
        const firstColon = destination.indexOf(":");
        const lastColon = destination.lastIndexOf(":");
        if (firstColon > 0 && firstColon === lastColon) {
          host = destination.slice(0, firstColon);
          port = parseJumpPort(destination.slice(firstColon + 1), source);
        } else {
          // More than one colon is an unbracketed IPv6 address without a port.
          host = destination;
        }
      }
    }

    if (!host || host.startsWith("-") || /[\s\0\r\n,]/.test(host)
        || (username !== undefined && (!username || /[\s\0\r\n,]/.test(username)))) {
      throw new Ssh2CompatibilityError(`Invalid ProxyJump destination ${JSON.stringify(source)}`, ["ProxyJump"]);
    }
    return { host, username, port, source };
  });
}

export function expandProxyJumpTokens(
  value: string,
  tokens: { host: string; originalHost: string; port: number; username: string },
): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== "%") {
      result += character;
      continue;
    }
    const token = value[++index];
    if (!token) {
      throw new Ssh2CompatibilityError("ProxyJump ends with an incomplete token", ["ProxyJump"]);
    }
    if (token === "%") result += "%";
    else if (token === "h") result += tokens.host;
    else if (token === "n") result += tokens.originalHost;
    else if (token === "p") result += String(tokens.port);
    else if (token === "r") result += tokens.username;
    else {
      throw new Ssh2CompatibilityError(`ProxyJump uses unsupported token %${token}`, ["ProxyJump"]);
    }
  }
  return result;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(home, path.slice(2));
  }
  return path;
}

function companionExecutable(
  executable: string,
  name: "ssh-keygen",
  platform: NodeJS.Platform,
): string {
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    return join(dirname(executable), platform === "win32" ? `${name}.exe` : name);
  }
  return platform === "win32" ? `${name}.exe` : name;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value || value === "none") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function intersectAlgorithms<T extends string>(
  value: string | undefined,
  supported: ReadonlySet<T>,
  label: string,
): T[] | undefined {
  if (!value) return undefined;
  const result = value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is T => supported.has(item as T));
  if (result.length === 0) {
    throw new Ssh2CompatibilityError(
      `ssh2 has no supported ${label} in the effective OpenSSH configuration`,
      [label],
    );
  }
  return result;
}

function buildAlgorithms(config: ParsedOpenSshConfig): Algorithms {
  const algorithms: Algorithms = {};
  algorithms.kex = intersectAlgorithms(first(config, "kexalgorithms"), SUPPORTED_KEX, "KexAlgorithms");
  algorithms.cipher = intersectAlgorithms(first(config, "ciphers"), SUPPORTED_CIPHERS, "Ciphers");
  algorithms.hmac = intersectAlgorithms(first(config, "macs"), SUPPORTED_MACS, "MACs");
  algorithms.serverHostKey = intersectAlgorithms(
    first(config, "hostkeyalgorithms"),
    SUPPORTED_HOST_KEYS,
    "HostKeyAlgorithms",
  );
  const compression: CompressionAlgorithm[] = enabled(first(config, "compression"))
    ? ["zlib@openssh.com", "zlib", "none"]
    : ["none"];
  algorithms.compress = compression;
  return algorithms;
}

async function existingConfigPaths(
  values: readonly string[],
  home: string,
): Promise<string[]> {
  const paths: string[] = [];
  for (const rawValue of values) {
    if (rawValue.toLowerCase() === "none") continue;
    const whole = expandHome(rawValue, home);
    try {
      await access(whole);
      paths.push(whole);
      continue;
    } catch {}
    // `ssh -G` prints multiple known-host files on one line without quoting.
    // Paths containing spaces are accepted when the whole value names a file;
    // otherwise this follows OpenSSH's usual whitespace-separated output.
    for (const token of rawValue.split(/\s+/).filter(Boolean)) {
      const path = expandHome(token, home);
      try {
        await access(path);
        paths.push(path);
      } catch {}
    }
  }
  return [...new Set(paths)];
}

interface KnownHostKeys {
  accepted: Set<string>;
  revoked: Set<string>;
  hasCertificateAuthority: boolean;
}

export function parseKnownHostSearchOutput(text: string): KnownHostKeys {
  const result: KnownHostKeys = {
    accepted: new Set(),
    revoked: new Set(),
    hasCertificateAuthority: false,
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    let marker: string | undefined;
    if (fields[0]?.startsWith("@")) marker = fields.shift();
    if (fields.length < 3) continue;
    const encodedKey = fields[2];
    try {
      Buffer.from(encodedKey, "base64");
    } catch {
      continue;
    }
    if (marker === "@revoked") result.revoked.add(encodedKey);
    else if (marker === "@cert-authority") result.hasCertificateAuthority = true;
    else result.accepted.add(encodedKey);
  }
  return result;
}

async function loadKnownHostKeys(
  config: ParsedOpenSshConfig,
  executable: string,
  platform: NodeJS.Platform,
  home: string,
  lookupHost: string,
  runLocal: LocalCommandRunner,
): Promise<KnownHostKeys> {
  const configuredPaths = [
    ...(config.get("userknownhostsfile") ?? []),
    ...(config.get("globalknownhostsfile") ?? []),
  ];
  const paths = await existingConfigPaths(configuredPaths, home);
  const combined: KnownHostKeys = {
    accepted: new Set(),
    revoked: new Set(),
    hasCertificateAuthority: false,
  };
  const keygen = companionExecutable(executable, "ssh-keygen", platform);
  for (const path of paths) {
    let result: LocalCommandResult;
    try {
      result = await runLocal(keygen, ["-F", lookupHost, "-f", path], 10_000);
    } catch (error) {
      throw new Ssh2CompatibilityError(
        `Could not inspect OpenSSH known_hosts with ${keygen}: ${error instanceof Error ? error.message : String(error)}`,
        ["ssh-keygen/known_hosts verification"],
      );
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      const detail = result.stderr.toString("utf8").trim();
      throw new Ssh2CompatibilityError(
        `Could not inspect OpenSSH known_hosts with ${keygen}${detail ? `: ${detail}` : ""}`,
        ["UserKnownHostsFile/GlobalKnownHostsFile"],
      );
    }
    const parsed = parseKnownHostSearchOutput(result.stdout.toString("utf8"));
    for (const key of parsed.accepted) combined.accepted.add(key);
    for (const key of parsed.revoked) combined.revoked.add(key);
    combined.hasCertificateAuthority ||= parsed.hasCertificateAuthority;
  }
  return combined;
}

function hardUnsupportedOptions(
  config: ParsedOpenSshConfig,
  role: "target" | "jump",
): string[] {
  const checks: Array<[string, string]> = [
    ["proxycommand", "ProxyCommand"],
    ["knownhostscommand", "KnownHostsCommand"],
    ["pkcs11provider", "PKCS11Provider"],
  ];
  if (role === "target") checks.push(["remotecommand", "RemoteCommand"]);
  const unsupported: string[] = [];
  for (const [key, label] of checks) {
    if (!isNone(first(config, key))) unsupported.push(label);
  }
  if ((config.get("certificatefile") ?? []).some((value) => !isNone(value))) {
    unsupported.push("CertificateFile");
  }
  const authenticationMethods = first(config, "authenticationmethods");
  if (!isNone(authenticationMethods) && authenticationMethods !== "any") {
    unsupported.push("AuthenticationMethods");
  }
  return unsupported;
}

function resolveAgentPath(
  config: ParsedOpenSshConfig,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string | undefined {
  const configured = first(config, "identityagent");
  if (configured?.toLowerCase() === "none") return undefined;
  if (configured) {
    const expanded = configured === "SSH_AUTH_SOCK"
      ? env.SSH_AUTH_SOCK
      : expandHome(configured, home);
    return expanded || undefined;
  }
  if (env.SSH_AUTH_SOCK) return env.SSH_AUTH_SOCK;
  return platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : undefined;
}

async function buildAuthentication(
  config: ParsedOpenSshConfig,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
  username: string,
): Promise<{ methods: AnyAuthMethod[]; warnings: string[] }> {
  if (first(config, "pubkeyauthentication") === "false"
      || first(config, "pubkeyauthentication") === "no") {
    throw new Ssh2CompatibilityError(
      "ssh2 mode requires public-key or SSH-agent authentication; PubkeyAuthentication is disabled",
      ["PubkeyAuthentication=no", "password/keyboard-interactive/GSSAPI authentication"],
    );
  }

  const methods: AnyAuthMethod[] = [{ type: "none", username }];
  const warnings: string[] = [];
  let encryptedKeys = 0;
  for (const configuredPath of config.get("identityfile") ?? []) {
    if (configuredPath.toLowerCase() === "none") continue;
    const path = expandHome(configuredPath, home);
    let contents: Buffer;
    try {
      contents = await readFile(path);
    } catch {
      continue;
    }
    const parsed = utils.parseKey(contents);
    if (parsed instanceof Error) {
      if (/encrypted|passphrase/i.test(parsed.message)) encryptedKeys++;
      else warnings.push(`ssh2 skipped unsupported identity file: ${path}`);
      continue;
    }
    const keys = Array.isArray(parsed) ? parsed : [parsed];
    for (const key of keys) {
      if (!key.isPrivateKey()) continue;
      methods.push({ type: "publickey", username, key });
    }
  }

  const identitiesOnly = enabled(first(config, "identitiesonly"));
  const agentPath = resolveAgentPath(config, platform, env, home);
  if (!identitiesOnly && agentPath) {
    methods.push({ type: "agent", username, agent: createAgent(agentPath) });
  } else if (identitiesOnly && encryptedKeys > 0) {
    if (methods.length === 1) {
      throw new Ssh2CompatibilityError(
        "ssh2 cannot combine IdentitiesOnly=yes with encrypted IdentityFile keys through the agent",
        ["IdentitiesOnly=yes with encrypted keys"],
      );
    }
    warnings.push(
      "encrypted IdentityFile keys were skipped because IdentitiesOnly=yes prevents unfiltered agent use",
    );
  }

  if (methods.length === 1) {
    const reason = encryptedKeys > 0
      ? "configured private keys are encrypted and no compatible SSH agent is available"
      : "no readable private key or SSH agent is available";
    throw new Ssh2CompatibilityError(
      `ssh2 authentication is unavailable: ${reason}`,
      ["password/keyboard-interactive/GSSAPI authentication"],
    );
  }
  return { methods, warnings };
}

interface ResolverContext {
  options: SshClientOptions;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  runLocal: LocalCommandRunner;
  executable: string;
  connectTimeout: number;
}

interface EndpointRequest {
  target: string;
  username?: string;
  port?: number;
  disableProxyJump: boolean;
  role: "target" | "jump";
}

interface EndpointResolution {
  endpoint: ResolvedSsh2Endpoint;
  openSsh: ParsedOpenSshConfig;
}

function validateConfigTarget(target: string): void {
  if (!target || target.startsWith("-") || /[\s\0\r\n]/.test(target)) {
    throw new Error(`Invalid SSH target: ${JSON.stringify(target)}`);
  }
}

async function resolveSsh2Endpoint(
  context: ResolverContext,
  request: EndpointRequest,
): Promise<EndpointResolution> {
  validateConfigTarget(request.target);
  const args: string[] = [];
  if (context.options.configFile) args.push("-F", context.options.configFile);
  args.push(
    "-G",
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${context.connectTimeout}`,
  );
  if (request.disableProxyJump) args.push("-o", "ProxyJump=none");
  if (request.username) args.push("-l", request.username);
  if (request.port !== undefined) args.push("-p", String(request.port));
  args.push(request.target);

  let generated: LocalCommandResult;
  try {
    generated = await context.runLocal(context.executable, args, 15_000);
  } catch (error) {
    throw new Ssh2CompatibilityError(
      `OpenSSH could not resolve ${request.target} for ssh2: ${error instanceof Error ? error.message : String(error)}`,
      ["OpenSSH configuration resolution"],
    );
  }
  if (generated.exitCode !== 0) {
    const detail = generated.stderr.toString("utf8").trim();
    throw new Ssh2CompatibilityError(
      `OpenSSH could not resolve ${request.target} for ssh2${detail ? `: ${detail}` : ""}`,
      ["OpenSSH configuration resolution"],
    );
  }

  const openSsh = parseOpenSshConfig(generated.stdout.toString("utf8"));
  const unsupported = hardUnsupportedOptions(openSsh, request.role);
  if (unsupported.length > 0) {
    throw new Ssh2CompatibilityError(
      `ssh2 does not support these effective OpenSSH options for ${request.target}: ${unsupported.join(", ")}. `
        + "Select the OpenSSH transport for this target.",
      unsupported,
    );
  }

  const host = first(openSsh, "hostname");
  const username = first(openSsh, "user");
  const port = parseInteger(first(openSsh, "port"), 22);
  if (!host || !username || /[\s\0\r\n]/.test(host) || port < 1 || port > 65_535) {
    throw new Ssh2CompatibilityError("OpenSSH returned an invalid host, user, or port for ssh2");
  }

  const hostKeyName = first(openSsh, "hostkeyalias") ?? host;
  const lookupHost = port === 22 ? hostKeyName : `[${hostKeyName}]:${port}`;
  const knownHostKeys = await loadKnownHostKeys(
    openSsh,
    context.executable,
    context.platform,
    context.home,
    lookupHost,
    context.runLocal,
  );
  if (knownHostKeys.accepted.size === 0) {
    const authority = knownHostKeys.hasCertificateAuthority
      ? " The host is trusted only through @cert-authority, which ssh2 mode does not support."
      : " Run the system OpenSSH client once to trust the host key first.";
    throw new Ssh2CompatibilityError(
      `No directly trusted host key for ${lookupHost} was found in OpenSSH known_hosts.${authority}`,
      knownHostKeys.hasCertificateAuthority ? ["@cert-authority"] : ["unknown host key enrollment"],
    );
  }

  const authentication = await buildAuthentication(
    openSsh,
    context.platform,
    context.env,
    context.home,
    username,
  );
  const verification: { rejection?: string } = {};
  const addressFamily = first(openSsh, "addressfamily");
  const localAddress = first(openSsh, "bindaddress");
  const config: ConnectConfig = {
    host,
    port,
    username,
    authHandler: authentication.methods,
    algorithms: buildAlgorithms(openSsh),
    readyTimeout: Math.max(
      1,
      parseInteger(first(openSsh, "connecttimeout"), context.connectTimeout),
    ) * 1_000,
    keepaliveInterval: parseInteger(first(openSsh, "serveraliveinterval"), 30) * 1_000,
    keepaliveCountMax: parseInteger(first(openSsh, "serveralivecountmax"), 3),
    forceIPv4: addressFamily === "inet",
    forceIPv6: addressFamily === "inet6",
    localAddress: localAddress && localAddress !== "*" ? localAddress : undefined,
    hostVerifier: (key: Buffer) => {
      const encoded = key.toString("base64");
      if (knownHostKeys.revoked.has(encoded)) {
        verification.rejection = `The host key for ${lookupHost} is marked @revoked`;
        return false;
      }
      if (!knownHostKeys.accepted.has(encoded)) {
        verification.rejection = `The host key presented by ${lookupHost} does not match OpenSSH known_hosts`;
        return false;
      }
      return true;
    },
  };

  return {
    endpoint: {
      config,
      hostLabel: `${username}@${host}:${port}`,
      warnings: authentication.warnings,
      verification,
    },
    openSsh,
  };
}

export async function resolveSsh2Connection(
  options: SshClientOptions,
  resolverOptions: Ssh2ConfigResolverOptions = {},
): Promise<ResolvedSsh2Connection> {
  validateConfigTarget(options.target);
  const platform = resolverOptions.platform ?? process.platform;
  const connectTimeout = options.connectTimeoutSeconds ?? 10;
  if (!Number.isInteger(connectTimeout) || connectTimeout < 1 || connectTimeout > 600) {
    throw new Error("SSH connect timeout must be an integer from 1 to 600 seconds");
  }
  const context: ResolverContext = {
    options,
    platform,
    env: resolverOptions.env ?? process.env,
    home: resolverOptions.home ?? homedir(),
    runLocal: resolverOptions.runLocal ?? runLocalCommand,
    executable: options.executable ?? (platform === "win32" ? "ssh.exe" : "ssh"),
    connectTimeout,
  };
  const target = await resolveSsh2Endpoint(context, {
    target: options.target,
    disableProxyJump: false,
    role: "target",
  });

  const proxyJump = first(target.openSsh, "proxyjump");
  const targetHost = target.endpoint.config.host!;
  const targetPort = target.endpoint.config.port ?? 22;
  const targetUsername = target.endpoint.config.username!;
  const originalHost = first(target.openSsh, "host")
    ?? options.target.slice(options.target.lastIndexOf("@") + 1);
  const jumpSpecs = parseProxyJump(isNone(proxyJump) ? undefined : expandProxyJumpTokens(proxyJump!, {
    host: targetHost,
    originalHost,
    port: targetPort,
    username: targetUsername,
  }));
  const proxyJumps: ResolvedSsh2Endpoint[] = [];
  for (const jump of jumpSpecs) {
    const resolved = await resolveSsh2Endpoint(context, {
      target: jump.host,
      username: jump.username,
      port: jump.port,
      disableProxyJump: true,
      role: "jump",
    });
    proxyJumps.push(resolved.endpoint);
  }

  return {
    ...target.endpoint,
    proxyJumps,
  };
}
