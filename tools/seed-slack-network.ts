// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Seed a Slack-provider network row into the live database, attached to the
// first (oldest) Lurker user. Pre-MVP convenience until the NetworkForm grows a
// Slack option — paste your tokens via env and run with tsx:
//
//   SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… \
//     npx tsx tools/seed-slack-network.ts
//
// Tokens: a bot/user OAuth token (xoxb-/xoxp-) with the conversations/history/
// users/chat scopes, and an app-level token (xapp-) with connections:write so
// socket mode can open. The server auto-connects on next boot (autoconnect=1).

import db from '../server/db/index.js';
import { createNetwork } from '../server/db/networks.js';

const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
const name = process.env.SLACK_NAME || 'Slack';

if (!botToken || !appToken) {
  console.error('Set SLACK_BOT_TOKEN (xoxb-/xoxp-) and SLACK_APP_TOKEN (xapp-).');
  process.exit(1);
}

const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as
  | { id: number }
  | undefined;
if (!user) {
  console.error('No Lurker user yet — create your account in the web UI first.');
  process.exit(1);
}

const net = createNetwork(user.id, {
  name,
  // host/port/nick are unused by the Slack adapter but the columns are NOT NULL.
  host: 'slack',
  port: 443,
  nick: 'me',
  provider: 'slack',
  slack_bot_token: botToken,
  slack_app_token: appToken,
  autoconnect: true,
});

console.log(`Created Slack network "${name}" (id ${net?.id}) for user ${user.id}.`);
console.log('Restart the server (or POST /api/networks/:id/connect) to connect.');
