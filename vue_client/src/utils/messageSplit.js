// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

// Client-side estimate of how many IRC lines a message will split into when
// the server hands it to irc-framework. We can't import the server-side
// helper (it imports from irc-framework's source tree) so this is a
// deliberately simpler port — word-greedy, byte-aware, accurate for ASCII
// and well-formed UTF-8. Pathological input (a 10kB string with no
// whitespace) might miscount by one chunk, which we accept: the UI hint is
// guidance, not a wire-level decision. The actual splitting still happens
// server-side via irc-framework's lineBreak().
//
// Constants mirror server/services/messageSplit.js — keep in sync if
// irc-framework ever bumps its message_max_length default.
export const MESSAGE_MAX_BYTES = 350;
export const ACTION_MAX_BYTES = MESSAGE_MAX_BYTES - ('ACTION'.length + 3);

const encoder = new TextEncoder();
function byteLen(s) {
  return encoder.encode(s).byteLength;
}

// Greedy word-pack: walk whitespace-separated tokens, fit as many as we can
// into each chunk's byte budget, start a new chunk on overflow. If a single
// token exceeds the budget on its own, we approximate by counting how many
// budget-sized slices it'd take — close enough to irc-framework's
// grapheme/codepoint cascade for any input a human types.
function chunksForLine(line, bytes) {
  if (!line) return 0;
  // Fast path: whole line fits.
  if (byteLen(line) <= bytes) return 1;

  let count = 0;
  let cur = '';
  let pendingWs = '';
  const tokens = line.split(/(\s+)/); // alternates non-ws, ws, non-ws, ws...

  const flushNew = (word) => {
    if (cur) { count += 1; cur = ''; pendingWs = ''; }
    if (byteLen(word) <= bytes) {
      cur = word;
      return;
    }
    // Word alone won't fit — split into byte-sized slices. Iterate by code
    // point so we don't tear surrogate pairs.
    let acc = '';
    for (const cp of word) {
      if (byteLen(acc) + byteLen(cp) > bytes) {
        count += 1;
        acc = cp;
      } else {
        acc += cp;
      }
    }
    cur = acc;
  };

  for (const tok of tokens) {
    if (!tok) continue;
    if (/^\s+$/.test(tok)) {
      pendingWs = tok;
      continue;
    }
    if (!cur) {
      flushNew(tok);
      continue;
    }
    if (byteLen(cur) + byteLen(pendingWs) + byteLen(tok) <= bytes) {
      cur += pendingWs + tok;
      pendingWs = '';
    } else {
      flushNew(tok);
    }
  }
  if (cur) count += 1;
  return count;
}

// PRIVMSG path: split on newlines first (each line independently chunked),
// matching what irc-framework's sendMessage() does.
export function chunkCountForSay(text) {
  if (!text) return 0;
  let total = 0;
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (!line) continue;
    total += chunksForLine(line, MESSAGE_MAX_BYTES);
  }
  return total;
}

// CTCP ACTION path: no newline pre-split (matches irc-framework), tighter
// budget to leave room for the \x01ACTION ... \x01 wrapper.
export function chunkCountForAction(text) {
  if (!text) return 0;
  return chunksForLine(text, ACTION_MAX_BYTES);
}
