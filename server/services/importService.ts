// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-user data import. Reads a zip produced by exportService and replays it
// into the database under the *importing* user's id. Refuses to import into
// an account that already has data — keep the flow simple and predictable:
// fresh accounts only.
//
// The whole import runs inside a single db.transaction() so a malformed
// archive (or a row that violates a FK constraint) rolls back cleanly and
// leaves the user's account empty for a retry.

import yauzl from 'yauzl';
import type { Statement, RunResult } from 'better-sqlite3';
import db from '../db/index.js';
import { EXPORT_TABLES, EXPORT_FORMAT_VERSION, IMPORT_ORDER } from '../db/exportSchema.js';

interface ExportTableDefFull {
  mode: string;
  scope: string;
  columns: string[];
  section?: string;
  pk?: string;
  blobColumns?: string[];
  rekeyOnImport?: boolean;
  fkRekey?: Record<string, string>;
  // FK columns that should be set to NULL — rather than causing the whole
  // row to be dropped — when their referenced id is missing from the map.
  // Used for nullable foreign keys whose absence is recoverable (e.g. a
  // /clear marker whose boundary message is gone; the rest of the
  // buffer_reads row, including the read pointer, is still valid).
  fkRekeyNullable?: string[];
}

export class ImportError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function readZipToMap(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(new ImportError('not_a_zip', 'file is not a valid zip archive'));
      const out = new Map<string, Buffer>();
      zip.readEntry();
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e2, stream) => {
          if (e2) return reject(e2);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', () => resolve(out));
    });
  });
}

// "Empty" means the user hasn't set up IRC on this instance yet. We
// deliberately don't check user_settings because the client auto-syncs
// system.timezone on every bootstrap, so a fresh account always has at
// least one row there. user_settings inserts use INSERT OR REPLACE so the
// imported timezone wins. Networks is the meaningful signal — if the user
// has zero networks they haven't started using the app yet.
function accountIsEmpty(userId: number): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM networks WHERE user_id = ?').get(userId) as {
    n: number;
  };
  return row.n === 0;
}

// Build a positional INSERT for the columns we actually have. Always skips
// an autoincrement PK so the target DB assigns a fresh id (rekeyOnImport
// controls whether we *track* the old→new mapping for FKs, not whether we
// reuse the old id).
function buildInsertStatement(
  table: string,
  def: ExportTableDefFull,
): { stmt: Statement; cols: string[] } {
  const skipCols = new Set<string>();
  if (def.pk) skipCols.add(def.pk);
  // upload_history's thumbnail is written separately from the thumbnails/ entries.
  if (def.blobColumns) for (const c of def.blobColumns) skipCols.add(c);

  const cols = def.columns.filter((c) => !skipCols.has(c));
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  return { stmt: db.prepare(sql), cols };
}

function rekeyRow(
  row: Record<string, unknown>,
  def: ExportTableDefFull,
  idMaps: Record<string, Map<unknown, unknown>>,
  targetUserId: number,
): Record<string, unknown> {
  const out = { ...row };
  if (!def.fkRekey) return out;
  const nullable = new Set(def.fkRekeyNullable ?? []);
  for (const [col, target] of Object.entries(def.fkRekey)) {
    if (out[col] == null) continue;
    if (target === 'users') {
      out[col] = targetUserId;
    } else {
      // An absent map means the referenced table wasn't imported (e.g. a
      // settings-only archive has no messages map, so buffer_reads rows
      // can't find their last_read_message_id). Treat the same as a row
      // missing from a populated map: leave undefined, let the caller drop.
      // Columns flagged nullable map missing → null instead, so the rest
      // of the row (other FKs, scalar data) survives.
      const map = idMaps[target];
      const mapped = map ? map.get(out[col]) : undefined;
      if (mapped === undefined) {
        out[col] = nullable.has(col) ? null : undefined;
      } else {
        out[col] = mapped;
      }
    }
  }
  return out;
}

function insertOne(stmt: Statement, cols: string[], row: Record<string, unknown>): RunResult {
  const args = cols.map((c) => (c in row ? row[c] : null));
  return stmt.run(...args);
}

function dependsOnMessages(def: ExportTableDefFull): boolean {
  return !!(def.fkRekey && Object.values(def.fkRekey).includes('messages'));
}

