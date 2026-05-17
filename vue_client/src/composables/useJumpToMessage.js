// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { watch } from 'vue';
import { useBuffersStore } from '../stores/buffers.js';
import { useToastsStore } from '../stores/toasts.js';

// Shared jump-to-message logic for both desktop and mobile shells. The
// shell-specific tail (mobile flips `screen.value = 'buffer'`; desktop has
// no such state) is left to the caller — they pass the `pendingScrollId`
// ref so we can drive the existing MessageList watcher and an optional
// `afterActivate` callback for any post-activate UI work.
//
// Behavior:
//   1. Reject :server: pseudo-buffers (no per-message anchor).
//   2. Reject closed buffers with the existing toast.
//   3. Activate the buffer.
//   4. If the target id is already in buf.messages, set pendingScrollId
//      directly (current happy path; no fetch needed).
//   5. Otherwise, loadAround() — detaching the buffer to a bounded ~200-row
//      historical slice — and arm pendingScrollId once the slice lands.
export function useJumpToMessage({ pendingScrollId, afterActivate } = {}) {
  const buffers = useBuffersStore();
  const toasts = useToastsStore();

  return function jumpToMessage({ networkId, target, messageId }) {
    if (typeof target === 'string' && target.startsWith(':server:')) {
      toasts.push({ kind: 'info', title: 'Cannot jump in server buffer', ttlMs: 4000 });
      return;
    }
    // A notification can outlive its buffer — if the channel was closed
    // since the push fired, activating would recreate an empty shell. Bail
    // with a toast instead of stranding the UI in a half-state.
    if (!buffers.isOpen(networkId, target)) {
      toasts.push({ kind: 'info', title: 'Buffer is closed', ttlMs: 4000 });
      return;
    }
    buffers.activate(networkId, target);
    if (typeof afterActivate === 'function') afterActivate();

    const buf = buffers.byKey(`${networkId}::${target}`);
    const hasMessage = buf?.messages?.some((m) => m.id === messageId);
    if (hasMessage) {
      if (pendingScrollId) pendingScrollId.value = messageId;
      return;
    }
    // Detached fetch path. loadAround sets detached=true synchronously, so
    // any live fanOut between here and the response is dropped. We arm
    // pendingScrollId once the slice replaces buf.messages — the MessageList
    // watcher then handles the scroll/pulse.
    buffers.loadAround(networkId, target, messageId);
    const stop = watch(() => buf?.messages?.length, (len) => {
      if (!len) return;
      // The around response replaces messages wholesale, so the first
      // non-empty change after dispatch is the slice landing.
      stop();
      if (pendingScrollId) pendingScrollId.value = messageId;
    });
  };
}
