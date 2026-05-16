<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<!--
  Single row for a historical message shown out of buffer context
  (search results, highlights list, etc). Header strip shows where
  and when the message happened ("network/channel" matching the
  status bar, plus the time); the body reads like a real chat line —
  nick with its standard color, then the message text.
-->

<template>
  <li
    :class="{ row: true, active }"
    @click="$emit('jump', message)"
    @mouseenter="$emit('hover')"
  >
    <div class="head">
      <div class="where">
        <template v-if="targetLabel"><span class="net">{{ networkLabel }}/</span><span class="target">{{ targetLabel }}</span></template>
        <span v-else class="net">{{ networkLabel }}</span>
      </div>
      <span class="time">{{ time }}</span>
    </div>
    <div class="body">
      <span class="nick" :style="nickStyle">{{ message.nick }}</span>
      <span class="sep">|</span>
      <span class="text">{{ message.text }}</span>
    </div>
  </li>
</template>

<script setup>
import { computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { useNickColors } from '../composables/useNickColors.js';
import { formatTimestamp } from '../utils/timestamp.js';

const props = defineProps({
  message: { type: Object, required: true },
  active: { type: Boolean, default: false },
});

defineEmits(['jump', 'hover']);

const networks = useNetworksStore();
const settings = useSettingsStore();
const nicks = useNickColors();

const tsFormat = computed(() => settings.effective('look.buffer.time_format'));
const selfColor = computed(() => settings.effective('look.nick.self_color'));

const time = computed(() => formatTimestamp(props.message.time, tsFormat.value));

const networkLabel = computed(() => {
  const m = props.message;
  return m.networkName || networks.networks.find((n) => n.id === m.networkId)?.name || `net:${m.networkId}`;
});

// Drop the `:server:<id>` pseudo-target so server messages render as just
// the network name (matches StatusBar.vue's buffer segment).
const targetLabel = computed(() => {
  const t = props.message.target;
  if (!t || t.startsWith(':server:')) return '';
  return t;
});

const nickStyle = computed(() => {
  if (props.message.self) return { color: selfColor.value };
  const c = nicks.color(props.message.nick);
  return c ? { color: c } : null;
});
</script>

<style scoped>
.row {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.row:hover,
.row.active { background: var(--bg-soft); }

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  color: var(--fg-muted);
  margin-bottom: 6px;
}
.where {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.net { color: var(--fg-muted); }
.target { color: var(--accent); }
.time { flex-shrink: 0; }

.body {
  white-space: pre-wrap;
  word-break: break-word;
}
.nick { font-weight: 600; }
.sep {
  color: var(--border);
  margin: 0 0.5ch;
}
</style>
