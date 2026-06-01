// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Cross-tenant isolation regression suite (D1, lurker.chat hosted service).
//
// The hosted service inverts the self-hosted threat model: co-tenants are
// adversaries to each other, so one missing `WHERE user_id = ?` or a
// mis-targeted broadcast leaks private messages. The route + WS/verb layers
// were audited clean by hand; this suite turns that audit into executable
// proof so a future refactor that drops a scope check fails CI instead of
// shipping a co-tenant DM leak.
//
// Shape: seed data owned by tenant A, then assert tenant B cannot read or
// mutate it across all three surfaces — HTTP routes, the transport-agnostic
// verb layer (the enforcement core shared by WebSocket + MCP), and the DB
// primitives. Positive controls confirm A *can* reach A's own data, so a
// blanket "everything 404s" bug couldn't make this suite pass.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  type LurkerTestAgent,
} from './test-utils/testApp.js';

// MUST run at module top level so DATABASE_PATH is set before any dynamic
// import touches db/index.js.
const ctx = setupTestDb('tenant-isolation');

const SECRET_TOKEN = 'isolationcanary'; // distinctive single FTS token in A's message
const SECRET_TARGET = '#secret';

let app: Express;
let agentA: LurkerTestAgent;
let agentB: LurkerTestAgent;

let userAId: number;
let userBId: number;
let netAId: number;
let netBId: number;
let msgIdA: number;
let uploadIdA: number;
let ruleIdA: number;
let tokenIdA: number;

// Late-bound module fns (imported after setupTestDb).
let callVerb: typeof import('./services/verbRegistry.js').callVerb;
let searchMessages: typeof import('./db/messages.js').searchMessages;
let getNetwork: typeof import('./db/networks.js').getNetwork;
let addBookmark: typeof import('./db/bookmarks.js').addBookmark;
let listBookmarkIdsForUser: typeof import('./db/bookmarks.js').listBookmarkIdsForUser;

// Asserts callVerb rejects with a specific error code (verbRegistry attaches
// `.code` to its boundary errors). Captures the thrown value, then asserts
// unconditionally — a silent "didn't throw" leaves `thrown` undefined and
// fails the expect.
function expectVerbError(fn: () => unknown, code: string): void {
  let thrown: { code?: string } | undefined;
  try {
    fn();
  } catch (err) {
    thrown = err as { code?: string };
  }
  expect(thrown?.code).toBe(code);
}

function verbCtx(userId: number, scope: 'read' | 'read-write' = 'read') {
  return { userId, scope, transport: 'test' };
}

