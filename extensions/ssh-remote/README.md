# @99percentpeople/pi-ssh-remote

Use the local [Pi coding agent](https://pi.dev/) against a remote Unix or
Windows workspace without leaving the current Pi conversation.

SSH Remote routes Pi's project-facing tools through SSH while keeping the TUI,
model credentials, installed packages, session files, and conversation history
on the local machine.

- **Local clients:** Linux, macOS, and Windows
- **Remote Unix hosts:** POSIX `sh`, including Bash, Zsh, ash, and BusyBox
- **Remote Windows hosts:** PowerShell 7 or Windows PowerShell 5.1 over OpenSSH

## Highlights

- Routes `read`, `write`, `edit`, `bash`, optional `grep`/`find`/`ls`, and user
  `!`/`!!` commands to the remote workspace
- Switches the same Pi session between local and SSH workspaces, or directly
  between SSH hosts
- Supports `auto`, `openssh`, and `ssh2` transports
- Reuses authenticated connections by default: OpenSSH multiplexing on
  Linux/macOS and a persistent `ssh2` connection on Windows
- Uses normal OpenSSH aliases and configuration, including multi-hop
  `ProxyJump`
- Detects Unix and Windows shells automatically, with an explicit shell option
  when needed
- Restores branch-aware SSH state across resume, reload, fork, clone, and
  `/tree`
- Fails closed when an SSH workspace is unavailable instead of silently using
  local files
- Combines with
  [`@99percentpeople/pi-background-tasks`](https://www.npmjs.com/package/@99percentpeople/pi-background-tasks)
  to run and attach to remote PTY/TUI applications such as `lazygit`, `htop`,
  `nvim`, and `k9s`
- Integrates with `@99percentpeople/pi-workspace-files`,
  `@99percentpeople/pi-codex-api`, and `@99percentpeople/pi-pwsh-adapter`

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Targets and paths](#targets-and-paths)
- [Configuration](#configuration)
- [SSH transports](#ssh-transports)
- [Authentication](#authentication)
- [Remote platform and shell](#remote-platform-and-shell)
- [Workspace and session lifecycle](#workspace-and-session-lifecycle)
- [AI control tools](#ai-control-tools)
- [Tool routing and integrations](#tool-routing-and-integrations)
- [Compatibility and limitations](#compatibility-and-limitations)
- [Security](#security)

## Install

```bash
pi install npm:@99percentpeople/pi-ssh-remote
```

The system OpenSSH client (`ssh` or `ssh.exe`) must be available on `PATH`.
SSH Remote uses it directly in OpenSSH mode, for `ssh -G` configuration
resolution in `ssh2` mode, and for remote background jobs.

> **Bun on Windows:** `bun add` or `bun install` may report
> `Blocked N postinstalls` and skip the native crypto build used by `ssh2`.
> This can make persistent `ssh2` connections hang during setup. Run
> `bun pm untrusted` to allow the scripts, or install with `npm i`, before using
> `ssh2` mode.

## Quick start

```bash
# Unix workspace
pi --ssh devbox:/srv/project

# Windows workspace (quote the target in your shell)
pi --ssh 'winuser@winbox:C:\Users\winuser\project'
```

The default transport is `auto`:

- Linux/macOS clients start with multiplexed OpenSSH.
- Windows clients start with a persistent `ssh2` connection.

Useful commands inside Pi:

```text
/ssh-status                         Show the current local or SSH environment
/ssh-cd /srv/another-project        Change the remote cwd without reconnecting
/ssh-connect staging:/srv/project   Enter SSH or switch directly to another host
/ssh-reconnect                      Reconnect or apply a transport change
/ssh-exit                           Return this conversation to its local workspace
```

### Remote background TUIs

Install Background Tasks 2.0.0 or newer alongside SSH Remote 0.5.0 or newer:

```bash
pi install npm:@99percentpeople/pi-background-tasks
```

These versions share Background Control protocol v2. Older Background Tasks
builds are blocked for active SSH workspaces rather than risking local fallback;
Background Tasks 2.x likewise rejects older unnamed SSH providers. Update both
packages together.

While the SSH workspace is active, ask Pi to *"start lazygit in a background
PTY named remote-git"*, then run `/bg-attach` and select it from the task list
(or pass the generated task ID):

```text
/bg-attach <task-id>
```

Keyboard, mouse, resize, signals, retained terminal state, and cleanup are
routed to the original remote host. `Ctrl+]` detaches while the TUI keeps
running. See the
[Background Tasks remote TUI guide](https://github.com/99percentpeople/pi-extensions/tree/master/extensions/background-tasks#run-a-remote-tui-over-ssh)
for requirements and more examples.

A typical OpenSSH alias works with either transport:

```sshconfig
Host devbox
    HostName 192.0.2.20
    User deploy
    IdentityFile ~/.ssh/company
    ProxyJump bastion
```

```bash
pi --ssh devbox:/srv/project
```

## Targets and paths

SSH Remote accepts rsync-style locations:

```text
devbox
deploy@devbox:/srv/project
deploy@[2001:db8::10]:/srv/project
winbox
winuser@winbox:C:\Users\winuser\project
```

IPv6 literals must use brackets. With no path, the remote login working
directory is used, normally the remote home directory. A relative startup path
is resolved from that directory.

### Unix paths

```bash
pi --ssh devbox:~/project
pi --ssh devbox:/srv/project
```

Unix paths use POSIX syntax. `~` and `~/path` resolve from the remote home.
`~other` paths are not supported.

### Windows paths

```bash
pi --ssh 'winbox:C:\Users\developer\project'
pi --ssh 'winbox:D:\source'
pi --ssh 'winbox:\\server\share\project'
```

Windows paths may be drive-qualified or UNC paths. Relative paths, `~`,
`~/path`, and `~\path` resolve against the remote user profile and cwd.
Drive-relative paths such as `C:folder` and `~other` paths are rejected because
their meaning is ambiguous.

`/ssh-cd` and `ssh_cd` always interpret their argument in the **remote**
filesystem:

- absolute paths remain remote absolute paths;
- relative paths resolve from the current remote cwd.

## Configuration

### Command-line flags

| Flag | Values | Purpose |
| --- | --- | --- |
| `--ssh` | `host` or `host:path` | Start or resume in an SSH workspace |
| `--ssh-config` | local path | Use an alternate local OpenSSH config |
| `--ssh-shell` | `auto`, `bash`, `zsh`, `pwsh`, `powershell` | Select the remote shell |
| `--ssh-transport` | `auto`, `openssh`, `ssh2` | Override the saved transport preference |

Examples:

```bash
pi --ssh devbox:/srv/project --ssh-transport openssh
pi --ssh devbox:/srv/project --ssh-shell zsh
pi --ssh devbox:/srv/project --ssh-config ~/.ssh/work.conf
```

### `/99settings`

Open **SSH Remote** in `/99settings`:

| Setting | Default | Behavior |
| --- | --- | --- |
| **Transport** | `Auto` | Chooses `auto`, `openssh`, or `ssh2`; reconnect to apply it to an active workspace |
| **Password prompt** | On | Allows TUI password prompts when key/agent authentication fails |
| **Persist passwords** | On | Saves entered passwords for later reconnects and `-r` resumes |
| **AI control tools** | Off | Exposes SSH environment controls to the model |
| **AI password auth** | On | Allows model-triggered connections to use or request a password |

A command-line transport overrides the saved setting. Changing **AI control
tools**, **AI password auth**, or password persistence takes effect immediately;
a transport change applies on the next connection or `/ssh-reconnect`.

## SSH transports

| Local platform | `auto` foreground transport | Connection reuse |
| --- | --- | --- |
| Linux / macOS | OpenSSH | Managed `ControlMaster` and `ControlPersist` |
| Windows | `ssh2` | One persistent TCP/authentication connection; one exec channel per operation |

Use `/ssh-status` to see the effective transport and whether its connection is
reused.

### Automatic fallback

- **Linux/macOS `auto`:** starts with multiplexed OpenSSH. If the server needs a
  password and `sshpass` is unavailable, it can fall back to `ssh2`, which can
  prompt directly.
- **Windows `auto`:** starts with `ssh2`. A compatibility or connection-setup
  failure before the first channel opens falls back to single-use OpenSSH and
  reports the reason.
- **Explicit `openssh` or `ssh2`:** does not hide incompatibilities by switching
  transports.

Cancelling a password prompt or exhausting password retries is a terminal
failure; another transport would reject the same credentials.

### OpenSSH mode

OpenSSH mode invokes the system `ssh` executable and leaves the destination
alias unchanged. Without `--ssh-config`, the client reads its normal user and
system configuration, including `~/.ssh/config`. This is the best choice for
advanced OpenSSH behavior that `ssh2` cannot reproduce.

On Linux and macOS, SSH Remote creates a private short-lived ControlPath. Each
operation still starts a lightweight local `ssh` process, but that process opens
a channel on the existing authenticated connection. The remote host may be
Unix or Windows.

Native Win32 OpenSSH still builds its mux entry points as
[no-ops](https://github.com/PowerShell/openssh-portable/blob/v10.0.0.0/contrib/win32/win32compat/no-ops.c#L59-L86),
so SSH Remote explicitly supplies `ControlMaster=no` and `ControlPath=none` on
Windows. Each foreground OpenSSH operation therefore creates a separate
connection.

OpenSSH starts non-interactively with `BatchMode=yes`, no remote PTY (`-T`),
and a ten-second connection timeout. Password retries are performed only
through `sshpass`; new-host and key-passphrase prompts never take over the Pi
TUI.

### `ssh2` mode

`ssh2` keeps one authenticated connection open and creates an exec channel for
each foreground operation. It runs `ssh -G` locally to resolve:

- aliases, `Include`, and `Match` rules;
- host, user, port, identities, and agent location;
- keepalives and effective algorithm lists;
- `ProxyJump` endpoints;
- configured `known_hosts` files.

Single- and multi-hop `ProxyJump` are implemented with `direct-tcpip` channels.
Each hop receives its own authenticated SSH connection, and the next hop uses
the preceding channel as its socket. Jump servers do not need `ssh`, `nc`, or
`socat`, but they must allow TCP forwarding to the next endpoint. Destination
names are resolved from the preceding jump host's network.

Supported authentication material includes unencrypted private keys and Unix,
Windows OpenSSH named-pipe, Cygwin, or Pageant agents where supported by
`ssh2`.

The following effective OpenSSH features require `openssh` mode:

- arbitrary `ProxyCommand`;
- `KnownHostsCommand` or `RemoteCommand`;
- `CertificateFile` and `@cert-authority`;
- `PKCS11Provider` and security-key/FIDO identities;
- keyboard-interactive or GSSAPI login;
- multi-step `AuthenticationMethods`;
- encrypted keys combined with `IdentitiesOnly=yes`.

`ControlMaster`, `ControlPersist`, and `ControlPath` are ignored because `ssh2`
owns the persistent connection. Paths containing spaces in a multi-file
`UserKnownHostsFile` or `GlobalKnownHostsFile` value may not be reproduced;
choose OpenSSH for those configurations.

Bun does not currently implement `chacha20-poly1305` in `node:crypto`
([oven-sh/bun#8072](https://github.com/oven-sh/bun/issues/8072)). SSH Remote
filters that cipher at runtime and negotiates AES-GCM/CTR instead.

## Authentication

SSH keys or an agent are recommended. They work across foreground operations,
reconnects, host switches, and background tasks without forwarding secrets
through the TUI.

### Host verification

- OpenSSH uses the system client's normal host-key policy.
- `ssh2` verifies every destination and jump host against direct entries in the
  configured OpenSSH `known_hosts` files.
- `ssh2` refuses unknown or changed keys and does not enroll trust
  automatically. Connect once with the system OpenSSH client to review and
  accept a new key before starting Pi.

### Password authentication

When key or agent authentication fails and **Password prompt** is enabled:

| Mode | Password behavior |
| --- | --- |
| Linux/macOS `auto` | Retries OpenSSH through `sshpass` when installed; otherwise falls back to `ssh2` |
| Windows `auto` or explicit `ssh2` | Prompts through the persistent `ssh2` client |
| Explicit `openssh` | Requires `sshpass` or `sshpass.exe` |

Install `sshpass` with, for example, `apt install sshpass` on Debian/Ubuntu or
`pacman -S sshpass` in Git Bash on Windows. OpenSSH passwords are placed only in
the `SSHPASS` environment variable, never in command arguments. `ssh2` sends
them through its authentication protocol.

The password prompt currently uses plain-text input because Pi does not yet
provide a masked input API. A wrong password re-prompts until cancelled or the
retry safety limit is reached. Servers that advertise only public-key methods
fail directly without opening a pointless prompt. Headless sessions never
prompt.

Passwords are held in process memory. With **Persist passwords** enabled, they
are also written to `ssh-remote-secrets.json` next to Pi's settings so restarts
and `-r` resumes can reuse them. The file uses mode `0600` on POSIX; Windows
relies on the inherited user-profile ACL.

```text
/ssh-forget-password        Forget target and ProxyJump passwords used by this Pi session
/ssh-forget-password all    Forget all cached and persisted SSH passwords
```

Disabling **Password prompt** prevents both user- and model-triggered prompts.
Disabling **Persist passwords** stops future reads and writes of the secrets
file but does not erase existing entries; use `/ssh-forget-password` to remove
them. Passwords already cached by the current process remain available.

### Model-triggered password authentication

**AI password auth** applies only to the model's `ssh_connect` tool:

- **On:** cached passwords may be used, and a required TUI prompt has a live
  60-second timeout. The user must enter the password directly in Pi and must
  never send it in chat.
- **Off:** `ssh_connect` is key-only. It neither reads cached passwords nor
  opens a prompt; an authentication failure recommends configuring SSH keys or
  re-enabling the setting.

Manual `/ssh-connect`, `/ssh-reconnect`, and startup `--ssh` actions are not
subject to the 60-second AI timeout. They may wait until the user submits or
cancels the prompt.

## Remote platform and shell

The default is automatic detection:

```bash
pi --ssh devbox --ssh-shell auto
```

SSH Remote first probes through POSIX `sh`, which also distinguishes Unix from
a native Windows host:

- a Unix account whose login shell is Zsh uses Zsh;
- other Unix hosts try Bash, then POSIX `sh` for ash-only systems;
- Windows hosts try PowerShell 7, then Windows PowerShell 5.1;
- when probing is inconclusive, the same deterministic candidate order is
  validated during workspace inspection.

Choose a shell explicitly when needed:

```bash
pi --ssh devbox --ssh-shell bash
pi --ssh devbox --ssh-shell zsh
pi --ssh winbox --ssh-shell pwsh
pi --ssh winbox --ssh-shell powershell
```

An explicit shell is checked first. Missing Bash or Zsh falls back to `sh` with
a warning; missing `pwsh` or `powershell` falls back to the other PowerShell.

The Pi tool remains named `bash` for compatibility, but commands use the
selected remote syntax. The model context and `!`/`!!` commands follow that
same shell.

Workspace control operations—path inspection, file tools, and search tools—use
POSIX `sh` scripts on Unix and encoded PowerShell scripts on Windows. This lets
OpenWrt, Alpine, BusyBox, and other Bash-free systems use the complete file-tool
set. On Windows, PowerShell commands are encoded as UTF-16LE payloads so script
content does not appear directly in `ssh.exe` arguments; file data still moves
as binary stdin/stdout. Cancellable Windows shell calls also record the root
PowerShell PID and start time. A Pi Esc cancellation or bash timeout uses a
second SSH channel with `taskkill /T /F` to remove that validated remote process
tree before closing the primary channel; a hard transport deadline prevents a
PowerShell 5.1 or Windows OpenSSH close hang from wedging the tool call.

Known POSIX-control-script limits:

- filenames containing newlines are not supported;
- `grep` or `find` glob patterns containing `)` are not supported.

## Workspace and session lifecycle

### Commands

| Command | Effect |
| --- | --- |
| `/ssh-connect <host[:path]>` | Enter SSH or switch directly from the active target |
| `/ssh-exit` | Return this conversation to its local workspace |
| `/ssh-cd <remote-path>` | Change the persistent remote cwd without reconnecting |
| `/ssh-status` | Show state, target, platform, shell, transport, cwd, and home |
| `/ssh-reconnect` | Retry the stored target or apply a transport change |
| `/ssh-forget-password [all]` | Clear session-scoped or all cached passwords |

These commands are always registered, including in ordinary local sessions.
Environment-changing commands wait for the current agent run to settle before
switching backends.

### Transactional switching and failure behavior

Host and cwd changes are validated before they are committed:

- `/ssh-connect` can switch directly between hosts; do not run `/ssh-exit`
  first.
- A failed host switch keeps the previous target, cwd, session name, persisted
  state, and connection active.
- A failed `/ssh-cd` keeps the previous cwd and connection unchanged.
- Existing background tasks remain on the host and cwd where they started.
  Only later launches follow the new environment.

Initial failures are handled by source:

| Action | Result on failure |
| --- | --- |
| Manual `/ssh-connect`, startup `--ssh`, or restore | Session remains **Disconnected** and workspace tools fail closed |
| Model `ssh_connect` from local | Session automatically returns to its local workspace |
| Manual or model switch from active SSH | Previous SSH workspace remains active |
| `/tree` restoration to another branch environment | Fails closed; the previous branch's host is not reused |

While SSH is connecting or disconnected after failure, routed tools and
`bg_start` report the SSH error instead of operating on Pi's local cwd. Use
`/ssh-reconnect` to retry or `/ssh-exit` to explicitly return local.

### Resume and branch state

Pi conversations and session files stay local. SSH Remote stores a hidden,
branch-aware entry containing only:

- target or alias;
- resolved remote platform and shell;
- resolved remote cwd and home;
- optional local OpenSSH config path.

It does not put passwords, private keys, SSH config contents, or remote file
contents in session state. Legacy version 1 Unix/Bash entries are migrated in
memory.

The selected local or SSH environment is restored after `/resume`, `pi -r`,
`pi -c`, reload, fork, clone, and `/tree`. `/new` inherits the previous remote
target. `/ssh-exit` writes an explicit local marker, so later resume stays local
instead of finding an older SSH entry. Passing a conflicting target, config,
cwd, or explicit shell while resuming is rejected to prevent an old
conversation from modifying another machine.

Pi still groups sessions by its **local** cwd. Start remote projects from a
stable local anchor directory; in `/resume`, press Tab to switch from
**Current Folder** to **All**. Resume restores conversation and environment
metadata, not a snapshot of remote files or running processes.

### Status and automatic session names

The footer status shows only `SSH: Connecting`, `SSH: Connected`, or
`SSH: Disconnected`. For unnamed sessions, SSH Remote sets Pi's native session
name to a stable location and then appends the remote Git branch and first user
message when available:

```text
SSH devbox:/srv/project (main) • Fix the build
```

A user-assigned `/name` is never overwritten.

## AI control tools

**SSH Remote → AI control tools** defaults to **Off**. Enabling it in
`/99settings` immediately adds:

| Tool | Purpose |
| --- | --- |
| `ssh_connect { target }` | Enter SSH or switch directly to another target |
| `ssh_exit {}` | Return to the local workspace |
| `ssh_cd { path }` | Change the active remote cwd |
| `ssh_status {}` | Inspect the current environment |

Disabling the setting removes these tools from the active tool set without
affecting manual commands or an active SSH workspace. `ssh_connect`, `ssh_exit`,
and `ssh_cd` execute sequentially so environment transitions cannot race sibling
tool calls. The model is instructed to complete a transition before issuing
file or shell calls against the new environment.

SSH Remote deliberately provides no permission prompt, allowlist, or approval
UI. A separate general-purpose extension can gate these stable tool names
through Pi's `tool_call` event. Environment transitions are also published on
the `ssh-remote:environment` event bus channel for auditing and integration.

See [Model-triggered password authentication](#model-triggered-password-authentication)
for the independent **AI password auth** setting.

## Tool routing and integrations

### Routed and local behavior

| Runs on the SSH workspace | Remains local |
| --- | --- |
| `read`, `write`, `edit`, `bash` | Pi TUI and conversation history |
| Optional `grep`, `find`, `ls` | Model credentials and installed packages |
| User `!` and `!!` commands | `todo`, `thinking-fold`, `cursor-effect`, `codex_search` |
| Shared workspace-file providers | Session files, project discovery, and skill definitions |
| New background tasks | Pi's local anchor cwd |

SSH Remote keeps Pi's native tool schemas, rendering, diffs, truncation, and
mutation-queue behavior. Optional `grep`, `find`, and `ls` retain Pi's normal
disabled state and become remote only when enabled through `--tools` or the tool
selector.

### Shared workspace files and Codex images

SSH Remote registers its active binary file backend through
`@99percentpeople/pi-workspace-files`. Consumers follow the same remote adapter
as Pi's `read` and `write` tools without tool-specific SSH hooks.

`@99percentpeople/pi-codex-api` uses this provider automatically:

- `output_path` resolves inside the remote workspace and is written there
  directly;
- `referenced_image_paths` are read remotely and sent to the image API;
- no image is staged locally and no reverse SSH or `scp` step is required;
- existing files are never overwritten;
- paths outside the active remote workspace are rejected.

Example for a Windows SSH workspace:

```text
output_path: C:\Users\dev\Desktop\wallpaper.png
referenced_image_paths: [C:\Users\dev\Desktop\reference.jpg]
```

### Background tasks

When `@99percentpeople/pi-background-tasks` is installed, SSH Remote registers a
remote backend for pipe and PTY jobs. Version 1.2.7 or newer also allows
`bg_start.cwd` to name a remote-only Unix or Windows directory. Remote signal,
transport-recovery, and ControlMaster-lease safety require Background Tasks
protocol v2; SSH Remote blocks remote `bg_start` with an actionable update
message when an older build is detected.

Background jobs require a real local process or PTY, so they always launch the
system OpenSSH client:

- Linux/macOS OpenSSH foreground mode shares the managed ControlPath.
- `ssh2`, Windows `auto`, and native Windows OpenSSH use separate
  non-interactive OpenSSH connections for background jobs.
- A foreground password is not forwarded to those separate processes; use an
  SSH key or agent.

SSH Remote registers a named, high-priority Background Tasks provider. Active
SSH resolves remotely, connecting or failed SSH fails closed, and local mode
falls through to lower-priority providers such as Pwsh. This avoids
last-writer registration races and restores arbitrary local adapters without a
per-`bg_start` reclaim.

Every SSH launch records an immutable label such as
`SSH devbox:/srv/project`. Background task results—including start,
status, wait, logs, input, and termination—repeat this label, and task rows show
it inline in the widget. This lets the model and user distinguish old tasks
after a host or cwd switch. Finished task snapshots retain the label across
extension reloads.

Each launch also creates a private remote control record for its Unix process
group or Windows process tree. `bg_send` signals and `bg_kill` use a short SSH
control channel to target that remote process directly; they do not mistake
termination of the local `ssh` launcher for termination of the command. Unix
supports its normal named signals and preserves the user shell's signal
handling, so Bash `trap` handlers continue to run for signals such as `INT`,
`TERM`, `HUP`, `QUIT`, `USR1`, and `USR2`. Remote Windows termination uses
`taskkill /T /F`, and unsupported Unix-only signals return an error.

Each multiplexed job holds a task lease on its launch-time ControlMaster. Host
switches and even an earlier-running SSH shutdown handler defer socket removal
until all leased jobs settle, so password-authenticated jobs remain
controllable without copying a password into background or signal processes.
A key- or agent-authenticated direct connection remains the fallback when no
managed master exists.

If the local `ssh` transport exits unexpectedly, the task control probes its
immutable remote record, requests `SIGTERM`, escalates to `SIGKILL` when needed,
and only then finalizes the task. If connectivity prevents confirmation,
Background Tasks reports `disconnected` and preserves signal control for a
later retry instead of claiming that the remote process exited. Running jobs
stay on their original host and cwd across `/ssh-connect`, `/ssh-exit`, and
`/ssh-cd`; resume does not reattach running jobs. Native Windows `ssh.exe` pipe
launches use `-n` to avoid the OpenSSH stdio deadlock and therefore require PTY
mode when later interactive stdin is needed.

### Windows PowerShell adapter

On Windows, `@99percentpeople/pi-pwsh-adapter` may register the `bash` tool
first. SSH Remote uses the shared `bash:delegate` protocol instead of competing
for that tool name:

- active SSH sessions run the delegated shell remotely;
- connecting or failed SSH sessions fail closed;
- local sessions use the normal local PowerShell backend;
- after `/ssh-exit`, the named SSH provider falls through to the registered
  local PowerShell background provider.

Use compatible versions of both packages.

## Compatibility and limitations

- `ssh2` implements the documented compatibility subset only. Use explicit
  OpenSSH for certificates, hardware keys, arbitrary routing, GSSAPI, or
  keyboard-interactive authentication.
- Windows PowerShell 5.1 can keep a manually nested native `ssh.exe` invocation
  open long after its remote command exits when console stdin remains attached.
  Prefer `ssh -n ...` for such nested commands or use PowerShell 7. Pi Esc and
  bash timeout still terminate the outer recorded process tree.
- Local `AGENTS.md`, `.pi`, project settings, registered skills, and references
  inside skill directories are not virtualized. They continue to come from
  Pi's local anchor directory.
- `read` downloads the complete remote file before applying Pi's line and byte
  truncation. Use the remote shell to select a range from very large files.
- Unix `find` uses remote `rg` when available so `.gitignore` is honored. Its
  POSIX fallback and the native Windows implementation always exclude `.git`
  and `node_modules`, but do not reproduce every `.gitignore` rule.
- Remote file paths are encoded into a reserved logical namespace before Pi's
  file tools run. This prevents Pi's local mutation queue from resolving
  remote-only paths such as `/root` or `/etc` against the local machine.
- `edit` serializes mutations inside the current Pi process, but cannot stop
  another process on the remote host from changing a file between read and
  write.
- Remote shells receive safe Pi model/session identifiers but never
  `PI_SESSION_FILE`, because that path exists only on the local host.
- Conversation resume does not restore remote processes or snapshot repository
  contents.

## Security

The package runs either the system OpenSSH client or the bundled `ssh2`
protocol client and executes commands with the same permissions as a manual SSH
login. Model-provided shell commands are executable code; review the package and
use a restricted remote account where appropriate.

File paths are placed only in encoded control scripts or shell-quoted POSIX
commands, and file contents travel through SSH stdin/stdout channels. Passwords
never enter SSH command arguments, but TUI password input is currently unmasked
and persisted passwords depend on the protections of the local settings
account. Prefer SSH keys or an agent for unattended and background work.

## Development

```bash
bun run build:packages
bun run --cwd extensions/ssh-remote build
pi -e ./extensions/ssh-remote/index.ts --ssh devbox:/srv/project
```

## License

MIT
