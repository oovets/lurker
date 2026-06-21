// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Quote-aware argument tokenizer for slash commands. The historical dispatcher
// splits on bare whitespace (`line.split(/\s+/)`), which can't carry values
// that contain spaces — a network name like "Libera Chat", an autosendcmd
// script, or a font-family stack. This mirrors the shell-ish parsing irssi uses
// for its /network option args: single- and double-quoted spans group, and a
// backslash escapes the next character verbatim.
//
// Pure and dependency-free so it unit-tests outside the Vue SFC. Shared by the
// upcoming /network (#356) and /set, /get (#357) commands.

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

/**
 * Split a command's argument string into tokens, honoring quotes and escapes.
 *
 * - Runs of whitespace separate tokens.
 * - A `'` or `"` opens a quoted span; whitespace inside it is preserved and the
 *   span joins the surrounding token (so `-x"a b"` is one token `-xa b`).
 * - `\` escapes the following character (`\"`, `\'`, `\ `, `\\`) literally.
 * - An empty quoted string (`""`) is a real, empty token.
 * - An unterminated quote is lenient: the remainder becomes the final token.
 */
export function tokenizeArgs(argLine: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < argLine.length; i++) {
    const ch = argLine[i];

    if (ch === '\\' && i + 1 < argLine.length) {
      cur += argLine[i + 1];
      inToken = true;
      i++;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      // Opening a quote starts a token even if the span turns out empty, so a
      // bare "" survives as a deliberate empty argument.
      inToken = true;
      continue;
    }

    if (WHITESPACE.has(ch)) {
      if (inToken) {
        tokens.push(cur);
        cur = '';
        inToken = false;
      }
      continue;
    }

    cur += ch;
    inToken = true;
  }

  if (inToken) tokens.push(cur);
  return tokens;
}
