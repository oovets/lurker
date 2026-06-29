// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Throwaway DB before importing anything that touches the db singleton.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-imessage-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('../db/index.js').default;
let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let ImessageConnection: typeof import('./imessageConnection.js').ImessageConnection;

interface SnapChannel {
  name: string;
  members: { nick: string }[];
}
interface AnyEvent {
  type: string;
  state?: string;
  target?: string;
  nick?: string;
  text?: string;
  kind?: string;
  slackTs?: string;
  reactions?: Array<{ name: string; count: number; mine?: boolean }>;
  files?: Array<{ name: string; url: string; image: boolean }>;
}

// Canned BlueBubbles data.
const DM_GUID = 'iMessage;-;dm1';
const GROUP_GUID = 'iMessage;+;grp1';
const CHATS = [
  { guid: DM_GUID, participants: [{ address: '+15551234', firstName: 'Alex' }] },
  {
    guid: GROUP_GUID,
    displayName: '',
    participants: [
      { address: '+1', firstName: 'Sam' },
      { address: '+2', firstName: 'Jordan' },
    ],
  },
];
// Returned newest-first (BlueBubbles DESC); the adapter reverses to persist
// oldest-first. m1 (text), t1 (a love tapback on m1), m2 (with an attachment).
const DM_MESSAGES = [
  {
    guid: 'm2',
    text: 'pic',
    isFromMe: false,
    dateCreated: 1_700_000_002_000,
    handle: { address: '+15551234' },
    attachments: [{ guid: 'att1', mimeType: 'image/png', transferName: 'photo.png' }],
  },
  {
    guid: 't1',
    isFromMe: true,
    dateCreated: 1_700_000_001_000,
    associatedMessageGuid: 'p:0/m1',
    associatedMessageType: 2000,
  },
  {
    guid: 'm1',
    text: 'hello world',
    isFromMe: false,
    dateCreated: 1_700_000_000_000,
    handle: { address: '+15551234' },
  },
];

