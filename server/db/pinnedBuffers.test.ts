// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-pinned-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let closeBuffer: typeof import('./closedBuffers.js').closeBuffer;
let pinned: typeof import('./pinnedBuffers.js');
let db: typeof import('./index.js').default;
let user: ReturnType<typeof import('./users.js').createUser>;
let net: ReturnType<typeof import('./networks.js').createNetwork>;
let net2: ReturnType<typeof import('./networks.js').createNetwork>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ closeBuffer } = await import('./closedBuffers.js'));
  pinned = await import('./pinnedBuffers.js');
  db = (await import('./index.js')).default;
  user = createUser('pin-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });
  net2 = createNetwork(user.id, { name: 'oftc', host: 'h2', port: 6697, tls: true, nick: 'a' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('pinBuffer / listPinnedForUserNetwork', () => {
  it('appends in pin order', () => {
    pinned.pinBuffer(user.id, net!.id, '#a');
    pinned.pinBuffer(user.id, net!.id, '#b');
    pinned.pinBuffer(user.id, net!.id, '#c');
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#a', '#b', '#c']);
  });

  it('is idempotent — pinning twice does not duplicate or move the entry', () => {
    pinned.pinBuffer(user.id, net!.id, '#a');
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#a', '#b', '#c']);
  });
});

describe('unpinBuffer', () => {
  it('densely renumbers remaining rows so positions stay 0..n-1', () => {
    pinned.unpinBuffer(user.id, net!.id, '#b');
    // Re-listing returns the new order; reorderPins relies on dense positions.
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#a', '#c']);
    // Pinning a fourth then unpinning the head exercises a non-trivial renumber.
    pinned.pinBuffer(user.id, net!.id, '#d');
    pinned.unpinBuffer(user.id, net!.id, '#a');
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#c', '#d']);
  });
});

describe('reorderPins', () => {
  it('rewrites order on a matching set', () => {
    const next = pinned.reorderPins(user.id, net!.id, ['#d', '#c']);
    expect(next).toEqual(['#d', '#c']);
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#d', '#c']);
  });

  it('returns null on a mismatched set', () => {
    expect(pinned.reorderPins(user.id, net!.id, ['#d'])).toBeNull();
    expect(pinned.reorderPins(user.id, net!.id, ['#d', '#c', '#missing'])).toBeNull();
  });
});

describe('listPinnedForUser', () => {
  it('groups by network id', () => {
    pinned.pinBuffer(user.id, net2!.id, '#meta');
    const grouped = pinned.listPinnedForUser(user.id);
    expect(grouped.get(net!.id)).toEqual(['#d', '#c']);
    expect(grouped.get(net2!.id)).toEqual(['#meta']);
  });
});

// Mirrors the schemaVersion < 7 cleanup in db/index.ts. Kept here as a string
// so the test can replay it against orphan rows that the public API can no
// longer create (close-buffer now implies unpin).
const PURGE_ORPHANS_SQL = `
  DELETE FROM pinned_buffers
  WHERE EXISTS (
    SELECT 1 FROM closed_buffers c
    WHERE c.user_id = pinned_buffers.user_id
      AND c.network_id = pinned_buffers.network_id
      AND c.target = pinned_buffers.target
  )
`;
const RENUMBER_PINS_SQL = `
  WITH renum AS (
    SELECT user_id, network_id, target,
           ROW_NUMBER() OVER (
             PARTITION BY user_id, network_id
             ORDER BY position ASC, target ASC
           ) - 1 AS new_pos
    FROM pinned_buffers
  )
  UPDATE pinned_buffers
  SET position = (
    SELECT new_pos FROM renum
    WHERE renum.user_id = pinned_buffers.user_id
      AND renum.network_id = pinned_buffers.network_id
      AND renum.target = pinned_buffers.target
  )
`;

describe('schemaVersion < 7 orphan cleanup (issue #112)', () => {
  it('drops pinned rows whose target is also closed, then renumbers positions per (user, network)', () => {
    // Fresh user/networks so we don't entangle with the suite-wide state above.
    const bob = createUser('pin-bob');
    const netA = createNetwork(bob.id, {
      name: 'a',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'b',
    });
    const netB = createNetwork(bob.id, {
      name: 'b',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'b',
    });

    pinned.pinBuffer(bob.id, netA!.id, '#x');
    pinned.pinBuffer(bob.id, netA!.id, '#y');
    pinned.pinBuffer(bob.id, netA!.id, '#z');
    pinned.pinBuffer(bob.id, netB!.id, '#solo');

    // Simulate the pre-fix bug: close a pinned buffer without unpinning it,
    // leaving an orphan pinned_buffers row pointing at a closed buffer.
    closeBuffer(bob.id, netA!.id, '#y');
    closeBuffer(bob.id, netB!.id, '#solo');

    db.exec(PURGE_ORPHANS_SQL);
    db.exec(RENUMBER_PINS_SQL);

    expect(pinned.listPinnedForUserNetwork(bob.id, netA!.id)).toEqual(['#x', '#z']);
    expect(pinned.listPinnedForUserNetwork(bob.id, netB!.id)).toEqual([]);

    // Positions must be dense (0..n-1) so a subsequent pin appends at the
    // correct slot — listPinnedForUserNetwork already orders by position,
    // but reorderPins relies on the underlying numbering being gap-free.
    const rows = db
      .prepare(`SELECT target, position FROM pinned_buffers WHERE user_id = ? AND network_id = ?`)
      .all(bob.id, netA!.id) as Array<{ target: string; position: number }>;
    expect(rows.toSorted((a, b) => a.position - b.position)).toEqual([
      { target: '#x', position: 0 },
      { target: '#z', position: 1 },
    ]);

    // Pinning a new buffer after the cleanup lands at position 2, not 3
    // (which is what would happen if renumber missed a gap).
    pinned.pinBuffer(bob.id, netA!.id, '#w');
    expect(pinned.listPinnedForUserNetwork(bob.id, netA!.id)).toEqual(['#x', '#z', '#w']);
  });
});
