// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import yauzl from 'yauzl';

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
let insertUpload;
let buildExportZip;
let buildExportFilename;
let computeExportPreview;
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
  ({ buildExportZip, buildExportFilename, computeExportPreview } = await import('./exportService.js'));
  ({ EXPORT_FORMAT_VERSION } = await import('../db/exportSchema.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readZipToMap(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = new Map();
      zip.readEntry();
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e2, stream) => {
          if (e2) return reject(e2);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', () => resolve(out));
    });
  });
}

async function runExport(userId, opts) {
  const sink = new PassThrough();
  const chunks = [];
  sink.on('data', (c) => chunks.push(c));
  await buildExportZip(userId, opts, sink);
  return Buffer.concat(chunks);
}

describe('buildExportZip', () => {
  let alice;
  let aliceNetA;
  let aliceMsg1;
  let aliceMsg2;

  beforeAll(async () => {
    alice = createUser('alice');
    aliceNetA = createNetwork(alice.id, {
      name: 'libera', host: 'irc.libera.chat', port: 6697, tls: true, nick: 'alice',
    });
    upsertChannel(aliceNetA.id, '#general', true);

    aliceMsg1 = insertMessage({
      networkId: aliceNetA.id, target: '#general', time: '2026-05-17T10:00:00Z',
      type: 'message', nick: 'alice', text: 'hello world', self: 1,
    });
    aliceMsg2 = insertMessage({
      networkId: aliceNetA.id, target: '#general', time: '2026-05-17T10:01:00Z',
      type: 'message', nick: 'bob', text: 'hi alice', self: 0,
    });

    setUserSetting(alice.id, 'appearance.theme.name', 'dark');
    createRule(alice.id, { pattern: 'alice', kind: 'plain', case_sensitive: 0 });
    setNote({ userId: alice.id, networkId: aliceNetA.id, nick: 'bob', note: 'lives in berlin' });
    addMask({ userId: alice.id, networkId: aliceNetA.id, mask: 'spammer!*@*' });
    pinBuffer(alice.id, aliceNetA.id, '#general');
    addBookmark(alice.id, aliceMsg1.id);

    // upload_history with a thumbnail blob
    insertUpload(alice.id, {
      provider: 'hoarder', url: 'https://example.com/foo.jpg',
      filename: 'foo.jpg', mime: 'image/jpeg', byte_size: 1234,
      width: 100, height: 100, thumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
    });
  });

  it('includes manifest.json with format version and counts', async () => {
    const buf = await runExport(alice.id, { includeMessages: false });
    const entries = await readZipToMap(buf);
    expect(entries.has('manifest.json')).toBe(true);
    const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
    expect(manifest.export_format_version).toBe(EXPORT_FORMAT_VERSION);
    expect(manifest.source_user_id).toBe(alice.id);
    expect(manifest.sections).toContain('data');
    expect(manifest.sections).not.toContain('messages');
    expect(manifest.counts.networks).toBe(1);
    expect(manifest.counts.messages).toBe(0);
  });

  it('omits messages.ndjson and bookmarks.json when includeMessages is false', async () => {
    const buf = await runExport(alice.id, { includeMessages: false });
    const entries = await readZipToMap(buf);
    expect(entries.has('messages.ndjson')).toBe(false);
    expect(entries.has('bookmarks.json')).toBe(false);
  });

  it('includes messages.ndjson and bookmarks.json when includeMessages is true', async () => {
    const buf = await runExport(alice.id, { includeMessages: true });
    const entries = await readZipToMap(buf);
    expect(entries.has('messages.ndjson')).toBe(true);
    expect(entries.has('bookmarks.json')).toBe(true);

    const lines = entries.get('messages.ndjson').toString('utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const rows = lines.map((l) => JSON.parse(l));
    expect(rows[0].text).toBe('hello world');
    expect(rows[1].text).toBe('hi alice');

    const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
    expect(manifest.sections).toContain('messages');
    expect(manifest.sections).toContain('bookmarks');
    expect(manifest.counts.messages).toBe(2);
  });

  it('writes data.json with networks, channels, and other per-user rows', async () => {
    const buf = await runExport(alice.id, { includeMessages: false });
    const entries = await readZipToMap(buf);
    const data = JSON.parse(entries.get('data.json').toString('utf8'));
    expect(data.networks.length).toBe(1);
    expect(data.networks[0].name).toBe('libera');
    expect(data.channels.length).toBe(1);
    expect(data.channels[0].name).toBe('#general');
    expect(data.users.length).toBe(1);
    expect(data.users[0].username).toBe('alice');
  });

  it('emits upload thumbnails as separate zip entries and strips the blob from data.json', async () => {
    const buf = await runExport(alice.id, { includeMessages: false });
    const entries = await readZipToMap(buf);
    const data = JSON.parse(entries.get('data.json').toString('utf8'));
    const upload = data.upload_history[0];
    expect(upload).toBeDefined();
    expect('thumbnail' in upload).toBe(false);
    expect(upload.hasThumbnail).toBe(true);
    expect(entries.has(`thumbnails/${upload.id}.jpg`)).toBe(true);
    expect(entries.get(`thumbnails/${upload.id}.jpg`).length).toBeGreaterThan(0);
  });

  it('scopes data per-user (bob does not see alice)', async () => {
    const bob = createUser('bob_scope');
    createNetwork(bob.id, {
      name: 'bobnet', host: 'irc.bobnet', port: 6697, tls: true, nick: 'bob',
    });
    const bufBob = await runExport(bob.id, { includeMessages: true });
    const entriesBob = await readZipToMap(bufBob);
    const dataBob = JSON.parse(entriesBob.get('data.json').toString('utf8'));
    expect(dataBob.networks.length).toBe(1);
    expect(dataBob.networks[0].name).toBe('bobnet');
    // alice's messages don't leak.
    const lines = (entriesBob.get('messages.ndjson') || Buffer.from('')).toString('utf8').trim();
    expect(lines).toBe('');
  });
});

describe('buildExportFilename', () => {
  it('includes username and date and a settings suffix when no messages', () => {
    const name = buildExportFilename('alice', { includeMessages: false });
    expect(name).toMatch(/^lurker-export-alice-\d{8}-settings\.lurk$/);
  });
  it('omits suffix when messages are included', () => {
    const name = buildExportFilename('alice', { includeMessages: true });
    expect(name).toMatch(/^lurker-export-alice-\d{8}\.lurk$/);
  });
  it('sanitizes special chars', () => {
    const name = buildExportFilename('al ice/!.', { includeMessages: true });
    expect(name).toMatch(/^lurker-export-al_ice___-\d{8}\.lurk$/);
  });
});

describe('computeExportPreview', () => {
  it('returns 0 for messages section when includeMessages is false', () => {
    const alice = db.prepare(`SELECT id FROM users WHERE username = 'alice'`).get();
    const counts = computeExportPreview(alice.id, { includeMessages: false });
    expect(counts.messages).toBe(0);
    expect(counts.networks).toBeGreaterThan(0);
  });
  it('returns real message counts when includeMessages is true', () => {
    const alice = db.prepare(`SELECT id FROM users WHERE username = 'alice'`).get();
    const counts = computeExportPreview(alice.id, { includeMessages: true });
    expect(counts.messages).toBeGreaterThan(0);
  });
});
