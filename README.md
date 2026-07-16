# Pi Extensions

A collection of custom extensions for the [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Extensions

| Extension | npm package | Description |
|-----------|-------------|-------------|
| **background-tasks** | `@99percentpeople/pi-background-tasks` | Cross-platform background tasks with PTY/TUI support |
| **pwsh-adapter** | `@99percentpeople/pi-pwsh-adapter` | Optional PowerShell 7 adapter for Windows |

## Installation

### From npm (Recommended)

```bash
# Cross-platform background task tools
pi install npm:@99percentpeople/pi-background-tasks

# Optional: Windows PowerShell 7 integration
pi install npm:@99percentpeople/pi-pwsh-adapter
```

The extensions are published independently. Installing background-tasks does
not install or enable the Windows-only PowerShell adapter.

The theme, skill, and prompt examples remain repository-local resources and
are not included in either extension package.

### From Source (For Development)

```bash
# Clone the repository
git clone https://github.com/99percentpeople/pi-extensions.git
cd pi-extensions

# Install dependencies
bun install

# Install background-tasks globally (Windows)
.\scripts\install.ps1 -Global

# Also install the optional PowerShell adapter
.\scripts\install.ps1 -Global -WithPwsh

# Install globally (Linux/macOS)
./scripts/install.sh --global

# Or install one package directly from the checkout
pi install ./extensions/background-tasks
```

### Quick Test Without Installing

```bash
# Test all extensions
.\scripts\install.ps1 -Test  # Windows
./scripts/install.sh --test   # Linux/macOS

# Test a specific extension
pi -e ./extensions/background-tasks/index.ts
```

## Verify Installation

After installing, start Pi and confirm the expected tools or commands are
available. The PowerShell adapter is inactive on non-Windows platforms.

### Example Configuration

See [examples/settings.json](examples/settings.json) for a complete configuration example.

## Extensions Reference

### background-tasks

Run long-running commands in the background with real-time monitoring.

**Tools:**
- `bg_start` - Start a background task
- `bg_wait` - Wait once for a finite task to finish or time out
- `bg_status` - Check status / list tasks
- `bg_logs` - Read stdout/stderr output or a PTY screen snapshot
- `bg_send` - Send text/keys through a compact single-string DSL, or send OS signals
- `bg_kill` - Terminate unresponsive processes

**Commands:**
- `/bg-attach <id>` - Attach to an interactive PTY or stream new pipe output; press `Ctrl+]` to detach
- `/bg-kill` - Kill a background task by ID

**Features:**
- Optional pseudoterminals for interactive commands and full-screen TUIs
- Detachable, resizable terminal sessions backed by `node-pty` and xterm headless
- Live stdout/stderr attachment for pipe tasks without replaying historical logs
- Single-string PTY input DSL with Ctrl chords, navigation keys, F1-F12, repetition, and atomic validation
- Explicit completion waits with timeout via `bg_wait` (no polling or AI follow-up notifications)
- Auto-throttle via AbortController for explicit status checks
- Latest stdout/stderr line included for pipe tasks; PTY snapshots are opt-in with `terminal_snapshot=true` and collapsed by default
- ANSI-safe `bg_logs` output, collapsed by default with dynamic standard-key expand/collapse hints
- Widget with real-time refresh (100ms)
- Extensible spawn backend via pi.events

Start an interactive task with `pty=true`, then attach from Pi:

```text
bg_start name="git-ui" command="lazygit" pty=true
/bg-attach <task-id>
```

PTY output combines stdout and stderr. For PTY tasks, `bg_logs` returns the
current terminal buffer instead of raw escape sequences. Linux installations
may need Python, `make`, and a C/C++ compiler when `node-pty` must be built from
source.

### pwsh-adapter

PowerShell 7 adapter for Windows environments.

**Features:**
- Replaces default bash tool with PowerShell 7
- Adapts background-tasks to use pwsh
- Uses interactive PowerShell mode for PTY tasks
- UTF-8 encoding support
- Process tree cleanup on Windows

## Creating Your Own Extensions Repository

Use this repository as a template to create your own Pi extensions collection:

```bash
# Clone this repository
git clone https://github.com/YOUR_USERNAME/pi-extensions.git
cd pi-extensions

# Initialize a new project (Windows)
.\scripts\init.ps1 -Name my-pi-extensions

# Initialize a new project (Linux/macOS)
./scripts/init.sh my-pi-extensions
```

This will:
1. Create a new project directory
2. Copy all template files
3. Update package.json with your project name
4. Initialize a git repository

## Development

This repository uses Bun 1.3.14 for dependency management. Run `bun install`
after cloning and commit `bun.lock` whenever dependencies change.

### Project Structure

```
pi-extensions/
├── extensions/           # TypeScript extensions
│   ├── background-tasks/
│   │   ├── package.json  # Independently published npm package
│   │   ├── README.md
│   │   └── index.ts
│   └── pwsh-adapter/
│       ├── package.json  # Independently published npm package
│       ├── README.md
│       └── index.ts
├── themes/               # Color themes
│   └── midnight.json
├── skills/               # Markdown skills
│   └── git-workflow/
│       └── SKILL.md
├── prompts/              # Prompt templates
│   └── code-review.md
├── package.json          # Private Bun workspace configuration
├── tsconfig.json         # TypeScript configuration
├── README.md             # This file
├── AGENTS.md             # AI agent configuration
├── CHANGELOG.md          # Version history
├── CONTRIBUTING.md       # Contribution guidelines
├── LICENSE               # MIT License
└── .gitignore            # Git ignore rules
```

### Adding New Extensions

1. Create a new package directory under `extensions/`:
   ```
   extensions/
   └── my-extension/
       ├── index.ts
       ├── package.json
       ├── README.md
       └── LICENSE
   ```

2. Implement the extension following the [Pi Extensions Guide](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)

3. Declare the extension in its own `extensions/my-extension/package.json`:
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

4. Add the package path to the root `workspaces` array and update this README.

### Testing

```bash
# Type checking
bun run lint

# Test specific extension
pi -e ./extensions/my-extension/index.ts

# Or use Makefile (Linux/macOS)
make test
make test-ext EXT=background-tasks
```

## Uninstall

```bash
pi remove npm:@99percentpeople/pi-background-tasks
pi remove npm:@99percentpeople/pi-pwsh-adapter
```

## Publishing

### To npm

Each extension is versioned and published from its own directory. The root
workspace is private and cannot be published accidentally.

```bash
# Validate every package
bun run pack:check

# Publish background-tasks
cd extensions/background-tasks
bun publish --access public

# Publish the Windows adapter separately
cd ../pwsh-adapter
bun publish --access public
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Documentation

- [Getting Started Guide](docs/getting-started.md) - How to create and use extensions
- [Project Overview](PROJECT_OVERVIEW.md) - Detailed project structure
- [Changelog](CHANGELOG.md) - Version history

## License

MIT
