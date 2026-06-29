// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The contract a per-network connection must satisfy for ircManager + wsHub to
// drive it. IrcConnection has always implemented this surface structurally;
// extracting it lets a SlackConnection (or any future provider) plug into the
// exact same manager/fan-out machinery without touching the client. Provider
// dispatch happens in ircManager.startNetwork off `network.provider`.
//
// IRC-only members (the irc-framework `client`, RPE2E helpers, raw-line
// passthrough specifics) stay on IrcConnection; ircManager reaches for them only
// after narrowing on `provider === 'irc'`, so they don't belong on this contract.

import type { Network } from '../db/networks.js';
import type { AwayState, ChannelState, IrcEvent } from './ircConnection.js';

// Per-network state blob the client snapshot is built from. Open-ended (index
// signature) because providers add their own extras, but the fields ircManager
// reads — networkId above all — are typed so snapshotForUser stays type-safe.
export interface NetworkSnapshot {
  networkId: number;
  state: string;
  nick: string;
  userModes: string;
  lagMs: number | null;
  multilineLimits: unknown;
  away: unknown;
  channels: unknown[];
  peerPresence: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Connection {
  // Discriminant for the IrcConnection | SlackConnection | ImessageConnection
  // union in ircManager — lets the manager narrow to a specific implementation
  // for provider-only paths.
  readonly provider: 'irc' | 'slack' | 'imessage';
  network: Network;
  // Connection lifecycle state ('idle' | 'connecting' | 'connected' |
  // 'disconnected' | …) — surfaced in the snapshot and the server buffer header.
  state: string;
  disposed: boolean;
  // Open buffers with membership/topic, keyed by lowercased channel name. wsHub
  // reads this to decide a buffer's joined state for backlog.
  channels: Map<string, ChannelState>;

  // Lifecycle
  connect(): void;
  disconnect(reason?: string): void;
  dispose(reason?: string): void;

  // Outbound
  say(target: string, text: string): void;
  action(target: string, text: string): void;
  notice(target: string, text: string): void;
  join(channel: string): void;
  part(channel: string, reason?: string): void;
  sendTyping(target: string, state: string): void;
  raw(line: string): void;

  // Presence / contacts
  probePresence(nick: string | undefined | null): void;
  trackDmPeer(nick: string | undefined | null): boolean;
  untrackDmPeer(nick: string | undefined | null): void;
  trackFriend(nick: string | undefined | null, contactId: number): void;
  untrackFriend(nick: string | undefined | null): void;
  applyAwayState(next: AwayState): void;

  // Event emission toward wsHub (publish persists; publishEphemeral is transient)
  publish(event: IrcEvent): void;
  publishEphemeral(event: IrcEvent): void;

  // The authenticated user's own display name on this connection, for self-echo.
  selfName(): string;
  // Multi-line send capability. IRC negotiates draft/multiline; other providers
  // return false and the manager falls back to a per-line send.
  supportsMultiline(): boolean;
  sendMultiline(target: string, text: string): string[];

  // Per-network state blob for the client snapshot (shape matches wsHub's
  // expectations: networkId, state, nick, channels[], peerPresence{}, …).
  snapshot(): NetworkSnapshot;
}
