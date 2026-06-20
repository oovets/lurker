// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Throwaway DB before importing the layer (db/index.js reads DATABASE_PATH at
// module-load time). Mirrors drafts.test.ts.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let deleteUser: typeof import('./users.js').deleteUser;
let systemMessages: typeof import('./systemMessages.js').default;

beforeAll(async () => {
  ({ createUser, deleteUser } = await import('./users.js'));
  systemMessages = (await import('./systemMessages.js')).default;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function line(over: Partial<Parameters<typeof systemMessages.insert>[0]> = {}) {
  return systemMessages.insert({
    ts: new Date().toISOString(),
    level: 'info',
    scope: 'lurker',
    source: 'server',
    text: 'hi',
    ...over,
  });
}

describe('systemMessages', () => {
  it('insert returns the row with an autoincrement id', () => {
    const row = line({ text: 'first' });
    expect(row.id).toBeGreaterThan(0);
    expect(row.text).toBe('first');
    expect(row.userId).toBeNull();
  });

  it('recent merges global + the user own lines in ascending id order', () => {
    const u = createUser('sys-alice');
    const other = createUser('sys-otto');
    const g = line({ text: 'global', userId: null });
    const mine = line({ text: 'mine', userId: u.id });
    line({ text: 'theirs', userId: other.id });

    const rows = systemMessages.recent(u.id);
    const texts = rows.map((r) => r.text);
    expect(texts).toContain('global');
    expect(texts).toContain('mine');
    // Another user's per-user line must not leak.
    expect(texts).not.toContain('theirs');
    // Ascending id ordering.
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(ids.toSorted((a, b) => a - b));
    expect(rows.find((r) => r.text === 'global')!.id).toBe(g.id);
    expect(rows.find((r) => r.text === 'mine')!.id).toBe(mine.id);
  });

  it('round-trips a JSON fields blob', () => {
    const u = createUser('sys-fields');
    line({ userId: u.id, fields: { nick: 'bob', count: 3 } });
    const row = systemMessages.recent(u.id).at(-1)!;
    expect(row.fields).toEqual({ nick: 'bob', count: 3 });
  });

  it('prunes a user ring beyond the per-user cap', () => {
    const u = createUser('sys-floody');
    for (let i = 0; i < 520; i++) line({ userId: u.id, text: `m${i}` });
    const mine = systemMessages.recent(u.id).filter((r) => r.userId === u.id);
    // Capped at 500; the newest survive, the oldest are pruned.
    expect(mine.length).toBe(500);
    expect(mine.some((r) => r.text === 'm519')).toBe(true);
    expect(mine.some((r) => r.text === 'm0')).toBe(false);
  });

  it('dropUser forgets only that user lines', () => {
    const u = createUser('sys-drop');
    line({ text: 'keepme-global', userId: null });
    line({ userId: u.id, text: 'dropme' });
    expect(systemMessages.recent(u.id).some((r) => r.text === 'dropme')).toBe(true);
    systemMessages.dropUser(u.id);
    const after = systemMessages.recent(u.id);
    expect(after.some((r) => r.text === 'dropme')).toBe(false);
    // Global lines are untouched.
    expect(after.some((r) => r.text === 'keepme-global')).toBe(true);
  });

  it('cascades per-user rows on account deletion', () => {
    const u = createUser('sys-cascade');
    line({ userId: u.id, text: 'cascade-me' });
    deleteUser(u.id);
    expect(systemMessages.recent(u.id).some((r) => r.text === 'cascade-me')).toBe(false);
  });
});

describe('countNotableNewer (unread classification, #355)', () => {
  it('counts admin/control-plane + warn/error, not routine info, newer than the pointer', () => {
    const u = createUser('sys-unread');
    const base = line({ userId: u.id, text: 'baseline' }).id; // pointer starts here
    line({ userId: u.id, text: 'routine join', level: 'info', source: 'server' }); // not notable
    line({ userId: u.id, text: 'a warning', level: 'warn', source: 'server' }); // notable
    line({ text: 'admin notice', level: 'info', source: 'admin' }); // notable, global
    line({ userId: u.id, text: 'an error', level: 'error', source: 'server' }); // notable

    expect(systemMessages.countNotableNewer(u.id, base)).toBe(3);
    // After reading everything, zero.
    const top = systemMessages.recent(u.id).at(-1)!.id;
    expect(systemMessages.countNotableNewer(u.id, top)).toBe(0);
  });

  it("doesn't count another user's per-user notable lines, but does count globals", () => {
    const u = createUser('sys-unread-a');
    const other = createUser('sys-unread-b');
    const before = systemMessages.countNotableNewer(u.id, 0);
    line({ userId: other.id, text: 'their error', level: 'error' }); // per-user to `other`
    expect(systemMessages.countNotableNewer(u.id, 0)).toBe(before); // doesn't leak
    line({ text: 'global error', level: 'error' }); // global (userId null)
    expect(systemMessages.countNotableNewer(u.id, 0)).toBe(before + 1);
  });
});

describe('keyset access (unified buffer delivery, #355)', () => {
  it('listSystemMessages: latest is newest-N oldest-first; before/afterId page by id', () => {
    const u = createUser('sys-keyset');
    const ids = Array.from({ length: 5 }, (_, i) => line({ userId: u.id, text: `k${i}` }).id);

    // latest (no cursor): oldest-first within the limit window.
    const latest3 = systemMessages.listSystemMessages(u.id, { limit: 3 });
    expect(latest3.map((r) => r.id)).toEqual(ids.slice(2)); // the 3 newest, ascending

    // before: older page, oldest-first. The shared DB has older global lines
    // too (visible to every user), so assert the tail — our two own rows just
    // below the cursor — rather than the whole page.
    const older = systemMessages.listSystemMessages(u.id, { before: ids[2], limit: 10 });
    expect(older.map((r) => r.id).slice(-2)).toEqual(ids.slice(0, 2));

    // afterId: newer page, ascending.
    const newer = systemMessages.listSystemMessages(u.id, { afterId: ids[2], limit: 10 });
    expect(newer.map((r) => r.id)).toEqual(ids.slice(3));
  });

  it('listSystemMessages mixes the user own + global lines, hides other users', () => {
    const u = createUser('sys-keyset-vis');
    const other = createUser('sys-keyset-other');
    const mine = line({ userId: u.id, text: 'mine' }).id;
    const glob = line({ text: 'global' }).id; // userId null
    const theirs = line({ userId: other.id, text: 'theirs' }).id;

    const visible = systemMessages.listSystemMessages(u.id, { limit: 100 }).map((r) => r.id);
    expect(visible).toContain(mine);
    expect(visible).toContain(glob);
    expect(visible).not.toContain(theirs);
  });

  it('hasOlderSystem / hasNewerSystem probe the visible edges', () => {
    const u = createUser('sys-edges');
    const a = line({ userId: u.id }).id;
    const b = line({ userId: u.id }).id; // b newer than a
    // Relative edges hold regardless of other rows already in the shared DB.
    expect(systemMessages.hasNewerSystem(u.id, a)).toBe(true); // b is newer than a
    expect(systemMessages.hasOlderSystem(u.id, b)).toBe(true); // a is older than b
    // Nothing is newer than the current newest visible line.
    const newest = systemMessages.listSystemMessages(u.id, { limit: 1 }).at(-1)!.id;
    expect(systemMessages.hasNewerSystem(u.id, newest)).toBe(false);
  });

  it('listSystemMessagesAround centers an anchor and reports both edges', () => {
    const u = createUser('sys-around');
    const ids = Array.from({ length: 5 }, () => line({ userId: u.id }).id);
    const slice = systemMessages.listSystemMessagesAround(u.id, ids[2], 1);
    if ('anchorMissing' in slice) throw new Error('anchor should exist');
    expect(slice.events.map((r) => r.id)).toEqual([ids[1], ids[2], ids[3]]);
    expect(slice.hasMoreOlder).toBe(true);
    expect(slice.hasMoreNewer).toBe(true);

    // A missing/foreign anchor reports anchorMissing rather than leaking rows.
    const other = createUser('sys-around-other');
    const theirs = line({ userId: other.id }).id;
    const miss = systemMessages.listSystemMessagesAround(u.id, theirs, 1);
    expect('anchorMissing' in miss && miss.anchorMissing).toBe(true);
  });

  it('afterId 0 pages from the start (ascending), not latest', () => {
    const u = createUser('sys-after0');
    const older = line({ userId: u.id }).id;
    const newer = line({ userId: u.id }).id; // newer > older
    // latest page = the newest row.
    expect(systemMessages.listSystemMessages(u.id, { limit: 1 }).at(-1)!.id).toBe(newer);
    // afterId:0 = everything after the start, ascending → the OLDEST visible row,
    // never the newest. (A truthy `if (afterId)` would drop 0 to the latest path.)
    expect(systemMessages.listSystemMessages(u.id, { afterId: 0, limit: 1 })[0].id).not.toBe(newer);
    const fromStart = systemMessages
      .listSystemMessages(u.id, { afterId: 0, limit: 100 })
      .map((r) => r.id);
    expect(fromStart).toContain(older);
    expect(fromStart.indexOf(older)).toBeLessThan(fromStart.indexOf(newer)); // ascending
  });
});
