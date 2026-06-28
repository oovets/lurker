// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Slack provider for the Lurker server. Satisfies the same Connection contract
// IrcConnection does (see connection.ts), so ircManager + wsHub + the entire
// Vue client drive it unchanged — the only difference is this talks to Slack's
// Web API + socket mode instead of IRC. ~/slack_rust/src/slack.rs is the
// field-level reference spec for every Slack call.
//
// Buffer-target mapping (the adapter's heart): Slack uses opaque ids (C…/D…/G…).
// Lurker keys buffers by name, with '#'-prefixed targets treated as channels
// (nicklist) and bare names as DMs. So channels map to `#name` and DMs to the
// peer's display name; targetToId/idToTarget are the source of truth for
// routing inbound events and outbound sends.
//
// Render path: connect() populates `channels` and persists recent history
// BEFORE emitting state 'connected'. wsHub re-sends a full snapshot + backlog to
// every open client on that 'connected' event (wsHub.ts ~1083), so the buffers,
// members, and history all appear in one shot.

import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import type { Connection, NetworkSnapshot } from './connection.js';
import type { Network } from '../db/networks.js';
import type {
  AwayState,
  ChannelMember,
  ChannelState,
  EnrichedEvent,
  IrcEvent,
} from './ircConnection.js';
import { insertMessage } from '../db/messages.js';

// Slack event types we mirror into Lurker's message history. Everything else
// (state, typing) is transient and rides publishEphemeral.
const PERSISTED_SLACK_TYPES = new Set(['message', 'action']);

// How many recent messages to backfill per conversation on connect, and how
// many channel members to pull for the nicklist. Kept modest to stay well under
// Slack's rate limits on a cold start; page-up history is a later iteration.
const BACKFILL_LIMIT = 40;
const MEMBERS_LIMIT = 100;

interface SlackMessageShape {
  ts?: string;
  user?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  bot_id?: string;
  username?: string;
}

export class SlackConnection implements Connection {
  readonly provider = 'slack' as const;
  network: Network;
  onEvent: (event: EnrichedEvent) => void;
  state = 'idle';
  disposed = false;
  // Open channel conversations as Lurker buffers, keyed by lowercased target.
  channels: Map<string, ChannelState> = new Map();

  // Self identity, resolved from auth.test on connect.
  selfId = '';
  selfDisplayName = '';

  // Buffer target ↔ Slack conversation id. targetToId routes outbound sends;
  // idToTarget routes inbound socket-mode events back to the right buffer.
  protected targetToId = new Map<string, string>();
  protected idToTarget = new Map<string, string>();
  // User id → display name cache (users.list seed + users.info fallback).
  protected userNames = new Map<string, string>();
  // De-dup key `${channelId}:${ts}` so a message present in both the history
  // backfill and the live socket stream is only persisted once.
  protected seenTs = new Set<string>();

  protected web: WebClient | null = null;
  protected socket: SocketModeClient | null = null;
  // Demo mode (sentinel `demo` tokens): drips canned live messages so the GUI
  // can be exercised without a real workspace. Cleared on disconnect.
  protected demoTimer: ReturnType<typeof setInterval> | null = null;

  constructor({ network, onEvent }: { network: Network; onEvent: (event: EnrichedEvent) => void }) {
    this.network = network;
    this.onEvent = onEvent;
  }

  // ── Connection contract ───────────────────────────────────────────────────