export async function importFromZipBuffer(
  targetUserId: number,
  zipBuffer: Buffer,
): Promise<{
  manifest: Record<string, unknown>;
  counts: Record<string, number>;
  thumbnailsAttached: number;
}> {
  const entries = await readZipToMap(zipBuffer);

  // ---- manifest ----
  if (!entries.has('manifest.json')) {
    throw new ImportError('missing_manifest', 'archive does not contain manifest.json');
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch (_) {
    throw new ImportError('bad_manifest', 'manifest.json is not valid JSON');
  }
  if (typeof manifest.export_format_version !== 'number') {
    throw new ImportError('bad_manifest', 'manifest is missing export_format_version');
  }
  if (manifest.export_format_version > EXPORT_FORMAT_VERSION) {
    throw new ImportError(
      'format_too_new',
      `archive uses export_format_version ${manifest.export_format_version}; this server understands up to ${EXPORT_FORMAT_VERSION}`,
    );
  }

  // ---- data.json ----
  if (!entries.has('data.json')) {
    throw new ImportError('missing_data', 'archive does not contain data.json');
  }
  let data: Record<string, Record<string, unknown>[]>;
  try {
    data = JSON.parse(entries.get('data.json')!.toString('utf8')) as Record<
      string,
      Record<string, unknown>[]
    >;
  } catch (_) {
    throw new ImportError('bad_data', 'data.json is not valid JSON');
  }

  // ---- empty-account guard ----
  if (!accountIsEmpty(targetUserId)) {
    throw new ImportError(
      'account_not_empty',
      'target account already has data; imports require a fresh account',
    );
  }

  const counts: Record<string, number> = {};
  const insertedThumbs: number[] = [];

  // Run the whole import in one transaction.
  const tx = db.transaction(() => {
    const idMaps: Record<string, Map<unknown, unknown>> = {};

    // The client auto-syncs system.timezone on every bootstrap, so a fresh
    // account usually has 1+ rows in user_settings already. Wipe before we
    // insert the imported settings — the import replaces, doesn't merge.
    db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(targetUserId);

    function insertTable(table: string): void {
      const def = EXPORT_TABLES[table as keyof typeof EXPORT_TABLES] as ExportTableDefFull;
      const rows = data[table] || [];
      const { stmt, cols } = buildInsertStatement(table, def);

      let inserted = 0;
      for (const original of rows) {
        const row = rekeyRow(original, def, idMaps, targetUserId);

        // If any required FK ended up undefined (referenced row wasn't in the
        // export), drop the row.
        let drop = false;
        if (def.fkRekey) {
          for (const col of Object.keys(def.fkRekey)) {
            if (row[col] === undefined) {
              drop = true;
              break;
            }
          }
        }
        if (drop) continue;

        const result = insertOne(stmt, cols, row);

        if (def.rekeyOnImport && def.pk) {
          idMaps[table] ??= new Map();
          idMaps[table].set(original[def.pk], result.lastInsertRowid);
        }
        inserted += 1;
      }
      counts[table] = inserted;
    }

    // First pass: data.json tables that don't depend on messages.
    for (const table of IMPORT_ORDER) {
      const def = EXPORT_TABLES[table as keyof typeof EXPORT_TABLES] as
        | ExportTableDefFull
        | undefined;
      if (!def || def.mode === 'skip') continue;
      if (def.section === 'messages' || def.section === 'bookmarks') continue;
      if (dependsOnMessages(def)) continue;
      insertTable(table);
    }

    // ---- messages.ndjson ----
    if (entries.has('messages.ndjson')) {
      const def = EXPORT_TABLES.messages as ExportTableDefFull;
      const { stmt, cols } = buildInsertStatement('messages', def);
      idMaps.messages = new Map();
      const lines = entries
        .get('messages.ndjson')!
        .toString('utf8')
        .split('\n')
        .filter((l) => l.length > 0);
      let inserted = 0;
      for (const line of lines) {
        let original: Record<string, unknown>;
        try {
          original = JSON.parse(line) as Record<string, unknown>;
        } catch (_) {
          throw new ImportError('bad_messages', 'messages.ndjson contains a non-JSON line');
        }
        const row = rekeyRow(original, def, idMaps, targetUserId);
        // network_id is required; if it didn't map, drop the row.
        if (row.network_id === undefined) continue;
        // matched_rule_id is nullable; if its target rule wasn't in the
        // export, fall back to null.
        if (row.matched_rule_id === undefined) row.matched_rule_id = null;
        // from_ignored was added later; older archives don't carry it, and
        // the column is NOT NULL so a missing key would fail the insert.
        if (row.from_ignored === undefined) row.from_ignored = 0;
        const result = insertOne(stmt, cols, row);
        idMaps.messages.set(original.id, result.lastInsertRowid);
        inserted += 1;
      }
      counts.messages = inserted;
    } else {
      counts.messages = 0;
    }

    // ---- bookmarks.json ----
    if (entries.has('bookmarks.json')) {
      const def = EXPORT_TABLES.user_bookmarks as ExportTableDefFull;
      const { stmt, cols } = buildInsertStatement('user_bookmarks', def);
      let bookmarks: Record<string, unknown>[];
      try {
        bookmarks = JSON.parse(entries.get('bookmarks.json')!.toString('utf8')) as Record<
          string,
          unknown
        >[];
      } catch (_) {
        throw new ImportError('bad_bookmarks', 'bookmarks.json is not valid JSON');
      }
      let inserted = 0;
      for (const original of bookmarks) {
        const row = rekeyRow(original, def, idMaps, targetUserId);
        if (row.message_id === undefined) continue;
        insertOne(stmt, cols, row);
        inserted += 1;
      }
      counts.user_bookmarks = inserted;
    } else {
      counts.user_bookmarks = 0;
    }

    // Second pass: data.json tables that depend on the messages id map.
    // Rows whose last_read_message_id (etc.) didn't make it into the
    // export are dropped silently by the FK-undefined check.
    for (const table of IMPORT_ORDER) {
      const def = EXPORT_TABLES[table as keyof typeof EXPORT_TABLES] as
        | ExportTableDefFull
        | undefined;
      if (!def || def.mode === 'skip') continue;
      if (def.section === 'messages' || def.section === 'bookmarks') continue;
      if (!dependsOnMessages(def)) continue;
      insertTable(table);
    }

    // ---- thumbnails ----
    if (idMaps.upload_history) {
      const update = db.prepare('UPDATE upload_history SET thumbnail = ? WHERE id = ?');
      for (const [filename, buf] of entries) {
        const m = filename.match(/^thumbnails\/(\d+)\.jpg$/);
        if (!m) continue;
        const oldId = parseInt(m[1], 10);
        const newId = idMaps.upload_history.get(oldId);
        if (newId == null) continue;
        update.run(buf, newId);
        insertedThumbs.push(Number(newId));
      }
    }
  });

  try {
    tx();
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError('insert_failed', `import failed: ${(err as Error).message}`);
  }

  return { manifest, counts, thumbnailsAttached: insertedThumbs.length };
}
