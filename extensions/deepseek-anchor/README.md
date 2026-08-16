# @99percentpeople/pi-deepseek-anchor

**English** | [简体中文](README.zh-CN.md)

Experimental DeepSeek V4 Pro request anchoring for the [Pi coding agent].

DeepSeek Anchor recreates the model-facing shape of DeepSeek Harness (DSH)
minimal mode's first request inside Pi. Its purpose is to start V4 Pro on a more
effective, training-aligned tool-use trajectory and thereby improve agent task
performance—not merely to make visible reasoning appear.

The extension starts a new session with a minimal tool scaffold, then restores
Pi's complete tool catalog after the bootstrap tool batch while keeping the
profile's complete system prompt as a session-wide anchor. The default
`pi-native` profile is the interoperable approximation; `exact-dsh` reproduces
the DSH bootstrap prompt and schemas more closely. Results remain task- and
environment-dependent, and the extension cannot guarantee a performance gain
or select a server-side route.

## Why

A Project2 V4.1b harness analysis reported that DeepSeek V4 Pro was unusually
sensitive to the first request's system prompt and tool schemas. The official
DeepSeek Harness (DSH) minimal preset calls its one-sentence prompt plus
persistent `bash` and `str_replace_editor` schemas the “exact RL prompt and
schemas.” A separate `anchored-standard` experiment retained the minimal
complete system prompt, restored the larger tool catalog after the first tool
call, and retained the stronger trajectory.

DeepSeek Anchor applies that client-side induction recipe in Pi: align the
first request with DSH minimal mode, let the initial tool policy form, then
restore the broader Pi tool catalog without dropping the complete prompt
anchor. It changes request structure; it does not change model weights,
guarantee hidden reasoning, select a server route, or guarantee task outcomes.

References:

- [DeepSeek V4 Pro harness analysis]
- [DSH minimal preset at the audited commit]
- [DSH minimal request snapshot]

## Profiles

### `pi-native` (default)

Uses Pi's normal tools during execution:

- fixed or user-configured one-sentence complete system prompt on every eligible request;
- `bash` and `edit` by default, with their existing Pi schemas during bootstrap;
- full pre-bootstrap active tool set restored after the bootstrap tool batch.

This profile never registers the DSH Bash wrapper, so Pi's own `bash` tool is
left untouched, including any configured `shellPath` or `shellCommandPrefix`
settings. It never uses the persistent DSH shell, and the PowerShell Adapter
keeps owning Bash on Windows. It is the interoperable approximation, not the
DSH schema contract.

### `exact-dsh`

Reproduces the model-facing DSH bootstrap contract more closely:

- complete system prompt fixed for the session to `You are a helpful software engineer assistant.`;
- exactly `bash` and `str_replace_editor` in the bootstrap payload;
- DSH-compatible names, descriptions, JSON schemas, and editor output;
- a per-session persistent local Bash process during bootstrap;
- the compatibility editor is removed when the normal Pi catalog returns.

The Bash compatibility wrapper is only registered while this profile is
enabled. Outside exact bootstrap it delegates to an active SSH Bash backend or
rebuilds Pi's normal local Bash with the host's `shellPath` and
`shellCommandPrefix` settings, so ordinary Bash calls keep Pi's configured
behavior. If another extension owns the `bash` or `str_replace_editor` tool
name, activation is refused instead of advertising DSH schemas while executing
a foreign implementation.

`exact-dsh` is POSIX-only. Its bootstrap uses the local filesystem and is
refused while another extension delegates Bash to a remote or unavailable
environment. Outside exact bootstrap, the wrapper follows an active SSH Bash
delegate or falls back to Pi's normal local Bash tool. PowerShell Adapter keeps
owning Bash on Windows, where only `pi-native` is available.

This is exact at the bootstrap prompt/schema boundary and keeps the exact
complete prompt afterward, but it is not a complete copy of the DSH runtime.
In particular, the extension does not reproduce DSH service routing, disable Pi
auto-compaction, enforce DSH's network/package-mirror claims, or add a
filesystem sandbox. The persistent shell and absolute-path editor run with the
same OS permissions as Pi.

