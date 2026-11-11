import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  loadBackgroundTasksConfig,
  normalizeBackgroundTasksConfig,
  saveBackgroundTasksConfig,
} from "./config.ts";
import { CompletionNotifications } from "./notifications.ts";
import { registerBackgroundTaskCommands } from "./commands.ts";
import {
  ORDERED_TASK_TOOL_NAMES,
  TASK_SNAPSHOT_CUSTOM_TYPE,
  clearOrderedToolCalls,
  clearTaskRuntimeState,
  configureExecutionBackend,
  disposeTaskControl,
  finishTask,
  flushConsole,
  forceKillProcess,
  getTaskSnapshotAppender,
  isTaskControllable,
  onTaskFinished,
  persistTaskReconciliation,
  registerOrderedToolCall,
  registerShellProvider,
  releaseOrderedToolCall,
  restoreFinishedTaskSnapshots,
  runningTasks,
  sendTaskSignal,
  setTaskSnapshotAppender,
  setTasksChangedHandler,
  settleDisconnectedTaskAfterSignal,
  taskOrderingKey,
  tasks,
  unregisterShellProvider,
  waitForSnapshotPersistence,
  waitForTaskEnd,
} from "./runtime.ts";
import { registerBackgroundTasksSettings } from "./settings.ts";
import { registerBackgroundTaskTools } from "./tools.ts";
import type {
  BackgroundTasksExtensionDependencies,
  PersistedTaskEvent,
} from "./types.ts";
import {
  WIDGET_KEY,
  clearWidget,
  discardExpiredFinishedTasks,
  getBackgroundTasksConfig,
  getWidgetContext,
  setBackgroundTasksConfig,
  setWidgetContext,
  updateWidget,
} from "./widget.ts";

export default function (
  pi: ExtensionAPI,
  dependencies: BackgroundTasksExtensionDependencies = {},
) {
  // Extension modules can survive Pi session replacement. Reset adapters here
  // so a remote or alternate shell from the previous session cannot leak into
  // a newly loaded local session before adapters register again.
  configureExecutionBackend(dependencies);
  setTasksChangedHandler(updateWidget);
  setBackgroundTasksConfig(normalizeBackgroundTasksConfig(
    (dependencies.loadConfig ?? loadBackgroundTasksConfig)(),
  ));
  const notifications = new CompletionNotifications(pi, getBackgroundTasksConfig().completionNotifications);
  let unsubscribeFinished = onTaskFinished((task) => notifications.finished(task));
  const persistConfig = dependencies.saveConfig ?? saveBackgroundTasksConfig;

  registerBackgroundTasksSettings(pi, {
    getConfig: getBackgroundTasksConfig,
    updateConfig: (next, ctx) => {
      const config = normalizeBackgroundTasksConfig(next);
      setBackgroundTasksConfig(config);
      notifications.setEnabled(config.completionNotifications);
      try {
        persistConfig(config);
      } catch (error) {
        ctx.ui.notify(
          `Failed to save Background Tasks settings: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
      setWidgetContext(ctx);
      updateWidget();
    },
  });

  const snapshotAppender = (event: PersistedTaskEvent) => {
    pi.appendEntry(TASK_SNAPSHOT_CUSTOM_TYPE, event);
  };
  const enableSnapshotPersistence = () => {
    setTaskSnapshotAppender(snapshotAppender);
  };
  enableSnapshotPersistence();

  pi.events.on("bg:unregister", (data: unknown) => {
    unregisterShellProvider((data as { id?: unknown })?.id);
  });

  pi.events.on("bg:register", registerShellProvider);

  pi.on("session_start", async (_event, ctx) => {
    notifications.reset(true);
    unsubscribeFinished();
    unsubscribeFinished = onTaskFinished((task) => notifications.finished(task));
    enableSnapshotPersistence();
    setTasksChangedHandler(updateWidget);
    clearOrderedToolCalls();
    clearWidget();
    await restoreFinishedTaskSnapshots(ctx);
    setWidgetContext(ctx);
    updateWidget();
  });

  pi.on("session_tree", async (_event, ctx) => {
    notifications.reset(true);
    setTasksChangedHandler(updateWidget);
    clearOrderedToolCalls();
    clearWidget();
    await restoreFinishedTaskSnapshots(ctx);
    setWidgetContext(ctx);
    updateWidget();
  });

  pi.on("turn_start", async () => {
    clearOrderedToolCalls();
  });

  pi.on("tool_call", async (event) => {
    if (!ORDERED_TASK_TOOL_NAMES.has(event.toolName)) return;
    const input = event.input as Record<string, unknown>;
    const taskReference = event.toolName === "bg_start" ? input.name : input.id;
    if (typeof taskReference !== "string" || taskReference.trim().length === 0) return;
    registerOrderedToolCall(event.toolCallId, taskOrderingKey(taskReference));
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    releaseOrderedToolCall(event.toolCallId);
    if (event.toolName.startsWith("bg_")) { setWidgetContext(ctx); updateWidget(); }
  });

  pi.on("turn_end", async (event, ctx) => {
    clearOrderedToolCalls();
    notifications.turnEnd(event, ctx);
  });

  pi.on("agent_settled", async () => {
    for (const task of runningTasks) task.retainForNextAgentTurn = true;
  });

  pi.on("before_agent_start", async () => {
    await waitForSnapshotPersistence();
    const reconciliation = await discardExpiredFinishedTasks((task) => notifications.protects(task));
    if (reconciliation.removed.length > 0 || reconciliation.clearedRetention.length > 0) {
      updateWidget();
      await persistTaskReconciliation(reconciliation.removed, reconciliation.clearedRetention);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    notifications.reset();
    unsubscribeFinished();
    clearOrderedToolCalls();
    await waitForSnapshotPersistence();
    if (getTaskSnapshotAppender() === snapshotAppender) setTaskSnapshotAppender(null);
    clearWidget();
    if (ctx?.hasUI && ctx !== getWidgetContext()) ctx.ui.setWidget(WIDGET_KEY, undefined);
    setWidgetContext(null);
    for (const task of tasks.values()) task.attachment.detach?.("shutdown");
    await Promise.all(Array.from(tasks.values()).map(async (task) => {
      await task.transportExitPending?.catch(() => {});
      if (!isTaskControllable(task) || (!task.process && !task.control)) return;
      try {
        await sendTaskSignal(task, "SIGTERM");
        await settleDisconnectedTaskAfterSignal(task);
        await waitForTaskEnd(task, 3000);
        if (isTaskControllable(task)) {
          await sendTaskSignal(task, "SIGKILL");
          await settleDisconnectedTaskAfterSignal(task);
          await waitForTaskEnd(task, 1000);
        }
      } catch {
        // Closing the local launcher is only a last-resort local cleanup. Do
        // not treat it as proof that an adapter-owned remote process exited.
        forceKillProcess(task);
      }
    }));
    for (const task of tasks.values()) {
      if (task.status === "running") {
        forceKillProcess(task);
        if (!task.control) finishTask(task, null, "shutdown");
      }
    }
    await Promise.all(Array.from(tasks.values()).map(async (task) => {
      await flushConsole(task);
      await disposeTaskControl(task).catch(() => {});
    }));
    await waitForSnapshotPersistence();
    for (const task of tasks.values()) task.console.terminal.dispose();
    clearTaskRuntimeState();
    setTasksChangedHandler(undefined);
  });

  registerBackgroundTaskTools(pi, dependencies, notifications);
  registerBackgroundTaskCommands(pi);
}
