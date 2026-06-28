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
// Parallel Slack calls during cold-start (members + per-conversation history).
const CONCURRENCY = 6;

interface SlackMessageShape {
  ts?: string;
  user?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  reactions?: Array<{ name?: string; count?: number }>;
}

// One emoji reaction on a message — rendered as a chip by the client. `mine`
// marks the authenticated user's own reaction so the chip can highlight and a
// click can toggle it off.
interface ReactionChip {
  name: string;
  count: number;
  mine?: boolean;
}

// A Slack message rendered into the Lurker fields both ingest paths emit.
interface BuiltMessage {
  nick: string;
  text: string;
  self: boolean;
  time: string;
  reactions: ReactionChip[];
}

// A thread buffer's target is `:thread:<channelTarget>:<threadTs>` — readable
// enough for the client to label ("#general › thread") and parse, while the
// server resolves it to {channelId, threadTs} for fetching + posting replies.
const THREAD_PREFIX = ':thread:';
function threadTargetFor(channelTarget: string, threadTs: string): string {
  return `${THREAD_PREFIX}${channelTarget}:${threadTs}`;
}

// Run an async fn over items with bounded concurrency — cuts cold-start time
// (members + per-conversation history) from sum-of-calls to roughly
// slowest-call × ceil(n/limit), while staying gentle on Slack's rate limits.
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      await fn(items[idx]).catch(() => {});
    }
  });
  await Promise.all(workers);
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
  // Bot id → name cache (bots.info), for app/bot messages that carry no user.
  protected botNames = new Map<string, string>();
  // De-dup key `${channelId}:${ts}` so a message present in both the history
  // backfill and the live socket stream is only persisted once.
  protected seenTs = new Set<string>();
  // Per-message reaction counts (`${channelId}:${ts}` → name → count), seeded
  // from history and updated by live reaction_added/removed so we can push the
  // full set to the client on each change.
  protected reactionTallies = new Map<string, Map<string, number>>();
  // Per-message set of reaction names the authenticated user has added, so chips
  // can show a "mine" state and click toggles add/remove.
  protected selfReactions = new Map<string, Set<string>>();
  // Open threads: thread target → {channelId, threadTs} for send routing, and
  // threadTs → thread target so live channel replies mirror into the open thread
  // buffer. De-dup of thread rows keyed `${threadTarget}:${ts}`.
  protected threads = new Map<string, { channelId: string; threadTs: string }>();
  protected threadByTs = new Map<string, string>();
  protected threadSeen = new Set<string>();

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
    const onReaction =
      (delta: number) =>
      async (args: {
        event?: { reaction?: string; user?: string; item?: { channel?: string; ts?: string } };
        ack?: () => Promise<void>;
      }) => {
        try {
          await args.ack?.();
        } catch {
          /* ack best-effort */
        }
        const e = args.event;
        if (e?.reaction && e.item?.channel && e.item.ts) {
          this.applyReactionDelta(e.item.channel, e.item.ts, e.reaction, delta, e.user);
        }
      };
    this.socket.on('reaction_added', onReaction(+1));
    this.socket.on('reaction_removed', onReaction(-1));
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
    // Raw Slack-style markup in a couple of lines so the GUI visibly shows the
    // mention/channel/link resolution; one line carries reactions (chips) and
    // a stable slackTs so the drip below can bump a reaction live.
    const RX_TS = 'demo-rx';
    const history: Array<{
      target: string;
      nick: string;
      text: string;
      ms: number;
      reactions?: ReactionChip[];
      slackTs?: string;
    }> = [
      {
        target: '#general',
        nick: 'Alice',
        text: 'welcome to the demo workspace 👋',
        ms: now - 60_000,
      },
      {
        target: '#general',
        nick: 'Bob',
        text: "this is Lurker's GUI rendering Slack-shaped data",
        ms: now - 50_000,
      },
      {
        target: '#general',
        nick: 'Bob',
        text: 'ping <@U_ME> — see <https://lurker.chat|the Lurker site>',
        ms: now - 45_000,
      },
      {
        target: '#general',
        nick: 'me',
        text: 'nice — and split panes work on these buffers too',
        ms: now - 40_000,
      },
      {
        target: '#general',
        nick: 'Alice',
        text: 'shipping Slack support 🚀',
        ms: now - 35_000,
        reactions: [
          { name: 'tada', count: 3 },
          { name: 'rocket', count: 2 },
        ],
        slackTs: RX_TS,
      },
      {
        target: '#general',
        nick: 'Bob',
        text: '↳ huge — thread replies show inline like this',
        ms: now - 33_000,
      },
      {
        target: '#random',
        nick: 'Alice',
        text: 'random thoughts land in <#C_RND|random>',
        ms: now - 30_000,
      },
      { target: 'Alice', nick: 'Alice', text: 'hey, this is a direct message', ms: now - 20_000 },
    ];
    for (const h of history) {
      if (h.reactions && h.slackTs) {
        const tally = new Map<string, number>();
        for (const r of h.reactions) tally.set(r.name, r.count);
        this.reactionTallies.set(`C_GEN:${h.slackTs}`, tally);
      }
      insertMessage({
        networkId: this.network.id,
        target: h.target,
        time: new Date(h.ms).toISOString(),
        type: 'message',
        nick: h.nick,
        text: this.formatText(h.text),
        kind: 'privmsg',
        self: h.nick === 'me',
        extra: {
          demo: true,
          // Every demo line gets a slackTs so the "Open thread" affordance shows.
          slackTs: h.slackTs || `demo-${h.ms}`,
          ...(h.reactions ? { reactions: h.reactions } : {}),
        },
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
      // Every other tick, bump a live reaction on the shipping message so the
      // chips visibly update; otherwise drip a new message.
      if (i % 2 === 1) {
        this.applyReactionDelta('C_GEN', RX_TS, 'thumbsup', +1);
        i += 1;
        return;
      }
      const [nick, text] = drip[(i >> 1) % drip.length];
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
    // A thread buffer posts to its parent channel with thread_ts.
    const thread = this.threads.get(target.toLowerCase());
    const channel = thread?.channelId ?? this.targetToId.get(target.toLowerCase());
    if (!channel || !this.web) return;
    void this.web.chat
      .postMessage({ channel, text, ...(thread ? { thread_ts: thread.threadTs } : {}) })
      .catch((err: unknown) => {
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

  // App/bot messages carry a bot_id (and often no user). Prefer the inline
  // bot_profile.name, fall back to bots.info, cached — so a monitoring app's
  // alerts show its name instead of "unknown".
  protected async resolveBotName(botId: string): Promise<string> {
    const cached = this.botNames.get(botId);
    if (cached) return cached;
    if (!this.web) return botId;
    try {
      const res = await this.web.bots.info({ bot: botId });
      const name = (res.bot?.name as string | undefined) || botId;
      this.botNames.set(botId, name);
      return name;
    } catch {
      this.botNames.set(botId, botId);
      return botId;
    }
  }

  // Build channel + DM buffers from the user's conversations, populating the
  // target↔id maps and (for channels) the nicklist. Member lists are fetched in
  // parallel after the (fast) conversation list, rather than serially per
  // channel — the dominant cold-start cost on a workspace with many channels.
  protected async loadConversations(): Promise<void> {
    if (!this.web) return;
    const channelIds: string[] = [];
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
          this.channels.set(name.toLowerCase(), {
            name,
            topic: (ch.topic?.value as string | undefined) || null,
            members: new Map<string, ChannelMember>(),
            modes: new Set<string>(),
          });
          channelIds.push(ch.id);
        }
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    await pool(channelIds, CONCURRENCY, (id) => this.fillMembers(id));
  }

  protected mapTarget(target: string, channelId: string): void {
    this.targetToId.set(target.toLowerCase(), channelId);
    this.idToTarget.set(channelId, target);
  }

  protected async fillMembers(channelId: string): Promise<void> {
    if (!this.web) return;
    const target = this.idToTarget.get(channelId);
    const channel = target ? this.channels.get(target.toLowerCase()) : null;
    if (!channel) return;
    try {
      const res = await this.web.conversations.members({
        channel: channelId,
        limit: MEMBERS_LIMIT,
      });
      for (const uid of res.members || []) {
        const nick = await this.resolveUserName(uid);
        channel.members.set(nick.toLowerCase(), {
          nick,
          modes: [],
          away: false,
          user: null,
          host: null,
        });
      }
    } catch {
      /* empty nicklist is acceptable for MVP */
    }
  }

  // Persist recent history for every mapped conversation, oldest-first so the
  // Lurker message ids increase in chronological order. Parallelised across
  // conversations (bounded) to keep cold-start snappy.
  protected async backfillAll(): Promise<void> {
    const ids = Array.from(this.targetToId.values());
    await pool(ids, CONCURRENCY, (id) => this.backfill(id));
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
      // slackTs lets a live reaction update find this row client-side; reactions
      // persist so chips survive a reload; threadRoot lets "open thread" root at
      // the right ts (all spread to top-level by rowToEvent).
      extra: {
        slackTs: msg.ts,
        ...(msg.thread_ts ? { threadRoot: msg.thread_ts } : {}),
        ...(built.reactions.length ? { reactions: built.reactions } : {}),
      },
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
    // If this is a reply in an open thread, mirror it into that thread buffer so
    // the thread pane updates live (independently of the in-channel ↳ copy).
    if (msg.thread_ts) {
      const threadTarget = this.threadByTs.get(msg.thread_ts);
      if (threadTarget) await this.publishThreadMessage(threadTarget, channelId, msg);
    }
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
      // Top-level for the live client; mirrored into extra so a reload keeps them.
      slackTs: msg.ts,
      threadRoot: msg.thread_ts,
      reactions: built.reactions,
      extra: {
        slackTs: msg.ts,
        ...(msg.thread_ts ? { threadRoot: msg.thread_ts } : {}),
        ...(built.reactions.length ? { reactions: built.reactions } : {}),
      },
    });
  }

  // ── Live reactions ────────────────────────────────────────────────────────

  // Apply a +1/-1 from a Slack reaction_added/removed event. `user` lets us
  // track whether the authenticated user is among the reactors, so the chip can
  // render a "mine" state and toggle on click.
  protected applyReactionDelta(
    channelId: string,
    ts: string,
    name: string,
    delta: number,
    user?: string,
  ): void {
    const key = `${channelId}:${ts}`;
    let tally = this.reactionTallies.get(key);
    if (!tally) {
      tally = new Map<string, number>();
      this.reactionTallies.set(key, tally);
    }
    tally.set(name, Math.max(0, (tally.get(name) || 0) + delta));
    if ((tally.get(name) || 0) === 0) tally.delete(name);
    if (user && user === this.selfId) {
      let mine = this.selfReactions.get(key);
      if (!mine) {
        mine = new Set<string>();
        this.selfReactions.set(key, mine);
      }
      if (delta > 0) mine.add(name);
      else mine.delete(name);
    }
    this.emitReactionUpdate(channelId, ts);
  }

  // Push the full current reaction set for a message; the client finds the row
  // by slackTs and replaces its chips (no new message row).
  protected emitReactionUpdate(channelId: string, ts: string): void {
    const target = this.idToTarget.get(channelId);
    if (!target) return;
    const key = `${channelId}:${ts}`;
    const tally = this.reactionTallies.get(key) || new Map<string, number>();
    const mine = this.selfReactions.get(key) || new Set<string>();
    const reactions: ReactionChip[] = Array.from(tally.entries())
      .filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count, mine: mine.has(name) }));
    this.publishEphemeral({ type: 'reaction', target, slackTs: ts, reactions });
  }

  // Click-to-react from the client: add or remove the user's reaction. The
  // resulting Slack reaction_added/removed event (which we also receive) updates
  // the tally + chips, so there's no optimistic local bump to double-count.
  react(target: string, slackTs: string, name: string, add: boolean): void {
    const channel = this.targetToId.get(target.toLowerCase());
    if (!channel || !slackTs || !name) return;
    // Demo mode has no real workspace — apply the toggle locally so click-to-
    // react is exercisable in the browser.
    if (!this.web) {
      this.applyReactionDelta(channel, slackTs, name, add ? +1 : -1, this.selfId);
      return;
    }
    const call = add
      ? this.web.reactions.add({ channel, timestamp: slackTs, name })
      : this.web.reactions.remove({ channel, timestamp: slackTs, name });
    void call.catch(() => {
      /* already_reacted / no_reaction are benign races; ignore */
    });
  }

  // ── Threads ───────────────────────────────────────────────────────────────

  // Open a thread as its own buffer beside the channel. Fetches the parent +
  // replies, persists them under the thread target, and registers the thread so
  // sends route to chat.postMessage(thread_ts) and live channel replies mirror
  // in. Returns the thread buffer target (key) so the caller can render backlog.
  async openThread(channelTarget: string, threadTs: string): Promise<string | null> {
    const channelId = this.targetToId.get(channelTarget.toLowerCase());
    if (!channelId || !threadTs) return null;
    const threadTarget = threadTargetFor(channelTarget, threadTs);
    this.threads.set(threadTarget.toLowerCase(), { channelId, threadTs });
    this.threadByTs.set(threadTs, threadTarget);

    let messages: SlackMessageShape[];
    if (this.web) {
      try {
        const res = await this.web.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 100,
        });
        messages = (res.messages || []) as SlackMessageShape[];
      } catch {
        messages = [];
      }
    } else {
      // Demo: synthesize a tiny thread off the parent.
      messages = [
        { ts: threadTs, user: 'U_ALICE', text: 'starting a thread here' },
        {
          ts: `${threadTs}-r1`,
          user: 'U_BOB',
          text: 'replying in the thread',
          thread_ts: threadTs,
        },
        {
          ts: `${threadTs}-r2`,
          user: 'U_ME',
          text: 'live replies land here too',
          thread_ts: threadTs,
        },
      ];
    }
    for (const m of messages) await this.persistThreadMessage(threadTarget, channelId, m);
    return threadTarget;
  }

  // Persist one thread message under the thread buffer (own de-dup so the parent,
  // which also lives in the channel, isn't skipped by the channel seenTs).
  protected async persistThreadMessage(
    threadTarget: string,
    channelId: string,
    msg: SlackMessageShape,
  ): Promise<void> {
    if (!msg.ts) return;
    const key = `${threadTarget}:${msg.ts}`;
    if (this.threadSeen.has(key)) return;
    this.threadSeen.add(key);
    const built = await this.renderMessage(channelId, msg, { inThread: true });
    insertMessage({
      networkId: this.network.id,
      target: threadTarget,
      time: built.time,
      type: 'message',
      nick: built.nick,
      text: built.text,
      kind: 'privmsg',
      self: built.self,
      extra: { slackTs: msg.ts, ...(built.reactions.length ? { reactions: built.reactions } : {}) },
      matchedRuleId: null,
      userhost: null,
      fromIgnored: false,
    });
  }

  // Live-publish a thread message (persist + fan out) so an open thread pane
  // updates in real time.
  protected async publishThreadMessage(
    threadTarget: string,
    channelId: string,
    msg: SlackMessageShape,
  ): Promise<void> {
    if (!msg.ts) return;
    const key = `${threadTarget}:${msg.ts}`;
    if (this.threadSeen.has(key)) return;
    this.threadSeen.add(key);
    const built = await this.renderMessage(channelId, msg, { inThread: true });
    this.publish({
      type: 'message',
      target: threadTarget,
      nick: built.nick,
      text: built.text,
      kind: 'privmsg',
      self: built.self,
      time: built.time,
      slackTs: msg.ts,
      reactions: built.reactions,
      extra: { slackTs: msg.ts, ...(built.reactions.length ? { reactions: built.reactions } : {}) },
    });
  }

  // Shared message mapping + de-dup. Returns null for messages we skip (edits,
  // deletes, joins, already-seen) so both ingest paths stay simple.
  protected async buildMessage(
    channelId: string,
    _target: string,
    msg: SlackMessageShape,
  ): Promise<BuiltMessage | null> {
    if (!msg.ts) return null;
    // MVP scope: plain messages + bot messages only; skip edits/deletes/joins.
    if (msg.subtype && msg.subtype !== 'bot_message' && msg.subtype !== 'me_message') return null;
    const key = `${channelId}:${msg.ts}`;
    if (this.seenTs.has(key)) return null;
    this.seenTs.add(key);
    return this.renderMessage(channelId, msg, {});
  }

  // Pure render of a Slack message into Lurker fields (no dedup/skip guards —
  // the caller owns those). Shared by the channel and thread paths; `inThread`
  // drops the inline ↳ marker since a thread buffer is already the conversation.
  protected async renderMessage(
    channelId: string,
    msg: SlackMessageShape,
    { inThread = false }: { inThread?: boolean },
  ): Promise<BuiltMessage> {
    // App/bot lines (bot_id, usually no user) name themselves via bot_profile /
    // username / bots.info; real users via the user cache. Only a message with
    // neither falls back to 'unknown'.
    let nick: string;
    if (msg.bot_id) {
      nick = msg.bot_profile?.name || msg.username || (await this.resolveBotName(msg.bot_id));
    } else if (msg.user) {
      nick = await this.resolveUserName(msg.user);
    } else {
      nick = msg.username || 'unknown';
    }
    let text = this.formatText(msg.text || '');
    // In the channel, a thread reply gets a ↳ marker so a flat buffer still
    // reads as a conversation; inside the thread buffer the marker is redundant.
    if (!inThread && msg.thread_ts && msg.thread_ts !== msg.ts) text = `↳ ${text}`;
    // Reactions ride as structured data on the event (rendered as chips by the
    // client). Seed the per-message tally so live reaction_added/removed deltas
    // can recompute and push an updated set.
    const reactions: ReactionChip[] = (msg.reactions || [])
      .filter((r): r is { name: string; count?: number } => !!r.name)
      .map((r) => ({ name: r.name, count: r.count ?? 1 }));
    if (reactions.length && msg.ts) {
      const tally = new Map<string, number>();
      for (const r of reactions) tally.set(r.name, r.count);
      this.reactionTallies.set(`${channelId}:${msg.ts}`, tally);
    }
    return {
      nick,
      text,
      self: !!msg.user && msg.user === this.selfId,
      time: msg.ts ? tsToIso(msg.ts) : new Date().toISOString(),
      reactions,
    };
  }

  // Resolve Slack message markup into the plain conventions Lurker's client
  // already understands (so its existing linkifier / nick coloring just works):
  //   <@U123> / <@U123|label>      → @DisplayName
  //   <#C123|name> / <#C123>       → #name
  //   <!here> / <!subteam^S|name>  → @here / @name
  //   <https://x|label>            → label (https://x)   [or the bare url]
  //   &amp; &lt; &gt;              → & < >
  // Emoji shortcodes (:smile:) and mrkdwn (*bold*) are left for the client.
  // Mentions resolve from the local user-name cache (sync) — a cache miss shows
  // the raw id rather than blocking on a users.info round trip per message.
  protected formatText(text: string): string {
    if (!text) return '';
    const replaced = text.replace(/<([^<>]+)>/g, (_match, inner: string) => {
      if (inner.startsWith('@')) {
        const body = inner.slice(1);
        const pipe = body.indexOf('|');
        if (pipe >= 0) return `@${body.slice(pipe + 1)}`;
        return `@${this.userNames.get(body) || body}`;
      }
      if (inner.startsWith('#')) {
        const body = inner.slice(1);
        const pipe = body.indexOf('|');
        if (pipe >= 0) return `#${body.slice(pipe + 1)}`;
        return this.idToTarget.get(body) || `#${body}`;
      }
      if (inner.startsWith('!')) {
        const body = inner.slice(1);
        const pipe = body.indexOf('|');
        if (pipe >= 0) return `@${body.slice(pipe + 1)}`;
        return `@${body.split('^')[0]}`;
      }
      const pipe = inner.indexOf('|');
      if (pipe >= 0) {
        const url = inner.slice(0, pipe);
        const label = inner.slice(pipe + 1);
        return label ? `${label} (${url})` : url;
      }
      return inner;
    });
    return replaced.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
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
