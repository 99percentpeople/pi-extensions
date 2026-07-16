# @99percentpeople/pi-background-tasks

Background task tools for the [Pi coding agent](https://github.com/badlogic/pi-mono), including explicit completion waits, log inspection, process signals, and optional PTY-backed TUI interaction.

## Install

```bash
pi install npm:@99percentpeople/pi-background-tasks
```

## Tools and commands

- `bg_start` starts pipe or PTY-backed tasks.
- `bg_wait` waits once for completion or timeout without polling.
- `bg_status` inspects task state.
- `bg_logs` reads pipe output or a parsed terminal snapshot.
- `bg_send` sends text, terminal control keys, or process signals.
- `bg_kill` terminates a task.
- `/bg-attach <id>` attaches to a PTY task; press `Ctrl+]` to detach.
- `/kill` terminates a task by ID.

Start and attach to a TUI:

```text
bg_start name="git-ui" command="lazygit" pty=true
/bg-attach <task-id>
```

Send exact text and terminal keys:

```text
bg_send id="<task-id>" key="ctrl+o"
bg_send id="<task-id>" key="f10"
bg_send id="<task-id>" text="filename.txt" enter=true
bg_send id="<task-id>" sequence=[{"key":"escape"},{"text":"iHello"},{"key":"enter"}]
```

`key` supports Ctrl+A–Z, Ctrl punctuation combinations, arrows, Home/End,
PageUp/PageDown, Insert/Delete, F1–F12, Enter, Escape, Tab, and Backspace.
Plain `text` is exact and never presses Enter unless `enter=true`; `sequence`
can interleave text and named keys without implicit input.

PTY output combines stdout and stderr. `bg_logs` returns the parsed terminal buffer rather than raw control sequences.
`bg_wait`, `bg_status`, and `bg_kill` omit PTY screen output by default; pass
`terminal_snapshot=true` when the current or final terminal screen is needed in the same result.
Snapshots are collapsed in Pi's TUI by default and can be expanded with the standard tool
expand key. Pipe tasks continue to include their ordinary latest stdout/stderr log line.

## Native dependency

PTY support uses `node-pty`. If a compatible binary is unavailable, installation may require Python and a native C/C++ build toolchain. On macOS this generally means Xcode command-line tools; Windows builds may require Visual Studio C++ and the Windows SDK.

## License

MIT
