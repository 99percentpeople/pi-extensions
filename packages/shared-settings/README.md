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
  nested option submenus that restore the parent selection, with stable layout
  height while navigating;
- type-to-search filtering in the main menu and every submenu, using Pi's input
  component and fuzzy matching.

This package is installed automatically as a dependency. It is not a Pi
extension and does not declare its own `pi.extensions` entry.

## Stable layout

Moving up or down keeps the menu height, scroll counter, description area, and
footer stable. Each menu reserves enough space for the maximum number of headers
in a visible row window and the longest wrapped description among its current
matches. Short descriptions (or settings without help) leave that space blank;
long descriptions remain fully visible.

The measurements are cached while navigating and recalculated when the terminal
width, search results, or settings change. Short menus stay compact, and each
submenu sizes itself independently; returning restores the parent layout.

## Search

Open `/99settings` and start typing to filter the current menu by plugin/panel
name, setting label, or description. Matching is case-insensitive and supports
fuzzy abbreviations and multiple words; plugin groups keep their original order.
Search applies to the current menu, not unopened submenus. Each submenu starts
with an empty search; returning restores the parent query and selection.

- **↑/↓** navigate matching settings; **Enter** changes a value or opens a submenu.
- **Space** changes a value when the search is empty; otherwise it adds a space
  to the query, just like Pi's `/settings`.
- **Backspace** edits the search; **Ctrl+U** clears text before the input cursor.
- **Esc** closes the current menu (or returns from a submenu), even with an
  active search, matching Pi's behavior.

Changes still apply immediately. Refreshing dynamic settings keeps the current
query and selected setting whenever it remains visible. Search text is temporary
and is not saved to the settings file.

## License

MIT
