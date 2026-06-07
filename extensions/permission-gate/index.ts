/**
 * Permission Gate Extension for Pi
 *
 * Blocks dangerous commands and requires user confirmation.
 *
 * Features:
 *   - Blocks dangerous bash commands (rm -rf, sudo, git push --force, etc.)
 *   - Configurable blocked patterns
 *   - User confirmation dialog
 *   - Custom rendering for blocked commands
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/permission-gate/
 *   Or: pi -e ./permission-gate/
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Dangerous Command Patterns ────────────────────────────────────────

const DANGEROUS_PATTERNS = [
  // File operations
  /\brm\s+(-[rfRF]+\s+|--recursive\s+|--force\s+)/i,
  /\brm\s+(-[a-zA-Z]*[rfRF][a-zA-Z]*\s+)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd[a-z]/i,

  // System operations
  /\bsudo\b/i,
  /\bchmod\s+777\b/i,
  /\bchown\s+root\b/i,
  /\bkill\s+-9\s+1\b/i,
  /\bkillall\b/i,
  /\bpkill\b/i,

  // Git operations
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+push\s+.*-f\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-zA-Z]*f/i,
  /\bgit\s+checkout\s+--\s*\./i,

  // Network operations
  /\bcurl\s+.*\|\s*(ba)?sh/i,
  /\bwget\s+.*\|\s*(ba)?sh/i,
  /\bnc\s+-l/i,
  /\bncat\b/i,

  // Package management
  /\bnpm\s+(uninstall|remove)\s+-g/i,
  /\bpip\s+uninstall\b/i,

  // Docker
  /\bdocker\s+rm\s+-f\b/i,
  /\bdocker\s+rmi\s+-f\b/i,
  /\bdocker\s+system\s+prune\s+-a\b/i,
];

// ── Types ─────────────────────────────────────────────────────────────

interface BlockedCommand {
  command: string;
  pattern: RegExp;
  reason: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

function findDangerousPattern(command: string): RegExp | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return pattern;
    }
  }
  return null;
}

function getPatternReason(pattern: RegExp): string {
  const source = pattern.source;

  if (source.includes("rm\\s+") || source.includes("rm\\s+")) {
    return "Recursive/force delete operation";
  }
  if (source.includes("sudo")) {
    return "Requires elevated privileges";
  }
  if (source.includes("git\\s+push") || source.includes("--force")) {
    return "Force push operation";
  }
  if (source.includes("git\\s+reset") || source.includes("git\\s+clean")) {
    return "Destructive git operation";
  }
  if (source.includes("curl") || source.includes("wget")) {
    return "Piping remote content to shell";
  }
  if (source.includes("chmod") || source.includes("chown")) {
    return "Permission modification";
  }
  if (source.includes("kill") || source.includes("pkill")) {
    return "Process termination";
  }
  if (source.includes("docker")) {
    return "Docker destructive operation";
  }

  return "Potentially dangerous command";
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Store blocked commands for reference
  const blockedCommands: BlockedCommand[] = [];

  pi.on("tool_call", async (event, ctx) => {
    // Only intercept bash tool calls
    if (event.toolName !== "bash") {
      return;
    }

    const input = event.input as { command?: string };
    const command = input.command;

    if (!command) {
      return;
    }

    const pattern = findDangerousPattern(command);
    if (!pattern) {
      return;
    }

    const reason = getPatternReason(pattern);

    // Log the blocked command
    blockedCommands.push({ command, pattern, reason });

    // Show confirmation dialog
    const ok = await ctx.ui.confirm(
      "⚠️  Dangerous Command Detected",
      `Command: ${command}\nReason: ${reason}\n\nDo you want to allow this command?`,
      { timeout: 30000 } // 30 second timeout
    );

    if (!ok) {
      return {
        block: true,
        reason: `Blocked by permission gate: ${reason}`,
      };
    }

    // User approved - allow the command
    ctx.ui.notify("Command approved by user", "info");
    return;
  });

  // Register command to view blocked commands history
  pi.registerCommand("blocked", {
    description: "Show history of blocked commands",
    handler: async (_args, ctx) => {
      if (blockedCommands.length === 0) {
        ctx.ui.notify("No commands have been blocked", "info");
        return;
      }

      const lines = blockedCommands.map((cmd, i) => 
        `${i + 1}. ${cmd.command}\n   Reason: ${cmd.reason}`
      );

      ctx.ui.notify(`Blocked Commands:\n${lines.join("\n\n")}`, "info");
    },
  });

  // Register command to clear history
  pi.registerCommand("blocked-clear", {
    description: "Clear blocked commands history",
    handler: async (_args, ctx) => {
      blockedCommands.length = 0;
      ctx.ui.notify("Blocked commands history cleared", "info");
    },
  });
}