Settings apply immediately without reloading. Gates are profile-specific, so
use `/new` after changing profiles once a conversation already contains
messages.

## Lifecycle

The default Anchored-mode lifecycle is:

1. Require the configured provider/model and a fresh conversation.
2. Record a profile/model-specific gate in the active session branch.
3. Before the first agent run, save the exact active tool set and expose only
   the profile's bootstrap tools.
4. Canonicalize the provider payload to one complete profile system instruction
   and the selected bootstrap tool catalog.
5. Keep the catalog stable for all sibling calls in that tool batch.
6. At `turn_end`, restore the saved tools before Pi prepares the next request.
7. Continue canonicalizing every later provider request to the same complete
   system instruction while leaving the restored tool catalog intact.
8. Persist the anchored phase so `/reload` and resume restore the full catalog
   without dropping the system anchor or repeating the bootstrap restriction.

If the first response contains no tool call, the session remains in bootstrap
until a later bootstrap response calls a tool. Tool restrictions are always
restored on model mismatch, disable, session replacement, reload, or shutdown.

Tool staging is fixed to the session: the catalog changes once (bootstrap →
anchored) per session, so the complete system prompt and the post-bootstrap
tool catalog stay stable across later requests.

## Thinking level

The reference runs used `max` thinking. DeepSeek Anchor never changes the user's
thinking level automatically. It emits one warning when an eligible run uses a
different level.

## Install

```bash
pi install npm:@99percentpeople/pi-deepseek-anchor
```

For source development:

```bash
pi -e ./extensions/deepseek-anchor/index.ts
```

Start a new session with the target model after installation:

```text
/model deepseek/deepseek-v4-pro
/new
```

## Settings

DeepSeek Anchor intentionally registers no private slash command. Open the
shared settings menu instead:

```text
/99settings
```

Select **DeepSeek Anchor**. Each option is described below, including what it
changes and which other options it affects:

| Setting | What it controls | Values | Default | Visible when |
| --- | --- | --- | --- | --- |
| Profile | Which bootstrap contract and system anchor shape eligible requests. | Pi native, Exact DSH | Pi native | Always |
| Mode | Whether and when the minimal bootstrap catalog is staged, or whether requests are left untouched. | Anchored, Minimal, Off | Anchored | Always |
| Bootstrap tools | Which Pi tools the pi-native bootstrap request exposes. | bash + edit, bash + read | bash + edit | Pi native only |

### Profile

- **Pi native** — uses Pi's own `bash` and `edit` (or configured) schemas for
  the bootstrap request and injects `nativeSystemPrompt` as the session-long
  system anchor. It never registers the DSH Bash wrapper and never uses the
  persistent DSH shell.
- **Exact DSH** — mirrors the DSH minimal preset more strictly: fixed
  `You are a helpful software engineer assistant.` system prompt, DSH
  `bash` + `str_replace_editor` schemas and editor output, and a persistent
  local Bash process during bootstrap. Requires POSIX and a local Bash backend
  (an SSH Bash delegate makes the profile refuse to activate).

Related options: `Bootstrap tools` only affects Pi native; Exact DSH keeps its
prompt and bootstrap tools immutable. Gates are profile-specific — changing
Profile in a conversation that already contains messages requires `/new` for
the new profile to take effect.

### Mode

- **Anchored** (default) — start with the profile's minimal bootstrap tool
  catalog, keep the complete profile system prompt for the whole session, and
  restore Pi's full tool catalog after the first bootstrap response that calls
  a tool. Once expanded, the catalog stays expanded for the rest of the
  session.
- **Minimal** — keep the minimal bootstrap catalog (and the complete profile
  system prompt) for every provider request. The catalog never expands; use it
  to compare the minimal trajectory against full Pi tools.
- **Off** — leave provider payloads and Pi's active tool catalog untouched.
  This is the clean baseline for A/B comparisons. The full tool catalog is
  restored immediately.

