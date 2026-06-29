// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// GET /api/link-preview?url=… — server-side unfurl for the chat UI. Authed (a
// logged-in user's own session) and provider-agnostic: the client calls it for
// any http(s) link it renders, lazily as links scroll into view. Returns
// { preview: {...} | null }.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { fetchLinkPreview } from '../services/linkPreview.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req: Request, res: Response) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url) {
    res.status(400).json({ error: 'url required' });
    return;
  }
  const preview = await fetchLinkPreview(url).catch(() => null);
  // Cache successful unfurls at the edge/browser; they rarely change.
  if (preview) res.setHeader('Cache-Control', 'private, max-age=21600');
  res.json({ preview });
});

export default router;
