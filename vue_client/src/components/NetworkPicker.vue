<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  First step of the add-network flow (#169): a searchable, tag-filterable list
  of well-known IRC networks. Picking one prefills NetworkForm with its verified
  host/port/TLS so a new user just enters a nick; "enter details manually" drops
  to the blank form. Content-only (no modal shell) — NetworkForm hosts it.
-->

<template>
  <div class="picker">
    <input
      v-model="query"
      class="search"
      type="search"
      placeholder="Search networks…"
      autocomplete="off"
      spellcheck="false"
      aria-label="Search networks"
    />

    <div v-if="builtinNetworkTags.length" class="tags" role="group" aria-label="Filter by tag">
      <button
        v-for="tag in builtinNetworkTags"
        :key="tag"
        type="button"
        class="tag-chip"
        :class="{ on: active.has(tag) }"
        :aria-pressed="active.has(tag)"
        @click="toggleTag(tag)"
      >
        {{ tag }}
      </button>
    </div>

    <ul class="list">
      <li v-for="net in filtered" :key="net.name">
        <button type="button" class="net-row" @click="$emit('select', net)">
          <span class="net-head">
            <span class="net-name">{{ net.name }}</span>
            <span v-if="net.tags.length" class="net-tags">
              <span v-for="tag in net.tags" :key="tag" class="net-tag">{{ tag }}</span>
            </span>
          </span>
          <span class="net-stats">
            <span
              v-if="net.users != null"
              class="stat"
              :title="`~${net.users.toLocaleString()} users (netsplit.de average)`"
            >
              <i class="fa-solid fa-users"></i> {{ formatCount(net.users) }}
            </span>
            <span
              v-if="net.channels != null"
              class="stat"
              :title="`~${net.channels.toLocaleString()} channels (netsplit.de average)`"
            >
              <i class="fa-solid fa-hashtag"></i> {{ formatCount(net.channels) }}
            </span>
          </span>
        </button>
      </li>
      <li v-if="!filtered.length" class="none">No networks match.</li>
    </ul>

    <button type="button" class="manual" @click="$emit('manual')">
      Enter details manually →
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import {
  builtinNetworks,
  builtinNetworkTags,
  type BuiltinNetwork,
} from '../utils/builtinNetworks.js';

defineEmits<{ select: [net: BuiltinNetwork]; manual: [] }>();

const query = ref('');
const active = reactive(new Set<string>());

function toggleTag(tag: string): void {
  if (active.has(tag)) active.delete(tag);
  else active.add(tag);
}

// Compact popularity label: 32976 -> "33k", 9208 -> "9.2k", 100 -> "100".
function formatCount(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

// Text search narrows by name/host; tag chips are OR'd (a network shows if it
// carries ANY selected tag) so adding chips broadens discovery rather than
// quickly emptying the list. The two filters AND together.
const filtered = computed<BuiltinNetwork[]>(() => {
  const q = query.value.trim().toLowerCase();
  const tags = [...active];
  return builtinNetworks.filter((n) => {
    if (q && !n.name.toLowerCase().includes(q)) return false;
    if (tags.length && !tags.some((t) => n.tags.includes(t))) return false;
    return true;
  });
});
</script>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  flex: 1;
  min-height: 0;
}
.search {
  color: var(--fg);
  width: 100%;
  box-sizing: border-box;
}
/* Squared tray of toggle buttons, styled after the message-list hover action
   bar (.row-actions): bordered container, square corners, subtle --bg-soft
   hover, --accent when on. */
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-1);
}
.tag-chip {
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg-muted);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
  text-transform: lowercase;
}
.tag-chip:hover {
  color: var(--fg);
  background: var(--bg-soft);
}
.tag-chip.on {
  background: var(--accent);
  color: var(--bg);
}
/* Breakout so the scrollbar sits against the card edge, matching net-form. */
.list {
  list-style: none;
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.net-row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-1);
  width: 100%;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius);
  padding: var(--space-3);
  cursor: pointer;
}
.net-row:hover {
  background: var(--bg-soft);
  border-color: var(--border);
}
.net-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  justify-content: space-between;
}
.net-name {
  color: var(--fg);
  font-weight: 600;
}
/* Tags sit top-right opposite the name; wrap toward the right edge. */
.net-tags {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-1);
}
/* Counts sit under the name. */
.net-stats {
  display: flex;
  gap: var(--space-3);
  color: var(--fg-muted);
  white-space: nowrap;
}
.stat i {
  opacity: 0.75;
}
.net-tag {
  color: var(--fg-muted);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
}
.none {
  color: var(--fg-muted);
  padding: var(--space-4);
  text-align: center;
}
.manual {
  align-self: flex-start;
  background: transparent;
  border: 0;
  padding: var(--space-2) 0;
  color: var(--accent);
  cursor: pointer;
  text-transform: lowercase;
}
.manual:hover {
  text-decoration: underline;
}
</style>
