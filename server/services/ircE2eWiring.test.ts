// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Phase 1c IRC wiring (#382): the seam between the E2eManager and live IRC
// traffic. These exercise the GLUE — does the outbound path put `+RPE2E01` on
// the wire while showing the sender plaintext; does an inbound chunk get
// decrypted (or a missing-key surfaced, not persisted as ciphertext); does a
// handshake CTCP ride NOTICE both ways; do the `/e2e …` commands dispatch. The
// crypto itself is pinned in server/services/e2e/*.test.ts, so we use real
// crypto for the new transport plumbing and spy the manager where only the
// routing decision is under test.

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { IrcConnection } from './ircConnection.js';
import ircManager from './ircManager.js';
import { e2eManager } from './e2e/manager.js';
import * as keyring from '../db/e2e.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';

const CTCP = '';
const WIRE = '+RPE2E01';

// alice = the IrcConnection's account (user_id 1, network 1); bob = a remote
// peer with his own keyring identity (user_id 2). Both ride the process-wide
// e2eManager singleton, which keys all state by (userId, networkId).
beforeAll(() => {
  createUser('e2e-alice'); // id 1
  createUser('e2e-bob'); // id 2
  // The e2e keyring rows FK to users + networks, so seed both network ids too.
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network id 1
  createNetwork(2, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'bob' }); // network id 2
});

function makeConn(): IrcConnection {
  return new IrcConnection({
    network: {
      id: 1,
      user_id: 1,
      name: 'n',
      host: 'irc.example.test',
      port: 6697,
      tls: 1,
      trusted_certificates: 1,
      nick: 'alice',
      username: null,
      realname: null,
      server_password: null,
      autoconnect: 1,
      sasl_account: null,
      sasl_password: null,
      connect_commands: null,
      position: 0,
      created_at: new Date().toISOString(),
    },
    onEvent: () => {},
  });
}

describe('outbound encrypt (ircManager.send)', () => {
  it('puts +RPE2E01 chunks on the wire but publishes the plaintext with an e2e flag', () => {
    const say = vi.fn<(target: string, text: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    const fakeConn = {
      say,
      publish,
      client: { user: { nick: 'alice' } },
      supportsMultiline: () => false,
    } as unknown as IrcConnection;
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(fakeConn);
    e2eManager.setChannelConfig(1, 1, '#enc', true, 'normal');

    const ok = ircManager.send(1, 1, '#enc', 'hello world');
    expect(ok).toBe(true);

    // Every wire line is ciphertext, never the cleartext.
    expect(say).toHaveBeenCalled();
    for (const [target, line] of say.mock.calls) {
      expect(target).toBe('#enc');
      expect(line.startsWith(WIRE)).toBe(true);
      expect(line).not.toContain('hello world');
    }
    // The sender sees exactly one readable bubble, flagged encrypted.
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        target: '#enc',
        text: 'hello world',
        e2e: true,
        self: true,
      }),
    );
    vi.restoreAllMocks();
  });

  it('falls through to a normal plaintext send when E2E is disabled for the channel', () => {
    const say = vi.fn<(target: string, text: string) => void>();
    const publish = vi.fn<(event: unknown) => void>();
    const fakeConn = {
      say,
      publish,
      client: { user: { nick: 'alice' } },
      supportsMultiline: () => false,
    } as unknown as IrcConnection;
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(fakeConn);

    ircManager.send(1, 1, '#plain', 'hello world');

    expect(say).toHaveBeenCalledWith('#plain', 'hello world');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', target: '#plain', text: 'hello world' }),
    );
    expect(publish.mock.calls[0][0]).not.toHaveProperty('e2e', true);
    vi.restoreAllMocks();
  });
});

