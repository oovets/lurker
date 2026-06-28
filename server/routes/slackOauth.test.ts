// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-slack-oauth');

const fakeManager = {
  started: [] as Array<[number, number]>,
  reset() {
    this.started = [];
  },
  startNetwork(userId: number, networkId: number) {
    this.started.push([userId, networkId]);
  },
};
vi.mock('../services/ircManager.js', () => ({ default: fakeManager }));

const ENV_KEYS = [
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_APP_TOKEN',
  'SLACK_OAUTH_REDIRECT_BASE',
];
const saved: Record<string, string | undefined> = {};
function configure(): void {
  process.env.SLACK_CLIENT_ID = 'cid-123';
  process.env.SLACK_CLIENT_SECRET = 'secret-xyz';
  process.env.SLACK_APP_TOKEN = 'xapp-shared';
  process.env.SLACK_OAUTH_REDIRECT_BASE = 'https://lurker.example.com';
}

let app: Express;
let agent: LurkerTestAgent;
let alice: User;
let signState: (uid: number, name: string, now: number) => string;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./slackOauth.js')).default;
  signState = (await import('../services/slackOauth.js')).signState;
  alice = createUser('slack-oauth-alice');
  app = createTestApp({ '/api/slack': router });
  agent = await createAuthedAgent(app, alice.id);
});

afterAll(() => ctx.cleanup());

beforeEach(() => {
  fakeManager.reset();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('GET /api/slack/oauth/config', () => {
  it('reports unconfigured when env is missing', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const res = await agent.get('/api/slack/oauth/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false });
  });

  it('reports configured when env is present', async () => {
    configure();
    const res = await agent.get('/api/slack/oauth/config');
    expect(res.body).toEqual({ configured: true });
  });
});

describe('GET /api/slack/oauth/start', () => {
  it('redirects to Slack consent with a signed state', async () => {
    configure();
    const res = await agent.get('/api/slack/oauth/start?name=Acme');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.host).toBe('slack.com');
    expect(url.searchParams.get('client_id')).toBe('cid-123');
    const state = url.searchParams.get('state')!;
    const { verifyState } = await import('../services/slackOauth.js');
    expect(verifyState(state, Date.now())).toEqual({ uid: alice.id, name: 'Acme' });
  });

  it('503s when not configured', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const res = await agent.get('/api/slack/oauth/start');
    expect(res.status).toBe(503);
  });
});

describe('GET /api/slack/oauth/callback', () => {
  it('exchanges the code, creates a Slack network, connects and redirects', async () => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          ok: true,
          access_token: 'xoxb-from-oauth',
          team: { id: 'T9', name: 'Acme Inc' },
        }),
      })),
    );
    const state = signState(alice.id, 'Acme', Date.now());
    const res = await agent.get(
      `/api/slack/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?slack=connected');

    const { listNetworksForUser } = await import('../db/networks.js');
    const net = listNetworksForUser(alice.id).find(
      (n) => n.provider === 'slack' && n.name === 'Acme',
    );
    expect(net).toBeTruthy();
    expect(net!.slack_bot_token).toBe('xoxb-from-oauth');
    expect(net!.slack_app_token).toBe('xapp-shared');
    expect(fakeManager.started).toContainEqual([alice.id, net!.id]);
  });

  it('rejects a tampered state with 400 and creates nothing', async () => {
    configure();
    const res = await agent.get('/api/slack/oauth/callback?code=abc&state=forged.sig');
    expect(res.status).toBe(400);
    expect(fakeManager.started).toHaveLength(0);
  });

  it('bounces back to the SPA when the user denies (error param)', async () => {
    configure();
    const res = await agent.get('/api/slack/oauth/callback?error=access_denied');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?slack=denied');
  });
});
