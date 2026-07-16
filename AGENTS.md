# AGENTS.md

This file provides configuration and context for AI coding agents working with this repository.

## Project Overview

This is a Pi extensions repository containing custom TypeScript extensions for the Pi coding agent. Extensions enhance Pi's capabilities with new tools, commands, UI components, and integrations.

The repository uses Bun 1.3.14 for dependency management and commits `bun.lock`.

## Repository Structure

```
pi-extensions/
├── extensions/           # TypeScript extensions (each in its own directory)
├── package.json          # Pi package configuration
├── tsconfig.json         # TypeScript configuration
├── README.md             # Project documentation
└── AGENTS.md             # This file
```

## Key Conventions

### Extension Structure

Each extension should:
1. Live in its own directory under `extensions/`
2. Export a default function that receives `ExtensionAPI`
3. Use TypeScript with proper type annotations
4. Include `promptSnippet` and `promptGuidelines` for tools
5. Provide custom rendering when appropriate

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

1. Create extension in `extensions/my-extension/index.ts`
2. Add to `package.json` under `pi.extensions`
3. Test with `pi -e ./extensions/my-extension/index.ts`
4. Update README.md with documentation
5. Run `bun run lint` for type checking

## Resources

- [Pi Extensions Documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi Examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions)
- [Extension API Reference](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md#extensionapi-methods)
