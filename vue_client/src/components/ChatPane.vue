<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <section
    class="pane"
    :class="{ 'members-collapsed': !showMembers, focused: multiPane && isFocused }"
    @mousedown.capture="focusPane"
  >
    <header class="topic">
      <div class="topic-meta">
        <span class="buffer">{{ bufferLabel }}</span>
        <template v-if="!isVirtual && topic">
          <span class="sep">│</span>
          <button
            type="button"
            class="topic-text"
            title="View full topic"
            @click="showTopic = true"
          >
            <LinkedText :text="topic" />
          </button>
        </template>
      </div>
      <div class="topic-actions">
        <!-- Friends overview header: add-friend + count -->
        <template v-if="isFriendsBuffer">
          <button
            type="button"
            class="link"
            title="Add friend"
            aria-label="Add friend"
            @click="friends.openEditorNew()"
          >
            <i class="fa-solid fa-person-circle-plus"></i>
          </button>
          <span
            class="member-count"
            :title="`${friendCount} ${friendCount === 1 ? 'friend' : 'friends'}`"
          >
            <i class="fa-solid fa-users"></i> {{ friendCount }}
          </span>
        </template>
        <!-- Real IRC buffer headers -->
        <template v-else-if="active">
          <template v-if="isServerBuffer">
            <button
              type="button"
              class="link"
              title="Channel list"
              aria-label="Channel list"
              @click="active && channelListModal.open(active.networkId)"
            >
              <i class="fa-solid fa-hashtag"></i>
            </button>
            <button
              type="button"
              class="link"
              :title="serverConnectActionLabel"
              :aria-label="serverConnectActionLabel"
              @click="toggleServerConnection"
            >
              <i :class="serverConnectActionIcon"></i>
            </button>
            <button class="link" title="Edit network" @click="editActiveNetwork">
              <i class="fa-solid fa-gear"></i>
            </button>
          </template>
          <template v-else-if="isDmHeader">
            <button
              type="button"
              class="link"
              title="View profile"
              aria-label="View profile"
              @click="openDmProfile"
            >
              <i class="fa-solid fa-id-card"></i>
            </button>
            <button
              type="button"
              class="link"
              :title="dmNoteLabel"
              :aria-label="dmNoteLabel"
              @click="openDmNote"
            >
              <i class="fa-solid fa-note-sticky"></i>
            </button>
          </template>
          <template v-else-if="isChannel">
            <button
              type="button"
              class="link notify"
              :class="{ on: channelNotifyAlways }"
              :title="channelNotifyLabel"
              :aria-label="channelNotifyLabel"
              @click="toggleChannelNotify"
            >
              <i :class="channelNotifyAlways ? 'fa-solid fa-bell' : 'fa-regular fa-bell'"></i>
            </button>
            <button
              class="link"
              :title="showMembers ? 'Hide members' : 'Show members'"
              :aria-label="showMembers ? 'Hide members' : 'Show members'"
              @click="toggleMembers"
            >
              <i class="fa-solid fa-users"></i>
            </button>
            <span
              v-if="memberCount != null"
              class="member-count"
              :title="`${memberCount} ${memberCount === 1 ? 'user' : 'users'} in channel`"
              >{{ memberCount }}</span
            >
          </template>
        </template>
        <!-- Close this pane (only when more than one is open) -->
        <button
          v-if="multiPane"
          type="button"
          class="link pane-close"
          title="Close pane"
          aria-label="Close pane"
          @click="networks.closePane(pane.id)"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </header>
    <div class="topic-divider"></div>

    <FriendsOverview
      v-if="renderMode === 'overview'"
      @view-activity="$emit('view-activity', $event)"
    />
    <MessageList
      v-else
      ref="messageListRef"
      :buffer-key="pane.key"
      :is-focused="isFocused"
      :pending-scroll-id="isFocused ? pendingScrollId : null"
    />
    <MemberList v-if="showMembers && hasNicklist" :buffer-key="pane.key" />

    <TopicModal
      v-if="showTopic && active"
      :topic="topic"
      :label="bufferLabel"
      @close="showTopic = false"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Network, Pane } from '../stores/networks.js';
import { useNetworksStore } from '../stores/networks.js';
import type { Buffer } from '../stores/buffers.js';
import { useActiveBuffer } from '../composables/useActiveBuffer.js';
import { useSettingsStore } from '../stores/settings.js';
import { useNicklistCollapseStore } from '../stores/nicklistCollapse.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useFriendsStore } from '../stores/friends.js';
import { useWhoisStore } from '../stores/whois.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { useChannelListModal } from '../composables/useChannelListModal.js';
import { useNetworkEditor } from '../composables/useNetworkEditor.js';
import MessageList from './MessageList.vue';
import MemberList from './MemberList.vue';
import FriendsOverview from './FriendsOverview.vue';
import LinkedText from './LinkedText.vue';
import TopicModal from './TopicModal.vue';

const props = withDefaults(
  defineProps<{
    pane: Pane;
    pendingScrollId?: number | string | null;
  }>(),
  { pendingScrollId: null },
);

defineEmits<{ (e: 'view-activity', query: string): void }>();

const networks = useNetworksStore();
const settings = useSettingsStore();
const nicklistCollapse = useNicklistCollapseStore();
const nickNotes = useNickNotesStore();
const friends = useFriendsStore();
const whois = useWhoisStore();
const channelNotify = useChannelNotifyStore();
const channelListModal = useChannelListModal();
const networkEditor = useNetworkEditor();

// Buffer state scoped to THIS pane's key (not the focused pane), so each pane
// renders its own header, messages, and nicklist.
const {
  active,
  activeBuf,
  topic,
  isServerBuffer,
  isChannel,
  bufferLabel,
  isVirtual,
  isFriendsBuffer,
  renderMode,
  hasNicklist,
} = useActiveBuffer(() => props.pane.key);

