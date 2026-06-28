// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// ASCII emoticon → emoji auto-conversion for the composer, the text-smiley
// counterpart to `:shortcode:` conversion. Typing a known emoticon (`:)`, `<3`,
// `:D`, …) right after a word boundary rewrites it to the emoji glyph.
//
// The boundary rule — the emoticon must sit at the start of the input or right
// after whitespace — is what keeps URLs safe: `http://` ends in `:/`, but its
// `:` follows `p`, not a space, so it never converts. It also means emoticons
// only fire as standalone tokens, matching how people actually type them.

// Curated, low-false-positive set. Multiple spellings map to the same glyph;
// case is significant (`:P`/`:p` both, but `:D` only uppercase) so we don't
// convert ordinary letters. Keys are matched longest-first.
const EMOTICONS: Record<string, string> = {
  ':)': '🙂',
  ':-)': '🙂',
  '=)': '🙂',
  ':(': '🙁',
  ':-(': '🙁',
  '=(': '🙁',
  ':D': '😄',
  ':-D': '😄',
  '=D': '😄',
  xD: '😆',
  XD: '😆',
  ';)': '😉',
  ';-)': '😉',
  ':P': '😛',
  ':-P': '😛',
  ':p': '😛',
  ':-p': '😛',
  ';P': '😜',
  ';p': '😜',
  ":'(": '😢',
  ':o': '😮',
  ':O': '😮',
  ':-o': '😮',
  ':-O': '😮',
  ':|': '😐',
  ':-|': '😐',
  ':/': '😕',
  ':\\': '😕',
  ':*': '😘',
  ':-*': '😘',
  '<3': '❤️',
  '</3': '💔',
  ':3': '😺',
  'D:': '😧',
  '\\o/': '🙌',
};

const MAX_LEN = Math.max(...Object.keys(EMOTICONS).map((k) => k.length));
const MIN_LEN = Math.min(...Object.keys(EMOTICONS).map((k) => k.length));

export interface EmoticonHit {
  start: number;
  end: number;
  emoji: string;
}

// If the text immediately before `caret` is a known emoticon at a word boundary,
// return its span + glyph; else null. Longest match wins so `:-)` beats nothing
// and `</3` beats `<3`.
export function findCompletedEmoticon(text: string, caret: number): EmoticonHit | null {
  const end = Math.min(caret, text.length);
  for (let len = MAX_LEN; len >= MIN_LEN; len--) {
    const start = end - len;
    if (start < 0) continue;
    const token = text.slice(start, end);
    const emoji = EMOTICONS[token];
    if (!emoji) continue;
    // Must be standalone: start of input or preceded by whitespace. This is the
    // URL guard (the `:` in `http://` follows `p`, not a space).
    const prev = start > 0 ? text[start - 1] : '';
    if (prev !== '' && !/\s/.test(prev)) return null;
    return { start, end, emoji };
  }
  return null;
}
