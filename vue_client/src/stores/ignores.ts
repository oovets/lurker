// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';
import {
  compileIgnoreRules,
  evaluateIgnores,
  isMemberHidden,
  type IgnoreRule,
  type IgnoreInput,
  type IgnoreVerdict,
} from '../utils/ignoreMatch.js';

// Per-network ignore rules (issue #301). Server is the source of truth — adds/
// removes ship over WS and the server fans an `ignore-list-updated` event to
// every session (cross-device sync). Filtering happens client-side in
// MessageList's renderRows computed, so /unignore reveals previously-hidden rows
// without a backlog reload. Each entry is a full irssi-style rule (mask /
// channels / pattern / levels / except / expiry); ignoreMatch.ts evaluates it.

export interface IgnoreEntry extends IgnoreRule {
  id: number;
  createdAt: string;
}

export interface IgnoreEntryWithNetwork extends IgnoreEntry {
  networkId: number;
}

type Compiled = ReturnType<typeof compileIgnoreRules>;

// Compile lazily, keyed by the entry-array identity. applySnapshot/applyUpdate
// assign fresh arrays, so a replaced list misses the cache and recompiles; old
// arrays are GC'd. No manual invalidation, and reads of byNetwork[networkId]
// keep render-time computeds reactive.
const compiledCache = new WeakMap<object, Compiled>();
function compiledFor(list: IgnoreEntry[]): Compiled {
  let c = compiledCache.get(list);
  if (!c) {
    c = compileIgnoreRules(list);
    compiledCache.set(list, c);
  }
  return c;
}

export const useIgnoresStore = defineStore('ignores', {
  state: () => ({
    byNetwork: {} as Record<number | string, IgnoreEntry[]>,
  }),
  getters: {
    masksFor: (state) => (networkId: number | string) =>
      state.byNetwork[networkId] || state.byNetwork[Number(networkId)] || [],

    // The hot path called from MessageList. networkId may be a number or string
    // depending on call site (Vue templates often stringify keys).
    evaluate:
      (state) =>
      (networkId: number | string, ctx: IgnoreInput): IgnoreVerdict => {
        const list = state.byNetwork[networkId] || state.byNetwork[Number(networkId)] || [];
        if (list.length === 0) return { hide: false, nohilight: false };
        return evaluateIgnores(compiledFor(list), ctx);
      },

    isHidden:
      (state) =>
      (networkId: number | string, ctx: IgnoreInput): boolean => {
        const list = state.byNetwork[networkId] || state.byNetwork[Number(networkId)] || [];
        if (list.length === 0) return false;
        return evaluateIgnores(compiledFor(list), ctx).hide;
      },

    // Full-context "is this message hidden?" for surfaces that hold the message
    // object (search/highlights/bookmarks results). Unlike isIgnored it honors
    // level/channel/pattern rules, so a /ignore x PUBLIC or -pattern rule keeps
    // those messages out of search. Result rows carry the body as `body` and
    // omit `type` (they're always chat), so default type to 'message' — which
    // still resolves PUBLIC/MSGS/channel/pattern correctly.
    isMessageHidden:
      (state) =>
      (
        networkId: number | string,
        m: {
          nick?: string | null;
          userhost?: string | null;
          target: string;
          type?: string;
          text?: string | null;
          body?: string | null;
        },
      ): boolean => {
        if (!m.nick) return false;
        const list = state.byNetwork[networkId] || state.byNetwork[Number(networkId)] || [];
        if (list.length === 0) return false;
        return evaluateIgnores(compiledFor(list), {
          nick: m.nick,
          userhost: m.userhost ?? null,
          target: m.target,
          text: m.text ?? m.body ?? '',
          type: m.type ?? 'message',
          isDm: !m.target.startsWith('#') && !m.target.startsWith(':server:'),
        }).hide;
      },

    // "Is this sender broadly ignored?" — a non-except, no-pattern, ALL-level
    // rule that hides them regardless of content (no channel scope, so applies
    // everywhere). For nick-only callers that have no message context
    // (autocomplete, the typing indicator). A NOHIGHLIGHT, content-pattern,
    // single-level, or channel-scoped rule deliberately does NOT count here —
    // those need full event context (use isMessageHidden / isHidden).
    isIgnored:
      (state) =>
      (networkId: number | string, nick: string, userhost: string): boolean => {
        const list = state.byNetwork[networkId] || state.byNetwork[Number(networkId)] || [];
        if (list.length === 0) return false;
        return isMemberHidden(compiledFor(list), nick, userhost || null, '');
      },

    // Nicklist filter — only whole-identity ALL rules remove a member (see
    // isMemberHidden). channel is the open buffer's target.
    isMemberHidden:
      (state) =>
      (
        networkId: number | string,
        nick: string,
        userhost: string | null,
        channel: string,
      ): boolean => {
        const list = state.byNetwork[networkId] || state.byNetwork[Number(networkId)] || [];
        if (list.length === 0) return false;
        return isMemberHidden(compiledFor(list), nick, userhost, channel);
      },

    allEntries: (state): IgnoreEntryWithNetwork[] => {
      const out: IgnoreEntryWithNetwork[] = [];
      for (const [networkId, list] of Object.entries(state.byNetwork)) {
        for (const entry of list || []) out.push({ ...entry, networkId: Number(networkId) });
      }
      return out;
    },
  },
  actions: {
    applySnapshot(networks: any[]) {
      const next: Record<number | string, IgnoreEntry[]> = {};
      for (const n of networks || []) {
        if (n?.networkId != null) next[n.networkId] = [...(n.ignoredMasks || [])];
      }
      this.byNetwork = next;
    },
    applyUpdate(networkId: number | string, masks: IgnoreEntry[]) {
      if (!networkId) return;
      this.byNetwork[networkId] = [...(masks || [])];
    },
    // Add a full rule (from the /ignore parser). The server re-validates.
    addRule(networkId: number | string, rule: IgnoreRule) {
      if (!networkId) return;
      socketSend({ type: 'add-ignore', networkId, rule });
    },
    // Remove by id (from the listed index) or by mask string.
    removeRule(networkId: number | string, by: { id?: number; mask?: string }) {
      if (!networkId) return;
      if (by.id == null && !by.mask) return;
      socketSend({ type: 'remove-ignore', networkId, id: by.id, mask: by.mask });
    },
    // Shim for the quick-ignore modal, which only knows a mask: an ALL-level
    // rule. The server expands a bare `mask` the same way.
    addMask(networkId: number | string, mask: string) {
      const trimmed = (mask || '').trim();
      if (!networkId || !trimmed) return;
      socketSend({ type: 'add-ignore', networkId, mask: trimmed });
    },
    // Remove every rule matching a bare mask string (server deletes by mask).
    removeMask(networkId: number | string, mask: string) {
      const trimmed = (mask || '').trim();
      if (!trimmed) return;
      this.removeRule(networkId, { mask: trimmed });
    },
  },
});
