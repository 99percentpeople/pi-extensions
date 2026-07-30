# @99percentpeople/pi-codex-api

Expose first-party Codex subscription APIs as native Pi tools and commands.
The extension reuses Pi's existing `openai-codex` OAuth login and does not need
an OpenAI API key, MCP server, or separate search provider.

## Requirements

- Pi authenticated with `/login` for the `openai-codex` provider
- An active `openai-codex` model, or **Other providers** enabled in `/99settings`
- A ChatGPT workspace and plan entitled to the requested Codex feature

The extension still loads when Codex has not been configured. It does not
prompt or attempt an OAuth request during installation. A tool call instead
shows an actionable error directing you to `/login`; an expired login is
reported the same way after Pi's refresh attempt fails.

API-key authentication is intentionally rejected because these tools target the
ChatGPT subscription backend rather than metered Platform API usage.

## Install

```bash
pi install npm:@99percentpeople/pi-codex-api
```

During development:

```bash
pi install ./extensions/codex-api
```

## Tools

### `codex_image`

Generates or edits images through the Codex subscription image API using
`gpt-image-2`.

```text
codex_image prompt="A quiet neon-lit ramen shop at night"
```

For edits, provide up to five image paths inside the current workspace:

```text
codex_image \
  prompt="Change only the sky to a warm sunset" \
  referenced_image_paths=["assets/photo.png"] \
  output_path="assets/photo-sunset.png"
```

If an edit target was attached or generated in the conversation and has no
usable local path, the model can instead include the smallest necessary window
of one to five recent conversation images with `num_last_images_to_include`.
The two reference mechanisms are mutually exclusive.

The model may request a validated GPT Image 2 `WIDTHxHEIGHT` size when exact
dimensions are part of the task. It normally omits `quality`, inheriting the
user's **Image quality** preference, and only overrides it when the user
explicitly requests a draft or a quality level.

New images default to `output/codex-images/<tool-call-id>.png`. Reference and
output paths must stay inside the current workspace, and existing files are
never overwritten. The PNG is both saved locally and returned as image
content so Codex can inspect or revise it in later turns. If a network request
fails before an HTTP response, the error identifies the endpoint path and any
safe transport code (for example `ECONNRESET`). The extension itself never
retries image generation automatically, because the server may have accepted
the first request; decide whether to retry after reviewing the error.

### `codex_search`

Uses the first-party Codex standalone search API. Supported command families:

- web and image queries;
- open, click, and find operations using returned reference IDs;
- PDF page screenshots;
- finance, weather, sports, and time lookups.

Search mode is configurable as Auto, Cached, Indexed, or Live. In Auto, the AI
requests a per-call mode: Cached for stable facts and known references, Indexed
for recent documentation and announcements, and Live for same-day or real-time
information. An omitted request defaults to Indexed. Selecting a fixed mode
pins every call to that mode, regardless of the AI request. External content is
untrusted and should never be treated as instructions.

## Parameter ownership

The extension follows the current official Codex split between task intent,
user policy, and internal protocol fields:

| Owner | Search | Image |
| --- | --- | --- |
| AI per call | queries, recency, task-specific domains, navigation/lookup commands, response length, and the requested mode when Auto is enabled | prompt, local or recent-conversation references, task-specific size, explicit quality override, destination path |
| User in `/99settings` | Auto or a fixed Cached/Indexed/Live policy, plus search context size | default image quality |
| Extension/backend | session/model routing, caller policy and token ceiling | fixed `gpt-image-2`, automatic background, one PNG result, reference and dimension validation |

Model selection, batch count, output format, input fidelity, masks, moderation,
and transparent background are intentionally not advertised as AI arguments on
this subscription path. In particular, GPT Image 2 does not support native
transparent-background output; requesting transparency through an unsupported
field would be misleading.

## Bundled skill

The package also ships the Agent Skills-standard **`gpt-image-prompts`** skill
under `skills/`. Pi discovers it with the package and can load it on demand to
write or refine production-ready GPT Image 2 prompts for new images,
reference-guided work, and precise edits. Invoke it explicitly with:

