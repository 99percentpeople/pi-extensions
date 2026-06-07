# Contributing to Pi Extensions

Thank you for your interest in contributing to Pi Extensions! This document provides guidelines and information for contributors.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Create a new branch for your feature or bugfix
4. Make your changes
5. Test your changes
6. Submit a pull request

## Development Setup

### Prerequisites

- Node.js 18+ or Bun
- Pi coding agent installed
- TypeScript knowledge

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/pi-extensions.git
cd pi-extensions

# Install dependencies
npm install

# Type checking
npm run lint
```

### Testing Extensions

Test extensions individually:

```bash
# Test a specific extension
pi -e ./extensions/my-extension/index.ts

# Test with multiple extensions
pi -e ./extensions/background-tasks/index.ts \
   -e ./extensions/permission-gate/index.ts
```

## Creating Extensions

### Extension Structure

Each extension should:

1. Live in its own directory under `extensions/`
2. Export a default function that receives `ExtensionAPI`
3. Use TypeScript with proper type annotations
4. Include `promptSnippet` and `promptGuidelines` for tools
5. Provide custom rendering when appropriate

### Example Extension

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

### Adding to Package

After creating your extension:

1. Add it to `package.json` under `pi.extensions`
2. Update `README.md` with documentation
3. Add to `CHANGELOG.md` under `[Unreleased]`

## Code Style

- Use TypeScript with strict mode
- Import types from `@earendil-works/pi-coding-agent`
- Use `typebox` for schema definitions
- Use `@earendil-works/pi-ai` for `StringEnum`
- Use `@earendil-works/pi-tui` for TUI components
- Follow existing code patterns in the repository

## Pull Request Process

1. Update documentation if needed
2. Add tests if applicable
3. Ensure all type checks pass
4. Update CHANGELOG.md
5. Request review from maintainers

## Reporting Issues

When reporting issues, please include:

- Pi version
- Extension version
- Steps to reproduce
- Expected behavior
- Actual behavior
- Error messages or logs

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
