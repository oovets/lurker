// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The public-facing Slack OAuth endpoints. `requireAuth` still gates every
// route: the consent round-trip is a top-level GET navigation, so the signed
// `lurker_session` cookie (SameSite=Lax) rides along and the callback runs as
// the logged-in user. Defense in depth, the signed `state` also carries the
// initiating user id and the callback rejects a mismatch.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth, blockWritesWhenPaused } from '../middleware/auth.js';
import { createNetwork } from '../db/networks.js';
import ircManager from '../services/ircManager.js';
import {
  slackOauthConfig,
  slackOauthConfigured,
  signState,
  verifyState,
  buildAuthorizeUrl,
  exchangeCode,
} from '../services/slackOauth.js';

const router = Router();
router.use(requireAuth);
router.use(blockWritesWhenPaused);

// Lets the client decide whether to show the "Add to Slack" button or fall back
// to manual token entry. Strictly a boolean — no secrets leave the server.
router.get('/oauth/config', (_req: Request, res: Response) => {
  res.json({ configured: slackOauthConfigured() });
});

// Kick off the flow: sign state (uid + chosen name) and 302 to Slack's consent
// screen. The client navigates the top-level window here.
router.get('/oauth/start', (req: Request, res: Response) => {
  const config = slackOauthConfig();
  if (!config) {
    res.status(503).json({ error: 'slack oauth not configured' });
    return;
  }
  const name = typeof req.query.name === 'string' ? req.query.name : '';
  const state = signState(req.user!.id, name, Date.now());
  res.redirect(buildAuthorizeUrl(config, state));
});

// Slack redirects the browser back here with `code` + our `state`. Exchange the
// code for a bot token, create the Slack network (pairing it with the shared
// app token), connect, and bounce back into the SPA.
router.get('/oauth/callback', async (req: Request, res: Response) => {
  const config = slackOauthConfig();
  if (!config) {
    res.status(503).send('Slack OAuth is not configured on this server.');
    return;
  }
  if (typeof req.query.error === 'string' && req.query.error) {
    res.redirect('/?slack=denied');
    return;
  }
  const parsed = verifyState(
    typeof req.query.state === 'string' ? req.query.state : '',
    Date.now(),
  );
  if (!parsed || parsed.uid !== req.user!.id) {
    res.status(400).send('Invalid or expired OAuth state. Please try connecting again.');
    return;
  }
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code) {
    res.status(400).send('Missing OAuth code.');
    return;
  }

  let result;
  try {
    result = await exchangeCode(code, config);
  } catch {
    res.status(502).send('Slack token exchange failed. Please try again.');
    return;
  }

  const network = createNetwork(req.user!.id, {
    name: parsed.name || result.teamName || 'Slack',
    host: 'slack',
    nick: 'me',
    autoconnect: true,
    provider: 'slack',
    slack_bot_token: result.botToken,
    slack_app_token: config.appToken,
  });
  if (!network) {
    res.status(500).send('Failed to create the Slack network.');
    return;
  }
  // The network row is created; connecting is best-effort. Guard the start so a
  // synchronous failure can't become an unhandled rejection out of this async
  // handler — the row persists and the user can retry connecting from the UI.
  try {
    ircManager.startNetwork(req.user!.id, network.id);
    res.redirect('/?slack=connected');
  } catch {
    res.redirect('/?slack=connect_failed');
  }
});

export default router;
