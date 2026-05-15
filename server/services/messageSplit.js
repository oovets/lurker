// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

// Mirrors irc-framework's outgoing splitter (client.sendMessage / client.action)
// so we can publish self-message events that match exactly what peers receive
// on the wire — one event per PRIVMSG sent. Without this, the sender's buffer
// shows a single long line while everyone else sees N chunks.
//
// We reuse irc-framework's own lineBreak() rather than reimplementing the
// byte/word/grapheme/codepoint cascade, so the split outcome is guaranteed to
// agree with what client.say()/client.action() actually transmits. The import
// reaches into the package's src/ tree — there's no exports map, so the path
// is stable for now; if a future irc-framework adds one, this will fail loudly
// at import time rather than silently diverging.
//
// Defaults match irc-framework: message_max_length=350 for PRIVMSG, and
// 350 - ('ACTION'.length + 3) = 341 for CTCP ACTION (the 3 covers the type
// name's leading space and the two \x01 SOH chars).
import { lineBreak } from 'irc-framework/src/linebreak.js';

const MESSAGE_MAX_BYTES = 350;
const ACTION_MAX_BYTES = MESSAGE_MAX_BYTES - ('ACTION'.length + 3);

function chunk(text, bytes) {
  return [...lineBreak(text, {
    bytes,
    allowBreakingWords: true,
    allowBreakingGraphemes: true,
  })];
}

// Split a PRIVMSG body the way irc-framework would: first on line breaks
// (each becomes its own series of wire messages — \n inside a PRIVMSG is
// illegal anyway), then byte-chunk each line.
export function splitSay(text) {
  if (text == null || text === '') return [];
  const out = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (!line) continue;
    out.push(...chunk(line, MESSAGE_MAX_BYTES));
  }
  return out;
}

// CTCP ACTION doesn't pre-split on newlines (matching irc-framework). The
// budget is tighter to leave room for the wrapping \x01ACTION ... \x01.
export function splitAction(text) {
  if (text == null || text === '') return [];
  return chunk(text, ACTION_MAX_BYTES);
}