Related options: `Bootstrap tools` remains visible for Pi native even in Off
so you can prepare a baseline before switching the mode back on.

### Bootstrap tools

- **bash + edit** (default) — the two-tool pair closest to the DSH minimal
  bootstrap while still using Pi's normal schemas.
- **bash + read** — an inspection-oriented variant: read files during
  bootstrap while deferring Pi's dedicated file-editing tools until the full
  catalog returns.

The JSON field `nativeBootstrapTools` accepts any registered Pi tool names
(e.g. `["bash", "read", "grep"]`). If a configured tool is not registered or is
missing from the provider payload, the extension restores the full catalog and
refuses to shape that request instead of sending an incomplete bootstrap.

Related options: Exact DSH ignores this setting and always bootstraps with
`bash` + `str_replace_editor`. The setting is shown for Pi native even when
Mode is Off, but it only changes requests when Mode is Anchored or Minimal.

### Advanced JSON fields

Configuration shares the repository-wide settings file:

```text
~/.pi/agent/99extensions.json
```

under the `deepseek-anchor` namespace:

```json
{
  "deepseek-anchor": {
    "version": 1,
    "profile": "pi-native",
    "mode": "anchored",
    "targetProvider": "deepseek",
    "targetModelId": "deepseek-v4-pro",
    "nativeBootstrapTools": ["bash", "edit"],
    "nativeSystemPrompt": "You are a helpful software engineer assistant."
  }
}
```

| Field | Purpose |
| --- | --- |
| `version` | Namespace schema version; keep at `1`. |
| `profile` / `mode` | Same values as the `/99settings` menu. |
| `targetProvider` | Provider part of the model gate; only this provider is eligible. |
| `targetModelId` | Model-id part of the gate; the provider payload model must also match this id. |
| `nativeBootstrapTools` | Pi tool names exposed by the Pi-native bootstrap request; ignored by Exact DSH. |
| `nativeSystemPrompt` | Complete system instruction injected into every eligible Pi-native request; Exact DSH uses the fixed DSH prompt. |

Missing or invalid fields normalize back to defaults when the extension loads.
Menu changes are saved and applied immediately; edits made directly to the
JSON file are picked up on the next extension reload or session. Runtime tool
snapshots stay session-local and are never written to this file.

## Debugging

```bash
DEEPSEEK_ANCHOR_DEBUG=1 pi -e ./extensions/deepseek-anchor/index.ts
```

Debug logs include request phase, selected tool names, the canonical complete
system prompt, and at most the first 120 characters of the first visible
reasoning block.
Reasoning logs may contain sensitive project data; enable them only for an
intentional experiment.

## Experimental cautions

- Treat visible reasoning style as a trajectory diagnostic, not the target of
  anchoring and not proof of higher ability or access to hidden chain-of-thought.
- Compare profiles in separate fresh sessions with the same model, thinking
  level, task, workspace, and evaluation procedure.
- A later-loaded `before_provider_request` extension can still mutate the final
  payload. Use a minimal extension set for strict request snapshots.
- The DSH-facing shell description is reproduced for schema fidelity, but this
  extension does not enforce its network or package-mirror statements.
- `str_replace_editor` accepts absolute paths and can read or mutate files
  outside the workspace. Install only in environments where Pi already has the
  intended filesystem access.

## Development

```bash
bun run lint
node --import tsx --test --test-isolation=process tests/deepseek-anchor.test.ts
bun run --cwd extensions/deepseek-anchor build
bun pm pack --dry-run --cwd dist/deepseek-anchor
```

## License

MIT

[Pi coding agent]: https://pi.dev/
[DeepSeek V4 Pro harness analysis]: https://github.com/xiaobright/modeltest/blob/main/docs/v4.1/DEEPSEEK_V4_PRO_HARNESS_ANALYSIS_20260814.md
[DSH minimal preset at the audited commit]: https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/minimal/agent.cordis.yml
[DSH minimal request snapshot]: https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/web/tests/minimal-preset.snapshot.ts
