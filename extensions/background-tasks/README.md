# @99percentpeople/pi-background-tasks

Background task tools for the [Pi coding agent](https://pi.dev/), including explicit completion waits, log inspection, process signals, and optional PTY-backed TUI interaction.

## Install

```bash
pi install npm:@99percentpeople/pi-background-tasks
```

## Tools and commands

- `bg_start` starts pipe or PTY-backed tasks.
- `bg_wait` waits once for completion or timeout without polling.
- `bg_status` inspects task state.
- `bg_logs` reads pipe output or a parsed terminal snapshot.
- `bg_send` sends a compact text/key input string or an OS process signal.
- `bg_kill` terminates a task.
- `/bg-attach <id>` attaches to an interactive PTY or streams new pipe output; press `Ctrl+]` to detach.
- `/bg-kill` terminates a task by ID.

Start and attach to a TUI:

```text
bg_start name="git-ui" command="lazygit" pty=true
/bg-attach <task-id>
```

For pipe tasks, `/bg-attach` streams new stdout and stderr directly until detach.
It does not replay historical logs or forward keyboard input; use `bg_logs` for
history and `bg_send` for stdin.

Send text and terminal keys with one input string:

```text
bg_send id="<task-id>" input="<C-o>filename.txt<Enter>"
bg_send id="<task-id>" input="<F10>"
bg_send id="<task-id>" input="<Esc>iHello<Enter>"
bg_send id="<task-id>" input="<Down*3><Enter>"
bg_send id="<task-id>" input="<A-f><A-f><Space>"
bg_send id="<task-id>" input="<C-d>"
```

The input DSL supports Ctrl+A–Z, Ctrl punctuation combinations, Alt/Meta combinations,
arrows, Home/End, PageUp/PageDown, Insert/Delete, F1–F12, Space, Enter, Escape,
Tab, and Backspace. Alt/Meta accepts `<A-f>`, `<Alt-f>`, `<M-f>`, and `<Meta-f>`
spellings and can also modify common navigation and function keys. Modifiers can be
combined, for example `<C-A-d>` or `<S-A-Left>`.
Plain characters are exact and never imply Enter. Terminal keys use `<...>` tokens;
for example, Ctrl+D is `<C-d>`. Use `\<` for a literal `<` and `\\` for a literal
backslash. Common Ctrl spellings are accepted inside key tokens.

PTY output combines stdout and stderr. `bg_logs` returns the parsed terminal buffer rather than raw control sequences.
`bg_wait`, `bg_status`, and `bg_kill` omit PTY screen output by default; pass
`terminal_snapshot=true` when the current or final terminal screen is needed in the same result.
Snapshots are collapsed in Pi's TUI by default and can be expanded with the standard tool
expand key. Pipe tasks continue to include their ordinary latest stdout/stderr log line.

`bg_start` follows Pi's configured Bash resolution and command prefix, so commands use the
same syntax as Pi's built-in `bash` tool. On Windows this means `shellPath`, Git Bash, or a
`bash.exe` found on `PATH`, rather than `cmd.exe`. Installing
`@99percentpeople/pi-pwsh-adapter` explicitly
switches both tools to PowerShell syntax.

## Native dependency

PTY support uses `node-pty`. If a compatible binary is unavailable, installation may require Python and a native C/C++ build toolchain. On macOS this generally means Xcode command-line tools; Windows builds may require Visual Studio C++ and the Windows SDK.

## License

MIT
