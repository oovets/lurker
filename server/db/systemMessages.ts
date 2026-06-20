// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

// Durable storage for the system buffer (issue #355). See the system_messages
// table comment in db/index.ts for the global-vs-per-user model. This module is
// the only writer/reader; the systemLog service layers the in-process
// EventEmitter fan-out on top of it.

// Count caps per scope. A global line is visible to everyone, so its ring is
// kept tighter than a user's own lifecycle log. Pruned after each insert so the
// table never grows unbounded on a long-lived cell.
const MAX_GLOBAL = 200;
const MAX_PER_USER = 500;

export interface SystemMessageRow {
  id: number;
  userId: number | null;
  ts: string;
  level: string;
  scope: string;
  source: string;
  text: string;
  fields: Record<string, unknown> | null;
}

export interface InsertParams {
  userId?: number | null;
  ts: string;
  level: string;
  scope: string;
  source: string;
  text: string;
  fields?: Record<string, unknown> | null;
}

const insertStmt = db.prepare(`
  INSERT INTO system_messages (user_id, ts, level, scope, source, text, fields)
  VALUES (@userId, @ts, @level, @scope, @source, @text, @fields)
`);

// Keep only the most recent N rows in a scope. NOT IN (recent N by id) deletes
// the tail; the partial index on (user_id, id) keeps both the subselect and the
// delete cheap.
const pruneGlobalStmt = db.prepare(`
  DELETE FROM system_messages
   WHERE user_id IS NULL
     AND id NOT IN (
       SELECT id FROM system_messages WHERE user_id IS NULL ORDER BY id DESC LIMIT ?
     )
`);

const prunePerUserStmt = db.prepare(`
  DELETE FROM system_messages
   WHERE user_id = ?
     AND id NOT IN (
       SELECT id FROM system_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?
     )
`);

// Global lines + this user's own lines, oldest-first, bounded to the combined
// cap so a fresh connect ships a sane snapshot. Selected DESC under the LIMIT
// (so we keep the newest) then re-sorted ASC for the client, which renders and
// merges by ascending id.
const recentStmt = db.prepare(`
  SELECT * FROM (
    SELECT id, user_id AS userId, ts, level, scope, source, text, fields
      FROM system_messages
     WHERE user_id IS NULL OR user_id = ?
     ORDER BY id DESC
     LIMIT ?
  ) ORDER BY id ASC
`);

// Count of "notable" system-buffer lines newer than afterId that are visible to
// this user (global + their own). Notable = admin/control-plane broadcasts or
// warnings/errors; routine lifecycle log lines (info/server) deliberately don't
// count, so ambient noise never marks the system buffer unread (#355). This is
// the classification rule behind the unread badge — keep it in sync with
// systemLineNotifies() in wsHub, which gates the live read-state refresh.
const countNotableNewerStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM system_messages
   WHERE id > ?
     AND (user_id IS NULL OR user_id = ?)
     AND (source IN ('admin', 'control-plane') OR level IN ('warn', 'error'))