beforeAll(async () => {
  db = (await import('../db/index.js')).default;
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ ImessageConnection } = await import('./imessageConnection.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A real-server (non-demo) connection with the BlueBubbles REST calls stubbed
// and the live socket suppressed.
function makeConn(label: string) {
  const user = createUser(label);
  const net = createNetwork(user.id, {
    name: 'iMessage',
    host: 'imessage',
    port: 443,
    nick: 'me',
    provider: 'imessage',
    imessage_server_url: 'https://bb.test',
    imessage_password: 'secret',
  });
  const events: AnyEvent[] = [];
  const sent: Array<{ chatGuid: string; text: string }> = [];
  const reacted: Array<{ chatGuid: string; sel: string; type: number }> = [];
  const marked: string[] = [];
  // Mutable so a test can add a new chat / new messages and re-poll.
  const stub: { chats: typeof CHATS; messages: Record<string, typeof DM_MESSAGES> } = {
    chats: [...CHATS],
    messages: { [DM_GUID]: DM_MESSAGES },
  };

  class Conn extends ImessageConnection {
    protected override async bbGetContacts() {
      return [{ address: '+15551234', firstName: 'Alex Rivera' }];
    }
    protected override async bbGetChats() {
      return stub.chats;
    }
    protected override async bbGetMessages(guid: string) {
      return stub.messages[guid] || [];
    }
    protected override async bbSendText(chatGuid: string, text: string) {
      sent.push({ chatGuid, text });
    }
    protected override async bbReact(chatGuid: string, sel: string, type: number) {
      reacted.push({ chatGuid, sel, type });
    }
    protected override async bbMarkRead(chatGuid: string) {
      marked.push(chatGuid);
    }
    protected override openSocket() {
      /* no live socket in tests */
    }
    protected override startPoll() {
      /* no background interval in tests; call pollNow() explicitly */
    }
    live(msg: unknown) {
      return (this as unknown as { ingestLive(m: unknown): Promise<void> }).ingestLive(msg);
    }
    pollNow() {
      return (this as unknown as { pollOnce(): Promise<void> }).pollOnce();
    }
  }
  const conn = new Conn({ network: net!, onEvent: (e) => events.push(e as unknown as AnyEvent) });
  return { conn, net: net!, events, sent, reacted, marked, stub };
}

describe('ImessageConnection', () => {
  it('connects: 1:1 + group buffers, history, tapbacks as reactions, attachments', async () => {
    const { conn, net } = makeConn('im-connect');
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    // Group chat is a named buffer with a member list; the 1:1 is DM-style.
    const snap = conn.snapshot() as unknown as { channels: SnapChannel[] };
    const group = snap.channels.find((c) => c.name === 'Sam, Jordan');
    expect(group).toBeDefined();
    expect(group!.members.map((m) => m.nick).sort()).toEqual(['Jordan', 'Sam']);

    // History mirrored under the contact-resolved DM target.
    const rows = db
      .prepare(
        "SELECT nick, text, extra FROM messages WHERE network_id = ? AND target = 'Alex Rivera' ORDER BY id",
      )
      .all(net.id) as Array<{ nick: string; text: string; extra: string }>;
    expect(rows.map((r) => r.text)).toEqual(['hello world', 'pic']);
    expect(rows[0].nick).toBe('Alex Rivera');

    // m1 carries the folded love tapback as a heart reaction chip.
    const m1Extra = JSON.parse(rows[0].extra);
    expect(m1Extra.slackTs).toBe('m1');
    expect(m1Extra.reactions).toContainEqual(expect.objectContaining({ name: 'heart', count: 1 }));
    // m2 carries its image attachment as a same-origin proxy URL.
    const m2Extra = JSON.parse(rows[1].extra);
    expect(m2Extra.files[0]).toMatchObject({
      image: true,
      url: `/api/networks/${net.id}/imessage-attachment/att1`,
    });
  });

  it('streams a live message and a live tapback', async () => {
    const { conn, events } = makeConn('im-live');
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    events.length = 0;
    await (conn as unknown as { live(m: unknown): Promise<void> }).live({
      guid: 'm9',
      text: 'live!',
      isFromMe: false,
      handle: { address: '+15551234' },
      chats: [{ guid: DM_GUID }],
    });
    const live = events.find((e) => e.type === 'message');
    expect(live).toMatchObject({ target: 'Alex Rivera', text: 'live!', slackTs: 'm9' });

    events.length = 0;
    await (conn as unknown as { live(m: unknown): Promise<void> }).live({
      guid: 'tb9',
      isFromMe: true,
      associatedMessageGuid: 'p:0/m9',
      associatedMessageType: 2001, // like → thumbsup
      chats: [{ guid: DM_GUID }],
    });
    const reaction = events.find((e) => e.type === 'reaction');
    expect(reaction?.slackTs).toBe('m9');
    expect(reaction?.reactions).toContainEqual(
      expect.objectContaining({ name: 'thumbsup', count: 1 }),
    );
  });

  it('sends via BlueBubbles, reacts with a tapback type, and marks read', async () => {
    const { conn, net, sent, reacted, marked } = makeConn('im-out');
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    conn.say('Alex Rivera', 'yo');
    expect(sent).toContainEqual({ chatGuid: DM_GUID, text: 'yo' });

    conn.react('Alex Rivera', 'm1', 'heart', true);
    expect(reacted).toContainEqual({ chatGuid: DM_GUID, sel: 'm1', type: 2000 });

    const row = db
      .prepare("SELECT id FROM messages WHERE network_id = ? AND target = 'Alex Rivera' LIMIT 1")
      .get(net.id) as { id: number };
    conn.markRead('Alex Rivera', row.id);
    expect(marked).toContain(DM_GUID);
  });

  it('reconciliation poll picks up a new chat and its messages', async () => {
    const { conn, net, events, stub } = makeConn('im-poll');
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    // A brand-new chat appears on the server with one message.
    const NEW_GUID = 'iMessage;-;dm2';
    stub.chats = [
      ...stub.chats,
      { guid: NEW_GUID, participants: [{ address: '+15559999', firstName: 'Casey' }] },
    ];
    stub.messages[NEW_GUID] = [
      {
        guid: 'n1',
        text: 'new chat hi',
        isFromMe: false,
        dateCreated: 1_700_000_500_000,
        handle: { address: '+15559999' },
      },
    ];

    events.length = 0;
    await (conn as unknown as { pollNow(): Promise<void> }).pollNow();

    // Its message was ingested under a new buffer target, named by the
    // participant's handle (firstName 'Casey').
    const row = db
      .prepare("SELECT target, text FROM messages WHERE network_id = ? AND text = 'new chat hi'")
      .get(net.id) as { target: string; text: string } | undefined;
    expect(row?.target).toBe('Casey');
    // A fresh 'connected' snapshot was emitted so the new buffer surfaces.
    expect(events.some((e) => e.type === 'state' && e.state === 'connected')).toBe(true);
  });

  it('demo mode builds a canned workspace with a 1:1 + group', async () => {
    const user = createUser('im-demo');
    const net = createNetwork(user.id, {
      name: 'iMessage',
      host: 'imessage',
      port: 443,
      nick: 'me',
      provider: 'imessage',
      imessage_server_url: 'demo',
      imessage_password: 'demo',
    });
    const events: AnyEvent[] = [];
    const conn = new ImessageConnection({
      network: net!,
      onEvent: (e) => events.push(e as unknown as AnyEvent),
    });
    await (conn as unknown as { connectAsync(): Promise<void> }).connectAsync();

    expect(events.some((e) => e.type === 'state' && e.state === 'connected')).toBe(true);
    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE network_id = ?').get(net!.id) as {
        n: number;
      }
    ).n;
    expect(count).toBe(5);
    const snap = conn.snapshot() as unknown as { channels: SnapChannel[] };
    expect(snap.channels.find((c) => c.name === 'Alex, Sam, Jordan')).toBeDefined();
    conn.dispose();
  });
});
