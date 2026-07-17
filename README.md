# Pi Extensions

Two independently published TypeScript extensions for the
[Pi coding agent](https://pi.dev/).

| Extension | npm package | Purpose |
| --- | --- | --- |
| background-tasks | [`@99percentpeople/pi-background-tasks`](https://www.npmjs.com/package/@99percentpeople/pi-background-tasks) | Background commands, explicit waits, logs, signals, and optional PTY/TUI interaction |
| pwsh-adapter | [`@99percentpeople/pi-pwsh-adapter`](https://www.npmjs.com/package/@99percentpeople/pi-pwsh-adapter) | PowerShell 7 and Windows PowerShell 5.1 adapter for Pi on Windows |

The packages have separate versions and releases. Installing background-tasks
does not install or enable the Windows-only PowerShell adapter.

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

## background-tasks

Tools:

- `bg_start` starts a pipe or PTY background task.
- `bg_wait` waits once for a finite task to finish or time out.
- `bg_status` inspects one task or lists known tasks.
- `bg_logs` reads pipe output or a parsed PTY terminal snapshot.
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
`<C-c>`, `<Enter>`, `<Up>`, and `<F10>`. Escape a literal `<` as `\<`.
PTY snapshots are opt-in on status, wait, and kill results and are collapsed
in Pi's TUI by default.

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

## Development

The repository is a private Bun 1.3.14 workspace. Each extension directory is
an independently publishable npm package.

```bash
bun install --frozen-lockfile
bun run check
bun run pack:check
```

Load an extension directly while developing:

```bash
pi -e ./extensions/background-tasks/index.ts
```

Repository layout:

```text
extensions/
├── background-tasks/
│   ├── index.ts
│   ├── package.json
│   └── README.md
└── pwsh-adapter/
    ├── index.ts
    ├── package.json
    └── README.md
tests/
├── background-tasks.test.ts
└── packages.test.ts
```

## Automated npm releases

The [publish workflow](.github/workflows/publish.yml) uses npm Trusted
Publishing with GitHub Actions OIDC. It does not require an `NPM_TOKEN` GitHub
secret.

Before the first automated release, configure a Trusted Publisher separately
for both npm packages:

- Provider: GitHub Actions
- Organization or user: `99percentpeople`
- Repository: `pi-extensions`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

Release tags are package-specific because the packages are versioned
independently:

| Package | Tag format | Example |
| --- | --- | --- |
| background-tasks | `background-tasks-v<version>` | `background-tasks-v1.0.3` |
| pwsh-adapter | `pwsh-adapter-v<version>` | `pwsh-adapter-v1.0.1` |

To publish a release:

1. Update the selected package's `version` in `package.json` and update its
   package README when needed.
2. Run `bun run pack:check` and commit the release changes.
3. Push the commit, then create and push the matching tag:

```bash
git tag background-tasks-v1.0.3
git push origin master background-tasks-v1.0.3
```

The workflow rejects a tag whose version does not exactly match the selected
package's `package.json`.

## Uninstall

```bash
pi remove npm:@99percentpeople/pi-background-tasks
pi remove npm:@99percentpeople/pi-pwsh-adapter
```

## License

MIT
