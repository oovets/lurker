// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { ref } from 'vue';

const isOpen = ref(false);
const url = ref<string | null>(null);

export function useImageModal() {
  function open(nextUrl: string): void {
    url.value = nextUrl;
    isOpen.value = true;
  }

  function close(): void {
    isOpen.value = false;
    url.value = null;
  }

  return { isOpen, url, open, close };
}
