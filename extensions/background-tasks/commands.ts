import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachTask } from "./attachment.ts";
import {
  isTaskControllable,
  sendTaskSignal,
  settleDisconnectedTaskAfterSignal,
  tasks,
  waitForTaskEnd,
} from "./runtime.ts";

export function registerBackgroundTaskCommands(pi: ExtensionAPI): void {
  // ── /bg-attach command ─────────────────────────────────────────────

  pi.registerCommand("bg-attach", {
    description: "Attach to a task (live while running, read-only final snapshot after exit; Ctrl+] to detach)",
    getArgumentCompletions: (prefix: string) => {
      const items = Array.from(tasks.values())
        .map((task) => ({ value: task.id, label: `${task.id} [${task.mode}] ${task.name} (${task.status})` }));
      return items.filter((item) => item.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      let id = args.trim().split(/\s+/, 1)[0];
      if (!id) {
        const retained = Array.from(tasks.values());
        if (retained.length === 0) {
          ctx.ui.notify("No background tasks.", "info");
          return;
        }
        const choice = await ctx.ui.select(
          "Attach to which task? (finished snapshots are read-only; Ctrl+] to detach)",
          retained.map((task) => `${task.id} [${task.mode}] ${task.name} (${task.status})`),
        );
        if (!choice) return;
        id = choice.split(" ", 1)[0];
      }

      const task = tasks.get(id);
      if (!task) {
        ctx.ui.notify(`Task not found: ${id}`, "error");
        return;
      }
      await attachTask(task, ctx);
    },
  });

  // ── /bg-kill command ───────────────────────────────────────────────

  pi.registerCommand("bg-kill", {
    description: "Kill a background task by ID",
    getArgumentCompletions: (prefix: string) => {
      const items = Array.from(tasks.values())
        .filter(isTaskControllable)
        .map(t => ({ value: t.id, label: `${t.id} ${t.name}` }));
      return items.filter(i => i.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      if (!args) {
        const running = Array.from(tasks.values()).filter(isTaskControllable);
        if (running.length === 0) {
          ctx.ui.notify("No running tasks.", "info");
          return;
        }
        const choice = await ctx.ui.select(
          "Kill which task?",
          running.map(t => `${t.id} ${t.name}`),
        );
        if (!choice) return;
        args = choice.split(" ", 1)[0];
      }

      const task = tasks.get(args);
      if (!task) {
        ctx.ui.notify(`Task not found: ${args}`, "error");
        return;
      }
      await task.transportExitPending?.catch(() => {});
      if (!isTaskControllable(task)) {
        ctx.ui.notify(`Task "${task.name}" is already ${task.status}.`, "warning");
        return;
      }

      try {
        await sendTaskSignal(task, "SIGKILL");
        await settleDisconnectedTaskAfterSignal(task);
      } catch (error) {
        ctx.ui.notify(`Failed to kill "${task.name}": ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      await waitForTaskEnd(task, 500);
      ctx.ui.notify(`Stop requested for "${task.name}" (${task.id}); status: ${task.status}`, "info");
    },
  });
}
