// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Parser for the /ignore command line (issue #301), modeled on irssi:
//
//   /ignore [-regexp|-full] [-pattern <text>] [-except] [-time <dur>]
//           [<mask>|<#channel>] [LEVELS...]
//
// Lives in shared/ so the client command handler and the server-side parity
// tests use the exact same implementation. Pure: no DOM, no clock except the
// injectable `now` for -time.

import { canonicalLevel, canonicalizeLevels, LEVEL_DEFS } from './ignoreLevels.js';

export type IgnorePatternKind = 'substr' | 'full' | 'regex';

export interface ParsedIgnore {
  mask: string | null;
  channels: string[] | null;
  pattern: string | null;
  patternKind: IgnorePatternKind;
  levels: string[];
  isExcept: boolean;
  expiresAt: string | null;
  // true = scope the rule to the current network (-network); false (default) =
  // global, applying on every network (#350). Consumed by the command handler,
  // which maps it to a networkId; the rule payload itself is scope-agnostic.
  scopeNetwork: boolean;
  error?: string;
}

// The concrete level tokens an `ALL` rule expands to when a subtractive level
// (`ALL -PUBLIC`) is applied. Derived from the shared definitions so it never
// drifts.
const CONCRETE_LEVELS = Object.keys(LEVEL_DEFS);

const DURATION_RE =
  /^(\d+)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/i;
const DURATION_MULT: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

// Cap durations at ~100 years. Beyond this `now + ms` overflows the valid Date
// range and `new Date(...).toISOString()` throws RangeError; an absurd value is
// almost always a typo, so reject it (treat as a parse error) rather than
// silently capping. A truly permanent ignore is just `-time` omitted.
const MAX_DURATION_MS = 100 * 365 * 24 * 60 * 60 * 1000;

function parseDuration(s: string | undefined): number | null {
  if (!s) return null;
  const m = DURATION_RE.exec(s.trim());
  if (!m) return null;
  const mult = DURATION_MULT[(m[2] || 's').toLowerCase()];
  if (mult == null) return null;
  const ms = parseInt(m[1], 10) * mult;
  if (!Number.isFinite(ms) || ms > MAX_DURATION_MS) return null;
  return ms;
}

// Turn a duration string (e.g. "7 days", "30m") into an ISO expiry timestamp,
// or null if it doesn't parse. Same grammar as the -time flag, exported so the
// settings pane computes expiry identically to the command line.
export function durationToExpiry(s: string, now: number = Date.now()): string | null {
  const ms = parseDuration(s);
  if (ms == null) return null;
  return new Date(now + ms).toISOString();
}

// Tokenize on whitespace, but keep a "(…)" group (balanced) or a "quoted" string
// as a single token so `-pattern (a|b c)` / `-pattern "two words"` survive.
function tokenize(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let buf = '';
      while (i < n && s[i] !== quote) buf += s[i++];
      if (i < n) i++; // closing quote
      tokens.push(buf);
    } else if (ch === '(') {
      let depth = 0;
      let buf = '';
      while (i < n) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        buf += c;
        i++;
        if (depth === 0) break;
      }
      tokens.push(buf);
    } else {
      let buf = '';
      while (i < n && !/\s/.test(s[i])) buf += s[i++];
      tokens.push(buf);
    }
  }
  return tokens;
}

function isChannelToken(t: string): boolean {
  return /^[#&!+]/.test(t);
}

export function parseIgnoreArgs(argLine: string, now: number = Date.now()): ParsedIgnore {
  const base: ParsedIgnore = {
    mask: null,
    channels: null,
    pattern: null,
    patternKind: 'substr',
    levels: [],
    isExcept: false,
    expiresAt: null,
    scopeNetwork: false,
  };
  const fail = (error: string): ParsedIgnore => ({ ...base, error });

  const tokens = tokenize(argLine.trim());
  const addLevels: string[] = [];
  const subLevels: string[] = [];
  const channels: string[] = [];
  let mask: string | null = null;
  let sawRegexp = false;
  let sawFull = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();

    if (lower === '-regexp' || lower === '-regex') {
      sawRegexp = true;
      continue;
    }
    if (lower === '-full' || lower === '-word') {
      sawFull = true;
      continue;
    }
    if (lower === '-except') {
      base.isExcept = true;
      continue;
    }
    // Scope flags (#350). Default is global; -network/-net scopes to the current
    // network, -global is the explicit opposite (a no-op but symmetric/discoverable).
    if (lower === '-network' || lower === '-net') {
      base.scopeNetwork = true;
      continue;
    }
    if (lower === '-global') {
      base.scopeNetwork = false;
      continue;
    }
    if (lower === '-replies') return fail('-replies is not supported');
    if (lower === '-pattern') {
      const val = tokens[++i];
      if (val === undefined) return fail('-pattern needs a value');
      base.pattern = val;
      continue;
    }
    if (lower === '-time') {
      const val = tokens[++i];
      const ms = parseDuration(val);
      if (ms == null) return fail(`invalid -time value: ${val ?? '(missing)'}`);
      base.expiresAt = new Date(now + ms).toISOString();
      continue;
    }

    // Subtractive level: -LEVEL where LEVEL is a known token (e.g. ALL -PUBLIC).
    if (t.startsWith('-') && t.length > 1) {
      const lvl = canonicalLevel(t.slice(1));
      if (lvl) {
        subLevels.push(lvl);
        continue;
      }
      return fail(`unknown flag: ${t}`);
    }

    if (isChannelToken(t)) {
      channels.push(t.toLowerCase());
      continue;
    }

    const lvl = canonicalLevel(t);
    if (lvl) {
      addLevels.push(lvl);
      continue;
    }

    if (mask === null) {
      mask = t === '*' ? null : t;
      continue;
    }
    return fail(`unexpected argument: ${t}`);
  }

  base.patternKind = sawRegexp ? 'regex' : sawFull ? 'full' : 'substr';
  base.mask = mask;
  base.channels = channels.length ? channels : null;

  // Resolve the level set. Additive tokens form the base; with none given the
  // base is ALL. Subtractive tokens expand ALL to its concrete members first,
  // then remove — mirroring irssi's `ALL -PUBLIC -ACTIONS`.
  const levelSet = new Set<string>(addLevels.length ? addLevels : ['ALL']);
  if (subLevels.length) {
    if (levelSet.has('ALL')) {
      levelSet.delete('ALL');
      for (const l of CONCRETE_LEVELS) levelSet.add(l);
    }
    for (const s of subLevels) levelSet.delete(s);
  }
  if (levelSet.size === 0) return fail('no levels remain');

  // Canonical order + dedupe for a stable stored CSV.
  base.levels = canonicalizeLevels([...levelSet]);
  return base;
}
