// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { tokenizeArgs } from './tokenize.js';

describe('tokenizeArgs', () => {
  it('splits on runs of whitespace', () => {
    expect(tokenizeArgs('a b c')).toEqual(['a', 'b', 'c']);
    expect(tokenizeArgs('  a \t b\n c  ')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for empty or whitespace-only input', () => {
    expect(tokenizeArgs('')).toEqual([]);
    expect(tokenizeArgs('   ')).toEqual([]);
  });

  it('keeps double- and single-quoted spans together', () => {
    expect(tokenizeArgs('-name "Libera Chat" -host irc.libera.chat')).toEqual([
      '-name',
      'Libera Chat',
      '-host',
      'irc.libera.chat',
    ]);
    expect(tokenizeArgs("add 'My Network' x")).toEqual(['add', 'My Network', 'x']);
  });

  it('joins a quoted span to the surrounding token', () => {
    expect(tokenizeArgs('-x"a b"y')).toEqual(['-xa by']);
  });

  it('treats an empty quoted string as a real empty token', () => {
    // irssi uses '' to clear a value (e.g. -sasl_mechanism '').
    expect(tokenizeArgs("-sasl_mechanism '' irc")).toEqual(['-sasl_mechanism', '', 'irc']);
  });

  it('preserves a quote of the other kind inside a quoted span', () => {
    expect(tokenizeArgs(`-realname "O'Brien"`)).toEqual(['-realname', "O'Brien"]);
    expect(tokenizeArgs(`-autosendcmd 'msg "hi there"'`)).toEqual([
      '-autosendcmd',
      'msg "hi there"',
    ]);
  });

  it('honors backslash escapes', () => {
    expect(tokenizeArgs('a\\ b')).toEqual(['a b']);
    expect(tokenizeArgs('"a\\"b"')).toEqual(['a"b']);
    expect(tokenizeArgs('a\\\\b')).toEqual(['a\\b']);
  });

  it('is lenient about an unterminated quote', () => {
    expect(tokenizeArgs('-name "Libera Chat')).toEqual(['-name', 'Libera Chat']);
  });

  it('preserves a font-family stack as one value', () => {
    expect(tokenizeArgs(`look.font.family "'Input Mono', ui-monospace, monospace"`)).toEqual([
      'look.font.family',
      "'Input Mono', ui-monospace, monospace",
    ]);
  });
});
