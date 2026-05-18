// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

// Per-user data export/import endpoints. Lets a user download a zip
// containing all of their data, and restore it on a fresh account on a
// different Lurker instance. See server/db/exportSchema.js for the
// per-table contract that drives both directions.

import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import {
  buildExportZip,
  buildExportFilename,
  computeExportPreview,
} from '../services/exportService.js';
import {
  importFromZipBuffer,
  ImportError,
} from '../services/importService.js';

const router = Router();
router.use(requireAuth);

// Cap import zip size. 500 MB is generous for "a single user's logs"; if a
// user trips this we want to see the report rather than silently accept
// something unbounded. Streaming import is a follow-up; for now multer
// buffers the whole zip in memory.
const HARD_IMPORT_LIMIT = 500 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: HARD_IMPORT_LIMIT, files: 1 },
});

// GET /api/exports/preview — return row counts for both flavors so the
// client can show what's about to be downloaded.
router.get('/preview', (req, res, next) => {
  try {
    const settingsOnly = computeExportPreview(req.user.id, { includeMessages: false });
    const withMessages = computeExportPreview(req.user.id, { includeMessages: true });
    res.json({
      settingsOnly,
      withMessages,
      username: req.user.username,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/exports?include_messages=1 — stream the zip to the response.
router.get('/', async (req, res, next) => {
  const includeMessages = String(req.query.include_messages || '').toLowerCase() === '1' ||
    String(req.query.include_messages || '').toLowerCase() === 'true';
  const filename = buildExportFilename(req.user.username, { includeMessages });
  // octet-stream (not application/zip) so Safari's "open safe files after
  // downloading" preference doesn't auto-unarchive the .lurk file.
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  try {
    await buildExportZip(req.user.id, { includeMessages }, res);
  } catch (err) {
    // Headers are already out — best we can do is close the connection.
    // The downstream will see a truncated zip and surface it as a corrupt
    // download. Logging makes it diagnosable server-side.
    console.error('[lurker] export failed:', err);
    if (!res.headersSent) return next(err);
    res.destroy();
  }
});

const importRouter = Router();
importRouter.use(requireAuth);

// POST /api/imports — upload an export zip and restore it into the
// caller's account. Refuses if the account already has data.
importRouter.post('/', upload.single('archive'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no archive uploaded' });
    const result = await importFromZipBuffer(req.user.id, req.file.buffer);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ImportError) {
      const status =
        err.code === 'account_not_empty' ? 409 :
        err.code === 'format_too_new'    ? 400 :
        err.code === 'not_a_zip'         ? 400 :
        err.code === 'missing_manifest'  ? 400 :
        err.code === 'missing_data'      ? 400 :
        err.code === 'bad_manifest'      ? 400 :
        err.code === 'bad_data'          ? 400 :
        err.code === 'bad_messages'      ? 400 :
        err.code === 'bad_bookmarks'     ? 400 :
        500;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

export { router as exportsRouter, importRouter };
