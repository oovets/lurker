// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';
import { fanOutToUser } from '../wsHub.js';

registerVerb({
  name: 'set_nick_note',
  description: 'Write a free-form note about a nick on a network. Pass an empty string to clear the note. Notes are capped at 4096 chars.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      nick: { type: 'string' },
      note: {
        type: 'string',
        description: 'The note body. Empty/whitespace string deletes the note.',
        maxLength: 4096,
      },
    },
    required: ['networkId', 'nick', 'note'],
    additionalProperties: false,
  },
  handler(ctx, input) {
    const networkId = Number(input.networkId);
    const nick = typeof input.nick === 'string' ? input.nick.trim() : '';
    if (!nick) return { networkId, nick: '', note: '', updatedAt: null };
    const raw = typeof input.note === 'string' ? input.note : '';
    const note = raw.length > 4096 ? raw.slice(0, 4096) : raw;
    const saved = ircManager.setNickNote(ctx.userId, networkId, nick, note);
    const result = {
      networkId,
      nick,
      note: saved ? saved.note : '',
      updatedAt: saved ? saved.updatedAt : null,
    };
    // Fan out to every open WS tab of this user — both transports converge on
    // the same `nick-note-updated` event so the UI reacts identically whether
    // the change came from the browser or an agent.
    fanOutToUser(ctx.userId, { kind: 'nick-note-updated', ...result });
    return result;
  },
});
