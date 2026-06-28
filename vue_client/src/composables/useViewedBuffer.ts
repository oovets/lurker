// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The set of buffer keys (`networkId::target`) whose message lists are actually
// rendered on screen right now. With split panes there can be several at once —
// one MessageList per visible pane — so this tracks a key per mounted instance
// rather than a single value. A buffer is "viewed" if ANY pane shows it.
//
// Each MessageList owns one entry, keyed by a unique token it holds for its
// lifetime: it reports its buffer while mounted and clears its entry on unmount.
// So the set is empty whenever no MessageList is mounted, which covers the
// Settings route, the mobile buffer-list / members screens, and the system
// console.
//
// Deliberately NOT networks.activeKey. activeKey only tracks the focused pane's
// buffer and lingers across route and mobile-screen changes, so it still reads
// as "in view" while the user sits on Settings or the buffer list. Toast
// suppression keys off this instead (useHighlightNotifier.shouldNotifyInApp) so
// a highlight in a non-visible buffer still toasts, and one already on screen in
// any pane stays quiet.
//
// A plain module map (not a ref): the only reader, shouldNotifyInApp, polls it
// imperatively when an event arrives — there's nothing to react to.
const viewedByToken = new Map<symbol, string>();

export function setViewedBuffer(token: symbol, key: string | null): void {
  if (key == null) viewedByToken.delete(token);
  else viewedByToken.set(token, key);
}

export function clearViewedBuffer(token: symbol): void {
  viewedByToken.delete(token);
}

export function isBufferViewed(key: string): boolean {
  for (const v of viewedByToken.values()) if (v === key) return true;
  return false;
}
