// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect } from 'vitest';
import {
  chunkCountForSay,
  chunkCountForAction,
  MESSAGE_MAX_BYTES,
  ACTION_MAX_BYTES,
} from './messageSplit.js';

describe('chunkCountForSay', () => {
  it('returns 0 for empty input', () => {
    expect(chunkCountForSay('')).toBe(0);
    expect(chunkCountForSay(null)).toBe(0);
    expect(chunkCountForSay(undefined)).toBe(0);
  });

  it('returns 1 for short ASCII input', () => {
    expect(chunkCountForSay('hello world')).toBe(1);
  });

  it('returns 1 for input right at the byte limit', () => {
    expect(chunkCountForSay('a'.repeat(MESSAGE_MAX_BYTES))).toBe(1);
  });

  it('returns 2 for input one byte over the limit (word-greedy)', () => {
    // 350 'a's plus a space and a single character at the end forces a
    // second chunk via the word boundary.
    const text = `${'a'.repeat(MESSAGE_MAX_BYTES - 5)} extra`;
    expect(chunkCountForSay(text)).toBe(2);
  });

  it('returns 3 for ~2.5x the limit of word-broken text', () => {
    const word = 'foo ';
    const text = word.repeat(Math.ceil((MESSAGE_MAX_BYTES * 2.5) / word.length));
    expect(chunkCountForSay(text)).toBe(3);
  });

  it('counts newlines as chunk boundaries', () => {
    expect(chunkCountForSay('one\ntwo')).toBe(2);
    expect(chunkCountForSay('one\r\ntwo\rthree')).toBe(3);
  });

  it('drops empty lines (matches server-side behavior)', () => {
    expect(chunkCountForSay('one\n\ntwo')).toBe(2);
  });

  it('respects byte length for multi-byte UTF-8', () => {
    // 100 fire emojis = 400 bytes > 350, must split.
    expect(chunkCountForSay('🔥'.repeat(100))).toBeGreaterThanOrEqual(2);
  });

  it('handles a single oversize word by slicing it', () => {
    // 1000 chars with no whitespace — single token wider than budget.
    const count = chunkCountForSay('a'.repeat(1000));
    // 1000 / 350 = 2.86, so at least 3 chunks.
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

describe('chunkCountForAction', () => {
  it('uses the tighter ACTION budget', () => {
    // A line that fits in PRIVMSG (350) but not in ACTION (341) → 1 chunk
    // for say, 2 for action.
    const text = 'a'.repeat(345);
    expect(chunkCountForSay(text)).toBe(1);
    expect(chunkCountForAction(text)).toBe(2);
  });

  it('does not split on newlines (matches irc-framework)', () => {
    // irc-framework's client.action doesn't pre-split on newlines, so
    // neither do we.
    expect(chunkCountForAction('one\ntwo')).toBe(1);
  });

  it('respects the lower limit value', () => {
    expect(ACTION_MAX_BYTES).toBeLessThan(MESSAGE_MAX_BYTES);
    expect(MESSAGE_MAX_BYTES - ACTION_MAX_BYTES).toBe('ACTION'.length + 3);
  });

  it('returns 0 for empty', () => {
    expect(chunkCountForAction('')).toBe(0);
  });
});
