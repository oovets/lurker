// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Throwaway DB before importing anything that touches the db singleton.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-slack-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

// Fake Slack SDKs. Defined via vi.hoisted so the vi.mock factories below can
// reference them. The WebClient fake answers the handful of methods connect()
// drives; the socket fake captures its event handlers so the test can push a
// live message through them.
const h = vi.hoisted(() => {
  const handlers: Record<string, (a: unknown) => unknown> = {};
  const posts: Array<{ channel: string; text: string }> = [];
  const web = {
    auth: { test: async () => ({ user_id: 'U_SELF', user: 'me' }) },
    users: {
      list: async () => ({
        members: [
          { id: 'U1', name: 'alice', profile: { display_name: 'Alice' } },
          { id: 'U_SELF', name: 'me', profile: {} },
        ],
        response_metadata: {},
      }),
      conversations: async () => ({
        channels: [
          { id: 'C1', name: 'general', is_im: false, topic: { value: 'hi there' } },
          { id: 'D1', is_im: true, user: 'U1' },
        ],
        response_metadata: {},
      }),
      info: async ({ user }: { user: string }) => ({ user: { id: user, name: user } }),
    },
    conversations: {
      members: async () => ({ members: ['U1', 'U_SELF'] }),
      history: async ({ channel }: { channel: string }) =>
        channel === 'C1'
          ? { messages: [{ ts: '1700000000.000100', user: 'U1', text: 'hello world' }] }
          : { messages: [] },
    },
    chat: {
      postMessage: async (args: { channel: string; text: string }) => {
        posts.push(args);
        return { ok: true, ts: '1700000000.000300' };
      },
    },
  };
  const socket = {
    on: (type: string, fn: (a: unknown) => unknown) => {
      handlers[type] = fn;
    },
    start: async () => {},
    disconnect: async () => {},
  };
  return { web, socket, handlers, posts };
});

vi.mock('@slack/web-api', () => ({
  WebClient: function WebClient() {
    return h.web;
  },
}));
vi.mock('@slack/socket-mode', () => ({
  SocketModeClient: function SocketModeClient() {
    return h.socket;
  },
}));

let db: typeof import('../db/index.js').default;
let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let SlackConnection: typeof import('./slackConnection.js').SlackConnection;

// Minimal shapes for asserting against the loosely-typed snapshot/events.
interface SnapMember {
  nick: string;
}
interface SnapChannel {
  name: string;
  members: SnapMember[];
}
interface AnyEvent {
  type: string;
  state?: string;
  target?: string;
  nick?: string;
  text?: string;
  kind?: string;
}

beforeAll(async () => {
  db = (await import('../db/index.js')).default;
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ SlackConnection } = await import('./slackConnection.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SlackConnection', () => {
  it('connects: builds channel buffers + members, persists history, sends, streams live', async () => {
    const user = createUser('me');
    const net = createNetwork(user.id, {
      name: 'Slack',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'xoxb-test',
      slack_app_token: 'xapp-test',
    });
    expect(net).toBeDefined();

    const events: AnyEvent[] = [];
    const conn = new SlackConnection({
      network: net!,
      onEvent: (e) => events.push(e as unknown as AnyEvent),
    });

    // connect() is the sync wrapper; await the async body directly.
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    // Channels became buffers, with the nicklist resolved from ids to names.
    const snap = conn.snapshot() as unknown as { channels: SnapChannel[] };
    const general = snap.channels.find((c) => c.name === '#general');
    expect(general).toBeDefined();
    expect(general!.members.map((m) => m.nick).sort()).toEqual(['Alice', 'me']);

    // Recent history was mirrored into the messages table (served via backlog).
    const rows = db
      .prepare("SELECT target, nick, text FROM messages WHERE target = '#general'")
      .all();
    expect(rows).toEqual([{ target: '#general', nick: 'Alice', text: 'hello world' }]);

    // The 'connected' state event is what makes wsHub re-snapshot the client.
    expect(events.some((e) => e.type === 'state' && e.state === 'connected')).toBe(true);

    // Sending resolves the target back to the Slack channel id.
    conn.say('#general', 'yo');
    expect(h.posts).toContainEqual({ channel: 'C1', text: 'yo' });

    // A live socket-mode message publishes a Lurker 'message' event for the buffer.
    events.length = 0;
    const onMessage = h.handlers['message'];
    expect(onMessage).toBeTypeOf('function');
    await onMessage({
      event: { channel: 'C1', ts: '1700000000.000900', user: 'U1', text: 'live!' },
      ack: async () => {},
    });
    const live = events.find((e) => e.type === 'message');
    expect(live).toMatchObject({
      target: '#general',
      nick: 'Alice',
      text: 'live!',
      kind: 'privmsg',
    });
  });

  it('demo mode: builds a canned workspace + drips live messages, no real Slack', async () => {
    vi.useFakeTimers();
    const user = createUser('demoer');
    const net = createNetwork(user.id, {
      name: 'Demo',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'demo',
      slack_app_token: 'demo',
    });
    const events: AnyEvent[] = [];
    const conn = new SlackConnection({
      network: net!,
      onEvent: (e) => events.push(e as unknown as AnyEvent),
    });

    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    const snap = conn.snapshot() as unknown as { channels: SnapChannel[] };
    expect(snap.channels.map((c) => c.name).sort()).toEqual(['#general', '#random']);

    // The canned history was mirrored for this network (5 backfilled lines).
    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE network_id = ?').get(net!.id) as {
        n: number;
      }
    ).n;
    expect(count).toBe(5);

    // The drip publishes a live message on the timer.
    events.length = 0;
    vi.advanceTimersByTime(8000);
    const live = events.find((e) => e.type === 'message' && e.target === '#general');
    expect(live).toBeDefined();

    conn.dispose();
    vi.useRealTimers();
  });
});
