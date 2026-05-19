// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import express from 'express';
import { callVerb, listVerbs } from './verbRegistry.js';

// Hand-rolled MCP-over-HTTP. The transport spec ("Streamable HTTP") is mostly
// JSON-RPC 2.0 with two extras we don't need yet: server→client streaming via
// SSE (we have no subscriptions), and resumable sessions via Mcp-Session-Id
// (we're stateless — every request reauthenticates by bearer token). Single
// POST per call carries the request and returns the response inline.
//
// We implement four methods:
//   initialize                 — capability handshake.
//   notifications/initialized  — client ack of initialize. No response.
//   tools/list                 — enumerate verbs the caller can invoke.
//   tools/call                 — invoke a verb by name with arguments.
//
// JSON-RPC errors are reserved for protocol problems (bad envelope, unknown
// method, missing tool name). Verb-level failures (`{ ok: false, error: ...}`
// from send_message, `unknown_network` from the registry boundary) come back
// as a normal tool result so the agent can branch on the value rather than
// catching a protocol error.

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'lurker', version: '0.1.0' };

const router = express.Router();

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

router.post('/', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.json(jsonRpcError(null, -32600, 'Invalid Request'));
  }
  const id = body.id ?? null;
  const isNotification = !('id' in body);

  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    if (isNotification) return res.status(204).end();
    return res.json(jsonRpcError(id, -32600, 'Invalid Request'));
  }

  try {
    let result;
    switch (body.method) {
      case 'initialize': {
        // Client passes its preferred protocolVersion in params; we echo back
        // the one we implement. Mismatches are negotiated client-side.
        result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        };
        break;
      }
      case 'notifications/initialized': {
        return res.status(204).end();
      }
      case 'tools/list': {
        result = { tools: listVerbs(req.apiToken.scope) };
        break;
      }
      case 'tools/call': {
        const params = body.params || {};
        const name = params.name;
        const args = params.arguments || {};
        if (typeof name !== 'string' || !name) {
          return res.json(jsonRpcError(id, -32602, 'Missing tool name'));
        }
        let toolPayload;
        let isError = false;
        try {
          toolPayload = callVerb(
            name,
            { userId: req.user.id, scope: req.apiToken.scope, transport: 'mcp' },
            args,
          );
        } catch (err) {
          isError = true;
          toolPayload = { error: err.code || 'error', message: err.message };
        }
        result = {
          content: [{ type: 'text', text: JSON.stringify(toolPayload) }],
          isError,
        };
        break;
      }
      default: {
        if (isNotification) return res.status(204).end();
        return res.json(jsonRpcError(id, -32601, `Method not found: ${body.method}`));
      }
    }
    if (isNotification) return res.status(204).end();
    return res.json({ jsonrpc: '2.0', id, result });
  } catch (err) {
    if (isNotification) return res.status(204).end();
    return res.json(jsonRpcError(id, -32603, 'Internal error', err.message));
  }
});

export default router;
