# Pi Extensions Project Overview

This document provides a comprehensive overview of the Pi Extensions project structure and organization.

## Project Purpose

This repository serves as a template and collection of custom extensions for the [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). It provides:

1. **Ready-to-use extensions** for common tasks
2. **Template structure** for creating your own extensions
3. **Best practices** for extension development
4. **Tools and scripts** for development and testing

## Repository Structure

```
pi-extensions/
├── .github/                    # GitHub configuration
│   └── workflows/              # CI/CD workflows
│       └── ci.yml              # Continuous integration
├── extensions/                 # TypeScript extensions (main content)
│   ├── background-tasks/       # Background task management
│   │   └── index.ts
│   └── pwsh-adapter/           # PowerShell 7 adapter
│       └── index.ts
├── themes/                     # Color themes
│   └── midnight.json
├── skills/                     # Markdown skills
│   └── git-workflow/
│       └── SKILL.md
├── prompts/                    # Prompt templates
│   └── code-review.md
├── scripts/                    # Development scripts
│   ├── install.ps1             # Windows installation
│   ├── install.sh              # Linux/macOS installation
│   ├── init.ps1                # Windows project initialization
│   └── init.sh                 # Linux/macOS project initialization
├── examples/                   # Example configurations
│   └── settings.json
├── tests/                      # Test documentation
│   └── README.md
├── package.json                # Pi package configuration
├── tsconfig.json               # TypeScript configuration
├── README.md                   # Main documentation
├── AGENTS.md                   # AI agent configuration
├── CHANGELOG.md                # Version history
├── CONTRIBUTING.md             # Contribution guidelines
├── LICENSE                     # MIT License
└── .gitignore                  # Git ignore rules
```

## Key Components

### 1. Extensions (Core)

Each extension is a TypeScript module that extends Pi's behavior:

- **background-tasks**: Run long commands in the background
- **pwsh-adapter**: PowerShell 7 support for Windows

### 2. Themes

Color themes for Pi's TUI:

- **midnight**: Dark theme for late-night coding

### 3. Skills

Markdown-based instructions for AI agents:

- **git-workflow**: Git workflow best practices

### 4. Prompts

Prompt templates for common tasks:

- **code-review**: Code review prompt

### 5. Scripts

Development and installation scripts:

- **install.ps1/sh**: Install extensions
- **init.ps1/sh**: Initialize new project

## Development Workflow

### 1. Creating a New Extension

```bash
# Create extension directory
mkdir extensions/my-extension

# Create index.ts
touch extensions/my-extension/index.ts

# Implement extension
# (see AGENTS.md for guidelines)

# Add to package.json
# Update README.md
```

### 2. Testing Extensions

```bash
# Test single extension
pi -e ./extensions/my-extension/index.ts

# Test multiple extensions
pi -e ./extensions/background-tasks/index.ts \
   -e ./extensions/permission-gate/index.ts

# Run all tests
.\scripts\install.ps1 -Test  # Windows
./scripts/install.sh --test   # Linux/macOS
```

### 3. Publishing Extensions

```bash
# Update version
bun pm version patch

# Update CHANGELOG.md

# Publish to npm
bun publish

# Or share via GitHub
git push origin main
```

## Best Practices

### Extension Development

1. **Single Responsibility**: Each extension should do one thing well
2. **Clear Documentation**: Include README.md for complex extensions
3. **Type Safety**: Use TypeScript with strict mode
4. **Error Handling**: Gracefully handle errors
5. **User Experience**: Provide clear feedback and notifications

### Code Organization

1. **Directory Structure**: One directory per extension
2. **Entry Point**: Use `index.ts` as entry point
3. **Helper Files**: Split complex logic into separate files
4. **Shared Code**: Use `_shared/` directory for common utilities

### Documentation

1. **README.md**: Main project documentation
2. **AGENTS.md**: AI agent configuration
3. **CHANGELOG.md**: Version history
4. **CONTRIBUTING.md**: Contribution guidelines

## Customization

### Adding Your Own Extensions

1. Fork this repository
2. Create your extensions in `extensions/`
3. Update `package.json` with your extensions
4. Update `README.md` with documentation
5. Share with the community

### Modifying Existing Extensions

1. Fork the extension directory
2. Make your changes
3. Test thoroughly
4. Update documentation
5. Consider contributing back

## Resources

- [Pi Documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi Examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions)
- [Extension API Reference](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md#extensionapi-methods)
- [TypeBox Documentation](https://github.com/sinclairzx81/typebox)

## Support

For issues and questions:

1. Check the [README.md](README.md) for common solutions
2. Search existing [GitHub Issues](https://github.com/YOUR_USERNAME/pi-extensions/issues)
3. Create a new issue with detailed information

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
