// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { listMessages, hasOlderRow } from '../../db/messages.js';
import { decorateMessage } from '../wsHub.js';

registerVerb({
  name: 'recent_messages',
  description: 'Fetch a window of recent messages for one buffer, oldest-first. Paginate backwards by passing the lowest id from a previous result as `before`.',
  scope: 'read',
  input: {
    type: 'object',
    properties: {
      networkId: {
        type: 'integer',
        description: 'The network id (from list_networks).',
      },
      target: {
        type: 'string',
        description: 'The buffer target — a channel name like "#foo" or a peer nick for a DM.',
      },
      limit: {
        type: 'integer',
        description: 'How many messages to return. Default 100, max 500.',
        minimum: 1,
        maximum: 500,
      },
      before: {
        type: 'integer',
        description: 'Optional. Return only messages with id < before, for backward pagination.',
      },
    },
    required: ['networkId', 'target'],
    additionalProperties: false,
  },
  handler(ctx, input) {
    const networkId = Number(input.networkId);
    const target = typeof input.target === 'string' ? input.target : '';
    if (!target) return { messages: [], hasOlder: false };
    const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
    const before = input.before ? Number(input.before) : undefined;
    const events = listMessages(networkId, target, { before, limit })
      .map((e) => decorateMessage(ctx.userId, e));
    const oldestId = events.length ? events[0].id : 0;
    return {
      messages: events,
      hasOlder: oldestId > 0 && hasOlderRow(networkId, target, oldestId),
    };
  },
});
