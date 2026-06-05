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
      <div v-if="failed" class="failed-card">
        <p class="empty">
          Failed to load image.
          <button class="link" type="button" @click="openInBrowser">Open in browser.</button>
        </p>
      </div>
      <p v-else-if="loading" class="loading" aria-label="Loading image">
        <i class="fa-solid fa-circle-notch fa-spin"></i>
      </p>
      <img
        v-show="!loading && !failed"
        class="image"
        :src="displayUrl"
        referrerpolicy="no-referrer"
        alt=""
        @load="onLoad"
        @error="onError"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const LOAD_TIMEOUT_MS = 20_000;

const props = defineProps<{
  url: string;
}>();

const emit = defineEmits<{ close: [] }>();

const loading = ref(true);
const failed = ref(false);
const displayUrl = ref(props.url);
const overlayEl = ref<HTMLElement | null>(null);
const loadTimer = ref<number | null>(null);

watch(
  () => props.url,
  (nextUrl) => startLoading(nextUrl),
);

function onLoad(): void {
  clearLoadTimer();
  loading.value = false;
  failed.value = false;
}

function onError(): void {
  clearLoadTimer();
  loading.value = false;
  failed.value = true;
}

function startLoading(nextUrl: string): void {
  clearLoadTimer();
  displayUrl.value = nextUrl;
  loading.value = true;
  failed.value = false;
  loadTimer.value = window.setTimeout(onLoadTimeout, LOAD_TIMEOUT_MS);
}

function clearLoadTimer(): void {
  if (loadTimer.value == null) return;

  window.clearTimeout(loadTimer.value);
  loadTimer.value = null;
}

function onLoadTimeout(): void {
  loadTimer.value = null;
  displayUrl.value = '';
  loading.value = false;
  failed.value = true;
}

function openInBrowser(): void {
  window.open(props.url, '_blank', 'noopener,noreferrer');
  emit('close');
}

onMounted(() => {
  overlayEl.value?.focus();
  startLoading(props.url);
});

onBeforeUnmount(() => {
  clearLoadTimer();
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
  animation: lightbox-fade-in 100ms ease-out;
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
.failed-card {
  width: min(520px, 92vw);
  background: var(--bg);
  border: 1px solid var(--accent);
  padding: var(--space-9);
}
.empty {
  color: var(--fg);
}
.link {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-2);
}
.link:hover {
  color: var(--accent);
}
.link:focus-visible {
  color: var(--accent);
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}

@keyframes lightbox-fade-in {
  from {
    opacity: 0;
    transform: scale(0.9);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
