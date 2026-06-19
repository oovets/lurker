// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared text-matching primitives used by the highlight engine and the ignore
// content-pattern matcher. One implementation means "highlights on a word" and
// "ignore -pattern that word" agree on word boundaries, glob translation, and
// URL stripping, on both server and client.

import { createUrlRegex } from './urlPattern.js';

// 'substr' — case-(in)sensitive substring (irssi's default -pattern / stristr)
// 'plain'  — whole-word match of a literal (word-boundary anchored)
// 'glob'   — whole-word glob (* and ?) match
// 'regex'  — raw regular expression
export type TextKind = 'substr' | 'plain' | 'glob' | 'regex';

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function globToRegexSource(pattern: string): string {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += escapeRegex(ch);
  }
  return out;
}

// Compile a text pattern into a predicate. Returns null when the pattern can't
// compile (invalid regex) so callers can drop the rule rather than throw.
export function buildTextTest(
  pattern: string,
  kind: TextKind,
  caseSensitive: boolean,
): ((text: string) => boolean) | null {
  if (kind === 'substr') {
    if (caseSensitive) return (text: string) => text.includes(pattern);
    const needle = pattern.toLowerCase();
    return (text: string) => text.toLowerCase().includes(needle);
  }
  const flags = caseSensitive ? '' : 'i';
  let source: string;
  if (kind === 'regex') {
    source = pattern;
  } else if (kind === 'glob') {
    source = `(?:^|\\W)(?:${globToRegexSource(pattern)})(?=\\W|$)`;
  } else {
    // 'plain'
    source = `(?:^|\\W)(?:${escapeRegex(pattern)})(?=\\W|$)`;
  }
  try {
    const re = new RegExp(source, flags);
    return (text: string) => re.test(text);
  } catch {
    return null;
  }
}

// The URL alternation is ~120 chars; compile it once and reuse. The /g regex is
// safe to share across .replace() calls (replace resets lastIndex each time).
const URL_RE = createUrlRegex();

// Blank out URLs before matching so a word inside a link — e.g. a nick that
// happens to appear in `https://example.com/nick` — doesn't trigger a match.
// The URL is replaced with a space (not removed) so words on either side can't
// fuse into a false match.
export function stripUrls(text: string): string {
  return text.replace(URL_RE, ' ');
}
