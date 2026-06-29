// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// iMessage provider for the Lurker server, via a BlueBubbles server (a
// self-hosted iMessage bridge that runs on a Mac and exposes a REST API +
// Socket.IO real-time feed). Satisfies the same Connection contract IRC and
// Slack do (see connection.ts), so ircManager + wsHub + the Vue client drive it
// unchanged. `github.com/oovets/imessage-tui` (api/client.go, ws/client.go,
// models/types.go) is the field-level reference for every BlueBubbles call.
//
// Architecture mirrors SlackConnection: a server-side bridge + a real-time
// socket. The Lurker server talks HTTP+WS to the user's BlueBubbles Mac over the
// network. Buffer mapping: 1:1 chats become DM buffers (peer display name);
// group chats become participant-named buffers (like Slack group DMs).
//
// The generic per-message id the client matches reactions/edits against is the
// `slackTs` field — we reuse it to carry the iMessage message GUID so the
// client's reaction/edit handling works without any client change.

import { io, type Socket } from 'socket.io-client';
import type { Connection, NetworkSnapshot } from './connection.js';
import type { Network } from '../db/networks.js';
import type {
  AwayState,
  ChannelMember,
  ChannelState,
  EnrichedEvent,
  IrcEvent,
} from './ircConnection.js';
import {
  insertMessage,
  getMessageExtra,
  countMessagesForTarget,
  recentProviderIds,
} from '../db/messages.js';

const BACKFILL_LIMIT = 50;
// Reconciliation poll: re-fetch chats + recent messages so new chats and any
// socket-missed messages still appear. A gentle cadence for a local BlueBubbles
// server; the socket remains the primary, low-latency path.
const POLL_INTERVAL_MS = 15_000;
const POLL_CONCURRENCY = 5;
const POLL_MESSAGE_LIMIT = 10;

// Run an async fn over items with bounded concurrency (cuts cold-start +
// per-poll fan-out from sum-of-calls to roughly slowest × ceil(n/limit)).
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

// ── BlueBubbles wire shapes (subset we use; spec = imessage-tui/models/types.go) ──
interface BBHandle {
  address?: string;
  firstName?: string;
}
interface BBAttachment {
  guid?: string;
  mimeType?: string;
  transferName?: string;
}
interface BBMessage {
  guid?: string;
  text?: string;
  isFromMe?: boolean;
  dateCreated?: number; // milliseconds epoch
  handle?: BBHandle | null; // null when isFromMe
  attachments?: BBAttachment[];
  associatedMessageGuid?: string;
  associatedMessageType?: number;
}
interface BBChat {
  guid?: string;
  displayName?: string;
  chatIdentifier?: string;
  participants?: BBHandle[];
}

interface ReactionChip {
  name: string;
  count: number;
  mine?: boolean;
}
interface FileChip {
  name: string;
  url: string;
  image: boolean;
  video: boolean;
}
interface BuiltMessage {
  nick: string;
  text: string;
  self: boolean;
  time: string;
  guid: string;
  reactions: ReactionChip[];
  files: FileChip[];
}

// Tapback type → reaction emoji name. 2000-2005 add a tapback, 3000-3005 remove
// the matching one (offset by 1000).
const TAPBACK_NAMES: Record<number, string> = {
  2000: 'heart',
  2001: 'thumbsup',
  2002: 'thumbsdown',
  2003: 'joy',
  2004: 'bangbang',
  2005: 'question',
};
const NAME_TO_TAPBACK = new Map(
  Object.entries(TAPBACK_NAMES).map(([n, name]) => [name, Number(n)]),
);
function tapbackOf(type: number | undefined): { name: string; add: boolean } | null {
  if (typeof type !== 'number') return null;
  if (type >= 2000 && type <= 2005) return { name: TAPBACK_NAMES[type], add: true };
  if (type >= 3000 && type <= 3005) return { name: TAPBACK_NAMES[type - 1000], add: false };
  return null;
}

