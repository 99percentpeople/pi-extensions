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
without relying on Windows `PATHEXT` expansion. Foreground shell calls finalize
after the direct PowerShell child exits even when a longer-lived descendant
inherits its output handles. Timeout and cancellation paths bound the
`taskkill /T /F` wait, preserve output collected before termination, and force
stdio cleanup if Windows never reports `close`.

When SSH Remote is installed, the adapter registers a named local Background
Tasks provider below SSH's priority. Active/connecting SSH therefore owns
routing, while local SSH mode falls through automatically to PowerShell without
last-writer registration races or dependence on extension startup order.

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

Background Tasks 2.0.0 or newer requires Pwsh Adapter 1.1.0 or newer. This pair
uses named Background Control protocol-v2 providers; update the adapter before
updating Background Tasks so the older unnamed registration is not rejected.

The extension is a no-op when loaded directly on a non-Windows platform.

[Pi coding agent]: https://pi.dev/

## License

MIT
