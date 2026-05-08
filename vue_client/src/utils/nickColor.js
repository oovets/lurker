// Deterministic nick coloring. Mirrors weechat's gui_nick_find_color:
// trim stop chars, lowercase, djb2-32 hash, modulo a fixed palette.
//
// Palette is the user's weechat chat_nick_colors list
// (73,74,107,109,110,114,139,150,167,174,176,179,183,204,208,210,215,221,67,68,75,111,117)
// translated from xterm 256 indexes to hex. Order is preserved so the
// hash → color mapping matches what they see in their weechat client.

export const NICK_COLOR_PALETTE = [
  '#5fafaf', // 73
  '#5fafd7', // 74
  '#87af5f', // 107
  '#87afaf', // 109
  '#87afd7', // 110
  '#87d787', // 114
  '#af87af', // 139
  '#afd787', // 150
  '#d75f5f', // 167
  '#d78787', // 174
  '#d787d7', // 176
  '#d7af5f', // 179
  '#d7afff', // 183
  '#ff5f87', // 204
  '#ff8700', // 208
  '#ff8787', // 210
  '#ffaf5f', // 215
  '#ffd75f', // 221
  '#5f87af', // 67
  '#5f87d7', // 68
  '#5fafff', // 75
  '#87afff', // 111
  '#87d7ff', // 117
];

const STOP_CHARS = '_|';

function trimForColor(nick) {
  let out = '';
  let seenOther = false;
  for (const ch of nick) {
    const isStop = STOP_CHARS.includes(ch);
    if (isStop && seenOther) break;
    if (!isStop) seenOther = true;
    out += ch;
  }
  return out;
}

function djb2(str) {
  let h = 5381 >>> 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const term = (((h << 5) >>> 0) + (h >>> 2) + cp) >>> 0;
    h = (h ^ term) >>> 0;
  }
  return h;
}

export function nickColor(nick) {
  if (!nick) return null;
  const normalized = trimForColor(nick).toLowerCase();
  if (!normalized) return null;
  return NICK_COLOR_PALETTE[djb2(normalized) % NICK_COLOR_PALETTE.length];
}

// Chars that can appear inside an IRC nick (RFC 2812 plus the usual extensions).
// A match against `nickSet` only counts when neither neighbour is one of these,
// so "bob" inside "bobby" won't match.
const NICK_CHAR_CLASS = '[A-Za-z0-9_\\-\\[\\]\\\\^{|}]';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Split `text` into [{text, color?, self?}] segments, coloring any occurrence
// of a nick from `nickSet`. Comparison is case-insensitive; the matched casing
// is preserved in the rendered text.
export function splitTextByNicks(text, nickSet, selfLower = null) {
  if (!text) return [{ text: '' }];
  if (!nickSet || nickSet.size === 0) return [{ text }];

  const nicks = [...nickSet].filter(Boolean);
  if (nicks.length === 0) return [{ text }];
  // Longest first so "alibaba" wins over "ali" in alternation.
  nicks.sort((a, b) => b.length - a.length);
  const alternation = nicks.map(escapeRegex).join('|');
  const pattern = new RegExp(
    `(?<!${NICK_CHAR_CLASS})(?:${alternation})(?!${NICK_CHAR_CLASS})`,
    'gi',
  );

  const out = [];
  let lastIdx = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const matched = m[0];
    const start = m.index;
    if (start > lastIdx) out.push({ text: text.slice(lastIdx, start) });
    const lower = matched.toLowerCase();
    const isSelf = selfLower && lower === selfLower;
    out.push({
      text: matched,
      color: isSelf ? null : nickColor(matched),
      self: !!isSelf,
    });
    lastIdx = start + matched.length;
  }
  if (lastIdx < text.length) out.push({ text: text.slice(lastIdx) });
  return out;
}
