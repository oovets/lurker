<template>
  <span class="nick-ref" :class="{ self: isSelf }" :style="style">{{ nick }}</span>
</template>

<script setup>
import { computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { nickColor } from '../utils/nickColor.js';

const props = defineProps({
  nick: { type: String, required: true },
});

const networks = useNetworksStore();
const buffers = useBuffersStore();

const selfLower = computed(() => {
  const key = networks.activeKey;
  if (!key) return null;
  const buf = buffers.byKey(key);
  const sn = buf ? networks.states[buf.networkId]?.nick : null;
  return sn ? sn.toLowerCase() : null;
});

const isSelf = computed(() => {
  const sl = selfLower.value;
  return !!(sl && props.nick && props.nick.toLowerCase() === sl);
});

const style = computed(() => {
  if (isSelf.value) return null;
  const c = nickColor(props.nick);
  return c ? { color: c } : null;
});
</script>

<style scoped>
.nick-ref { color: inherit; }
.nick-ref.self { color: var(--fg); }
</style>
