/**
 * Session Name Extension for Pi
 *
 * Automatically names sessions based on the first user message.
 *
 * Features:
 *   - Auto-generate session names from first message
 *   - Manual session naming via /name command
 *   - Session name display in status
 *   - Configurable name length
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/session-name/
 *   Or: pi -e ./session-name/
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Helpers ───────────────────────────────────────────────────────────

function generateSessionName(text: string, maxLength: number = 50): string {
  // Remove common prefixes
  let cleaned = text
    .replace(/^(please|can you|could you|help me|i want to|i need to|let's|lets)\s+/i, "")
    .replace(/^(how do i|how to|what is|what's|why is|why does)\s+/i, "")
    .replace(/[?!.]+$/, "")
    .trim();

  // Take first sentence or up to maxLength
  const firstSentence = cleaned.split(/[.!?]\s/)[0];
  const name = firstSentence.length > maxLength 
    ? firstSentence.slice(0, maxLength) + "..."
    : firstSentence;

  // Capitalize first letter
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let hasNamedSession = false;

  pi.on("session_start", async (event, ctx) => {
    // Reset flag for new sessions
    if (event.reason === "new" || event.reason === "startup") {
      hasNamedSession = false;
    }
  });

  pi.on("input", async (event, ctx) => {
    // Only name on first user message
    if (hasNamedSession) {
      return { action: "continue" };
    }

    // Don't name on commands
    if (event.text.startsWith("/")) {
      return { action: "continue" };
    }

    // Generate and set name
    const name = generateSessionName(event.text);
    if (name) {
      pi.setSessionName(name);
      hasNamedSession = true;

      // Show notification in TUI mode
      if (ctx.hasUI) {
        ctx.ui.notify(`Session named: ${name}`, "info");
      }
    }

    return { action: "continue" };
  });

  // Manual naming command
  pi.registerCommand("name", {
    description: "Set or change session name",
    getArgumentCompletions: (prefix: string) => {
      // Suggest common names
      const suggestions = [
        "Refactor auth module",
        "Debug API issue",
        "Add new feature",
        "Code review",
        "Performance optimization",
        "Database migration",
        "UI improvements",
        "Testing setup",
      ];

      return suggestions
        .filter(s => s.toLowerCase().startsWith(prefix.toLowerCase()))
        .map(s => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      if (!args) {
        // Show current name
        const currentName = pi.getSessionName();
        if (currentName) {
          ctx.ui.notify(`Current session name: ${currentName}`, "info");
        } else {
          ctx.ui.notify("Session has no name", "info");
        }
        return;
      }

      // Set new name
      pi.setSessionName(args);
      hasNamedSession = true;
      ctx.ui.notify(`Session renamed to: ${args}`, "info");
    },
  });

  // Clear name command
  pi.registerCommand("name-clear", {
    description: "Clear session name",
    handler: async (_args, ctx) => {
      pi.setSessionName("");
      hasNamedSession = false;
      ctx.ui.notify("Session name cleared", "info");
    },
  });
}
