<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Previous-input recall menu — the pointer-driven counterpart to Up-arrow
  history. Opened by tapping the `>` prompt (see MessageInput), it lists the
  buffer's recent submitted lines so mobile users, who have no arrow keys, can
  still reach their input history (issue #204). Picking a row replaces the
  composer outright, exactly like an Up-arrow recall — editable, not sent.

  Modelled on ChannelPicker: a position:fixed popover anchored above the input
  bar and kept clear of the iOS soft keyboard via visualViewport. Tap-only by
  design — Up/Down already serve keyboard users — so there's no externally
  driven activeIndex; a plain :hover highlight is enough.
-->

<template>
  <div
    v-if="open && rows.length"
    ref="panelEl"
    class="history-picker"
    :style="panelStyle"
    @pointerdown.stop
    @mousedown.prevent.stop
  >
    <!-- Same iOS focus-preservation contract as ChannelPicker: act on `click`
         (end of touch), keep `@mousedown.prevent` so focus never leaves the
         textarea, and use a plain <div role=button> rather than a focusable
         <button>. Emitting on pointerdown would close the picker (v-if)
         mid-touch and defeat the focus guard. -->
    <div
      v-for="(entry, i) in rows"
      :key="i + ':' + entry"
      role="button"
      class="row"
      :title="entry"
      @mousedown.prevent
      @click="pick(entry)"
    >
      <span class="entry">{{ entry }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';

const props = withDefaults(
  defineProps<{
    open?: boolean;
    // Buffer history in chronological order (oldest first) — the same slice
    // Up-arrow walks. Rendered as-is so the newest line sits at the bottom,
    // nearest the input bar and matching the first Up-arrow recall.
    entries?: readonly string[];
    // The input form, used to position the panel above the bar.
    anchor?: HTMLElement | null;
    // The `>` toggle button. Taps on it must not dismiss the panel (its own
    // click handler owns open/close) — everything else outside the panel does.
    toggleEl?: HTMLElement | null;
  }>(),
  {
    open: false,
    entries: () => [],
    anchor: null,
    toggleEl: null,
  },
);

const emit = defineEmits<{
  select: [entry: string];
  close: [];
}>();

const panelEl = ref<HTMLElement | null>(null);
const panelBottom = ref(8);

// Cap the list so a long-lived buffer doesn't render hundreds of rows. The
// newest entries are the likeliest recalls, so keep the tail (oldest first ->
// newest last) and let the panel scroll for the rest.
const rows = computed(() => (props.open ? props.entries.slice(-50) : []));

function pick(entry: string) {
  emit('select', entry);
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
  const toggle = props.toggleEl;
  if (panel && panel.contains(e.target as Node)) return;
  // The toggle owns open/close — let its click handler decide, don't double-
  // fire a close here. Tapping anywhere else (including the textarea) dismisses.
  if (toggle && toggle.contains(e.target as Node)) return;
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

watch(
  () => props.open,
  (v) => {
    if (!v) return;
    recomputePosition();
    // Open scrolled to the bottom — the newest entry sits there, nearest the
    // input, and it's the likeliest recall. Without this the overflow scroller
    // defaults to the top (oldest), unlike the nick/channel pickers which pull
    // their best match (rendered at the bottom) into view on open.
    nextTick(() => {
      const panel = panelEl.value;
      if (panel) panel.scrollTop = panel.scrollHeight;
    });
  },
);
</script>

<style scoped>
.history-picker {
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
/* Tap-only menu — no externally driven activeIndex to coordinate with, so a
   plain :hover highlight is fine (unlike the nick/channel pickers, which avoid
   :hover to dodge double-highlighting during keyboard nav). Soft neutral fill
   matches the context menu / Cmd-K list. */
.row:hover {
  background: var(--bg-soft);
}
/* Recalled lines can be long — keep each row to a single line, clipped with an
   ellipsis. The full text is in the row's title and lands in the composer on
   pick, so nothing is lost. */
.entry {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
