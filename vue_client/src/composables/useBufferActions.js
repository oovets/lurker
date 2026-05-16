// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { usePinsStore } from '../stores/pins.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { useContextMenu } from './useContextMenu.js';

// Shared menu items for a buffer (channel/DM). Exposed as a composable so the
// sidebar right-click handler and the topic-bar cog button both surface the
// same actions. Server buffers have their own dedicated affordances (edit
// network, browse channels) and aren't handled here.
export function useBufferActions() {
  const pins = usePinsStore();
  const channelNotify = useChannelNotifyStore();
  const menu = useContextMenu();

  function buildItems(buf) {
    if (!buf || buf.target.startsWith(':server:')) return [];
    const isChannel = buf.target.startsWith('#');
    const kind = isChannel ? 'Channel' : 'DM';
    const pinned = pins.isPinned(buf.networkId, buf.target);
    const items = [
      pinned
        ? { label: `Unpin ${kind}`, icon: 'fa-solid fa-thumbtack-slash', onClick: () => pins.unpin(buf.networkId, buf.target) }
        : { label: `Pin ${kind}`, icon: 'fa-solid fa-thumbtack', onClick: () => pins.pin(buf.networkId, buf.target) },
    ];
    if (isChannel) {
      const isAlwaysNotify = channelNotify.notifyAlways(buf.networkId, buf.target);
      items.push(
        isAlwaysNotify
          ? {
              label: 'Stop always notifying',
              icon: 'fa-solid fa-bell-slash',
              onClick: () => channelNotify.setNotifyAlways(buf.networkId, buf.target, false),
            }
          : {
              label: 'Always notify',
              icon: 'fa-solid fa-bell',
              onClick: () => channelNotify.setNotifyAlways(buf.networkId, buf.target, true),
            },
      );
    }
    return items;
  }

  function openMenuFor(buf, x, y) {
    const items = buildItems(buf);
    if (items.length === 0) return;
    menu.open(items, x, y);
  }

  // Anchor the menu to the bottom-left of a triggering button so it drops down
  // from the cog rather than appearing at the cursor — keeps the menu visually
  // tethered to the affordance that opened it.
  function openMenuFromButton(buf, buttonEl) {
    if (!buttonEl) return;
    const rect = buttonEl.getBoundingClientRect();
    openMenuFor(buf, rect.left, rect.bottom + 2);
  }

  return { buildItems, openMenuFor, openMenuFromButton };
}
