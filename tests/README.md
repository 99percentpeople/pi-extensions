# tests — automated test suites

Unit and integration tests run with Node's built-in test runner (`node --test`
via `tsx`). The repo root wires them up:

```bash
bun run check            # privacy scan + lint (tsc) + all unit tests
bun run test             # unit tests only
bun run test:integration # Windows integration tests (see below)
```

## Layout

- `*.test.ts` — unit tests. Most use fake SSH executors, in-memory harnesses,
  and pure-function assertions. `ssh-remote.test.ts` also runs a localhost
  OpenSSH background-control matrix when key-authenticated localhost SSH is
  available; it skips automatically otherwise. The suite covers adapters,
  OpenSSH multiplexing and task leases, persistent ssh2 channels, recursive
  ProxyJump/config compatibility, path mapping, session state, provider
  routing, transport-loss cleanup, Unix pipe/PTY signals, and Windows process
  tree command generation. `pwsh-adapter.test.ts` covers bounded exit/close,
  timeout, abort, taskkill failure/hang, cwd error classification, partial
  output, and race handling;
  Windows CI also executes its real inherited-stdio regression fixture and the
  real local PowerShell/taskkill tree test in `ssh-remote.test.ts`.
- `ssh-remote-windows-integration.test.ts` — integration tests against a real
  Windows host over OpenSSH. They are **skipped automatically** when no host
  is configured, so `bun run check` stays safe in CI.

## Test data privacy

Use fixed fictional users, paths, hosts, emails, and documentation-reserved IP
ranges in committed tests and examples. Never paste local SSH configuration or
machine-specific values into a fixture. `bun run check:privacy` scans tracked
and unignored files under `tests/` and `e2e/` without printing matched values;
it is also the first stage of `bun run check`.

## Windows integration tests

Enable them with environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `PI_SSH_TEST_HOST` | yes | SSH alias or `user@host`; optionally `user@host:path` to select the remote cwd |
| `PI_SSH_TEST_SHELL` | no | `auto` (default — probes bash → pwsh → powershell), `pwsh`, `powershell`, `bash` |

```bash
PI_SSH_TEST_HOST=user@host PI_SSH_TEST_SHELL=pwsh bun run test:integration
```

The suite covers: adapter probing and workspace inspection; unicode, CRLF and
binary file round trips; fileExists/access; listDirectory, findEntries and
grep (literal/regex/glob/single-file); runShell exit codes, stdout streaming,
unicode output and the no-options call path; the gzip transport for long
commands; stderr CLIXML cleanliness; and timeout aborts. A scratch directory
(`pi-ssh-integration` under the remote user's home) is created and cleaned up
automatically.

For a standalone end-to-end smoke script (no test runner, 36 checks, exit
codes), see [e2e/README.md](../e2e/README.md).
