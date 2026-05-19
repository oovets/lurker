// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

// Alt parity is computed inline against the buffer's most recent striped row.
// Better-sqlite3 is synchronous and the IRC pipeline is single-threaded, so
// the subselect-then-insert can't observe a torn write — no transaction needed.
// Non-striped types pass through with alt=0; the value is meaningless for them
// and the client never reads it.
const insertStmt = db.prepare(`
  INSERT INTO messages (network_id, target, time, type, nick, text, kind, self, extra, matched_rule_id, userhost, alt)
  VALUES (
    @networkId, @target, @time, @type, @nick, @text, @kind, @self, @extra, @matchedRuleId, @userhost,
    CASE WHEN @type IN ('message', 'action', 'notice')
         THEN 1 - COALESCE(
           (SELECT alt FROM messages
             WHERE network_id = @networkId AND target = @target
               AND type IN ('message', 'action', 'notice')
             ORDER BY id DESC LIMIT 1),
           1)
         ELSE 0
    END
  )
`);

const altByIdStmt = db.prepare(`SELECT alt FROM messages WHERE id = ?`);

export function insertMessage(row) {
  const result = insertStmt.run({
    networkId: row.networkId,
    target: row.target,
    time: row.time,
    type: row.type,
    nick: row.nick ?? null,
    text: row.text ?? null,
    kind: row.kind ?? null,
    self: row.self ? 1 : 0,
    extra: row.extra ? JSON.stringify(row.extra) : null,
    matchedRuleId: row.matchedRuleId ?? null,
    userhost: row.userhost ?? null,
  });
  const id = result.lastInsertRowid;
  const altRow = altByIdStmt.get(id);
  return { id, alt: altRow?.alt === 1 };
}

function rowToEvent(row) {
  const event = {
    id: row.id,
    networkId: row.network_id,
    target: row.target,
    time: row.time,
    type: row.type,
    nick: row.nick,
    text: row.text,
    kind: row.kind,
    self: !!row.self,
    userhost: row.userhost ?? null,
    alt: row.alt === 1,
    matched: row.matched_rule_id != null,
    matchedRuleId: row.matched_rule_id,
  };
  if (row.extra) {
    try {
      Object.assign(event, JSON.parse(row.extra));
    } catch (_) { /* ignore malformed */ }
  }
  return event;
}

// `before` paginates backward (returns up to `limit` events with id < before).
// `afterId` does the opposite — used by the WS resume path to ship only the
// gap an existing client missed, instead of re-sending its last 50 known rows.
// Results are always returned oldest-first regardless of which path was taken.
export function listMessages(networkId, target, { before, afterId, limit = 50 } = {}) {
  if (afterId) {
    const rows = db.prepare(
      `SELECT * FROM messages WHERE network_id = ? AND target = ? AND id > ?
       ORDER BY id ASC LIMIT ?`
    ).all(networkId, target, afterId, limit);
    return rows.map(rowToEvent);
  }
  const sql = before
    ? `SELECT * FROM messages WHERE network_id = ? AND target = ? AND id < ? ORDER BY id DESC LIMIT ?`
    : `SELECT * FROM messages WHERE network_id = ? AND target = ? ORDER BY id DESC LIMIT ?`;
  const params = before ? [networkId, target, before, limit] : [networkId, target, limit];
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToEvent).reverse();
}

// Bounded context window around an arbitrary message id. Used by the
// jump-to-message UX (search results, highlights) — loads halfLimit older rows
// + the anchor + halfLimit newer rows. The anchor lookup also enforces
// (networkId, target) so callers can't lift rows out of buffers they don't own
// just by knowing a message id. Returns oldest-first.
export function listMessagesAround(networkId, target, anchorId, halfLimit = 100) {
  const anchorRow = db.prepare(
    `SELECT * FROM messages WHERE id = ? AND network_id = ? AND target = ?`
  ).get(anchorId, networkId, target);
  if (!anchorRow) {
    return { events: [], hasMoreOlder: false, hasMoreNewer: false, anchorMissing: true };
  }
  const older = listMessages(networkId, target, { before: anchorId, limit: halfLimit });
  const newer = listMessages(networkId, target, { afterId: anchorId, limit: halfLimit });
  const events = [...older, rowToEvent(anchorRow), ...newer];
  const oldestId = events[0].id;
  const newestId = events[events.length - 1].id;
  return {
    events,
    hasMoreOlder: hasOlderThan(networkId, target, oldestId),
    hasMoreNewer: hasNewerThan(networkId, target, newestId),
  };
}

