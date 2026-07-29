# @99percentpeople/pi-pwsh-adapter

PowerShell shell adapter for the [Pi coding agent] on Windows.

It replaces Pi's `bash` compatibility tool and user `!`/`!!` commands with
PowerShell, configures UTF-8 input/output, and adapts
`@99percentpeople/pi-background-tasks` to use the same runtime when both
packages are installed.

At startup it selects PowerShell once for the whole session:

1. PowerShell 7 or newer through `pwsh.exe` when available.
2. Otherwise Windows PowerShell 5.1 through `powershell.exe`.

The selected executable is explicit, so both pipe and PTY background tasks work
without relying on Windows `PATHEXT` expansion.

## Requirements

- Windows
- PowerShell 7 in `PATH`, or Windows PowerShell 5.1

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

[Pi coding agent]: https://pi.dev/

## Shared settings

Installing this plugin participates in the shared `/99settings` infrastructure,
but PowerShell Adapter is omitted from the menu while it has no configurable
values.

## License

MIT
