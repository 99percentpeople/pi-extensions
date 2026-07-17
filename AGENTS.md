# AGENTS.md

This file provides configuration and context for AI coding agents working with this repository.

## Project Overview

This is a Pi extensions repository containing custom TypeScript extensions for the Pi coding agent. Extensions enhance Pi's capabilities with new tools, commands, UI components, and integrations.

The repository uses Bun 1.3.14 for dependency management and commits `bun.lock`.

## Repository Structure

```
pi-extensions/
├── extensions/           # Independently published Pi extension packages
├── package.json          # Private Bun workspace configuration
├── tsconfig.json         # TypeScript configuration
├── README.md             # Project documentation
└── AGENTS.md             # This file
```

## Key Conventions

### Extension Structure

Each extension should:
1. Live in its own directory under `extensions/`
2. Include its own publishable `package.json`, `README.md`, and `LICENSE`
3. Export a default function that receives `ExtensionAPI`
4. Use TypeScript with proper type annotations
5. Include `promptSnippet` and `promptGuidelines` for tools
6. Provide custom rendering when appropriate

### Extension Types

- **Tools**: Register tools callable by the LLM via `pi.registerTool()`
- **Commands**: Register slash commands via `pi.registerCommand()`
- **Events**: Subscribe to lifecycle events via `pi.on()`
- **UI**: Customize TUI components and rendering

### Code Style

- Use TypeScript with strict mode
- Import types from `@earendil-works/pi-coding-agent`
- Use `typebox` for schema definitions
- Use `@earendil-works/pi-ai` for `StringEnum`
- Use `@earendil-works/pi-tui` for TUI components

### Testing

Extensions can be tested individually:
```bash
pi -e ./extensions/my-extension/index.ts
```

## Development Workflow

1. Create an extension package under `extensions/my-extension/`
2. Declare `./index.ts` under `pi.extensions` in that package's `package.json`
3. Add the package directory to the root Bun `workspaces` array
4. Test with `pi -e ./extensions/my-extension/index.ts`
5. Update README.md with documentation
6. Run `bun run check` and the package's pack dry-run

## Resources

- [Pi Extensions Documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi Examples](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions)
- [Extension API Reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#extensionapi-methods)
