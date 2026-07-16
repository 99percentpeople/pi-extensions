# @99percentpeople/pi-pwsh-adapter

Optional PowerShell 7 shell adapter for the [Pi coding agent] on Windows.

It replaces Pi's `bash` compatibility tool and user `!`/`!!` commands with `pwsh`, configures UTF-8 input/output, and adapts `@99percentpeople/pi-background-tasks` to use PowerShell when both packages are installed.

## Requirements

- Windows
- PowerShell 7 with `pwsh` available in `PATH`

## Install

```powershell
pi install npm:@99percentpeople/pi-pwsh-adapter
```

To use PowerShell with background tasks, install both independent packages:

```powershell
pi install npm:@99percentpeople/pi-background-tasks
pi install npm:@99percentpeople/pi-pwsh-adapter
```

The extension is a no-op when loaded directly on a non-Windows platform.

[Pi coding agent]: https://github.com/badlogic/pi-mono

## License

MIT
