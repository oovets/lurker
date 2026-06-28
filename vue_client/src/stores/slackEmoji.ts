// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-network registry of Slack workspace-custom emoji (shortcode name → image
// URL). Fetched once per network from `/api/networks/:id/slack-emoji` and cached
// for the session. Consulted by the message renderer, reaction chips, and the
// `:shortcode:` autocomplete to surface + render custom emoji the Unicode set
// can't represent. Non-Slack networks just resolve to an empty map.

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api.js';
import { rankShortcodes } from '../utils/emojiShortcodes.js';

export const useSlackEmojiStore = defineStore('slackEmoji', () => {
  // networkId → { name: url }. A plain reactive record so any render reading
  // url()/search() repaints once a network's map lands.
  const byNetwork = ref<Record<number, Record<string, string>>>({});
  // networkIds with a fetch in flight or done, so ensure() runs at most once.
  const requested = new Set<number>();

  async function ensure(networkId: number | null | undefined): Promise<void> {
    if (networkId == null || requested.has(networkId)) return;
    requested.add(networkId);
    try {
      const { emoji } = await api<{ emoji: Record<string, string> }>(
        `/api/networks/${networkId}/slack-emoji`,
      );
      byNetwork.value = { ...byNetwork.value, [networkId]: emoji || {} };
    } catch {
      // Leave the network absent; a later ensure() won't retry (requested), but
      // a fresh network id will. Renders fall back to shortcode text.
      requested.delete(networkId);
    }
  }

  // The image URL for a custom emoji on a network, or null if unknown.
  function url(networkId: number | null | undefined, name: string): string | null {
    if (networkId == null) return null;
    return byNetwork.value[networkId]?.[name] ?? null;
  }

  // Ranked custom-emoji matches for the autocomplete: [{ name, url }].
  function search(
    networkId: number | null | undefined,
    query: string,
    limit = 12,
  ): Array<{ name: string; url: string }> {
    if (networkId == null) return [];
    const map = byNetwork.value[networkId];
    if (!map) return [];
    return rankShortcodes(Object.keys(map), query)
      .slice(0, limit)
      .map((name) => ({ name, url: map[name] }));
  }

  return { byNetwork, ensure, url, search };
});