  connect(): void {
    this.setState('connecting');
    void this.connectAsync().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.publishEphemeral({
        type: 'notice',
        target: `:server:${this.network.id}`,
        nick: 'lurker',
        text: `Slack connection failed: ${msg}`,
      });
      this.setState('disconnected');
    });
  }

  protected async connectAsync(): Promise<void> {
    const botToken = this.network.slack_bot_token;
    const appToken = this.network.slack_app_token;
    if (!botToken || !appToken) {
      throw new Error('missing slack_bot_token or slack_app_token');
    }
    // Demo workspace — no real Slack, just canned data + a live drip so the
    // whole GUI path (buffers, history, members, live, split panes) is testable
    // without credentials.
    if (botToken === 'demo') {
      await this.connectDemo();
      return;
    }
    this.web = new WebClient(botToken);

    const auth = (await this.web.auth.test()) as { user_id?: string; user?: string };
    this.selfId = auth.user_id || '';
    this.selfDisplayName = auth.user || 'me';

    await this.seedUserNames();
    await this.loadConversations();
    await this.backfillAll();

    // Buffers + history are in place; this flips the client to "connected" and
    // makes wsHub re-snapshot every open socket with the full picture.
    this.setState('connected');

    // Live stream. Started after the snapshot so the cold-start backlog and the
    // live tail don't interleave; seenTs de-dups the small overlap window.
    this.socket = new SocketModeClient({ appToken });
    this.socket.on(
      'message',
      async (args: { event?: SlackMessageShape; ack?: () => Promise<void> }) => {
        try {
          await args.ack?.();
        } catch {
          /* ack best-effort */
        }
        if (args.event) await this.ingestLive(args.event);
      },
    );
    this.socket.on(
      'user_typing',
      async (args: { event?: { channel?: string; user?: string }; ack?: () => Promise<void> }) => {
        try {
          await args.ack?.();
        } catch {
          /* ack best-effort */
        }
        this.onTyping(args.event);
      },
    );
    await this.socket.start();
  }

  disconnect(reason?: string): void {
    void reason;
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
    void this.socket?.disconnect().catch(() => {});
    this.socket = null;
    this.setState('disconnected');
  }

  // Canned two-channel + one-DM workspace with a few backfilled messages and a
  // live message every few seconds. Same publish/persist path as the real
  // adapter, so it exercises the identical server→client contract.
  protected async connectDemo(): Promise<void> {
    this.selfId = 'U_ME';
    this.selfDisplayName = 'me';
    for (const [id, name] of [
      ['U_ME', 'me'],
      ['U_ALICE', 'Alice'],
      ['U_BOB', 'Bob'],
    ] as const) {
      this.userNames.set(id, name);
    }

    const demoChannels: Array<{ id: string; name: string; topic: string; members: string[] }> = [
      { id: 'C_GEN', name: '#general', topic: 'general chatter', members: ['Alice', 'Bob', 'me'] },
      { id: 'C_RND', name: '#random', topic: 'anything goes', members: ['Alice', 'me'] },
    ];
    for (const c of demoChannels) {
      this.mapTarget(c.name, c.id);
      const members = new Map<string, ChannelMember>();
      for (const n of c.members) {
        members.set(n.toLowerCase(), { nick: n, modes: [], away: false, user: null, host: null });
      }
      this.channels.set(c.name.toLowerCase(), {
        name: c.name,
        topic: c.topic,
        members,
        modes: new Set<string>(),
      });
    }
    this.mapTarget('Alice', 'D_ALICE');

    const now = Date.now();
    const history: Array<[string, string, string, number]> = [
      ['#general', 'Alice', 'welcome to the demo workspace 👋', now - 60_000],
      ['#general', 'Bob', "this is Lurker's GUI rendering Slack-shaped data", now - 50_000],
      ['#general', 'me', 'nice — and split panes work on these buffers too', now - 40_000],
      ['#random', 'Alice', 'random thoughts land here', now - 30_000],
      ['Alice', 'Alice', 'hey, this is a direct message', now - 20_000],
    ];
    for (const [target, nick, text, ms] of history) {
      insertMessage({
        networkId: this.network.id,
        target,
        time: new Date(ms).toISOString(),
        type: 'message',
        nick,
        text,
        kind: 'privmsg',
        self: nick === 'me',
        extra: { demo: true },
        matchedRuleId: null,
        userhost: null,
        fromIgnored: false,
      });
    }

    this.setState('connected');

    const drip: Array<[string, string]> = [
      ['Alice', 'still here — sending a live update'],
      ['Bob', 'look, a new message just appeared'],
      ['Alice', 'try opening #random in a split pane'],
    ];
    let i = 0;
    this.demoTimer = setInterval(() => {
      if (this.disposed) return;
      const [nick, text] = drip[i % drip.length];
      i += 1;
      this.publish({
        type: 'message',
        target: '#general',
        nick,
        text,
        kind: 'privmsg',
        self: false,
        time: new Date().toISOString(),
        extra: { demo: true },
      });
    }, 8000);
  }

  dispose(reason?: string): void {
    this.disposed = true;
    this.disconnect(reason);
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  say(target: string, text: string): void {
    const channel = this.targetToId.get(target.toLowerCase());
    if (!channel || !this.web) return;
    void this.web.chat.postMessage({ channel, text }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.publishEphemeral({
        type: 'notice',
        target,
        nick: 'lurker',
        text: `send failed: ${msg}`,
      });
    });
  }

  // Slack has no separate ACTION/NOTICE wire types — render both as a normal
  // message for the MVP (italicised /me is a later refinement).
  action(target: string, text: string): void {
    this.say(target, `_${text}_`);
  }
  notice(target: string, text: string): void {
    this.say(target, text);
  }

  // Channels are joined implicitly by membership; the MVP doesn't issue
  // conversations.join. No-ops keep the manager's join/part calls harmless.
  join(_channel: string): void {}
  part(_channel: string, _reason?: string): void {}
  // Sending typing to Slack needs the socket-mode write path; skipped for MVP.
  sendTyping(_target: string, _state: string): void {}
  raw(_line: string): void {}

  // Presence/contacts — Slack presence is a later iteration; no-op for MVP.
  probePresence(_nick: string | undefined | null): void {}
  trackDmPeer(_nick: string | undefined | null): boolean {
    return false;
  }
  untrackDmPeer(_nick: string | undefined | null): void {}
  trackFriend(_nick: string | undefined | null, _contactId: number): void {}
  untrackFriend(_nick: string | undefined | null): void {}
  applyAwayState(_next: AwayState): void {}

  selfName(): string {
    return this.selfDisplayName || 'slack';
  }
  supportsMultiline(): boolean {
    return false;
  }
  sendMultiline(_target: string, _text: string): string[] {
    return [];
  }

  // ── Slack → Lurker ingestion ──────────────────────────────────────────────

  // Seed the user-name cache from a single users.list page set so members and
  // message authors resolve without a per-id round trip. Best-effort: on
  // failure we fall back to lazy users.info in resolveUserName.
  protected async seedUserNames(): Promise<void> {
    if (!this.web) return;
    try {
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await this.web.users.list({ limit: 200, cursor });
        for (const u of res.members || []) {
          if (u.id) this.userNames.set(u.id, displayNameOf(u));
        }
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor && ++pages < 10);
    } catch {
      /* lazy resolution covers the gaps */
    }
  }

  protected async resolveUserName(id: string | undefined): Promise<string> {
    if (!id) return 'unknown';
    const cached = this.userNames.get(id);
    if (cached) return cached;
    if (!this.web) return id;
    try {
      const res = await this.web.users.info({ user: id });
      const name = res.user ? displayNameOf(res.user) : id;
      this.userNames.set(id, name);
      return name;
    } catch {
      this.userNames.set(id, id);
      return id;
    }
  }

  // Build channel + DM buffers from the user's conversations, populating the
  // target↔id maps and (for channels) the nicklist.
  protected async loadConversations(): Promise<void> {
    if (!this.web) return;
    let cursor: string | undefined;
    do {
      const res = await this.web.users.conversations({
        types: 'public_channel,private_channel,mpim,im',
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const ch of res.channels || []) {
        if (!ch.id) continue;
        if (ch.is_im) {
          // DM — target is the peer's display name; appears in the sidebar once
          // its backfilled history lands (DMs aren't snapshot channels).
          const peer = await this.resolveUserName(ch.user);
          this.mapTarget(peer, ch.id);
        } else {
          const name = `#${ch.name || ch.id}`;
          this.mapTarget(name, ch.id);
          const members = await this.fetchMembers(ch.id);
          this.channels.set(name.toLowerCase(), {
            name,
            topic: (ch.topic?.value as string | undefined) || null,
            members,
            modes: new Set<string>(),
          });
        }
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  protected mapTarget(target: string, channelId: string): void {
    this.targetToId.set(target.toLowerCase(), channelId);
    this.idToTarget.set(channelId, target);
  }

  protected async fetchMembers(channelId: string): Promise<Map<string, ChannelMember>> {
    const map = new Map<string, ChannelMember>();
    if (!this.web) return map;
    try {
      const res = await this.web.conversations.members({
        channel: channelId,
        limit: MEMBERS_LIMIT,
      });
      for (const uid of res.members || []) {
        const nick = await this.resolveUserName(uid);
        map.set(nick.toLowerCase(), { nick, modes: [], away: false, user: null, host: null });
      }
    } catch {
      /* empty nicklist is acceptable for MVP */
    }
    return map;
  }

  // Persist recent history for every mapped conversation, oldest-first so the
  // Lurker message ids increase in chronological order.
  protected async backfillAll(): Promise<void> {
    for (const [, channelId] of this.targetToId) {
      await this.backfill(channelId).catch(() => {});
    }
  }

  protected async backfill(channelId: string): Promise<void> {
    if (!this.web) return;
    const target = this.idToTarget.get(channelId);
    if (!target) return;
    const res = await this.web.conversations.history({ channel: channelId, limit: BACKFILL_LIMIT });
    const messages = (res.messages || []) as SlackMessageShape[];
    // history returns newest-first; reverse so we persist oldest-first.
    for (const msg of messages.slice().reverse()) {
      await this.persistHistorical(channelId, target, msg);
    }
  }

  // Backfill path: write straight to the DB (no live fan-out) so the messages
  // arrive via the backlog frame, not as N live events.
  protected async persistHistorical(
    channelId: string,
    target: string,
    msg: SlackMessageShape,
  ): Promise<void> {
    const built = await this.buildMessage(channelId, target, msg);
    if (!built) return;
    insertMessage({
      networkId: this.network.id,
      target,
      time: built.time,
      type: 'message',
      nick: built.nick,
      text: built.text,
      kind: 'privmsg',
      self: built.self,
      extra: { slackTs: msg.ts },
      matchedRuleId: null,
      userhost: null,
      fromIgnored: false,
    });
  }

  // Live path: publish (persist + fan out to open clients).
  protected async ingestLive(msg: SlackMessageShape & { channel?: string }): Promise<void> {
    const channelId = msg.channel;
    if (!channelId) return;
    const target = this.idToTarget.get(channelId);
    if (!target) return; // a conversation opened after connect — handled later
    const built = await this.buildMessage(channelId, target, msg);
    if (!built) return;
    this.publish({
      type: 'message',
      target,
      nick: built.nick,
      text: built.text,
      kind: 'privmsg',
      self: built.self,
      time: built.time,
      extra: { slackTs: msg.ts },
    });
  }

  // Shared message mapping + de-dup. Returns null for messages we skip (edits,
  // deletes, joins, already-seen) so both ingest paths stay simple.
  protected async buildMessage(
    channelId: string,
    _target: string,
    msg: SlackMessageShape,
  ): Promise<{ nick: string; text: string; self: boolean; time: string } | null> {
    if (!msg.ts) return null;
    // MVP scope: plain messages + bot messages only; skip edits/deletes/joins.
    if (msg.subtype && msg.subtype !== 'bot_message' && msg.subtype !== 'me_message') return null;
    const key = `${channelId}:${msg.ts}`;
    if (this.seenTs.has(key)) return null;
    this.seenTs.add(key);
    const nick = msg.bot_id
      ? msg.username || (await this.resolveUserName(msg.user)) || 'bot'
      : await this.resolveUserName(msg.user);
    return {
      nick,
      text: msg.text || '',
      self: !!msg.user && msg.user === this.selfId,
      time: tsToIso(msg.ts),
    };
  }

  protected onTyping(event: { channel?: string; user?: string } | undefined): void {
    if (!event?.channel) return;
    const target = this.idToTarget.get(event.channel);
    if (!target) return;
    this.publishEphemeral({
      type: 'typing',
      target,
      nick: this.userNames.get(event.user || '') || event.user || 'someone',
      state: 'active',
    });
  }

  // ── Event emission (mirrors IrcConnection.publish, minus IRC-only
  //    highlight/ignore decoration, which is a later iteration) ──────────────

  publish(event: IrcEvent): void {
    if (this.disposed) return;
    const time = (event.time as string | undefined) || new Date().toISOString();
    const enriched: EnrichedEvent = {
      ...event,
      userId: this.network.user_id,
      networkId: this.network.id,
      time,
    };
    if (PERSISTED_SLACK_TYPES.has(event.type) && typeof event.target === 'string') {
      const { id, alt } = insertMessage({
        networkId: this.network.id,
        target: event.target,
        time,
        type: event.type,
        nick: event.nick as string | undefined,
        text: event.text as string | undefined,
        kind: event.kind as string | undefined,
        self: event.self as boolean | undefined,
        extra: (event.extra as Record<string, unknown> | null | undefined) ?? null,
        matchedRuleId: null,
        userhost: null,
        fromIgnored: false,
      });
      enriched.id = id;
      enriched.alt = alt;
      enriched.matched = false;
      enriched.matchedRuleId = null;
    }
    this.onEvent(enriched);
  }

  publishEphemeral(event: IrcEvent): void {
    if (this.disposed) return;
    this.onEvent({
      ...event,
      userId: this.network.user_id,
      networkId: this.network.id,
      time: (event.time as string | undefined) || new Date().toISOString(),
    });
  }

  setState(state: string, extra: Record<string, unknown> = {}): void {
    this.state = state;
    this.publish({ type: 'state', state, target: `:server:${this.network.id}`, ...extra });
  }

  // Per-network state blob for the client snapshot — same shape wsHub expects
  // from IrcConnection.snapshot().
  snapshot(): NetworkSnapshot {
    return {
      networkId: this.network.id,
      state: this.state,
      nick: this.selfName(),
      userModes: '',
      lagMs: null,
      multilineLimits: null,
      away: null,
      channels: Array.from(this.channels.values()).map((ch) => ({
        name: ch.name,
        topic: ch.topic,
        modes: '',
        members: Array.from(ch.members.values()).map((m) => ({
          nick: m.nick,
          modes: m.modes,
          away: !!m.away,
          user: m.user || null,
          host: m.host || null,
        })),
      })),
      peerPresence: {},
    };
  }
}

// Slack ts is "<seconds>.<microseconds>" — a unique id and a timestamp. Lurker
// stores ISO time; the original ts rides in the message `extra` for de-dup.
function tsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString();
}

// Slack user → display label, preferring the chosen display name, then real
// name, then the handle. Mirrors slack_rust's resolve_user_name precedence.
function displayNameOf(u: {
  profile?: { display_name?: string; real_name?: string };
  real_name?: string;
  name?: string;
  id?: string;
}): string {
  return (
    u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id || 'unknown'
  );
}