beforeAll(async () => {
  const { createUser } = await import('./db/users.js');
  const networksDb = await import('./db/networks.js');
  const { insertMessage, searchMessages: search } = await import('./db/messages.js');
  const { insertUpload } = await import('./db/uploadHistory.js');
  const { createToken } = await import('./db/apiTokens.js');
  const bookmarks = await import('./db/bookmarks.js');
  const { default: highlightRulesService } = await import('./services/highlightRulesService.js');
  // Side-effecting import registers every verb into the shared registry.
  await import('./services/verbs/index.js');
  const registry = await import('./services/verbRegistry.js');

  callVerb = registry.callVerb;
  searchMessages = search;
  getNetwork = networksDb.getNetwork;
  addBookmark = bookmarks.addBookmark;
  listBookmarkIdsForUser = bookmarks.listBookmarkIdsForUser;

  userAId = createUser('tenant-a').id;
  userBId = createUser('tenant-b').id;

  netAId = networksDb.createNetwork(userAId, { name: 'netA', host: 'irc.a.test', nick: 'a' })!.id;
  netBId = networksDb.createNetwork(userBId, { name: 'netB', host: 'irc.b.test', nick: 'b' })!.id;

  // A private message in A's buffer — the thing a leak would expose.
  msgIdA = Number(
    insertMessage({
      networkId: netAId,
      target: SECRET_TARGET,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'someone',
      text: SECRET_TOKEN,
    }).id,
  );

  // B's own '#secret' buffer on B's own network — a deliberate target-name
  // collision with A's buffer. Proves isolation keys on network ownership, not
  // on the buffer name (the case Copilot flagged on PR #157).
  insertMessage({
    networkId: netBId,
    target: SECRET_TARGET,
    time: new Date().toISOString(),
    type: 'message',
    nick: 'b-side',
    text: 'b-own-message',
  });

  uploadIdA = insertUpload(userAId, {
    provider: 'test',
    url: 'https://example.test/a.png',
    filename: 'a.png',
    mime: 'image/png',
    byte_size: 10,
    width: 1,
    height: 1,
    thumbnail: Buffer.from('thumb-a'),
  });

  const created = highlightRulesService.create(userAId, { pattern: 'a-rule', kind: 'plain' });
  ruleIdA = (created as { ok: true; rule: { id: number } }).rule.id;

  tokenIdA = createToken({ userId: userAId, name: 'A token', scope: 'read-write' }).id;

  // A bookmarks A's own message: positive control + the row B must not see.
  addBookmark(userAId, msgIdA);

  const networksRouter = (await import('./routes/networks.js')).default;
  const uploadsRouter = (await import('./routes/uploads.js')).default;
  const highlightRulesRouter = (await import('./routes/highlightRules.js')).default;
  const apiTokensRouter = (await import('./routes/apiTokens.js')).default;
  const bookmarksRouter = (await import('./routes/bookmarks.js')).default;

  app = createTestApp({
    '/api/networks': networksRouter,
    '/api/uploads': uploadsRouter,
    '/api/highlight-rules': highlightRulesRouter,
    '/api/api-tokens': apiTokensRouter,
    '/api/bookmarks': bookmarksRouter,
  });
  agentA = await createAuthedAgent(app, userAId);
  agentB = await createAuthedAgent(app, userBId);
});

afterAll(() => ctx.cleanup());

describe('HTTP routes — tenant B cannot reach tenant A', () => {
  it('networks: list returns only B; A’s network is absent', async () => {
    const res = await agentB.get('/api/networks');
    expect(res.status).toBe(200);
    const ids = res.body.networks.map((n: { id: number }) => n.id);
    expect(ids).toContain(netBId);
    expect(ids).not.toContain(netAId);
  });

  it('networks: patch/delete/connect on A’s network 404 for B', async () => {
    expect((await agentB.patch(`/api/networks/${netAId}`).send({ name: 'pwned' })).status).toBe(
      404,
    );
    expect((await agentB.delete(`/api/networks/${netAId}`)).status).toBe(404);
    expect((await agentB.post(`/api/networks/${netAId}/connect`)).status).toBe(404);
  });

  it('uploads: B cannot read A’s thumbnail or delete A’s upload', async () => {
    expect((await agentB.get(`/api/uploads/${uploadIdA}/thumb`)).status).toBe(404);
    expect((await agentB.delete(`/api/uploads/${uploadIdA}`)).status).toBe(404);
    const list = await agentB.get('/api/uploads');
    expect(list.body.items.map((u: { id: number }) => u.id)).not.toContain(uploadIdA);
  });

  it('highlight rules: B cannot patch/delete A’s rule', async () => {
    expect(
      (await agentB.patch(`/api/highlight-rules/${ruleIdA}`).send({ enabled: false })).status,
    ).toBe(404);
    expect((await agentB.delete(`/api/highlight-rules/${ruleIdA}`)).status).toBe(404);
  });

  it('api tokens: B cannot revoke A’s token, nor see it listed', async () => {
    expect((await agentB.delete(`/api/api-tokens/${tokenIdA}`)).status).toBe(404);
    const list = await agentB.get('/api/api-tokens');
    expect(list.body.items.map((t: { id: number }) => t.id)).not.toContain(tokenIdA);
  });

  it('bookmarks: B’s list is empty (A’s bookmark is invisible)', async () => {
    const res = await agentB.get('/api/bookmarks');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });
});

