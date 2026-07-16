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

PTY output combines stdout and stderr. `bg_logs` returns the parsed terminal buffer rather than raw control sequences.

## Native dependency

PTY support uses `node-pty`. If a compatible binary is unavailable, installation may require Python and a native C/C++ build toolchain. On macOS this generally means Xcode command-line tools; Windows builds may require Visual Studio C++ and the Windows SDK.

## License

MIT
