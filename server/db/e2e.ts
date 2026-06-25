// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// RPE2E keyring — the persistent storage layer for end-to-end encryption
// (issue #382). A faithful port of repartee's `keyring.rs`, adapted for
// Lurker's multi-tenant cell: the identity is per-ACCOUNT (`user_id`) and
// everything else is scoped per `(user_id, network_id)`.
//
// Secret columns (the identity private key and the session keys) are sealed
// with the existing `secretCrypto` at-rest scheme (the same `lk1.*` envelope
// used for network credentials) — important because hosted cell DBs ship to R2
// backups. Public material (pubkeys, fingerprints) is stored as BLOB. This
// module is pure storage + CRUD; handshake orchestration, trust policy, and the
// rate limiter live in the (not-yet-built) E2eManager.

import { E2eError } from '../services/e2e/errors.js';
import { decryptSecret, encryptSecret } from '../utils/secretCrypto.js';
import db from './index.js';

// ─── types ───────────────────────────────────────────────────────────────────

export type TrustStatus = 'pending' | 'trusted' | 'revoked';
export type ChannelMode = 'auto-accept' | 'normal' | 'quiet';

export interface IdentityInput {
  pubkey: Uint8Array;
  /** 32-byte Ed25519 seed (sealed at rest). */
  privkey: Uint8Array;
  fingerprint: Uint8Array;
  createdAt: number;
}
export type IdentityRow = IdentityInput;

export interface PeerRecord {
  fingerprint: Uint8Array;
  pubkey: Uint8Array;
  lastHandle: string | null;
  lastNick: string | null;
  firstSeen: number;
  lastSeen: number;
  globalStatus: TrustStatus;
}

export interface IncomingSession {
  handle: string;
  channel: string;
  fingerprint: Uint8Array;
  /** 32-byte session key (sealed at rest). */
  sk: Uint8Array;
  status: TrustStatus;
  createdAt: number;
}

export interface OutgoingSession {
  channel: string;
  /** 32-byte session key (sealed at rest). */
  sk: Uint8Array;
  createdAt: number;
  pendingRotation: boolean;
}

export interface ChannelConfig {
  channel: string;
  enabled: boolean;
  mode: ChannelMode;
}

/**
 * Thrown by `installIncomingSessionStrict` when a session already exists for
 * `(handle, channel)` under a DIFFERENT fingerprint — the strict-TOFU signal a
 * caller turns into a "key changed, /e2e reverify to accept" warning.
 */
export class HandleMismatchError extends E2eError {
  readonly expected: string;
  readonly got: string;
  constructor(expected: string, got: string) {
    super('keyring', `handle mismatch: pinned ${expected}, got ${got}`);
    this.name = 'HandleMismatchError';
    this.expected = expected;
    this.got = got;
  }
}

// ─── value mapping ───────────────────────────────────────────────────────────

const toBlob = (u8: Uint8Array): Buffer => Buffer.from(u8);
const fromBlob = (b: unknown): Uint8Array => new Uint8Array(b as Buffer);

