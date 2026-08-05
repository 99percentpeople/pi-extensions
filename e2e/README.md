# e2e — SSH Remote smoke tests

Standalone end-to-end verification for the
[ssh-remote](../extensions/ssh-remote/README.md) extension. No model is
involved: the scripts drive the adapters over a real OpenSSH connection and
exercise the same operations the routed tools use.

| Scenario | Script | Where it runs |
| --- | --- | --- |
| A: Pi on Linux/macOS → **Windows remote** | [remote-windows-smoke.ts](remote-windows-smoke.ts) | any machine with Bun + SSH access to a Windows host |
| B: **Pi running on Windows** → any remote | [local-windows-smoke.ts](local-windows-smoke.ts) | the Windows machine itself (default target: `localhost`) |

Automated integration tests (Node test runner, auto-skip without a host) live
in [tests/README.md](../tests/README.md).

---

## Scenario A — remote Windows host

`remote-windows-smoke.ts` verifies the complete adapter surface: probing, path
encoding, file read/write (unicode + binary), ls/find/grep, shell execution,
streaming, and the gzip transport for long commands.

### Prerequisites

- A Windows host with OpenSSH Server and PowerShell 7 (`pwsh`) or
  Windows PowerShell 5.1 (`powershell`).
- SSH access configured from this machine: a `~/.ssh/config` alias (or
  `user@host`) with key-based authentication. See the extension's
  [OpenSSH configuration notes](../extensions/ssh-remote/README.md).
- No build step: the script runs the adapter TypeScript sources directly with
  Bun (the adapter chain only imports Node built-ins).

### Usage

```bash
bun run e2e/remote-windows-smoke.ts <host> [shell]
```

| Argument | Description |
| --- | --- |
| `host` | SSH alias or `user@host`; optionally `user@host:path` to start in a specific remote directory |
| `shell` | `auto` (default — probes bash → pwsh → powershell), `pwsh`, `powershell`, or `bash` |

The host can also come from `PI_SSH_TEST_HOST`:

```bash
PI_SSH_TEST_HOST=user@host bun run test:e2e
```

Examples:

```bash
bun run e2e/remote-windows-smoke.ts devbox              # auto-detect the remote shell
bun run e2e/remote-windows-smoke.ts devbox pwsh         # force PowerShell 7
bun run e2e/remote-windows-smoke.ts devbox powershell   # force Windows PowerShell 5.1
```

### Checks and exit codes

Covers path encoding (drive/UNC round trips, win32-local form), adapter
selection, mkdir/write/read (unicode, CRLF, binary), fileExists/access,
listDirectory, findEntries (globs, recursion, `.git`/`node_modules` skip),
grep (literal, regex, glob, single-file), runShell (exit codes, streaming,
interactive invocation, unicode output), the gzip transport, the
encoded-command size guard, and stderr CLIXML cleanliness on PowerShell 5.1.

Each check prints `ok <name>` / `FAIL <name>`; the run ends with
`== RESULT: N passed, M failed ==`. Exit codes: `0` all passed, `1` failed
checks, `2` usage error. A scratch directory is created under the remote
user's home and removed afterwards.

---

## Scenario B — Pi running on Windows

When Pi itself runs on Windows, `auto` uses one persistent `ssh2` connection;
explicit OpenSSH mode remains single-use because native `ssh.exe` has no
reliable ControlMaster support. The OpenSSH client also requires temp-file
stdio because anonymous pipes wedge `ssh.exe` (see `client.ts`). This scenario
exercises both transports, the win32 logical path namespace
(`C:\__pi_ssh_remote_windows__\...`), and the interactive session surface
(status bar, `/ssh-connect`, `/ssh-exit`, `/ssh-cd`, `/ssh-status`,
`/ssh-reconnect`, and `!` commands).

### Prerequisites (on the Windows machine)

- Pi installed (`bun add -g @earendil-works/pi-coding-agent`), OpenSSH Server
  running, and PowerShell 7 or Windows PowerShell 5.1.
- The extension build and its production `ssh2` dependency copied to the
  machine (or run from a clone of this repo). If `node_modules` contains
  workspace symlinks, replace them with real
  copies of the `packages/*` sources — tar-created symlinks fail with `EPERM`
  on Windows.
