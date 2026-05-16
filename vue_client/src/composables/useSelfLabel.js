// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';

// Self-identity label used in the input prompt and (compact) status bar:
//   [channel-prefix][nick](userModes)   e.g.  @bradleyroot(i)
// Plus a separate away label string like "(brb)" when /away is set.
//
// The channel-prefix is the user's own op/voice marker derived from the
// active channel's member list. For DMs / server buffers it's empty.
const PROMPT_PREFIX = { o: '@', h: '%', v: '+', a: '&', q: '~' };
const PROMPT_PREFIX_RANK = ['q', 'a', 'o', 'h', 'v'];

export function useSelfLabel() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();

  const active = computed(() => networks.activeBuffer);
  const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));

  const channelPrefix = computed(() => {
    const buf = buffer.value;
    if (!buf || !buf.target?.startsWith('#')) return '';
    const state = networks.states[buf.networkId];
    const nick = state?.nick;
    if (!nick) return '';
    const lc = nick.toLowerCase();
    const me = (buf.members || []).find((m) => ((m.nick || m).toLowerCase()) === lc);
    const modes = me && typeof me === 'object' ? (me.modes || []) : [];
    for (const letter of PROMPT_PREFIX_RANK) {
      if (modes.includes(letter)) return PROMPT_PREFIX[letter];
    }
    return '';
  });

  const promptLabel = computed(() => {
    if (!active.value) return '—';
    const state = networks.states[active.value.networkId];
    const nick = state?.nick;
    if (!nick) return '—';
    const modes = state?.userModes || '';
    const parens = modes ? `(${modes})` : '';
    return `${channelPrefix.value}${nick}${parens}`;
  });

  const awayLabel = computed(() => {
    if (!active.value) return '';
    // The server keeps `message` populated after /back so the buffer dividers
    // can render the completed pair — gate on `active` so the label
    // disappears when the user is no longer away.
    const away = networks.states[active.value.networkId]?.away;
    return away?.active && away.message ? `(${away.message})` : '';
  });

  return { promptLabel, awayLabel };
}
