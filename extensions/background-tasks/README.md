# @99percentpeople/pi-background-tasks

Run long-lived commands alongside the [Pi coding agent](https://pi.dev/) without
blocking the current conversation. The extension supports ordinary background
processes as well as full PTY-backed terminal applications, with live status,
retained output, interactive attach, and completion-aware cleanup.

## Features

- Run builds, servers, watchers, tests, and terminal applications in the background
- Choose lightweight `pipe` mode or a real pseudo-terminal with `pty` mode
- Keep consuming and retaining output even when no user is attached
- Attach without pausing or redirecting the child process
- Replay earlier output before switching seamlessly to live output
- Interact with PTY applications using keyboard, mouse, focus, and resize events
- Inspect separate stdout/stderr logs for pipe tasks or a parsed terminal screen for PTY tasks
- Wait explicitly for task completion without repeated polling
- Keep final output available long enough for both the user and model to inspect it
- Track task status, duration, and recent output in a compact expandable widget
- Send text, terminal keys, stdin data, and process signals to running tasks
- Use the same shell resolution and command syntax as Pi's built-in `bash` tool

## Install

```bash
pi install npm:@99percentpeople/pi-background-tasks
```

During local development:

```bash
pi -e ./extensions/background-tasks/index.ts
```

## Typical workflow

Ask Pi to start a command in the background, then continue working while it
runs. For example:

```text
Run the development server in the background and tell me when it is ready.
Start lazygit in a background PTY so I can attach to it.
Run the test suite in the background and inspect the failures when it exits.
```

The model can start, wait for, inspect, signal, and stop tasks. Users normally
only need the two interactive commands:

```text
/bg-attach <task-id>
/bg-kill <task-id>
```

Omit the task ID to choose from an interactive list. Press `Ctrl+]` to leave an
attached console without stopping its task.

## Pipe and PTY modes

| | Pipe mode | PTY mode |
| --- | --- | --- |
| Best for | Builds, servers, scripts, tests, and watchers | TUIs, REPLs, debuggers, and terminal-aware programs |
| Output model | Separate stdout and stderr logs | One terminal screen with ANSI control sequences interpreted |
| Attached view | Combined stdout/stderr in arrival order | Live virtual terminal |
| Direct attached input | Read-only; send stdin through Pi | Keyboard and mouse input are forwarded |
| Resize behavior | Local console reflow only | Debounced terminal and child-process resize |

Pipe mode is the simpler default for commands that only need reliable logs.
PTY mode sets up a real pseudo-terminal, so programs can detect terminal
capabilities, redraw their screen, request mouse tracking, and respond to window
size changes as they would in a standalone terminal.

## Live attach and final snapshots

Each task owns a virtual console from the moment it starts. Output is processed
continuously whether attached or not. When `/bg-attach` opens the console, it
first renders the retained terminal buffer and buffers only the small amount of
output arriving during that replay. The child process is never paused and its
stdout or stderr is never reconnected to the physical terminal.

For PTY applications, attach forwards keyboard input and terminal resize events.
Extended mouse encodings, including SGR and SGR pixel mode, are restored when
the application enables them. Mouse tracking, encodings, and focus modes are
reset on detach so terminal state does not leak back into Pi.

If a task exits while attached, the console stays open until `Ctrl+]`:

- pipe mode appends a completion message;
- PTY mode overlays the message in the bottom-right corner without changing the
  application's final screen.

The completion message exists only on the user's physical terminal. It is not
written into retained logs, `bg_logs`, or the final virtual-terminal snapshot.
A finished task can be attached again in read-only mode while its snapshot is
still retained.

## Status widget

Pi displays background tasks below the editor with their status, duration, and
latest output. The collapsed widget shows at most three task entries and
prioritizes running tasks. When more tasks exist, Pi's standard tool expansion
shortcut (`Ctrl+O` by default) reveals the complete list.

The header uses separate colors for the total, running, and finished counts so
active work stands out without making the whole widget look like a warning.
Running durations and recent output refresh without repeatedly registering a
new widget.

## Output retention and cleanup

When a task exits during an agent turn, its final status, duration, latest log,
and terminal snapshot remain available for the rest of that turn. A task that
was still running when the agent became idle is retained through the following
turn if it finishes while idle, giving the model a chance to inspect the result.
The snapshot is discarded at the next turn boundary after that opportunity.

Once discarded, the old task ID is no longer available through attach, status,
logs, or wait operations. Retention is intentionally short-lived and stored in
an in-memory log store; no task output is written to a temporary disk directory.
Pipe stdout and stderr are capped at 4 MiB each, with the oldest bytes discarded
when that limit is reached. This is not persistent job
management. When the Pi session shuts down, the extension detaches consoles,
terminates remaining processes, clears retained output, and disposes the
virtual terminals so it does not leave orphaned tasks.

## Sending input and keys

Pi can send ordinary text, terminal keys, or signals without opening an attached
console. Text is exact and never implies Enter. Special keys use `<...>` tokens:

```text
<C-o>filename.txt<Enter>
<Esc>iHello<Enter>
<Down*3><Enter>
```

The input syntax supports Ctrl+A-Z and Ctrl punctuation, Alt/Meta combinations,
arrows, navigation keys, Insert/Delete, F1-F12, Space, Enter, Escape, Tab, and
Backspace. Modifiers can be combined, such as `<C-A-d>` or `<S-A-Left>`, and
key repetition uses forms such as `<Down*3>`. Use `\<` for a literal `<` and
`\\` for a literal backslash.

Pipe attachments do not forward keyboard input directly, but Pi can still send
stdin through the background task interface. PTY attachments forward input
interactively and the same key syntax remains available for model-driven input.

The signal input accepts every named signal exposed by Node.js for the current
operating system and sends it to the task's process group on Unix. Signal
availability and behavior remain platform-specific; Windows processes and
Windows PTYs support a smaller set of effective signal behaviors. Use the
dedicated kill operation when the goal is reliable process-tree termination.

## Output inspection

Pipe tasks retain stdout and stderr separately for inspection, while their
attached console combines both streams in arrival order. PTY tasks expose the
parsed terminal buffer rather than raw ANSI escape sequences, which makes
full-screen application output readable to the model.

Normal status and completion checks keep PTY output compact. Pi requests a
terminal snapshot only when the current or final screen is useful; snapshots
follow the standard collapsed/expanded tool-output behavior.

## Pi capabilities

The extension exposes a compact set of model-facing operations: start, wait,
status, logs, send, and kill. They cover process launch, one-shot completion
waiting, output inspection, text/key/signal delivery, and termination. Users can
usually describe the desired outcome in natural language instead of calling
these operations manually. While a tool call is streaming, fields appear only
after the model writes them; missing arguments are omitted rather than rendered
as placeholders.

## Shell and platform behavior

Background commands follow Pi's configured Bash resolution and command prefix,
so they use the same syntax as the built-in `bash` tool. On Windows this means
Pi's configured `shellPath`, Git Bash, or a `bash.exe` found on `PATH`, rather
than `cmd.exe`.

Installing `@99percentpeople/pi-pwsh-adapter` explicitly switches both Pi's
built-in shell tool and background tasks to PowerShell syntax.

## Native dependency

PTY support uses `node-pty`. If a compatible prebuilt binary is unavailable,
installation may require Python and a native C/C++ build toolchain. On macOS
this generally means Xcode command-line tools; Windows builds may require Visual
Studio C++ and the Windows SDK. Pipe mode does not require a pseudo-terminal at
runtime, but `node-pty` is still installed as a package dependency.

## License

MIT
