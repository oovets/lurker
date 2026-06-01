// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { getUserSettings } from '../db/settings.js';
import { defaultsAsObject } from '../services/settingsRegistry.js';
import * as imagePipeline from '../services/imagePipeline.js';
import { getProvider, providerIds, secretsForProvider } from '../services/uploadProviders/index.js';
import {
  NODE_UPLOAD_PROVIDER_ID,
  nodeUploadSecrets,
  nodeUploadLimits,
} from '../services/uploadProviders/nodeUpload.js';
import type { UploadListRow } from '../db/uploadHistory.js';
import { insertUpload, listUploads, getThumbnail, deleteUpload } from '../db/uploadHistory.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { isNodeMode } from '../utils/edition.js';

const router = Router();
router.use(requireAuth);

// Resolve effective settings with registry defaults filled in. Reused across
// the size-cap middleware and the route handler so they always agree.
// Settings are untyped (JS module) — Record<string, unknown> is the best we can do.
function effectiveSettings(userId: number): Record<string, unknown> {
  return { ...defaultsAsObject(), ...getUserSettings(userId) };
}

// multer doesn't know about per-user settings until we look up the user, but
// it needs to be configured up-front. We use a generous hard ceiling (200 MB,
// the registry max) so multer never rejects below the per-user cap; the route
// handler enforces the actual per-user `uploads.image.max_upload_mb`.
const HARD_BYTE_CEILING = 200 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: HARD_BYTE_CEILING, files: 1 },
});

router.post(
  '/',
  upload.single('image'),
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'no file uploaded' });
        return;
      }

      const settings = effectiveSettings(req.user!.id);
      // The image-pipeline limits (size cap, max dimension, JPEG quality) are
      // operator-controlled in node edition — sourced from env, not the tenant's
      // settings, so a tenant can't lift their own cap or inflate storage. A3
      // hides the matching UI. Standalone keeps these as per-user settings.
      const limits = isNodeMode() ? nodeUploadLimits() : null;
      const maxMb = limits ? limits.maxMb : Number(settings['uploads.image.max_upload_mb']) || 25;
      if (req.file.size > maxMb * 1024 * 1024) {
        res.status(413).json({ error: `file exceeds ${maxMb} MB` });
        return;
      }

      // In node edition the operator forces the in-house uploader and supplies
      // its credentials from the environment — a tenant never picks a host or
      // sees the keys. Standalone honors the user's chosen provider as before.
      const providerId = isNodeMode()
        ? NODE_UPLOAD_PROVIDER_ID
        : String(settings['uploads.provider'] ?? '');
      const provider = getProvider(providerId);
      if (!provider) {
        res.status(400).json({ error: `unknown provider: ${providerId}` });
        return;
      }

      // Long-message → .txt upload bypasses the sharp pipeline. Providers
      // (x0.at, catbox, hoarder) are MIME-agnostic, so we hand the raw bytes
      // straight through with a .txt extension and no thumbnail.
      const isText = req.file.mimetype === 'text/plain';

      let outBuffer: Buffer;
      let outMime: string;
      let outExt: string;
      let outByteSize: number;
      let outWidth: number | null = null;
      let outHeight: number | null = null;
      let thumb: Buffer | null = null;

      if (isText) {
        outBuffer = req.file.buffer;
        outMime = 'text/plain';
        outExt = 'txt';
        outByteSize = req.file.size;
      } else {
        // imagePipeline is an untyped JS module — any is unavoidable here
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let optimized: any;
        try {
          optimized = await imagePipeline.optimize(req.file.buffer, {
            maxDim: limits
              ? limits.maxDim
              : Number(settings['uploads.image.max_dimension']) || 2048,
            quality: limits ? limits.quality : Number(settings['uploads.image.quality']) || 85,
          });
        } catch (err) {
          const e = err as { code?: string; message?: string };
          if (e.code === 'UNSUPPORTED_FORMAT') {
            res.status(415).json({ error: e.message });
            return;
          }
          throw err;
        }
        thumb = (await imagePipeline.thumbnail(req.file.buffer)) as Buffer | null;
        outBuffer = optimized.buffer as Buffer;
        outMime = optimized.mime as string;
        outExt = optimized.ext as string;
        outByteSize = optimized.byteSize as number;
        outWidth = optimized.width as number | null;
        outHeight = optimized.height as number | null;
      }

      const originalName = req.file.originalname || '';
      const baseName = originalName.replace(/\.[^.]+$/, '') || `upload-${Date.now()}`;
      const filename = `${baseName}.${outExt}`;

      const secrets: Record<string, string> = isNodeMode()
        ? nodeUploadSecrets()
        : secretsForProvider(providerId, settings as Record<string, string>);
      // provider.upload is from an untyped JS module
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;
      try {
        result = await provider.upload(
          outBuffer,
          {
            filename,
            mime: outMime,
          },
          secrets,
        );
      } catch (err) {
        const e = err as { code?: string; message?: string };
        const status = e.code === 'PROVIDER_AUTH' ? 401 : e.code === 'PROVIDER_CONFIG' ? 400 : 502;
        res.status(status).json({ error: e.message, provider: providerId });
        return;
      }

      const id = insertUpload(req.user!.id, {
        provider: providerId,
        url: result.url,
        filename: originalName || null,
        mime: outMime,
        byte_size: outByteSize,
        width: outWidth,
        height: outHeight,
        thumbnail: thumb,
      });

      res.json({ id, url: result.url });
    } catch (err) {
      next(err);
    }
  }),
);

router.get('/', (req: Request, res: Response) => {
  const before = req.query.before ? Number(req.query.before) : null;
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const rows: UploadListRow[] = listUploads(req.user!.id, { before, limit });
  res.json({
    items: rows.map((r) => {
      const { has_thumbnail, ...rest } = r;
      return has_thumbnail ? { ...rest, thumbnail_url: `/api/uploads/${r.id}/thumb` } : rest;
    }),
    providers: providerIds,
  });
});

router.get('/:id/thumb', (req: Request, res: Response) => {
  const row = getThumbnail(req.user!.id, Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(row.thumbnail);
});

router.delete('/:id', (req: Request, res: Response) => {
  const ok = deleteUpload(req.user!.id, Number(req.params.id));
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
