<template>
  <nav class="buffer-list">
    <div v-for="net in networks.networks" :key="net.id" class="net">
      <div class="net-head" @click="toggleNet(net.id)">
        <span class="indicator" :class="stateClass(net.id)"></span>
        <span class="name">{{ net.name }}</span>
        <span class="hostnick">{{ networks.states[net.id]?.nick || net.nick }}</span>
        <button
          class="settings"
          title="Edit network"
          @click.stop="$emit('edit-network', net)"
        >⚙</button>
      </div>
      <ul class="channels">
        <li
          v-for="buf in netBuffers(net.id)"
          :key="buf.target"
          :class="{
            active: isActive(net.id, buf.target),
            unread: buf.unread > 0,
            server: isServerBuffer(buf),
          }"
          @click="select(net.id, buf.target)"
        >
          <span class="bullet">{{ bulletFor(buf) }}</span>
          <span class="label" :style="labelStyle(buf)">{{ labelFor(buf) }}</span>
          <span v-if="buf.unread > 0" class="badge">{{ buf.unread }}</span>
          <button
            v-if="buf.target.startsWith('#')"
            class="part"
            title="Leave channel"
            @click.stop="part(net.id, buf.target)"
          >×</button>
        </li>
      </ul>
      <div class="add">
        <input
          v-model="joinInput[net.id]"
          placeholder="#channel"
          @keydown.enter="join(net.id)"
        />
      </div>
    </div>
    <p v-if="!networks.networks.length" class="empty">No networks yet — add one with the + button.</p>
  </nav>
</template>

<script setup>
import { reactive } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { socketSend } from '../composables/useSocket.js';
import { nickColor } from '../utils/nickColor.js';

defineEmits(['edit-network']);

const networks = useNetworksStore();
const buffers = useBuffersStore();

const joinInput = reactive({});

function isServerBuffer(buf) {
  return buf.target.startsWith(':server:');
}

function isDmBuffer(buf) {
  return !isServerBuffer(buf) && !buf.target.startsWith('#');
}

function labelStyle(buf) {
  if (!isDmBuffer(buf)) return null;
  const selfNick = networks.states[buf.networkId]?.nick;
  if (selfNick && buf.target.toLowerCase() === selfNick.toLowerCase()) return null;
  const c = nickColor(buf.target);
  return c ? { color: c } : null;
}

function bulletFor(buf) {
  if (isServerBuffer(buf)) return '⚙';
  if (buf.target.startsWith('#')) return '#';
  return '@';
}

function labelFor(buf) {
  if (isServerBuffer(buf)) return 'server';
  return buf.target.replace(/^#/, '');
}

function bufferOrder(buf) {
  if (isServerBuffer(buf)) return 0;
  if (buf.target.startsWith('#')) return 1;
  return 2;
}

function netBuffers(networkId) {
  return buffers.forNetwork(networkId).sort((a, b) => {
    const oa = bufferOrder(a);
    const ob = bufferOrder(b);
    if (oa !== ob) return oa - ob;
    return a.target.localeCompare(b.target);
  });
}

function select(networkId, target) {
  networks.setActive(networkId, target);
  buffers.markRead(networkId, target);
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

function join(networkId) {
  const value = (joinInput[networkId] || '').trim();
  if (!value) return;
  const channel = value.startsWith('#') ? value : `#${value}`;
  socketSend({ type: 'join', networkId, channel });
  joinInput[networkId] = '';
}

function part(networkId, channel) {
  socketSend({ type: 'part', networkId, channel });
}

function toggleNet(_) {
  // Reserved for collapse/expand later.
}
</script>

<style scoped>
.buffer-list {
  flex: 1;
  overflow: auto;
  padding: 8px 0;
}
.net { padding: 6px 0; border-bottom: 1px solid var(--border); }
.net-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.name { flex: 1; color: var(--fg); }
.hostnick { color: var(--fg); font-size: 11px; }
.indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bad);
}
.indicator.good { background: var(--good); }
.indicator.warn { background: var(--warn); }
.indicator.bad { background: var(--bad); }

.channels { list-style: none; margin: 0; padding: 0; }
.channels li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  cursor: pointer;
  border-left: 2px solid transparent;
}
.channels li:hover { background: var(--bg-soft); }
.channels li.active {
  background: var(--bg-soft);
  border-left-color: var(--accent);
}
.channels li.unread .label { font-weight: 600; }
.channels li.server .label { color: var(--fg-muted); font-style: italic; }
.bullet { color: var(--fg-muted); width: 12px; }
.label { flex: 1; }
.badge {
  background: var(--accent-soft);
  color: var(--fg);
  border-radius: 10px;
  padding: 0 6px;
  font-size: 11px;
}
.part {
  background: none;
  border: none;
  color: var(--fg-muted);
  padding: 0 4px;
  cursor: pointer;
}
.part:hover { color: var(--bad); }

.settings {
  background: none;
  border: none;
  color: var(--fg-muted);
  padding: 0 2px;
  cursor: pointer;
  font-size: 12px;
}
.settings:hover { color: var(--fg); }

.add { padding: 4px 12px; }
.add input { width: 100%; font-size: 12px; }

.empty { padding: 12px; color: var(--fg-muted); font-size: 12px; }
</style>
