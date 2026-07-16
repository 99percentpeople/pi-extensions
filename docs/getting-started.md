# Getting Started with Pi Extensions

This guide will help you get started with creating and using Pi extensions.

## Prerequisites

Before you begin, make sure you have:

1. [Pi coding agent](https://github.com/badlogic/pi-mono) installed
2. [Bun](https://bun.com/) 1.3.14 for dependency management
3. [Node.js](https://nodejs.org/) 18+ for Pi runtime compatibility
4. Basic TypeScript knowledge
5. A code editor (VS Code recommended)

## Installation

### Option 1: Install independent packages from npm (Recommended)

```bash
pi install npm:@99percentpeople/pi-background-tasks

# Windows only, when PowerShell 7 integration is wanted
pi install npm:@99percentpeople/pi-pwsh-adapter
```

### Option 2: Install from source

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/pi-extensions.git
cd pi-extensions

# Install dependencies
bun install

# Install background-tasks globally from the checkout
pi install ./extensions/background-tasks

# Or install to a specific project
cd ~/your-project
pi install -l /path/to/pi-extensions/extensions/background-tasks
```

### Option 3: Quick test without installing

```bash
pi -e ./extensions/background-tasks/index.ts
```

## Using Extensions

### Background Tasks

Run long commands in the background:

```bash
# Start a background task
bg_start name="build" command="bun run build"

# Check status
bg_status id="abcd"

# Read logs
bg_logs id="abcd" tail=50

# Send text and keys using the single-string input DSL
bg_send id="abcd" input="y<Enter>"
bg_send id="abcd" input="<F10>"
bg_send id="abcd" input="<Esc>iHello<Enter>"

# Terminate a task
bg_kill id="abcd" force=true

# Start a full-screen TUI in a pseudoterminal
bg_start name="git-ui" command="lazygit" pty=true

# Wait and include the final PTY screen without a separate bg_logs call
bg_wait id="abcd" terminal_snapshot=true

# Attach from the Pi command line; press Ctrl+] to detach
/bg-attach abcd
```

### PWSh Adapter

PowerShell 7 adapter for Windows:

- Replaces default bash tool with PowerShell 7
- Adapts background-tasks to use pwsh
- UTF-8 encoding support
- Process tree cleanup on Windows

## Creating Your Own Extension

### Step 1: Create the extension directory

```bash
mkdir extensions/my-extension
```

### Step 2: Create the extension file

Create `extensions/my-extension/index.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // Register a tool
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What this tool does",
    promptSnippet: "Short description for system prompt",
    promptGuidelines: [
      "Use my_tool when the user asks for specific functionality."
    ],
    parameters: Type.Object({
      input: Type.String({ description: "Input parameter" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Tool implementation
      return {
        content: [{ type: "text", text: "Result" }],
        details: { /* optional details */ },
      };
    },
  });

  // Register a command
  pi.registerCommand("my-command", {
    description: "Description of the command",
    handler: async (args, ctx) => {
      ctx.ui.notify("Command executed!", "info");
    },
  });

  // Subscribe to events
  pi.on("session_start", async (event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });
}
```

### Step 3: Test the extension

```bash
pi -e ./extensions/my-extension/index.ts
```

### Step 4: Add an extension package.json

```json
{
  "name": "@your-scope/pi-my-extension",
  "version": "1.0.0",
  "type": "module",
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

Add `extensions/my-extension` to the root Bun `workspaces` array. Each
extension is versioned and published from its own directory.

### Step 5: Update documentation

Update `README.md` with your extension's documentation.

## Development Tips

### 1. Use TypeScript

Always use TypeScript with strict mode for better type safety:

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
```

### 2. Handle Errors Gracefully

```typescript
async execute(toolCallId, params, signal, onUpdate, ctx) {
  try {
    // Your implementation
    return { content: [{ type: "text", text: "Success" }] };
  } catch (error) {
    throw new Error(`Failed: ${error.message}`);
  }
}
```

### 3. Provide Clear Feedback

```typescript
// Use notifications
ctx.ui.notify("Task completed!", "info");

// Use status updates
ctx.ui.setStatus("my-ext", "Processing...");

// Use widgets
ctx.ui.setWidget("my-ext", ["Line 1", "Line 2"]);
```

### 4. Follow Best Practices

- Keep extensions focused on single responsibility
- Provide clear documentation
- Use meaningful tool and command names
- Include error handling
- Test thoroughly

## Troubleshooting

### Extension not loading

1. Check for TypeScript errors: `bun run lint`
2. Verify the extension path in the extension's own `package.json`
3. Check Pi's error output

### Tool not appearing

1. Make sure `promptSnippet` is defined
2. Check tool registration in the extension
3. Restart Pi after changes

### Command not working

1. Verify command registration
2. Check for conflicts with existing commands
3. Test with `pi -e ./extensions/my-extension/index.ts`

## Next Steps

- Read the [Pi Extensions Documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- Explore [example extensions](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions)
- Join the [Pi community](https://discord.gg/pi-coding-agent)
- Contribute to this repository

## Getting Help

If you need help:

1. Check the [README.md](../README.md) for common questions
2. Search [GitHub Issues](https://github.com/YOUR_USERNAME/pi-extensions/issues)
3. Create a new issue with detailed information

Happy coding! 🚀
