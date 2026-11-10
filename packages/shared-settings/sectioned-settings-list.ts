import {
  fuzzyFilter,
  getKeybindings,
  Input,
  isFocusable,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";

export interface SectionedSettingRow {
  id: string;
  section: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
  submenu?: (currentValue: string, done: (value?: string) => void) => Component;
}

export interface SectionedSettingsListTheme extends SettingsListTheme {
  header(text: string): string;
}

interface SettingsListLayout {
  width: number;
  bodyHeight: number;
  descriptions: string[][];
  descriptionHeight: number;
}

export class SectionedSettingsList implements Component, Focusable {
  private readonly searchInput = new Input();
  private filteredRows: SectionedSettingRow[];
  private layout: SettingsListLayout | undefined;
  private hasFocus = false;
  private selectedIndex = 0;
  private submenuComponent: Component | undefined;
  private submenuRowId: string | undefined;

  constructor(
    private rows: SectionedSettingRow[],
    private readonly maxVisibleRows: number,
    private readonly theme: SectionedSettingsListTheme,
    private readonly onChange: (id: string, value: string) => void,
    private readonly onCancel: () => void,
    private readonly keybindings: KeybindingsManager = getKeybindings(),
  ) {
    this.filteredRows = rows;
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.syncFocus();
  }

  private syncFocus(): void {
    this.searchInput.focused = this.hasFocus && !this.submenuComponent;
    if (this.submenuComponent && isFocusable(this.submenuComponent)) {
      this.submenuComponent.focused = this.hasFocus;
    }
  }

  replaceRows(rows: SectionedSettingRow[], selectedId?: string): void {
    const currentId = selectedId ?? this.filteredRows[this.selectedIndex]?.id;
    this.rows = rows;
    this.applyFilter();
    const nextIndex = currentId ? this.filteredRows.findIndex((row) => row.id === currentId) : -1;
    this.selectedIndex = nextIndex >= 0 ? nextIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredRows.length - 1));
  }

  updateValue(id: string, value: string): void {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) row.currentValue = value;
  }

  invalidate(): void {
    this.layout = undefined;
    this.searchInput.invalidate();
    this.submenuComponent?.invalidate?.();
  }

  render(width: number): string[] {
    if (this.submenuComponent) return this.submenuComponent.render(width);
    const lines = [...this.searchInput.render(width), ""];
    const rows = this.filteredRows;
    if (rows.length === 0) {
      const message = this.rows.length === 0 ? "  No settings available" : "  No matching settings";
      lines.push(truncateToWidth(this.theme.hint(message), width), "", this.renderHint(width));
      return lines;
    }

    const visibleCount = Math.max(1, this.maxVisibleRows);
    const start = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(visibleCount / 2),
        rows.length - visibleCount,
      ),
    );
    const end = Math.min(start + visibleCount, rows.length);
    const visibleRows = rows.slice(start, end);
    const maxLabelWidth = Math.min(
      30,
      Math.max(...this.rows.map((row) => visibleWidth(row.label))),
    );
    const layout = this.getLayout(width);
    const bodyStart = lines.length;
    let previousSection: string | undefined;

    for (let offset = 0; offset < visibleRows.length; offset += 1) {
      const row = visibleRows[offset]!;
      const rowIndex = start + offset;
      if (row.section !== previousSection) {
        lines.push(truncateToWidth(this.theme.header(`  ${row.section}`), width));
        previousSection = row.section;
      }

      const selected = rowIndex === this.selectedIndex;
      const prefix = selected ? this.theme.cursor : "  ";
      const label = truncateToWidth(row.label, maxLabelWidth, "");
      const labelPadded = label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(label)));
      const separator = "  ";
      const usedWidth =
        visibleWidth(prefix) +
        maxLabelWidth +
        visibleWidth(separator);
      const valueWidth = Math.max(0, width - usedWidth - 2);
      const value = truncateToWidth(row.currentValue, valueWidth, "");
      lines.push(
        truncateToWidth(
          prefix +
            this.theme.label(labelPadded, selected) +
            separator +
            this.theme.value(value, selected),
          width,
        ),
      );
    }

    // Headers vary between scroll windows. Pad before the counter/help so their
    // positions stay fixed, not just the bottom border's position.
    while (lines.length < bodyStart + layout.bodyHeight) lines.push("");
    if (start > 0 || end < rows.length) {
      lines.push(truncateToWidth(this.theme.hint(`  (${this.selectedIndex + 1}/${rows.length})`), width));
    }

    if (layout.descriptionHeight > 0) {
      lines.push("");
      const description = layout.descriptions[this.selectedIndex] ?? [];
      for (let index = 0; index < layout.descriptionHeight; index += 1) {
        const line = description[index];
        lines.push(line === undefined ? "" : truncateToWidth(this.theme.description(`  ${line}`), width));
      }
    }
    lines.push("");
    lines.push(this.renderHint(width));
    return lines;
  }

  handleInput(data: string): void {
    if (this.submenuComponent) {
      this.submenuComponent.handleInput?.(data);
      return;
    }
    const keybindings = this.keybindings;
    const rows = this.filteredRows;
    if (keybindings.matches(data, "tui.select.up")) {
      if (rows.length > 0) {
        this.selectedIndex = this.selectedIndex === 0 ? rows.length - 1 : this.selectedIndex - 1;
      }
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      if (rows.length > 0) {
        this.selectedIndex =
          this.selectedIndex === rows.length - 1 ? 0 : this.selectedIndex + 1;
      }
      return;
    }
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }
    if (
      keybindings.matches(data, "tui.select.confirm") ||
      (data === " " && this.searchInput.getValue().length === 0)
    ) {
      const row = rows[this.selectedIndex];
      if (row?.submenu) {
        this.submenuRowId = row.id;
        this.submenuComponent = row.submenu(row.currentValue, (value) => {
          if (value !== undefined) {
            row.currentValue = value;
            this.onChange(row.id, value);
          }
          if (this.submenuComponent && isFocusable(this.submenuComponent)) {
            this.submenuComponent.focused = false;
          }
          this.submenuComponent = undefined;
          const restoredIndex = this.filteredRows.findIndex((candidate) => candidate.id === this.submenuRowId);
          if (restoredIndex >= 0) this.selectedIndex = restoredIndex;
          this.submenuRowId = undefined;
          this.syncFocus();
        });
        this.syncFocus();
        return;
      }
      if (!row?.values || row.values.length === 0) return;
      const currentIndex = row.values.indexOf(row.currentValue);
      const value = row.values[(currentIndex + 1) % row.values.length]!;
      row.currentValue = value;
      this.onChange(row.id, value);
      return;
    }

    const previousQuery = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== previousQuery) {
      this.applyFilter();
      this.selectedIndex = 0;
    }
  }

  private getLayout(width: number): SettingsListLayout {
    if (this.layout?.width === width) return this.layout;

    const rows = this.filteredRows;
    const visibleCount = Math.min(rows.length, Math.max(1, this.maxVisibleRows));
    let headers = 1;
    for (let index = 1; index < visibleCount; index += 1) {
      if (rows[index]!.section !== rows[index - 1]!.section) headers += 1;
    }
    let maxHeaders = headers;
    // Slide across every possible row window, counting its section boundaries.
    for (let start = 1; start + visibleCount <= rows.length; start += 1) {
      if (rows[start]!.section !== rows[start - 1]!.section) headers -= 1;
      const end = start + visibleCount - 1;
      if (rows[end]!.section !== rows[end - 1]!.section) headers += 1;
      maxHeaders = Math.max(maxHeaders, headers);
    }

    const descriptions = rows.map((row) => row.description
      ? wrapTextWithAnsi(row.description, Math.max(1, width - 4))
      : [],
    );
    this.layout = {
      width,
      bodyHeight: visibleCount + maxHeaders,
      descriptions,
      // Reserve for all matches, not only the visible window: scrolling to a
      // longer description should never resize the menu or hide help text.
      descriptionHeight: descriptions.reduce((height, lines) => Math.max(height, lines.length), 0),
    };
    return this.layout;
  }

  private applyFilter(): void {
    this.layout = undefined;
    const matches = new Set(
      fuzzyFilter(this.rows, this.searchInput.getValue(), (row) =>
        `${row.section} ${row.label} ${row.description ?? ""}`,
      ),
    );
    // Keep plugin groups and setting order stable rather than sorting by match score.
    this.filteredRows = this.rows.filter((row) => matches.has(row));
  }

  private renderHint(width: number): string {
    return truncateToWidth(
      this.theme.hint("  Type to search · ↑/↓ to navigate · Enter/Space to change · Esc to cancel"),
      width,
    );
  }
}
