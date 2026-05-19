// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { searchMessages } from '../../db/messages.js';
import { decorateMessage } from '../wsHub.js';

registerVerb({
  name: 'search_messages',
  description: 'Full-text search across the caller\'s message history. Returns matches newest-first; paginate by passing the lowest id as `before`.',
  scope: 'read',
  input: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Free-text query. Multiple whitespace-separated terms are ANDed together.',
      },
      networkId: {
        type: 'integer',
        description: 'Optional. Restrict the search to a single network. Omit to search every network the caller owns.',
      },
      target: {
        type: 'string',
        description: 'Optional. Restrict to a single buffer target (channel name or peer nick).',
      },
      nick: {
        type: 'string',
        description: 'Optional. Restrict to messages from a specific nick.',
      },
      limit: {
        type: 'integer',
        description: 'How many matches to return. Default 50, max 100.',
        minimum: 1,
        maximum: 100,
      },
      before: {
        type: 'integer',
        description: 'Optional. Return only matches with id < before, for backward pagination.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler(ctx, input) {
    const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 100);
    const results = searchMessages(ctx.userId, {
      query: typeof input.query === 'string' ? input.query : '',
      networkId: input.networkId ? Number(input.networkId) : undefined,
      target: typeof input.target === 'string' && input.target ? input.target : undefined,
      nick: typeof input.nick === 'string' && input.nick ? input.nick : undefined,
      before: input.before ? Number(input.before) : undefined,
      limit,
    }).map((e) => decorateMessage(ctx.userId, e));
    return {
      messages: results,
      hasMore: results.length === limit,
    };
  },
});
