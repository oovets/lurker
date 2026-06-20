// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type * as SystemLogModule from './systemLog.js';

// systemLog is now DB-backed (system_messages, issue #355), so point the DB
// layer at a throwaway file before importing anything that touches it — both for
// isolation and because per-user lines carry a FK to a real users row.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let systemLog: typeof SystemLogModule.default;
let createUser: typeof import('../db/users.js').createUser;
let alice: number;
let bob: number;

beforeAll(async () => {
  systemLog = (await import('./systemLog.js')).default;
  ({ createUser } = await import('../db/users.js'));
  alice = createUser('syslog-alice').id;
  bob = createUser('syslog-bob').id;
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('log', () => {
  it('global lines have null userId and surface to every getRecent caller', () => {
    const line = systemLog.log({ scope: 'server', text: 'server boot' });
    expect(line.userId).toBeNull();
    expect(line.level).toBe('info');
    expect(line.scope).toBe('server');
    expect(line.source).toBe('server');
    expect(line.text).toBe('server boot');
    expect(line.id).toBeGreaterThan(0);

    const recent = systemLog.getRecent(alice);
    expect(recent.find((l) => l.text === 'server boot')).toBeTruthy();
  });

  it('per-user lines are visible to that user, not to others', () => {
    systemLog.log({ scope: 'irc', text: 'private to alice', userId: alice });
    expect(systemLog.getRecent(alice).find((l) => l.text === 'private to alice')).toBeTruthy();
    expect(systemLog.getRecent(bob).find((l) => l.text === 'private to alice')).toBeFalsy();
  });

  it('per-user lines merge with globals in monotonic id order', () => {
    systemLog.log({ scope: 'global', text: 'global-A' });
    systemLog.log({ scope: 'priv', text: 'priv-B', userId: alice });
    systemLog.log({ scope: 'global', text: 'global-C' });
    const texts = systemLog.getRecent(alice).map((l) => l.text);
    const ia = texts.indexOf('global-A');
    const ib = texts.indexOf('priv-B');
    const ic = texts.indexOf('global-C');
    expect(ia).toBeLessThan(ib);
    expect(ib).toBeLessThan(ic);
  });

  it('defaults level/scope/source and stringifies null/undefined text', () => {
    const line = systemLog.log({});
    expect(line.level).toBe('info');
    expect(line.scope).toBe('lurker');
    expect(line.source).toBe('server');
    expect(line.text).toBe('');
    expect(line.fields).toBeNull();
  });

  it('carries an explicit source through', () => {
    const line = systemLog.log({ text: 'notice', source: 'control-plane' });
    expect(line.source).toBe('control-plane');
  });

  it('preserves an explicit fields payload', () => {
    const line = systemLog.log({ scope: 'irc', text: 'meta', fields: { code: 42 } });
    expect(line.fields).toEqual({ code: 42 });
  });

  it('non-object fields are dropped (defensive)', () => {
    const line = systemLog.log({
      scope: 'x',
      text: 'y',
      fields: 'not-an-object' as unknown as Record<string, unknown>,
    });
    expect(line.fields).toBeNull();
  });

  it('emits the line on the "line" event', () => {
    return new Promise<void>((resolve, reject) => {
      function handler(l: unknown) {
        const line = l as { text: string; scope: string };
        systemLog.off('line', handler);
        try {
          expect(line.text).toBe('emit-test');
          expect(line.scope).toBe('emit');
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      systemLog.on('line', handler);
      systemLog.log({ scope: 'emit', text: 'emit-test' });
    });
  });
});

describe('getRecent', () => {
  it('returns an array (globals only) for a user with no private lines', () => {
    const recent = systemLog.getRecent(999999); // never logged to / nonexistent
    expect(Array.isArray(recent)).toBe(true);
    expect(recent.every((l) => l.userId === null)).toBe(true);
  });
});

describe('dropUser', () => {
  it("forgets a user's ring without touching globals", () => {
    systemLog.log({ scope: 'wipe-me', text: 'doomed', userId: bob });
    expect(systemLog.getRecent(bob).find((l) => l.text === 'doomed')).toBeTruthy();
    systemLog.dropUser(bob);
    expect(systemLog.getRecent(bob).find((l) => l.text === 'doomed')).toBeFalsy();
  });
});

describe('ring caps', () => {
  it('caps the global ring (exact constant lives in db/systemMessages)', () => {
    // Push enough lines to overflow the 200-line global cap.
    for (let i = 0; i < 250; i += 1) systemLog.log({ scope: 'flood', text: `g${i}` });
    const recent = systemLog.getRecent(alice);
    const globals = recent.filter((l) => l.userId === null && /^g\d+$/.test(l.text));
    expect(globals.length).toBeLessThanOrEqual(200);
    // The oldest survivor should be well past g0 (pruned).
    expect(globals[0].text).not.toBe('g0');
  });
});
