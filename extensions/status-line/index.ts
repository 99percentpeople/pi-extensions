/**
 * Status Line Extension for Pi
 *
 * Displays useful status information in the footer.
 *
 * Features:
 *   - Current working directory
 *   - Git branch and status
 *   - Context token usage
 *   - Model information
 *   - Session duration
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/status-line/
 *   Or: pi -e ./status-line/
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Helpers ───────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function truncatePath(path: string, maxLength: number = 30): string {
  if (path.length <= maxLength) {
    return path;
  }

  const parts = path.split(/[/\\]/);
  if (parts.length <= 2) {
    return "..." + path.slice(-(maxLength - 3));
  }

  // Show first and last parts
  const first = parts[0];
  const last = parts.slice(-2).join("/");
  const truncated = `${first}/.../${last}`;

  if (truncated.length <= maxLength) {
    return truncated;
  }

  return "..." + path.slice(-(maxLength - 3));
}

// ── Git Helpers ───────────────────────────────────────────────────────

interface GitInfo {
  branch: string | null;
  isDirty: boolean;
  ahead: number;
  behind: number;
}

async function getGitInfo(cwd: string, pi: ExtensionAPI): Promise<GitInfo> {
  try {
    // Get current branch
    const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;

    if (!branch) {
      return { branch: null, isDirty: false, ahead: 0, behind: 0 };
    }

    // Check if dirty
    const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd });
    const isDirty = statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0;

    // Get ahead/behind counts
    let ahead = 0;
    let behind = 0;
    try {
      const revResult = await pi.exec(
        "git",
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        { cwd }
      );
      if (revResult.exitCode === 0) {
        const [a, b] = revResult.stdout.trim().split(/\s+/).map(Number);
        ahead = a || 0;
        behind = b || 0;
      }
    } catch {
      // No upstream configured
    }

    return { branch, isDirty, ahead, behind };
  } catch {
    return { branch: null, isDirty: false, ahead: 0, behind: 0 };
  }
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let sessionStartTime: number = Date.now();
  let uiCtx: ExtensionContext | null = null;

  pi.on("session_start", async (_event, ctx) => {
    sessionStartTime = Date.now();
    uiCtx = ctx;
    updateStatusLine(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    updateStatusLine(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatusLine(ctx);
  });

  async function updateStatusLine(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    const parts: string[] = [];

    // Current directory
    const cwd = ctx.cwd;
    parts.push(`📁 ${truncatePath(cwd)}`);

    // Git info
    try {
      const git = await getGitInfo(cwd, pi);
      if (git.branch) {
        let gitStatus = `🔀 ${git.branch}`;
        if (git.isDirty) gitStatus += "*";
        if (git.ahead > 0) gitStatus += `↑${git.ahead}`;
        if (git.behind > 0) gitStatus += `↓${git.behind}`;
        parts.push(gitStatus);
      }
    } catch {
      // Git not available
    }

    // Model info
    try {
      const model = ctx.model;
      if (model) {
        parts.push(`🤖 ${model.id}`);
      }
    } catch {
      // Model info not available
    }

    // Session duration
    const duration = Date.now() - sessionStartTime;
    parts.push(`⏱️ ${formatDuration(duration)}`);

    // Context usage
    try {
      const usage = ctx.getContextUsage();
      if (usage) {
        const tokens = usage.tokens;
        const formatted = tokens > 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens.toString();
        parts.push(`📊 ${formatted} tokens`);
      }
    } catch {
      // Context usage not available
    }

    // Update footer
    ctx.ui.setFooter((tui, theme) => ({
      render(width: number) {
        const line = parts.join(" │ ");
        const truncated = line.length > width ? line.slice(0, width - 3) + "..." : line;
        return [theme.fg("dim", truncated)];
      },
      invalidate() {},
    }));
  }

  // Register command to refresh status
  pi.registerCommand("status", {
    description: "Refresh status line",
    handler: async (_args, ctx) => {
      await updateStatusLine(ctx);
      ctx.ui.notify("Status line refreshed", "info");
    },
  });
}
