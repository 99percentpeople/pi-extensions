# Pi Extensions

[![CI](https://github.com/99percentpeople/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/99percentpeople/pi-extensions/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/99percentpeople/pi-extensions)](LICENSE)

A focused collection of extensions for the [Pi coding agent](https://pi.dev/).
Add background tasks, remote SSH workspaces, PowerShell support, Codex subscription
tools, cursor effects, folded reasoning, or a compact todo workflow without
installing an all-in-one bundle.

Every extension is published and versioned independently. Install only the
capabilities you need.

## Contents

- [Packages](#packages)
- [Quick start](#quick-start)
- [Compatibility](#compatibility)
- [Extension guide](#extension-guide)
- [Shared infrastructure](#shared-infrastructure)
- [Development](#development)
- [Publishing](#publishing)
- [Uninstall](#uninstall)

## Packages

### Extensions

| Extension | npm | What it adds |
| --- | --- | --- |
| [Background Tasks](extensions/background-tasks/README.md) | [![background-tasks](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-background-tasks?label=background-tasks)](https://www.npmjs.com/package/@99percentpeople/pi-background-tasks) | Pipe and PTY background tasks with attach, logs, waits, input, signals, and local or SSH-backed execution |
| [Codex API](extensions/codex-api/README.md) | [![codex-api](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-codex-api?label=codex-api)](https://www.npmjs.com/package/@99percentpeople/pi-codex-api) | Codex OAuth image generation, search, Fast mode, and subscription usage tools |
| [Cursor Effect](extensions/cursor-effect/README.md) | [![cursor-effect](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-cursor-effect?label=cursor-effect)](https://www.npmjs.com/package/@99percentpeople/pi-cursor-effect) | Configurable effects for Pi's working, retry, compaction, and branch-summary cursors |
| [PowerShell Adapter](extensions/pwsh-adapter/README.md) | [![pwsh-adapter](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-pwsh-adapter?label=pwsh-adapter)](https://www.npmjs.com/package/@99percentpeople/pi-pwsh-adapter) | PowerShell 7 or Windows PowerShell 5.1 for Pi's shell and background tasks on Windows |
| [SSH Remote](extensions/ssh-remote/README.md) | [![ssh-remote](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-ssh-remote?label=ssh-remote)](https://www.npmjs.com/package/@99percentpeople/pi-ssh-remote) | Remote Unix or Windows workspaces through reusable OpenSSH or `ssh2` transports |
| [Thinking Fold](extensions/thinking-fold/README.md) | [![thinking-fold](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-thinking-fold?label=thinking-fold)](https://www.npmjs.com/package/@99percentpeople/pi-thinking-fold) | Timed, collapsible live-tail previews for long reasoning traces |
| [Todo](extensions/todo/README.md) | [![todo](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-todo?label=todo)](https://www.npmjs.com/package/@99percentpeople/pi-todo) | Atomic whole-plan updates, dependencies, reminders, and a read-only TUI widget |

### Shared libraries

| Library | npm | Purpose |
| --- | --- | --- |
| [`@99percentpeople/pi-shared-settings`](packages/shared-settings/README.md) | [![shared-settings](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-shared-settings?label=shared-settings)](https://www.npmjs.com/package/@99percentpeople/pi-shared-settings) | Shared `/99settings` menu and namespaced settings store |
| [`@99percentpeople/pi-workspace-files`](packages/workspace-files/README.md) | [![workspace-files](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-workspace-files?label=workspace-files)](https://www.npmjs.com/package/@99percentpeople/pi-workspace-files) | Binary workspace I/O protocol shared by Codex API and SSH Remote |

The shared libraries are runtime dependencies, not Pi extensions. They register
no tools or commands on their own.

## Quick start

### Install an extension

Choose one or more packages:

```bash
pi install npm:@99percentpeople/pi-background-tasks
pi install npm:@99percentpeople/pi-codex-api
pi install npm:@99percentpeople/pi-cursor-effect
pi install npm:@99percentpeople/pi-ssh-remote
pi install npm:@99percentpeople/pi-thinking-fold
pi install npm:@99percentpeople/pi-todo
```

On Windows, add the PowerShell adapter when Pi's `bash` tool and Background
Tasks should both use PowerShell syntax:

```powershell
pi install npm:@99percentpeople/pi-pwsh-adapter
```

### Common setups

#### Remote workspace with attachable PTY tasks

```bash
pi install npm:@99percentpeople/pi-background-tasks
pi install npm:@99percentpeople/pi-ssh-remote
pi --ssh devbox:/srv/project
```

SSH Remote uses your existing OpenSSH aliases and credentials. The same
Background Tasks workflow can then run `htop`, `lazygit`, `nvim`, or another TUI
on the remote host without leaving the current Pi conversation.

#### Codex subscription tools

```bash
pi install npm:@99percentpeople/pi-codex-api
```

Sign in to Pi's `openai-codex` provider. No OpenAI API key or MCP server is
required. To use the tools while another provider is active, enable **Other
providers** in `/99settings`.

#### Todo replacement

Remove another extension that owns the same `todo` tool before installing this
one:

```bash
pi remove npm:@juicesharp/rpiv-todo
pi install npm:@99percentpeople/pi-todo
```

### Configure installed extensions

Open the shared settings menu:

```text
/99settings
```

Only installed extensions that expose settings appear in the menu.

## Compatibility

Background Control protocol v2 integrations require this minimum set:

| Package | Minimum version |
| --- | --- |
| `@99percentpeople/pi-background-tasks` | `2.0.0` |
| `@99percentpeople/pi-ssh-remote` | `0.5.0` |
| `@99percentpeople/pi-pwsh-adapter` | `1.1.0` |

Background Tasks works by itself. SSH Remote and the PowerShell Adapter matter
only when those integrations are installed. Background Tasks 2.x rejects
unnamed protocol-v1 providers so an active remote workspace cannot silently
fall back to a local process.

## Extension guide

### Background Tasks

Run finite commands, long-lived services, and interactive terminal programs
without blocking the foreground Pi session.

| Tool | Purpose |
| --- | --- |
| `bg_start` | Start a pipe or PTY task |
| `bg_wait` | Wait once for a finite task to finish or time out |
| `bg_status` | Inspect task state and immutable launch metadata |
| `bg_logs` | Read retained pipe or PTY output |
| `bg_send` | Send text, terminal keys, EOF, or an execution-environment signal |
| `bg_kill` | Terminate a running or disconnected adapter-owned task |

User commands:

- `/bg-attach <id>` attaches to a PTY or follows new pipe output. Press
  `Ctrl+]` to detach.
- `/bg-kill` selects and terminates a running task.

Task names can be used anywhere an ID is accepted. Same-task calls emitted in
one model response execute in source order, while independent task chains run
in parallel. PTY support uses `node-pty`; systems without a compatible native
binary may require a C/C++ toolchain.

[Read the Background Tasks documentation →](extensions/background-tasks/README.md)

### SSH Remote

Keep Pi local while routing workspace operations to a remote Unix or Windows
host. SSH Remote handles:

- `read`, `write`, `edit`, and `bash`;
- optional `grep`, `find`, and `ls` tools;
- user `!` and `!!` commands;
- binary workspace files used by Codex API;
- Background Tasks PTY and signal control.

Auto transport selection uses managed OpenSSH multiplexing on Linux and macOS,
and a persistent `ssh2` connection with OpenSSH compatibility fallback on
Windows. Both transports support `ProxyJump`; explicit OpenSSH mode also keeps
native `ProxyCommand` behavior.

Session state records the target, remote platform, shell, and cwd. Resume and
branch navigation restore that state transactionally, while failures block
remote tools instead of falling back to Pi's local workspace.

| Command | Purpose |
| --- | --- |
| `/ssh-connect <target>` | Connect or switch directly to another SSH target |
| `/ssh-cd <path>` | Change the persistent remote cwd without reconnecting |
| `/ssh-status` | Show the current local or remote environment |
| `/ssh-reconnect` | Reconnect the active target |
| `/ssh-exit` | Return explicitly to the local workspace |
| `/ssh-forget-password [all]` | Remove cached password entries |

Model-facing environment controls are disabled by default. Model-triggered
password input has a 60-second deadline; manual connections can wait until the
user responds.

[Read the SSH Remote documentation →](extensions/ssh-remote/README.md)

### PowerShell Adapter

This Windows-only extension:

- prefers PowerShell 7 (`pwsh.exe`);
- falls back to Windows PowerShell 5.1 (`powershell.exe`);
- routes Pi's Bash backend and Background Tasks through the same runtime;
- configures UTF-8 input and output;
- preserves interactive PTY behavior.

Without the adapter, Background Tasks follows Pi's configured Bash resolution,
including Git Bash on Windows.

[Read the PowerShell Adapter documentation →](extensions/pwsh-adapter/README.md)

### Codex API

Use a ChatGPT Codex subscription from Pi without an API key.

| Tool or command | Purpose |
| --- | --- |
| `codex_image` | Generate or edit images and save non-overwriting PNG outputs |
| `codex_search` | Search web/images, navigate pages, capture PDF pages, and query finance, weather, sports, or time data |
| `/codex-usage` | Show quota, plan information, and reset cards |
| `/codex-redeem` | Confirm and redeem an available reset card |

The usage commands appear only after Pi confirms an `openai-codex` OAuth login.
When SSH Remote is active, generated files and image references use the remote
binary workspace provider instead of a local staging directory.

[Read the Codex API documentation →](extensions/codex-api/README.md)

### Cursor Effect

Style Pi's main working, retry, compaction, and branch-summary cursors without
changing tool loaders, widgets, messages, or model events. Built-in themes
include Default, Claude Code, and Codex; Custom mode exposes independent loader
and label controls.

[Read the Cursor Effect documentation →](extensions/cursor-effect/README.md)

### Thinking Fold

Long reasoning traces render beneath a once-per-second timed header. The live
view keeps a compact tail, completed thinking defaults to `Thought for xx.xs`,
and `Ctrl+T` restores the full original reasoning. Display-only patches never
alter persisted messages or reasoning signatures.

[Read the Thinking Fold documentation →](extensions/thinking-fold/README.md)

### Todo

The `todo` tool writes one authoritative `tasks[]` snapshot instead of issuing
per-task CRUD calls. It supports:

- stable model-facing keys and same-call dependencies;
- sparse updates for existing tasks;
- stale-revision and dependency-graph validation;
- omission-based deletion with no archive or cancelled state;
- branch-aware persistence and compaction checkpoints;
- a read-only widget with configurable reminders.

Completed tasks remain visible for the current response and are removed before
the next response unless unfinished work still depends on them.

[Read the Todo documentation →](extensions/todo/README.md)

## Shared infrastructure

### Shared settings

Configurable extensions share one atomically written file:

```text
~/.pi/agent/99extensions.json
```

| Namespace | Main settings |
| --- | --- |
| `background-tasks` | Collapsed task count and output previews |
| `codex-api` | Fast mode, provider access, search, image quality, and usage status |
| `cursor-effect` | Themes and custom loader/label effects |
| `ssh-remote` | Transport, password behavior, and AI controls |
| `thinking-fold` | Fold threshold and streaming/completed display behavior |
| `todo` | Widget size, dependency numbers, and reminder interval |

<details>
<summary>Example <code>99extensions.json</code></summary>

```json
{
  "background-tasks": {
    "collapsedTaskLimit": 0,
    "outputPreview": "finished"
  },
  "codex-api": {
    "fastMode": false,
    "allowOtherProviders": false,
    "searchMode": "auto"
  },
  "ssh-remote": {
    "transport": "auto"
  },
  "thinking-fold": {
    "foldThreshold": 5,
    "streamingBehavior": "auto",
    "completedBehavior": "auto"
  },
  "todo": {
    "collapsedTaskLimit": 3,
    "showDependencyNumbers": true,
    "reminderInterval": 3
  }
}
```

</details>

### Workspace files

`@99percentpeople/pi-workspace-files` defines the binary workspace I/O protocol
used by Codex API and SSH Remote. Consumers request the active file system and
fall back to a workspace-confined local Node.js backend when no remote provider
claims it.

The protocol covers native path resolution, buffered or streaming binary
reads/writes, directory creation, existence checks, and cancellation.

[Read the Workspace Files documentation →](packages/workspace-files/README.md)

## Development

The repository is a private Bun 1.3.14 workspace containing independently
published source packages.

### Install, build, and test

```bash
bun install --frozen-lockfile
bun run build:all
bun run check
bun run pack:check
```

`bun run check` runs the privacy scanner, strict TypeScript checking, and the
unit/integration test suite. The privacy scanner rejects developer-specific
paths, accounts, hosts, emails, private IPs, and credential-shaped material in
committed test and e2e fixtures.

### Build output

Builds never create package-local `dist/` directories. Each complete npm staging
package is generated under the repository root:

```text
dist/<package-name>/
├── index.min.js
├── index.min.js.map
├── package.json
├── README.md
└── LICENSE
```

Shared libraries additionally include declarations; package-specific skills or
JSON assets are copied beside the runtime entrypoint. Root `dist/` is ignored by
Git and rebuilt from release tags.

Pi core peers and all npm runtime dependencies remain external. This preserves
Pi's peer-module identity and lets native or dynamic dependencies use their
normal package loaders.

### Load source directly

```bash
pi -e ./extensions/background-tasks/index.ts
pi -e ./extensions/codex-api/index.ts
pi -e ./extensions/cursor-effect/index.ts
pi -e ./extensions/ssh-remote/index.ts --ssh devbox:/srv/project
pi -e ./extensions/thinking-fold/index.ts
pi -e ./extensions/todo/index.ts
```

On Windows:

```powershell
pi -e ./extensions/pwsh-adapter/index.ts
```

### Repository layout

| Path | Contents |
| --- | --- |
| `extensions/` | Seven independently published Pi extensions |
| `packages/` | Shared settings and workspace-file runtime libraries |
| `tests/` | Unit and optional live integration tests |
| `e2e/` | Local and remote Windows smoke tests |
| `scripts/` | Build, privacy, and package validation scripts |
| `promo/` | Demo assets used by package documentation |

Windows SSH integration requires a live test host. See
[`tests/README.md`](tests/README.md) for the integration suite and
[`e2e/README.md`](e2e/README.md) for local/remote smoke tests.

## Publishing

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) publishes only
from package-specific tags through npm Trusted Publishing and GitHub Actions
OIDC. No `NPM_TOKEN` is required.

Configure a Trusted Publisher separately for all nine npm packages:

- **Provider:** GitHub Actions
- **Organization or user:** `99percentpeople`
- **Repository:** `pi-extensions`
- **Workflow filename:** `publish.yml`
- **Allowed action:** `npm publish`

Tags use the source directory name followed by the exact package version:

```text
background-tasks-v2.0.1
ssh-remote-v0.5.3
workspace-files-v0.1.1
```

To release a package:

1. Update its source `package.json` version and any internal dependency pins.
2. Update package documentation when behavior changed.
3. Run `bun run pack:check`.
4. Commit and push the release changes.
5. Create and push the matching tag.

```bash
git tag ssh-remote-v0.5.3
git push origin master ssh-remote-v0.5.3
```

Publish shared libraries before extensions that require their new versions. The
workflow rejects tags that do not exactly match the selected package's
`package.json`.

## Uninstall

```bash
pi remove npm:@99percentpeople/pi-background-tasks
pi remove npm:@99percentpeople/pi-codex-api
pi remove npm:@99percentpeople/pi-cursor-effect
pi remove npm:@99percentpeople/pi-pwsh-adapter
pi remove npm:@99percentpeople/pi-ssh-remote
pi remove npm:@99percentpeople/pi-thinking-fold
pi remove npm:@99percentpeople/pi-todo
```

## License

[MIT](LICENSE)
