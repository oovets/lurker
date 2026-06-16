<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div
    v-if="open && rows.length"
    ref="panelEl"
    class="channel-picker"
    :style="panelStyle"
    @pointerdown.stop
    @mousedown.prevent.stop
  >
    <!-- Same iOS focus-preservation contract as NickPicker: act on `click`
         (end of touch), keep `@mousedown.prevent` so focus never leaves the
         textarea, and use a plain <div role=button> rather than a focusable
         <button>. Emitting on pointerdown would close the picker (v-if)
         mid-touch and defeat the focus guard. -->
    <div
      v-for="row in renderedRows"
      :key="row.name + ':' + row.index"
      role="button"
      class="row"
      :class="{ active: row.index === activeIndex }"
      @mousedown.prevent
      @click="pick(row.name)"
      @mouseenter="activeIndex = row.index"
    >
      <span class="channel">{{ row.name }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useBuffersStore } from '../stores/buffers.js';
import { buildChannelCandidates } from '../utils/channelCompletion.js';

const props = withDefaults(
  defineProps<{
    open?: boolean;
    // The raw `#`-prefixed token under the cursor; the leading '#' stays in
    // both the match filter and the inserted result.
    query?: string;
    networkId?: number | null;
    anchor?: HTMLElement | null;
  }>(),
  {
    open: false,
    query: '',
    networkId: null,
    anchor: null,
  },
);

const emit = defineEmits<{
  select: [channel: string];
  close: [];
}>();

const buffers = useBuffersStore();
const panelEl = ref<HTMLElement | null>(null);
const panelBottom = ref(8);

// Index into `rows` (candidate order, 0 = best match) of the keyboard-
// highlighted entry. Rows render bottom-up — see `renderedRows` — so index 0
// sits visually at the bottom, nearest the input bar.
const activeIndex = ref(0);

const rows = computed(() => {
  // Bail before touching the buffers store while closed: a computed only
  // tracks the deps it reads, so this early return keeps `rows` (and the watch
  // that subscribes to it) from rebuilding the candidate list on every buffer
  // mutation behind a closed picker. The panel's v-if gates on `open` anyway,
  // so returning [] here is behavior-neutral.
  if (!props.open || props.networkId == null) return [];
  return buildChannelCandidates(buffers.forNetwork(props.networkId), props.query)
    .slice(0, 50)
    .map((name, index) => ({ name, index }));
});

// The panel opens upward, so render candidates worst-to-best top-to-bottom —
// the most likely pick lands at the bottom, right under the user's eye and
// closest to the input bar.
const renderedRows = computed(() => rows.value.slice().reverse());

function pick(channel: string) {
  emit('select', channel);
}

// Keyboard navigation, driven from MessageInput's textarea keydown handler:
// the textarea keeps focus while the picker is open, so the picker never
// receives key events itself. `delta` is in candidate-index space — +1 steps
// toward worse matches (visually up), -1 toward the best match (visually
// down) — and clamps at both ends rather than wrapping.
function moveActive(delta: number) {
  const n = rows.value.length;
  if (n === 0) return;
  activeIndex.value = Math.min(Math.max(activeIndex.value + delta, 0), n - 1);
  // Keyboard moves can land on a row scrolled out of the panel — pull it back
  // in. Mouse hover also sets activeIndex (see @mouseenter) but a hovered row
  // is necessarily already visible, so the scroll lives here rather than in a
  // blanket watch(activeIndex).
  nextTick(scrollActiveIntoView);
}

function confirmActive() {
  const row = rows.value[activeIndex.value];
  if (row) pick(row.name);
}

function hasCandidates() {
  return rows.value.length > 0;
}

defineExpose({ moveActive, confirmActive, hasCandidates });

function scrollActiveIntoView() {
  const el = panelEl.value?.querySelector('.row.active');
  if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
}

function recomputePosition() {
  // Anchor the picker just above the input bar, riding above the iOS soft
  // keyboard via visualViewport.height. Without this, the picker gets occluded
  // as soon as the keyboard slides up.
  const anchor = props.anchor;
  if (!anchor) {
    panelBottom.value = 8;
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const vv = window.visualViewport;
  const viewportHeight = vv ? vv.height : window.innerHeight;
  // Distance from bottom of viewport to top of anchor.
  const distance = viewportHeight - rect.top;
  panelBottom.value = Math.max(distance + 4, 8);
}

const panelStyle = computed(() => ({ bottom: `${panelBottom.value}px` }));

function onDocPointerDown(e: PointerEvent) {
  if (!props.open) return;
  const panel = panelEl.value;
  const anchor = props.anchor;
  if (panel && panel.contains(e.target as Node)) return;
  if (anchor && anchor.contains(e.target as Node)) return;
  emit('close');
}

function onKey(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key === 'Escape') emit('close');
}

onMounted(() => {
  recomputePosition();
  window.addEventListener('resize', recomputePosition);
  window.visualViewport?.addEventListener('resize', recomputePosition);
  window.visualViewport?.addEventListener('scroll', recomputePosition);
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', recomputePosition);
  window.visualViewport?.removeEventListener('resize', recomputePosition);
  window.visualViewport?.removeEventListener('scroll', recomputePosition);
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('keydown', onKey);
});

// A new candidate set (the query changed, or buffers were re-filtered)
// re-anchors the highlight on the best match and pulls it back into view.
watch(rows, () => {
  activeIndex.value = 0;
  nextTick(scrollActiveIntoView);
});

watch(
  () => props.open,
  (v) => {
    if (v) {
      activeIndex.value = 0;
      recomputePosition();
      nextTick(scrollActiveIntoView);
    }
  },
);
</script>

<style scoped>
.channel-picker {
  position: fixed;
  left: var(--space-4);
  right: var(--space-4);
  max-width: 480px;
  margin: 0 auto;
  max-height: 50vh;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover-up);
  z-index: var(--z-popover);
}
.row {
  display: flex;
  align-items: center;
  padding: var(--space-6);
  min-height: 44px;
  cursor: pointer;
  user-select: none;
}
/* Single highlight, shared by mouse and keyboard: hovering a row sets
   activeIndex (see @mouseenter), so .active alone covers both — no separate
   :hover rule that could double-highlight during keyboard nav. Soft neutral
   fill matches the context menu / Cmd-K list. */
.row.active {
  background: var(--bg-soft);
}
.channel {
  font-weight: 500;
}
</style>
