import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the DB layer at a throwaway file before importing anything that
// touches it. db/index.js reads DATABASE_PATH at module-load time, so this
// must happen before the dynamic imports below.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caint-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser;
let createNetwork;
let ownsNetwork;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork, ownsNetwork } = await import('./networks.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ownsNetwork', () => {
  it('returns true for a network owned by the user', () => {
    const alice = createUser('alice');
    const net = createNetwork(alice.id, {
      name: 'libera', host: 'irc.libera.chat', port: 6697, tls: true, nick: 'alice',
    });
    expect(ownsNetwork(alice.id, net.id)).toBe(true);
  });

  it('returns false when the network belongs to a different user', () => {
    const bob = createUser('bob');
    const carol = createUser('carol');
    const carolNet = createNetwork(carol.id, {
      name: 'libera', host: 'irc.libera.chat', port: 6697, tls: true, nick: 'carol',
    });
    expect(ownsNetwork(bob.id, carolNet.id)).toBe(false);
    expect(ownsNetwork(carol.id, carolNet.id)).toBe(true);
  });

  it('returns false for nonexistent networks', () => {
    const dave = createUser('dave');
    expect(ownsNetwork(dave.id, 999999)).toBe(false);
  });

  it('returns false for falsy or invalid inputs', () => {
    expect(ownsNetwork(null, 1)).toBe(false);
    expect(ownsNetwork(undefined, 1)).toBe(false);
    expect(ownsNetwork(1, null)).toBe(false);
    expect(ownsNetwork(1, undefined)).toBe(false);
    expect(ownsNetwork(0, 0)).toBe(false);
  });
});