/** Seal a raw key to a secretCrypto envelope (hex → encrypted TEXT). */
function sealKey(key: Uint8Array): string {
  return encryptSecret(Buffer.from(key).toString('hex'))!;
}
/** Open a sealed key back to raw bytes. */
function openKey(stored: string): Uint8Array {
  const hex = decryptSecret(stored);
  if (!hex) throw new E2eError('keyring', 'sealed key is empty or unreadable');
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

// Lenient enum parsing, mirroring repartee (unknown → safe default; `auto` is an
// accepted alias for `auto-accept`).
export function parseTrustStatus(s: string): TrustStatus {
  return s === 'trusted' ? 'trusted' : s === 'revoked' ? 'revoked' : 'pending';
}
export function parseChannelMode(s: string): ChannelMode {
  if (s === 'auto-accept' || s === 'auto') return 'auto-accept';
  if (s === 'quiet') return 'quiet';
  return 'normal';
}

// ─── identity (per account) ──────────────────────────────────────────────────

const upsertIdentityStmt = db.prepare(`
  INSERT INTO e2e_identity (user_id, pubkey, privkey, fingerprint, created_at)
  VALUES (@userId, @pubkey, @privkey, @fingerprint, @createdAt)
  ON CONFLICT(user_id) DO UPDATE SET
    pubkey = excluded.pubkey, privkey = excluded.privkey,
    fingerprint = excluded.fingerprint, created_at = excluded.created_at
`);
const loadIdentityStmt = db.prepare(
  `SELECT pubkey, privkey, fingerprint, created_at FROM e2e_identity WHERE user_id = ?`,
);

export function saveIdentity(userId: number, id: IdentityInput): void {
  upsertIdentityStmt.run({
    userId,
    pubkey: toBlob(id.pubkey),
    privkey: sealKey(id.privkey),
    fingerprint: toBlob(id.fingerprint),
    createdAt: id.createdAt,
  });
}

export function loadIdentity(userId: number): IdentityRow | null {
  const r = loadIdentityStmt.get(userId) as
    | { pubkey: Buffer; privkey: string; fingerprint: Buffer; created_at: number }
    | undefined;
  if (!r) return null;
  return {
    pubkey: fromBlob(r.pubkey),
    privkey: openKey(r.privkey),
    fingerprint: fromBlob(r.fingerprint),
    createdAt: r.created_at,
  };
}

// ─── peers ───────────────────────────────────────────────────────────────────

const upsertPeerStmt = db.prepare(`
  INSERT INTO e2e_peers
    (user_id, network_id, fingerprint, pubkey, last_handle, last_nick, first_seen, last_seen, global_status)
  VALUES
    (@userId, @networkId, @fingerprint, @pubkey, @lastHandle, @lastNick, @firstSeen, @lastSeen, @globalStatus)
  ON CONFLICT(user_id, network_id, fingerprint) DO UPDATE SET
    last_handle = excluded.last_handle, last_nick = excluded.last_nick,
    last_seen = excluded.last_seen, global_status = excluded.global_status
`);
const getPeerByFpStmt = db.prepare(
  `SELECT * FROM e2e_peers WHERE user_id = ? AND network_id = ? AND fingerprint = ?`,
);
const getPeerByHandleStmt = db.prepare(
  `SELECT * FROM e2e_peers WHERE user_id = ? AND network_id = ? AND last_handle = ?
   ORDER BY last_seen DESC LIMIT 1`,
);
const deletePeerStmt = db.prepare(
  `DELETE FROM e2e_peers WHERE user_id = ? AND network_id = ? AND fingerprint = ?`,
);
const listPeersStmt = db.prepare(
  `SELECT * FROM e2e_peers WHERE user_id = ? AND network_id = ? ORDER BY first_seen ASC`,
);

interface PeerRow {
  fingerprint: Buffer;
  pubkey: Buffer;
  last_handle: string | null;
  last_nick: string | null;
  first_seen: number;
  last_seen: number;
  global_status: string;
}
function mapPeer(r: PeerRow): PeerRecord {
  return {
    fingerprint: fromBlob(r.fingerprint),
    pubkey: fromBlob(r.pubkey),
    lastHandle: r.last_handle,
    lastNick: r.last_nick,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    globalStatus: parseTrustStatus(r.global_status),
  };
}

export function upsertPeer(userId: number, networkId: number, peer: PeerRecord): void {
  upsertPeerStmt.run({
    userId,
    networkId,
    fingerprint: toBlob(peer.fingerprint),
    pubkey: toBlob(peer.pubkey),
    lastHandle: peer.lastHandle,
    lastNick: peer.lastNick,
    firstSeen: peer.firstSeen,
    lastSeen: peer.lastSeen,
    globalStatus: peer.globalStatus,
  });
}

export function getPeerByFingerprint(
  userId: number,
  networkId: number,
  fingerprint: Uint8Array,
): PeerRecord | null {
  const r = getPeerByFpStmt.get(userId, networkId, toBlob(fingerprint)) as PeerRow | undefined;
  return r ? mapPeer(r) : null;
}

/** Reverse lookup by handle (most recently seen), for the TOFU "known
 *  fingerprint, new handle" check. */
export function getPeerByHandle(
  userId: number,
  networkId: number,
  handle: string,
): PeerRecord | null {
  const r = getPeerByHandleStmt.get(userId, networkId, handle) as PeerRow | undefined;
  return r ? mapPeer(r) : null;
}

export function deletePeerByFingerprint(
  userId: number,
  networkId: number,
  fingerprint: Uint8Array,
): void {
  deletePeerStmt.run(userId, networkId, toBlob(fingerprint));
}

export function listPeers(userId: number, networkId: number): PeerRecord[] {
  return (listPeersStmt.all(userId, networkId) as PeerRow[]).map(mapPeer);
}

// ─── incoming sessions (per sender, per channel) ─────────────────────────────

const upsertIncomingStmt = db.prepare(`
  INSERT INTO e2e_incoming_sessions
    (user_id, network_id, handle, channel, fingerprint, sk, status, created_at)
  VALUES
    (@userId, @networkId, @handle, @channel, @fingerprint, @sk, @status, @createdAt)
  ON CONFLICT(user_id, network_id, handle, channel) DO UPDATE SET
    fingerprint = excluded.fingerprint, sk = excluded.sk,
    status = excluded.status, created_at = excluded.created_at
`);
const getIncomingFpStmt = db.prepare(
  `SELECT fingerprint FROM e2e_incoming_sessions
   WHERE user_id = ? AND network_id = ? AND handle = ? AND channel = ?`,
);
const getIncomingStmt = db.prepare(
  `SELECT * FROM e2e_incoming_sessions
   WHERE user_id = ? AND network_id = ? AND handle = ? AND channel = ?`,
);
const updateIncomingStatusStmt = db.prepare(
  `UPDATE e2e_incoming_sessions SET status = ?
   WHERE user_id = ? AND network_id = ? AND handle = ? AND channel = ?`,
);
const deleteIncomingStmt = db.prepare(
  `DELETE FROM e2e_incoming_sessions
   WHERE user_id = ? AND network_id = ? AND handle = ? AND channel = ?`,
);
const deleteIncomingForHandleStmt = db.prepare(
  `DELETE FROM e2e_incoming_sessions WHERE user_id = ? AND network_id = ? AND handle = ?`,
);
const listTrustedForChannelStmt = db.prepare(
  `SELECT * FROM e2e_incoming_sessions
   WHERE user_id = ? AND network_id = ? AND channel = ? AND status = 'trusted'`,
);
const listIncomingStmt = db.prepare(
  `SELECT * FROM e2e_incoming_sessions WHERE user_id = ? AND network_id = ?
   ORDER BY channel ASC, handle ASC`,
);

interface IncomingRow {
  handle: string;
  channel: string;
  fingerprint: Buffer;
  sk: string;
  status: string;
  created_at: number;
}
function mapIncoming(r: IncomingRow): IncomingSession {
  return {
    handle: r.handle,
    channel: r.channel,
    fingerprint: fromBlob(r.fingerprint),
    sk: openKey(r.sk),
    status: parseTrustStatus(r.status),
    createdAt: r.created_at,
  };
}
function incomingBind(userId: number, networkId: number, s: IncomingSession) {
  return {
    userId,
    networkId,
    handle: s.handle,
    channel: s.channel,
    fingerprint: toBlob(s.fingerprint),
    sk: sealKey(s.sk),
    status: s.status,
    createdAt: s.createdAt,
  };
}

/** Unconditional upsert (override / import / test path). */
export function setIncomingSession(userId: number, networkId: number, s: IncomingSession): void {
  upsertIncomingStmt.run(incomingBind(userId, networkId, s));
}

/**
 * Install under strict TOFU: if a row already exists for `(handle, channel)`
 * with a different fingerprint, throw `HandleMismatchError` and leave the
 * existing row untouched. Same fingerprint (idempotent refresh) upserts.
 */
export function installIncomingSessionStrict(
  userId: number,
  networkId: number,
  s: IncomingSession,
): void {
  const existing = getIncomingFpStmt.get(userId, networkId, s.handle, s.channel) as
    | { fingerprint: Buffer }
    | undefined;
  if (existing) {
    const pinned = Buffer.from(existing.fingerprint).toString('hex');
    const incoming = Buffer.from(s.fingerprint).toString('hex');
    if (pinned !== incoming) throw new HandleMismatchError(pinned, incoming);
  }
  upsertIncomingStmt.run(incomingBind(userId, networkId, s));
}

export function getIncomingSession(
  userId: number,
  networkId: number,
  handle: string,
  channel: string,
): IncomingSession | null {
  const r = getIncomingStmt.get(userId, networkId, handle, channel) as IncomingRow | undefined;
  return r ? mapIncoming(r) : null;
}

export function updateIncomingStatus(
  userId: number,
  networkId: number,
  handle: string,
  channel: string,
  status: TrustStatus,
): void {
  updateIncomingStatusStmt.run(status, userId, networkId, handle, channel);
}

export function deleteIncomingSession(
  userId: number,
  networkId: number,
  handle: string,
  channel: string,
): void {
  deleteIncomingStmt.run(userId, networkId, handle, channel);
}

/** Delete every incoming session for a handle (across channels); returns the
 *  number removed, for a user-facing reverify summary. */
export function deleteIncomingSessionsForHandle(
  userId: number,
  networkId: number,
  handle: string,
): number {
  return deleteIncomingForHandleStmt.run(userId, networkId, handle).changes;
}

/** Trusted incoming sessions for a channel (the decrypt hot path). */
export function listTrustedSessionsForChannel(
  userId: number,
  networkId: number,
  channel: string,
): IncomingSession[] {
  return (listTrustedForChannelStmt.all(userId, networkId, channel) as IncomingRow[]).map(
    mapIncoming,
  );
}

export function listIncomingSessions(userId: number, networkId: number): IncomingSession[] {
  return (listIncomingStmt.all(userId, networkId) as IncomingRow[]).map(mapIncoming);
}

// ─── outgoing sessions (our key, per channel) ────────────────────────────────

const upsertOutgoingStmt = db.prepare(`
  INSERT INTO e2e_outgoing_sessions (user_id, network_id, channel, sk, created_at, pending_rotation)
  VALUES (@userId, @networkId, @channel, @sk, @createdAt, 0)
  ON CONFLICT(user_id, network_id, channel) DO UPDATE SET
    sk = excluded.sk, created_at = excluded.created_at, pending_rotation = 0
`);
const getOutgoingStmt = db.prepare(
  `SELECT * FROM e2e_outgoing_sessions WHERE user_id = ? AND network_id = ? AND channel = ?`,
);
const setPendingRotationStmt = db.prepare(
  `UPDATE e2e_outgoing_sessions SET pending_rotation = ?
   WHERE user_id = ? AND network_id = ? AND channel = ?`,
);
const listOutgoingStmt = db.prepare(
  `SELECT * FROM e2e_outgoing_sessions WHERE user_id = ? AND network_id = ? ORDER BY channel ASC`,
);

interface OutgoingRow {
  channel: string;
  sk: string;
  created_at: number;
  pending_rotation: number;
}
function mapOutgoing(r: OutgoingRow): OutgoingSession {
  return {
    channel: r.channel,
    sk: openKey(r.sk),
    createdAt: r.created_at,
    pendingRotation: r.pending_rotation === 1,
  };
}

export function setOutgoingSession(
  userId: number,
  networkId: number,
  channel: string,
  sk: Uint8Array,
  createdAt: number,
): void {
  upsertOutgoingStmt.run({ userId, networkId, channel, sk: sealKey(sk), createdAt });
}

export function getOutgoingSession(
  userId: number,
  networkId: number,
  channel: string,
): OutgoingSession | null {
  const r = getOutgoingStmt.get(userId, networkId, channel) as OutgoingRow | undefined;
  return r ? mapOutgoing(r) : null;
}

export function markOutgoingPendingRotation(
  userId: number,
  networkId: number,
  channel: string,
): void {
  setPendingRotationStmt.run(1, userId, networkId, channel);
}

export function clearOutgoingPendingRotation(
  userId: number,
  networkId: number,
  channel: string,
): void {
  setPendingRotationStmt.run(0, userId, networkId, channel);
}

export function listOutgoingSessions(userId: number, networkId: number): OutgoingSession[] {
  return (listOutgoingStmt.all(userId, networkId) as OutgoingRow[]).map(mapOutgoing);
}

// ─── channel config ──────────────────────────────────────────────────────────

const upsertChannelConfigStmt = db.prepare(`
  INSERT INTO e2e_channel_config (user_id, network_id, channel, enabled, mode)
  VALUES (@userId, @networkId, @channel, @enabled, @mode)
  ON CONFLICT(user_id, network_id, channel) DO UPDATE SET
    enabled = excluded.enabled, mode = excluded.mode
`);
const getChannelConfigStmt = db.prepare(
  `SELECT * FROM e2e_channel_config WHERE user_id = ? AND network_id = ? AND channel = ?`,
);
const listChannelConfigsStmt = db.prepare(
  `SELECT * FROM e2e_channel_config WHERE user_id = ? AND network_id = ? ORDER BY channel ASC`,
);

interface ChannelConfigRow {
  channel: string;
  enabled: number;
  mode: string;
}
function mapChannelConfig(r: ChannelConfigRow): ChannelConfig {
  return { channel: r.channel, enabled: r.enabled === 1, mode: parseChannelMode(r.mode) };
}

export function setChannelConfig(userId: number, networkId: number, cfg: ChannelConfig): void {
  upsertChannelConfigStmt.run({
    userId,
    networkId,
    channel: cfg.channel,
    enabled: cfg.enabled ? 1 : 0,
    mode: cfg.mode,
  });
}

export function getChannelConfig(
  userId: number,
  networkId: number,
  channel: string,
): ChannelConfig | null {
  const r = getChannelConfigStmt.get(userId, networkId, channel) as ChannelConfigRow | undefined;
  return r ? mapChannelConfig(r) : null;
}

export function listChannelConfigs(userId: number, networkId: number): ChannelConfig[] {
  return (listChannelConfigsStmt.all(userId, networkId) as ChannelConfigRow[]).map(
    mapChannelConfig,
  );
}

// ─── autotrust ───────────────────────────────────────────────────────────────

const addAutotrustStmt = db.prepare(`
  INSERT OR IGNORE INTO e2e_autotrust (user_id, network_id, scope, handle_pattern, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const listAutotrustStmt = db.prepare(
  `SELECT scope, handle_pattern FROM e2e_autotrust WHERE user_id = ? AND network_id = ?`,
);
const removeAutotrustStmt = db.prepare(
  `DELETE FROM e2e_autotrust WHERE user_id = ? AND network_id = ? AND handle_pattern = ?`,
);
const matchAutotrustStmt = db.prepare(
  `SELECT handle_pattern FROM e2e_autotrust
   WHERE user_id = ? AND network_id = ? AND (scope = 'global' OR scope = ?)`,
);

export interface AutotrustRule {
  scope: string;
  handlePattern: string;
}

export function addAutotrust(
  userId: number,
  networkId: number,
  scope: string,
  handlePattern: string,
  createdAt: number,
): void {
  addAutotrustStmt.run(userId, networkId, scope, handlePattern, createdAt);
}

export function listAutotrust(userId: number, networkId: number): AutotrustRule[] {
  return (
    listAutotrustStmt.all(userId, networkId) as Array<{ scope: string; handle_pattern: string }>
  ).map((r) => ({ scope: r.scope, handlePattern: r.handle_pattern }));
}

export function removeAutotrust(userId: number, networkId: number, handlePattern: string): void {
  removeAutotrustStmt.run(userId, networkId, handlePattern);
}

/**
 * True if any autotrust rule (global, or scoped to `channel`) matches `handle`.
 * Patterns use minimal case-insensitive glob: `*` any run, `?` one char.
 */
export function autotrustMatches(
  userId: number,
  networkId: number,
  handle: string,
  channel: string,
): boolean {
  const rows = matchAutotrustStmt.all(userId, networkId, channel) as Array<{
    handle_pattern: string;
  }>;
  return rows.some((r) => globMatchCi(r.handle_pattern, handle));
}

/** Minimal case-insensitive glob: `*` matches any run, `?` one char, else literal. */
export function globMatchCi(pattern: string, input: string): boolean {
  const p = pattern.toLowerCase();
  const s = input.toLowerCase();
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === s[si])) {
      pi++;
      si++;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = si;
    } else if (star !== -1) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

// ─── outgoing recipients (for lazy-rotate distribution) ──────────────────────

const recordRecipientStmt = db.prepare(`
  INSERT INTO e2e_outgoing_recipients (user_id, network_id, channel, handle, fingerprint, first_sent_at)
  VALUES (@userId, @networkId, @channel, @handle, @fingerprint, @firstSentAt)
  ON CONFLICT(user_id, network_id, channel, handle) DO UPDATE SET fingerprint = excluded.fingerprint
`);
const listRecipientsStmt = db.prepare(
  `SELECT handle, fingerprint FROM e2e_outgoing_recipients
   WHERE user_id = ? AND network_id = ? AND channel = ? ORDER BY first_sent_at ASC`,
);
const removeRecipientStmt = db.prepare(
  `DELETE FROM e2e_outgoing_recipients
   WHERE user_id = ? AND network_id = ? AND channel = ? AND handle = ?`,
);
const deleteRecipientsForHandleStmt = db.prepare(
  `DELETE FROM e2e_outgoing_recipients WHERE user_id = ? AND network_id = ? AND handle = ?`,
);

export interface OutgoingRecipient {
  handle: string;
  fingerprint: Uint8Array;
}

export function recordOutgoingRecipient(
  userId: number,
  networkId: number,
  channel: string,
  handle: string,
  fingerprint: Uint8Array,
  firstSentAt: number,
): void {
  recordRecipientStmt.run({
    userId,
    networkId,
    channel,
    handle,
    fingerprint: toBlob(fingerprint),
    firstSentAt,
  });
}

export function listOutgoingRecipients(
  userId: number,
  networkId: number,
  channel: string,
): OutgoingRecipient[] {
  return (
    listRecipientsStmt.all(userId, networkId, channel) as Array<{
      handle: string;
      fingerprint: Buffer;
    }>
  ).map((r) => ({ handle: r.handle, fingerprint: fromBlob(r.fingerprint) }));
}

export function removeOutgoingRecipient(
  userId: number,
  networkId: number,
  channel: string,
  handle: string,
): void {
  removeRecipientStmt.run(userId, networkId, channel, handle);
}

export function deleteOutgoingRecipientsForHandle(
  userId: number,
  networkId: number,
  handle: string,
): number {
  return deleteRecipientsForHandleStmt.run(userId, networkId, handle).changes;
}
