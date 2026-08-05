# @99percentpeople/pi-pwsh-adapter

PowerShell shell adapter for the [Pi coding agent] on Windows.

Make Pi speak PowerShell instead of bash: `!`/`!!` commands and the built-in
shell tool run through PowerShell 7 (or Windows PowerShell 5.1), with UTF-8
input/output configured automatically.

It replaces Pi's `bash` compatibility tool and user `!`/`!!` commands with
PowerShell, configures UTF-8 input/output, and adapts
`@99percentpeople/pi-background-tasks` to use the same runtime when both
packages are installed. The compatibility tool reuses Pi's built-in bash tool
definition, preserving its optional timeout, streaming updates, output
truncation, full-output files, elapsed-time display, and error formatting.

At startup it selects PowerShell once for the whole session:

1. PowerShell 7 or newer through `pwsh.exe` when available.
2. Otherwise Windows PowerShell 5.1 through `powershell.exe`.

The selected executable is explicit, so both pipe and PTY background tasks work
without relying on Windows `PATHEXT` expansion. When SSH Remote is installed,
the adapter yields the background backend from the beginning of an SSH
connection attempt through its successful exit, independent of extension
startup order. It then restores the local PowerShell backend for later tasks.

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

## License

MIT
