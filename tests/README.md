# tests — automated test suites

Unit and integration tests run with Node's built-in test runner (`node --test`
via `tsx`). The repo root wires them up:

```bash
bun run check            # lint (tsc) + all unit tests
bun run test             # unit tests only
bun run test:integration # Windows integration tests (see below)
```

## Layout

- `*.test.ts` — unit tests. They use fake SSH executors, in-memory harnesses,
  and pure-function assertions; no network access. `ssh-remote.test.ts` covers
  the ssh-remote extension's adapters, client, path mapping, session state,
  and background-shell resolver.
- `ssh-remote-windows-integration.test.ts` — integration tests against a real
  Windows host over OpenSSH. They are **skipped automatically** when no host
  is configured, so `bun run check` stays safe in CI.

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
