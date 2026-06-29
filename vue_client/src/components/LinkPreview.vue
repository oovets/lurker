<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  A rich preview card for a single URL in a chat message (Spotify, YouTube,
  news sites, …). The metadata is unfurled server-side; this component fetches
  it lazily — only once the card scrolls into view (IntersectionObserver) — so
  opening a long history doesn't fire a request per link. Renders nothing until
  a preview is available, so unsupported links leave no empty box.
-->

<template>
  <span ref="root" class="link-preview-anchor">
    <a
      v-if="preview"
      class="link-preview"
      :href="preview.url"
      target="_blank"
      rel="noopener noreferrer"
      @click.stop
    >
      <img v-if="preview.image" class="lp-thumb" :src="preview.image" alt="" loading="lazy" />
      <span class="lp-body">
        <span v-if="preview.siteName" class="lp-site">{{ preview.siteName }}</span>
        <span class="lp-title">{{ preview.title || preview.url }}</span>
        <span v-if="preview.description" class="lp-desc">{{ preview.description }}</span>
      </span>
    </a>
  </span>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { previewRef, loadPreview, type LinkPreviewData } from '../composables/useLinkPreviews.js';

const props = defineProps<{ url: string }>();

const preview = computed<LinkPreviewData | null>(() => {
  const v = previewRef(props.url).value;
  return v && typeof v === 'object' ? v : null;
});

const root = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

onMounted(() => {
  if (!root.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        void loadPreview(props.url);
        observer?.disconnect();
        observer = null;
      }
    },
    { rootMargin: '200px' },
  );
  observer.observe(root.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<style scoped>
.link-preview-anchor {
  display: block;
}
.link-preview {
  display: flex;
  gap: 10px;
  align-items: stretch;
  margin-top: 4px;
  max-width: 420px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-1, 4px);
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  text-decoration: none;
  color: inherit;
  overflow: hidden;
}
.link-preview:hover {
  background: var(--bg-hover, rgba(127, 127, 127, 0.14));
}
.lp-thumb {
  width: 84px;
  height: 84px;
  object-fit: cover;
  flex: none;
}
.lp-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  min-width: 0;
}
.lp-site {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--muted, #888);
}
.lp-title {
  font-weight: 600;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}
.lp-desc {
  font-size: 0.85rem;
  color: var(--fg-muted, #aaa);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}
</style>
