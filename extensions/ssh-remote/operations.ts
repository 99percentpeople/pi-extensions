import type {
  BashOperations,
  EditOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { buildUnixBashCommand } from "./adapters/unix.ts";
import type { RemoteAdapter } from "./adapters/types.ts";

export const buildRemoteBashCommand = buildUnixBashCommand;

export function createRemoteReadOperations(
  adapter: RemoteAdapter,
  signal?: AbortSignal,
): ReadOperations {
  return {
    readFile: (path) => adapter.readFile(path, signal),
    access: (path) => adapter.access(path, "read", signal),
    detectImageMimeType: (path) => adapter.detectImageMimeType(path, signal),
  };
}

export function createRemoteWriteOperations(
  adapter: RemoteAdapter,
  signal?: AbortSignal,
): WriteOperations {
  return {
    mkdir: (path) => adapter.mkdir(path, signal),
    writeFile: (path, content) => adapter.writeFile(path, content, signal),
  };
}

export function createRemoteEditOperations(
  adapter: RemoteAdapter,
  signal?: AbortSignal,
): EditOperations {
  return {
    readFile: (path) => adapter.readFile(path, signal),
    writeFile: (path, content) => adapter.writeFile(path, content, signal),
    access: (path) => adapter.access(path, "write", signal),
  };
}

export function createRemoteBashOperations(
  adapter: RemoteAdapter,
  mapCwd: (cwd: string) => string = (cwd) => cwd,
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => ({
      exitCode: await adapter.runShell(command, mapCwd(cwd), {
        signal,
        timeoutSeconds: timeout,
        captureOutput: false,
        onStdout: onData,
        onStderr: onData,
        env,
      }),
    }),
  };
}
