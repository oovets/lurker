// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Slack "Add to Slack" OAuth v2 flow. This lets a user grant a workspace's bot
// token by clicking through Slack's consent screen instead of pasting tokens.
//
// Scope of what OAuth covers here: oauth.v2.access returns a per-install **bot
// token** (xoxb-…). The **app-level token** (xapp-…) socket mode needs is NOT
// an OAuth artifact — it is a single app-wide secret the operator generates once
// in the Slack app config and supplies via SLACK_APP_TOKEN. So OAuth removes the
// per-workspace copy-paste of the bot token; the shared app token stays a server
// secret reused for every install. (A multi-tenant deployment that can't share
// one app token would move off socket mode onto the Events API — out of scope.)
//
// Config comes entirely from the environment so nothing app-secret lands in the
// DB or the client bundle. When any of the four are unset the flow reports
// "unconfigured" and the UI falls back to manual token entry.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { resolveSessionSecret } from '../utils/sessionSecret.js';

// The bot scopes the SlackConnection adapter actually exercises: conversation
// listing + history across all four conversation kinds, posting, reading users,
// reactions (read+write), and private file download. Kept in sync with the
// `this.web.*` calls in slackConnection.ts.
export const SLACK_BOT_SCOPES = [
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'chat:write',
  'users:read',
  'reactions:read',
  'reactions:write',
  'files:read',
];

export interface SlackOauthConfig {
  clientId: string;
  clientSecret: string;
  appToken: string;
  redirectUri: string;
}

// All four must be present for the flow to be usable. The redirect base is the
// public origin Slack will send the browser back to (e.g. https://lurker.example.com);
// the callback path is appended here so operators configure one value.
export function slackOauthConfig(): SlackOauthConfig | null {
  const clientId = (process.env.SLACK_CLIENT_ID || '').trim();
  const clientSecret = (process.env.SLACK_CLIENT_SECRET || '').trim();
  const appToken = (process.env.SLACK_APP_TOKEN || '').trim();
  const base = (process.env.SLACK_OAUTH_REDIRECT_BASE || '').trim().replace(/\/+$/, '');
  if (!clientId || !clientSecret || !appToken || !base) return null;
  return {
    clientId,
    clientSecret,
    appToken,
    redirectUri: `${base}/api/slack/oauth/callback`,
  };
}

export function slackOauthConfigured(): boolean {
  return slackOauthConfig() !== null;
}

// ── CSRF state: a signed, time-boxed token round-tripped through Slack ──
// Binds the flow to the initiating Lurker user (uid) and carries the chosen
// network name, so the callback trusts neither the cookie alone nor any query
// param Slack echoes back unsigned.

const STATE_TTL_MS = 10 * 60 * 1000;

let cachedKey: Buffer | null = null;
function stateKey(): Buffer {
  if (!cachedKey) {
    cachedKey = createHmac('sha256', resolveSessionSecret().secret)
      .update('slack-oauth-state')
      .digest();
  }
  return cachedKey;
}

interface StatePayload {
  uid: number;
  name: string;
  n: string;
  t: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function signState(uid: number, name: string, now: number): string {
  const payload: StatePayload = { uid, name: name || '', n: b64url(randomBytes(9)), t: now };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', stateKey()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyState(state: string, now: number): { uid: number; name: string } | null {
  const dot = state.indexOf('.');
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = b64url(createHmac('sha256', stateKey()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    return null;
  }
  if (typeof payload.uid !== 'number' || typeof payload.t !== 'number') return null;
  if (now - payload.t > STATE_TTL_MS || payload.t - now > STATE_TTL_MS) return null;
  return { uid: payload.uid, name: typeof payload.name === 'string' ? payload.name : '' };
}

export function buildAuthorizeUrl(config: SlackOauthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    scope: SLACK_BOT_SCOPES.join(','),
    redirect_uri: config.redirectUri,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export interface SlackOauthResult {
  botToken: string;
  teamName: string;
  teamId: string;
}

// Exchange the one-time code for a bot token. Uses the plain OAuth endpoint
// (form-encoded, no token) via global fetch so it is trivially mockable in tests
// and pulls in no client construction. Throws on a non-ok Slack response.
export async function exchangeCode(
  code: string,
  config: SlackOauthConfig,
): Promise<SlackOauthResult> {
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }).toString(),
  });
  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    access_token?: string;
    team?: { id?: string; name?: string };
  };
  if (!data.ok || !data.access_token) {
    throw new Error(`slack oauth.v2.access failed: ${data.error || 'unknown'}`);
  }
  return {
    botToken: data.access_token,
    teamName: data.team?.name || '',
    teamId: data.team?.id || '',
  };
}
