// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

// The schema tripwire. Asserts that every live table and column in the SQLite
// schema is declared in EXPORT_TABLES — either as exported (with a column
// list) or skipped (with a reason). Adding a new table or column without
// updating exportSchema.js fails this test, which keeps the per-user data
// export honest as the schema grows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db;
let EXPORT_TABLES;
let FTS_SHADOW_PREFIXES;
let listExportedTables;
let listSkippedTables;

beforeAll(async () => {
  db = (await import('./index.js')).default;
  ({ EXPORT_TABLES, FTS_SHADOW_PREFIXES, listExportedTables, listSkippedTables } =
    await import('./exportSchema.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function liveTables() {
  return db
    .prepare(`
      SELECT name FROM sqlite_master
       WHERE type IN ('table', 'view')
         AND name NOT LIKE 'sqlite_%'
    `)
    .all()
    .map((r) => r.name)
    .filter((name) => !FTS_SHADOW_PREFIXES.some((prefix) => name.startsWith(prefix)));
}

function liveColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

describe('exportSchema registry', () => {
  it('declares every live table', () => {
    const declared = new Set(Object.keys(EXPORT_TABLES));
    const live = liveTables();
    const missing = live.filter((t) => !declared.has(t));
    expect(missing, `tables present in the DB but missing from EXPORT_TABLES: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('does not declare phantom tables', () => {
    const live = new Set(liveTables());
    const phantoms = Object.keys(EXPORT_TABLES).filter((t) => !live.has(t));
    expect(phantoms, `tables declared in EXPORT_TABLES but absent from the DB: ${phantoms.join(', ')}`)
      .toEqual([]);
  });

  it('covers every column on every exported table', () => {
    const problems = [];
    for (const [table, def] of Object.entries(EXPORT_TABLES)) {
      if (def.mode !== 'export' && def.mode !== 'partial') continue;
      const cols = liveColumns(table);
      const exported = new Set(def.columns ?? []);
      const skipped = new Set(Object.keys(def.skippedColumns ?? {}));
      for (const col of cols) {
        if (!exported.has(col) && !skipped.has(col)) {
          problems.push(`${table}.${col} is not in columns or skippedColumns`);
        }
      }
      for (const col of def.columns ?? []) {
        if (!cols.includes(col)) {
          problems.push(`${table}.${col} declared in exportSchema but not present in DB`);
        }
      }
      for (const col of Object.keys(def.skippedColumns ?? {})) {
        if (!cols.includes(col)) {
          problems.push(`${table}.${col} listed in skippedColumns but not present in DB`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('requires a reason for every skipped table', () => {
    const problems = [];
    for (const [table, def] of Object.entries(EXPORT_TABLES)) {
      if (def.mode !== 'skip') continue;
      if (!def.reason || typeof def.reason !== 'string' || def.reason.trim() === '') {
        problems.push(`${table}: missing reason`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('requires a reason for every skipped column on a partial table', () => {
    const problems = [];
    for (const [table, def] of Object.entries(EXPORT_TABLES)) {
      if (def.mode !== 'partial') continue;
      for (const [col, reason] of Object.entries(def.skippedColumns ?? {})) {
        if (!reason || typeof reason !== 'string' || reason.trim() === '') {
          problems.push(`${table}.${col}: missing reason`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('uses recognized mode values', () => {
    const valid = new Set(['export', 'partial', 'skip']);
    const problems = [];
    for (const [table, def] of Object.entries(EXPORT_TABLES)) {
      if (!valid.has(def.mode)) problems.push(`${table}: unknown mode "${def.mode}"`);
    }
    expect(problems).toEqual([]);
  });

  it('only references exporter-known tables in fkRekey', () => {
    const exported = new Set([...listExportedTables(), 'users']);
    const problems = [];
    for (const [table, def] of Object.entries(EXPORT_TABLES)) {
      const fk = def.fkRekey || {};
      for (const [col, target] of Object.entries(fk)) {
        if (!exported.has(target)) {
          problems.push(`${table}.${col} → ${target} (not an exported table)`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('listExportedTables / listSkippedTables', () => {
  it('partitions the registry without overlap', () => {
    const exported = new Set(listExportedTables());
    const skipped = new Set(listSkippedTables());
    const overlap = [...exported].filter((t) => skipped.has(t));
    expect(overlap).toEqual([]);
    expect(exported.size + skipped.size).toBe(Object.keys(EXPORT_TABLES).length);
  });
});
