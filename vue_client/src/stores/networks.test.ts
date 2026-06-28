// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// The pane actions under test are pure store mutations — they never touch the
// network API or auth. Stub the api module so importing the store doesn't try
// to reach a server, and the auth store (only used by connect/disconnect).
vi.mock('../api.js', () => ({ api: vi.fn<() => Promise<unknown>>() }));

import { useNetworksStore } from './networks.js';
import { SYSTEM_KEY } from '../lib/virtualBuffers.js';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('split panes', () => {
  it('starts with a single empty focused pane', () => {
    const s = useNetworksStore();
    expect(s.panes).toHaveLength(1);
    expect(s.activeKey).toBeNull();
    expect(s.focusedPane.id).toBe(s.focusedPaneId);
    expect(s.paneKeys).toEqual([]);
  });

  it('setActive points the focused pane at the buffer key', () => {
    const s = useNetworksStore();
    s.setActive(1, '#chan');
    expect(s.activeKey).toBe('1::#chan');
    expect(s.activeBuffer).toEqual({ networkId: 1, target: '#chan', network: undefined });
    expect(s.paneKeys).toEqual(['1::#chan']);
  });

  it('activateVirtual sets a flat sentinel key (no IRC buffer)', () => {
    const s = useNetworksStore();
    s.activateVirtual(SYSTEM_KEY);
    expect(s.activeKey).toBe(SYSTEM_KEY);
    // Virtual keys have no `::`, so activeBuffer reports "no IRC buffer".
    expect(s.activeBuffer).toBeNull();
  });

  it('openPane adds a focused pane and returns its id', () => {
    const s = useNetworksStore();
    s.setActive(1, '#a');
    const firstId = s.focusedPaneId;
    const newId = s.openPane(null);
    expect(s.panes).toHaveLength(2);
    expect(s.focusedPaneId).toBe(newId);
    expect(newId).not.toBe(firstId);
    // The original pane keeps its buffer; the new one is empty + focused.
    expect(s.panes.find((p) => p.id === firstId)?.key).toBe('1::#a');
    expect(s.activeKey).toBeNull();
  });

  it('activating into a new pane leaves the other pane untouched', () => {
    const s = useNetworksStore();
    s.setActive(1, '#a');
    const firstId = s.focusedPaneId;
    const newId = s.openPane(null);
    s.setActive(2, '#b'); // focused pane is the new one
    expect(s.panes.find((p) => p.id === firstId)?.key).toBe('1::#a');
    expect(s.panes.find((p) => p.id === newId)?.key).toBe('2::#b');
    expect(s.paneKeys).toEqual(['1::#a', '2::#b']);
  });

  it('setFocusedPane moves activeKey to that pane', () => {
    const s = useNetworksStore();
    s.setActive(1, '#a');
    const firstId = s.focusedPaneId;
    const newId = s.openPane(null);
    s.setActive(2, '#b');
    s.setFocusedPane(firstId);
    expect(s.activeKey).toBe('1::#a');
    s.setFocusedPane(newId);
    expect(s.activeKey).toBe('2::#b');
  });

  it('closePane removes a pane and refocuses a neighbor; never below one', () => {
    const s = useNetworksStore();
    s.setActive(1, '#a');
    const firstId = s.focusedPaneId;
    const newId = s.openPane(null);
    s.setActive(2, '#b');
    s.closePane(newId); // close the focused (second) pane
    expect(s.panes).toHaveLength(1);
    expect(s.focusedPaneId).toBe(firstId);
    expect(s.activeKey).toBe('1::#a');
    // Closing the last remaining pane is a no-op.
    s.closePane(firstId);
    expect(s.panes).toHaveLength(1);
  });

  it('clearKey blanks every pane showing the key', () => {
    const s = useNetworksStore();
    s.setActive(1, '#a');
    s.openPane(null);
    s.setActive(1, '#a'); // same buffer in both panes
    expect(s.paneKeys).toEqual(['1::#a', '1::#a']);
    s.clearKey('1::#a');
    expect(s.paneKeys).toEqual([]);
    expect(s.panes).toHaveLength(2);
  });
});
