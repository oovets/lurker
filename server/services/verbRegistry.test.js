// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-verb-registry-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser;
let createNetwork;
let registerVerb;
let callVerb;
let listVerbs;
let getVerb;
let __resetForTests;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ registerVerb, callVerb, listVerbs, getVerb, __resetForTests } =
    await import('./verbRegistry.js'));
});

beforeEach(() => {
  __resetForTests();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('verbRegistry', () => {
  it('registerVerb + getVerb round-trips', () => {
    registerVerb({
      name: 'noop',
      description: 'does nothing',
      scope: 'read',
      input: { type: 'object' },
      handler: () => 'ok',
    });
    expect(getVerb('noop').description).toBe('does nothing');
  });

  it('registerVerb rejects duplicates, invalid scope, missing handler', () => {
    registerVerb({ name: 'dup', scope: 'read', handler: () => null });
    expect(() => registerVerb({ name: 'dup', scope: 'read', handler: () => null })).toThrow();
    expect(() => registerVerb({ name: 'bad', scope: 'admin', handler: () => null })).toThrow();
    expect(() => registerVerb({ name: 'no-handler', scope: 'read' })).toThrow();
  });

  it('callVerb throws unknown_verb when the name is not registered', () => {
    try {
      callVerb('ghost', { userId: 1, scope: 'read' }, {});
      throw new Error('expected throw');
    } catch (err) {
      expect(err.code).toBe('unknown_verb');
    }
  });

  it('callVerb enforces scope: read-write verbs reject read scope', () => {
    registerVerb({
      name: 'mutate',
      scope: 'read-write',
      handler: () => 'wrote',
    });
    expect(() => callVerb('mutate', { userId: 1, scope: 'read' }, {})).toThrow(/scope insufficient/);
    expect(callVerb('mutate', { userId: 1, scope: 'read-write' }, {})).toBe('wrote');
  });

  it('callVerb rejects unknown networkId at the boundary (other-user ownership leak)', () => {
    const owner = createUser('vr-owner');
    const intruder = createUser('vr-intruder');
    const net = createNetwork(owner.id, {
      name: 'libera', host: 'h', port: 6697, tls: true, nick: 'o',
    });
    registerVerb({
      name: 'read-net',
      scope: 'read',
      handler: (ctx, input) => ({ saw: input.networkId }),
    });
    // Owner can call against their own network.
    expect(callVerb('read-net', { userId: owner.id, scope: 'read' }, { networkId: net.id }))
      .toEqual({ saw: net.id });
    // Intruder cannot.
    try {
      callVerb('read-net', { userId: intruder.id, scope: 'read' }, { networkId: net.id });
      throw new Error('expected throw');
    } catch (err) {
      expect(err.code).toBe('unknown_network');
    }
  });

  it('listVerbs filters read-write verbs from a read-only caller', () => {
    registerVerb({ name: 'r', description: 'r', scope: 'read', handler: () => null });
    registerVerb({ name: 'w', description: 'w', scope: 'read-write', handler: () => null });
    const readSet = listVerbs('read').map((v) => v.name);
    const rwSet = listVerbs('read-write').map((v) => v.name);
    expect(readSet).toEqual(['r']);
    expect(rwSet.sort()).toEqual(['r', 'w']);
  });

  it('listVerbs entries carry the inputSchema declared at registration', () => {
    const schema = { type: 'object', properties: { x: { type: 'integer' } } };
    registerVerb({ name: 'sch', description: 'with schema', scope: 'read', input: schema, handler: () => null });
    const entry = listVerbs('read').find((v) => v.name === 'sch');
    expect(entry.inputSchema).toEqual(schema);
  });
});
