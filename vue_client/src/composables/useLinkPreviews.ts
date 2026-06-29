// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Lazy, deduped client cache for server-unfurled link previews. A LinkPreview
// component asks for a URL's preview when it scrolls into view; the first ask
// per URL fetches `/api/link-preview`, the rest reuse the shared reactive ref.
// `undefined` = not fetched yet, `null` = fetched, no preview, object = preview.

import { ref, type Ref } from 'vue';
import { api } from '../api.js';

export interface LinkPreviewData {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  author?: string;
}

const cache = new Map<string, Ref<LinkPreviewData | null | undefined>>();
const inflight = new Set<string>();

export function previewRef(url: string): Ref<LinkPreviewData | null | undefined> {
  let r = cache.get(url);
  if (!r) {
    r = ref<LinkPreviewData | null | undefined>(undefined);
    cache.set(url, r);
  }
  return r;
}

export async function loadPreview(url: string): Promise<void> {
  const r = previewRef(url);
  if (r.value !== undefined || inflight.has(url)) return;
  inflight.add(url);
  try {
    const { preview } = await api<{ preview: LinkPreviewData | null }>(
      `/api/link-preview?url=${encodeURIComponent(url)}`,
    );
    r.value = preview ?? null;
  } catch {
    r.value = null;
  } finally {
    inflight.delete(url);
  }
}
