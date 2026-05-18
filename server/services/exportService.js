// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

// Per-user data export. Streams a zip to a writable destination (typically
// the HTTP response). Driven entirely by EXPORT_TABLES — if a table is
// declared as exported there, it lands in the zip; if it's declared as
// skipped, it doesn't. The schema tripwire in exportSchema.test.js
// guarantees the registry covers every live table.

import { Readable } from 'stream';
import { ZipArchive } from 'archiver';
import db from '../db/index.js';
import { EXPORT_TABLES, EXPORT_FORMAT_VERSION } from '../db/exportSchema.js';

// SQL fragment that filters a table to a single user's rows. Returned as
// `{ where, params }` so callers can splice it into a SELECT.
function scopeFilter(scope, userId) {
  switch (scope) {
    case 'identity':
      return { where: 'WHERE id = ?', params: [userId] };
    case 'user_id':
      return { where: 'WHERE user_id = ?', params: [userId] };
    case 'via_network':
      return {
        where: 'WHERE network_id IN (SELECT id FROM networks WHERE user_id = ?)',
        params: [userId],
      };
    case 'via_rules':
      return {
        where: 'WHERE rule_id IN (SELECT id FROM highlight_rules WHERE user_id = ?)',
        params: [userId],
      };
    default:
      throw new Error(`exportService: unknown scope "${scope}"`);
  }
}

function countRows(table, scope, userId) {
  const { where, params } = scopeFilter(scope, userId);
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params).n;
}

// Project a row into the shape that lands in the export. Strips BLOB columns
// (they get written to thumbnails/<id>.<ext> separately) and replaces them
// with a hasThumbnail flag so the importer knows to look for the file.
function projectRow(row, def) {
  const out = {};
  for (const col of def.columns) {
    if (def.blobColumns?.includes(col)) continue;
    out[col] = row[col];
  }
  if (def.blobColumns?.includes('thumbnail')) {
    out.hasThumbnail = row.thumbnail != null;
  }
  return out;
}

function* messagesNdjsonGenerator(userId, networkIdToCount) {
  const def = EXPORT_TABLES.messages;
  const { where, params } = scopeFilter(def.scope, userId);
  const cols = def.columns.join(', ');
  const cursor = db
    .prepare(`SELECT ${cols} FROM messages ${where} ORDER BY id ASC`)
    .iterate(...params);
  for (const row of cursor) {
    networkIdToCount.total += 1;
    yield JSON.stringify(projectRow(row, def)) + '\n';
  }
}

function selectAll(table, def, userId) {
  const { where, params } = scopeFilter(def.scope, userId);
  const cols = def.columns.join(', ');
  const order = def.pk ? `ORDER BY ${def.pk} ASC` : '';
  return db.prepare(`SELECT ${cols} FROM ${table} ${where} ${order}`).all(...params);
}

export function computeExportPreview(userId, { includeMessages = false } = {}) {
  const counts = {};
  for (const [table, def] of Object.entries(EXPORT_TABLES)) {
    if (def.mode !== 'export' && def.mode !== 'partial') continue;
    if (def.section === 'messages' && !includeMessages) {
      counts[table] = 0;
      continue;
    }
    if (def.section === 'bookmarks' && !includeMessages) {
      counts[table] = 0;
      continue;
    }
    counts[table] = countRows(table, def.scope, userId);
  }
  return counts;
}

function getSchemaVersion() {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get();
  return row ? parseInt(row.value, 10) || 0 : 0;
}

// Build the export zip and stream it to `destStream`. Resolves when the
// archive has been finalized (every byte is in destStream's buffer or
// further downstream). Rejects if archiver emits an error.
//
// The destination is typically the express `res` object; the caller is
// responsible for setting Content-Type and Content-Disposition before
// calling this. We don't set them here so the function is reusable from
// tests that pipe into a `PassThrough`.
export async function buildExportZip(userId, { includeMessages = false } = {}, destStream) {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const archiveDone = new Promise((resolve, reject) => {
    archive.on('error', reject);
    archive.on('warning', (err) => {
      // ENOENT warnings from archiver are non-fatal but we surface anything else.
      if (err.code !== 'ENOENT') reject(err);
    });
    destStream.on('error', reject);
    destStream.on('finish', resolve);
    destStream.on('close', resolve);
  });

  archive.pipe(destStream);

  const sections = ['data'];
  const counts = {};

  // ---- data.json: everything except messages, bookmarks. ----
  const data = {};
  for (const [table, def] of Object.entries(EXPORT_TABLES)) {
    if (def.mode !== 'export' && def.mode !== 'partial') continue;
    if (def.section && def.section !== 'data') continue;
    const rows = selectAll(table, def, userId);
    data[table] = rows.map((row) => projectRow(row, def));
    counts[table] = rows.length;

    // Thumbnails — emit each blob as a separate zip entry.
    if (def.blobColumns?.includes('thumbnail')) {
      for (const row of rows) {
        if (row.thumbnail != null) {
          archive.append(row.thumbnail, { name: `thumbnails/${row.id}.jpg` });
        }
      }
    }
  }

  // ---- messages.ndjson ----
  if (includeMessages) {
    sections.push('messages');
    const totalRef = { total: 0 };
    const messagesStream = Readable.from(messagesNdjsonGenerator(userId, totalRef), {
      encoding: 'utf8',
    });
    archive.append(messagesStream, { name: 'messages.ndjson' });
    // We populate counts.messages from the registry preview, since the
    // generator-based count is only known after the stream drains. The
    // preview path uses COUNT(*) which is cheap for any indexed selection.
    counts.messages = countRows('messages', EXPORT_TABLES.messages.scope, userId);

    // ---- bookmarks.json ----
    sections.push('bookmarks');
    const bookmarksDef = EXPORT_TABLES.user_bookmarks;
    const bookmarkRows = selectAll('user_bookmarks', bookmarksDef, userId)
      .map((row) => projectRow(row, bookmarksDef));
    archive.append(JSON.stringify(bookmarkRows, null, 2), { name: 'bookmarks.json' });
    counts.user_bookmarks = bookmarkRows.length;
  } else {
    counts.messages = 0;
    counts.user_bookmarks = 0;
  }

  archive.append(JSON.stringify(data, null, 2), { name: 'data.json' });

  // ---- manifest.json ----
  const manifest = {
    export_format_version: EXPORT_FORMAT_VERSION,
    db_schema_version: getSchemaVersion(),
    exported_at: new Date().toISOString(),
    source_user_id: userId,
    sections,
    counts,
  };
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  await archive.finalize();
  await archiveDone;
}

// The `.lurk` extension is just a renamed zip — yauzl reads it fine by
// content, not extension. The custom suffix sidesteps Safari's
// auto-unarchive-on-download behavior (which fires for application/zip)
// and labels the file as obviously a Lurker export.
export function buildExportFilename(username, { includeMessages = false } = {}) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safe = String(username || 'user').replace(/[^a-zA-Z0-9_-]/g, '_');
  const suffix = includeMessages ? '' : '-settings';
  return `lurker-export-${safe}-${date}${suffix}.lurk`;
}