function msToIso(ms: number | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : new Date().toISOString();
}
// An associatedMessageGuid is `p:<index>/<targetGuid>`; strip the prefix.
function stripTargetGuid(g: string | undefined): string {
  return (g || '').replace(/^p:\d+\//, '');
}

// Fallback mime from a file extension, for when BlueBubbles omits `mimeType`
// (common for video). Returns '' for anything we wouldn't render inline anyway.
const EXT_MIME: Record<string, string> = {
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  heic: 'image/heic',
  webp: 'image/webp',
  pdf: 'application/pdf',
};
function mimeFromName(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && EXT_MIME[ext]) || '';
}

// Normalize a handle address into a key both contacts and chat participants map
// to, so names resolve despite formatting differences. Contacts come back like
// `+46 73-853 80 87` or `5704041242` (spaces/dashes/no country code) while chat
// addresses are clean E.164 (`+46738538087`) — keying both on the last 9 digits
// bridges the gap (and tolerates a present/absent country code). Emails key on
// the lowercased address; non-numeric sender ids (e.g. `distrokid`) on the
// lowercased raw string.
function contactKey(address: string | undefined): string {
  const a = (address || '').trim();
  if (!a) return '';
  if (a.includes('@')) return a.toLowerCase();
  const digits = a.replace(/\D/g, '');
  if (!digits) return a.toLowerCase();
  return digits.length > 9 ? digits.slice(-9) : digits;
}

