# @99percentpeople/pi-ssh-remote

Use the local [Pi coding agent](https://pi.dev/) against a remote Unix or
Windows workspace. The extension routes Pi's built-in `read`, `write`, `edit`,
and `bash` tools plus the optional `grep`, `find`, and `ls` tools and user
`!`/`!!` commands through the system OpenSSH client while leaving the Pi UI,
model credentials, packages, and session files on the local machine.

Version 0.2.0 supports Linux, macOS, and Windows clients connected to:

- Unix hosts with Bash and the usual POSIX utilities;
- Windows OpenSSH hosts with PowerShell 7 or Windows PowerShell 5.1.

## Features

- Reuses OpenSSH aliases and the normal `~/.ssh/config` automatically
- Supports `User`, `Port`, `IdentityFile`, `ProxyJump`, `Include`, `Match`, and
  OpenSSH connection multiplexing without reimplementing SSH configuration
- Accepts rsync-style targets such as `host:/srv/project` and `user@host:path`
- Auto-detects remote Unix/Bash or Windows/PowerShell environments
- Keeps Pi's native tool schemas, truncation, diffs, rendering, and mutation
  queue behavior; `grep`, `find`, and `ls` retain Pi's default disabled state
- Streams file contents over SSH stdin/stdout instead of putting them in
  command-line arguments
- Stores the target, platform, shell, remote home, and resolved cwd in the Pi
  session
- Restores and reconnects after `/resume`, `pi -r`, `pi -c`, reload, fork, or
  clone; `/new` inherits the previous remote target
- Fails closed after a configured connection fails instead of silently writing
  to the local filesystem
- Adapts `@99percentpeople/pi-background-tasks` through its `bg:register`
  backend when that extension is installed

## Install

```bash
pi install npm:@99percentpeople/pi-ssh-remote
```

During local development:

```bash
bun run build:packages
bun run --cwd extensions/ssh-remote build
pi -e ./extensions/ssh-remote/index.ts --ssh devbox:/srv/project
```

## OpenSSH configuration

The extension invokes the system `ssh` executable (`ssh.exe` on Windows) with
its destination alias unchanged. Without `--ssh-config`, OpenSSH automatically
reads its normal user and system configuration, including `~/.ssh/config`.

On Windows, install or enable the Windows OpenSSH Client capability and ensure
`ssh.exe` is available on `PATH`. The same user SSH config and `ssh-agent`
credentials used by a manual PowerShell `ssh <host>` command are reused.

```sshconfig
Host devbox
    HostName 10.0.0.20
    User deploy
    Port 2222
    IdentityFile ~/.ssh/company
    ProxyJump bastion
    ControlMaster auto
    ControlPersist 10m
    ControlPath ~/.ssh/control-%C
```

```bash
ssh devbox
pi --ssh devbox:/srv/project
```

The extension enables `BatchMode=yes` and a ten-second connection timeout, so
password, passphrase, and new-host prompts do not corrupt the Pi TUI. Load keys
into an SSH agent and accept a new host key before starting Pi.

Use a different local config file only when needed:

```bash
pi --ssh devbox:/srv/project --ssh-config ~/.ssh/work.conf
```

Accepted target forms include:

```text
devbox
deploy@devbox:/srv/project
deploy@[2001:db8::10]:/srv/project
winbox
winuser@winbox:C:\Users\winuser\project
```

With no path, the remote login working directory is used. This is normally the
remote home directory. Relative paths are resolved from that directory.

## Remote shell selection

The default is automatic detection:

```bash
pi --ssh devbox --ssh-shell auto
```

Detection tries Unix Bash, PowerShell 7, then Windows PowerShell 5.1. Override
it when a host exposes more than one environment:

```bash
pi --ssh devbox --ssh-shell bash
pi --ssh winbox --ssh-shell pwsh
pi --ssh winbox --ssh-shell powershell
```

`cmd.exe` by itself is not supported. On Windows, the extension starts
PowerShell through `-NoProfile -NonInteractive -EncodedCommand`, so it works
even when Windows OpenSSH's DefaultShell is `cmd.exe`. Control scripts are
encoded, while file data is still transferred as binary stdin/stdout.

## Unix workspaces

Unix paths use POSIX syntax:

```bash
pi --ssh devbox:~/project
pi --ssh devbox:/srv/project
```

The `bash` tool and user `!` commands execute Bash syntax.

## Windows workspaces

Windows paths support drive-qualified and UNC forms:

```bash
pi --ssh 'winbox:C:\Users\developer\project'
pi --ssh 'winbox:D:\source'
pi --ssh 'winbox:\\server\share\project'
```

Relative paths, `~`, `~/path`, and `~\path` are resolved against the remote
Windows user profile and working directory. Drive-relative paths such as
`C:folder` and `~other` paths are rejected because their meaning is ambiguous.

The tool remains named `bash` for Pi compatibility, but its prompt and session
context tell the model to use PowerShell syntax. User `!`/`!!` commands use the
same remote PowerShell runtime.

## Session resume

Pi conversations remain in the local Pi session directory. The extension adds
a hidden, branch-aware entry containing only:

- the SSH destination or alias;
- the detected remote platform and shell;
- the resolved remote cwd and home;
- the optional local OpenSSH config path.

It never copies private keys, passwords, SSH config contents, or remote file
contents into this state. Version 1 Unix session entries are migrated in memory
to Unix/Bash version 2 state, so existing conversations continue to resume.

A resumed session reconnects its stored target even when Pi was started without
`--ssh`. Passing a different target, config, cwd, or explicit shell while
resuming is rejected to prevent an old conversation from modifying another
machine.

Pi groups sessions by its local cwd. Start each remote project from a stable
local anchor directory and name important sessions. In `/resume`, press Tab to
switch from **Current Folder** to **All**.

Conversation history is restored, but the extension does not snapshot remote
files or revive running processes. Remote repository contents may have changed
between sessions.

## Commands

```text
/ssh-status      Show target, platform, shell, remote cwd/home, and config source
/ssh-reconnect   Retry the target stored in the current session
```

These commands are registered only when the current session requests, resumes,
or inherits an SSH workspace, so ordinary local sessions do not show them.

The status line reports only connection state: `SSH:` is muted, while
`Connecting`, `Connected`, or `Disconnected` uses the matching warning,
success, or error color. It does not repeat the remote path.

When the session has no custom name, SSH Remote uses Pi's session name to show
the location in both the normal first footer line and the native `/resume`
list. It queries the current remote Git branch after a successful connection
and appends the first user message when it arrives, producing a line such as:

```text
~ • SSH devbox:C:\Users\dev\Desktop\pi-extensions (master) • Fix the build
```

The first message is normalized to one line, matching the information Pi uses
for ordinary unnamed sessions. The SSH location stays first as a stable remote
identifier; on narrow terminals Pi may truncate the message suffix. This single
session name preserves Pi's built-in footer, token/model statistics, and other
extension statuses without installing a custom footer or widget. A
user-assigned `/name` remains untouched. Temporary `[host:path] title` names
created by the prefix experiment are migrated back to the automatic
`SSH target:path (branch) • first message` format when that workspace
reconnects.

If connection setup fails, overridden tools report the SSH failure and do not
fall back to local operations.

## Shared workspace files

SSH Remote registers its active binary file backend through
`@99percentpeople/pi-workspace-files`. Tools using that shared package follow
the same remote adapter path as Pi's routed `read` and `write` tools instead of
adding tool-specific SSH hooks.

`@99percentpeople/pi-codex-api` uses this backend automatically:

- `output_path` is resolved against the remote workspace. The Base64 PNG from
  the image API is decoded and written directly through the active SSH adapter,
  then reported using its native Unix or Windows path.
- `referenced_image_paths` are read directly through the same remote adapter and
  converted to data URLs for the image API request.
- No generated image or reference image is staged in Pi's local workspace, and
  no reverse SSH or separate `scp` step is required.
- The default destination remains `output/codex-images/<tool-call>.png`, but it
  is created remotely.
- Existing remote files are never overwritten. Paths outside the remote
  workspace are rejected, matching `codex_image`'s normal workspace boundary.

For example, a Windows SSH session can use:

```text
output_path: C:\Users\dev\Desktop\wallpaper.png
referenced_image_paths: [C:\Users\dev\Desktop\reference.jpg]
```

## Background tasks

When `@99percentpeople/pi-background-tasks` is installed, SSH Remote registers a
remote shell backend for both pipe and PTY jobs. Background Tasks 1.2.7 or newer
also honors the adapter's local launch cwd, allowing `bg_start.cwd` to name a
remote-only Unix or Windows directory.

Running jobs are still owned by the current Pi process. Session replacement or
shutdown terminates the local SSH process and does not attempt to reattach the
job after resume.

## Compatibility and limitations

- `todo`, `thinking-fold`, `cursor-effect`, and `codex_search` remain local and
  work normally.
- On Windows clients, local sessions are left untouched so
  `pi-pwsh-adapter` can continue to own the local `bash` tool. SSH Remote
  registers its tool overrides only for sessions that request, resume, or
  inherit an SSH workspace.
- A failed remote connection (unreachable host, missing remote directory, or
  no supported remote shell) reports the error and leaves the session in a
  `Disconnected` state: tools fail closed with the probe error, while
  `/ssh-status` and `/ssh-reconnect` stay available for recovery.
- Background tasks follow the same rule: while the SSH workspace is
  unavailable, `bg_start` is blocked with the probe error instead of silently
  running on the local machine (the shared background-task backend can be
  claimed by other adapters such as `pi-pwsh-adapter`, so the block is applied
  at the tool level to stay independent of registration order).
- On Windows, `pi-pwsh-adapter` registers the `bash` tool before this
  extension (Pi keeps the first registration per tool name). SSH Remote
  claims the bash tool through the `bash:delegate` event protocol instead:
  the adapter's bash tool and `!` commands execute on the remote while the
  SSH workspace is active, fail closed while it is unavailable, and fall back
  to the local PowerShell backend in local sessions. Both packages must be at
  compatible versions for the delegation to work.
- Pi's optional standalone `grep`, `find`, and `ls` tools remain disabled by
  default. If enabled through `--tools` or the tool selector, they execute on
  the remote workspace and fail closed with the other routed tools.
- Unix `find` uses remote `rg` when available so `.gitignore` is honored; its
  POSIX fallback and the native Windows implementation always exclude `.git`
  and `node_modules` but do not parse every `.gitignore` rule.
- Remote project discovery is not virtualized. Local `AGENTS.md`, `.pi`, skills,
  and project settings still come from Pi's local anchor directory.
- `read` downloads a complete remote file before applying Pi's line and byte
  truncation. Avoid using it on very large files; use the remote shell to select
  a range.
- `edit` serializes mutations inside the current Pi process, but cannot prevent
  another process on the remote host from changing a file between read and
  write steps.
- Remote shell commands export safe Pi model/session identifiers but do not
  export `PI_SESSION_FILE`, because that path exists only on the local host.

## Security

The package executes the system `ssh` binary and remote shell commands with the
same account permissions as a manual SSH login. File paths are embedded only in
encoded control scripts or shell-quoted Unix commands, and file contents travel
through stdin/stdout. Model-provided shell commands are intentionally executable
code. Review the package and use a restricted remote account when appropriate.

## License

MIT
