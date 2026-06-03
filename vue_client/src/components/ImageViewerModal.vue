<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div
    ref="overlayEl"
    class="lightbox"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label="Image viewer"
    @click.self="$emit('close')"
    @keydown.esc="$emit('close')"
  >
    <div class="topbar">
      <div class="controls">
        <button
          class="control"
          type="button"
          title="open in browser"
          aria-label="open in browser"
          @click="openInBrowser"
        >
          <i class="fa-solid fa-arrow-up-right-from-square"></i>
        </button>
        <button
          class="control"
          type="button"
          title="close"
          aria-label="close"
          @click="$emit('close')"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>

    <div class="stage" @click.self="$emit('close')">
      <p v-if="failed" class="empty">Couldn't load image.</p>
      <p v-else-if="loading" class="loading" aria-label="Loading image">
        <i class="fa-solid fa-circle-notch fa-spin"></i>
      </p>
      <img
        v-show="!loading && !failed"
        class="image"
        :src="url"
        alt=""
        @load="onLoad"
        @error="onError"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';

const props = defineProps<{
  url: string;
}>();

const emit = defineEmits<{ close: [] }>();

const loading = ref(true);
const failed = ref(false);
const overlayEl = ref<HTMLElement | null>(null);

watch(
  () => props.url,
  () => {
    loading.value = true;
    failed.value = false;
  },
);

function onLoad(): void {
  loading.value = false;
  failed.value = false;
}

function onError(): void {
  loading.value = false;
  failed.value = true;
}

function openInBrowser(): void {
  window.open(props.url, '_blank', 'noopener,noreferrer');
  emit('close');
}

onMounted(() => {
  overlayEl.value?.focus();
});
</script>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  --control-rail: calc(var(--icon-lg) + (2 * var(--space-2)));
  background: rgba(0, 0, 0, 0.84);
  display: grid;
  grid-template-rows: var(--control-rail) minmax(0, 1fr) var(--control-rail);
  gap: var(--space-4);
  padding: var(--space-7);
  outline: none;
}

.topbar {
  grid-column: 1;
  grid-row: 1;
  width: 100%;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding-top: env(safe-area-inset-top);
  padding-right: env(safe-area-inset-right);
  z-index: 1;
}
.controls {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.control {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  /* Icon-only button — size the glyph, not text weight (fa-solid is already
     weight 900). */
  font-size: var(--icon-lg);
  padding: var(--space-2) var(--space-4);
}
.control:hover {
  color: var(--accent);
}

.stage {
  grid-column: 1;
  grid-row: 2;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.image {
  display: block;
  width: auto;
  height: auto;
  max-width: 92vw;
  max-height: 100%;
  object-fit: contain;
}
.loading,
.empty {
  margin: 0;
  color: rgba(255, 255, 255, 0.78);
  text-align: center;
}
.loading {
  font-size: var(--icon-lg);
}
.empty {
  font-style: italic;
  padding: var(--space-10);
}
</style>
