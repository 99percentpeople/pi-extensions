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

Preset themes intentionally expose no speed or color overrides. `Custom` keeps
Loader and Label controls independent and retains their values while another
preset is selected.

### Custom Loader effects

| Effect | Description |
| --- | --- |
| Pi default | Pi's ten-frame Braille spinner |
| None | Hide the leading indicator |
| Claude Code | The platform-specific Claude mark sequence |
| Pulse | `· • ● •` pulse |
| Dots | Fixed-width three-dot fill |
| Bounce | Rising and falling block |
| Orbit | `◐ ◓ ◑ ◒` rotation |

Every visible Custom loader supports Slow/Normal/Fast speed and
Accent/Text/Muted/Claude color. Frames have a stable display width, so the
label does not jump horizontally.

### Custom Label effects

| Effect | Description |
| --- | --- |
| None | Keep the native label styling |
| Wave | A crest with a softer trailing band |
| Shimmer | A cosine-smoothed highlight |
| Scan | A crisp moving highlight band |
| Pulse | Whole-label brightness breathing |
| Rainbow | A moving ANSI 256-color spectrum |

Animated labels support speed and a loop pause. Moving effects also support
left-to-right, right-to-left, and ping-pong directions. Wave, Shimmer, and Scan
provide crest width controls; all non-Rainbow effects support Accent, Thinking,
and Monochrome palettes. Loader and Label clocks are independent, and label
segmentation preserves emoji and combining-character graphemes.

## Install

```bash
pi install npm:@99percentpeople/pi-cursor-effect
```

For local development, build the npm artifact before installing the package
directory:

```bash
bun run build:packages
bun run --cwd extensions/cursor-effect build
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
        "palette": "accent",
        "direction": "left-to-right",
        "pause": "none"
      }
    }
  }
}
```

## Compatibility

Pi does not currently expose a renderer hook for its main status indicators.
This package therefore installs a guarded patch on `Loader.updateDisplay()`,
`Loader.render()`, and `Loader.stop()`, activated only for Pi's four main status
kinds: `working`, `retry`, `compaction`, and `branchSummary`. The `stop()` wrapper
owns the independent Label timer and prevents it from outliving a status row.
Tool, bash, and extension loaders do not have those kinds and remain unchanged.
The patch checks the expected methods at startup, avoids duplicates, and restores
the original prototype during session shutdown. Pre-styled ANSI labels are left
unchanged.

Streaming label changes preserve the current Label effect phase instead of
restarting it for every partial summary or status message. Loader animation
remains driven by Pi's normal interval callbacks. Pi rendering and extension
callbacks share Node's main event loop, so terminal animation cannot redraw
while a synchronous callback is blocking that thread.

## License

MIT
