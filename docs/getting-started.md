# Getting Started with Pi Extensions

This guide will help you get started with creating and using Pi extensions.

## Prerequisites

Before you begin, make sure you have:

1. [Pi coding agent](https://github.com/badlogic/pi-mono) installed
2. [Node.js](https://nodejs.org/) 18+ or [Bun](https://bun.sh/)
3. Basic TypeScript knowledge
4. A code editor (VS Code recommended)

## Installation

### Option 1: Install from npm (Recommended)

```bash
pi install npm:pi-extensions
```

### Option 2: Install from source

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/pi-extensions.git
cd pi-extensions

# Install globally
pi install .

# Or install to a specific project
cd ~/your-project
pi install -l /path/to/pi-extensions
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
bg_start name="build" command="npm run build"

# Check status
bg_status id="abcd"

# Read logs
bg_logs id="abcd" tail=50

# Send input
bg_send id="abcd" text="y"

# Stop task
bg_stop id="abcd" force=true
```

### Permission Gate

Automatically blocks dangerous commands:

```bash
# This will be blocked and require confirmation
rm -rf /tmp/test

# View blocked commands
/blocked

# Clear history
/blocked-clear
```

### Status Line

Displays useful information in the footer:

- Current directory
- Git branch and status
- Model information
- Session duration
- Context usage

### Session Name

Automatically names sessions:

```bash
# Sessions are automatically named based on first message
# You can also manually set a name
/name My Project Session

# Clear name
/name-clear
```

### Weather

Get weather information:

```bash
# Ask for weather
What's the weather in New York?

# Use the command
/weather London
```

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

### Step 4: Add to package.json

```json
{
  "pi": {
    "extensions": [
      "./extensions/background-tasks/index.ts",
      "./extensions/my-extension/index.ts"
    ]
  }
}
```

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

1. Check for TypeScript errors: `npm run lint`
2. Verify the extension path in `package.json`
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
