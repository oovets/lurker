// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  slackOauthConfig,
  slackOauthConfigured,
  signState,
  verifyState,
  buildAuthorizeUrl,
  exchangeCode,
  SLACK_BOT_SCOPES,
} from './slackOauth.js';

const ENV_KEYS = [
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_APP_TOKEN',
  'SLACK_OAUTH_REDIRECT_BASE',
];

function setConfigured(): void {
  process.env.SLACK_CLIENT_ID = 'cid-123';
  process.env.SLACK_CLIENT_SECRET = 'secret-xyz';
  process.env.SLACK_APP_TOKEN = 'xapp-1-AAA';
  process.env.SLACK_OAUTH_REDIRECT_BASE = 'https://lurker.example.com/';
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('slackOauthConfig', () => {
  it('returns null until all four env vars are set', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(slackOauthConfig()).toBeNull();
    expect(slackOauthConfigured()).toBe(false);
    process.env.SLACK_CLIENT_ID = 'cid';
    expect(slackOauthConfig()).toBeNull();
  });

  it('builds the callback redirect_uri from the base (trailing slash trimmed)', () => {
    setConfigured();
    const cfg = slackOauthConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.redirectUri).toBe('https://lurker.example.com/api/slack/oauth/callback');
    expect(slackOauthConfigured()).toBe(true);
  });
});

describe('state sign/verify', () => {
  it('round-trips uid + name', () => {
    const state = signState(42, 'My Workspace', 1_000_000);
    expect(verifyState(state, 1_000_000)).toEqual({ uid: 42, name: 'My Workspace' });
  });

  it('rejects a tampered body', () => {
    const state = signState(42, 'x', 1_000_000);
    const tampered = `${'A'.repeat(state.indexOf('.'))}.${state.split('.')[1]}`;
    expect(verifyState(tampered, 1_000_000)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const state = signState(42, 'x', 1_000_000);
    expect(verifyState(`${state}x`, 1_000_000)).toBeNull();
  });

  it('rejects an expired state (older than the TTL)', () => {
    const state = signState(42, 'x', 1_000_000);
    expect(verifyState(state, 1_000_000 + 11 * 60 * 1000)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyState('', 1)).toBeNull();
    expect(verifyState('nodot', 1)).toBeNull();
    expect(verifyState('.sig', 1)).toBeNull();
  });
});

describe('buildAuthorizeUrl', () => {
  it('includes client id, scopes, redirect uri and state', () => {
    setConfigured();
    const cfg = slackOauthConfig()!;
    const url = new URL(buildAuthorizeUrl(cfg, 'STATE123'));
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid-123');
    expect(url.searchParams.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(url.searchParams.get('state')).toBe('STATE123');
    expect(url.searchParams.get('scope')).toBe(SLACK_BOT_SCOPES.join(','));
  });
});

describe('exchangeCode', () => {
  it('POSTs to oauth.v2.access and returns the bot token + team', async () => {
    setConfigured();
    const cfg = slackOauthConfig()!;
    const fetchMock = vi.fn<
      (url: string, init: { body: string }) => Promise<{ json: () => Promise<unknown> }>
    >(async (_url, _init) => ({
      json: async () => ({
        ok: true,
        access_token: 'xoxb-real-bot',
        team: { id: 'T1', name: 'Acme' },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await exchangeCode('the-code', cfg);
    expect(result).toEqual({ botToken: 'xoxb-real-bot', teamName: 'Acme', teamId: 'T1' });
    const [, init] = fetchMock.mock.calls[0];
    const body = new URLSearchParams(init.body);
    expect(body.get('code')).toBe('the-code');
    expect(body.get('client_id')).toBe('cid-123');
    expect(body.get('client_secret')).toBe('secret-xyz');
    expect(body.get('redirect_uri')).toBe(cfg.redirectUri);
  });

  it('throws when Slack reports failure', async () => {
    setConfigured();
    const cfg = slackOauthConfig()!;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => ({ ok: false, error: 'bad_code' }) })),
    );
    await expect(exchangeCode('x', cfg)).rejects.toThrow(/bad_code/);
  });
});