describe('HTTP routes — owner A can reach own data (positive controls)', () => {
  it('A sees A’s network, reads A’s thumbnail, and sees A’s bookmark', async () => {
    const nets = await agentA.get('/api/networks');
    expect(nets.body.networks.map((n: { id: number }) => n.id)).toContain(netAId);

    const thumb = await agentA.get(`/api/uploads/${uploadIdA}/thumb`);
    expect(thumb.status).toBe(200);

    const bm = await agentA.get('/api/bookmarks');
    expect(bm.body.items.map((m: { id: number }) => m.id)).toContain(msgIdA);
  });
});

describe('Verb layer (WebSocket + MCP core) — tenant B is denied', () => {
  it('network-keyed verbs throw unknown_network for B against A’s network', () => {
    expectVerbError(
      () =>
        callVerb('recent_messages', verbCtx(userBId), { networkId: netAId, target: SECRET_TARGET }),
      'unknown_network',
    );
    expectVerbError(
      () =>
        callVerb('send_message', verbCtx(userBId, 'read-write'), {
          networkId: netAId,
          target: SECRET_TARGET,
          text: 'hi',
        }),
      'unknown_network',
    );
    expectVerbError(
      () => callVerb('get_nick_note', verbCtx(userBId), { networkId: netAId, nick: 'someone' }),
      'unknown_network',
    );
  });

  it('global search/list verbs never surface A’s data to B', () => {
    const search = callVerb('search_messages', verbCtx(userBId), { query: SECRET_TOKEN }) as {
      messages: unknown[];
    };
    expect(search.messages).toHaveLength(0);

    const buffers = callVerb('list_buffers', verbCtx(userBId), {}) as Array<{
      networkId: number;
      target: string;
    }>;
    // Isolation is by network ownership, not target name. B has its own
    // same-named '#secret' buffer (seeded below), so the invariant is "B sees
    // NOTHING on A's network" — not "no buffer is named #secret". The `some`
    // check confirms B does see its own colliding buffer, so this isn't
    // vacuously passing on an empty list.
    expect(buffers.every((b) => b.networkId !== netAId)).toBe(true);
    expect(buffers.some((b) => b.networkId === netBId && b.target === SECRET_TARGET)).toBe(true);

    const networks = callVerb('list_networks', verbCtx(userBId), {}) as Array<{ id: number }>;
    expect(networks.map((n) => n.id)).not.toContain(netAId);
  });
});

describe('Verb layer — owner A can (positive controls)', () => {
  it('A reads A’s buffer, finds A’s message in search, sees A’s network', () => {
    const recent = callVerb('recent_messages', verbCtx(userAId), {
      networkId: netAId,
      target: SECRET_TARGET,
    }) as { messages: Array<{ id: number }> };
    expect(recent.messages.map((m) => m.id)).toContain(msgIdA);

    const search = callVerb('search_messages', verbCtx(userAId), { query: SECRET_TOKEN }) as {
      messages: Array<{ id: number }>;
    };
    expect(search.messages.map((m) => m.id)).toContain(msgIdA);

    const networks = callVerb('list_networks', verbCtx(userAId), {}) as Array<{ id: number }>;
    expect(networks.map((n) => n.id)).toContain(netAId);
  });
});

describe('DB isolation primitives', () => {
  it('getNetwork is user-scoped', () => {
    expect(getNetwork(netAId, userBId)).toBeUndefined();
    expect(getNetwork(netAId, userAId)).toBeDefined();
  });

  it('addBookmark cannot cross tenants (the messageId IDOR is closed)', () => {
    // B tries to bookmark A's message by id — must be a silent no-op so it
    // can't then be read back through B's bookmarks list.
    expect(addBookmark(userBId, msgIdA)).toBe(false);
    expect(listBookmarkIdsForUser(userBId)).toHaveLength(0);
    // Positive control: A's own bookmark is present.
    expect(listBookmarkIdsForUser(userAId)).toContain(msgIdA);
  });

  it('searchMessages is user-scoped at the SQL layer', () => {
    expect(searchMessages(userBId, { query: SECRET_TOKEN })).toHaveLength(0);
    expect(searchMessages(userAId, { query: SECRET_TOKEN }).length).toBeGreaterThan(0);
  });
});