```text
/skill:gpt-image-prompts
```

The skill contains visual prompt-writing guidance only. It does not select or
document tools, construct API requests, manage credentials, or prescribe file
and execution workflows.

## Tool display

Web and image queries render normalized source cards instead of the backend's
raw citation dump. The collapsed view shows three title/domain/snippet cards;
Pi's configured tool-output expansion shortcut (`Ctrl+O` by default) expands
every source with its full URL. Internal reference markers,
word-limit metadata, and separators are hidden. Open/click/find/PDF operations
use cleaned document cards. Batched navigation renders each returned page as a
separate numbered card with a short per-page preview, one shared expansion hint,
and visible warning styling for unresolved references. Weather, finance,
sports, and time lookups use a compact data view. This changes only the TUI display copy: the model
still receives the complete original search output.

Search and image parameters stream into the call row while the model constructs
them; input parameters are never repeated in the result area. Both tools also
stream real execution stages into the active result row while they run
(authentication, request, reference loading, generation, and saving as
applicable). Successful `codex_search` and `codex_image` calls also request a
rate-limited background usage refresh. The Codex search and image endpoints
return one final response, so result bodies appear atomically rather than as
fabricated content chunks.

## Commands

```text
/codex-usage
```

Fast mode is controlled only through **Codex API → Fast mode** in
`/99settings`. It sends `service_tier: "priority"` on Codex Responses requests
and can reduce latency while consuming included limits faster. The extension fetches
subscription usage directly from Codex's official ChatGPT WHAM endpoint when a
session starts or a Codex model is selected; `/codex-usage` forces a fresh
read, so no model request is required first. Automatic post-response refreshes
are limited to once per minute.

Pi does not currently publish an OAuth-account-change event or expose its
credential store to extensions. As a temporary compatibility layer, this
extension watches Pi's agent-directory `auth.json`. A short debounce reloads
the public model registry and compares the resolved Codex Account ID. After
`/login` replaces the account, the old snapshot is removed, the status changes
to `Codex syncing…`, and a forced account-scoped refresh starts. `/logout`
clears the status. In-flight requests are revision-guarded, so an old account
cannot overwrite the newly active account. The watcher is closed on session
teardown and never accesses Pi's private authentication runtime.

`/codex-usage` groups every metered limit under a simple `Codex usage` heading.
Each server-provided window (for example 5h, daily, or weekly) uses a fixed
20-cell bar whose filled portion represents remaining capacity, followed only
by `% left` and its reset time. Additional credit availability stays under the
same limit group. Inactive zero-value placeholder windows are hidden. Response
headers remain supported as a fallback.

## Settings

Use the shared menu:

```text
/99settings
```

The **Codex API** section controls:

- **Other providers** — off by default. When enabled, a non-Codex model may
  call `codex_image` and `codex_search`; the extension resolves only the
  separately logged-in `openai-codex` OAuth account. It never sends the active
  model provider's credentials to ChatGPT.
- **Fast mode** — enables or disables the priority service tier;
- Auto search routing, or a fixed Cached, Indexed, or Live policy;
- search context size;
- default GPT Image 2 quality (`Auto`, `Low`, `Medium`, or `High`);
- subscription usage status visibility.

Configuration is stored under the `codex-api` namespace in:

```text
~/.pi/agent/99extensions.json
```

## Authentication and privacy

The extension asks Pi's model registry for a refreshed OAuth token at tool-call
time. It sends the same bearer token and `ChatGPT-Account-ID` used by Pi's
`openai-codex` adapter. With **Other providers** enabled, it resolves that
Codex model specifically rather than using the active model's credentials.
Tokens are never copied into extension settings or tool results. The extracted
ChatGPT account ID is used only as an in-memory Usage-state key and is never
persisted or displayed. The watcher reacts only to the `auth.json` filename;
credential parsing and resolution remain inside Pi's public model registry.

Image prompts, reference images, search commands, and search context are sent
to OpenAI's Codex backend and are subject to the active ChatGPT workspace's
policies. Feature availability and request formats may change as Codex rolls
out backend updates.
