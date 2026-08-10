import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  beginConsoleCatchUp,
  flushConsole,
  releaseConsoleCatchUp,
  terminalIO,
  waitForTaskEnd,
} from "./runtime.ts";
import type {
  AttachmentReason,
  BgTask,
  ConsoleData,
  MouseEncodingMode,
} from "./types.ts";

const ATTACH_DETACH_KEY = "\x1d";
const ATTACH_RESIZE_DEBOUNCE_MS = 40;
const FINISHED_ATTACH_HINT = "Task finished - Ctrl+] to return";
const TERMINAL_INPUT_MODE_RESET = [
  "\x1b[?9l", "\x1b[?1000l", "\x1b[?1001l", "\x1b[?1002l", "\x1b[?1003l",
  "\x1b[?1004l", "\x1b[?1005l", "\x1b[?1006l", "\x1b[?1007l",
  "\x1b[?1015l", "\x1b[?1016l", "\x1b[?2004l",
].join("");
const TERMINAL_RESET = [
  TERMINAL_INPUT_MODE_RESET,
  "\x1b[?1049l", "\x1b[0m", "\x1b[?25h", "\x1b[2J", "\x1b[H",
].join("");
const ATTACH_STATUS_GRACE_MS = 100;

function writePipeFinishedHint(): void {
  terminalIO.output.write(TERMINAL_INPUT_MODE_RESET);
  terminalIO.output.write(`\r\n[${FINISHED_ATTACH_HINT}]\r\n`);
}

function writePtyFinishedView(task: BgTask): void {
  const cols = Math.max(1, Math.floor(terminalIO.output.columns || task.console.terminal.cols || 80));
  const rows = Math.max(1, Math.floor(terminalIO.output.rows || task.console.terminal.rows || 24));
  const hint = ` ${FINISHED_ATTACH_HINT} `.slice(0, cols);
  const column = Math.max(1, cols - hint.length + 1);

  terminalIO.output.write("\x1b[2J\x1b[H");
  terminalIO.output.write(task.console.serializer.serialize({ scrollback: 200 }));
  terminalIO.output.write(TERMINAL_INPUT_MODE_RESET);
  terminalIO.output.write(`\x1b7\x1b[${rows};${column}H\x1b[7m${hint}\x1b[0m\x1b8`);
}

function serializeMouseEncodingMode(mode: MouseEncodingMode): string {
  if (mode === "utf8") return "\x1b[?1005h";
  if (mode === "sgr") return "\x1b[?1006h";
  if (mode === "urxvt") return "\x1b[?1015h";
  if (mode === "sgr-pixels") return "\x1b[?1016h";
  return "";
}

async function notifyAttachmentResult(
  task: BgTask,
  modeLabel: "PTY" | "Pipe",
  reason: AttachmentReason,
  attachError: string | undefined,
  ctx: ExtensionContext,
  reportTaskOutcome = true,
): Promise<void> {
  if (attachError) {
    ctx.ui.notify(`${modeLabel} attachment failed: ${attachError}`, "error");
    return;
  }
  if (reason === "shutdown" || !reportTaskOutcome) return;

  if (reason === "detached" && task.status === "running") {
    await waitForTaskEnd(task, ATTACH_STATUS_GRACE_MS);
  }
  if (task.status !== "running") {
    const detail = task.exitCode !== null
      ? ` (exit code ${task.exitCode})`
      : task.signal
        ? ` (${task.signal})`
        : "";
    ctx.ui.notify(
      `${modeLabel} task "${task.name}" ${task.status}${detail}.`,
      task.status === "failed" ? "error" : "info",
    );
    return;
  }
  ctx.ui.notify(`Detached from "${task.name}".`, "info");
}