- Loopback SSH auth for `--ssh localhost`:
  `ssh-keygen -t ed25519 -f %USERPROFILE%\.ssh\id_e2e`, append `id_e2e.pub` to
  `authorized_keys` (admin users also need
  `C:\ProgramData\ssh\administrators_authorized_keys`), add a
  `Host localhost` block to `~/.ssh/config` pointing at `id_e2e`, then verify
  with `ssh -o BatchMode=yes localhost ver`.
- Model credentials (`~/.pi/agent/auth.json`) for the interactive checks.

### 1. Adapter smoke (no model needed)

```powershell
bun run e2e\local-windows-smoke.ts localhost pwsh
```

Expected: probe, mkdir, write/read (unicode + binary), fileExists, access,
listDirectory, findEntries, grep, runShell (exit codes, streaming), and the
long-command gzip path all pass in ~1s per operation.

### 2. Interactive model session

```powershell
pi -e <path-to-extension>\dist\index.ts `
  --ssh localhost:C:\Users\<you>\remote-test-dir --ssh-shell pwsh `
  --ssh-transport auto
```

| Step | Expected |
| --- | --- |
| Status bar | `SSH: Connected` (green) |
| `/ssh-status` | target/platform/shell/transport/cwd/home; transport is `ssh2 (reused)` |
| `! Get-Location; whoami` | executes on the remote (remote cwd + remote user) |
| Ask the model to read/write/edit/bash/grep/find/ls | results land on the remote filesystem |
| `/ssh-cd C:\Users\<you>\remote-test-dir\child` | cwd changes without a new foreground client and later tools use the child directory |
| `/ssh-exit` | status clears and later tools use the local Pi cwd |
| `/ssh-connect localhost:C:\Users\<you>\remote-test-dir` | the same conversation returns to SSH |
| `/ssh-connect <second-host>:<path>` while connected | switches directly without `/ssh-exit`; a failed candidate leaves `localhost` active |
| Enable **AI control tools** in `/99settings` | `ssh_connect`, `ssh_exit`, `ssh_cd`, and `ssh_status` become active immediately |
| `/ssh-reconnect` | reconnects to the same target |
| Exit (`ctrl+d`) | clean shutdown, status indicator disappears |

Repeat once with `--ssh-transport openssh`; `/ssh-status` should report
`openssh (single-use)` and all operations should still pass through the
Windows temp-file stdio workaround.

For an optional password-only target, first clear cached credentials with
`/ssh-forget-password all` and leave **AI password auth** enabled in
`/99settings`, then ask the model to connect. It should warn that user input may
be required, and the password input should display a live countdown from 60
seconds. Letting it expire must fail `ssh_connect`, clear the SSH status, and
leave `/ssh-status` reporting the local workspace. Repeating the timeout while
another SSH target is active must leave that previous target connected.

Next disable **AI password auth**, clear passwords again, and repeat the model
request. No password input should open; `ssh_connect` should fail immediately
with a recommendation to configure SSH key-based login. Running `/ssh-connect`
against the same target manually must still prompt without a countdown;
cancelling or failing an initial prompt should leave the workspace
**Disconnected** for inspection or `/ssh-reconnect`.

### 3. Non-interactive model pass

```powershell
pi -p --no-session -e <path-to-extension>\dist\index.ts `
  --ssh localhost:C:\Users\<you>\remote-test-dir --ssh-shell pwsh `
  "Use the ls tool to list the directory and reply with its contents."
```

### Known Windows pitfalls (all fixed in the extension)

1. **ssh.exe wedges with anonymous pipes.** This affects explicit OpenSSH,
   auto fallback, and background jobs—not persistent `ssh2`. The Windows OpenSSH client stops
   exiting after the remote command produces output when spawned with piped
   stdio. `OpenSshClient` uses temp-file stdio on Windows (`-n` + stdin file
   for input, stdout/stderr files polled for streaming). Do not revert to
   pipes for the Windows client.
2. **Force-killing ssh sessions leaves wedged sessions.** Repeated
   `kill -9`/timeout aborts can orphan `ssh.exe`/`pwsh`/`conhost` processes
   that make later sessions hang even with the fix. Clean up stray processes,
   or restart the sshd service if sessions start hanging.
3. **Workspace symlinks don't survive tar/zip copies** (bun workspace links
   extract as broken reparse points on Windows). Copy the `packages/*` sources
   as real directories when shipping the extension to a Windows box.
