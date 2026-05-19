// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { getNote } from '../../db/nickNotes.js';

registerVerb({
  name: 'get_nick_note',
  description: 'Read the caller\'s free-form note about a nick on a network. Returns an empty note string when no note exists.',
  scope: 'read',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      nick: { type: 'string' },
    },
    required: ['networkId', 'nick'],
    additionalProperties: false,
  },
  handler(ctx, input) {
    const networkId = Number(input.networkId);
    const nick = typeof input.nick === 'string' ? input.nick.trim() : '';
    if (!nick) return { networkId, nick: '', note: '', updatedAt: null };
    const row = getNote({ userId: ctx.userId, networkId, nick });
    return {
      networkId,
      nick,
      note: row?.note || '',
      updatedAt: row?.updatedAt || null,
    };
  },
});
