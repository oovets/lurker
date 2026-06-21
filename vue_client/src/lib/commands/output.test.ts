// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { formatColumns } from './output.js';

describe('formatColumns', () => {
  it('returns an empty array for no rows', () => {
    expect(formatColumns([])).toEqual([]);
  });

  it('pads each column to its widest cell and leaves no trailing whitespace', () => {
    const out = formatColumns([
      ['Libera', 'irc.libera.chat', 'connected'],
      ['OFTC', 'irc.oftc.net', 'off'],
    ]);
    expect(out).toEqual(['Libera  irc.libera.chat  connected', 'OFTC    irc.oftc.net     off']);
    for (const line of out) expect(line).toBe(line.replace(/\s+$/, ''));
  });

  it('honors a custom gap between columns', () => {
    expect(
      formatColumns(
        [
          ['a', 'b'],
          ['cc', 'd'],
        ],
        1,
      ),
    ).toEqual(['a  b', 'cc d']);
  });

  it('handles ragged rows by treating missing cells as empty', () => {
    expect(formatColumns([['key', 'value'], ['lonely']])).toEqual(['key     value', 'lonely']);
  });

  it('does not pad a single-column grid', () => {
    expect(formatColumns([['alpha'], ['b']])).toEqual(['alpha', 'b']);
  });

  it('emits no trailing whitespace when the final cell is empty', () => {
    expect(formatColumns([['a', '']])).toEqual(['a']);
    expect(
      formatColumns([
        ['key', 'value'],
        ['empty', ''],
      ]),
    ).toEqual(['key    value', 'empty']);
  });
});
