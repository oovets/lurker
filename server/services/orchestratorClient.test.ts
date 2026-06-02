// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Set edition + node config before importing the module under test. vitest runs
// each file in its own process, so this is scoped here.
process.env.LURKER_EDITION = 'node';
process.env.LURKER_NODE_SECRET = 'fleet-secret';
process.env.LURKER_ORCHESTRATOR_URL = 'http://orchestrator:8020';
process.env.LURKER_NODE_NAME = 'cell-test';
process.env.LURKER_NODE_CONTROL_URL = 'http://cell-test:8015';
process.env.LURKER_NODE_CAPACITY = '250';

import { setupTestDb } from '../test-utils/testApp.js';

// countUsers() reads the DB, so a test DB must exist before the import below.
const ctx = setupTestDb('orchestrator-client');

// Loose signature for the global fetch mock — reportToOrchestrator only reads
// `.ok` off the response.
type FetchMock = (...args: unknown[]) => Promise<{ ok: boolean }>;

let mod: typeof import('./orchestratorClient.js');

beforeAll(async () => {
  mod = await import('./orchestratorClient.js');
});

afterAll(() => {
  ctx.cleanup();
  vi.unstubAllGlobals();
});

describe('readOrchestratorConfig', () => {
  it('returns a full config when node mode + env are set', () => {
    expect(mod.readOrchestratorConfig()).toMatchObject({
      url: 'http://orchestrator:8020',
      name: 'cell-test',
      controlUrl: 'http://cell-test:8015',
      capacity: 250,
      secret: 'fleet-secret',
    });
  });

  it('is null (client no-ops) when a required var is missing', () => {
    const saved = process.env.LURKER_ORCHESTRATOR_URL;
    delete process.env.LURKER_ORCHESTRATOR_URL;
    try {
      expect(mod.readOrchestratorConfig()).toBeNull();
    } finally {
      process.env.LURKER_ORCHESTRATOR_URL = saved;
    }
  });
});

describe('buildRegistration', () => {
  it('advertises identity, capacity, version, and a live user count', () => {
    const cfg = mod.readOrchestratorConfig();
    expect(cfg).not.toBeNull();
    const reg = mod.buildRegistration(cfg!);
    expect(reg).toMatchObject({
      name: 'cell-test',
      control_url: 'http://cell-test:8015',
      capacity: 250,
    });
    expect(typeof reg.version).toBe('string');
    expect(typeof reg.user_count).toBe('number');
  });
});

describe('reportToOrchestrator', () => {
  it('posts to /_cp/cells/register with the bearer and returns true on 2xx', async () => {
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const cfg = mod.readOrchestratorConfig()!;
    expect(await mod.reportToOrchestrator(cfg)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('http://orchestrator:8020/_cp/cells/register');
    expect(opts.headers.Authorization).toBe('Bearer fleet-secret');
    expect(opts.headers['User-Agent']).toMatch(/^Lurker\//);
  });

  it('returns false (never throws) when the orchestrator is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn<FetchMock>().mockRejectedValue(new Error('ECONNREFUSED')));
    const cfg = mod.readOrchestratorConfig()!;
    expect(await mod.reportToOrchestrator(cfg)).toBe(false);
  });

  it('returns false on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn<FetchMock>().mockResolvedValue({ ok: false }));
    const cfg = mod.readOrchestratorConfig()!;
    expect(await mod.reportToOrchestrator(cfg)).toBe(false);
  });
});
