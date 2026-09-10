# @99percentpeople/pi-cursor-effect

A focused [Pi](https://github.com/earendil-works/pi) extension for selectable
visual effects on Pi's **main session status cursors**.

Pick a preset (`Claude Code` or `Codex`) for an authentic busy-row look, or
build your own: spinner glyph, animated label effects (wave, shimmer, scan,
rainbow), speed, color, and direction — all from `/99settings`. Runtime metrics
add task elapsed time, output tokens, estimated live throughput, and a final
summary independently of the selected theme.

## Demo

Animated working cursor while the model is busy (Claude Code preset):

![cursor-effect demo](https://raw.githubusercontent.com/99percentpeople/pi-extensions/master/promo/demo/cursor-effect.gif)

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
widgets, message bodies, model events, or session data. Metrics observe model
lifecycle events and optionally send a completion summary via `ctx.ui.notify()`. Other extensions, such
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

## Runtime metrics

All four switches are enabled by default and available under
`/99settings → Cursor Effect → Runtime metrics` in **every** theme:

| Setting | Display |
| --- | --- |
| Elapsed time | Total busy interval, including tools, automatic retries and compaction |
| Output tokens | Completed provider-reported output plus an estimate for the streaming response |
| Live speed | `≈48.2 tok/s` while working; `Avg 46.1 tok/s` using provider-reported output in the completion notification |
| Completion notification | Notify once with enabled metrics when the task settles; no persistent footer status |

Completion notifications follow the elapsed-time, output-token and live-speed
switches. There is no separate average-speed switch; legacy `averageSpeed` values
are ignored. Disabling all three metrics suppresses the notification.
The default working label is displayed as `Working...`; custom labels are unchanged.

Illustrative output:

```text
⠦ Responding... 18s ≈860 out ≈47.8 tok/s
⠦ Working... 32s 1,024 out ≈47.8 tok/s

Done 42s 1,280 out Avg 46.1 tok/s
```

**Timing and accuracy:** elapsed time uses a monotonic local clock and stops at
`agent_settled`, not the earlier `agent_end`. Speed measures client-observed
model-call throughput from `turn_start` to assistant `message_end`, including
request preparation and first-output waiting, but excluding subsequent tool
execution, retry backoff, compaction and user idle time. It is not a server-side
decode-speed measurement. Final speed divides summed output by summed measured
model-call durations, rather than averaging individual rates.

During tool execution or the next call's first-output wait, live speed retains
the last displayed value; it is not a measurement of that waiting interval.
A new task resets the retained value, and speed stays absent until its first
valid sample.

Live estimates count streamed text, visible thinking and tool-call JSON using
approximately four ASCII characters or one non-ASCII code point per token.
They are **not tokenizer-exact** and cannot measure hidden reasoning; every
estimated count/rate has an `≈` prefix. Final counts use `usage.output`, whose
reasoning/tool-token coverage depends on the provider, so final and live rates
can differ. No model calls or network requests are added for measurement.
Missing usage for a response with visible output (or an error/abort) produces
`out —` / `Avg — tok/s` rather than a fabricated total. Rates for spans shorter
than 500ms are withheld. Errors and cancellation are labelled in the summary.

Retry, compaction and branch-summary rows show only elapsed task time while a
task is active; their internal model usage is not included. Standalone manual
compaction/branch summarization is not measured. Background tasks surviving the
agent's completion are not part of its elapsed time.

Metrics are appended only during rendering: existing labels from `thinking-fold`
remain untouched, and the suffix uses dim styling rather than the label animation.
A 250ms refresh keeps metrics moving even with both animations disabled. Timers
are stopped with their loaders and cleaned up on session shutdown/reload. Pi's
native wrapping/clipping also applies to metrics, including editor-border status
placement and narrow terminals. Completion summaries use Pi's notification UI,
independently of custom footers. The existing `completionSummary` config key is
preserved for compatibility. There is no history persistence or
reconstruction of timings after reload.

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

Run `/99settings`. All themes expose runtime metrics:

```text
Cursor Effect
Theme            Claude Code
Runtime metrics  4/4 On
```

Selecting `Custom` dynamically reveals the two detailed submenus:

```text
Cursor Effect
Theme          Custom
Runtime metrics 4/4 On
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
    "metrics": {
      "elapsed": true,
      "outputTokens": true,
      "liveSpeed": true,
      "completionSummary": true
    },
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
unchanged; enabled metrics can still be appended after them.

Streaming label changes preserve the current Label effect phase instead of
restarting it for every partial summary or status message. Loader animation
remains driven by Pi's normal interval callbacks. Pi rendering and extension
callbacks share Node's main event loop, so terminal animation cannot redraw
while a synchronous callback is blocking that thread.

## License

MIT
