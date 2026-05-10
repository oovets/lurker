<template>
  <div class="chat" @click="onChatClick">
    <aside class="sidebar">
      <div class="sidebar-head">
        <span class="logo">caint</span>
        <span v-if="!connected" class="status off" title="Disconnected">●</span>
        <RouterLink class="link first-action" to="/settings" title="Settings"><i class="fa-solid fa-gear"></i></RouterLink>
        <button class="link" @click="showHighlights = true" title="Highlights"><i class="fa-regular fa-bell"></i></button>
        <button class="link" @click="openAddNetwork" title="Add network"><i class="fa-solid fa-plus"></i></button>
      </div>
      <BufferList />
    </aside>

    <header v-if="active" class="topic">
      <span class="buffer">{{ bufferLabel }}</span>
      <button
        v-if="isServerBuffer"
        class="link"
        title="Edit network"
        @click="editActiveNetwork"
      ><i class="fa-solid fa-gear"></i></button>
      <span v-if="memberCount != null" class="count">{{ memberCount }}</span>
      <template v-if="topic">
        <span class="sep">│</span>
        <span class="topic-text"><LinkedText :text="topic" /></span>
      </template>
    </header>
    <div v-if="active" class="topic-divider"></div>

    <MessageList :pending-scroll-id="pendingScrollId" />
    <MemberList v-if="active" />
    <MessageInput ref="messageInputRef" />

    <NetworkForm
      v-if="showNetworkForm"
      :network="editingNetwork"
      @close="closeNetworkForm"
    />
    <HighlightsModal
      v-if="showHighlights"
      @close="showHighlights = false"
      @jump="onJumpToMessage"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useSocket } from '../composables/useSocket.js';
import { startPresenceReporter, reportNow } from '../composables/usePresence.js';
import { registerSW, onSWPushMessage } from '../composables/usePush.js';
import BufferList from '../components/BufferList.vue';
import MessageList from '../components/MessageList.vue';
import MessageInput from '../components/MessageInput.vue';
import MemberList from '../components/MemberList.vue';
import NetworkForm from '../components/NetworkForm.vue';
import HighlightsModal from '../components/HighlightsModal.vue';
import LinkedText from '../components/LinkedText.vue';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const settings = useSettingsStore();
const { connected } = useSocket();

const showNetworkForm = ref(false);
const editingNetwork = ref(null);
const showHighlights = ref(false);
const pendingScrollId = ref(null);
const messageInputRef = ref(null);
const { activeKey } = storeToRefs(networks);

// Forward stray clicks anywhere in the chat frame (topic bar, message list,
// member list, sidebar gutter, etc.) into the message input. The selector
// excludes anything genuinely interactive — buttons, links, form controls,
// and modal contents — and we bail if the user is in the middle of selecting
// text so we don't kill their selection.
function onChatClick(e) {
  if (e.target.closest('button, a, input, textarea, select, label, .modal, [contenteditable=true]')) return;
  const sel = window.getSelection();
  if (sel && sel.toString().length > 0) return;
  messageInputRef.value?.focus();
}

function onJumpToMessage({ networkId, target, messageId }) {
  buffers.activate(networkId, target);
  pendingScrollId.value = messageId;
}

function openAddNetwork() {
  editingNetwork.value = null;
  showNetworkForm.value = true;
}
function openEditNetwork(net) {
  editingNetwork.value = net;
  showNetworkForm.value = true;
}
function closeNetworkForm() {
  showNetworkForm.value = false;
  editingNetwork.value = null;
}

const active = computed(() => networks.activeBuffer);
const activeBuf = computed(() => (activeKey.value ? buffers.byKey(activeKey.value) : null));
const topic = computed(() => activeBuf.value?.topic);

const isServerBuffer = computed(() => !!active.value?.target?.startsWith(':server:'));

const bufferLabel = computed(() => {
  const t = active.value?.target;
  if (!t) return '';
  if (isServerBuffer.value) return active.value?.network?.name || 'server';
  return t;
});

const memberCount = computed(() => {
  const t = active.value?.target;
  if (!t || !t.startsWith('#')) return null;
  return activeBuf.value?.members?.length ?? null;
});

function editActiveNetwork() {
  const net = active.value?.network;
  if (net) openEditNetwork(net);
}

onMounted(async () => {
  if (!settings.loaded) settings.fetchAll().catch(() => {});
  await networks.fetchAll();
  startPresenceReporter();
  reportNow();
  // Register the SW unconditionally so a previously-subscribed device can
  // still receive push events without the user re-opening Settings. Push
  // subscription itself is now per-client, gated by an explicit Settings
  // button — see usePush.enable().
  registerSW().catch(() => { /* ignore */ });
  onSWPushMessage((data) => {
    if (data?.kind === 'jump') onJumpToMessage(data);
  });
});
</script>

<style scoped>
/* WeeChat-style frame: the sidebar runs full height on the left; the topic
   and input bars span the full width to the right of it; and the message
   list + nicklist sit between them. */
.chat {
  display: grid;
  grid-template-columns: 220px 1fr 180px;
  /* The 1px row owns the topic/messages divider as its own grid track,
     outside the scroll container. Putting the line inside .message-list
     (border-top, inset box-shadow) lets row backgrounds and hover states
     paint over it as content scrolls past — the line appears to be eaten
     by the scrolling rows. A dedicated row sits between the two children
     and nothing can paint on top of it. */
  grid-template-rows: auto auto 1fr auto;
  grid-template-areas:
    "sidebar topic    topic"
    "sidebar divider  divider"
    "sidebar messages members"
    "sidebar input    input";
  height: 100vh;
  overflow: hidden;
}
/* min-height/min-width 0 lets flex/scrolling children stay inside their row. */
.chat > * { min-width: 0; min-height: 0; }

.sidebar {
  grid-area: sidebar;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.sidebar-head {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.logo { color: var(--accent); font-weight: bold; }
.status.off { color: var(--bad); }
/* The first action button absorbs the spare horizontal space so the status
   sits next to "caint" on the left and the icon buttons are right-aligned. */
.first-action { margin-left: auto; }
.link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 0 4px;
  cursor: pointer;
  font: inherit;
  text-decoration: none;
}
.link:hover { color: var(--fg); }

.topic {
  grid-area: topic;
  padding: 8px 12px;
  display: flex;
  align-items: baseline;
  gap: 1ch;
  white-space: nowrap;
  overflow: hidden;
}
.topic-divider {
  grid-area: divider;
  background: var(--border);
  height: 1px;
}
.topic .buffer { color: var(--accent); }
.topic .count  { color: var(--fg-muted); }
.topic .sep    { color: var(--border); }
.topic .topic-text {
  color: var(--fg-muted);
  text-overflow: ellipsis;
  overflow: hidden;
}

/* These selectors target the root elements of the imported components.
   Vue 3 scoped CSS attaches the parent's data-v attribute to a child
   component's root element, so .message-list / .members / .input here
   match the rendered roots of MessageList / MemberList / MessageInput. */
.message-list { grid-area: messages; }
.members      { grid-area: members; border-left: 1px solid var(--border); }
.input        { grid-area: input; }
</style>