async function attachFinishedTaskSnapshot(
  task: BgTask,
  modeLabel: "PTY" | "Pipe",
  ctx: ExtensionContext,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(`${modeLabel} attachment requires Pi TUI mode.`, "warning");
    return;
  }
  if (task.attachment.detach) {
    ctx.ui.notify(`Task "${task.name}" is already attached.`, "warning");
    return;
  }

  let attachError: string | undefined;
  const reason = await ctx.ui.custom<AttachmentReason>((tui, _theme, _keybindings, done) => {
    let cleaned = false;
    let terminalStarted = false;
    let rawBeforeAttach = false;
    let inputHandler: ((data: string | Buffer) => void) | undefined;

    const cleanup = (result: AttachmentReason) => {
      if (cleaned) return;
      cleaned = true;
      task.attachment.detach = undefined;
      task.attachment.taskExited = undefined;
      if (inputHandler) terminalIO.input.removeListener("data", inputHandler);
      if (terminalStarted) {
        terminalIO.input.pause();
        terminalIO.input.setRawMode?.(rawBeforeAttach);
        terminalIO.output.write(TERMINAL_RESET);
        tui.start();
        tui.requestRender(true);
      }
      done(result);
    };

    task.attachment.detach = cleanup;

    queueMicrotask(async () => {
      try {
        if (cleaned) return;
        tui.stop();
        terminalStarted = true;
        rawBeforeAttach = terminalIO.input.isRaw || false;
        terminalIO.input.setRawMode?.(true);
        terminalIO.input.setEncoding("utf8");
        terminalIO.input.resume();

        inputHandler = (chunk) => {
          const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
          if (data.includes(ATTACH_DETACH_KEY)) cleanup("detached");
        };
        terminalIO.input.on("data", inputHandler);

        await flushConsole(task);
        if (cleaned) return;
        if (modeLabel === "PTY") {
          writePtyFinishedView(task);
        } else {
          terminalIO.output.write("\x1b[2J\x1b[H");
          terminalIO.output.write(task.console.serializer.serialize({ scrollback: 200 }));
          writePipeFinishedHint();
        }
      } catch (error) {
        attachError = error instanceof Error ? error.message : String(error);
        cleanup("detached");
      }
    });

    return {
      render: () => [],
      invalidate: () => {},
      dispose: () => cleanup("detached"),
    } satisfies Component & { dispose(): void };
  });

  await notifyAttachmentResult(task, modeLabel, reason, attachError, ctx, false);
}

