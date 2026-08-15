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

This profile never uses the persistent DSH shell: on POSIX its compatibility
wrapper delegates to an active SSH Bash backend or Pi's normal local Bash
implementation, while PowerShell Adapter remains untouched on Windows. It is
the interoperable approximation, not the DSH schema contract.

### `exact-dsh`

Reproduces the model-facing DSH bootstrap contract more closely:

- complete system prompt fixed for the session to `You are a helpful software engineer assistant.`;
- exactly `bash` and `str_replace_editor` in the bootstrap payload;
- DSH-compatible names, descriptions, JSON schemas, and editor output;
- a per-session persistent local Bash process during bootstrap;
- the compatibility editor is removed when the normal Pi catalog returns.

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

The default `anchored/session` lifecycle is:

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

The experimental `prompt` scope restages the bootstrap tool catalog for every
user prompt while retaining both the complete system anchor and prior
conversation history. It is useful for ablation, but it is not equivalent to a
fresh DSH task session.

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

Select **DeepSeek Anchor** and configure:

| Setting | Values | Default |
| --- | --- | --- |
| Profile | Pi native, Exact DSH | Pi native |
| Mode | Anchored, Minimal, Off | Anchored |
| Anchor scope | Session first, Every prompt | Session first |
| Bootstrap tools | bash + edit, bash + read | bash + edit |

Anchored mode keeps the complete profile system prompt for the session and
stages the minimal tool catalog only until the bootstrap tool batch completes.
Minimal mode keeps both that prompt and the minimal tool catalog for every
request. Anchor scope appears only in Anchored mode; Bootstrap tools appears
only in the Pi-native profile. Exact DSH keeps its prompt and bootstrap schemas
immutable. Changes are persisted and applied immediately. If a profile change
makes the current non-empty conversation ineligible, the settings notification
asks for `/new` instead of silently re-anchoring old history.

Configuration shares the repository-wide settings file:

```text
~/.pi/agent/99extensions.json
```

under the `deepseek-anchor` namespace. Advanced fields such as the exact target
model and native complete system prompt remain normal namespaced JSON settings.
Runtime tool snapshots stay session-local and are never written to global
settings.

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