describe('inbound decrypt (c.on message)', () => {
  it('renders a decrypted chunk as plaintext with the e2e flag', () => {
    const conn = makeConn();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    vi.spyOn(e2eManager, 'decryptIncoming').mockReturnValue({ kind: 'plaintext', text: 'secret' });

    conn.client.emit('message', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      target: '#in',
      type: 'privmsg',
      message: `${WIRE} 00112233aabbccdd 0 1/1 nonce:ct`,
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ target: '#in', nick: 'bob', text: 'secret', e2e: true }),
    );
    vi.restoreAllMocks();
  });

  it('surfaces a missing-key hint and never persists raw ciphertext', () => {
    const conn = makeConn();
    const publish = vi.fn<(event: unknown) => void>();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    conn.publishEphemeral = publishEphemeral;
    vi.spyOn(e2eManager, 'decryptIncoming').mockReturnValue({ kind: 'missing-key' });

    conn.client.emit('message', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      target: '#in',
      type: 'privmsg',
      message: `${WIRE} 00112233aabbccdd 0 1/1 nonce:ct`,
    });

    expect(publish).not.toHaveBeenCalled();
    expect(publishEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system', target: '#in' }),
    );
    expect(publishEphemeral.mock.calls[0][0]).toMatchObject({
      text: expect.stringContaining('no session key'),
    });
    vi.restoreAllMocks();
  });

  it('leaves a plain (non-RPE2E) channel message untouched', () => {
    const conn = makeConn();
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    const spy = vi.spyOn(e2eManager, 'decryptIncoming');

    conn.client.emit('message', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      target: '#in',
      type: 'privmsg',
      message: 'just a normal line',
    });

    expect(spy).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ target: '#in', text: 'just a normal line' }),
    );
    expect(publish.mock.calls[0][0]).not.toHaveProperty('e2e', true);
    vi.restoreAllMocks();
  });
});

describe('handshake transport (c.on ctcp response)', () => {
  it('answers a real KEYREQ with a CTCP-framed KEYRSP NOTICE to the sender', () => {
    const conn = makeConn();
    const notice = vi.fn<(target: string, text: string) => void>();
    conn.client.notice = notice;
    conn.publishEphemeral = vi.fn<(event: unknown) => void>();
    e2eManager.setChannelConfig(1, 1, '#hs', true, 'auto-accept');

    // bob builds a genuine, signed KEYREQ from his own identity.
    const body = e2eManager.buildKeyReq(2, 2, '#hs');
    expect(body).toBeTruthy();

    conn.client.emit('ctcp response', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      target: '#hs',
      type: 'RPEE2E',
      message: body,
    });

    expect(notice).toHaveBeenCalled();
    const [target, line] = notice.mock.calls[0];
    expect(target).toBe('bob');
    expect(line.startsWith(`${CTCP}RPEE2E KEYRSP `)).toBe(true);
    expect(line.endsWith(CTCP)).toBe(true);
  });

  it('routes a handshake notice to the channel buffer when joined, else the server buffer', () => {
    const conn = makeConn();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = publishEphemeral;
    conn.upsertChannel('#rt'); // we're in #rt

    conn.surfaceE2eNotice({ level: 'info', text: 'hi' }, '#rt');
    expect(publishEphemeral).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'system', target: '#rt', text: 'hi' }),
    );

    conn.surfaceE2eNotice({ level: 'warn', text: 'bye' }, '#notjoined');
    expect(publishEphemeral).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'error', target: ':server:1' }),
    );
  });

  it('ignores a non-RPEE2E CTCP response without replying', () => {
    const conn = makeConn();
    const notice = vi.fn<(target: string, text: string) => void>();
    conn.client.notice = notice;

    conn.client.emit('ctcp response', {
      nick: 'someone',
      ident: 'i',
      hostname: 'h',
      type: 'VERSION',
      message: 'VERSION SomeClient 1.0',
    });

    expect(notice).not.toHaveBeenCalled();
  });
});

describe('/e2e command dispatch (runE2eCommand)', () => {
  it('on <#chan> <mode> writes the channel config', () => {
    const conn = makeConn();
    conn.publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.runE2eCommand('#cmd', 'on #cmd auto');
    const cfg = keyring.getChannelConfig(1, 1, '#cmd');
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.mode).toBe('auto-accept');
  });

  it('fingerprint reports the account identity', () => {
    const conn = makeConn();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = publishEphemeral;
    conn.runE2eCommand(':server:1', 'fingerprint');
    const texts = publishEphemeral.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(texts.some((t) => t.includes('your fingerprint'))).toBe(true);
  });

  it('handshake <nick> sends a CTCP-framed KEYREQ NOTICE from the issuing channel', () => {
    const conn = makeConn();
    conn.publishEphemeral = vi.fn<(event: unknown) => void>();
    const notice = vi.fn<(target: string, text: string) => void>();
    conn.client.notice = notice;
    conn.runE2eCommand('#cmd', 'handshake carol');
    expect(notice).toHaveBeenCalled();
    const [target, line] = notice.mock.calls[0];
    expect(target).toBe('carol');
    expect(line.startsWith(`${CTCP}RPEE2E KEYREQ `)).toBe(true);
  });

  it('rejects a channel op issued without a channel', () => {
    const conn = makeConn();
    const publishEphemeral = vi.fn<(event: unknown) => void>();
    conn.publishEphemeral = publishEphemeral;
    conn.runE2eCommand(':server:1', 'on');
    expect(publishEphemeral).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
