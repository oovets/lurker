// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ComputedRef, MaybeRefOrGetter, Ref } from 'vue';
import { computed, toRef } from 'vue';
import { storeToRefs } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import {
  FRIENDS_KEY,
  SYSTEM_KEY,
  isVirtualKey,
  virtualConfig,
  type VirtualRenderMode,
} from '../lib/virtualBuffers.js';

export interface ActiveBufferState {
  activeKey: Ref<string | null>;
  active: ComputedRef<{ networkId: number; target: string; network: unknown } | null>;
  activeBuf: ComputedRef<unknown>;
  topic: ComputedRef<string | undefined>;
  isServerBuffer: ComputedRef<boolean>;
  isChannel: ComputedRef<boolean>;
  bufferLabel: ComputedRef<string>;
  isSystemBuffer: ComputedRef<boolean>;
  isVirtual: ComputedRef<boolean>;
  isFriendsBuffer: ComputedRef<boolean>;
  // Registry-driven capabilities so views dispatch off the virtual-buffer
  // config instead of hard-coding per-key checks. For a real IRC buffer these
  // default to a normal message buffer with input + nicklist.
  renderMode: ComputedRef<VirtualRenderMode>;
  hasInput: ComputedRef<boolean>;
  hasNicklist: ComputedRef<boolean>;
}

// `keyArg` lets a caller scope the returned state to a specific buffer key
// instead of the focused pane — ChatPane passes its pane's key so each pane
// renders its own header/messages/nicklist. Omitted, it falls back to the
// focused pane's activeKey (the original single-buffer behavior), so every
// existing caller is unchanged.
export function useActiveBuffer(keyArg?: MaybeRefOrGetter<string | null>): ActiveBufferState {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const { activeKey: focusedKey } = storeToRefs(networks);
  const activeKey = keyArg != null ? toRef(keyArg) : focusedKey;

  // Per-key analog of networks.activeBuffer: derive the {networkId, target,
  // network} triple from this pane's key so panes scoped via keyArg don't all
  // report the focused pane's buffer.
  const active = computed(() => {
    const k = activeKey.value;
    if (!k || isVirtualKey(k) || !k.includes('::')) return null;
    const [networkId, name] = k.split('::');
    const id = Number(networkId);
    return { networkId: id, target: name, network: networks.networkById(id) ?? undefined };
  });
  const virtualCfg = computed(() => virtualConfig(activeKey.value));
  const isVirtual = computed(() => virtualCfg.value != null);
  const isSystemBuffer = computed(() => activeKey.value === SYSTEM_KEY);
  const isFriendsBuffer = computed(() => activeKey.value === FRIENDS_KEY);
  // A real IRC buffer renders the message list with input + (for channels) a
  // nicklist; virtual buffers declare their own capabilities in the registry.
  const renderMode = computed<VirtualRenderMode>(() => virtualCfg.value?.renderMode ?? 'buffer');
  const hasInput = computed(() => virtualCfg.value?.hasInput ?? true);
  const hasNicklist = computed(() => virtualCfg.value?.hasNicklist ?? true);
  const activeBuf = computed(() => {
    if (!activeKey.value) return null;
    // Only 'buffer'-mode virtual buffers have a Buffer object in the store;
    // 'overview' (friends) renders its own body.
    if (virtualCfg.value && virtualCfg.value.renderMode !== 'buffer') return null;
    return buffers.byKey(activeKey.value);
  });
  const topic = computed(() => (activeBuf.value as any)?.topic);
  const isServerBuffer = computed(() => !!active.value?.target?.startsWith(':server:'));
  const isChannel = computed(() => !!active.value?.target?.startsWith('#'));
  const bufferLabel = computed(() => {
    if (virtualCfg.value) return virtualCfg.value.label;
    const t = active.value?.target;
    if (!t) return '';
    if (isServerBuffer.value) return (active.value?.network as any)?.name || 'server';
    return t;
  });

  return {
    activeKey,
    active,
    activeBuf,
    topic,
    isServerBuffer,
    isChannel,
    bufferLabel,
    isSystemBuffer,
    isVirtual,
    isFriendsBuffer,
    renderMode,
    hasInput,
    hasNicklist,
  };
}
