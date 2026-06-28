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
  const posts: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const reacts: Array<{ channel: string; timestamp: string; name: string; op: string }> = [];
  const marks: Array<{ channel: string; ts: string }> = [];
  const joins: string[] = [];
  const leaves: string[] = [];
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
      getPresence: async () => ({ presence: 'away' }),
    },
    bots: {
      info: async ({ bot }: { bot: string }) => ({ bot: { id: bot, name: 'AlertBot' } }),
    },
    emoji: {
      // A custom emoji, an alias to it, a dangling alias, and a non-URL value —
      // exercises alias resolution + filtering. Overridden per-test as needed.
      list: async () => ({
        emoji: {
          party_parrot: 'https://emoji.example/parrot.gif',
          partyparrot: 'alias:party_parrot',
          dangling: 'alias:nope',
          weird: 'not-a-url',
        },
      }),
    },
    conversations: {
      members: async () => ({ members: ['U1', 'U_SELF'] }),
      history: async ({ channel, latest }: { channel: string; latest?: string }) => {
        if (channel !== 'C1') return { messages: [] };
        // Initial backfill (no `latest`): one recent message. Page-up (`latest`
        // set): one older message, then exhausted.
        if (!latest)
          return { messages: [{ ts: '1700000000.000100', user: 'U1', text: 'hello world' }] };
        if (latest === '1700000000.000100')
          return {
            messages: [{ ts: '1699999999.000000', user: 'U1', text: 'older one' }],
            has_more: false,
          };
        return { messages: [] };
      },
      replies: async ({ ts }: { channel: string; ts: string }) => ({
        messages: [
          { ts, user: 'U1', text: 'thread parent' },
          { ts: `${ts}-r`, user: 'U_SELF', text: 'a reply', thread_ts: ts },
        ],
      }),
      mark: async ({ channel, ts }: { channel: string; ts: string }) => {
        marks.push({ channel, ts });
        return { ok: true };
      },
      // Channel directory for join() name→id resolution; overridden per-test.
      list: async () => ({
        channels: [{ id: 'C9', name: 'random' }],
        response_metadata: {},
      }),
      join: async ({ channel }: { channel: string }) => {
        joins.push(channel);
        return { ok: true };
      },
      leave: async ({ channel }: { channel: string }) => {
        leaves.push(channel);
        return { ok: true };
      },
    },
    search: {
      // Overridden per-test; default returns no matches.
      messages: async () => ({ messages: { matches: [], paging: { page: 1, pages: 1 } } }),
    },
    chat: {
      postMessage: async (args: { channel: string; text: string; thread_ts?: string }) => {
        posts.push({ channel: args.channel, text: args.text, thread_ts: args.thread_ts });
        return { ok: true, ts: '1700000000.000300' };
      },
    },
    reactions: {
      add: async (args: { channel: string; timestamp: string; name: string }) => {
        reacts.push({ ...args, op: 'add' });
        return { ok: true };
      },
      remove: async (args: { channel: string; timestamp: string; name: string }) => {
        reacts.push({ ...args, op: 'remove' });
        return { ok: true };
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
  return { web, socket, handlers, posts, reacts, marks, joins, leaves };
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
  slackTs?: string;
  reactions?: Array<{ name: string; count: number }>;
  files?: Array<{ name: string; url: string; image: boolean }>;
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

  it('probes DM peer presence on demand', async () => {
    const user = createUser('presence');
    const net = createNetwork(user.id, {
      name: 'Slack',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'xoxb-test',
      slack_app_token: 'xapp-test',
    });
    const events: AnyEvent[] = [];
    const conn = new SlackConnection({
      network: net!,
      onEvent: (e) => events.push(e as unknown as AnyEvent),
    });
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    events.length = 0;
    conn.probePresence('Alice');
    await Promise.resolve();
    await Promise.resolve();
    const pres = events.find((e) => e.type === 'peer-presence');
    expect(pres?.nick).toBe('Alice');
    expect(pres?.state).toBe('away'); // mock getPresence returns 'away'
  });

  it('emits live edit + delete events by slackTs', async () => {
    const user = createUser('editor');
    const net = createNetwork(user.id, {
      name: 'Slack',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'xoxb-test',
      slack_app_token: 'xapp-test',
    });
    const events: AnyEvent[] = [];
    const conn = new SlackConnection({
      network: net!,
      onEvent: (e) => events.push(e as unknown as AnyEvent),
    });
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();
    const onMessage = h.handlers['message'];

    events.length = 0;
    await onMessage({
      event: {
        channel: 'C1',
        subtype: 'message_changed',
        message: { ts: '1700000000.009000', text: 'fixed typo' },
      },
      ack: async () => {},
    });
    expect(events.find((e) => e.type === 'edit')).toMatchObject({
      target: '#general',
      slackTs: '1700000000.009000',
      text: 'fixed typo (edited)',
    });

    events.length = 0;
    await onMessage({
      event: { channel: 'C1', subtype: 'message_deleted', deleted_ts: '1700000000.009000' },
      ack: async () => {},
    });
    expect(events.find((e) => e.type === 'delete')).toMatchObject({
      target: '#general',
      slackTs: '1700000000.009000',
    });
  });

  it('exposes file attachments as same-origin proxy URLs', async () => {
    const user = createUser('filer');
    const net = createNetwork(user.id, {
      name: 'Slack',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'xoxb-test',
      slack_app_token: 'xapp-test',
    });
    const events: AnyEvent[] = [];
    const conn = new SlackConnection({
      network: net!,
      onEvent: (e) => events.push(e as unknown as AnyEvent),
    });
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    events.length = 0;
    await h.handlers['message']({
      event: {
        channel: 'C1',
        ts: '1700000000.008000',
        user: 'U1',
        text: 'see this',
        files: [
          { id: 'F1', name: 'pic.png', mimetype: 'image/png', url_private: 'https://x/pic.png' },
          {
            id: 'F2',
            name: 'doc.pdf',
            mimetype: 'application/pdf',
            url_private: 'https://x/doc.pdf',
          },
        ],
      },
      ack: async () => {},
    });
    const ev = events.find((e) => e.type === 'message');
    expect(ev?.files).toEqual([
      { name: 'pic.png', url: `/api/networks/${net!.id}/slack-file/F1`, image: true },
      { name: 'doc.pdf', url: `/api/networks/${net!.id}/slack-file/F2`, image: false },
    ]);
  });

  it('pages older history on demand (fetchOlder)', async () => {
    const user = createUser('pager');
    const net = createNetwork(user.id, {
      name: 'Slack',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'xoxb-test',
      slack_app_token: 'xapp-test',
    });
    const conn = new SlackConnection({ network: net!, onEvent: () => {} });
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    const older = await (
      conn as unknown as {
        fetchOlder(t: string): Promise<{ events: Array<{ text: string }>; hasMore: boolean }>;
      }
    ).fetchOlder('#general');
    expect(older.events.map((e) => e.text)).toEqual(['older one']);
    expect(older.hasMore).toBe(false);
  });

  it('encodes @name mentions into <@id> so Slack notifies', async () => {
    const user = createUser('mentioner');
    const net = createNetwork(user.id, {
      name: 'Slack',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'xoxb-test',
      slack_app_token: 'xapp-test',
    });
    const conn = new SlackConnection({ network: net!, onEvent: () => {} });
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    h.posts.length = 0;
    conn.say('#general', 'hey @alice and @Alice, see #general (not #nope)');
    await Promise.resolve();
    expect(h.posts[0]?.text).toBe('hey <@U1> and <@U1>, see <#C1|general> (not #nope)');
  });

  it('names app/bot messages instead of showing "unknown"', async () => {
    const user = createUser('bots');
    const net = createNetwork(user.id, {
      name: 'Slack',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'xoxb-test',
      slack_app_token: 'xapp-test',
    });
    const events: AnyEvent[] = [];
    const conn = new SlackConnection({
      network: net!,
      onEvent: (e) => events.push(e as unknown as AnyEvent),
    });
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();
    const onMessage = h.handlers['message'];

    // Inline bot_profile name wins.
    events.length = 0;
    await onMessage({
      event: {
        channel: 'C1',
        ts: '1700000000.003000',
        bot_id: 'B1',
        bot_profile: { name: 'Datadog' },
        text: 'ALERT',
      },
      ack: async () => {},
    });
    expect(events.find((e) => e.type === 'message')?.nick).toBe('Datadog');

    // No bot_profile → resolved via bots.info (mock returns AlertBot).
    events.length = 0;
    await onMessage({
      event: { channel: 'C1', ts: '1700000000.003001', bot_id: 'B2', text: 'ALERT' },
      ack: async () => {},
    });
    expect(events.find((e) => e.type === 'message')?.nick).toBe('AlertBot');
  });

  it('resolves Slack markup into Lurker-friendly text', async () => {
    const user = createUser('fmt');
    const net = createNetwork(user.id, {
      name: 'Slack',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'xoxb-test',
      slack_app_token: 'xapp-test',
    });
    const events: AnyEvent[] = [];
    const conn = new SlackConnection({
      network: net!,
      onEvent: (e) => events.push(e as unknown as AnyEvent),
    });
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    events.length = 0;
    const onMessage = h.handlers['message'];
    await onMessage({
      event: {
        channel: 'C1',
        ts: '1700000000.001000',
        user: 'U1',
        text: 'hi <@U1> see <#C1|general> and <https://x.com|the site> &amp; <!here>',
      },
      ack: async () => {},
    });
    const live = events.find((e) => e.type === 'message');
    expect(live?.text).toBe('hi @Alice see #general and the site (https://x.com) & @here');
  });

  it('marks thread replies, carries reaction chips, and updates them live', async () => {
    const user = createUser('rx');
    const net = createNetwork(user.id, {
      name: 'Slack',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'xoxb-test',
      slack_app_token: 'xapp-test',
    });
    const events: AnyEvent[] = [];
    const conn = new SlackConnection({
      network: net!,
      onEvent: (e) => events.push(e as unknown as AnyEvent),
    });
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    events.length = 0;
    const onMessage = h.handlers['message'];
    // A threaded reply carrying reactions (structured, not in the text).
    await onMessage({
      event: {
        channel: 'C1',
        ts: '1700000000.002000',
        thread_ts: '1700000000.001500',
        user: 'U1',
        text: 'in the thread',
        reactions: [
          { name: 'tada', count: 3 },
          { name: '+1', count: 2 },
        ],
      },
      ack: async () => {},
    });
    const live = events.find((e) => e.type === 'message');
    expect(live?.text).toBe('↳ in the thread');
    expect(live?.slackTs).toBe('1700000000.002000');
    expect(live?.reactions).toEqual([
      { name: 'tada', count: 3 },
      { name: '+1', count: 2 },
    ]);

    // A live reaction_added bumps the tally and pushes the full updated set.
    events.length = 0;
    await h.handlers['reaction_added']({
      event: { reaction: 'tada', item: { channel: 'C1', ts: '1700000000.002000' } },
      ack: async () => {},
    });
    const rx = events.find((e) => e.type === 'reaction');
    expect(rx?.target).toBe('#general');
    expect(rx?.slackTs).toBe('1700000000.002000');
    expect(rx?.reactions).toEqual([
      { name: 'tada', count: 4, mine: false },
      { name: '+1', count: 2, mine: false },
    ]);
  });

  it('opens a thread buffer, posts replies with thread_ts, mirrors live replies', async () => {
    const user = createUser('threader');
    const net = createNetwork(user.id, {
      name: 'Slack',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'xoxb-test',
      slack_app_token: 'xapp-test',
    });
    const events: AnyEvent[] = [];
    const conn = new SlackConnection({
      network: net!,
      onEvent: (e) => events.push(e as unknown as AnyEvent),
    });
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    const root = '1700000000.007000';
    const threadTarget = await (
      conn as unknown as { openThread(t: string, ts: string): Promise<string | null> }
    ).openThread('#general', root);
    expect(threadTarget).toBe(`:thread:#general:${root}`);

    // Parent + reply persisted under the thread buffer.
    const rows = db
      .prepare('SELECT text FROM messages WHERE target = ? ORDER BY id')
      .all(threadTarget) as Array<{ text: string }>;
    expect(rows.map((r) => r.text)).toEqual(['thread parent', 'a reply']);

    // A reply sent in the thread buffer posts with thread_ts.
    h.posts.length = 0;
    conn.say(threadTarget!, 'my reply');
    await Promise.resolve();
    expect(h.posts).toContainEqual({ channel: 'C1', text: 'my reply', thread_ts: root });

    // A live channel reply to that thread mirrors into the thread buffer.
    events.length = 0;
    await h.handlers['message']({
      event: {
        channel: 'C1',
        ts: '1700000000.007050',
        user: 'U1',
        text: 'live reply',
        thread_ts: root,
      },
      ack: async () => {},
    });
    const mirrored = events.filter((e) => e.type === 'message' && e.target === threadTarget);
    expect(mirrored.map((e) => e.text)).toEqual(['live reply']);
  });

  it('syncs read state back to Slack (conversations.mark)', async () => {
    const user = createUser('reader');
    const net = createNetwork(user.id, {
      name: 'Slack',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'xoxb-test',
      slack_app_token: 'xapp-test',
    });
    const conn = new SlackConnection({ network: net!, onEvent: () => {} });
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    const row = db
      .prepare("SELECT id FROM messages WHERE network_id = ? AND target = '#general'")
      .get(net!.id) as { id: number };
    h.marks.length = 0;
    conn.markRead('#general', row.id);
    await Promise.resolve();
    expect(h.marks).toContainEqual({ channel: 'C1', ts: '1700000000.000100' });
  });

  it('click-to-react calls reactions.add/remove', async () => {
    const user = createUser('clicker');
    const net = createNetwork(user.id, {
      name: 'Slack',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'xoxb-test',
      slack_app_token: 'xapp-test',
    });
    const conn = new SlackConnection({ network: net!, onEvent: () => {} });
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    h.reacts.length = 0;
    conn.react('#general', '1700000000.005000', 'tada', true);
    conn.react('#general', '1700000000.005000', 'tada', false);
    // resolve the queued (async) Slack calls
    await Promise.resolve();
    expect(h.reacts).toEqual([
      { channel: 'C1', timestamp: '1700000000.005000', name: 'tada', op: 'add' },
      { channel: 'C1', timestamp: '1700000000.005000', name: 'tada', op: 'remove' },
    ]);
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

    // The canned history was mirrored for this network (12 backfilled lines).
    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE network_id = ?').get(net!.id) as {
        n: number;
      }
    ).n;
    expect(count).toBe(12);

    // Markup in the canned lines is resolved to readable text.
    const ping = db
      .prepare(
        "SELECT text FROM messages WHERE network_id = ? AND nick = 'Bob' AND text LIKE 'ping%'",
      )
      .get(net!.id) as { text: string } | undefined;
    expect(ping?.text).toBe('ping @me — see the Lurker site (https://lurker.chat)');

    // The drip publishes a live message on the timer.
    events.length = 0;
    vi.advanceTimersByTime(8000);
    const live = events.find((e) => e.type === 'message' && e.target === '#general');
    expect(live).toBeDefined();

    conn.dispose();
    vi.useRealTimers();
  });

  // Shared boilerplate: a fresh user + Slack network + connected adapter.
  async function connectFresh(label: string) {
    const user = createUser(label);
    const net = createNetwork(user.id, {
      name: 'Slack',
      host: 'slack',
      port: 443,
      nick: 'me',
      provider: 'slack',
      slack_bot_token: 'xoxb-test',
      slack_app_token: 'xapp-test',
    });
    const events: AnyEvent[] = [];
    const conn = new SlackConnection({
      network: net!,
      onEvent: (e) => events.push(e as unknown as AnyEvent),
    });
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();
    return { net: net!, conn, events };
  }

  it('renders a blocks-only (Block Kit) message when it carries no text', async () => {
    const { events } = await connectFresh('blockkit');
    events.length = 0;
    await h.handlers['message']({
      event: {
        channel: 'C1',
        ts: '1700000000.000910',
        user: 'U1',
        // No `text` — only Block Kit rich_text, as app/bot posts often send.
        blocks: [
          {
            type: 'rich_text',
            elements: [
              {
                type: 'rich_text_section',
                elements: [
                  { type: 'text', text: 'hi ' },
                  { type: 'user', user_id: 'U1' },
                  { type: 'text', text: ' see ' },
                  { type: 'link', url: 'https://x.io', text: 'here' },
                ],
              },
            ],
          },
        ],
      },
      ack: async () => {},
    });
    const live = events.find((e) => e.type === 'message');
    expect(live?.text).toBe('hi @Alice see here (https://x.io)');
  });

  it('names a group DM (mpim) by its participants', async () => {
    const origConv = h.web.users.conversations;
    const origHist = h.web.conversations.history;
    h.web.users.conversations = (async () => ({
      channels: [{ id: 'G1', name: 'mpdm-alice--bob-1', is_im: false, is_mpim: true }],
      response_metadata: {},
    })) as unknown as typeof h.web.users.conversations;
    h.web.conversations.history = async ({ channel }: { channel: string }) =>
      channel === 'G1'
        ? { messages: [{ ts: '1700000000.000500', user: 'U1', text: 'group hi' }] }
        : { messages: [] };
    try {
      const { net } = await connectFresh('mpim');
      const rows = db.prepare('SELECT target, text FROM messages WHERE network_id = ?').all(net.id);
      expect(rows).toContainEqual({ target: 'alice, bob', text: 'group hi' });
    } finally {
      h.web.users.conversations = origConv;
      h.web.conversations.history = origHist;
    }
  });

  it('joins a channel the bot is not in yet (resolves id, joins, backfills, re-snapshots)', async () => {
    const { conn, events } = await connectFresh('joiner');
    h.joins.length = 0;
    events.length = 0;
    await (conn as unknown as { joinAsync(c: string): Promise<void> }).joinAsync('#random');
    // Resolved 'random' → C9 via conversations.list, then conversations.join(C9).
    expect(h.joins).toContain('C9');
    const snap = conn.snapshot() as unknown as { channels: SnapChannel[] };
    expect(snap.channels.find((c) => c.name === '#random')).toBeDefined();
    // A fresh 'connected' snapshot surfaces the new buffer to open sockets.
    expect(events.some((e) => e.type === 'state' && e.state === 'connected')).toBe(true);
  });

  it('loads workspace-custom emoji and resolves alias chains', async () => {
    const { conn } = await connectFresh('emoji');
    const map = (conn as unknown as { emojiMap(): Record<string, string> }).emojiMap();
    // Direct URL + an alias resolved to it; dangling alias + non-URL dropped.
    expect(map.party_parrot).toBe('https://emoji.example/parrot.gif');
    expect(map.partyparrot).toBe('https://emoji.example/parrot.gif');
    expect(map.dangling).toBeUndefined();
    expect(map.weird).toBeUndefined();
  });

  it('searches the whole workspace via search.messages', async () => {
    const { conn, net } = await connectFresh('searcher');
    const origSearch = h.web.search.messages;
    h.web.search.messages = (async () => ({
      messages: {
        matches: [
          {
            ts: '1700000000.000700',
            user: 'U1',
            text: 'found it',
            channel: { id: 'C1', name: 'general' },
          },
        ],
        paging: { page: 1, pages: 1 },
      },
    })) as typeof h.web.search.messages;
    try {
      const res = await conn.search('found');
      expect(res.messages).toHaveLength(1);
      expect(res.messages[0]).toMatchObject({
        networkId: net.id,
        target: '#general',
        nick: 'Alice',
        text: 'found it',
      });
      // Synthetic negative id keeps result keys unique + opens the channel on jump.
      expect((res.messages[0] as { id: number }).id).toBeLessThan(0);
    } finally {
      h.web.search.messages = origSearch;
    }
  });
});
