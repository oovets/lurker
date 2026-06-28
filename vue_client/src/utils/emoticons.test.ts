// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { findCompletedEmoticon } from './emoticons.js';

// Convert at the caret (end of the typed token).
function at(text: string) {
  return findCompletedEmoticon(text, text.length);
}

describe('findCompletedEmoticon', () => {
  it('converts standalone emoticons at the start of input', () => {
    expect(at(':)')?.emoji).toBe('🙂');
    expect(at(':D')?.emoji).toBe('😄');
    expect(at('<3')?.emoji).toBe('❤️');
  });

  it('converts after whitespace', () => {
    const hit = at('hello :)');
    expect(hit?.emoji).toBe('🙂');
    expect(hit?.start).toBe(6);
    expect(hit?.end).toBe(8);
  });

  it('prefers the longest match (:-) over nothing, </3 over <3)', () => {
    expect(at(':-)')?.emoji).toBe('🙂');
    expect(at('</3')?.emoji).toBe('💔');
  });

  it('does NOT convert inside a word (URL guard)', () => {
    // The `:/` in a URL follows `p`, not whitespace — must not convert.
    expect(at('http:/')).toBeNull();
    expect(at('https://')).toBeNull();
    expect(at('C:)')).toBeNull();
  });

  it('respects case so ordinary letters do not convert', () => {
    expect(at(':P')?.emoji).toBe('😛');
    expect(at(':p')?.emoji).toBe('😛');
    // A bare ":d" is not in the map (only :D), so a word like "as:d" is safe.
    expect(at(':d')).toBeNull();
  });

  it('only fires when the caret is right after the emoticon', () => {
    // Caret in the middle of the text, not at the emoticon's end.
    expect(findCompletedEmoticon('hi :) there', 3)).toBeNull();
    expect(findCompletedEmoticon('hi :) there', 5)?.emoji).toBe('🙂');
  });

  it('returns null for plain text', () => {
    expect(at('just text')).toBeNull();
    expect(at('')).toBeNull();
  });
});
