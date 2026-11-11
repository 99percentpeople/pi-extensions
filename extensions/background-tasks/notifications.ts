import type {
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { isFinalTaskStatus, tasks } from "./runtime.ts";
import type { BgTask } from "./types.ts";

/** Receipts stay local until a successful active turn boundary; never wake an idle agent. */
export class CompletionNotifications {
  private readonly pending = new Map<string, BgTask>();
  private generation = 0;
  private active = true;

  constructor(private readonly pi: ExtensionAPI, private enabled: boolean) {}

  reset(active = false): void {
    this.generation++;
    this.pending.clear();
    this.active = active;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.pending.clear();
    // Enabling only subscribes to future finishes; never scan historical tasks.
  }

  captureGeneration(): number {
    return this.generation;
  }

  finished(task: BgTask): void {
    if (!this.active || !this.enabled || tasks.get(task.id) !== task) return;
    this.pending.set(task.id, task);
  }

  /** Called on the definition's final execute result, including nested/codemode calls. */
  acknowledge(details: unknown, generation: number): void {
    if (!this.active || generation !== this.generation || !details || typeof details !== "object") return;
    const result = details as { id?: unknown; status?: unknown; tasks?: unknown };
    if (typeof result.id === "string" && (
      result.status === "completed" || result.status === "failed" || result.status === "stopped"
    )) this.pending.delete(result.id);
    if (Array.isArray(result.tasks)) {
      for (const task of result.tasks) this.acknowledge(task, generation);
    }
  }

  protects(task: BgTask): boolean {
    return this.pending.get(task.id) === task;
  }

  turnEnd(event: TurnEndEvent, ctx: ExtensionContext): void {
    if (!this.active || !this.enabled || event.message?.role !== "assistant") return;
    if (ctx.isIdle() || ctx.signal?.aborted || ctx.hasPendingMessages()) return;
    if (event.message.stopReason === "aborted" || event.message.stopReason === "error" || event.message.stopReason === "length") return;
    // All tool execute results have returned and acknowledged consumed receipts.
    // Automatic retries reach this boundary without another before_agent_start.
    const unread = [...this.pending.values()].filter((task) => tasks.get(task.id) === task && isFinalTaskStatus(task.status));
    if (unread.length === 0) return;
    for (const task of unread) {
      // Preserve output if a user prompt races with the boundary steering batch.
      task.retainForNextAgentTurn = true;
      this.pending.delete(task.id);
    }
    this.pi.sendMessage({
      customType: "background-tasks-completed",
      content: "Unread background task completions:\n" + unread.map((task) =>
        `- ${JSON.stringify(task.name)} (${task.id}): ${task.status}`
        + (task.exitCode === null ? "" : `, exit=${task.exitCode}`),
      ).join("\n") + "\nUse bg_status or bg_logs if further inspection is needed.",
      display: true,
      details: { taskIds: unread.map((task) => task.id) },
    }, { deliverAs: "steer", triggerTurn: false });
  }
}
