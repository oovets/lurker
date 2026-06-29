// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Seed an iMessage-provider network row into the live database, attached to the
// first (oldest) Lurker user. Convenience for testing — point it at a running
// BlueBubbles server via env and run with tsx:
//
//   IMESSAGE_SERVER_URL=https://your-mac:1234 IMESSAGE_PASSWORD=… \
//     npx tsx tools/seed-imessage-network.ts
//
// Or seed the credential-free demo workspace (canned chats, no Mac needed):
//
//   IMESSAGE_SERVER_URL=demo IMESSAGE_PASSWORD=demo \
//     npx tsx tools/seed-imessage-network.ts
//
// The server auto-connects on next boot (autoconnect=1).

import db from '../server/db/index.js';
import { createNetwork } from '../server/db/networks.js';

const serverUrl = process.env.IMESSAGE_SERVER_URL;
const password = process.env.IMESSAGE_PASSWORD;
const name = process.env.IMESSAGE_NAME || 'iMessage';

if (!serverUrl || !password) {
  console.error('Set IMESSAGE_SERVER_URL and IMESSAGE_PASSWORD (or both to "demo").');
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
  // host/port/nick are unused by the iMessage adapter but the columns are NOT NULL.
  host: 'imessage',
  port: 443,
  nick: 'me',
  provider: 'imessage',
  imessage_server_url: serverUrl,
  imessage_password: password,
  autoconnect: true,
});

console.log(`Created iMessage network "${name}" (id ${net?.id}) for user ${user.id}.`);
console.log('Restart the server (or POST /api/networks/:id/connect) to connect.');
