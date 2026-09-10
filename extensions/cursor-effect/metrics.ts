import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CursorMetricsConfig } from "./config.ts";

/** Deliberately approximate: ASCII ~4 characters/token, other code points ~1. */
export function estimateOutputTokens(delta: string): number {
  let tokens = 0;
  for (const char of delta) tokens += char.codePointAt(0)! <= 0x7f ? 0.25 : 1;
  return tokens;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

interface ResponseSample {
  startedAt: number;
  estimated: number;
}

/** Local monotonic timings; no provider/model/context mutations or session writes. */
export class CursorMetrics {
  private startedAt = 0;
  private endedAt = 0;
  private response?: ResponseSample;
  private outputTokens = 0;
  private responseMs = 0;
  private lastLiveSpeed?: string;
  private missingUsage = false;
  private outcome = "Done";
  active = false;
  completed = false;

  constructor(private readonly now: () => number = () => performance.now()) {}

  reset(): void {
    this.active = false;
    this.completed = false;
    this.response = undefined;
    this.outputTokens = 0;
    this.responseMs = 0;
    this.lastLiveSpeed = undefined;
    this.missingUsage = false;
    this.outcome = "Done";
  }

  start(): void {
    // Automatic retries/continuations belong to the same busy interval.
    if (this.active) return;
    this.reset();
    this.active = true;
    this.startedAt = this.now();
  }

  startResponse(): void {
    if (!this.active) return;
    this.response = { startedAt: this.now(), estimated: 0 };
  }

  addDelta(delta: string): void {
    if (this.response) this.response.estimated += estimateOutputTokens(delta);
  }

  endResponse(output: number | undefined, stopReason: string): void {
    if (!this.active || !this.response) return;
    if (stopReason === "aborted") this.outcome = "Cancelled";
    else if (stopReason === "error") this.outcome = "Error";
    else this.outcome = "Done";
    if (typeof output === "number" && Number.isFinite(output) && output > 0) {
      this.outputTokens += output;
      this.responseMs += Math.max(0, this.now() - this.response.startedAt);
    } else if (this.response.estimated > 0 || stopReason === "error" || stopReason === "aborted") {
      this.missingUsage = true;
    }
    this.response = undefined;
  }

  finish(): void {
    if (!this.active) return;
    if (this.response) this.missingUsage = true;
    this.response = undefined;
    this.endedAt = this.now();
    this.active = false;
    this.completed = true;
  }

  text(config: CursorMetricsConfig, kind = "working"): string {
    if (!this.active && !this.completed) return "";
    const now = this.active ? this.now() : this.endedAt;
    const parts: string[] = [];
    if (config.elapsed) parts.push(duration(now - this.startedAt));
    // Compaction/summary tokens are not delivered through normal message events.
    if (kind !== "working") return parts.join(" ");
    if (config.outputTokens) {
      const estimate = this.response?.estimated ?? 0;
      parts.push(this.missingUsage ? "out —" : `${estimate > 0 ? "≈" : ""}${Math.round(this.outputTokens + estimate)} out`);
    }
    if (this.active && config.liveSpeed) {
      if (this.response) {
        const ms = now - this.response.startedAt;
        if (ms >= 500 && this.response.estimated > 0) {
          this.lastLiveSpeed = `≈${(this.response.estimated * 1000 / ms).toFixed(1)} tok/s`;
        }
      }
      // Hold the last displayed estimate through tool execution and first-output
      // waiting. It belongs only to this task, not to a subsequent user request.
      if (this.lastLiveSpeed) parts.push(this.lastLiveSpeed);
    }
    // Average throughput uses only request spans, including first-output wait,
    // and excludes tool execution, retry backoff, compaction and user idle time.
    // The speed switch controls both live estimates and the final average.
    if (!this.active && config.liveSpeed) {
      parts.push(!this.missingUsage && this.responseMs >= 500 && this.outputTokens > 0
        ? `Avg ${(this.outputTokens * 1000 / this.responseMs).toFixed(1)} tok/s` : "Avg — tok/s");
    }
    if (!parts.length) return "";
    return this.active ? parts.join(" ") : `${this.outcome} ${parts.join(" ")}`;
  }
}

export function registerCursorMetrics(
  pi: ExtensionAPI,
  getConfig: () => CursorMetricsConfig,
): { suffix(kind: string): string } {
  const metrics = new CursorMetrics();
  pi.on("session_start", () => { metrics.reset(); });
  pi.on("session_tree", () => { metrics.reset(); });
  pi.on("agent_start", () => { metrics.start(); });
  pi.on("turn_start", () => { metrics.startResponse(); });
  pi.on("message_update", (event) => {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
      metrics.addDelta(update.delta);
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      metrics.endResponse(event.message.usage?.output, event.message.stopReason);
    }
  });
  // agent_end is too early: automatic retry/compaction/follow-ups may follow.
  pi.on("agent_settled", (_event, ctx) => {
    if (!metrics.active) return;
    metrics.finish();
    const config = getConfig();
    const text = config.completionSummary ? metrics.text(config) : "";
    if (ctx.hasUI && text) ctx.ui.notify(text, "info");
  });
  pi.on("session_shutdown", () => { metrics.reset(); });
  return {
    suffix: (kind) => metrics.active ? metrics.text(getConfig(), kind) : "",
  };
}
