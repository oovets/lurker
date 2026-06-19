// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

export type IgnorePatternKind = 'substr' | 'full' | 'regex';

// A single ignore rule (issue #301), irssi-style. Every dimension is optional
// and AND-ed by the matcher: mask (who), channels (where), pattern (what text),
// levels (which event types, incl. the special NOHIGHLIGHT). is_except inverts it
// into a whitelist entry; expires_at auto-removes it.
export interface IgnoreRuleRow {
  id: number;
  mask: string | null;
  channels: string[] | null;
  pattern: string | null;
  patternKind: IgnorePatternKind;
  levels: string[];
  isExcept: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface IgnoreRuleRowWithNetwork extends IgnoreRuleRow {
  // null = a global rule (applies on every network); a number scopes it to one.
  networkId: number | null;
}

/** Fields needed to create a rule (id/createdAt are assigned by the DB). */
export interface IgnoreRuleInput {
  mask: string | null;
  channels: string[] | null;
  pattern: string | null;
  patternKind: IgnorePatternKind;
  levels: string[];
  isExcept: boolean;
  expiresAt: string | null;
}

const addStmt = db.prepare(`
  INSERT INTO ignored_masks
    (user_id, network_id, mask, channels, pattern, pattern_kind, levels, is_except, expires_at)
  VALUES
    (@userId, @networkId, @mask, @channels, @pattern, @patternKind, @levels, @isExcept, @expiresAt)
`);

// Dedupe lookup: an identical rule (every dimension EXCEPT expiry) already
// exists. mask folds NOCASE like the column; levels compare as exact CSV, so the
// service must canonicalize level order before calling. Expiry is excluded on
// purpose — a re-add with a new -time should refresh the lifetime of the same
// logical rule, not spawn a near-duplicate row (every timed add differs by ms).
const findIdenticalStmt = db.prepare(`
  SELECT id, expires_at AS expiresAt FROM ignored_masks
  WHERE user_id = @userId AND network_id IS @networkId
    AND IFNULL(mask, '') = IFNULL(@mask, '') COLLATE NOCASE
    AND IFNULL(channels, '') = IFNULL(@channels, '')
    AND IFNULL(pattern, '') = IFNULL(@pattern, '')
    AND pattern_kind = @patternKind
    AND levels = @levels
    AND is_except = @isExcept
  LIMIT 1
`);

const updateExpiryStmt = db.prepare(`
  UPDATE ignored_masks SET expires_at = @expiresAt WHERE id = @id
`);

// id is a globally-unique PK, so user_id alone is the ownership guard — no need
// to also match network_id (which would have to special-case NULL for globals).
const removeByIdStmt = db.prepare(`
  DELETE FROM ignored_masks
  WHERE user_id = @userId AND id = @id
`);

// Remove every rule matching the mask within the scope the caller can see: the
// global rules plus the current network's. @networkId NULL collapses this to
// globals only. IS handles the NULL compare that `=` can't.
const removeByMaskStmt = db.prepare(`
  DELETE FROM ignored_masks
  WHERE user_id = @userId AND mask = @mask COLLATE NOCASE
    AND (network_id IS NULL OR network_id IS @networkId)
`);

const COLS = `id, mask, channels, pattern, pattern_kind AS patternKind, levels,
              is_except AS isExcept, expires_at AS expiresAt, created_at AS createdAt`;

const listForNetworkStmt = db.prepare(`
  SELECT ${COLS}
  FROM ignored_masks
  WHERE user_id = ? AND network_id = ?
  ORDER BY id ASC
`);

// Global rules only (network_id NULL) — the client's global bucket.
const listGlobalStmt = db.prepare(`
  SELECT ${COLS}
  FROM ignored_masks
  WHERE user_id = ? AND network_id IS NULL
  ORDER BY id ASC
`);

// The effective set for one network: its own rules unioned with the globals.
// This is what the matcher compiles on the insert hot path.
const listForScopeStmt = db.prepare(`
  SELECT ${COLS}
  FROM ignored_masks
  WHERE user_id = ? AND (network_id IS NULL OR network_id = ?)
  ORDER BY id ASC
`);

const listAllStmt = db.prepare(`
  SELECT network_id AS networkId, ${COLS}
  FROM ignored_masks
  WHERE user_id = ?
  ORDER BY network_id ASC, id ASC
`);

// expires_at is stored as an ISO-8601 string (`...THH:MM:SS.sssZ`), which won't
// compare lexicographically against datetime('now') (`YYYY-MM-DD HH:MM:SS`).
// datetime() normalizes both sides to the same UTC format for a correct compare.
const listExpiredStmt = db.prepare(`
  SELECT DISTINCT user_id AS userId, network_id AS networkId
  FROM ignored_masks
  WHERE expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')
`);

const deleteExpiredStmt = db.prepare(`
  DELETE FROM ignored_masks
  WHERE expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')
`);

interface RawRuleRow {
  id: number;
  networkId?: number | null;
  mask: string | null;
  channels: string | null;
  pattern: string | null;
  patternKind: string;
  levels: string;
  isExcept: number;
  expiresAt: string | null;
  createdAt: string;
}

function parseList(csv: string | null): string[] {
  if (!csv) return [];
  return csv.split(',').filter(Boolean);
}

function serializeList(list: string[] | null | undefined): string | null {
  if (!list || list.length === 0) return null;
  return list.join(',');
}

function rowToRule(row: RawRuleRow): IgnoreRuleRow {
  return {
    id: row.id,
    mask: row.mask,
    channels: row.channels ? parseList(row.channels) : null,
    pattern: row.pattern,
    patternKind: row.patternKind as IgnorePatternKind,
    levels: parseList(row.levels),
    isExcept: !!row.isExcept,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

function toParams(userId: number, networkId: number | null, rule: IgnoreRuleInput) {
  return {
    userId,
    networkId,
    mask: rule.mask,
    channels: serializeList(rule.channels),
    pattern: rule.pattern,
    patternKind: rule.patternKind,
    levels: rule.levels.join(','),
    isExcept: rule.isExcept ? 1 : 0,
    expiresAt: rule.expiresAt,
  };
}

// Insert a rule, or — if an identical one (ignoring expiry) exists — refresh its
// expiry to the new value and return its id with created:false. Refreshing means
// a re-add with a different -time extends/clears the lifetime in place rather
// than leaving a stale expiry or duplicating the rule.
export function addRule({
  userId,
  networkId,
  rule,
}: {
  userId: number;
  networkId: number | null;
  rule: IgnoreRuleInput;
}): { id: number; created: boolean } {
  const params = toParams(userId, networkId, rule);
  const existing = findIdenticalStmt.get(params) as
    | { id: number; expiresAt: string | null }
    | undefined;
  if (existing) {
    if (existing.expiresAt !== params.expiresAt) {
      updateExpiryStmt.run({ id: existing.id, expiresAt: params.expiresAt });
    }
    return { id: existing.id, created: false };
  }
  const result = addStmt.run(params);
  return { id: Number(result.lastInsertRowid), created: true };
}

export function removeRuleById({ userId, id }: { userId: number; id: number }): boolean {
  return removeByIdStmt.run({ userId, id }).changes > 0;
}

/**
 * Remove every rule whose mask matches (case-insensitively) within the visible
 * scope: globals plus the given network (networkId null = globals only). Returns
 * the count.
 */
export function removeRuleByMask({
  userId,
  networkId,
  mask,
}: {
  userId: number;
  networkId: number | null;
  mask: string;
}): number {
  return removeByMaskStmt.run({ userId, networkId, mask }).changes;
}

/** A single network's own rules (network-scoped only, excludes globals). */
export function listRules({
  userId,
  networkId,
}: {
  userId: number;
  networkId: number;
}): IgnoreRuleRow[] {
  return (listForNetworkStmt.all(userId, networkId) as RawRuleRow[]).map(rowToRule);
}

/** The user's global rules (network_id NULL). */
export function listGlobalRules(userId: number): IgnoreRuleRow[] {
  return (listGlobalStmt.all(userId) as RawRuleRow[]).map(rowToRule);
}

/** Effective set for a network: globals ∪ that network's rules (matcher input). */
export function listScopedRules({
  userId,
  networkId,
}: {
  userId: number;
  networkId: number;
}): IgnoreRuleRow[] {
  return (listForScopeStmt.all(userId, networkId) as RawRuleRow[]).map(rowToRule);
}

export function listAllRulesForUser(userId: number): IgnoreRuleRowWithNetwork[] {
  return (listAllStmt.all(userId) as RawRuleRow[]).map((r) => ({
    ...rowToRule(r),
    networkId: r.networkId ?? null,
  }));
}

// Delete every lapsed rule and report the (user, network) pairs touched so the
// caller can invalidate compiled caches and fan out updated lists.
const sweep = db.transaction((): { userId: number; networkId: number | null }[] => {
  const affected = listExpiredStmt.all() as { userId: number; networkId: number | null }[];
  if (affected.length) deleteExpiredStmt.run();
  return affected;
});

export function sweepExpired(): { userId: number; networkId: number | null }[] {
  return sweep();
}
