// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth, blockWritesWhenPaused } from '../middleware/auth.js';
import type { Network } from '../db/networks.js';
import {
  listNetworksForUser,
  getNetwork,
  createNetwork,
  updateNetwork,
  deleteNetwork,
  reorderNetworks,
  listChannels,
  upsertChannel,
} from '../db/networks.js';
import ircManager from '../services/ircManager.js';
import { fanOutToUser } from '../services/wsHub.js';

const router = Router();
router.use(requireAuth);
// Paused accounts are read-only: every connect/reconnect/join/part and all
// network-config mutation here is blocked, while GET listing still works so the
// sidebar renders. See blockWritesWhenPaused.
router.use(blockWritesWhenPaused);

function networkPayload(network: Network | undefined | null): Record<string, unknown> | null {
  if (!network) return null;
  // Never ship secrets to the client — drop the IRC passwords and the Slack
  // tokens, surfacing only booleans for "is one set".
  const { server_password, sasl_password, slack_bot_token, slack_app_token, ...safe } = network;
  return {
    ...safe,
    tls: !!network.tls,
    trusted_certificates: !!network.trusted_certificates,
    autoconnect: !!network.autoconnect,
    has_password: !!server_password,
    has_sasl_password: !!sasl_password,
    has_slack_tokens: !!(slack_bot_token && slack_app_token),
    channels: listChannels(network.id),
  };
}

router.get('/', (req: Request, res: Response) => {
  const networks = listNetworksForUser(req.user!.id).map(networkPayload);
  res.json({ networks });
});

router.post('/', (req: Request, res: Response) => {
  const {
    name,
    host,
    port,
    tls,
    trusted_certificates,
    nick,
    username,
    realname,
    server_password,
    autoconnect,
    sasl_account,
    sasl_password,
    default_channel,
    connect_commands,
    provider,
    slack_bot_token,
    slack_app_token,
  } = req.body || {};
  const isSlack = provider === 'slack';
  // Slack rows need only a name + the two tokens; host/nick are placeholders the
  // adapter ignores. IRC keeps its original required set.
  if (isSlack) {
    if (!name || !slack_bot_token || !slack_app_token) {
      res.status(400).json({ error: 'name, slack_bot_token, and slack_app_token are required' });
      return;
    }
  } else if (!name || !host || !nick) {
    res.status(400).json({ error: 'name, host, and nick are required' });
    return;
  }

  const network = createNetwork(req.user!.id, {
    name,
    host: isSlack ? 'slack' : host,
    port,
    tls,
    trusted_certificates,
    nick: isSlack ? 'me' : nick,
    username,
    realname,
    server_password,
    autoconnect,
    sasl_account,
    sasl_password,
    connect_commands,
    provider: isSlack ? 'slack' : 'irc',
    slack_bot_token: isSlack ? slack_bot_token : null,
    slack_app_token: isSlack ? slack_app_token : null,
  });
  if (!network) {
    res.status(500).json({ error: 'failed to create network' });
    return;
  }
  // Slack conversations are discovered on connect, so there's no default channel
  // to pre-create for a Slack network.
  const channel = isSlack ? '' : (default_channel || '').trim();
  if (channel) upsertChannel(network.id, channel, true);
  // Creating a network is an explicit "Save & connect" action, so connect now
  // regardless of `autoconnect`. The `autoconnect` flag governs only whether a
  // network is connected automatically at cold-start (connectScheduler /
  // ircManager.initAll) and on un-pause resume — not whether this initial,
  // user-initiated setup connects.
  ircManager.startNetwork(req.user!.id, network.id);
  res.status(201).json({ network: networkPayload(network) });
});

// Rewrite sidebar order for the caller. Body: { ids: [n1, n2, ...] } in the
// new order. Must match the user's current set exactly — partial reorders
// rejected with 409 so the caller refetches and tries again.
router.post('/reorder', (req: Request, res: Response) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }
  const next = reorderNetworks(req.user!.id, ids);
  if (next === null) {
    const networks = listNetworksForUser(req.user!.id).map(networkPayload);
    res.status(409).json({ error: 'network set mismatch', networks });
    return;
  }
  const networks = listNetworksForUser(req.user!.id).map(networkPayload);
  res.json({ networks });
});

router.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = getNetwork(id, req.user!.id);
  if (!existing) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  const updated = updateNetwork(id, req.user!.id, req.body || {});
  res.json({ network: networkPayload(updated) });
});

router.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = getNetwork(id, req.user!.id);
  if (!existing) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  ircManager.disposeNetwork(req.user!.id, id, 'network removed');
  deleteNetwork(id, req.user!.id);
  // Deleting the network cascades away its contact_targets, so re-publish the
  // contact list to every open tab — otherwise the Friends UI keeps stale
  // targets (and a possibly-dead primary DM) pointing at the gone network until
  // the next reconnect re-snapshots.
  fanOutToUser(req.user!.id, {
    kind: 'contacts-snapshot',
    contacts: ircManager.listContacts(req.user!.id),
  });
  res.json({ ok: true });
});

router.post('/:id/connect', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const network = getNetwork(id, req.user!.id);
  if (!network) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  ircManager.startNetwork(req.user!.id, id);
  res.json({ ok: true });
});

router.post('/:id/disconnect', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const network = getNetwork(id, req.user!.id);
  if (!network) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  ircManager.stopNetwork(req.user!.id, id, req.body?.reason);
  res.json({ ok: true });
});

router.post('/:id/reconnect', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const network = getNetwork(id, req.user!.id);
  if (!network) {
    res.status(404).json({ error: 'network not found' });
    return;
  }
  ircManager.restartNetwork(req.user!.id, id);
  res.json({ ok: true });
});

// Same-origin proxy for Slack file attachments: Slack's url_private needs the
// bot token, which the browser doesn't have — so the server fetches it and
// streams it back (authenticated by the session like every other route).
router.get('/:id/slack-file/:fileId', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const conn = ircManager.getConnection(req.user!.id, id);
  if (conn?.provider !== 'slack') {
    res.status(404).end();
    return;
  }
  const file = await conn.downloadFile(String(req.params.fileId));
  if (!file) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', file.mimetype);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(Buffer.from(file.data));
});

// The workspace's custom emoji (name → image URL) for a Slack network, so the
// client can offer them in `:shortcode:` autocomplete and render them in
// message bodies + reaction chips. Empty object for non-Slack networks.
router.get('/:id/slack-emoji', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const conn = ircManager.getConnection(req.user!.id, id);
  if (conn?.provider !== 'slack') {
    res.json({ emoji: {} });
    return;
  }
  res.json({ emoji: conn.emojiMap() });
});

router.post('/:id/join', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { channel } = req.body || {};
  if (!channel) {
    res.status(400).json({ error: 'channel required' });
    return;
  }
  if (!ircManager.joinChannel(req.user!.id, id, channel)) {
    res.status(409).json({ error: 'network not connected' });
    return;
  }
  res.json({ ok: true });
});

router.post('/:id/part', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { channel, reason } = req.body || {};
  if (!channel) {
    res.status(400).json({ error: 'channel required' });
    return;
  }
  if (!ircManager.partChannel(req.user!.id, id, channel, reason)) {
    res.status(409).json({ error: 'network not connected' });
    return;
  }
  res.json({ ok: true });
});

export default router;