async function attachPtyTask(task: BgTask, ctx: ExtensionContext): Promise<void> {
  const state = task.console;
  const taskProcess = task.process;
  if (task.mode !== "pty") {
    ctx.ui.notify(`Task "${task.name}" is not a PTY task.`, "warning");
    return;
  }
  if (task.status !== "running") {
    await attachFinishedTaskSnapshot(task, "PTY", ctx);
    return;
  }
  if (!taskProcess || taskProcess.kind !== "pty") {
    ctx.ui.notify(`Task "${task.name}" process is unavailable.`, "warning");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify("PTY attachment requires Pi TUI mode.", "warning");
    return;
  }
  if (task.attachment.detach) {
    ctx.ui.notify(`Task "${task.name}" is already attached.`, "warning");
    return;
  }

  let attachError: string | undefined;
  const reason = await ctx.ui.custom<AttachmentReason>((tui, _theme, _keybindings, done) => {
    let cleaned = false;
    let terminalStarted = false;
    let rawBeforeAttach = false;
    let catchUpBuffer: ConsoleData[] | null = null;
    let inputHandler: ((data: string | Buffer) => void) | undefined;
    let resizeHandler: (() => void) | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let attachmentReady = false;
    let finishedViewScheduled = false;
    let finishedViewShown = false;

    const cleanup = (result: AttachmentReason) => {
      if (cleaned) return;
      cleaned = true;
      state.subscriber = undefined;
      task.attachment.detach = undefined;
      task.attachment.taskExited = undefined;
      if (inputHandler) terminalIO.input.removeListener("data", inputHandler);
      if (resizeHandler) terminalIO.output.removeListener("resize", resizeHandler);
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = undefined;
      }
      if (catchUpBuffer) {
        releaseConsoleCatchUp(task, catchUpBuffer);
        catchUpBuffer = null;
      }
      if (terminalStarted) {
        terminalIO.input.pause();
        terminalIO.input.setRawMode?.(rawBeforeAttach);
        terminalIO.output.write(TERMINAL_RESET);
        tui.start();
        tui.requestRender(true);
      }
      done(result);
    };

    const showFinishedView = () => {
      if (cleaned || !attachmentReady || finishedViewScheduled) return;
      finishedViewScheduled = true;
      void flushConsole(task).then(() => {
        if (cleaned) return;
        state.subscriber = undefined;
        finishedViewShown = true;
        writePtyFinishedView(task);
      }).catch((error) => {
        attachError = error instanceof Error ? error.message : String(error);
        cleanup("detached");
      });
    };

    task.attachment.detach = cleanup;
    task.attachment.taskExited = showFinishedView;

    queueMicrotask(async () => {
      try {
        if (cleaned) return;
        tui.stop();
        terminalStarted = true;
        rawBeforeAttach = terminalIO.input.isRaw || false;
        terminalIO.input.setRawMode?.(true);
        terminalIO.input.setEncoding("utf8");
        terminalIO.input.resume();

        inputHandler = (chunk) => {
          const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
          const detachAt = data.indexOf(ATTACH_DETACH_KEY);
          if (detachAt >= 0) {
            if (task.status === "running" && detachAt > 0) taskProcess.pty.write(data.slice(0, detachAt));
            cleanup("detached");
            return;
          }
          if (task.status === "running") taskProcess.pty.write(data);
        };
        const applyResize = () => {
          const cols = Math.min(MAX_TERMINAL_COLS, Math.max(
            MIN_TERMINAL_COLS,
            Math.floor(terminalIO.output.columns || state.terminal.cols || 80),
          ));
          const rows = Math.min(MAX_TERMINAL_ROWS, Math.max(
            MIN_TERMINAL_ROWS,
            Math.floor(terminalIO.output.rows || state.terminal.rows || 24),
          ));
          state.terminal.resize(cols, rows);
          if (task.process?.kind === "pty") task.process.pty.resize(cols, rows);
        };
        resizeHandler = () => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = undefined;
            applyResize();
            if (finishedViewShown) writePtyFinishedView(task);
          }, ATTACH_RESIZE_DEBOUNCE_MS);
        };

        terminalIO.input.on("data", inputHandler);
        terminalIO.output.on("resize", resizeHandler);
        catchUpBuffer = beginConsoleCatchUp(task);
        await flushConsole(task);
        if (cleaned) return;
        applyResize();
        terminalIO.output.write("\x1b[2J\x1b[H");
        terminalIO.output.write(state.serializer.serialize({ scrollback: 200 }));
        const mouseEncodingSequence = serializeMouseEncodingMode(state.mouseEncodingMode);
        if (mouseEncodingSequence) terminalIO.output.write(mouseEncodingSequence);
        state.subscriber = (data) => terminalIO.output.write(data);
        releaseConsoleCatchUp(task, catchUpBuffer);
        catchUpBuffer = null;
        attachmentReady = true;
        if (task.status !== "running") showFinishedView();
      } catch (error) {
        attachError = error instanceof Error ? error.message : String(error);
        cleanup("detached");
      }
    });

    return {
      render: () => [],
      invalidate: () => {},
      dispose: () => cleanup("detached"),
    } satisfies Component & { dispose(): void };
  });

  await notifyAttachmentResult(task, "PTY", reason, attachError, ctx);
}

