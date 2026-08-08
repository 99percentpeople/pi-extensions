# Recording the demo GIFs

Every GIF in `promo/demo/` should capture a real Pi TUI session running the
actual extension against a live model.

## Prerequisites

- [vhs](https://github.com/charmbracelet/vhs)
- `pi` with access to the model used by the demo
- Optional verification tools such as `ffmpeg` and `tesseract`

## Workflow

1. Build the extension being demonstrated.
2. Start from a clean scratch directory.
3. Disable extension discovery with `-ne` and load only the target extension
   or explicitly documented integration pair with `-e <extension-entry>`.
4. Record an English prompt, the extension's defining in-progress state, and a
   stable completed state.
5. Verify the generated GIF, then copy it into `promo/demo/`.

Use `--no-session` so the recording does not create a persistent Pi session.

## Tape template

```vim
Output demo.gif
Set FontSize 14
Set Width 1000
Set Height 440
Set Padding 16
Set Theme Dracula
Set Framerate 20
Set TypingSpeed 35ms
Set PlaybackSpeed 1.2
Env PI_OFFLINE "1"

Hide
Type "pi --model <provider/model> --thinking <level> --no-session -ne -e <extension-entry>"
Enter
Sleep 8s
Show
Sleep 800ms

Type "<english prompt>"
Sleep 500ms
Enter

Wait+Screen@60s /<completion marker>/
Sleep 4s
```

Keep the important state visible long enough to read. Use at most one
`Hide`/`Show` pair, and never use `Wait+Screen` while recording is hidden. For
long takes, increase playback speed or use 15fps instead of keeping long idle
periods.

## Verification

Check that:

- the prompt, active state, and completed state are all visible;
- the screen does not jump back to the startup view;
- no unrelated extensions, notifications, or real local paths appear;
- the GIF decodes without errors.

Example decode and metadata checks:

```bash
ffmpeg -v error -i demo.gif -f null -
ffprobe -v error \
  -show_entries stream=width,height,avg_frame_rate,duration,nb_frames \
  -of default=noprint_wrappers=1 demo.gif
```

## Output specs

- 1000x440, Dracula theme, 15-25fps
- Approximately 0.4-2.3MB and 10-36 seconds
- English terminal content