// Cheap edge-exists probes for the around/before/after handlers. Using a
// LIMIT 1 EXISTS-shaped query (rather than COUNT(*)) keeps this O(index seek)
// regardless of how much history is in the buffer.
function hasOlderThan(networkId, target, id) {
  return !!db.prepare(
    `SELECT 1 FROM messages WHERE network_id = ? AND target = ? AND id < ? LIMIT 1`
  ).get(networkId, target, id);
}

function hasNewerThan(networkId, target, id) {
  return !!db.prepare(
    `SELECT 1 FROM messages WHERE network_id = ? AND target = ? AND id > ? LIMIT 1`
  ).get(networkId, target, id);
}

// Public wrappers so wsHub can compute hasMoreOlder/Newer for the 'before',
// 'after', and 'latest' modes without re-declaring the SQL there.
export function hasOlderRow(networkId, target, id) {
  return hasOlderThan(networkId, target, id);
}
export function hasNewerRow(networkId, target, id) {
  return hasNewerThan(networkId, target, id);
}

export function listRecentForBuffers(networkId, targets, perBuffer = 50) {
  const out = {};
  for (const t of targets) {
    out[t] = listMessages(networkId, t, { limit: perBuffer });
  }
  return out;
}

export function listBufferTargets(networkId) {
  return db
    .prepare('SELECT DISTINCT target FROM messages WHERE network_id = ? ORDER BY target')
    .all(networkId)
    .map((r) => r.target);
}

// Per-(network, target) summary for the MCP list_buffers verb. Aggregates
// every target that has at least one message, with the freshest message
// timestamp. Pseudo-buffers (':server:*') are filtered at the SQL layer so
// they never leak into the agent-facing surface; clients reach them via the
// snapshot only.
export function listBuffersForNetwork(networkId) {
  return db
    .prepare(
      `SELECT target, MAX(time) AS lastMessageAt
         FROM messages
        WHERE network_id = ?
          AND target NOT LIKE ':server:%'
        GROUP BY target
        ORDER BY lastMessageAt DESC`
    )
    .all(networkId);
}

// (target, max_id) per buffer in this network. Used by /mark-all-read so the
// server can clamp every buffer's read pointer to its tail in one pass.
export function maxIdByBuffer(networkId) {
  return db
    .prepare('SELECT target, MAX(id) AS maxId FROM messages WHERE network_id = ? GROUP BY target')
    .all(networkId);
}

// Cheap "does the user have any history with this target?" check used by the
// no_such_nick router: only route a DM-shaped error into a per-nick buffer if
// the user has actually conversed with that nick. Stops typo /whois replies
// from spawning empty DM buffers.
export function hasMessageForTarget(networkId, target) {
  if (!networkId || !target) return false;
  const row = db
    .prepare('SELECT 1 FROM messages WHERE network_id = ? AND target = ? COLLATE NOCASE LIMIT 1')
    .get(networkId, target);
  return !!row;
}

export function countOlder(networkId, target, beforeId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE network_id = ? AND target = ? AND id < ?`
  ).get(networkId, target, beforeId).n;
}

// Types that count as "real content" for the unread badge. Membership churn
// (join/part/quit/kick/nick/mode/topic), MOTD, away markers, and server
// errors are all persisted for the buffer log but shouldn't bump the badge —
// the live unread path in useSocket.applyEvent uses the same allowlist, and
// we need the SQL paths to match so backlog/read-state recomputes don't snap
// the count to an inflated number.
export const COUNTABLE_TYPES = new Set(['message', 'action', 'notice']);
const COUNTABLE_TYPES_SQL = `('${[...COUNTABLE_TYPES].join("','")}')`;

export function countNewer(networkId, target, afterId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM messages
     WHERE network_id = ? AND target = ? AND id > ?
       AND type IN ${COUNTABLE_TYPES_SQL}`
  ).get(networkId, target, afterId || 0).n;
}

