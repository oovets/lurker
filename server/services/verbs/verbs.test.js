// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-verbs-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser;
let createNetwork;
let insertMessage;
let callVerb;

let owner;
let intruder;
let net;
let otherNet;

beforeAll(async () => {
  ({ createUser } = await import('../../db/users.js'));
  ({ createNetwork } = await import('../../db/networks.js'));
  ({ insertMessage } = await import('../../db/messages.js'));
  // Importing the verbs aggregator triggers registration as a side effect.
  await import('./index.js');
  ({ callVerb } = await import('../verbRegistry.js'));

  owner = createUser('verbs-owner');
  intruder = createUser('verbs-intruder');
  net = createNetwork(owner.id, {
    name: 'libera', host: 'h', port: 6697, tls: true, nick: 'owner',
  });
  otherNet = createNetwork(intruder.id, {
    name: 'oftc', host: 'h', port: 6697, tls: true, nick: 'intruder',
  });

  const t = new Date().toISOString();
  insertMessage({ networkId: net.id, target: '#chan', time: t, type: 'message', nick: 'alice', text: 'hello world', self: false });
  insertMessage({ networkId: net.id, target: '#chan', time: t, type: 'message', nick: 'bob', text: 'second message', self: false });
  insertMessage({ networkId: net.id, target: '#chan', time: t, type: 'message', nick: 'alice', text: 'deployment ready', self: false });
  insertMessage({ networkId: net.id, target: 'bob', time: t, type: 'message', nick: 'bob', text: 'private msg', self: false });
  insertMessage({ networkId: net.id, target: ':server:libera', time: t, type: 'notice', nick: null, text: 'motd', self: false });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const rwCtx = (userId) => ({ userId, scope: 'read-write', transport: 'ws' });
const rCtx = (userId) => ({ userId, scope: 'read', transport: 'ws' });

describe('list_networks', () => {
  it('returns the caller\'s networks with connected=false when no live connection', () => {
    const result = callVerb('list_networks', rCtx(owner.id), {});
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: net.id, name: 'libera', connected: false, nick: 'owner' });
  });

  it('is user-scoped — never leaks another user\'s networks', () => {
    const result = callVerb('list_networks', rCtx(intruder.id), {});
    expect(result.map((n) => n.id)).toEqual([otherNet.id]);
  });
});

describe('list_buffers', () => {
  it('returns the caller\'s buffers and excludes :server:* pseudo-buffers', () => {
    const result = callVerb('list_buffers', rCtx(owner.id), {});
    const targets = result.map((b) => b.target).sort();
    expect(targets).toEqual(['#chan', 'bob']);
    expect(result.find((b) => b.target === '#chan').kind).toBe('channel');
    expect(result.find((b) => b.target === 'bob').kind).toBe('dm');
  });

  it('honors the networkId filter and rejects another user\'s networkId at the boundary', () => {
    const only = callVerb('list_buffers', rCtx(owner.id), { networkId: net.id });
    expect(only.every((b) => b.networkId === net.id)).toBe(true);
    expect(() => callVerb('list_buffers', rCtx(owner.id), { networkId: otherNet.id }))
      .toThrow(/unknown network/);
  });
});

describe('recent_messages', () => {
  it('returns oldest-first with hasOlder=false when buffer has fewer rows than limit', () => {
    const result = callVerb('recent_messages', rCtx(owner.id), {
      networkId: net.id, target: '#chan', limit: 10,
    });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].text).toBe('hello world');
    expect(result.messages[2].text).toBe('deployment ready');
    expect(result.hasOlder).toBe(false);
  });

  it('hasOlder=true when more rows exist before the window', () => {
    const result = callVerb('recent_messages', rCtx(owner.id), {
      networkId: net.id, target: '#chan', limit: 1,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('deployment ready');
    expect(result.hasOlder).toBe(true);
  });

  it('decorates each message with the dm/matched/notify flags', () => {
    const result = callVerb('recent_messages', rCtx(owner.id), {
      networkId: net.id, target: 'bob', limit: 10,
    });
    expect(result.messages[0]).toHaveProperty('dm', true);
    expect(result.messages[0]).toHaveProperty('notify');
  });

  it('rejects another user\'s networkId at the boundary', () => {
    expect(() => callVerb('recent_messages', rCtx(owner.id), {
      networkId: otherNet.id, target: '#chan', limit: 5,
    })).toThrow(/unknown network/);
  });
});