// BlueBubbles nests its payload array differently across endpoints/versions:
// `data.data`, `data.chats`, `data.messages`, a bare `data`, or top-level
// `messages` (replicated from imessage-tui's gjson fallbacks). Returns the first
// array found, else [].
function arrAt(obj: unknown, key: string): unknown[] | null {
  if (obj && typeof obj === 'object') {
    const v = (obj as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  return null;
}
function pickArray(json: unknown): unknown[] {
  const data =
    json && typeof json === 'object' ? (json as Record<string, unknown>).data : undefined;
  return (
    arrAt(data, 'data') ||
    arrAt(data, 'chats') ||
    arrAt(data, 'messages') ||
    (Array.isArray(data) ? (data as unknown[]) : null) ||
    arrAt(json, 'messages') ||
    []
  );
}

export class ImessageConnection implements Connection {
  readonly provider = 'imessage' as const;
  network: Network;
  onEvent: (event: EnrichedEvent) => void;
  state = 'idle';
  disposed = false;
  // Open chats as Lurker buffers, keyed by lowercased target. Group chats get a
  // member list; 1:1 chats are DM-style (no entry here, surfaced via history).
  channels: Map<string, ChannelState> = new Map();

  selfDisplayName = 'me';

  // Buffer target ↔ BlueBubbles chat guid.
  protected targetToId = new Map<string, string>();
  protected idToTarget = new Map<string, string>();
  // Handle address → display name (contacts), for resolving senders.
  protected handleNames = new Map<string, string>();
  // De-dup of message guids seen across backfill + the live socket.
  protected seenGuids = new Set<string>();
  // Per-message reaction tallies (`${chatGuid}:${msgGuid}` → name → count) and
  // the set the user added themselves, so chips can show a "mine" state.
  protected reactionTallies = new Map<string, Map<string, number>>();
  protected selfReactions = new Map<string, Set<string>>();
  // Attachment guid → metadata, for the same-origin proxy route.
  protected attachments = new Map<string, { mimetype: string; name: string }>();

  protected socket: Socket | null = null;
  protected demoTimer: ReturnType<typeof setInterval> | null = null;

  constructor({ network, onEvent }: { network: Network; onEvent: (event: EnrichedEvent) => void }) {
    this.network = network;
    this.onEvent = onEvent;
  }

  protected get serverUrl(): string {
    return (this.network.imessage_server_url || '').replace(/\/+$/, '');
  }
  protected get password(): string {
    return this.network.imessage_password || '';
  }
  protected get isDemo(): boolean {
    return this.serverUrl === 'demo' || this.password === 'demo';
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
        text: `iMessage connection failed: ${msg}`,
      });
      this.setState('disconnected');
    });
  }

  protected async connectAsync(): Promise<void> {
    if (this.isDemo) {
      await this.connectDemo();
      return;
    }
    if (!this.serverUrl || !this.password) {
      throw new Error('missing imessage_server_url or imessage_password');
    }
    await this.loadContacts();
    await this.loadChats();
    // Seed the de-dup set from what's already mirrored so a reconnect doesn't
    // re-insert history (the source of duplicate buffers/messages).
    for (const id of recentProviderIds(this.network.id, 5000)) this.seenGuids.add(id);
    await this.backfillAll();
    // Buffers + history are in place; flip to connected so wsHub re-snapshots.
    this.setState('connected');
    this.openSocket();
    this.startPoll();
  }

  disconnect(reason?: string): void {
    void reason;
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    try {
      this.socket?.disconnect();
    } catch {
      /* best effort */
    }
    this.socket = null;
    this.setState('disconnected');
  }

  dispose(reason?: string): void {
    this.disposed = true;
    this.disconnect(reason);
  }

  // ── BlueBubbles REST (small, isolated so tests can stub them) ──────────────

  // BlueBubbles wraps responses as { status, message, data }. Auth is a query
  // param. imessage-tui uses `guid` for the read-query endpoints (chat/query,
  // chat/{guid}/message, contact/query) and `password` elsewhere; both are
  // accepted by the server, but we mirror the proven client to be safe.
  protected bbUrl(
    path: string,
    params: Record<string, string> = {},
    authParam: 'password' | 'guid' = 'password',
  ): string {
    const u = new URL(`${this.serverUrl}/api/v1/${path.replace(/^\/+/, '')}`);
    u.searchParams.set(authParam, this.password);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  // chat/query is a POST with an empty body; the server returns every chat with
  // its participants (names are filled from contacts separately).
  protected async bbGetChats(): Promise<BBChat[]> {
    const res = await fetch(this.bbUrl('chat/query', {}, 'guid'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return pickArray(await res.json()) as BBChat[];
  }

  protected async bbGetMessages(chatGuid: string, limit = BACKFILL_LIMIT): Promise<BBMessage[]> {
    const res = await fetch(
      this.bbUrl(
        `chat/${encodeURIComponent(chatGuid)}/message`,
        {
          limit: String(limit),
          with: 'attachments',
          withAttachments: 'true',
          includeAttachments: 'true',
        },
        'guid',
      ),
    );
    return pickArray(await res.json()) as BBMessage[];
  }

  // contact/query is a POST with an empty body; each contact has a displayName +
  // phoneNumbers[]. Returns one BBHandle per address so loadContacts can build
  // its address→name map (mirrors imessage-tui GetContacts).
  protected async bbGetContacts(): Promise<BBHandle[]> {
    const res = await fetch(this.bbUrl('contact/query', {}, 'guid'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const contacts = pickArray(await res.json()) as Array<{
      displayName?: string;
      phoneNumbers?: Array<{ address?: string }>;
      emails?: Array<{ address?: string }>;
    }>;
    const out: BBHandle[] = [];
    for (const c of contacts) {
      const name = c.displayName;
      if (!name) continue;
      for (const p of c.phoneNumbers || [])
        if (p.address) out.push({ address: p.address, firstName: name });
      for (const e of c.emails || [])
        if (e.address) out.push({ address: e.address, firstName: name });
    }
    return out;
  }

  protected async bbSendText(chatGuid: string, text: string, tempGuid: string): Promise<void> {
    await fetch(this.bbUrl('message/text'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatGuid, tempGuid, message: text, method: 'private-api' }),
    });
  }

  protected async bbReact(
    chatGuid: string,
    selectedMessageGuid: string,
    reactionType: number,
  ): Promise<void> {
    await fetch(this.bbUrl('message/react'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatGuid, selectedMessageGuid, reaction: reactionType }),
    });
  }

  protected async bbMarkRead(chatGuid: string): Promise<void> {
    await fetch(this.bbUrl(`chat/${encodeURIComponent(chatGuid)}/read`), { method: 'POST' });
  }

  // ── Chats → buffers ────────────────────────────────────────────────────────

  protected mapTarget(target: string, chatGuid: string): void {
    this.targetToId.set(target.toLowerCase(), chatGuid);
    this.idToTarget.set(chatGuid, target);
  }

  // Resolve a handle (phone/email) to a display name: contacts cache, else the
  // handle's own firstName, else the raw address.
  protected resolveHandle(h: BBHandle | null | undefined): string {
    if (!h) return 'me';
    const addr = h.address || '';
    return this.handleNames.get(contactKey(addr)) || h.firstName || addr || 'unknown';
  }

  // 1:1 → peer display name; group → "Alice, Bob, Carol +N" (mirrors Slack mpim
  // naming + imessage-tui Chat.GetDisplayName()).
  protected chatTarget(chat: BBChat): { target: string; isGroup: boolean } {
    const parts = chat.participants || [];
    if (parts.length <= 1) {
      return {
        target: this.resolveHandle(parts[0]) || chat.chatIdentifier || 'unknown',
        isGroup: false,
      };
    }
    if (chat.displayName) return { target: chat.displayName, isGroup: true };
    const names = parts.map((p) => this.resolveHandle(p)).filter(Boolean);
    const label =
      names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
    return { target: label || chat.chatIdentifier || 'group', isGroup: true };
  }

  protected async loadContacts(): Promise<void> {
    let contacts: BBHandle[];
    try {
      contacts = await this.bbGetContacts();
    } catch {
      return; // contacts are optional name polish
    }
    for (const c of contacts) {
      const key = contactKey(c.address);
      if (key && c.firstName) this.handleNames.set(key, c.firstName);
    }
  }

  protected async loadChats(): Promise<void> {
    for (const chat of await this.bbGetChats()) this.registerChat(chat);
  }

  // Map a chat to a buffer target. Group chats get a channel-style entry (with a
  // member list); 1:1 chats are DM-style and surface via their history. Safe to
  // call again for an existing chat (the poll uses it to add new ones).
  protected registerChat(chat: BBChat): string | null {
    if (!chat.guid) return null;
    const { target, isGroup } = this.chatTarget(chat);
    this.mapTarget(target, chat.guid);
    if (isGroup) {
      const members = new Map<string, ChannelMember>();
      for (const p of chat.participants || []) {
        const nick = this.resolveHandle(p);
        members.set(nick.toLowerCase(), { nick, modes: [], away: false, user: null, host: null });
      }
      this.channels.set(target.toLowerCase(), {
        name: target,
        topic: null,
        members,
        modes: new Set<string>(),
      });
    }
    return target;
  }

  protected async backfillAll(): Promise<void> {
    // Parallel (bounded) — a workspace can have hundreds of chats, so a serial
    // backfill makes cold start crawl.
    await pool(Array.from(this.idToTarget.keys()), POLL_CONCURRENCY, (guid) => this.backfill(guid));
  }

  protected async backfill(chatGuid: string): Promise<void> {
    const target = this.idToTarget.get(chatGuid);
    if (!target) return;
    // History already mirrored for this chat — skip the bulk backfill (the poll
    // + socket catch anything new). First connect (empty buffer) backfills.
    if (countMessagesForTarget(this.network.id, target) > 0) return;
    const messages = await this.bbGetMessages(chatGuid);
    // BlueBubbles returns newest-first; persist oldest-first.
    const ordered = messages.slice().reverse();
    // First pass: fold tapbacks into reaction tallies so the message they target
    // carries its chips when persisted.
    for (const msg of ordered) this.foldTapback(chatGuid, msg);
    // Second pass: persist normal (non-tapback) messages with their reactions.
    for (const msg of ordered) {
      if (tapbackOf(msg.associatedMessageType)) continue;
      this.persistHistorical(chatGuid, target, msg);
    }
  }

  // Record a tapback onto its target message's tally. Returns true if msg was a
  // tapback (and should not be rendered as a normal message). De-dups by the
  // tapback's own guid so a poll/backfill overlap can't double-count.
  protected foldTapback(chatGuid: string, msg: BBMessage): boolean {
    const tb = tapbackOf(msg.associatedMessageType);
    if (!tb) return false;
    if (msg.guid) {
      if (this.seenGuids.has(msg.guid)) return true;
      this.seenGuids.add(msg.guid);
    }
    const target = stripTargetGuid(msg.associatedMessageGuid);
    if (target)
      this.applyReactionDelta(chatGuid, target, tb.name, tb.add ? +1 : -1, !!msg.isFromMe);
    return true;
  }

  protected buildMessage(chatGuid: string, msg: BBMessage): BuiltMessage | null {
    if (!msg.guid) return null;
    if (tapbackOf(msg.associatedMessageType)) return null; // tapbacks aren't messages
    const key = `${chatGuid}:${msg.guid}`;
    if (this.seenGuids.has(msg.guid)) return null;
    this.seenGuids.add(msg.guid);
    const nick = msg.isFromMe ? this.selfDisplayName : this.resolveHandle(msg.handle);
    const files: FileChip[] = [];
    for (const a of msg.attachments || []) {
      if (!a.guid) continue;
      const name = a.transferName || a.guid;
      // Skip Apple's rich-link / plugin-payload attachments — they're URL-preview
      // metadata, not real files, and would otherwise render as junk rows.
      if (/pluginPayload/i.test(name)) continue;
      // BlueBubbles sometimes omits the mime; derive it from the extension so
      // videos (esp. .mov) still get a playable Content-Type and the <video> tag.
      const mimetype = a.mimeType || mimeFromName(name);
      if (!mimetype) continue; // unknown, non-displayable payload
      this.attachments.set(a.guid, { mimetype, name });
      files.push({
        name,
        url: `/api/networks/${this.network.id}/imessage-attachment/${a.guid}`,
        image: mimetype.startsWith('image/'),
        video: mimetype.startsWith('video/'),
      });
    }
    const tally = this.reactionTallies.get(key);
    const mine = this.selfReactions.get(key);
    const reactions: ReactionChip[] = tally
      ? Array.from(tally.entries())
          .filter(([, c]) => c > 0)
          .map(([name, count]) => ({ name, count, mine: !!mine?.has(name) }))
      : [];
    return {
      nick,
      text: msg.text || '',
      self: !!msg.isFromMe,
      time: msToIso(msg.dateCreated),
      guid: msg.guid,
      reactions,
      files,
    };
  }

  protected persistHistorical(chatGuid: string, target: string, msg: BBMessage): void {
    const built = this.buildMessage(chatGuid, msg);
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
      // slackTs carries the iMessage guid so the client matches reactions to this
      // row; reactions/files persist so they survive a reload.
      extra: {
        slackTs: built.guid,
        ...(built.reactions.length ? { reactions: built.reactions } : {}),
        ...(built.files.length ? { files: built.files } : {}),
      },
      matchedRuleId: null,
      userhost: null,
      fromIgnored: false,
    });
  }

  // ── Realtime ────────────────────────────────────────────────────────────────

  protected openSocket(): void {
    const socket = io(this.serverUrl, {
      transports: ['websocket'],
      // BlueBubbles accepts either auth param on the socket handshake; send both.
      query: { guid: this.password, password: this.password },
      reconnection: true,
    });
    const onMessage = (data: BBMessage & { chats?: BBChat[] }) => void this.ingestLive(data);
    socket.on('new-message', onMessage);
    socket.on('updated-message', onMessage);
    this.socket = socket;
  }

  // Resolve which chat a live message belongs to, registering a brand-new chat
  // (one we haven't seen yet) from the payload's attached `chats` so its buffer
  // appears immediately. Returns null only when the payload has no chat at all.
  protected chatGuidFor(msg: BBMessage & { chats?: BBChat[] }): string | null {
    const chat = msg.chats?.[0];
    const guid = chat?.guid;
    if (!guid) return null;
    if (!this.idToTarget.has(guid)) {
      this.registerChat(chat!);
      // Surface the new buffer to open clients.
      if (this.state === 'connected') this.setState('connected');
    }
    return this.idToTarget.has(guid) ? guid : null;
  }

  protected async ingestLive(msg: BBMessage & { chats?: BBChat[] }): Promise<void> {
    const chatGuid = this.chatGuidFor(msg);
    if (!chatGuid) return;
    const target = this.idToTarget.get(chatGuid);
    if (!target) return;
    // A tapback updates an existing message's chips, not a new row.
    if (this.foldTapback(chatGuid, msg)) return;
    this.publishLive(chatGuid, target, msg);
  }

  // Build + persist + emit a single live message (shared by the socket and the
  // reconciliation poll). No-op for a tapback or an already-seen guid.
  protected publishLive(chatGuid: string, target: string, msg: BBMessage): void {
    const built = this.buildMessage(chatGuid, msg);
    if (!built) return;
    this.publish({
      type: 'message',
      target,
      nick: built.nick,
      text: built.text,
      kind: 'privmsg',
      self: built.self,
      time: built.time,
      slackTs: built.guid,
      reactions: built.reactions,
      files: built.files,
      extra: {
        slackTs: built.guid,
        ...(built.reactions.length ? { reactions: built.reactions } : {}),
        ...(built.files.length ? { files: built.files } : {}),
      },
    });
  }

  // ── Reconciliation poll ──────────────────────────────────────────────────────
  // The socket can miss events (sleep, reconnect, server hiccups), so we also
  // poll: re-fetch the chat list to add new chats, and pull each chat's recent
  // messages to ingest anything new. Dedup (seenGuids) keeps it idempotent.
  protected poll: ReturnType<typeof setInterval> | null = null;

  protected startPoll(): void {
    this.poll = setInterval(() => void this.pollOnce().catch(() => {}), POLL_INTERVAL_MS);
  }

  protected async pollOnce(): Promise<void> {
    if (this.disposed) return;
    let added = false;
    for (const chat of await this.bbGetChats().catch(() => [] as BBChat[])) {
      if (chat.guid && !this.idToTarget.has(chat.guid)) {
        this.registerChat(chat);
        added = true;
      }
    }
    if (added) this.setState('connected'); // re-snapshot for new buffers
    const guids = Array.from(this.idToTarget.keys());
    await pool(guids, POLL_CONCURRENCY, async (chatGuid) => {
      const target = this.idToTarget.get(chatGuid);
      if (!target) return;
      const messages = await this.bbGetMessages(chatGuid, POLL_MESSAGE_LIMIT).catch(
        () => [] as BBMessage[],
      );
      const ordered = messages.slice().reverse();
      for (const msg of ordered) this.foldTapback(chatGuid, msg);
      for (const msg of ordered) {
        if (tapbackOf(msg.associatedMessageType)) continue;
        if (msg.guid && !this.seenGuids.has(msg.guid)) this.publishLive(chatGuid, target, msg);
      }
    });
  }

  // ── Reactions (tapbacks) ─────────────────────────────────────────────────────

  protected applyReactionDelta(
    chatGuid: string,
    msgGuid: string,
    name: string,
    delta: number,
    fromMe: boolean,
  ): void {
    const key = `${chatGuid}:${msgGuid}`;
    let tally = this.reactionTallies.get(key);
    if (!tally) {
      tally = new Map<string, number>();
      this.reactionTallies.set(key, tally);
    }
    tally.set(name, Math.max(0, (tally.get(name) || 0) + delta));
    if ((tally.get(name) || 0) === 0) tally.delete(name);
    if (fromMe) {
      let mine = this.selfReactions.get(key);
      if (!mine) {
        mine = new Set<string>();
        this.selfReactions.set(key, mine);
      }
      if (delta > 0) mine.add(name);
      else mine.delete(name);
    }
    // Only push a live update once connected (backfill folds happen pre-connect
    // and ride along with the persisted message instead).
    if (this.state === 'connected') this.emitReactionUpdate(chatGuid, msgGuid);
  }

  protected emitReactionUpdate(chatGuid: string, msgGuid: string): void {
    const target = this.idToTarget.get(chatGuid);
    if (!target) return;
    const key = `${chatGuid}:${msgGuid}`;
    const tally = this.reactionTallies.get(key) || new Map<string, number>();
    const mine = this.selfReactions.get(key) || new Set<string>();
    const reactions: ReactionChip[] = Array.from(tally.entries())
      .filter(([, c]) => c > 0)
      .map(([name, count]) => ({ name, count, mine: mine.has(name) }));
    this.publishEphemeral({ type: 'reaction', target, slackTs: msgGuid, reactions });
  }

  // Click-to-react from the client. BlueBubbles needs the target message guid +
  // a tapback type number. Demo applies locally.
  react(target: string, slackTs: string, name: string, add: boolean): void {
    const chatGuid = this.targetToId.get(target.toLowerCase());
    const type = NAME_TO_TAPBACK.get(name);
    if (!chatGuid || !slackTs || type === undefined) return;
    // Demo has no real workspace — apply the toggle locally so click-to-react is
    // exercisable in the browser. A real server round-trips via BlueBubbles.
    if (this.isDemo) {
      this.applyReactionDelta(chatGuid, slackTs, name, add ? +1 : -1, true);
      return;
    }
    void this.bbReact(chatGuid, slackTs, add ? type : type + 1000).catch(() => {});
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  say(target: string, text: string): void {
    const chatGuid = this.targetToId.get(target.toLowerCase());
    if (!chatGuid || !text) return;
    if (this.isDemo) {
      // Echo locally so the demo composer round-trips.
      this.publish({
        type: 'message',
        target,
        nick: this.selfDisplayName,
        text,
        kind: 'privmsg',
        self: true,
        time: new Date().toISOString(),
        slackTs: `local-${Date.now()}`,
        extra: { slackTs: `local-${Date.now()}` },
      });
      return;
    }
    const tempGuid = `temp-${this.network.id}-${Date.now()}`;
    void this.bbSendText(chatGuid, text, tempGuid).catch(() => {});
  }

  action(target: string, text: string): void {
    this.say(target, text);
  }
  notice(target: string, text: string): void {
    this.say(target, text);
  }

  // Mark a chat read on the Mac when the user reads it in Lurker.
  markRead(target: string, messageId: number): void {
    const chatGuid = this.targetToId.get(target.toLowerCase());
    if (!chatGuid || this.isDemo) return;
    // messageId is only used to confirm there's a real message; BlueBubbles
    // marks the whole chat read.
    const extra = getMessageExtra(this.network.id, target, messageId);
    if (!extra) return;
    void this.bbMarkRead(chatGuid).catch(() => {});
  }

  // Attachment bytes for the proxy route (fetched from BlueBubbles with auth).
  async downloadAttachment(
    attachmentGuid: string,
  ): Promise<{ data: ArrayBuffer; mimetype: string; name: string } | null> {
    const meta = this.attachments.get(attachmentGuid);
    if (!meta || this.isDemo) return null;
    try {
      const res = await fetch(
        this.bbUrl(`attachment/${encodeURIComponent(attachmentGuid)}/download`),
      );
      if (!res.ok) return null;
      return { data: await res.arrayBuffer(), mimetype: meta.mimetype, name: meta.name };
    } catch {
      return null;
    }
  }

  // ── IRC-only no-ops ──────────────────────────────────────────────────────────
  join(_channel: string): void {}
  part(_channel: string, _reason?: string): void {}
  sendTyping(_target: string, _state: string): void {}
  raw(_line: string): void {}
  probePresence(_nick: string | undefined | null): void {}
  trackDmPeer(_nick: string | undefined | null): boolean {
    return false;
  }
  untrackDmPeer(_nick: string | undefined | null): void {}
  trackFriend(_nick: string | undefined | null, _contactId: number): void {}
  untrackFriend(_nick: string | undefined | null): void {}
  applyAwayState(_next: AwayState): void {}
  supportsMultiline(): boolean {
    return false;
  }
  sendMultiline(_target: string, _text: string): string[] {
    return [];
  }
  selfName(): string {
    return this.selfDisplayName;
  }

  // ── Event emission (mirrors SlackConnection) ─────────────────────────────────
  publish(event: IrcEvent): void {
    if (this.disposed) return;
    const time = (event.time as string | undefined) || new Date().toISOString();
    const enriched: EnrichedEvent = {
      ...event,
      userId: this.network.user_id,
      networkId: this.network.id,
      time,
    };
    if (event.type === 'message' && typeof event.target === 'string') {
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

  // ── Demo mode (credential-free; mirrors SlackConnection.connectDemo) ─────────
  protected async connectDemo(): Promise<void> {
    this.selfDisplayName = 'me';
    // A 1:1 chat and a group chat.
    this.mapTarget('Alex Rivera', 'iMessage;-;demo-dm');
    const groupTarget = 'Alex, Sam, Jordan';
    this.mapTarget(groupTarget, 'iMessage;+;demo-group');
    const members = new Map<string, ChannelMember>();
    for (const n of ['Alex', 'Sam', 'Jordan', 'me']) {
      members.set(n.toLowerCase(), { nick: n, modes: [], away: false, user: null, host: null });
    }
    this.channels.set(groupTarget.toLowerCase(), {
      name: groupTarget,
      topic: null,
      members,
      modes: new Set<string>(),
    });

    const now = Date.now();
    const history: Array<{
      target: string;
      nick: string;
      text: string;
      ms: number;
      self?: boolean;
      guid: string;
      reactions?: ReactionChip[];
    }> = [
      {
        target: 'Alex Rivera',
        nick: 'Alex Rivera',
        text: 'hey! this is iMessage inside Lurker',
        ms: now - 60_000,
        guid: 'd1',
      },
      {
        target: 'Alex Rivera',
        nick: 'me',
        text: 'whoa, it renders just like IRC and Slack',
        ms: now - 50_000,
        self: true,
        guid: 'd2',
      },
      {
        target: 'Alex Rivera',
        nick: 'Alex Rivera',
        text: 'tapbacks show up as reaction chips too',
        ms: now - 40_000,
        guid: 'd3',
        reactions: [{ name: 'heart', count: 1, mine: true }],
      },
      {
        target: groupTarget,
        nick: 'Sam',
        text: 'group chats land in one buffer',
        ms: now - 30_000,
        guid: 'd4',
      },
      {
        target: groupTarget,
        nick: 'Jordan',
        text: 'with a participant list on the side',
        ms: now - 20_000,
        guid: 'd5',
      },
    ];
    for (const h of history) {
      if (h.reactions) {
        const chatGuid = this.targetToId.get(h.target.toLowerCase())!;
        const key = `${chatGuid}:${h.guid}`;
        const tally = new Map<string, number>();
        for (const r of h.reactions) tally.set(r.name, r.count);
        this.reactionTallies.set(key, tally);
        if (h.reactions.some((r) => r.mine))
          this.selfReactions.set(
            key,
            new Set(h.reactions.filter((r) => r.mine).map((r) => r.name)),
          );
      }
      this.seenGuids.add(h.guid);
      insertMessage({
        networkId: this.network.id,
        target: h.target,
        time: msToIso(h.ms),
        type: 'message',
        nick: h.nick,
        text: h.text,
        kind: 'privmsg',
        self: !!h.self,
        extra: { slackTs: h.guid, ...(h.reactions ? { reactions: h.reactions } : {}) },
        matchedRuleId: null,
        userhost: null,
        fromIgnored: false,
      });
    }

    this.setState('connected');

    // Drip a live message every few seconds so the live path is visible.
    let n = 0;
    this.demoTimer = setInterval(() => {
      n += 1;
      const guid = `d-live-${n}`;
      this.seenGuids.add(guid);
      this.publish({
        type: 'message',
        target: 'Alex Rivera',
        nick: 'Alex Rivera',
        text: `live iMessage #${n}`,
        kind: 'privmsg',
        self: false,
        time: new Date().toISOString(),
        slackTs: guid,
        extra: { slackTs: guid },
      });
    }, 8000);
  }
}
