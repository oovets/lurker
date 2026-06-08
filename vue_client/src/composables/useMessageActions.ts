// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { useBookmarksStore } from '../stores/bookmarks.js';

export interface MessageLike {
  id?: number | null;
  nick?: string;
  text?: string;
  self?: boolean;
  userhost?: string;
  networkId?: number;
  network_id?: number;
}

export interface MessageContext {
  networkId: number;
  onReply(message: MessageLike): void;
  onIgnore(message: MessageLike): void;
}

export interface MessageAction {
  key: 'reply' | 'copy' | 'save' | 'ignore';
  // Tooltip + accessible label for the icon button.
  label: string;
  // Font Awesome classes for the button glyph.
  icon: string;
  onClick(): void;
  // Toggles the "lit" treatment — currently only the bookmark when saved.
  active?: boolean;
}

export interface MessageActionsAPI {
  buildActions(
    message: MessageLike | null | undefined,
    ctx: MessageContext | null | undefined,
  ): MessageAction[];
}

// Single source of truth for the per-message actions rendered as the hover
// action bar in MessageList (issue #117 — replaced the kebab + context menu).
// The caller owns the component-local UI for the ignore confirmation
// (mirrors useMemberActions) and the reply hand-off to the composer, passing
// both in via `context`.
//
// `message` shape: { id, nick, text, self, userhost, network_id|networkId, ... }
// `context` shape: { networkId, onReply(message), onIgnore(message) }
export function useMessageActions(): MessageActionsAPI {
  const bookmarks = useBookmarksStore();

  function buildActions(
    message: MessageLike | null | undefined,
    ctx: MessageContext | null | undefined,
  ): MessageAction[] {
    if (!message || !ctx) return [];
    const actions: MessageAction[] = [];

    // Reply: prepend `nick: ` to the composer. Addressing your own line is
    // pointless, so self rows skip it (same gate as Ignore).
    if (!message.self && message.nick) {
      actions.push({
        key: 'reply',
        label: `Reply to ${message.nick}`,
        icon: 'fa-solid fa-reply',
        onClick: () => ctx.onReply(message),
      });
    }

    if (message.text) {
      actions.push({
        key: 'copy',
        label: 'Copy text',
        icon: 'fa-regular fa-copy',
        onClick: () => {
          if (!navigator.clipboard) return;
          navigator.clipboard.writeText(String(message.text || '')).catch(() => {});
        },
      });
    }

    // Bookmarks are only meaningful for messages with a stable server id.
    if (message.id != null) {
      const saved = bookmarks.isSaved(message.id);
      actions.push({
        key: 'save',
        label: saved ? 'Remove bookmark' : 'Save message',
        icon: saved ? 'fa-solid fa-bookmark' : 'fa-regular fa-bookmark',
        active: saved,
        onClick: () => bookmarks.toggle(message),
      });
    }

    // Ignoring your own messages doesn't make sense; the server uses the
    // user's hostmask for delivery, not ignore filtering.
    if (!message.self && message.nick) {
      actions.push({
        key: 'ignore',
        label: `Ignore ${message.nick}…`,
        icon: 'fa-solid fa-ban',
        onClick: () => ctx.onIgnore(message),
      });
    }

    return actions;
  }

  return { buildActions };
}
