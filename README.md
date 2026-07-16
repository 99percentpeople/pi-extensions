# Pi Extensions

A collection of custom extensions for the [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Extensions

| Extension | Type | Description |
|-----------|------|-------------|
| **background-tasks** | Tool | Run long commands in the background with real-time monitoring |
| **pwsh-adapter** | Tool | PowerShell 7 adapter for Windows environments |

## Installation

### From npm (Recommended)

```bash
pi install npm:@99percentpeople/pi-extensions
```

### From Source (For Development)

```bash
# Clone the repository
git clone https://github.com/99percentpeople/pi-extensions.git
cd pi-extensions

# Install dependencies
bun install

# Install globally (Windows)
.\scripts\install.ps1 -Global

# Install globally (Linux/macOS)
./scripts/install.sh --global

# Or install manually
pi install .
```

### Quick Test Without Installing

```bash
# Test all extensions
.\scripts\install.ps1 -Test  # Windows
./scripts/install.sh --test   # Linux/macOS

# Test specific extension
pi -e ./extensions/background-tasks/index.ts \
   -e ./extensions/pwsh-adapter/index.ts
```

## Verify Installation

After installing, start pi and look for the startup message:

```
Extensions: background-tasks, pwsh-adapter, permission-gate, status-line, session-name
```

### Example Configuration

See [examples/settings.json](examples/settings.json) for a complete configuration example.

## Extensions Reference

### background-tasks

Run long-running commands in the background with real-time monitoring.

**Tools:**
- `bg_start` - Start a background task
- `bg_wait` - Wait once for a finite task to finish or time out
- `bg_status` - Check status / list tasks
- `bg_logs` - Read stdout/stderr output
- `bg_send` - Send stdin input or OS control signals
- `bg_kill` - Terminate unresponsive processes

**Commands:**
- `/kill` - Kill a background task by ID

**Features:**
- Explicit completion waits with timeout via `bg_wait` (no polling or AI follow-up notifications)
- Auto-throttle via AbortController for explicit status checks
- Latest stdout/stderr log line included in `bg_status`
- ANSI-safe `bg_logs` output, collapsed by default with dynamic standard-key expand/collapse hints
- Widget with real-time refresh (100ms)
- Extensible spawn backend via pi.events

### pwsh-adapter

PowerShell 7 adapter for Windows environments.

**Features:**
- Replaces default bash tool with PowerShell 7
- Adapts background-tasks to use pwsh
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
│   │   └── index.ts
│   └── pwsh-adapter/
│       └── index.ts
├── themes/               # Color themes
│   └── midnight.json
├── skills/               # Markdown skills
│   └── git-workflow/
│       └── SKILL.md
├── prompts/              # Prompt templates
│   └── code-review.md
├── package.json          # Pi package configuration
├── tsconfig.json         # TypeScript configuration
├── README.md             # This file
├── AGENTS.md             # AI agent configuration
├── CHANGELOG.md          # Version history
├── CONTRIBUTING.md       # Contribution guidelines
├── LICENSE               # MIT License
└── .gitignore            # Git ignore rules
```

### Adding New Extensions

1. Create a new directory under `extensions/`:
   ```
   extensions/
   └── my-extension/
       └── index.ts
   ```

2. Implement the extension following the [Pi Extensions Guide](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)

3. Add the extension to `package.json` under `pi.extensions`:
   ```json
   {
     "pi": {
       "extensions": [
         "./extensions/background-tasks/index.ts",
         "./extensions/pwsh-adapter/index.ts",
         "./extensions/my-extension/index.ts"
       ]
     }
   }
   ```

4. Update this README with extension documentation

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
pi remove pi-extensions
```

## Publishing

### To npm

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Create a git tag
4. Publish to npm:

```bash
bun publish --access public
```

### To GitHub

1. Push to GitHub
2. Users can install with:

```bash
pi install git:github.com/99percentpeople/pi-extensions
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Documentation

- [Getting Started Guide](docs/getting-started.md) - How to create and use extensions
- [Project Overview](PROJECT_OVERVIEW.md) - Detailed project structure
- [Changelog](CHANGELOG.md) - Version history

## License

MIT
