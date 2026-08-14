import type { BackgroundSignal } from "./control.ts";
import {
  buildSshArguments,
  type SpawnFunction,
  type SshClientOptions,
} from "../transport/client.ts";

export interface SshProcessLaunch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface SshControlProcessResult {
  exitCode: number | null;
  closeSignal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const CONTROL_ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  75: "remote control record was not ready",
  76: "remote control record was invalid",
  77: "remote process was no longer signalable",
};

export function controlErrorDetail(exitCode: number | null, stderr: string): string {
  if (stderr) return stderr;
  return exitCode === null
    ? ""
    : CONTROL_ERROR_DESCRIPTIONS[exitCode] ?? "";
}

export class SshSignalControlError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "SshSignalControlError";
  }
}

export function buildOpenSshLaunch(
  options: SshClientOptions,
  command: string,
  allocatePty: boolean,
  redirectStdin: boolean,
  baseEnv: NodeJS.ProcessEnv,
): SshProcessLaunch {
  // Background launches deliberately do not inherit a foreground password.
  // They may reuse an authenticated ControlMaster, otherwise they require a
  // key or agent just like a manually started non-interactive ssh process.
  const sshProgram = options.executable ?? "ssh";
  return {
    file: sshProgram,
    args: [
      ...buildSshArguments(options, allocatePty, redirectStdin),
      command,
    ],
    env: { ...baseEnv },
  };
}

export function runControlProcess(
  launch: SshProcessLaunch,
  label: string,
  cwd: string,
  spawnFn: SpawnFunction,
  connectTimeoutSeconds: number,
  abortSignal?: AbortSignal,
): Promise<SshControlProcessResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ReturnType<SpawnFunction>;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timeoutMs = Math.min(
      30_000,
      Math.max(8_000, connectTimeoutSeconds * 1_000 + 5_000),
    );
    const boundedAppend = (
      chunks: Buffer[],
      currentBytes: number,
      chunk: Buffer | string,
    ): number => {
      if (currentBytes >= 4_000) return currentBytes;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const retained = data.subarray(0, 4_000 - currentBytes);
      if (retained.length > 0) chunks.push(retained);
      return currentBytes + retained.length;
    };
    const onAbort = () => {
      try {
        child?.kill("SIGKILL");
      } catch {}
      const reason = abortSignal?.reason;
      finish(reason instanceof Error ? reason : new Error(`Remote ${label} control cancelled`));
    };
    const finish = (error?: Error, result?: SshControlProcessResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    if (abortSignal?.aborted) {
      const reason = abortSignal.reason;
      reject(reason instanceof Error ? reason : new Error(`Remote ${label} control cancelled`));
      return;
    }
    try {
      child = spawnFn(launch.file, launch.args, {
        cwd,
        env: launch.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutBytes = boundedAppend(stdout, stdoutBytes, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBytes = boundedAppend(stderr, stderrBytes, chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, closeSignal) => {
      finish(undefined, {
        exitCode: code,
        closeSignal,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) {
      onAbort();
      return;
    }
    timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(new Error(`Remote ${label} control timed out`));
    }, timeoutMs);
    timeout.unref?.();
  });
}

export async function runSignalControl(
  launch: SshProcessLaunch,
  signal: BackgroundSignal,
  cwd: string,
  spawnFn: SpawnFunction,
  connectTimeoutSeconds: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  const result = await runControlProcess(
    launch,
    signal,
    cwd,
    spawnFn,
    connectTimeoutSeconds,
    abortSignal,
  );
  if (result.exitCode === 0) return;
  const detail = controlErrorDetail(result.exitCode, result.stderr);
  throw new SshSignalControlError(
    `Remote ${signal} control failed (${result.exitCode ?? result.closeSignal ?? "unknown"})${detail ? `: ${detail}` : ""}`,
    result.exitCode,
  );
}
