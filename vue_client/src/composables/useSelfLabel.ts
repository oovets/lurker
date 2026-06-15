// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ComputedRef } from 'vue';
import { computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';

export interface SelfLabelState {
  promptLabel: ComputedRef<string>;
  promptLabelNoModes: ComputedRef<string>;
  awayLabel: ComputedRef<string>;
}

// Self-identity label used in the input prompt and (compact) status bar:
//   [channel-prefix][nick](userModes)   e.g.  @bradleyroot(i)
// Plus a separate away label string like "(brb)" when /away is set.
//
// The channel-prefix is the user's own op/voice marker derived from the
// active channel's member list. For DMs / server buffers it's empty.
const PROMPT_PREFIX: Record<string, string> = { o: '@', h: '%', v: '+', a: '&', q: '~' };
const PROMPT_PREFIX_RANK = ['q', 'a', 'o', 'h', 'v'];

export function useSelfLabel(): SelfLabelState {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();

  const active = computed(() => networks.activeBuffer);
  const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));

  const channelPrefix = computed(() => {
    const buf = buffer.value;
    if (!buf || !buf.target.startsWith('#')) return '';
    const nick = networks.states[buf.networkId]?.nick;
    if (!nick) return '';
    const lc = nick.toLowerCase();
    const me = buf.members.find((m) => m.nick.toLowerCase() === lc);
    const modes = me?.modes ?? [];
    for (const letter of PROMPT_PREFIX_RANK) {
      if (modes.includes(letter)) return PROMPT_PREFIX[letter];
    }
    return '';
  });

  // Identity without the trailing user-mode parens. Feeds the mobile input
  // placeholder, which mirrors the compact status bar's choice to drop modes
  // on narrow screens; the desktop prompt (promptLabel) keeps them.
  const promptLabelNoModes = computed(() => {
    const a = active.value;
    if (!a) return '—';
    const nick = networks.states[a.networkId]?.nick;
    if (!nick) return '—';
    return `${channelPrefix.value}${nick}`;
  });

  const promptLabel = computed(() => {
    const base = promptLabelNoModes.value;
    const a = active.value;
    if (!a || base === '—') return base;
    const modes = networks.states[a.networkId]?.userModes || '';
    return modes ? `${base}(${modes})` : base;
  });

  const awayLabel = computed(() => {
    if (!active.value) return '';
    // The server keeps `message` populated after /back so the buffer dividers
    // can render the completed pair — gate on `active` so the label
    // disappears when the user is no longer away.
    const away = networks.states[active.value.networkId]?.away;
    return away?.active && away.message ? `(${away.message})` : '';
  });

  return { promptLabel, promptLabelNoModes, awayLabel };
}
