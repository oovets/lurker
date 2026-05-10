<template>
  <nav class="buffer-list">
    <div v-for="net in networks.networks" :key="net.id" class="net">
      <div
        class="net-head"
        :class="{ active: isActive(net.id, serverTarget(net.id)) }"
        :title="`Open ${net.name} server buffer`"
        @click="select(net.id, serverTarget(net.id))"
      >
        <span class="indicator" :class="stateClass(net.id)"></span>
        <span class="name">{{ net.name }}</span>
        <span
          v-if="serverHighlights(net.id) > 0"
          class="badge highlight"
          :title="`${serverHighlights(net.id)} highlight${serverHighlights(net.id) === 1 ? '' : 's'}`"
        >●</span>
        <span v-if="serverUnread(net.id) > 0" class="badge">{{ serverUnread(net.id) }}</span>
      </div>
      <ul class="channels">
        <li
          v-for="buf in netBuffers(net.id)"
          :key="buf.target"
          :class="{
            active: isActive(net.id, buf.target),
            unread: buf.unread > 0,
            highlighted: buf.highlighted > 0,
            'not-joined': isUnjoined(buf, net.id),
          }"
          @click="select(net.id, buf.target)"
        >
          <span class="label" :style="labelStyle(buf)">{{ labelFor(buf) }}</span>
          <span
            v-if="buf.highlighted > 0"
            class="badge highlight"
            :title="`${buf.highlighted} highlight${buf.highlighted === 1 ? '' : 's'}`"
          >●</span>
          <span v-if="buf.unread > 0" class="badge">{{ buf.unread }}</span>
        </li>
      </ul>
    </div>
    <p v-if="!networks.networks.length" class="empty">No networks yet — add one with the + button.</p>
  </nav>
</template>

<script setup>
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNickColors } from '../composables/useNickColors.js';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const nicks = useNickColors();

function isServerBuffer(buf) {
  return buf.target.startsWith(':server:');
}

function isDmBuffer(buf) {
  return !isServerBuffer(buf) && !buf.target.startsWith('#');
}

function serverTarget(networkId) {
  return `:server:${networkId}`;
}

function serverBuf(networkId) {
  return buffers.byKey(`${networkId}::${serverTarget(networkId)}`);
}

function serverUnread(networkId) {
  return serverBuf(networkId)?.unread || 0;
}

function serverHighlights(networkId) {
  return serverBuf(networkId)?.highlighted || 0;
}

function labelStyle(buf) {
  if (!isDmBuffer(buf)) return null;
  const selfNick = networks.states[buf.networkId]?.nick;
  if (selfNick && buf.target.toLowerCase() === selfNick.toLowerCase()) return null;
  const c = nicks.color(buf.target);
  return c ? { color: c } : null;
}

function labelFor(buf) {
  return buf.target;
}

function bufferOrder(buf) {
  if (buf.target.startsWith('#')) return 0;
  return 1;
}

// Strip leading hashes so ##anime sorts next to #anime, not before #aardvark
// (raw localeCompare would weight every leading '#' as sort-significant).
function sortKey(target) {
  return target.replace(/^#+/, '').toLowerCase();
}

function netBuffers(networkId) {
  return buffers
    .forNetwork(networkId)
    .filter((b) => !isServerBuffer(b))
    .sort((a, b) => {
      const oa = bufferOrder(a);
      const ob = bufferOrder(b);
      if (oa !== ob) return oa - ob;
      return sortKey(a.target).localeCompare(sortKey(b.target));
    });
}

function select(networkId, target) {
  buffers.activate(networkId, target);
}

function isActive(networkId, target) {
  return networks.activeKey === `${networkId}::${target}`;
}

function stateClass(networkId) {
  const s = networks.states[networkId]?.state;
  if (s === 'connected') return 'good';
  if (s === 'connecting' || s === 'reconnecting') return 'warn';
  return 'bad';
}

// Channels render dimmed when we're either explicitly parted (joined=false)
// or when the network itself isn't connected — in both cases the buffer is
// just a history view, not a live channel. DMs and server buffers have no
// "joined" concept and are never dimmed by this rule.
function isUnjoined(buf, networkId) {
  if (!buf.target.startsWith('#')) return false;
  if (buf.joined === false) return true;
  return networks.states[networkId]?.state !== 'connected';
}
</script>

<style scoped>
.buffer-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0;
}
.net { padding: 4px 0 6px; }
.net + .net { border-top: 1px solid var(--border); margin-top: 4px; }
.net-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
  border-left: 2px solid transparent;
}
.net-head:hover { background: var(--bg-soft); }
.net-head.active {
  background: var(--bg-soft);
  border-left-color: var(--accent);
}
.name { flex: 1; color: var(--fg); }
.indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--bad);
  flex: 0 0 auto;
}
.indicator.good { background: var(--good); }
.indicator.warn { background: var(--warn); }
.indicator.bad { background: var(--bad); }

.channels { list-style: none; margin: 0; padding: 0; }
.channels li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 2px 24px;
  cursor: pointer;
  border-left: 2px solid transparent;
  position: relative;
}
/* Tree guide: top-half vertical + horizontal arm. The arm meets the row's
   vertical centerline and stops short of the label, producing ├─ / └─. */
.channels li::before {
  content: "";
  position: absolute;
  left: 12px;
  top: 0;
  height: 50%;
  width: 8px;
  border-left: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  pointer-events: none;
}
/* Bottom-half vertical: only when there's a sibling below — turns └─ into ├─. */
.channels li:not(:last-child)::after {
  content: "";
  position: absolute;
  left: 12px;
  top: 50%;
  bottom: 0;
  width: 0;
  border-left: 1px solid var(--border);
  pointer-events: none;
}
.channels li:hover { background: var(--bg-soft); }
.channels li.active {
  background: var(--bg-soft);
  border-left-color: var(--accent);
}
.channels li.unread .label { font-weight: 600; color: var(--fg); }
.channels li.highlighted .label { color: var(--warn); }
/* Parted/disconnected channels render as a history view rather than a live
   buffer. Apply opacity to the whole row so badges, labels, and tree guides
   all dim together; unread/highlight colors still come through. */
.channels li.not-joined { opacity: 0.5; }
.label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  color: var(--accent);
  padding: 0 2px;
}
.badge.highlight { color: var(--warn); }

.empty { padding: 12px; color: var(--fg-muted); font-style: italic; }
</style>
