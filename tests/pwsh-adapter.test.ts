import assert from "node:assert/strict";
import {
  type ChildProcess,
  spawn,
  spawnSync,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  createPwshBashOperations,
  selectPowerShellRuntime,
  type PowerShellProcessOptions,
  type PowerShellRuntime,
} from "../extensions/pwsh-adapter/index.ts";

const runtime: PowerShellRuntime = {
  file: "pwsh.exe",
  kind: "powershell-7",
  version: "7.5.2",
  label: "PowerShell 7.5.2",
};

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = null;
  readonly pid: number;
  exitCode: number | null = null;
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitExit(code: number | null): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  emitClose(code: number | null): void {
    this.emit("close", code, null);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function fakeSpawn(
  primary: FakeChildProcess,
  taskkills: FakeChildProcess[] = [],
  calls: Array<{ file: string; args: readonly string[] }> = [],
): typeof spawn {
  return ((file: string, args: readonly string[] = []) => {
    calls.push({ file, args });
    if (file === "taskkill") {
      const taskkill = taskkills.shift();
      if (!taskkill) throw new Error("unexpected taskkill spawn");
      return taskkill.asChildProcess();
    }
    assert.equal(file, runtime.file);
    return primary.asChildProcess();
  }) as typeof spawn;
}

function createOperations(
  primary: FakeChildProcess,
  options: PowerShellProcessOptions = {},
  taskkills: FakeChildProcess[] = [],
  calls: Array<{ file: string; args: readonly string[] }> = [],
) {
  return createPwshBashOperations(runtime, {
    exitCloseGraceMs: 10,
    taskkillTimeoutMs: 15,
    postKillGraceMs: 10,
    spawn: fakeSpawn(primary, taskkills, calls),
    kill: () => true,
    ...options,
  });
}

function execWithOutput(
  primary: FakeChildProcess,
  options: PowerShellProcessOptions & {
    signal?: AbortSignal;
    timeout?: number;
  } = {},
  taskkills: FakeChildProcess[] = [],
  calls: Array<{ file: string; args: readonly string[] }> = [],
  cwd = process.cwd(),
) {
  const chunks: Buffer[] = [];
  const operations = createOperations(primary, options, taskkills, calls);
  const result = operations.exec("Write-Output ok", cwd, {
    onData: (data) => chunks.push(Buffer.from(data)),
    signal: options.signal,
    timeout: options.timeout,
  });
  return {
    result,
    output: () => Buffer.concat(chunks).toString("utf8"),
    async waitForSpawn() {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (calls.some((call) => call.file === runtime.file)) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error("PowerShell fixture did not spawn");
    },
  };
}

test("PowerShell operations resolve after exit when descendants keep stdio open", async () => {
  const primary = new FakeChildProcess(1001);
  const execution = execWithOutput(primary);
  await execution.waitForSpawn();

  primary.stdout.write("partial stdout\n");
  primary.stderr.write("partial stderr\n");
  primary.emitExit(0);

  assert.deepEqual(await execution.result, { exitCode: 0 });
  assert.equal(execution.output(), "partial stdout\npartial stderr\n");
  assert.equal(primary.stdout.destroyed, true);
  assert.equal(primary.stderr.destroyed, true);
  assert.doesNotThrow(() => primary.emit("error", new Error("late error")));
});

test("PowerShell operations prefer close during the post-exit grace period", async () => {
  const primary = new FakeChildProcess(1002);
  const execution = execWithOutput(primary, { exitCloseGraceMs: 50 });
  await execution.waitForSpawn();

  primary.emitExit(7);
  setTimeout(() => primary.emitClose(3), 5);

  assert.deepEqual(await execution.result, { exitCode: 3 });
});

test("PowerShell operations reject a missing cwd before spawning", async () => {
  const primary = new FakeChildProcess(1010);
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const missingCwd = join(
    tmpdir(),
    `pi-pwsh-missing-cwd-${process.pid}-${Date.now()}`,
  );
  await rm(missingCwd, { force: true, recursive: true });

  const execution = execWithOutput(primary, {}, [], calls, missingCwd);

  await assert.rejects(execution.result, (error: Error) => {
    assert.equal(
      error.message,
      `Working directory does not exist: ${missingCwd}\nCannot execute PowerShell commands.`,
    );
    return true;
  });
  assert.deepEqual(calls, []);
});

test("PowerShell operations classify cwd deletion races separately from missing executables", async () => {
  const primary = new FakeChildProcess(1011);
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const cwd = await mkdtemp(join(tmpdir(), "pi-pwsh-cwd-race-"));

  try {
    const execution = execWithOutput(primary, {}, [], calls, cwd);
    await execution.waitForSpawn();
    await rm(cwd, { force: true, recursive: true });
    primary.emit("error", Object.assign(new Error("spawn pwsh.exe ENOENT"), {
      code: "ENOENT",
    }));

    await assert.rejects(execution.result, (error: Error) => {
      assert.equal(
        error.message,
        `Working directory does not exist: ${cwd}\nCannot execute PowerShell commands.`,
      );
      return true;
    });
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("PowerShell operations map executable spawn failures", async () => {
  const primary = new FakeChildProcess(1003);
  const execution = execWithOutput(primary);
  await execution.waitForSpawn();
  const error = Object.assign(new Error("spawn pwsh.exe ENOENT"), {
    code: "ENOENT",
  });

  queueMicrotask(() => primary.emit("error", error));

  await assert.rejects(
    execution.result,
    /PowerShell 7\.5\.2 executable `pwsh\.exe` was not found/,
  );
  assert.equal(primary.stdout.destroyed, true);
  assert.equal(primary.stderr.destroyed, true);
});

test("PowerShell timeout preserves partial output and settles after taskkill", async () => {
  const primary = new FakeChildProcess(1004);
  const taskkill = new FakeChildProcess(2004);
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const execution = execWithOutput(
    primary,
    { timeout: 0.005 },
    [taskkill],
    calls,
  );
  await execution.waitForSpawn();

  primary.stdout.write("partial JSON");
  setTimeout(() => taskkill.emitExit(0), 8);

  await assert.rejects(execution.result, /timeout:0\.005/);
  assert.equal(execution.output(), "partial JSON");
  assert.deepEqual(calls[1], {
    file: "taskkill",
    args: ["/F", "/T", "/PID", "1004"],
  });
  assert.equal(primary.stdout.destroyed, true);
  assert.equal(primary.stderr.destroyed, true);
});

test("PowerShell timeout falls back when taskkill emits an error", async () => {
  const primary = new FakeChildProcess(1005);
  const taskkill = new FakeChildProcess(2005);
  const killedPids: number[] = [];
  const execution = execWithOutput(
    primary,
    {
      timeout: 0.001,
      kill: (pid) => {
        killedPids.push(pid);
        return true;
      },
    },
    [taskkill],
  );
  await execution.waitForSpawn();

  setTimeout(() => taskkill.emit("error", new Error("taskkill unavailable")), 3);

  await assert.rejects(execution.result, /timeout:0\.001/);
  assert.deepEqual(killedPids, [1005]);
});

test("PowerShell timeout remains bounded when taskkill hangs", async () => {
  const primary = new FakeChildProcess(1006);
  const taskkill = new FakeChildProcess(2006);
  const killedPids: number[] = [];
  const startedAt = Date.now();
  const execution = execWithOutput(
    primary,
    {
      timeout: 0.001,
      taskkillTimeoutMs: 10,
      postKillGraceMs: 5,
      kill: (pid) => {
        killedPids.push(pid);
        return true;
      },
    },
    [taskkill],
  );
  await execution.waitForSpawn();

  await assert.rejects(execution.result, /timeout:0\.001/);
  assert.ok(Date.now() - startedAt < 200, "timeout finalization should be bounded");
  assert.equal(taskkill.killed, true);
  assert.deepEqual(killedPids, [1006]);
});

test("PowerShell abort remains bounded when close never arrives", async () => {
  const primary = new FakeChildProcess(1007);
  const taskkill = new FakeChildProcess(2007);
  const controller = new AbortController();
  const execution = execWithOutput(
    primary,
    { signal: controller.signal },
    [taskkill],
  );
  await execution.waitForSpawn();

  controller.abort();
  setTimeout(() => taskkill.emitExit(0), 3);

  await assert.rejects(execution.result, /^Error: aborted$/);
  assert.equal(primary.stdout.destroyed, true);
  assert.equal(primary.stderr.destroyed, true);
});

test("PowerShell timeout wins a race with a later child error", async () => {
  const primary = new FakeChildProcess(1008);
  const taskkill = new FakeChildProcess(2008);
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const execution = execWithOutput(
    primary,
    { timeout: 0.001 },
    [taskkill],
    calls,
  );
  await execution.waitForSpawn();

  setTimeout(() => {
    primary.emit("error", new Error("late child error"));
    taskkill.emitExit(0);
  }, 4);

  await assert.rejects(execution.result, /timeout:0\.001/);
  assert.equal(calls.filter((call) => call.file === "taskkill").length, 1);
});

test("PowerShell operations do not spawn when already aborted", async () => {
  const primary = new FakeChildProcess(1009);
  const controller = new AbortController();
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  controller.abort();

  const execution = execWithOutput(
    primary,
    { signal: controller.signal },
    [],
    calls,
  );

  await assert.rejects(execution.result, /^Error: aborted$/);
  assert.deepEqual(calls, []);
});

test("PowerShell adapter resolves with a real inherited-stdio descendant", {
  skip: process.platform !== "win32" ? "requires Windows handle inheritance" : false,
}, async () => {
  const selectedRuntime = selectPowerShellRuntime();
  const operations = createPwshBashOperations(selectedRuntime);
  const lingerScript = [
    'const { spawn } = require("node:child_process");',
    'const linger = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {',
    '  detached: true, stdio: ["ignore", 1, 2], windowsHide: true,',
    '});',
    'linger.unref();',
    'process.stdout.write(`fixture-pid:${linger.pid}\\n`);',
  ].join("\n");
  const encoded = Buffer.from(lingerScript).toString("base64");
  const output: Buffer[] = [];
  const startedAt = Date.now();
  const operation = operations.exec(
    `& node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`,
    process.cwd(),
    { onData: (data) => output.push(Buffer.from(data)) },
  );
  let lingerPid: number | undefined;
  let guardHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        guardHandle = setTimeout(
          () => reject(new Error("inherited stdio kept the adapter open")),
          2_000,
        );
      }),
    ]);
    const text = Buffer.concat(output).toString("utf8");
    lingerPid = Number(/fixture-pid:(\d+)/.exec(text)?.[1]);

    assert.deepEqual(result, { exitCode: 0 });
    assert.match(text, /fixture-pid:\d+/);
    assert.ok(
      Date.now() - startedAt < 1_500,
      "adapter should use the bounded exit-to-close grace period",
    );
  } finally {
    if (guardHandle) clearTimeout(guardHandle);
    const text = Buffer.concat(output).toString("utf8");
    lingerPid ??= Number(/fixture-pid:(\d+)/.exec(text)?.[1]);
    if (Number.isInteger(lingerPid) && lingerPid! > 0) {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(lingerPid)], {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      });
    }
    await operation.catch(() => undefined);
  }
});