const friendCount = computed(() => friends.contacts.length);
const showTopic = ref(false);

const multiPane = computed(() => networks.panes.length > 1);
const isFocused = computed(() => networks.focusedPaneId === props.pane.id);
// mousedown.capture fires before the click reaches the input-focus forwarder in
// DesktopChat, so the pane the user interacts with becomes focused first.
function focusPane() {
  networks.setFocusedPane(props.pane.id);
}

const messageListRef = ref<{ scrollByPage: (dir: number) => void } | null>(null);
defineExpose({
  scrollByPage: (dir: number) => messageListRef.value?.scrollByPage(dir),
});

// ── Header logic (moved from DesktopChat, now pane-scoped) ─────────────────
const isDmHeader = computed(() => {
  if (!active.value) return false;
  if (isChannel.value || isServerBuffer.value) return false;
  // Thread buffers aren't DMs — no profile/note actions for them.
  if (active.value.target.startsWith(':thread:')) return false;
  return true;
});
function openDmProfile() {
  if (!active.value) return;
  whois.openViewer(active.value.networkId, active.value.target);
}
const dmNoteLabel = computed(() =>
  active.value && nickNotes.hasNote(active.value.networkId, active.value.target)
    ? 'Edit note'
    : 'Add note',
);
function openDmNote() {
  if (!active.value) return;
  nickNotes.openEditor(active.value.networkId, active.value.target);
}

const channelNotifyAlways = computed(() => {
  if (!isChannel.value || !active.value) return false;
  return channelNotify.notifyAlways(active.value.networkId, active.value.target);
});
const channelNotifyLabel = computed(() =>
  channelNotifyAlways.value ? 'Stop always notifying' : 'Always notify',
);
function toggleChannelNotify() {
  if (!isChannel.value || !active.value) return;
  channelNotify.setNotifyAlways(
    active.value.networkId,
    active.value.target,
    !channelNotifyAlways.value,
  );
}

const memberCount = computed(() => {
  if (!isChannel.value) return null;
  return (activeBuf.value as Buffer | null)?.members?.length ?? null;
});

const showMembers = computed(() => {
  if (!isChannel.value || !active.value) return false;
  const { networkId, target } = active.value;
  const override = nicklistCollapse.override(networkId, target);
  if (override !== undefined) return !override;
  return settings.effective('look.layout.show_member_list');
});
function toggleMembers() {
  if (!isChannel.value || !active.value) return;
  const { networkId, target } = active.value;
  nicklistCollapse.setCollapsed(networkId, target, !!showMembers.value);
}

function editActiveNetwork() {
  const net = active.value?.network as Network | undefined;
  if (net) networkEditor.open(net);
}

const serverConnectionState = computed(() => {
  if (!active.value || !isServerBuffer.value) return null;
  return networks.states[active.value.networkId]?.state ?? null;
});
const serverConnectActionLabel = computed(() =>
  serverConnectionState.value === 'connected' ? 'Disconnect' : 'Reconnect',
);
const serverConnectActionIcon = computed(() =>
  serverConnectionState.value === 'connected'
    ? 'fa-solid fa-plug-circle-xmark'
    : 'fa-solid fa-plug',
);
function toggleServerConnection() {
  if (!active.value) return;
  const id = active.value.networkId;
  const p =
    serverConnectionState.value === 'connected' ? networks.disconnect(id) : networks.reconnect(id);
  p.catch((err) => console.error('[ChatPane] toggle server connection failed', err));
}
</script>

<style scoped>
/* One pane: topic + divider on top, then the message list beside the (optional)
   member list. Mirrors the inner portion of DesktopChat's old grid, but scoped
   to a single buffer so several can sit side-by-side. */
.pane {
  --members-w: 180px;
  display: grid;
  grid-template-columns: 1fr var(--members-w);
  grid-template-rows: auto auto 1fr;
  grid-template-areas:
    'topic    topic'
    'divider  divider'
    'messages members';
  min-width: 0;
  height: 100%;
  overflow: hidden;
}
.pane.members-collapsed {
  --members-w: 0px;
}
.pane > * {
  min-width: 0;
  min-height: 0;
}

/* These selectors target the root elements of the imported components — Vue 3
   scoped CSS stamps this component's data-v attribute on a child component's
   root, so .message-list / .members match MessageList / MemberList. */
.message-list {
  grid-area: messages;
}
.members {
  grid-area: members;
  border-left: 1px solid var(--border);
}

.topic {
  grid-area: topic;
  padding: var(--space-4) var(--space-6);
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  white-space: nowrap;
  overflow: hidden;
}
/* Focused-pane tell (only meaningful with 2+ panes): a thin accent rule under
   the topic bar so the user knows which pane the shared input/status target. */
.pane.focused .topic {
  box-shadow: inset 0 -2px 0 var(--accent);
}
.topic-divider {
  grid-area: divider;
  background: var(--border);
  height: 1px;
}
.topic .buffer {
  color: var(--accent);
}
.topic .sep {
  color: var(--border);
}
.topic .topic-text {
  color: var(--fg-muted);
  text-overflow: ellipsis;
  overflow: hidden;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  min-width: 0;
}
.topic .topic-text:hover {
  color: var(--fg);
}
.topic .topic-text:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}
.topic-meta {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  min-width: 0;
  overflow: hidden;
}
.topic-actions {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  flex-shrink: 0;
}
.topic-actions .notify {
  color: var(--fg-muted);
}
.topic-actions .notify.on {
  color: var(--accent);
}
.topic .member-count {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
.link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 0 var(--space-2);
  cursor: pointer;
  font: inherit;
  text-decoration: none;
}
.link:hover {
  color: var(--fg);
}
</style>