`);

const dropUserStmt = db.prepare(`DELETE FROM system_messages WHERE user_id = ?`);

interface RawRow {
  id: number;
  userId: number | null;
  ts: string;
  level: string;
  scope: string;
  source: string;
  text: string;
  fields: string | null;
}

function hydrate(row: RawRow): SystemMessageRow {
  let fields: Record<string, unknown> | null = null;
  if (row.fields) {
    try {
      const parsed = JSON.parse(row.fields);
      if (parsed && typeof parsed === 'object') fields = parsed as Record<string, unknown>;
    } catch {
      // A malformed blob shouldn't sink the whole snapshot — drop it to null.
      fields = null;
    }
  }
  return { ...row, fields };
}

// Insert one line and return the persisted row (with its autoincrement id).
// Prunes the affected scope so the ring stays bounded.
export function insert(params: InsertParams): SystemMessageRow {
  const userId = params.userId == null ? null : Number(params.userId);
  const info = insertStmt.run({
    userId,
    ts: params.ts,
    level: params.level,
    scope: params.scope,
    source: params.source,
    text: params.text,
    fields: params.fields ? JSON.stringify(params.fields) : null,
  });
  const id = Number(info.lastInsertRowid);
  if (userId == null) {
    pruneGlobalStmt.run(MAX_GLOBAL);
  } else {
    prunePerUserStmt.run(userId, userId, MAX_PER_USER);
  }
  return {
    id,
    userId,
    ts: params.ts,
    level: params.level,
    scope: params.scope,
    source: params.source,
    text: params.text,
    fields: params.fields ?? null,
  };
}

// The global lines + this user's own lines, oldest-first. Shipped as the
// system-buffer snapshot on each WS (re)connect.
export function recent(userId: number): SystemMessageRow[] {
  const rows = recentStmt.all(Number(userId), MAX_GLOBAL + MAX_PER_USER) as RawRow[];
  return rows.map(hydrate);
}

// Notable (unread-worthy) lines newer than afterId for this user. Drives the
// system buffer's unread badge.
export function countNotableNewer(userId: number, afterId: number): number {
  const row = countNotableNewerStmt.get(Number(afterId) || 0, Number(userId)) as { n: number };
  return row.n;
}

// Keyset pagination over a user's visible system lines (global + own), mirroring
// db/messages.ts so the system buffer rides the same backlog/history delivery as
// network buffers instead of a bespoke snapshot path (#355). Ordered by id; the
// DESC-under-LIMIT forms return newest, then flip to oldest-first for the client.
const SYS_COLS = `id, user_id AS userId, ts, level, scope, source, text, fields`;
const listAfterStmt = db.prepare(
  `SELECT ${SYS_COLS} FROM system_messages
    WHERE (user_id IS NULL OR user_id = ?) AND id > ? ORDER BY id ASC LIMIT ?`,
);
const listBeforeStmt = db.prepare(
  `SELECT ${SYS_COLS} FROM system_messages
    WHERE (user_id IS NULL OR user_id = ?) AND id < ? ORDER BY id DESC LIMIT ?`,
);
const listLatestStmt = db.prepare(
  `SELECT ${SYS_COLS} FROM system_messages
    WHERE (user_id IS NULL OR user_id = ?) ORDER BY id DESC LIMIT ?`,
);
const anchorStmt = db.prepare(
  `SELECT ${SYS_COLS} FROM system_messages WHERE id = ? AND (user_id IS NULL OR user_id = ?)`,
);
const hasOlderStmt = db.prepare(
  `SELECT 1 FROM system_messages WHERE (user_id IS NULL OR user_id = ?) AND id < ? LIMIT 1`,
);
const hasNewerStmt = db.prepare(
  `SELECT 1 FROM system_messages WHERE (user_id IS NULL OR user_id = ?) AND id > ? LIMIT 1`,
);

export function listSystemMessages(
  userId: number,
  { before, afterId, limit = 50 }: { before?: number; afterId?: number; limit?: number } = {},
): SystemMessageRow[] {
  const uid = Number(userId);
  // `afterId != null` (not truthy): afterId 0 is a valid "everything after the
  // start" cursor the history 'after' mode accepts — a truthy check would drop
  // it to the latest/before path and return the wrong slice.
  if (afterId != null) {
    return (listAfterStmt.all(uid, afterId, limit) as RawRow[]).map(hydrate);
  }
  const rows = (
    before ? listBeforeStmt.all(uid, before, limit) : listLatestStmt.all(uid, limit)
  ) as RawRow[];
  return rows.map(hydrate).reverse();
}

export function hasOlderSystem(userId: number, id: number): boolean {
  return !!hasOlderStmt.get(Number(userId), id);
}
export function hasNewerSystem(userId: number, id: number): boolean {
  return !!hasNewerStmt.get(Number(userId), id);
}

// Bounded context window around an arbitrary line id — the jump-to-message UX,
// mirroring db/messages.ts::listMessagesAround. The anchor lookup re-checks
// visibility so a caller can't lift another user's private line by id.
export function listSystemMessagesAround(
  userId: number,
  anchorId: number,
  halfLimit = 100,
):
  | { events: SystemMessageRow[]; hasMoreOlder: boolean; hasMoreNewer: boolean }
  | { events: []; hasMoreOlder: false; hasMoreNewer: false; anchorMissing: true } {
  const uid = Number(userId);
  const anchor = anchorStmt.get(anchorId, uid) as RawRow | undefined;
  if (!anchor) return { events: [], hasMoreOlder: false, hasMoreNewer: false, anchorMissing: true };
  const older = listSystemMessages(uid, { before: anchorId, limit: halfLimit });
  const newer = listSystemMessages(uid, { afterId: anchorId, limit: halfLimit });
  const events = [...older, hydrate(anchor), ...newer];
  return {
    events,
    hasMoreOlder: hasOlderSystem(uid, events[0].id),
    hasMoreNewer: hasNewerSystem(uid, events[events.length - 1].id),
  };
}

// Forget a user's personal lines. The users FK cascades on actual account
// deletion; this is the explicit path the service calls so a re-signup under a
// recycled id never inherits stale history.
export function dropUser(userId: number): void {
  dropUserStmt.run(Number(userId));
}

export default {
  insert,
  recent,
  countNotableNewer,
  dropUser,
  listSystemMessages,
  listSystemMessagesAround,
  hasOlderSystem,
  hasNewerSystem,
};
