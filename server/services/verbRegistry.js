// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { ownsNetwork } from '../db/networks.js';

// Single registry of transport-agnostic verbs the MCP server and (where it
// makes sense) the WS hub both call into. Each verb declares a name, a
// human-readable description, a scope ('read' or 'read-write'), a JSON
// Schema describing its inputs (published verbatim through MCP tools/list),
// and a handler.
//
// Registration happens at module import time inside each verb file under
// services/verbs/. The aggregator services/verbs/index.js imports all of them
// so a single side-effecting import wires up the full surface.

const verbs = new Map();

const VALID_SCOPES = new Set(['read', 'read-write']);

export function registerVerb({ name, description, scope, input, handler }) {
  if (typeof name !== 'string' || !name) throw new Error('verb name required');
  if (verbs.has(name)) throw new Error(`duplicate verb: ${name}`);
  if (!VALID_SCOPES.has(scope)) throw new Error(`invalid scope for ${name}: ${scope}`);
  if (typeof handler !== 'function') throw new Error(`handler required for ${name}`);
  verbs.set(name, {
    name,
    description: description || '',
    scope,
    input: input || { type: 'object', properties: {}, additionalProperties: false },
    handler,
  });
}

export function getVerb(name) {
  return verbs.get(name) || null;
}

// Lists verbs the caller can actually invoke. A read-only token sees only
// read verbs in tools/list — there's no point advertising a tool the agent
// will be 403'd on.
export function listVerbs(callerScope) {
  const out = [];
  for (const verb of verbs.values()) {
    if (verb.scope === 'read-write' && callerScope !== 'read-write') continue;
    out.push({ name: verb.name, description: verb.description, inputSchema: verb.input });
  }
  return out;
}

// Universal boundary: scope check + network-ownership check. Verbs trust ctx
// to carry an authenticated userId and the granted scope. Anything with a
// numeric networkId in the input gets ownership-checked here rather than at
// each call site; verbs are still free to do additional structural validation
// in their handlers.
export function callVerb(name, ctx, input) {
  const verb = verbs.get(name);
  if (!verb) {
    const err = new Error(`unknown verb: ${name}`);
    err.code = 'unknown_verb';
    throw err;
  }
  if (verb.scope === 'read-write' && ctx.scope !== 'read-write') {
    const err = new Error(`scope insufficient: ${name} requires read-write`);
    err.code = 'forbidden';
    throw err;
  }
  if (input && input.networkId != null) {
    const networkId = Number(input.networkId);
    if (!Number.isInteger(networkId) || networkId <= 0 || !ownsNetwork(ctx.userId, networkId)) {
      const err = new Error('unknown network');
      err.code = 'unknown_network';
      throw err;
    }
  }
  return verb.handler(ctx, input || {});
}

// Test-only: wipe the registry between cases. Real code should never call
// this; the registry is intended to be populated once at process start.
export function __resetForTests() {
  verbs.clear();
}