// Cheap indexed count of unread highlights since `afterId`. Uses the partial
// idx_messages_matched index — the old scan+decorate approach was replaced
// once match state moved to insert time.
export function countHighlightsNewer(networkId, target, afterId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM messages
     WHERE network_id = ? AND target = ? AND id > ?
       AND matched_rule_id IS NOT NULL`
  ).get(networkId, target, afterId || 0).n;
}

// Highlight history feed for the /api/highlights endpoint. Scoped to a single
// user via the networks join. Cursor pagination via `before` (a message id);
// returns rows ordered newest-first.
export function listUserHighlights(userId, { before, limit = 50 } = {}) {
  const sql = before
    ? `SELECT m.*, n.name AS network_name
       FROM messages m
       JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = ?
         AND m.matched_rule_id IS NOT NULL
         AND m.id < ?
       ORDER BY m.id DESC
       LIMIT ?`
    : `SELECT m.*, n.name AS network_name
       FROM messages m
       JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = ?
         AND m.matched_rule_id IS NOT NULL
       ORDER BY m.id DESC
       LIMIT ?`;
  const params = before ? [userId, before, limit] : [userId, limit];
  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => ({
    ...rowToEvent(row),
    networkName: row.network_name,
  }));
}

// Turn a free-text query into an FTS5 MATCH string. Each whitespace-separated
// term is wrapped in double quotes (embedded quotes doubled to escape them),
// which neutralizes FTS5 operator characters in user input and ANDs the terms
// together implicitly.
function toFtsMatch(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

// Full-text search across the caller's message history. Free-text `query` runs
// against the messages_fts index; `networkId` / `target` / `nick` are
// structured filters (the inline from:/in:/on: search syntax). The networks
// join scopes every result to the caller's own networks — this is the
// access-control boundary, so a missing networkId means "all my networks", not
// "all networks". Cursor pagination via `before` (a message id); rows ordered
// newest-first, restricted to chat-shaped types.
export function searchMessages(userId, { query, networkId, target, nick, before, limit = 50 } = {}) {
  const text = typeof query === 'string' ? query.trim() : '';
  // Nothing to search on — no free text and no structured filter.
  if (!text && !networkId && !target && !nick) return [];

  let from = 'messages m JOIN networks n ON n.id = m.network_id';
  const where = ['n.user_id = ?', `m.type IN ${COUNTABLE_TYPES_SQL}`];
  const params = [userId];

  if (text) {
    const match = toFtsMatch(text);
    if (!match) return [];
    // FTS5's MATCH operator must reference the virtual table by its real name,
    // not an alias — `alias MATCH ?` parses `alias` as a column.
    from += ' JOIN messages_fts ON messages_fts.rowid = m.id';
    where.push('messages_fts MATCH ?');
    params.push(match);
  }
  if (networkId) { where.push('m.network_id = ?'); params.push(networkId); }
  if (target) { where.push('m.target = ? COLLATE NOCASE'); params.push(target); }
  if (nick) { where.push('m.nick = ? COLLATE NOCASE'); params.push(nick); }
  if (before) { where.push('m.id < ?'); params.push(before); }

  const sql = `SELECT m.*, n.name AS network_name
               FROM ${from}
               WHERE ${where.join(' AND ')}
               ORDER BY m.id DESC
               LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params).map((row) => ({
    ...rowToEvent(row),
    networkName: row.network_name,
  }));
}

const listSpeakersStmt = db.prepare(`
  SELECT nick, MAX(time) AS last_time
  FROM messages
  WHERE network_id = ?
    AND target = ?
    AND type IN ('message', 'action')
    AND self = 0
    AND nick IS NOT NULL
    AND nick <> ''
  GROUP BY LOWER(nick)
  ORDER BY last_time DESC
  LIMIT ?
`);

export function listSpeakers(networkId, target, limit = 128) {
  return listSpeakersStmt.all(networkId, target, limit)
    .map((r) => ({ nick: r.nick, lastTime: Date.parse(r.last_time) || 0 }))
    .filter((s) => s.lastTime > 0);
}
