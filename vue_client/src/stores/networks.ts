// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { useAuthStore } from './auth.js';
import { isVirtualKey } from '../lib/virtualBuffers.js';
import type { MultilineLimits } from '../utils/messageSplit.js';

export interface Network {
  id: number;
  name: string;
  host: string;
  port: number;
  nick: string;
  tls: boolean;
  [key: string]: unknown;
}

export interface PeerPresenceEntry {
  nick: string;
  state: string | null;
  stateAt: string | null;
  awayMessage: string | null;
}

// User-level self-presence, broadcast per network from the away-state stream.
// Mirrors the in-memory shape ircManager/IrcConnection hold (`AwayState`
// there); `message` and `since` stay populated after /back so the buffer
// dividers can render the completed away→back pair.
export interface AwayState {
  active: boolean;
  message: string | null;
  since: string | null;
  autoSet: boolean;
  backAt: string | null;
}

export interface NetworkState {
  networkId: number;
  channels: string[];
  state?: string;
  nick?: string;
  userModes?: string;
  away?: AwayState | null;
  peerPresence?: Record<string, PeerPresenceEntry>;
  lagMs?: number | null;
  // Advertised draft/multiline limits when the network negotiated the cap,
  // else null/absent. Drives the composer's multiline-aware SPLIT/FLOOD hint
  // and upload-as-.txt gate. Refreshed by the snapshot pushed on connect. (#381)
  multilineLimits?: MultilineLimits | null;
}

export interface ActiveBuffer {
  networkId: number;
  target: string;
  network: Network | undefined;
}

// A split-view pane: one slot in the desktop grid showing a single buffer.
// `key` is the same `${networkId}::${target}` (or flat virtual sentinel) the
// buffers store uses, or null for an empty pane. The desktop shell renders one
// column per pane; mobile only ever uses the single seed pane. Pane ids come
// from a monotonic counter (no Date.now/random — keeps tests deterministic and
// avoids the resume-breaking globals).
export interface Pane {
  id: string;
  key: string | null;
}

let paneCounter = 0;
function nextPaneId(): string {
  paneCounter += 1;
  return `pane-${paneCounter}`;
}