async function attachPipeTask(task: BgTask, ctx: ExtensionContext): Promise<void> {
  const taskProcess = task.process;
  const state = task.console;
  if (task.mode !== "pipe") {
    ctx.ui.notify(`Task "${task.name}" is not a pipe task.`, "warning");
    return;
  }
  if (task.status !== "running") {
    await attachFinishedTaskSnapshot(task, "Pipe", ctx);
    return;
  }
  if (!taskProcess || taskProcess.kind !== "pipe") {
    ctx.ui.notify(`Task "${task.name}" process is unavailable.`, "warning");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Pipe attachment requires Pi TUI mode.", "warning");
    return;
  }
  if (task.attachment.detach) {
    ctx.ui.notify(`Task "${task.name}" is already attached.`, "warning");
    return;
  }

  let attachError: string | undefined;
  const reason = await ctx.ui.custom<AttachmentReason>((tui, _theme, _keybindings, done) => {
    let cleaned = false;
    let terminalStarted = false;
    let rawBeforeAttach = false;
    let catchUpBuffer: ConsoleData[] | null = null;
    let inputHandler: ((data: string | Buffer) => void) | undefined;
    let attachmentReady = false;
    let finishedHintScheduled = false;

    const cleanup = (result: AttachmentReason) => {
      if (cleaned) return;
      cleaned = true;
      state.subscriber = undefined;
      task.attachment.detach = undefined;
      task.attachment.taskExited = undefined;
      if (inputHandler) terminalIO.input.removeListener("data", inputHandler);
      if (catchUpBuffer) {
        releaseConsoleCatchUp(task, catchUpBuffer);
        catchUpBuffer = null;
      }
      if (terminalStarted) {
        terminalIO.input.pause();
        terminalIO.input.setRawMode?.(rawBeforeAttach);
        terminalIO.output.write(TERMINAL_RESET);
        tui.start();
        tui.requestRender(true);
      }
      done(result);
    };

    const showFinishedHint = () => {
      if (cleaned || !attachmentReady || finishedHintScheduled) return;
      finishedHintScheduled = true;
      void flushConsole(task).then(() => {
        if (cleaned) return;
        state.subscriber = undefined;
        writePipeFinishedHint();
      }).catch((error) => {
        attachError = error instanceof Error ? error.message : String(error);
        cleanup("detached");
      });
    };

    task.attachment.detach = cleanup;
    task.attachment.taskExited = showFinishedHint;

    queueMicrotask(async () => {
      try {
        if (cleaned) return;
        tui.stop();
        terminalStarted = true;
        rawBeforeAttach = terminalIO.input.isRaw || false;
        terminalIO.input.setRawMode?.(true);
        terminalIO.input.setEncoding("utf8");
        terminalIO.input.resume();

        inputHandler = (chunk) => {
          const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
          if (data.includes(ATTACH_DETACH_KEY)) cleanup("detached");
        };

        terminalIO.input.on("data", inputHandler);
        catchUpBuffer = beginConsoleCatchUp(task);
        await flushConsole(task);
        if (cleaned) return;

        const cols = Math.min(MAX_TERMINAL_COLS, Math.max(
          MIN_TERMINAL_COLS,
          Math.floor(terminalIO.output.columns || state.terminal.cols || 80),
        ));
        const rows = Math.min(MAX_TERMINAL_ROWS, Math.max(
          MIN_TERMINAL_ROWS,
          Math.floor(terminalIO.output.rows || state.terminal.rows || 24),
        ));
        state.terminal.resize(cols, rows);
        terminalIO.output.write("\x1b[2J\x1b[H");
        terminalIO.output.write(state.serializer.serialize({ scrollback: 200 }));
        state.subscriber = (data) => terminalIO.output.write(data);
        releaseConsoleCatchUp(task, catchUpBuffer);
        catchUpBuffer = null;
        attachmentReady = true;
        if (task.status !== "running") showFinishedHint();
      } catch (error) {
        attachError = error instanceof Error ? error.message : String(error);
        cleanup("detached");
      }
    });

    return {
      render: () => [],
      invalidate: () => {},
      dispose: () => cleanup("detached"),
    } satisfies Component & { dispose(): void };
  });

  await notifyAttachmentResult(task, "Pipe", reason, attachError, ctx);
}

export async function attachTask(task: BgTask, ctx: ExtensionContext): Promise<void> {
  if (task.mode === "pty") await attachPtyTask(task, ctx);
  else await attachPipeTask(task, ctx);
}
