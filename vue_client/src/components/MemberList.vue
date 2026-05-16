<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<template>
  <div class="members">
    <ul>
      <li
        v-for="m in sorted"
        :key="nickOf(m)"
        :class="liClass(m)"
        @click="onRowClick($event, m)"
        @contextmenu.prevent="onRowContextMenu($event, m)"
      >
        <span class="prefix">{{ prefixOf(m) }}</span>
        <span class="nick" :style="nickStyle(m)">{{ nickOf(m) }}</span>
        <button
          v-if="!isSelf(m)"
          type="button"
          class="row-actions"
          title="Actions"
          aria-label="Member actions"
          @click.stop="onActionsClick($event, m)"
          @contextmenu.stop.prevent
        ><i class="fa-solid fa-ellipsis-vertical"></i></button>
      </li>
    </ul>
    <IgnoreModal
      v-if="modalMember"
      :nick="nickOf(modalMember)"
      :user="userOf(modalMember)"
      :host="hostOf(modalMember)"
      :network-id="buffer?.networkId"
      @close="modalMember = null"
    />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNickColors } from '../composables/useNickColors.js';
import { useMemberActions } from '../composables/useMemberActions.js';
import { useIgnoresStore } from '../stores/ignores.js';
import IgnoreModal from './IgnoreModal.vue';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const nicks = useNickColors();
const memberActions = useMemberActions();
const ignores = useIgnoresStore();
const modalMember = ref(null);

const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));
const members = computed(() => buffer.value?.members || []);
const selfNick = computed(() => {
  const b = buffer.value;
  if (!b) return null;
  return networks.states[b.networkId]?.nick || null;
});

function isSelf(m) {
  const sn = selfNick.value;
  return !!sn && nickOf(m).toLowerCase() === sn.toLowerCase();
}
function nickStyle(m) {
  // Away members render in a flat muted color — the .away CSS rule wins
  // regardless of inline style, but skipping the inline color keeps the DOM
  // honest.
  if (isAway(m)) return null;
  if (isSelf(m)) return { color: nicks.selfColor.value };
  const c = nicks.color(nickOf(m));
  return c ? { color: c } : null;
}

const PREFIX_ORDER = ['~', '&', '@', '%', '+', ''];

function nickOf(m) { return typeof m === 'string' ? m : m.nick; }
function userOf(m) { return typeof m === 'object' && m?.user ? m.user : null; }
function hostOf(m) { return typeof m === 'object' && m?.host ? m.host : null; }
function modesOf(m) { return Array.isArray(m?.modes) ? m.modes : []; }

// Click handlers funnel through one builder so right-click, row-click
// (mobile tap, desktop click — member rows have no other action), and the
// hover three-dots all open the same menu. Anchor by event coords for the
// row paths and by button rect for the three-dots so the popup drops out
// from the affordance the user actually pointed at.
function menuContext() {
  return {
    networkId: buffer.value?.networkId,
    isSelf,
    onIgnore: (m) => { modalMember.value = m; },
  };
}
function onRowClick(e, m) {
  if (!buffer.value || isSelf(m)) return;
  memberActions.openMenuFor(m, menuContext(), e.clientX, e.clientY);
}
function onRowContextMenu(e, m) {
  if (!buffer.value || isSelf(m)) return;
  memberActions.openMenuFor(m, menuContext(), e.clientX, e.clientY);
}
function onActionsClick(e, m) {
  if (!buffer.value || isSelf(m)) return;
  memberActions.openMenuFromButton(m, menuContext(), e.currentTarget);
}
function prefixOf(m) {
  const modes = modesOf(m);
  if (modes.includes('q')) return '~';
  if (modes.includes('a')) return '&';
  if (modes.includes('o')) return '@';
  if (modes.includes('h')) return '%';
  if (modes.includes('v')) return '+';
  return '';
}
function prefixClass(m) {
  const p = prefixOf(m);
  return p ? `mode-${p}` : '';
}
function isAway(m) { return typeof m === 'object' && !!m?.away; }
function liClass(m) {
  const classes = [];
  const p = prefixClass(m);
  if (p) classes.push(p);
  if (isAway(m)) classes.push('away');
  return classes;
}

const sorted = computed(() => {
  const networkId = buffer.value?.networkId;
  const list = members.value;
  // Self is always visible — guards against the corner case of a mask
  // matching the user's own nick (or a hostmask the server-side nick
  // happens to fall into) which would otherwise vanish them from their
  // own nicklist.
  const filtered = networkId
    ? list.filter((m) => {
        if (isSelf(m)) return true;
        const nick = nickOf(m);
        const userhost = m && typeof m === 'object' && m.user && m.host
          ? `${nick}!${m.user}@${m.host}`
          : null;
        return !ignores.isIgnored(networkId, nick, userhost);
      })
    : list;
  return [...filtered].sort((a, b) => {
    const pa = PREFIX_ORDER.indexOf(prefixOf(a));
    const pb = PREFIX_ORDER.indexOf(prefixOf(b));
    if (pa !== pb) return pa - pb;
    return nickOf(a).localeCompare(nickOf(b), undefined, { sensitivity: 'base' });
  });
});
</script>

<style scoped>
.members { display: flex; flex-direction: column; height: 100%; min-height: 0; }
ul {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
li {
  display: flex;
  align-items: baseline;
  gap: 2px;
  padding: 1px 10px;
  user-select: none;
  cursor: pointer;
  position: relative;
}
li:hover { background: var(--bg-soft); }

/* Hover affordance — invisible until the row is hovered, then drops in from
   the right edge of the row. Hidden entirely on touch breakpoints; mobile
   uses tap-anywhere-on-row to open the same menu. */
.row-actions {
  margin-left: auto;
  padding: 0 2px;
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  line-height: 1;
  opacity: 0;
  transition: opacity 80ms linear;
}
li:hover .row-actions,
.row-actions:focus-visible { opacity: 1; }
.row-actions:hover { color: var(--fg); }
@media (max-width: 768px) {
  .row-actions { display: none; }
}
.prefix { width: 10px; text-align: center; color: var(--fg-muted); }
li.mode-\~ .prefix { color: var(--member-owner); }
li.mode-\& .prefix { color: var(--member-admin); }
li.mode-\@ .prefix { color: var(--member-op); }
li.mode-\% .prefix { color: var(--member-halfop); }
li.mode-\+ .prefix { color: var(--member-voice); }
.nick { color: var(--accent); }
/* Away nicks lose all per-user color and render in a flat muted gray. The
   rule overrides the inline nickStyle (which is suppressed for away anyway)
   and the prefix mode colors so the whole row reads as inert. */
li.away .nick,
li.away .prefix { color: var(--fg-muted) !important; }
</style>
