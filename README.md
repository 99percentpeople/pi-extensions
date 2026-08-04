# Pi Extensions

[![CI](https://github.com/99percentpeople/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/99percentpeople/pi-extensions/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/99percentpeople/pi-extensions)](LICENSE)
[![background-tasks](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-background-tasks?label=background-tasks)](https://www.npmjs.com/package/@99percentpeople/pi-background-tasks)
[![codex-api](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-codex-api?label=codex-api)](https://www.npmjs.com/package/@99percentpeople/pi-codex-api)
[![cursor-effect](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-cursor-effect?label=cursor-effect)](https://www.npmjs.com/package/@99percentpeople/pi-cursor-effect)
[![pwsh-adapter](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-pwsh-adapter?label=pwsh-adapter)](https://www.npmjs.com/package/@99percentpeople/pi-pwsh-adapter)
[![ssh-remote](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-ssh-remote?label=ssh-remote)](https://www.npmjs.com/package/@99percentpeople/pi-ssh-remote)
[![thinking-fold](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-thinking-fold?label=thinking-fold)](https://www.npmjs.com/package/@99percentpeople/pi-thinking-fold)
[![todo](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-todo?label=todo)](https://www.npmjs.com/package/@99percentpeople/pi-todo)

A focused collection of TypeScript extensions for the
[Pi coding agent](https://pi.dev/): run and revisit background tasks, expose
Codex subscription image and search APIs, style the main session status cursors,
use PowerShell consistently on Windows, route coding tools through reusable SSH,
fold long reasoning traces, and keep model-authored plans visible in the TUI.

| Extension | npm package | Purpose |
| --- | --- | --- |
| background-tasks | [`@99percentpeople/pi-background-tasks`](https://www.npmjs.com/package/@99percentpeople/pi-background-tasks) | Background commands, explicit waits, logs, signals, and optional PTY/TUI interaction |
| codex-api | [`@99percentpeople/pi-codex-api`](https://www.npmjs.com/package/@99percentpeople/pi-codex-api) | Codex OAuth image generation/editing, first-party search, Fast mode, and subscription usage status |
| cursor-effect | [`@99percentpeople/pi-cursor-effect`](https://www.npmjs.com/package/@99percentpeople/pi-cursor-effect) | Selectable effects for Pi's working, retry, compaction, and branch-summary cursors |
| pwsh-adapter | [`@99percentpeople/pi-pwsh-adapter`](https://www.npmjs.com/package/@99percentpeople/pi-pwsh-adapter) | PowerShell 7 and Windows PowerShell 5.1 adapter for Pi on Windows |
| ssh-remote | [`@99percentpeople/pi-ssh-remote`](https://www.npmjs.com/package/@99percentpeople/pi-ssh-remote) | Route Pi file and shell tools to remote Unix or Windows workspaces through reusable OpenSSH or ssh2 transports |
| thinking-fold | [`@99percentpeople/pi-thinking-fold`](https://www.npmjs.com/package/@99percentpeople/pi-thinking-fold) | Live tail previews for long reasoning traces with full summaries and Ctrl+T expansion |
| todo | [`@99percentpeople/pi-todo`](https://www.npmjs.com/package/@99percentpeople/pi-todo) | Minimal atomic whole-plan todo writes with dependencies and a read-only list above the input |

The packages have separate versions and releases. Installing one extension does
not install or enable any of the others.

## Shared settings

Extensions in this collection that expose configurable values share one
configuration command:

```text
/99settings
```

The menu discovers installed plugins at runtime and shows only plugins that
currently expose configurable values. Plugins without settings are omitted.
Configuration is stored atomically in one file:

```text
~/.pi/agent/99extensions.json
```

For example:

```json
{
  "background-tasks": {
    "collapsedTaskLimit": 0,
    "outputPreview": "finished"
  },
  "codex-api": {
    "fastMode": false,
    "allowOtherProviders": false,
    "searchMode": "auto",
    "searchContextSize": "medium",
    "imageQuality": "auto",
    "usageStatus": true
  },
  "cursor-effect": {
    "theme": "default",
    "custom": {
      "loader": { "style": "pi-default", "speed": "normal", "color": "accent" },
      "label": {
        "style": "wave",
        "speed": "normal",
        "crestWidth": "soft",
        "palette": "accent",
        "direction": "left-to-right",
        "pause": "none"
      }
    }
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
    "showDependencyNumbers": true
  }
}
```

Operational commands such as `/bg-attach` and `/bg-kill` remain separate.

## Shared workspace files

`@99percentpeople/pi-workspace-files` provides the common binary workspace I/O
protocol used by `codex-api` and `ssh-remote`. Consumers request the active file
system and automatically fall back to a workspace-confined local Node.js
backend. Remote extensions can register a provider for native path resolution,
buffered or streaming binary reads/writes through the same methods, directory
creation, existence checks, and cancellation.

It is a library dependency rather than a Pi extension, so it registers no tools,
commands, or `pi.extensions` entry. See
[`packages/workspace-files`](packages/workspace-files/README.md).

## Highlights

- Install only the capabilities you need; every extension is an independent npm
  package.
- Integrate with Pi's native tools, widgets, session history, and terminal UI.
- Support interactive PTY applications, persistent task snapshots, and
  cross-platform shell execution.
- Validate on Linux, macOS, and Windows, with tag-driven npm releases through
  GitHub Actions Trusted Publishing.

## Installation

Install background task support on Linux, macOS, or Windows:

```bash
pi install npm:@99percentpeople/pi-background-tasks
```

On Windows, install the optional adapter when both Pi's `bash` tool and
`bg_start` should use PowerShell syntax:

```powershell
pi install npm:@99percentpeople/pi-pwsh-adapter
```

Without the adapter, `bg_start` follows Pi's configured Bash resolution and
command prefix, including Git Bash on Windows.

Use local Pi sessions and credentials against a remote Unix or Windows workspace
through an existing OpenSSH alias and an automatically selected reusable transport:

```bash
pi install npm:@99percentpeople/pi-ssh-remote
pi --ssh devbox:/srv/project
```

Install Codex subscription API tools after signing in to Pi's `openai-codex`
provider. Build local package directories before installing them from this
checkout:

```bash
bun run build:packages
bun run --cwd extensions/codex-api build
pi install ./extensions/codex-api
```

Install the reasoning-fold and optional cursor-effect extensions from this
checkout while developing:

```bash
bun run build:packages
bun run --cwd extensions/thinking-fold build
bun run --cwd extensions/cursor-effect build
pi install ./extensions/thinking-fold
pi install ./extensions/cursor-effect
```

Install the snapshot-based todo extension after removing another extension that
registers the same `todo` tool:

```bash
pi remove npm:@juicesharp/rpiv-todo
pi install npm:@99percentpeople/pi-todo
```

## background-tasks

Tools:

- `bg_start` starts a pipe or PTY background task.
- `bg_wait` waits once for a finite task to finish or time out.
- `bg_status` reads task metadata or lists known tasks.
- `bg_logs` is the only tool that reads pipe or parsed PTY output.
- `bg_send` sends text, terminal keys, or supported process signals.
- `bg_kill` terminates a task.

Commands:

- `/bg-attach <id>` attaches to a PTY or streams new pipe output. Press
  `Ctrl+]` to detach.
- `/bg-kill` selects and terminates a running task.

Example:

```text
bg_start name="git-ui" command="lazygit" pty=true
/bg-attach <task-id>
```

Terminal keys sent through `bg_send` use angle-bracket tokens such as
`<C-c>`, `<A-f>`, `<Space>`, `<Up>`, and `<F10>`. Escape a literal `<` as `\<`.
Every model-facing task `id` also accepts its unique name. Same-task calls in
one model response execute in source order, including `bg_start` by name, so a
model can emit `bg_start(name=A) → bg_wait(id=A) → bg_logs(id=A)` together
without first spending a round to learn the generated ID. Different task chains
run in parallel, and the same sequence works for pipe and PTY tasks.

PTY support uses `node-pty`. If no compatible native binary is available,
installation may require a C/C++ toolchain. `/99settings` controls how many task
rows appear in the collapsed widget and which pipe tasks show latest-output
previews. See the
[background-tasks package documentation](extensions/background-tasks/README.md)
for details.

## pwsh-adapter

The adapter is a Windows-only package that:

- prefers PowerShell 7 (`pwsh.exe`) and falls back to Windows PowerShell 5.1
  (`powershell.exe`);
- replaces Pi's Bash execution backend with the selected runtime;
- configures UTF-8 input and output;
- makes background-tasks use the same PowerShell syntax;
- keeps PTY tasks interactive.

The startup notification and tool prompt identify the selected version so the
model can avoid PowerShell 7-only syntax when running Windows PowerShell 5.1.

## ssh-remote

`ssh-remote` keeps Pi local while routing `read`, `write`, `edit`, `bash`, the
optional `grep`, `find`, and `ls` tools, and user `!`/`!!` commands through a
selectable `auto`, `openssh`, or `ssh2` transport. Auto mode uses managed
OpenSSH multiplexing on Linux/macOS and a persistent `ssh2` connection on
Windows, with compatibility fallback to single-use OpenSSH. Targets retain
rsync-style syntax such as `devbox:/srv/project`; both transports support
single- and multi-hop `ProxyJump`, while explicit OpenSSH mode additionally
supports arbitrary `ProxyCommand` behavior. `ssh2` resolves its documented
configuration subset through `ssh -G`. Shell selection is one flag:
`--ssh-shell` chooses Bash, Zsh, PowerShell 7, or Windows PowerShell 5.1
explicitly, or auto mode detects the remote account's login shell (Zsh
accounts get Zsh) with a sh/PowerShell fallback and warning when the chosen
shell is missing. The resolved target, platform, shell, and cwd are stored as
hidden Pi session state and reconnect on resume; failed connections block
remote tools instead of falling back to local files. The
status line shows only the themed connection state, while an automatic
`SSH target:path (branch) • first message` session name places the remote
location and opening request in Pi's normal footer and native `/resume` list
without replacing the footer. When `codex-api` is installed, its image output
and reference paths use SSH Remote's shared binary workspace backend, including
native Windows paths, without local staging. See the
[ssh-remote package documentation](extensions/ssh-remote/README.md).

## codex-api

`codex-api` turns your ChatGPT subscription into Pi tools — `codex_image`
and `codex_search` — without an OpenAI API key or MCP server. They even work
while a third-party model (DeepSeek, Google, …) is active: enable **Other
providers** in `/99settings` and the tools reuse Pi's logged-in
`openai-codex` subscription. It also provides settings-controlled Fast mode.
After Pi confirms an `openai-codex` OAuth login, it registers `/codex-usage`
for quota, plan info, and earned reset cards, plus `/codex-redeem` to
confirmably redeem a reset card when you run out of messages. Sessions started
without a Codex login keep these commands hidden. Image outputs are saved as
non-overwriting PNG files and returned to
the model for follow-up inspection. Search supports web and image queries, page
navigation, PDF screenshots, finance, weather, sports, and time operations,
with Auto routing (Cached / Indexed / Live per call) or fixed user modes.
Configure Fast, search mode, search context size, and usage status through
`/99settings`. See the
[codex-api package documentation](extensions/codex-api/README.md).

## cursor-effect

`cursor-effect` owns visual styling for Pi's main working, retry, compaction,
and branch-summary status cursors, while leaving tool/bash/extension loaders
alone. Complete themes include Default, Claude Code, and Codex without tuning
controls. Selecting Custom reveals independent Loader and Label submenus for
speed, color, crest width, and palette while preserving those custom values.
It does not modify Items, tool/bash loaders, widgets, messages, or model events.
Use the shared `/99settings` menu to configure the persistent effects. See the
[cursor-effect package documentation](extensions/cursor-effect/README.md).

## thinking-fold

Long reasoning traces stay under a once-per-second timed Item header. Model
behavior controls the main-cursor status headline, while `/99settings` separately
controls the fold threshold, the display while thinking, and the display after
thinking. Completed thinking defaults to `Thought for xx.xs`; `Ctrl+T` restores
the full original content and keeps that view expanded across later turns until
toggled again. `Ctrl+T` does not take over Pi's native `Ctrl+O` tool expansion. The
compatibility patch changes only display copies; session messages and reasoning
signatures remain untouched. See the
[thinking-fold package documentation](extensions/thinking-fold/README.md).

## todo

The `todo` tool replaces per-task CRUD calls with one atomic `tasks[]` snapshot.
Stable task keys allow dependencies to reference tasks created in the same call.
Updates include the complete current key list but may omit unchanged fields, so
one compact call can complete the current task and start the next. The list is
authoritative: omitted keys are deleted directly, stale revisions can be
rejected, and invalid dependency graphs do not partially mutate state. Deleted
tasks leave no cancelled status or archived record.

The extension deliberately registers no todo-specific slash commands or interactive manager.
A read-only widget above the input shows a configurable number of tasks when
collapsed and the complete list when expanded with Pi's standard `Ctrl+O`
binding. Configure the collapsed-item limit and dependency-number visibility
through `/99settings`. In-progress task labels are bold. Task keys stay
model-only; when dependency numbers are enabled, participating tasks receive
compact display-only references such as `○ Implement #2 ← #1`, while independent
tasks remain unnumbered. The tool call itself remains a compact progress
confirmation. Completed tasks stay
visible for the current response, then are automatically removed before the
next response unless unfinished work still depends on them. Exact state follows
Pi session branches, survives reloads, and is checkpointed back into model
context after compaction. See the [todo package documentation](extensions/todo/README.md)
for the schema.

## Development

The repository uses a private root package as a Bun 1.3.14 workspace. Each
extension directory is independently publishable. Extensions with configurable
values depend on the small `pi-shared-settings` infrastructure package.

```bash
bun install --frozen-lockfile
bun run build:all
bun run check
bun run pack:check
```

Each extension and the shared runtime helper bundle their local TypeScript
modules into `dist/index.ts` before npm packing. Keeping the bundled entrypoint
as TypeScript lets Pi resolve peer imports against its active runtime, which is
required by extensions that patch TUI classes. Pi core packages and runtime
dependencies remain external. The `prepack` lifecycle runs the build for package
validation and publishing. Use `build:extensions` for `extensions/`,
`build:packages` for `packages/`, and `build:all` for both groups.

Load an extension directly from TypeScript while developing:

```bash
pi -e ./extensions/background-tasks/index.ts
pi -e ./extensions/cursor-effect/index.ts
pi -e ./extensions/ssh-remote/index.ts --ssh devbox:/srv/project
pi -e ./extensions/thinking-fold/index.ts
pi -e ./extensions/todo/index.ts
```

Repository layout:

```text
extensions/
├── background-tasks/
│   ├── index.ts
│   ├── package.json
│   └── README.md
├── cursor-effect/
│   ├── index.ts
│   ├── config.ts
│   ├── package.json
│   └── README.md
├── pwsh-adapter/
│   ├── index.ts
│   ├── package.json
│   └── README.md
├── ssh-remote/
│   ├── index.ts
│   ├── client.ts
│   ├── operations.ts
│   ├── package.json
│   └── README.md
├── thinking-fold/
│   ├── index.ts
│   ├── renderer.ts
│   ├── config.ts
│   ├── model-behaviors.ts
│   ├── model-behaviors.json
│   ├── package.json
│   └── README.md
└── todo/
    ├── index.ts
    ├── state.ts
    ├── package.json
    └── README.md
packages/
├── shared-settings/
│   ├── index.ts
│   ├── sectioned-settings-list.ts
│   ├── package.json
│   └── README.md
└── workspace-files/
    ├── index.ts
    ├── package.json
    └── README.md
tests/
├── background-tasks.test.ts
├── cursor-effect.test.ts
├── shared-settings.test.ts
├── workspace-files.test.ts
├── ssh-remote.test.ts
├── ssh-remote-windows-integration.test.ts
├── thinking-fold.test.ts
├── todo.test.ts
├── README.md
└── packages.test.ts
e2e/
├── README.md
├── remote-windows-smoke.ts
└── local-windows-smoke.ts
```

Windows-specific verification needs a live Windows SSH host and is documented
next to the code, not here:

- [tests/README.md](tests/README.md) — unit vs integration layout, and how to
  run the Windows integration suite (`PI_SSH_TEST_HOST` / `PI_SSH_TEST_SHELL`).
- [e2e/README.md](e2e/README.md) — end-to-end smoke scripts for both
  directions: `remote-windows-smoke.ts` (Pi on Linux/macOS → Windows remote)
  and `local-windows-smoke.ts` (Pi running on Windows), no model required.

## Automated npm releases

The [publish workflow](.github/workflows/publish.yml) uses npm Trusted
Publishing with GitHub Actions OIDC. It does not require an `NPM_TOKEN` GitHub
secret.

Before the first automated release, configure a Trusted Publisher separately
for all nine npm packages:

- Provider: GitHub Actions
- Organization or user: `99percentpeople`
- Repository: `pi-extensions`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

Release tags are package-specific because the packages are versioned
independently:

| Package | Tag format | Example |
| --- | --- | --- |
| background-tasks | `background-tasks-v<version>` | `background-tasks-v1.2.2` |
| codex-api | `codex-api-v<version>` | `codex-api-v0.2.2` |
| cursor-effect | `cursor-effect-v<version>` | `cursor-effect-v0.1.0` |
| pwsh-adapter | `pwsh-adapter-v<version>` | `pwsh-adapter-v1.0.6` |
| ssh-remote | `ssh-remote-v<version>` | `ssh-remote-v0.1.0` |
| thinking-fold | `thinking-fold-v<version>` | `thinking-fold-v0.1.0` |
| todo | `todo-v<version>` | `todo-v1.2.0` |
| shared-settings | `shared-settings-v<version>` | `shared-settings-v0.1.0` |
| workspace-files | `workspace-files-v<version>` | `workspace-files-v0.1.0` |

Publish shared library packages before releasing an extension that requires a
newer version of them.

To publish a release:

1. Update the selected package's `version` in `package.json` and update its
   package README when needed.
2. Run `bun run pack:check` and commit the release changes.
3. Push the commit, then create and push the matching tag:

```bash
git tag background-tasks-v1.1.3
git push origin master background-tasks-v1.1.3
```

The workflow rejects a tag whose version does not exactly match the selected
package's `package.json`.

## Uninstall

```bash
pi remove npm:@99percentpeople/pi-background-tasks
pi remove npm:@99percentpeople/pi-cursor-effect
pi remove npm:@99percentpeople/pi-pwsh-adapter
pi remove npm:@99percentpeople/pi-ssh-remote
pi remove npm:@99percentpeople/pi-thinking-fold
pi remove npm:@99percentpeople/pi-todo
```

## License

MIT
