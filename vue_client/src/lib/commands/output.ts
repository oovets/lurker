// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared formatters for command output that lands in the system buffer (#355).
// Command handlers turn their results into plain strings here, then hand each
// line to the SFC's localInfo() helper (a synthetic, non-persisted `motd`
// line). Keeping the formatting pure — no store, no Vue — means it unit-tests
// in isolation and stays consistent across commands.
//
// Consumed by the list-style output of /network (#356) and /set, /get (#357).

/**
 * Render a grid of cells as space-aligned, fixed-width text rows, sizing each
 * column to its widest cell so they line up under the UI's monospace font.
 *
 * The final cell of each row is never padded, so there's no trailing
 * whitespace. Ragged rows (differing column counts) are fine — missing cells
 * are treated as empty.
 *
 * @param rows  one string[] per line; each entry is a column cell
 * @param gap   spaces between columns (default 2)
 */
export function formatColumns(rows: string[][], gap = 2): string[] {
  if (!rows.length) return [];

  const colCount = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    widths[c] = Math.max(0, ...rows.map((r) => (r[c] ?? '').length));
  }

  const sep = ' '.repeat(Math.max(0, gap));
  return rows.map((row) => {
    const last = row.length - 1;
    const line = row.map((cell, c) => (c === last ? cell : cell.padEnd(widths[c]))).join(sep);
    // An empty (or short) final cell still gets a separator in front of it, so
    // strip any trailing spaces to keep the no-trailing-whitespace promise —
    // e.g. [['a', '']] would otherwise format to 'a  '.
    return line.replace(/ +$/, '');
  });
}