describe('search_messages', () => {
  it('matches against FTS index, decorates results, scopes to the caller', () => {
    const result = callVerb('search_messages', rCtx(owner.id), { query: 'deployment' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('deployment ready');
    // Caller's network only.
    expect(result.messages[0].networkId).toBe(net.id);
  });

  it('returns empty when nothing matches', () => {
    const result = callVerb('search_messages', rCtx(owner.id), { query: 'xyzzy-no-such-term' });
    expect(result.messages).toEqual([]);
  });
});

describe('get_nick_note / set_nick_note', () => {
  it('get returns an empty note when none is set; set writes and round-trips', () => {
    const empty = callVerb('get_nick_note', rCtx(owner.id), { networkId: net.id, nick: 'alice' });
    expect(empty.note).toBe('');
    expect(empty.updatedAt).toBeNull();
    const set = callVerb('set_nick_note', rwCtx(owner.id), {
      networkId: net.id, nick: 'alice', note: 'works at Acme',
    });
    expect(set.note).toBe('works at Acme');
    expect(set.updatedAt).not.toBeNull();
    const got = callVerb('get_nick_note', rCtx(owner.id), { networkId: net.id, nick: 'alice' });
    expect(got.note).toBe('works at Acme');
  });

  it('set with empty string deletes the note', () => {
    callVerb('set_nick_note', rwCtx(owner.id), { networkId: net.id, nick: 'carol', note: 'to delete' });
    callVerb('set_nick_note', rwCtx(owner.id), { networkId: net.id, nick: 'carol', note: '' });
    const got = callVerb('get_nick_note', rCtx(owner.id), { networkId: net.id, nick: 'carol' });
    expect(got.note).toBe('');
  });

  it('set_nick_note caps body at 4096 chars', () => {
    const long = 'x'.repeat(5000);
    const result = callVerb('set_nick_note', rwCtx(owner.id), { networkId: net.id, nick: 'dave', note: long });
    expect(result.note.length).toBe(4096);
  });

  it('set_nick_note rejected when caller has read-only scope', () => {
    expect(() => callVerb('set_nick_note', rCtx(owner.id), {
      networkId: net.id, nick: 'eve', note: 'denied',
    })).toThrow(/scope insufficient/);
  });
});

describe('send_message / send_action', () => {
  it('returns ok=false, error=not-connected when no live IRC connection', () => {
    const result = callVerb('send_message', rwCtx(owner.id), {
      networkId: net.id, target: '#chan', text: 'hi',
    });
    expect(result).toEqual({ ok: false, error: 'not-connected' });
  });

  it('send_action shares the same error shape', () => {
    const result = callVerb('send_action', rwCtx(owner.id), {
      networkId: net.id, target: '#chan', text: 'waves',
    });
    expect(result).toEqual({ ok: false, error: 'not-connected' });
  });

  it('send_message is rejected for read-only scope', () => {
    expect(() => callVerb('send_message', rCtx(owner.id), {
      networkId: net.id, target: '#chan', text: 'hi',
    })).toThrow(/scope insufficient/);
  });

  it('rejects empty target or text without round-tripping ircManager', () => {
    expect(callVerb('send_message', rwCtx(owner.id), {
      networkId: net.id, target: '', text: 'hi',
    })).toEqual({ ok: false, error: 'empty-target-or-text' });
    expect(callVerb('send_message', rwCtx(owner.id), {
      networkId: net.id, target: '#chan', text: '',
    })).toEqual({ ok: false, error: 'empty-target-or-text' });
  });
});
