# @99percentpeople/pi-shared-settings

Internal shared infrastructure for the independently installable
`@99percentpeople` Pi extensions.

It provides:

- the single `/99settings` command;
- a runtime registry of installed extensions, with no-settings plugins omitted
  from the visible menu;
- namespaced reads and atomic writes to `~/.pi/agent/99extensions.json`;
- one combined TUI settings menu with compact plugin headers, unindented setting
  labels, one aligned value column, automatic scrolling beyond 10 rows, and
  nested option submenus that restore the parent selection.

This package is installed automatically as a dependency. It is not a Pi
extension and does not declare its own `pi.extensions` entry.

## License

MIT
