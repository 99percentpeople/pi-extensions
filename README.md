# Pi Extensions

[![CI](https://github.com/99percentpeople/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/99percentpeople/pi-extensions/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/99percentpeople/pi-extensions)](LICENSE)
[![background-tasks](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-background-tasks?label=background-tasks)](https://www.npmjs.com/package/@99percentpeople/pi-background-tasks)
[![codex-api](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-codex-api?label=codex-api)](https://www.npmjs.com/package/@99percentpeople/pi-codex-api)
[![cursor-effect](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-cursor-effect?label=cursor-effect)](https://www.npmjs.com/package/@99percentpeople/pi-cursor-effect)
[![pwsh-adapter](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-pwsh-adapter?label=pwsh-adapter)](https://www.npmjs.com/package/@99percentpeople/pi-pwsh-adapter)
[![thinking-fold](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-thinking-fold?label=thinking-fold)](https://www.npmjs.com/package/@99percentpeople/pi-thinking-fold)
[![todo](https://img.shields.io/npm/v/%4099percentpeople%2Fpi-todo?label=todo)](https://www.npmjs.com/package/@99percentpeople/pi-todo)

A focused collection of TypeScript extensions for the
[Pi coding agent](https://pi.dev/): run and revisit background tasks, expose
Codex subscription image and search APIs, style the main session status cursors,
use PowerShell consistently on Windows, fold long reasoning traces, and keep
model-authored plans visible in the TUI.

| Extension | npm package | Purpose |
| --- | --- | --- |
| background-tasks | [`@99percentpeople/pi-background-tasks`](https://www.npmjs.com/package/@99percentpeople/pi-background-tasks) | Background commands, explicit waits, logs, signals, and optional PTY/TUI interaction |
| codex-api | [`@99percentpeople/pi-codex-api`](https://www.npmjs.com/package/@99percentpeople/pi-codex-api) | Codex OAuth image generation/editing, first-party search, Fast mode, and subscription usage status |
| cursor-effect | [`@99percentpeople/pi-cursor-effect`](https://www.npmjs.com/package/@99percentpeople/pi-cursor-effect) | Selectable effects for Pi's working, retry, compaction, and branch-summary cursors |
| pwsh-adapter | [`@99percentpeople/pi-pwsh-adapter`](https://www.npmjs.com/package/@99percentpeople/pi-pwsh-adapter) | PowerShell 7 and Windows PowerShell 5.1 adapter for Pi on Windows |
| thinking-fold | [`@99percentpeople/pi-thinking-fold`](https://www.npmjs.com/package/@99percentpeople/pi-thinking-fold) | Live tail previews for long reasoning traces with full summaries and Ctrl+T expansion |
| todo | [`@99percentpeople/pi-todo`](https://www.npmjs.com/package/@99percentpeople/pi-todo) | Minimal atomic whole-plan todo writes with dependencies and a read-only list above the input |

The packages have separate versions and releases. Installing one extension does
not install or enable any of the others.

## Shared settings

Installing any extension in this collection enables one configuration command:

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
  "thinking-fold": {
    "foldThreshold": 5,
    "streamingBehavior": "auto",
    "completedBehavior": "auto"
  }
}
```

Operational commands such as `/bg-attach` and `/bg-kill` remain separate.

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
Same-task calls in one model response execute in source order, so
`bg_wait → bg_logs` waits before reading output while different task chains can
run in parallel. The same sequence works for pipe and PTY tasks.

PTY support uses `node-pty`. If no compatible native binary is available,
installation may require a C/C++ toolchain. See the
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

## codex-api

`codex-api` reuses Pi's existing ChatGPT subscription OAuth to expose
`codex_image` and `codex_search`, without an OpenAI API key or MCP server. It
also provides settings-controlled Fast mode for the priority service tier and
`/codex-usage` for current subscription usage windows and credits. Image
outputs are saved as non-overwriting PNG files and returned to the model for
follow-up inspection. Search supports web and image queries, page navigation,
PDF screenshots, finance, weather, sports, and time operations. Auto search lets
the AI choose Cached, Indexed, or Live per call, while fixed user modes always
win. Configure Fast, search mode, search context size, and usage status through
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
It participates in the shared settings runtime but stays hidden from `/99settings`
until it exposes configurable values.
A read-only widget above the input shows the current task when collapsed and the
complete list when expanded with Pi's standard `Ctrl+O` binding. Task keys stay
model-only; tasks participating in dependencies receive compact, display-only
numbers after their names, such as `○ Implement #2 ← #1`, while independent
tasks remain unnumbered. The tool call itself remains a compact progress
confirmation. Completed tasks stay
visible for the current response, then are automatically removed before the
next response unless unfinished work still depends on them. Exact state follows
Pi session branches, survives reloads, and is checkpointed back into model
context after compaction. See the [todo package documentation](extensions/todo/README.md)
for the schema.

## Development

The repository uses a private root package as a Bun 1.3.14 workspace. Each
extension directory is independently publishable and depends on the small
`pi-shared-settings` infrastructure package.

```bash
bun install --frozen-lockfile
bun run build:all
bun run check
bun run pack:check
```

Each extension and the shared runtime helper bundle their local TypeScript
modules into `dist/index.js` before npm packing. Pi core packages and runtime
dependencies remain external. The `prepack` lifecycle runs this build for both
package validation and publishing. Use `build:extensions` for `extensions/`,
`build:packages` for `packages/`, and `build:all` for both groups.

Load an extension directly from TypeScript while developing:

```bash
pi -e ./extensions/background-tasks/index.ts
pi -e ./extensions/cursor-effect/index.ts
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
└── shared-settings/
    ├── index.ts
    ├── sectioned-settings-list.ts
    ├── package.json
    └── README.md
tests/
├── background-tasks.test.ts
├── cursor-effect.test.ts
├── shared-settings.test.ts
├── thinking-fold.test.ts
├── todo.test.ts
└── packages.test.ts
```

## Automated npm releases

The [publish workflow](.github/workflows/publish.yml) uses npm Trusted
Publishing with GitHub Actions OIDC. It does not require an `NPM_TOKEN` GitHub
secret.

Before the first automated release, configure a Trusted Publisher separately
for all six npm packages:

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
| cursor-effect | `cursor-effect-v<version>` | `cursor-effect-v0.1.0` |
| pwsh-adapter | `pwsh-adapter-v<version>` | `pwsh-adapter-v1.0.2` |
| thinking-fold | `thinking-fold-v<version>` | `thinking-fold-v0.1.0` |
| todo | `todo-v<version>` | `todo-v1.2.0` |
| shared-settings | `shared-settings-v<version>` | `shared-settings-v0.1.0` |

Publish `shared-settings` before releasing an extension that requires a newer
shared-settings version.

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
pi remove npm:@99percentpeople/pi-thinking-fold
pi remove npm:@99percentpeople/pi-todo
```

## License

MIT
