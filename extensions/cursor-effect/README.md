# @99percentpeople/pi-cursor-effect

A focused [Pi](https://github.com/earendil-works/pi) extension for selectable
visual effects on Pi's **main session status cursors**.

## Scope

This package changes Pi's main `working`, `retry`, `compaction`, and
`branchSummary` status indicators, including labels such as:

```text
⠦ Working...
⠦ Thinking...
⠦ Analyzing the request
⠦ Responding…
⠦ Compacting context... (escape to cancel)
⠦ Retrying (1/3) in 2s... (escape to cancel)
```

It does **not** change assistant Items, reasoning content, tool/bash loaders,
widgets, message bodies, model events, or session data. Other extensions, such
as `thinking-fold`, provide their status labels as plain text and remain fully
functional without this package.

## Themes

- `default` (default): do not override Pi's native loader or label;
- `claude-code`: the inspected Claude Code 2.1.x platform-specific mark cycle,
  120ms glyph timing, ANSI 256 orange, and right-to-left three-character label
  glimmer;
- `codex`: the current Codex busy-row bullet and synchronized two-second label
  shimmer, refreshed every 32ms;
- `custom`: independently configure Loader and Label effects.

Preset themes intentionally expose no speed or color overrides. Custom retains
all previous controls: Pi/None/Claude loaders with speed and color, plus
None/Wave labels with speed, crest width, and palette. Custom values remain in
the configuration while another preset is selected.

## Install

```bash
pi install npm:@99percentpeople/pi-cursor-effect
```

For local development:

```bash
pi install ./extensions/cursor-effect
```

Restart Pi or run `/reload` after installation.

## Settings

Run `/99settings`. Presets keep the section to one row:

```text
Cursor Effect
Theme  Claude Code
```

Selecting `Custom` dynamically reveals the two detailed submenus:

```text
Cursor Effect
Theme          Custom
Loader effect  Pi default
Label effect   Wave
```

The shared menu displays only installed `@99percentpeople` plugins that expose
configurable values. Configuration persists in:

```text
~/.pi/agent/99extensions.json
```

under the `cursor-effect` namespace:

```json
{
  "cursor-effect": {
    "theme": "default",
    "custom": {
      "loader": {
        "style": "pi-default",
        "speed": "normal",
        "color": "accent"
      },
      "label": {
        "style": "wave",
        "speed": "normal",
        "crestWidth": "soft",
        "palette": "accent"
      }
    }
  }
}
```

## Compatibility

Pi does not currently expose a renderer hook for its main status indicators.
This package therefore installs a guarded patch on `Loader.updateDisplay()` and
`Loader.render()`, activated only for Pi's four main status kinds: `working`,
`retry`, `compaction`, and `branchSummary`. Tool, bash, and extension loaders do
not have those kinds and remain unchanged. The patch checks the expected methods
at startup, avoids duplicates, and restores the original prototype during
session shutdown. Pre-styled ANSI labels are left unchanged.

## License

MIT
