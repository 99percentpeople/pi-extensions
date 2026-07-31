# @99percentpeople/pi-codex-api

Turn your ChatGPT subscription into Pi superpowers — image generation, web
search, Fast mode, and usage monitoring — **no OpenAI API key required**.

## Highlights

- **Image generation & editing** — `codex_image` creates or edits images via
  your Codex subscription's `gpt-image-2`, and works from **any model**:
  even with a third-party provider active (DeepSeek, Google, …), it reuses Pi's
  logged-in `openai-codex` OAuth account (enable **Other providers** in
  `/99settings`).
- **First-party search** — `codex_search` runs web and image queries, page
  navigation, PDF screenshots, finance, weather, sports, and time lookups, and
  renders clean result cards instead of raw citations.
- **Fast mode** — optional priority service tier for snappier responses.
- **Usage at a glance** — the status bar shows remaining Codex quota and
  reset time; `/codex-usage` shows your plan, masked account, limits, credits,
  and earned rate-limit reset cards.
- **Reset cards** — when you run out of messages, `/codex-redeem` redeems an
  earned reset card safely: pick a card, confirm, done.

## Demo

Subscription usage, limit-reached state, and reset-card redemption:

![codex usage demo](../../promo/demo/codex-api.gif)

Web search with clean result cards (search → open a result → summarize):

![codex search demo](../../promo/demo/codex-search.gif)

Image generation with `gpt-image-2` (saved PNG + description):

![codex image demo](../../promo/demo/codex-image.gif)

## Quick start

```bash
pi install npm:@99percentpeople/pi-codex-api
```

Requirements:

- Pi logged in with `/login` for `openai-codex`
- An active `openai-codex` model, or **Other providers** enabled in
  `/99settings` to use the subscription from any model

That's it — just ask *"generate an image of a neon ramen shop"* or *"search
the web for today's Rust releases"* and the model calls the tools for you.

## Commands

### `/codex-usage`

Shows a fresh snapshot of your subscription in one block:

```text
Codex usage

account · Plus (user@example.com)

codex
  weekly [█████████████░░░░░░░] 65% left resets in 5d 3h
  no additional credits

rate limit redeem
  Full reset (available, expires 2026-08-13 02:14 UTC+8)
```

- Plan type and masked email from Codex's official usage endpoint
- Each limit window shows remaining capacity as a bar; when exhausted it reads
  `limit reached` instead of `0% left`
- Earned reset cards, sorted by expiry, with local-time expiry timestamps
- The status bar mirrors this compactly: `Codex weekly 65% 5d 3h` →
  `Codex weekly limit reached 5d 14h`

Usage refreshes automatically on session start and model select;
`/codex-usage` always forces a fresh read.

### `/codex-redeem`

Redeems an earned rate-limit reset card when you're out of messages:

```text
──────────────────────────────────────────────
Select a reset credit to redeem (30s)

→ Full reset (expires 2026-08-03)
  Full reset (expires 2026-08-12)

↑↓ navigate  ↵ select  esc cancel
──────────────────────────────────────────────
      ↓ pick a card
──────────────────────────────────────────────
Redeem Full reset (expires 2026-08-12)? (30s)

→ No
  Yes

↑↓ navigate  ↵ select  esc cancel
──────────────────────────────────────────────
```

- Multiple cards show a picker (earliest expiry first); a single card skips to
  confirmation
- **No is the default**, so a stray Enter never consumes anything
- Redemptions are idempotent: a retry after a network failure can never consume
  a second card
- Without dialog UI, it falls back to a two-step confirm flow

## Settings

Configure under **Codex API** in `/99settings`:

- **Other providers** — let any model (DeepSeek, Google, …) use the logged-in
  Codex subscription
- **Fast mode** — priority service tier (lower latency, faster limit use)
- **Search** — auto routing (Cached / Indexed / Live per call) or a fixed mode,
  plus context size
- **Image quality** — default GPT Image 2 quality
- **Usage status** — show or hide the Codex quota line in the status bar

Settings live in `~/.pi/agent/99extensions.json` under the `codex-api`
namespace.

## How it works

- Reuses Pi's existing `openai-codex` OAuth — no API key, no MCP server, no
  separate search provider
- Tokens are fetched per call from Pi's model registry, never stored in
  settings or tool results
- Images and search requests go to OpenAI's Codex backend and follow your
  ChatGPT workspace's policies
- The extension also ships the **`gpt-image-prompts`** skill for crafting
  production-grade image prompts — invoke it with `/skill:gpt-image-prompts`

## Development

```bash
bun run build:packages
bun run --cwd extensions/codex-api build
pi install ./extensions/codex-api
```
