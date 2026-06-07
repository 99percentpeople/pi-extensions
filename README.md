# Pi Extensions

A collection of custom extensions for the [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Extensions

| Extension | Type | Description |
|-----------|------|-------------|
| **background-tasks** | Tool | Run long commands in the background with real-time monitoring |
| **pwsh-adapter** | Tool | PowerShell 7 adapter for Windows environments |
| **permission-gate** | Tool | Block dangerous commands and require user confirmation |
| **status-line** | UI | Display useful status information in the footer |
| **session-name** | Command | Automatically name sessions based on first message |
| **weather** | Tool | Get weather information for any city |

## Installation

### From npm (Recommended)

```bash
pi install npm:pi-extensions
```

### From Source (For Development)

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/pi-extensions.git
cd pi-extensions

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
- `bg_status` - Check status / list tasks
- `bg_logs` - Read stdout/stderr output
- `bg_send` - Interact via stdin (text, control chars)
- `bg_stop` - Force kill unresponsive processes

**Commands:**
- `/kill` - Kill a background task by ID

**Features:**
- Auto-throttle via AbortController
- Widget with real-time refresh (100ms)
- Extensible spawn backend via pi.events

### pwsh-adapter

PowerShell 7 adapter for Windows environments.

**Features:**
- Replaces default bash tool with PowerShell 7
- Adapts background-tasks to use pwsh
- UTF-8 encoding support
- Process tree cleanup on Windows

### permission-gate

Blocks dangerous commands and requires user confirmation.

**Features:**
- Blocks dangerous bash commands (rm -rf, sudo, git push --force, etc.)
- Configurable blocked patterns
- User confirmation dialog with 30-second timeout
- Command history tracking

**Commands:**
- `/blocked` - Show history of blocked commands
- `/blocked-clear` - Clear blocked commands history

### status-line

Displays useful status information in the footer.

**Features:**
- Current working directory (truncated)
- Git branch and status (dirty, ahead/behind)
- Model information
- Session duration
- Context token usage

**Commands:**
- `/status` - Refresh status line

### session-name

Automatically names sessions based on the first user message.

**Features:**
- Auto-generate session names from first message
- Manual session naming via /name command
- Configurable name length
- Smart prefix removal

**Commands:**
- `/name` - Set or change session name
- `/name-clear` - Clear session name

### weather

Get weather information for any city.

**Features:**
- Get current weather for any city
- Temperature in Celsius/Fahrenheit
- Weather conditions and humidity
- Wind speed and direction
- Custom rendering with weather icons

**Tools:**
- `weather` - Get weather information for a location

**Commands:**
- `/weather` - Quick weather lookup

**Available Locations:**
- New York
- London
- Tokyo
- Paris

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

### Project Structure

```
pi-extensions/
├── extensions/           # TypeScript extensions
│   ├── background-tasks/
│   │   └── index.ts
│   ├── pwsh-adapter/
│   │   └── index.ts
│   ├── permission-gate/
│   │   └── index.ts
│   ├── status-line/
│   │   └── index.ts
│   ├── session-name/
│   │   └── index.ts
│   └── weather/
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
npm run lint

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
npm publish
```

### To GitHub

1. Push to GitHub
2. Users can install with:

```bash
pi install git:github.com/YOUR_USERNAME/pi-extensions
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Documentation

- [Getting Started Guide](docs/getting-started.md) - How to create and use extensions
- [Project Overview](PROJECT_OVERVIEW.md) - Detailed project structure
- [Changelog](CHANGELOG.md) - Version history

## License

MIT
