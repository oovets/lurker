import db from './index.js';

export function listNetworksForUser(userId) {
  return db.prepare('SELECT * FROM networks WHERE user_id = ? ORDER BY id').all(userId);
}

export function getNetwork(id, userId) {
  return db.prepare('SELECT * FROM networks WHERE id = ? AND user_id = ?').get(id, userId);
}

const ownsNetworkStmt = db.prepare('SELECT 1 FROM networks WHERE id = ? AND user_id = ? LIMIT 1');
export function ownsNetwork(userId, networkId) {
  if (!userId || !networkId) return false;
  return !!ownsNetworkStmt.get(networkId, userId);
}

export function createNetwork(userId, fields) {
  const { name, host, port, tls, nick, username, realname, server_password, autoconnect, sasl_account, sasl_password } = fields;
  const result = db.prepare(`
    INSERT INTO networks (user_id, name, host, port, tls, nick, username, realname, server_password, autoconnect, sasl_account, sasl_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    name,
    host,
    port ?? 6697,
    tls ? 1 : 0,
    nick,
    username || null,
    realname || null,
    server_password || null,
    autoconnect === false ? 0 : 1,
    sasl_account || null,
    sasl_password || null,
  );
  return getNetwork(result.lastInsertRowid, userId);
}

export function updateNetwork(id, userId, fields) {
  const allowed = ['name', 'host', 'port', 'tls', 'nick', 'username', 'realname', 'server_password', 'autoconnect', 'sasl_account', 'sasl_password'];
  const setClauses = [];
  const params = [];
  for (const key of allowed) {
    if (key in fields) {
      setClauses.push(`${key} = ?`);
      let value = fields[key];
      if (key === 'tls' || key === 'autoconnect') value = value ? 1 : 0;
      params.push(value);
    }
  }
  if (!setClauses.length) return getNetwork(id, userId);
  params.push(id, userId);
  db.prepare(`UPDATE networks SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  return getNetwork(id, userId);
}

export function deleteNetwork(id, userId) {
  db.prepare('DELETE FROM networks WHERE id = ? AND user_id = ?').run(id, userId);
}

export function listChannels(networkId) {
  return db.prepare('SELECT * FROM channels WHERE network_id = ? ORDER BY name').all(networkId);
}

export function upsertChannel(networkId, name, joined) {
  db.prepare(`
    INSERT INTO channels (network_id, name, joined) VALUES (?, ?, ?)
    ON CONFLICT (network_id, name) DO UPDATE SET joined = excluded.joined
  `).run(networkId, name, joined ? 1 : 0);
  return db.prepare('SELECT * FROM channels WHERE network_id = ? AND name = ?').get(networkId, name);
}

export function deleteChannel(networkId, name) {
  db.prepare('DELETE FROM channels WHERE network_id = ? AND name = ?').run(networkId, name);
}
