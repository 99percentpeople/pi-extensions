import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  collectWorkspaceFile,
  createLocalWorkspaceFiles,
  registerWorkspaceFileProvider,
  resolveWorkspaceFiles,
  type WorkspaceFileSystem,
} from "@99percentpeople/pi-workspace-files";

function eventApi(): Pick<ExtensionAPI, "events"> {
  const bus = new EventEmitter();
  return {
    events: {
      on: (name, handler) => {
        bus.on(name, handler);
        return () => bus.off(name, handler);
      },
      emit: (name, data) => {
        bus.emit(name, data);
      },
    },
  };
}

test("local workspace files resolve, read, and write binary data inside the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-files-"));
  try {
    const files = createLocalWorkspaceFiles(root);
    const output = files.resolvePath("assets/image.png");
    const bytes = Buffer.from([0, 1, 2, 255]);
    assert.equal(files.extname(output), ".png");
    assert.equal(await files.exists(output), false);
    await files.mkdir(files.dirname(output));
    await files.writeFile(output, bytes);
    assert.equal(await files.exists(output), true);
    assert.deepEqual(
      await collectWorkspaceFile(await files.readFile(output)),
      bytes,
    );
    assert.deepEqual(await readFile(output), bytes);

    const streamed = files.resolvePath("assets/streamed.bin");
    async function* chunks() {
      yield Uint8Array.from([1, 2]);
      yield Uint8Array.from([3, 4]);
    }
    await files.writeFile(streamed, chunks());
    assert.deepEqual(await readFile(streamed), Buffer.from([1, 2, 3, 4]));
    assert.throws(
      () => files.resolvePath("../outside.png"),
      /must stay inside the current workspace/,
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => files.readFile(output, { signal: controller.signal }),
      /aborted/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace providers are composable, optional, and uniquely claimed", () => {
  const pi = eventApi();
  const localRoot = process.cwd();
  const remoteFiles = {
    resolvePath: (path: string) => `/remote/${path}`,
    extname: () => ".bin",
    dirname: () => "/remote",
    exists: async () => false,
    readFile: async () => Buffer.from("remote"),
    mkdir: async () => {},
    writeFile: async () => {},
  } satisfies WorkspaceFileSystem;

  const unsubscribe = registerWorkspaceFileProvider(
    pi,
    "test-remote",
    ({ cwd }) => cwd === "/local-anchor" ? remoteFiles : undefined,
  );
  assert.equal(resolveWorkspaceFiles(pi, "/local-anchor"), remoteFiles);
  assert.notEqual(resolveWorkspaceFiles(pi, localRoot), remoteFiles);

  registerWorkspaceFileProvider(pi, "second-remote", () => remoteFiles);
  assert.throws(
    () => resolveWorkspaceFiles(pi, "/local-anchor"),
    /Multiple extensions claimed.*test-remote, second-remote/,
  );
  unsubscribe();
  assert.equal(resolveWorkspaceFiles(pi, "/local-anchor"), remoteFiles);
  assert.throws(
    () => registerWorkspaceFileProvider(pi, "\n", () => remoteFiles),
    /owner must be a non-empty single line/,
  );
});
