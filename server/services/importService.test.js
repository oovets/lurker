// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let createUser;
let createNetwork;
let upsertChannel;
let insertMessage;
let setUserSetting;
let createRule;
let setNote;
let pinBuffer;
let addMask;
let addBookmark;
let setReadState;
let insertUpload;
let setNicklistCollapsed;
let setChannelNotifyAlways;
let upsertDraft;
let closeBuffer;
let writeAwayMarker;
let addInputHistory;
let EXPORT_TABLES;
let buildExportZip;
let importFromZipBuffer;
let ImportError;
let EXPORT_FORMAT_VERSION;

beforeAll(async () => {
  db = (await import('../db/index.js')).default;
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork, upsertChannel } = await import('../db/networks.js'));
  ({ insertMessage } = await import('../db/messages.js'));
  ({ insertUpload } = await import('../db/uploadHistory.js'));
  ({ setUserSetting } = await import('../db/settings.js'));
  ({ createRule } = await import('../db/highlightRules.js'));
  ({ setNote } = await import('../db/nickNotes.js'));
  ({ pinBuffer } = await import('../db/pinnedBuffers.js'));
  ({ addMask } = await import('../db/ignoredMasks.js'));
  ({ addBookmark } = await import('../db/bookmarks.js'));
  ({ setReadState } = await import('../db/bufferReads.js'));
  ({ setNicklistCollapsed } = await import('../db/nicklistCollapsed.js'));
  ({ setChannelNotifyAlways } = await import('../db/channelNotify.js'));
  ({ upsertDraft } = await import('../db/drafts.js'));
  ({ closeBuffer } = await import('../db/closedBuffers.js'));
  ({ writeAwayMarker } = await import('../db/userAwayState.js'));
  const ih = await import('../db/inputHistory.js');
  addInputHistory = ih.addEntry;
  ({ buildExportZip } = await import('./exportService.js'));
  ({ importFromZipBuffer, ImportError } = await import('./importService.js'));
  ({ EXPORT_FORMAT_VERSION, EXPORT_TABLES } = await import('../db/exportSchema.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function exportToBuffer(userId, opts) {
  const sink = new PassThrough();
  const chunks = [];
  sink.on('data', (c) => chunks.push(c));
  await buildExportZip(userId, opts, sink);
  return Buffer.concat(chunks);
}

function seedAlice() {
  const alice = createUser(`alice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const net = createNetwork(alice.id, {
    name: 'libera', host: 'irc.libera.chat', port: 6697, tls: true, nick: 'alice',
  });
  upsertChannel(net.id, '#general', true);
  upsertChannel(net.id, '#dev', false);
  const m1 = insertMessage({
    networkId: net.id, target: '#general', time: '2026-05-17T10:00:00Z',
    type: 'message', nick: 'alice', text: 'hello', self: 1,
  });
  insertMessage({
    networkId: net.id, target: '#general', time: '2026-05-17T10:01:00Z',
    type: 'message', nick: 'bob', text: 'hi alice', self: 0,
  });
  setUserSetting(alice.id, 'appearance.theme.name', 'dark');
  const rule = createRule(alice.id, { pattern: 'alice', kind: 'plain', case_sensitive: 0 });
  setNote({ userId: alice.id, networkId: net.id, nick: 'bob', note: 'lives in berlin' });
  addMask({ userId: alice.id, networkId: net.id, mask: 'spammer!*@*' });
  pinBuffer(alice.id, net.id, '#general');
  addBookmark(alice.id, m1.id);
  setReadState(alice.id, net.id, '#general', m1.id);
  insertUpload(alice.id, {
    provider: 'hoarder', url: 'https://example.com/foo.jpg',
    filename: 'foo.jpg', mime: 'image/jpeg', byte_size: 1234,
    width: 100, height: 100, thumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
  });
  return { alice, net, ruleId: rule.id };
}

describe('importFromZipBuffer — roundtrip', () => {
  it('rehydrates networks, channels, messages, bookmarks, highlights, pins, notes, masks, settings, uploads', async () => {
    const { alice, net } = seedAlice();
    const bob = createUser(`bob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const buf = await exportToBuffer(alice.id, { includeMessages: true });

    const result = await importFromZipBuffer(bob.id, buf);
    expect(result.manifest.export_format_version).toBe(EXPORT_FORMAT_VERSION);

    // Bob now owns mirror copies — new ids, same payloads.
    const bobNets = db.prepare('SELECT * FROM networks WHERE user_id = ?').all(bob.id);
    expect(bobNets.length).toBe(1);
    expect(bobNets[0].id).not.toBe(net.id);
    expect(bobNets[0].name).toBe('libera');

    const bobChannels = db.prepare('SELECT * FROM channels WHERE network_id = ?').all(bobNets[0].id);
    expect(bobChannels.map((c) => c.name).sort()).toEqual(['#dev', '#general']);

    const bobMessages = db
      .prepare('SELECT * FROM messages WHERE network_id = ? ORDER BY id ASC')
      .all(bobNets[0].id);
    expect(bobMessages.length).toBe(2);
    expect(bobMessages.map((m) => m.text)).toEqual(['hello', 'hi alice']);

    const bobBookmarks = db
      .prepare('SELECT * FROM user_bookmarks WHERE user_id = ?')
      .all(bob.id);
    expect(bobBookmarks.length).toBe(1);
    // Bookmark must point to a real message owned by bob's network.
    const bookmarkedMsg = db.prepare('SELECT network_id FROM messages WHERE id = ?')
      .get(bobBookmarks[0].message_id);
    expect(bookmarkedMsg.network_id).toBe(bobNets[0].id);

    const bobRules = db.prepare('SELECT * FROM highlight_rules WHERE user_id = ?').all(bob.id);
    expect(bobRules.length).toBe(1);
    expect(bobRules[0].pattern).toBe('alice');

    const bobPins = db.prepare('SELECT * FROM pinned_buffers WHERE user_id = ?').all(bob.id);
    expect(bobPins.length).toBe(1);
    expect(bobPins[0].network_id).toBe(bobNets[0].id);
    expect(bobPins[0].target).toBe('#general');

    const bobMasks = db.prepare('SELECT * FROM ignored_masks WHERE user_id = ?').all(bob.id);
    expect(bobMasks.length).toBe(1);
    expect(bobMasks[0].mask).toBe('spammer!*@*');

    const bobNotes = db.prepare('SELECT * FROM user_nick_notes WHERE user_id = ?').all(bob.id);
    expect(bobNotes.length).toBe(1);
    expect(bobNotes[0].nick).toBe('bob');
    expect(bobNotes[0].note).toBe('lives in berlin');

    const bobSettings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').all(bob.id);
    expect(bobSettings.length).toBe(1);
    expect(bobSettings[0].key).toBe('appearance.theme.name');

    const bobUploads = db.prepare('SELECT * FROM upload_history WHERE user_id = ?').all(bob.id);
    expect(bobUploads.length).toBe(1);
    expect(bobUploads[0].url).toBe('https://example.com/foo.jpg');
    // Thumbnail blob was re-attached from the zip entry.
    expect(bobUploads[0].thumbnail).not.toBeNull();
    expect(Buffer.from(bobUploads[0].thumbnail).length).toBeGreaterThan(0);
    expect(result.thumbnailsAttached).toBe(1);
  });

  it('refuses to import into a non-empty account', async () => {
    const { alice } = seedAlice();
    const carol = createUser(`carol_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    createNetwork(carol.id, {
      name: 'pre-existing', host: 'irc.example', port: 6697, tls: true, nick: 'c',
    });
    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    await expect(importFromZipBuffer(carol.id, buf)).rejects.toMatchObject({
      code: 'account_not_empty',
    });
  });

  it('treats an account with only auto-synced user_settings as empty', async () => {
    // Reproduces the real-world case: client auto-pushes system.timezone on
    // every bootstrap, so a brand-new account has 1 row in user_settings
    // before the user does anything. That should not block an import; the
    // imported settings replace whatever was auto-synced.
    const { alice } = seedAlice();
    const fresh = createUser(`fresh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    setUserSetting(fresh.id, 'system.timezone', 'America/Chicago');
    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    const result = await importFromZipBuffer(fresh.id, buf);
    expect(result.counts.networks).toBe(1);
    // user_settings row from alice's export wins; fresh's auto-synced row gone.
    const tz = db
      .prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'system.timezone'`)
      .get(fresh.id);
    // alice didn't set timezone, so post-import there should be no row at
    // that key (the export's user_settings overwrites the table).
    expect(tz).toBeUndefined();
  });

  it('imports successfully without messages section', async () => {
    const { alice } = seedAlice();
    const dave = createUser(`dave_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    const result = await importFromZipBuffer(dave.id, buf);
    expect(result.counts.messages).toBe(0);
    expect(result.counts.user_bookmarks).toBe(0);

    const msgs = db.prepare(`
      SELECT COUNT(*) AS n FROM messages
        WHERE network_id IN (SELECT id FROM networks WHERE user_id = ?)
    `).get(dave.id).n;
    expect(msgs).toBe(0);

    const bookmarks = db.prepare('SELECT COUNT(*) AS n FROM user_bookmarks WHERE user_id = ?')
      .get(dave.id).n;
    expect(bookmarks).toBe(0);

    // Networks and other settings still made it.
    const nets = db.prepare('SELECT COUNT(*) AS n FROM networks WHERE user_id = ?')
      .get(dave.id).n;
    expect(nets).toBe(1);

    // buffer_reads FK to messages, so settings-only imports must skip those
    // rows cleanly instead of failing the import.
    const reads = db.prepare('SELECT COUNT(*) AS n FROM buffer_reads WHERE user_id = ?')
      .get(dave.id).n;
    expect(reads).toBe(0);
  });

  it('keeps buffer_reads when messages are included', async () => {
    const { alice } = seedAlice();
    const ed = createUser(`ed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const buf = await exportToBuffer(alice.id, { includeMessages: true });
    await importFromZipBuffer(ed.id, buf);
    const reads = db.prepare('SELECT * FROM buffer_reads WHERE user_id = ?').all(ed.id);
    expect(reads.length).toBe(1);
    // last_read_message_id points to a message that exists in this DB.
    const msg = db.prepare('SELECT id FROM messages WHERE id = ?').get(reads[0].last_read_message_id);
    expect(msg).toBeDefined();
  });

  it('rejects an archive without a manifest', async () => {
    const eve = createUser(`eve_${Date.now()}`);
    // A zip with only an unrelated file.
    const { ZipArchive } = await import('archiver');
    const archive = new ZipArchive();
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.append('hello', { name: 'random.txt' });
    await archive.finalize();
    const buf = Buffer.concat(chunks);
    await expect(importFromZipBuffer(eve.id, buf)).rejects.toMatchObject({
      code: 'missing_manifest',
    });
  });

  it('rejects an archive with a future format version', async () => {
    const frank = createUser(`frank_${Date.now()}`);
    const { ZipArchive } = await import('archiver');
    const archive = new ZipArchive();
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.append(
      JSON.stringify({ export_format_version: EXPORT_FORMAT_VERSION + 99 }),
      { name: 'manifest.json' },
    );
    archive.append('{}', { name: 'data.json' });
    await archive.finalize();
    const buf = Buffer.concat(chunks);
    await expect(importFromZipBuffer(frank.id, buf)).rejects.toMatchObject({
      code: 'format_too_new',
    });
  });

  it('rejects a non-zip blob', async () => {
    const gabby = createUser(`gabby_${Date.now()}`);
    const buf = Buffer.from('this is not a zip file, just text');
    await expect(importFromZipBuffer(gabby.id, buf)).rejects.toBeInstanceOf(ImportError);
  });
});

// Full equivalence: every exported table populated, exported, imported, and
// then compared row-for-row across the two accounts. Columns that are
// expected to differ (rekeyed FKs, autoincrement PKs, last_seen_at on users)
// are projected out so the comparison fails *only* if the payload diverged.
describe('importFromZipBuffer — end-to-end equivalence', () => {
  function uniqueUsername(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  // Seeds every table declared as 'export' or 'partial' so the equivalence
  // test exercises the full registry, not a subset.
  function seedComplete() {
    const user = createUser(uniqueUsername('alice'));
    const net1 = createNetwork(user.id, {
      name: 'libera', host: 'irc.libera.chat', port: 6697, tls: true,
      nick: 'alice', username: 'alice_u', realname: 'Alice Tester',
      server_password: 'svrpw', autoconnect: true,
      sasl_account: 'alice', sasl_password: 'sp', connect_commands: 'JOIN #foo',
    });
    const net2 = createNetwork(user.id, {
      name: 'oftc', host: 'irc.oftc.net', port: 6697, tls: true, nick: 'alice',
    });
    upsertChannel(net1.id, '#general', true);
    upsertChannel(net1.id, '#dev', false);
    upsertChannel(net2.id, '#support', true);

    const m1 = insertMessage({
      networkId: net1.id, target: '#general', time: '2026-05-17T10:00:00Z',
      type: 'message', nick: 'alice', text: 'hello', self: 1, userhost: 'alice!a@host',
    });
    const m2 = insertMessage({
      networkId: net1.id, target: '#general', time: '2026-05-17T10:01:00Z',
      type: 'message', nick: 'bob', text: 'hi alice', self: 0,
    });
    insertMessage({
      networkId: net2.id, target: '#support', time: '2026-05-17T10:02:00Z',
      type: 'action', nick: 'alice', text: 'waves', self: 1,
    });

    setUserSetting(user.id, 'appearance.theme.name', 'dark');
    setUserSetting(user.id, 'chat.consolidate.join_part', true);
    const rule = createRule(user.id, { pattern: 'alice', kind: 'plain', case_sensitive: 0 });
    createRule(user.id, { pattern: 'urgent', kind: 'regex', case_sensitive: 1 });
    // highlight_rule_networks via direct insert (no helper exposes it cleanly).
    db.prepare(
      'INSERT INTO highlight_rule_networks (rule_id, network_id) VALUES (?, ?)',
    ).run(rule.id, net1.id);

    setNote({ userId: user.id, networkId: net1.id, nick: 'bob', note: 'in berlin' });
    setNote({ userId: user.id, networkId: net2.id, nick: 'carol', note: 'op of #support' });
    addMask({ userId: user.id, networkId: net1.id, mask: 'spammer!*@*' });
    addMask({ userId: user.id, networkId: net2.id, mask: '*!*@evilhost' });
    pinBuffer(user.id, net1.id, '#general');
    pinBuffer(user.id, net2.id, '#support');
    setNicklistCollapsed(user.id, net1.id, '#dev', true);
    setChannelNotifyAlways(user.id, net1.id, '#general', true);
    upsertDraft(user.id, net1.id, '#dev', 'half-typed thought');
    closeBuffer(user.id, net1.id, '#oldchan');
    addBookmark(user.id, m1.id);
    addBookmark(user.id, m2.id);
    setReadState(user.id, net1.id, '#general', m2.id);
    writeAwayMarker(user.id, {
      awayDatetime: '2026-05-17T11:00:00Z',
      awayMessage: 'brb',
      autoSet: false,
    });
    addInputHistory(user.id, net1.id, '#general', '/whois bob');
    addInputHistory(user.id, net1.id, '#general', '/me waves');

    insertUpload(user.id, {
      provider: 'hoarder', url: 'https://example.com/foo.jpg',
      filename: 'foo.jpg', mime: 'image/jpeg', byte_size: 1234,
      width: 100, height: 100,
      thumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]),
    });
    insertUpload(user.id, {
      provider: 'catbox', url: 'https://example.com/bar.png',
      filename: 'bar.png', mime: 'image/png', byte_size: 5678,
      width: 200, height: 150,
      thumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]),
    });

    return user;
  }

  // Columns that legitimately differ between the source and target accounts.
  // Per-table FK-rekey columns are taken from the registry; PKs of
  // autoincrement tables also differ; matched_rule_id can legitimately turn
  // to NULL on import if its rule wasn't carried over (it shouldn't here).
  function projectionFor(table, def) {
    const skip = new Set();
    if (def.pk) skip.add(def.pk);
    if (def.fkRekey) for (const col of Object.keys(def.fkRekey)) skip.add(col);
    return def.columns.filter((c) => !skip.has(c) && !def.blobColumns?.includes(c));
  }

  function rowsFor(userId, table, def) {
    let sql;
    switch (def.scope) {
      case 'identity':
        sql = `SELECT * FROM ${table} WHERE id = ?`;
        break;
      case 'user_id':
        sql = `SELECT * FROM ${table} WHERE user_id = ?`;
        break;
      case 'via_network':
        sql = `SELECT * FROM ${table}
               WHERE network_id IN (SELECT id FROM networks WHERE user_id = ?)`;
        break;
      case 'via_rules':
        sql = `SELECT * FROM ${table}
               WHERE rule_id IN (SELECT id FROM highlight_rules WHERE user_id = ?)`;
        break;
      default:
        throw new Error(`unknown scope ${def.scope}`);
    }
    return db.prepare(sql).all(userId);
  }

  // Sort rows deterministically using their stable (non-rekeyed) columns so
  // the comparison doesn't depend on insertion order or autoincrement ids.
  function sortKey(row, keys) {
    return keys
      .map((k) => {
        const v = row[k];
        if (v instanceof Buffer) return v.toString('base64');
        return JSON.stringify(v ?? null);
      })
      .join('|');
  }

  function projectRows(rows, projection) {
    return rows
      .map((row) => {
        const out = {};
        for (const c of projection) out[c] = row[c];
        return out;
      })
      .sort((a, b) => sortKey(a, projection).localeCompare(sortKey(b, projection)));
  }

  // upload_history thumbnails ship as separate zip entries, but on the
  // imported side they end up back in the row. Compare BLOBs by content.
  function blobsFor(userId) {
    const rows = db
      .prepare(`SELECT thumbnail FROM upload_history WHERE user_id = ? ORDER BY id ASC`)
      .all(userId);
    return rows
      .map((r) => (r.thumbnail ? Buffer.from(r.thumbnail).toString('base64') : null))
      .sort();
  }

  it('round-trips every exported table with payload-identical content', async () => {
    const alice = seedComplete();
    const bob = createUser(uniqueUsername('bob'));

    const buf = await exportToBuffer(alice.id, { includeMessages: true });
    await importFromZipBuffer(bob.id, buf);

    for (const [table, def] of Object.entries(EXPORT_TABLES)) {
      if (def.mode !== 'export' && def.mode !== 'partial') continue;
      // `users` is identity-only: alice keeps her username on alice's
      // instance, bob keeps his on bob's. We don't expect equivalence here.
      if (table === 'users') continue;

      const aliceRows = rowsFor(alice.id, table, def);
      const bobRows = rowsFor(bob.id, table, def);

      // Count parity first — catches missing inserts before we get into
      // payload comparisons (the payload diff would also catch it, but the
      // count failure points at the table much more directly).
      expect(
        bobRows.length,
        `row count mismatch for ${table}: alice=${aliceRows.length}, bob=${bobRows.length}`,
      ).toBe(aliceRows.length);

      const projection = projectionFor(table, def);
      if (projection.length === 0) continue; // table is pure-FK (e.g. highlight_rule_networks)

      expect(
        projectRows(bobRows, projection),
        `payload mismatch for ${table}`,
      ).toEqual(projectRows(aliceRows, projection));
    }

    // BLOBs aren't in the column projection — verify separately.
    expect(blobsFor(bob.id)).toEqual(blobsFor(alice.id));

    // Structural FK sanity: every per-network row in bob's tables must
    // point at one of bob's networks, not alice's.
    const bobNetIds = new Set(
      db.prepare('SELECT id FROM networks WHERE user_id = ?').all(bob.id).map((r) => r.id),
    );
    const tablesWithNetworkFk = Object.entries(EXPORT_TABLES)
      .filter(([, d]) => d.fkRekey && Object.values(d.fkRekey).includes('networks'))
      .map(([t]) => t);
    for (const t of tablesWithNetworkFk) {
      const stray = db
        .prepare(`SELECT COUNT(*) AS n FROM ${t}
                  WHERE network_id IS NOT NULL
                    AND network_id NOT IN (SELECT id FROM networks WHERE user_id = ?)`)
        .get(bob.id).n;
      // We're querying ${t} unscoped, so this catches alice's rows too if
      // any happened to claim bob's id space. The check is meaningful only
      // for tables where we can scope by user_id; restrict to those.
      if (EXPORT_TABLES[t].scope === 'user_id') {
        const strayForBob = db
          .prepare(`SELECT COUNT(*) AS n FROM ${t}
                    WHERE user_id = ?
                      AND network_id NOT IN (SELECT id FROM networks WHERE user_id = ?)`)
          .get(bob.id, bob.id).n;
        expect(strayForBob, `${t} has bob rows referencing non-bob networks`).toBe(0);
      }
    }

    // Rule-network junction (no user_id column) — verify via_rules scope.
    const junctionStray = db
      .prepare(`SELECT COUNT(*) AS n FROM highlight_rule_networks
                WHERE rule_id IN (SELECT id FROM highlight_rules WHERE user_id = ?)
                  AND network_id NOT IN (SELECT id FROM networks WHERE user_id = ?)`)
      .get(bob.id, bob.id).n;
    expect(junctionStray).toBe(0);
  });
});
