import { spawn } from "node:child_process";
import {
  keyText,
  type AgentToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as nodePty from "node-pty";
import { MAX_INPUT_BYTES, parseInput, type ParsedInput } from "./input.ts";
import {
  BACKGROUND_SEND_SIGNALS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  closeTaskInput,
  createConsoleSession,
  emptyOutputMessage,
  findTaskByReference,
  flushConsole,
  formatDuration,
  formatElapsedSeconds,
  generateId,
  getTerminalSnapshotLines,
  isTaskControllable,
  normalizeTaskEnvironment,
  normalizeTaskName,
  persistFinishedTaskSnapshot,
  readRange,
  readTail,
  recordPipeData,
  recordPtyData,
  renderTaskCallLabel,
  resolveShell,
  runningTasks,
  sendProcessSignal,
  sendTaskSignal,
  settleDisconnectedTaskAfterSignal,
  settleTaskTransportExit,
  takeNextTaskOrder,
  taskControlFromLaunch,
  taskDetailLine,
  taskEnvironmentDetails,
  taskEnvironmentLine,
  taskEnvironmentSuffix,
  taskLatestPipeLog,
  taskLatestPipeLogLine,
  taskLogKey,
  tasks,
  terminalIO,
  throwIfAborted,
  truncateText,
  waitForOrderedToolCall,
  waitForTaskEnd,
  waitUntilAllowed,
  withTaskEnvironment,
  writeTaskInput,
} from "./runtime.ts";
import type {
  BackgroundProcess,
  BackgroundSignal,
  BackgroundTasksExtensionDependencies,
  BgTask,
  BgWaitRenderState,
} from "./types.ts";
import { setWidgetContext, updateWidget } from "./widget.ts";

export function registerBackgroundTaskTools(
  pi: ExtensionAPI,
  dependencies: BackgroundTasksExtensionDependencies,
): void {
  // ── bg_start ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_start",
    label: "BG Start",
    description: "Start a task asynchronously only when background execution is genuinely needed: for concurrent work, later interaction, or an explicit user request. Its unique name can immediately reference ordered follow-up bg_* calls in the same assistant response.",
    promptSnippet: "Start a genuinely asynchronous task for concurrent work or later interaction",
    promptGuidelines: [
      "Use bg_start only when the user explicitly requests background execution, the process must remain available for later interaction (for example, a server, watcher, or TUI), or you will perform independent useful work concurrently while it runs.",
      "Do not use bg_start merely because a command may be slow. If background execution was not explicitly requested and you need its result before any independent work can proceed, use the bash tool with an appropriate timeout instead of bg_start → bg_wait → bg_logs.",
      "Give each bg_start task a unique name; names are compared case-insensitively across all currently retained tasks.",
      "Use the Environment returned by bg_start and later bg_* results as the task's immutable launch location; an SSH task stays on that target and cwd even if the active workspace changes.",
      "Set bg_start pty=true only for terminal-aware or interactive TUI programs; keep the default pipe mode for ordinary builds and servers.",
      "Once bg_start is justified, compose complete bg_* workflows in one assistant response. Every bg_* id accepts a task ID or unique name, and same-task calls execute strictly in source order, not in parallel. For example, emit bg_start(name=\"tests\") → bg_wait(id=\"tests\") → bg_logs(id=\"tests\") together; for an existing task, emit bg_wait → bg_logs together. Different tasks execute in parallel, and bg_status without id is independent.",
      "A running bg_start task survives ordinary agent runs but session reload or shutdown terminates it. A task finishing during a run is normally retained through that run; a task that was still running when the agent settled and then finishes while idle is normally retained through the next run.",
      "Use bg_wait only for finite bg_start tasks whose completion is needed. bg_wait includes the latest pipe log line when available; place bg_logs immediately after bg_wait only when full or multiline pipe output or PTY terminal output is needed. Do not poll either tool.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "A short unique name for the task (case-insensitive among retained tasks)", minLength: 1 }),
      command: Type.String({ description: "The shell command to run" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current)" })),
      pty: Type.Optional(Type.Boolean({ description: "Run in a pseudoterminal for interactive/TUI programs (default: false)" })),
      cols: Type.Optional(Type.Number({ description: "Initial PTY columns (default: current terminal or 120)", minimum: 20, maximum: 500 })),
      rows: Type.Optional(Type.Number({ description: "Initial PTY rows (default: current terminal or 30)", minimum: 5, maximum: 200 })),
    }),

    executionMode: "parallel",

    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
      const predecessor = waitForOrderedToolCall(toolCallId, signal);
      if (predecessor) await predecessor;
      const name = normalizeTaskName(params.name);
      if (!name) throw new Error("Background task name cannot be empty.");
      const duplicate = findTaskByReference(name);
      if (duplicate) {
        throw new Error(
          `Background task name "${name}" is already in use by task ${duplicate.id} (${duplicate.status}) or conflicts with its ID. ` +
          "Choose a unique name that is not another task's ID.",
        );
      }

      const id = generateId();
      const stdoutLogKey = taskLogKey(id, "stdout");
      const stderrLogKey = taskLogKey(id, "stderr");
      const mode = params.pty ? "pty" : "pipe";
      const cwd = params.cwd || ctx.cwd;
      const shell = resolveShell(params.command, mode === "pty", {
        cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
      const launchCwd = shell.cwd ?? cwd;
      const taskControl = taskControlFromLaunch(shell);
      const cols = Math.min(MAX_TERMINAL_COLS, Math.max(
        MIN_TERMINAL_COLS,
        Math.floor(params.cols ?? terminalIO.output.columns ?? 120),
      ));
      const rows = Math.min(MAX_TERMINAL_ROWS, Math.max(
        MIN_TERMINAL_ROWS,
        Math.floor(params.rows ?? terminalIO.output.rows ?? 30),
      ));
      let taskProcess: BackgroundProcess;
      const console = createConsoleSession(cols, rows, mode);

      try {
        if (mode === "pty") {
          let ptyProcess: nodePty.IPty;
          ptyProcess = (shell.ptySpawnProcess ?? dependencies.ptySpawnProcess ?? nodePty.spawn)(shell.file, shell.args, {
            name: shell.env.TERM || "xterm-256color",
            cols,
            rows,
            cwd: launchCwd,
            env: { ...shell.env, TERM: shell.env.TERM || "xterm-256color" },
          });
          taskProcess = {
            kind: "pty",
            pid: ptyProcess.pid,
            pty: ptyProcess,
          };
        } else {
          const child = (shell.spawnProcess ?? dependencies.spawnProcess ?? spawn)(shell.file, shell.args, {
            cwd: launchCwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: shell.env,
            detached: process.platform !== "win32",
          });
          taskProcess = {
            kind: "pipe",
            pid: child.pid ?? 0,
            child,
          };
        }
      } catch (error) {
        console.terminal.dispose();
        if (taskControl) await taskControl.dispose();
        throw error;
      }

      const task: BgTask = {
        id, name, command: params.command, mode,
        environment: normalizeTaskEnvironment(shell.taskEnvironment),
        process: taskProcess,
        control: taskControl,
        controlDisposed: false,
        transportExitPending: null,
        console,
        attachment: {},
        status: "running",
        statusDetail: null,
        exitCode: null, signal: null,
        order: takeNextTaskOrder(),
        startedAt: Date.now(), endedAt: null,
        stdoutLogKey, stderrLogKey, stdoutLines: 0, stderrLines: 0,
        done: new AbortController(),
        latestLog: null,
        retainForNextAgentTurn: false,
        stdoutPending: "", stderrPending: "",
        requestedStopSignal: null,
      };
      tasks.set(id, task);
      runningTasks.add(task);

      if (taskProcess.kind === "pty") {
        taskProcess.pty.onData((data) => recordPtyData(task, data));
        taskProcess.pty.onExit(({ exitCode, signal }) => {
          settleTaskTransportExit(
            task,
            exitCode,
            signal ? `signal ${signal}` : null,
          );
        });
      } else {
        const child = taskProcess.child;
        let outputRevision = 0;
        child.stdout?.on("data", (d: Buffer) => {
          outputRevision += 1;
          recordPipeData(task, "stdout", d);
        });
        child.stderr?.on("data", (d: Buffer) => {
          outputRevision += 1;
          recordPipeData(task, "stderr", d);
        });
        let spawned = false;
        child.once("spawn", () => {
          spawned = true;
        });
        child.once("error", (err) => {
          const errorLine = `[error: ${err.message}]`;
          recordPipeData(task, "stderr", Buffer.from(`\n${errorLine}\n`));
          // A launch failure emits `error` and `close`, but never `exit`.
          if (!spawned) settleTaskTransportExit(task, null, null, true);
        });
        let outputRevisionAtExit: number | null = null;
        // Process state follows `exit` only. On Windows, inherited stdio handles can
        // keep `close` pending long after this PID no longer exists.
        child.once("exit", (code, signal) => {
          outputRevisionAtExit = outputRevision;
          settleTaskTransportExit(task, code, signal);
        });
        // `close` is an I/O lifecycle event. If more output arrived after `exit`,
        // update the snapshot without adding a redundant entry for the normal case.
        child.once("close", () => {
          if (
            task.status !== "running" &&
            outputRevisionAtExit !== null &&
            outputRevision !== outputRevisionAtExit
          ) {
            void persistFinishedTaskSnapshot(task).catch(() => {});
          }
        });
        if (shell.initialStdin !== undefined) {
          child.stdin?.end(shell.initialStdin);
        }
      }

      setWidgetContext(ctx);
      updateWidget();

      const environmentLine = taskEnvironmentLine(task, "  ");
      const launchLines = [
        taskDetailLine("ID", id, "  "),
        taskDetailLine("Name", name, "  "),
        ...(environmentLine ? [environmentLine] : []),
        taskDetailLine("Command", params.command, "  "),
        taskDetailLine("PID", taskProcess.pid, "  "),
        taskDetailLine(
          "Mode",
          `${mode}${mode === "pty" ? ` (${cols}x${rows}; use /bg-attach ${id} for interactive control)` : ` (use /bg-attach ${id} to replay and follow output)`}`,
          "  ",
        ),
      ];
      return {
        content: [{
          type: "text",
          text: `Background task started:\n${launchLines.join("\n")}\nReference it by ID or unique name. For finite completion, use bg_wait; it includes the latest pipe log line. Add bg_logs only for full or PTY output.`,
        }],
        details: {
          id,
          name,
          command: params.command,
          pid: taskProcess.pid,
          mode,
          cols: mode === "pty" ? cols : undefined,
          rows: mode === "pty" ? rows : undefined,
          ...taskEnvironmentDetails(task),
        },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const parts = [theme.fg("toolTitle", theme.bold("bg_start"))];
      if (typeof args.name === "string" && args.name) parts.push(theme.fg("accent", args.name));
      if (typeof args.command === "string" && args.command) parts.push(theme.fg("muted", `$ ${args.command}`));
      if (args.pty) parts.push(theme.fg("dim", "[pty]"));
      text.setText(parts.join(" "));
      return text;
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Starting..."), 0, 0);
      const d = result.details as {
        id?: string;
        name?: string;
        pid?: number;
        environment?: string;
      } | undefined;
      if (!d) return new Text(theme.fg("success", "Done"), 0, 0);
      const location = d.environment ? ` @ ${d.environment}` : "";
      const lines = [
        theme.fg("accent", d.name ?? "")
          + theme.fg("dim", ` ${d.id ?? ""} pid=${d.pid ?? ""}${location}`),
      ];
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ── bg_wait ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_wait",
    label: "BG Wait",
    description: "Wait for a finite task to finish or time out and include its latest pipe log line when available. Use bg_logs for full pipe output or PTY terminal output.",
    promptSnippet: "Wait for finite completion and return the latest pipe log line",
    promptGuidelines: [
      "Use bg_wait once when completion of an already-justified finite bg_start task is required; never create a bg_start task solely so you can wait on it.",
      "bg_wait returns completion status plus the latest pipe log line when available. Emit bg_logs immediately after bg_wait only when full or multiline pipe output or PTY terminal output is needed; do not wait for the bg_wait result before emitting bg_logs.",
      "A bg_wait timeout leaves the task running and still returns the latest pipe log line; a following same-response bg_logs call reads fuller output retained at that point.",
      "Do not use bg_wait for persistent servers or watchers, and do not immediately wait again after a timeout unless the user asks you to keep waiting.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID or unique name (case-insensitive)" }),
      timeout: Type.Optional(Type.Number({ description: "Maximum seconds to wait (default: 300)", minimum: 1, maximum: 3600 })),
    }),

    executionMode: "parallel",

    async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult<Record<string, unknown>>> {
      const predecessor = waitForOrderedToolCall(toolCallId, signal);
      if (predecessor) await predecessor;
      const task = findTaskByReference(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };

      const timeoutSeconds = params.timeout ?? 300;
      const timeoutMs = timeoutSeconds * 1000;
      if (task.status === "running") {
        onUpdate?.({
          content: [],
          details: {
            id: task.id,
            name: task.name,
            status: task.status,
            ...taskEnvironmentDetails(task),
          },
        });
        await waitUntilAllowed(timeoutMs, [task.done.signal], signal);
      }
      await flushConsole(task);

      const timedOut = task.status === "running";
      const duration = task.endedAt
        ? formatDuration(task.endedAt - task.startedAt)
        : formatDuration(Date.now() - task.startedAt);
      const parts = timedOut
        ? [
            `Timed out after ${formatDuration(timeoutMs)} waiting for task "${task.name}" (${task.id}).`,
            "The task is still running; the timeout did not stop it.",
          ]
        : [`Task "${task.name}" (${task.id}) ${task.status} after ${duration}.`];
      const environmentLine = taskEnvironmentLine(task, "  ");
      if (environmentLine) parts.push(environmentLine);
      parts.push(taskDetailLine("Status", task.status, "  "));
      if (task.statusDetail) {
        parts.push(taskDetailLine("Detail", task.statusDetail, "  "));
      }
      parts.push(taskDetailLine("Duration", duration, "  "));
      if (task.exitCode !== null) {
        parts.push(taskDetailLine("Exit code", task.exitCode, "  "));
      }
      if (task.signal) parts.push(taskDetailLine("Signal", task.signal, "  "));
      const latestLog = taskLatestPipeLog(task);
      const latestLogLine = taskLatestPipeLogLine(task, "  ");
      if (latestLogLine) parts.push(latestLogLine);

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: {
          id: task.id,
          name: task.name,
          status: task.status,
          timedOut,
          timeout: timeoutSeconds,
          exitCode: task.exitCode,
          signal: task.signal,
          mode: task.mode,
          statusDetail: task.statusDetail ?? undefined,
          ...(latestLog ? { latestLog } : {}),
          ...taskEnvironmentDetails(task),
        },
      };
    },

    renderCall(args, theme, context) {
      const state = context.state as BgWaitRenderState;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
      }
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const name = renderTaskCallLabel(args.id, theme);
      const timeout = typeof args.timeout === "number" ? theme.fg("dim", `timeout=${args.timeout}s`) : "";
      text.setText([theme.fg("toolTitle", theme.bold("bg_wait")), name, timeout].filter(Boolean).join(" "));
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      const state = context.state as BgWaitRenderState;
      if (state.startedAt !== undefined && isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
        state.interval.unref?.();
      }
      if (!isPartial || context.isError) {
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }
      if (isPartial) {
        const elapsed = state.startedAt === undefined
          ? "0.0s"
          : formatElapsedSeconds(Date.now() - state.startedAt);
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(`${theme.fg("muted", `Elapsed ${elapsed}`)}`);
        return text;
      }
      const content = result.content[0]?.type === "text" ? result.content[0].text : "";
      const details = result.details as { status?: BgTask["status"]; timedOut?: boolean } | undefined;
      const color = details?.timedOut
        ? "warning"
        : details?.status === "failed"
          ? "error"
          : details?.status === "stopped" || details?.status === "disconnected"
            ? "warning"
            : "toolOutput";
      return new Text(theme.fg(color, content) || content, 0, 0);
    },
  });

  // ── bg_status ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_status",
    label: "BG Status",
    description: "Inspect task status and metadata or list current tasks, including each task's latest pipe log line when available. This is not a polling or waiting tool and does not return full or PTY output.",
    promptSnippet: "Inspect background task status with the latest pipe log line",
    promptGuidelines: [
      "Do not poll bg_status after bg_start; use bg_wait once when a finite task's final status is required.",
      "Use bg_status only for requested task metadata, recovering a missing task reference, or diagnosing task state.",
      "Use bg_status without id only when the task ID or name is unknown and a retained-task list is needed.",
      "bg_status includes the latest pipe log line when available; use bg_logs for full or multiline pipe output and for all PTY terminal output.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Task ID or unique name. If omitted, lists all retained tasks." })),
    }),

    executionMode: "parallel",

    async execute(toolCallId, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      const predecessor = waitForOrderedToolCall(toolCallId, signal);
      if (predecessor) await predecessor;
      if (!params.id) {
        const entries = Array.from(tasks.values());
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "No background tasks." }], details: { tasks: [] } };
        }
        const lines = entries.flatMap((task) => {
          const duration = task.endedAt
            ? formatDuration(task.endedAt - task.startedAt)
            : formatDuration(Date.now() - task.startedAt);
          const exit = task.exitCode !== null ? ` exit=${task.exitCode}` : "";
          const environment = task.environment ? ` [${task.environment}]` : "";
          const summary = `[${task.id}] "${task.name}" ${task.status} ${task.mode} (${duration})${exit}${environment}`;
          const latestLogLine = taskLatestPipeLogLine(task, "  ");
          return latestLogLine ? [summary, latestLogLine] : [summary];
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            tasks: entries.map((task) => {
              const latestLog = taskLatestPipeLog(task);
              return {
                id: task.id,
                name: task.name,
                status: task.status,
                mode: task.mode,
                exitCode: task.exitCode,
                signal: task.signal,
                ...(latestLog ? { latestLog } : {}),
                ...taskEnvironmentDetails(task),
              };
            }),
          },
        };
      }

      const task = findTaskByReference(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };
      await settleDisconnectedTaskAfterSignal(task, signal).catch(() => {});

      const duration = task.endedAt
        ? formatDuration(task.endedAt - task.startedAt)
        : formatDuration(Date.now() - task.startedAt);
      const environmentLine = taskEnvironmentLine(task, "  ");
      const latestLog = taskLatestPipeLog(task);
      const parts: string[] = [
        `Task: ${task.name} (${task.id})`,
        ...(environmentLine ? [environmentLine] : []),
        taskDetailLine("Status", task.status, "  "),
        ...(task.statusDetail
          ? [taskDetailLine("Detail", task.statusDetail, "  ")]
          : []),
        taskDetailLine("Command", task.command, "  "),
        taskDetailLine("Mode", task.mode, "  "),
        taskDetailLine("Duration", duration, "  "),
      ];
      if (task.exitCode !== null) {
        parts.push(taskDetailLine("Exit code", task.exitCode, "  "));
      }
      if (task.signal) parts.push(taskDetailLine("Signal", task.signal, "  "));
      if (task.process?.pid) parts.push(taskDetailLine("PID", task.process.pid, "  "));
      const latestLogLine = taskLatestPipeLogLine(task, "  ");
      if (latestLogLine) parts.push(latestLogLine);
      if (task.status === "running") parts.push("  Use bg_wait to await completion; do not poll bg_status.");

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: {
          id: task.id,
          name: task.name,
          status: task.status,
          mode: task.mode,
          exitCode: task.exitCode,
          signal: task.signal,
          pid: task.process?.pid,
          statusDetail: task.statusDetail ?? undefined,
          ...(latestLog ? { latestLog } : {}),
          ...taskEnvironmentDetails(task),
        },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const hasTaskId = typeof args.id === "string" && args.id.trim().length > 0;
      const label = hasTaskId
        ? renderTaskCallLabel(args.id, theme)
        : context.argsComplete ? theme.fg("toolOutput", "all") : "";
      text.setText([theme.fg("toolTitle", theme.bold("bg_status")), label].filter(Boolean).join(" "));
      return text;
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Checking..."), 0, 0);
      const content = result.content[0]?.type === "text" ? result.content[0].text : "";
      const lines = content.split("\n").map(l => {
        if (l.includes("Status:")) {
          if (l.includes("running")) return l.replace("running", theme.fg("success", "running"));
          if (l.includes("completed")) return l.replace("completed", theme.fg("accent", "completed"));
          if (l.includes("failed")) return l.replace("failed", theme.fg("error", "failed"));
          if (l.includes("stopped")) return l.replace("stopped", theme.fg("warning", "stopped"));
          if (l.includes("disconnected")) return l.replace("disconnected", theme.fg("warning", "disconnected"));
        }
        return theme.fg("toolOutput", l) || l;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ── bg_logs ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_logs",
    label: "BG Logs",
    description:
      "Read retained pipe or PTY output when the latest pipe line returned by bg_wait or bg_status is insufficient. Place bg_logs after bg_wait in the same response when fuller final output is needed.",
    promptSnippet: "Read full task output when a latest-line summary is insufficient",
    promptGuidelines: [
      "Use bg_logs when you need more than the latest pipe log line returned by bg_wait or bg_status, or when you need any PTY terminal output.",
      "Use bg_logs with tail=N for recent output; omit stream to use the correct default for either pipe or PTY mode.",
      "Do not poll with bg_logs. When fuller finite output is needed, emit bg_wait followed by bg_logs in the same assistant response; source ordering makes bg_logs run after bg_wait.",
    ],

    parameters: Type.Object({
      id: Type.String({ description: "Task ID or unique name (case-insensitive)" }),
      tail: Type.Optional(
        Type.Number({ description: "Read last N lines (default: 100)" }),
      ),
      stream: Type.Optional(
        StringEnum(["stdout", "stderr", "both", "terminal"] as const, {
          description: "Which stream (default: 'both'); use terminal for explicit PTY output",
        }),
      ),
      from_line: Type.Optional(
        Type.Number({
          description: "Start from this line (0-indexed). Overrides tail.",
        }),
      ),
      max_lines: Type.Optional(
        Type.Number({ description: "Max lines with from_line (default: 500)" }),
      ),
    }),

    executionMode: "parallel",

    async execute(
      toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const predecessor = waitForOrderedToolCall(toolCallId, signal);
      if (predecessor) await predecessor;
      const task = findTaskByReference(params.id);
      if (!task)
        return {
          content: [{ type: "text", text: `Task not found: ${params.id}` }],
          details: {},
        };

      const stream = params.stream || "both";
      const maxLines = params.max_lines || 500;
      const lines = params.tail || 100;
      let stdout = "",
        stderr = "";

      if (task.mode === "pty") {
        await flushConsole(task);
        if (stream === "stderr") {
          return {
            content: [{
              type: "text",
              text: withTaskEnvironment(
                task,
                "(PTY output combines stdout and stderr; use stream=terminal)",
              ),
            }],
            details: {
              id: task.id,
              name: task.name,
              status: task.status,
              mode: task.mode,
              ...taskEnvironmentDetails(task),
            },
          };
        }
        const snapshotLines = getTerminalSnapshotLines(task);
        const selected = params.from_line !== undefined
          ? snapshotLines.slice(params.from_line, params.from_line + maxLines)
          : snapshotLines.slice(-lines);
        const output = selected.join("\n");
        return {
          content: [{
            type: "text",
            text: withTaskEnvironment(
              task,
              output
                ? `── terminal ──\n${output}`
                : emptyOutputMessage(task, "terminal output"),
            ),
          }],
          details: {
            id: task.id,
            name: task.name,
            status: task.status,
            mode: task.mode,
            terminalRows: snapshotLines.length,
            cols: task.console.terminal.cols,
            rows: task.console.terminal.rows,
            ...taskEnvironmentDetails(task),
          },
        };
      }

      if (stream === "terminal") {
        return {
          content: [{
            type: "text",
            text: withTaskEnvironment(
              task,
              "(terminal output is only available for PTY tasks)",
            ),
          }],
          details: {
            id: task.id,
            name: task.name,
            status: task.status,
            mode: task.mode,
            ...taskEnvironmentDetails(task),
          },
        };
      }

      if (stream === "stdout" || stream === "both")
        stdout =
          params.from_line !== undefined
            ? await readRange(task.stdoutLogKey, params.from_line, maxLines)
            : await readTail(task.stdoutLogKey, lines);
      if (stream === "stderr" || stream === "both")
        stderr =
          params.from_line !== undefined
            ? await readRange(task.stderrLogKey, params.from_line, maxLines)
            : await readTail(task.stderrLogKey, lines);

      const parts: string[] = [];
      if (stream === "both") {
        if (stdout) parts.push(`── stdout ──\n${stdout}`);
        if (stderr) parts.push(`── stderr ──\n${stderr}`);
        if (!stdout && !stderr) parts.push(emptyOutputMessage(task, "output"));
      } else {
        parts.push(
          stream === "stdout"
            ? stdout || "(no stdout)"
            : stderr || "(no stderr)",
        );
      }

      return {
        content: [{
          type: "text",
          text: withTaskEnvironment(task, parts.join("\n")),
        }],
        details: {
          id: task.id,
          name: task.name,
          status: task.status,
          stdoutLines: task.stdoutLines,
          stderrLines: task.stderrLines,
          ...taskEnvironmentDetails(task),
        },
      };
    },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const name = renderTaskCallLabel(args.id, theme);
      const extras: string[] = [];
      if (args.tail) extras.push(`tail=${args.tail}`);
      if (args.stream && args.stream !== "both") extras.push(args.stream);
      const extra = extras.length
        ? theme.fg("dim", extras.join(" "))
        : "";
      const toggleHint = theme.fg(
        "dim",
        ` (${keyText("app.tools.expand")} ${context.expanded ? "to collapse" : "to expand"})`,
      );
      text.setText(
        [theme.fg("toolTitle", theme.bold("bg_logs")), name, extra, toggleHint].filter(Boolean).join(" "),
      );
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (!expanded) {
        text.setText("");
        return text;
      }
      const content =
        result.content[0]?.type === "text" ? result.content[0].text : "";
      const lines = content.split("\n").map((l) => {
        if (l.startsWith("── ") || l.startsWith("-- "))
          return theme.fg("accent", l) || l;
        if (
          l === "(no output yet)" ||
          l === "(no output)" ||
          l === "(no stdout)" ||
          l === "(no stderr)" ||
          l === "(no terminal output yet)" ||
          l === "(no terminal output)"
        )
          return theme.fg("muted", l) || l;
        return theme.fg("toolOutput", l) || l;
      });
      text.setText(`\n${lines.join("\n")}`);
      return text;
    },
  });

  // ── bg_send ────────────────────────────────────────────────────────

  const DEFAULT_TERMINATING_SIGNALS = new Set<BackgroundSignal>([
    "SIGABRT",
    "SIGHUP",
    "SIGINT",
    "SIGKILL",
    "SIGQUIT",
    "SIGTERM",
  ]);
  const signalClassifiesStop = (
    task: BgTask,
    signal: BackgroundSignal,
  ): boolean => task.control?.terminatingSignals
    ? task.control.terminatingSignals.includes(signal)
    : DEFAULT_TERMINATING_SIGNALS.has(signal);

  pi.registerTool({
    name: "bg_send",
    label: "BG Send",
    description: "Send text and terminal keys to a running task, or signal a running/disconnected adapter-owned task.",
    promptSnippet: "Send a compact text/key input string or an OS signal to a background task",
    promptGuidelines: [
      "Provide exactly one of bg_send input or signal. bg_send input is exact text; wrap every terminal key in an angle-bracket token such as <C-d>, <A-f>, <Space>, or <Up>, and escape a literal '<' as \\<.",
      "Use bg_send input for terminal keys; use bg_send signal only when an OS process signal is explicitly intended.",
      "For a pipe task, bg_send input=<C-d> or input=<EOF> closes stdin.",
      "When bg_send is followed by waiting or output inspection, emit bg_send → bg_wait → bg_logs together in one assistant response so same-task source ordering avoids extra model rounds.",
      "For a disconnected adapter task, bg_send input is unavailable because the local transport is gone, but bg_send signal may remain usable for cleanup.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID or unique name (case-insensitive)" }),
      input: Type.Optional(Type.String({ description: "Exact text; terminal keys must use <...> tokens, for example y<Enter>, <A-f>, or <C-d>", minLength: 1, maxLength: MAX_INPUT_BYTES })),
      signal: Type.Optional(StringEnum([...BACKGROUND_SEND_SIGNALS], { description: "Named signal validated against the task's local or adapter execution environment" })),
    }),

    executionMode: "parallel",

    async execute(toolCallId, params, abortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
      const predecessor = waitForOrderedToolCall(toolCallId, abortSignal);
      if (predecessor) await predecessor;
      const task = findTaskByReference(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };
      await task.transportExitPending?.catch(() => {});

      const sourceCount = [params.input !== undefined, params.signal !== undefined].filter(Boolean).length;
      if (sourceCount !== 1) {
        return { content: [{ type: "text", text: "Provide exactly one of input or signal." }], details: {} };
      }

      if (params.signal) {
        if (!isTaskControllable(task)) {
          return {
            content: [{
              type: "text",
              text: `Task "${task.name}"${taskEnvironmentSuffix(task)} is not controllable (${task.status}).`,
            }],
            details: {
              id: task.id,
              name: task.name,
              status: task.status,
              ...taskEnvironmentDetails(task),
            },
          };
        }
        const previousStopSignal = task.requestedStopSignal;
        const target = task.control?.signalTarget ?? "process group";
        if (signalClassifiesStop(task, params.signal)) {
          task.requestedStopSignal = params.signal;
        }
        try {
          await sendProcessSignal(task, params.signal, false, abortSignal);
          await settleDisconnectedTaskAfterSignal(task, abortSignal);
          return {
            content: [{
              type: "text",
              text: `Sent ${params.signal} to "${task.name}" ${target}${taskEnvironmentSuffix(task)}.`,
            }],
            details: {
              id: task.id,
              name: task.name,
              signal: params.signal,
              ...taskEnvironmentDetails(task),
            },
          };
        } catch (err) {
          task.requestedStopSignal = previousStopSignal;
          throwIfAborted(abortSignal);
          return {
            content: [{
              type: "text",
              text: `Failed to send ${params.signal} to "${task.name}"${taskEnvironmentSuffix(task)}: ${err instanceof Error ? err.message : String(err)}`,
            }],
            details: {
              id: task.id,
              name: task.name,
              ...taskEnvironmentDetails(task),
            },
          };
        }
      }

      if (
        task.status !== "running"
        || !task.process
        || task.control?.stdinAvailable === false
      ) {
        return {
          content: [{
            type: "text",
            text: task.status === "disconnected"
              ? `Task "${task.name}" transport${taskEnvironmentSuffix(task)} is disconnected; only adapter signals remain available.`
              : task.control?.stdinAvailable === false
                ? `Task "${task.name}" stdin${taskEnvironmentSuffix(task)} is unavailable for this adapter launch; use PTY mode for interactive input.`
                : `Task "${task.name}"${taskEnvironmentSuffix(task)} is not running.`,
          }],
          details: {
            id: task.id,
            name: task.name,
            status: task.status,
            ...taskEnvironmentDetails(task),
          },
        };
      }

      let parsed: ParsedInput;
      try {
        parsed = parseInput(task, params.input ?? "");
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed for "${task.name}"${taskEnvironmentSuffix(task)}: ${err instanceof Error ? err.message : String(err)}`,
          }],
          details: {
            id: task.id,
            name: task.name,
            ...taskEnvironmentDetails(task),
          },
        };
      }

      if (parsed.eof) {
        closeTaskInput(task);
        return {
          content: [{
            type: "text",
            text: `Closed stdin for "${task.name}"${taskEnvironmentSuffix(task)}.`,
          }],
          details: {
            id: task.id,
            name: task.name,
            eof: true,
            mode: task.mode,
            ...taskEnvironmentDetails(task),
          },
        };
      }

      try {
        writeTaskInput(task, parsed.data);
        return {
          content: [{
            type: "text",
            text: `Sent to "${task.name}"${taskEnvironmentSuffix(task)}: ${parsed.data.length} bytes (${parsed.keyTokens} key tokens)`,
          }],
          details: {
            id: task.id,
            name: task.name,
            bytes: parsed.data.length,
            keyTokens: parsed.keyTokens,
            textBytes: parsed.textBytes,
            mode: task.mode,
            ...taskEnvironmentDetails(task),
          },
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed for "${task.name}"${taskEnvironmentSuffix(task)}: ${err instanceof Error ? err.message : String(err)}`,
          }],
          details: {
            id: task.id,
            name: task.name,
            ...taskEnvironmentDetails(task),
          },
        };
      }
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const name = renderTaskCallLabel(args.id, theme);
      const value = args.signal ?? (args.input !== undefined ? truncateText(JSON.stringify(args.input), 80) : undefined);
      const input = value !== undefined ? theme.fg("dim", `→ ${value}`) : "";
      text.setText([theme.fg("toolTitle", theme.bold("bg_send")), name, input].filter(Boolean).join(" "));
      return text;
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Sending..."), 0, 0);
      const content = result.content[0]?.type === "text" ? result.content[0].text : "";
      return new Text(theme.fg("toolOutput", content) || content, 0, 0);
    },
  });

  // ── bg_kill ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_kill",
    label: "BG Kill",
    description: "Terminate a running or disconnected background task and report the result. Sends SIGTERM by default or SIGKILL with force=true; does not return process output.",
    promptSnippet: "Terminate an unresponsive background task",
    promptGuidelines: [
      "Use bg_kill when a background task must be terminated.",
      "Use bg_kill with force=true to send SIGKILL immediately; otherwise bg_kill sends SIGTERM.",
      "bg_kill returns termination status only. When final output is needed, emit bg_kill followed by bg_logs in the same assistant response.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID or unique name (case-insensitive)" }),
      force: Type.Optional(Type.Boolean({ description: "Send SIGKILL instead of SIGTERM (default: false)" })),
    }),

    executionMode: "parallel",

    async execute(toolCallId, params, abortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
      const predecessor = waitForOrderedToolCall(toolCallId, abortSignal);
      if (predecessor) await predecessor;
      const task = findTaskByReference(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };
      await task.transportExitPending?.catch(() => {});
      if (!isTaskControllable(task)) {
        return {
          content: [{
            type: "text",
            text: `Task "${task.name}"${taskEnvironmentSuffix(task)} is already ${task.status}.`,
          }],
          details: {
            id: task.id,
            name: task.name,
            status: task.status,
            ...taskEnvironmentDetails(task),
          },
        };
      }

      const signal = params.force ? "SIGKILL" : "SIGTERM";
      try {
        await sendTaskSignal(task, signal, abortSignal);
        await settleDisconnectedTaskAfterSignal(task, abortSignal);
      }
      catch (err) {
        throwIfAborted(abortSignal);
        return {
          content: [{
            type: "text",
            text: `Failed to send ${signal} to "${task.name}"${taskEnvironmentSuffix(task)}: ${err instanceof Error ? err.message : String(err)}`,
          }],
          details: {
            id: task.id,
            name: task.name,
            ...taskEnvironmentDetails(task),
          },
        };
      }

      await waitForTaskEnd(task, params.force ? 500 : 2500);

      const action = isTaskControllable(task) ? `Sent ${signal} to` : "Terminated";
      return {
        content: [{
          type: "text",
          text: `${action} "${task.name}"${taskEnvironmentSuffix(task)}. Status: ${task.status}`,
        }],
        details: {
          id: task.id,
          name: task.name,
          status: task.status,
          signal,
          mode: task.mode,
          ...taskEnvironmentDetails(task),
        },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const name = renderTaskCallLabel(args.id, theme);
      const sig = args.force ? theme.fg("error", "SIGKILL") : "";
      text.setText([theme.fg("toolTitle", theme.bold("bg_kill")), name, sig].filter(Boolean).join(" "));
      return text;
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Killing..."), 0, 0);
      const content = result.content[0]?.type === "text" ? result.content[0].text : "";
      const lines = content.split("\n").map(l => {
        if (l.includes("SIGKILL")) return theme.fg("error", l) || l;
        if (l.includes("SIGTERM")) return theme.fg("warning", l) || l;
        return theme.fg("toolOutput", l) || l;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

}