export const useNetworksStore = defineStore('networks', {
  state: () => ({
    networks: [] as Network[],
    states: {} as Record<number | string, NetworkState>,
    // Split panes. Always at least one. `activeKey` is no longer stored
    // directly — it's a getter onto the focused pane's key, so every existing
    // reader (which means "the focused buffer") keeps working unchanged.
    panes: [{ id: 'pane-0', key: null }] as Pane[],
    focusedPaneId: 'pane-0',
  }),
  getters: {
    // The pane the single shared input + status bar act on. Falls back to the
    // first pane if focusedPaneId ever dangles (closePane refocuses, but guard
    // anyway so readers never see undefined).
    focusedPane(state): Pane {
      return state.panes.find((p) => p.id === state.focusedPaneId) ?? state.panes[0];
    },
    // Back-compat: "the active/focused buffer key". Reads across the codebase
    // (MessageInput, StatusBar, BufferList highlight, QuickSwitcher, keyboard
    // nav) all legitimately mean the focused pane, so they need no change.
    activeKey(): string | null {
      return this.focusedPane?.key ?? null;
    },
    // Every key currently visible across all panes. Used by buffers.activate to
    // decide whether leaving a buffer in one pane should reset its read state —
    // it must NOT if another pane still shows it.
    paneKeys(state): string[] {
      return state.panes.map((p) => p.key).filter((k): k is string => k != null);
    },
    networkById: (state) => (id: number) => state.networks.find((n) => n.id === id) || null,
    // Presence row for a (network, nick), disconnected-aware: a down network's
    // cached rows are stale, so report a synthetic 'offline'. Connected with no
    // row stays null (unknown = "potentially online", the no-MONITOR case).
    // Single source of truth for the sidebar, status bar, profile, and Friends.
    peerFor:
      (state) =>
      (networkId: number | string, nick: string): PeerPresenceEntry | null => {
        const netState = state.states[networkId];
        if (netState && netState.state !== 'connected')
          return { nick, state: 'offline', stateAt: null, awayMessage: null };
        return netState?.peerPresence?.[nick.toLowerCase()] ?? null;
      },
    activeBuffer(state): ActiveBuffer | null {
      const activeKey = this.activeKey;
      if (!activeKey) return null;
      // Virtual buffers (:system:, :friends:) use a flat sentinel key (no `::`).
      // They have no IRC send target, so report "no IRC buffer active" — the
      // views drive their own header/rendering. Friends still renders messages
      // via buffers.byKey(activeKey) directly, not through this getter.
      if (isVirtualKey(activeKey)) return null;
      if (!activeKey.includes('::')) return null;
      const [networkId, name] = activeKey.split('::');
      const id = Number(networkId);
      return { networkId: id, target: name, network: state.networks.find((n) => n.id === id) };
    },
  },
  actions: {
    async fetchAll() {
      const { networks } = await api('/api/networks');
      this.networks = networks;
    },
    async create(payload: Partial<Network>) {
      const { network } = await api('/api/networks', { method: 'POST', body: payload });
      this.networks.push(network);
      return network as Network;
    },
    async update(id: number, patch: Partial<Network>) {
      const { network } = await api(`/api/networks/${id}`, { method: 'PATCH', body: patch });
      const idx = this.networks.findIndex((n) => n.id === id);
      if (idx >= 0) this.networks[idx] = network;
      return network as Network;
    },
    // Rewrite sidebar order. Server validates the id set; on 409 it echoes the
    // authoritative list, which we apply so the UI snaps back to truth instead
    // of staying out of sync after a concurrent add/delete from another tab.
    async reorder(ids: number[]) {
      try {
        const { networks } = await api('/api/networks/reorder', {
          method: 'POST',
          body: { ids },
        });
        this.networks = networks;
      } catch (err: any) {
        if (err?.status === 409 && Array.isArray(err.data?.networks)) {
          this.networks = err.data.networks;
        }
        throw err;
      }
    },
    async remove(id: number) {
      await api(`/api/networks/${id}`, { method: 'DELETE' });
      this.networks = this.networks.filter((n) => n.id !== id);
      delete this.states[id];
      // Blank any pane showing a buffer on the removed network — across all
      // panes, not just the focused one (#split-panes).
      for (const pane of this.panes) {
        if (pane.key?.startsWith(`${id}::`)) pane.key = null;
      }
    },
    // The IRC connection toggles are the writes most reachable from the
    // read-only browse view (header toggle, network context menu), so they get
    // a client-side short-circuit to avoid firing a request the server would
    // 403 anyway. Config mutations (create/update/remove) are reached only from
    // editing UI a paused user shouldn't be in, and stay server-enforced.
    async connect(id: number) {
      if (useAuthStore().isPaused) return;
      await api(`/api/networks/${id}/connect`, { method: 'POST' });
    },
    async disconnect(id: number, reason?: string) {
      if (useAuthStore().isPaused) return;
      await api(`/api/networks/${id}/disconnect`, {
        method: 'POST',
        ...(reason ? { body: { reason } } : {}),
      });
    },
    async reconnect(id: number) {
      if (useAuthStore().isPaused) return;
      await api(`/api/networks/${id}/reconnect`, { method: 'POST' });
    },
    setActive(networkId: number | string | null, target: string) {
      // The app-scoped system buffer (#355) has no network — it keys on the bare
      // sentinel target, matching the buffers store's key() helper.
      this.setFocusedKey(networkId == null ? target : `${networkId}::${target}`);
    },
    // Virtual buffers (system console, friends) aren't tied to an IRC network.
    // They use a flat sentinel key (no `::`) so the existing
    // `${networkId}::${target}` parsers ignore them.
    activateVirtual(key: string) {
      this.setFocusedKey(key);
    },
    // ── Split panes ─────────────────────────────────────────────────────────
    // Point the focused pane at a buffer key. The single write path behind
    // setActive/activateVirtual, so "activate a buffer" always lands in the
    // pane the user is currently driving.
    setFocusedKey(key: string | null) {
      const pane = this.panes.find((p) => p.id === this.focusedPaneId) ?? this.panes[0];
      if (pane) pane.key = key;
    },
    setFocusedPane(id: string) {
      if (this.panes.some((p) => p.id === id)) this.focusedPaneId = id;
    },
    // Open a new pane (initially showing `key`, often null) and focus it.
    // Returns the new pane id so the caller can immediately activate a buffer
    // into it via buffers.activate(networkId, target, { paneId }).
    openPane(key: string | null = null): string {
      const id = nextPaneId();
      this.panes.push({ id, key });
      this.focusedPaneId = id;
      return id;
    },
    // Close a pane, never dropping below one. If the closed pane was focused,
    // focus a neighbor so the input/status bar always has a target.
    closePane(id: string) {
      if (this.panes.length <= 1) return;
      const idx = this.panes.findIndex((p) => p.id === id);
      if (idx < 0) return;
      this.panes.splice(idx, 1);
      if (this.focusedPaneId === id) {
        const neighbor = this.panes[idx] ?? this.panes[this.panes.length - 1];
        this.focusedPaneId = neighbor.id;
      }
    },
    // Null out every pane currently showing `key` (a buffer closed elsewhere,
    // e.g. the close-buffer fan-out in useSocket).
    clearKey(key: string) {
      for (const pane of this.panes) {
        if (pane.key === key) pane.key = null;
      }
    },
    applySnapshot(networks: NetworkState[]) {
      const map: Record<number | string, NetworkState> = {};
      for (const snap of networks) map[snap.networkId] = snap;
      this.states = map;
    },
    applyState(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = {
        ...existing,
        state: event.state,
        nick: event.nick || existing.nick,
      };
    },
    applyOwnNick(event: any) {
      const existing = this.states[event.networkId];
      if (!existing || !event.nick) return;
      this.states[event.networkId] = { ...existing, nick: event.nick };
    },
    applyUserMode(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = {
        ...existing,
        userModes: typeof event.modes === 'string' ? event.modes : '',
      };
    },
    applyAwayState(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = {
        ...existing,
        away: event.away || null,
      };
    },
    // Per-(network, nick) peer presence. Single most-recent-event shape:
    // { state, stateAt } where state ∈ {online, offline, away, back}.
    // Stored under the network state bucket so the snapshot apply seeds it
    // instantly; readers (MessageList marker, BufferList decoration,
    // StatusBar segment) look up by lowercase nick.
    applyPeerPresence(networkId: number | string, nick: string, payload: any) {
      if (!networkId || !nick) return;
      const existing = this.states[networkId] || { networkId: Number(networkId), channels: [] };
      const peerPresence = { ...existing.peerPresence };
      peerPresence[nick.toLowerCase()] = {
        nick,
        state: payload?.state || null,
        stateAt: payload?.stateAt || null,
        awayMessage: payload?.awayMessage || null,
      };
      this.states[networkId] = { ...existing, peerPresence };
    },
    applyLag(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      const v = event.lagMs;
      this.states[event.networkId] = {
        ...existing,
        lagMs: typeof v === 'number' ? v : null,
      };
    },
  },
});
