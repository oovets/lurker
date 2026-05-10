<template>
  <div class="mchat">
    <!-- Screen: channel list -->
    <section v-if="screen === 'list'" class="screen list">
      <header class="bar">
        <span class="logo">caint</span>
        <span v-if="!connected" class="status off" title="Disconnected">●</span>
        <span class="spacer"></span>
        <button class="icon" title="Highlights" @click="showHighlights = true">
          <i class="fa-regular fa-bell"></i>
        </button>
        <RouterLink class="icon" to="/settings" title="Settings">
          <i class="fa-solid fa-gear"></i>
        </RouterLink>
      </header>
      <div class="bufferlist-wrap" @click="onBufferListClick">
        <BufferList />
      </div>
    </section>

    <!-- Screen: buffer -->
    <section v-else-if="screen === 'buffer'" class="screen buffer">
      <header class="bar">
        <button class="icon back" title="Back" @click="goList">
          <i class="fa-solid fa-arrow-left"></i>
        </button>
        <span class="title">{{ bufferLabel }}</span>
        <span class="spacer"></span>
        <button class="icon" title="Highlights" @click="showHighlights = true">
          <i class="fa-regular fa-bell"></i>
        </button>
        <button
          v-if="isChannel"
          class="icon"
          title="Members"
          @click="screen = 'members'"
        ><i class="fa-solid fa-users"></i></button>
      </header>
      <MessageList :pending-scroll-id="pendingScrollId" />
      <StatusBar compact />
      <MessageInput ref="messageInputRef" />
    </section>

    <!-- Screen: members -->
    <section v-else-if="screen === 'members'" class="screen members-screen">
      <header class="bar">
        <button class="icon back" title="Back" @click="screen = 'buffer'">
          <i class="fa-solid fa-arrow-left"></i>
        </button>
        <span class="title">{{ bufferLabel }} — members</span>
      </header>
      <MemberList />
    </section>

    <HighlightsModal
      v-if="showHighlights"
      @close="showHighlights = false"
      @jump="onJumpToMessage"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useSocket } from '../composables/useSocket.js';
import { startPresenceReporter, reportNow } from '../composables/usePresence.js';
import { registerSW, onSWPushMessage } from '../composables/usePush.js';
import { useVisualViewportHeight } from '../composables/useViewport.js';
import BufferList from '../components/BufferList.vue';
import MessageList from '../components/MessageList.vue';
import MessageInput from '../components/MessageInput.vue';
import MemberList from '../components/MemberList.vue';
import StatusBar from '../components/StatusBar.vue';
import HighlightsModal from '../components/HighlightsModal.vue';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const settings = useSettingsStore();
const { connected } = useSocket();
const { activeKey } = storeToRefs(networks);

// Pin --viewport-h to the visualViewport height so the shell stays glued to
// the visible region when the iOS soft keyboard pushes content up.
useVisualViewportHeight();

// `list` (default) → tap a buffer → `buffer` → tap members icon → `members`.
// Back arrows walk the stack backwards. We don't sync this to the URL — the
// flow is short and stateful, and a URL would expose us to bookmarks that
// land on the buffer screen with no active buffer.
const screen = ref('list');
const showHighlights = ref(false);
const pendingScrollId = ref(null);
const messageInputRef = ref(null);

const active = computed(() => networks.activeBuffer);
const isServerBuffer = computed(() => !!active.value?.target?.startsWith(':server:'));
const isChannel = computed(() => !!active.value?.target?.startsWith('#'));
const bufferLabel = computed(() => {
  const t = active.value?.target;
  if (!t) return '';
  if (isServerBuffer.value) return active.value?.network?.name || 'server';
  return t;
});

// BufferList calls buffers.activate() directly on click; we react to the
// activeKey flip rather than intercepting the click so the same store state
// drives both layouts. Only auto-advance from the list — if a remote event
// changes activeKey while the user is on the members screen, leave them be.
watch(activeKey, (next) => {
  if (next && screen.value === 'list') screen.value = 'buffer';
});

// Re-tapping the *same* buffer the user was last in doesn't change activeKey
// so the watcher above doesn't fire. Catch the bubbled click here as a
// belt-and-suspenders advance: if a row was hit and a buffer is active, go
// to the buffer screen. Vue event bubbling runs BufferList's @click first,
// so by the time we read activeKey it's already up to date.
function onBufferListClick(e) {
  const hit = e.target.closest('.channels li, .net-head');
  if (!hit) return;
  if (activeKey.value) screen.value = 'buffer';
}

function goList() {
  screen.value = 'list';
}

function onJumpToMessage({ networkId, target, messageId }) {
  buffers.activate(networkId, target);
  pendingScrollId.value = messageId;
  screen.value = 'buffer';
}

onMounted(async () => {
  if (!settings.loaded) settings.fetchAll().catch(() => {});
  await networks.fetchAll();
  // Always land on the list. /settings is only reachable via the list
  // header, so back-from-settings should return to the list — not drop the
  // user into whatever buffer happened to be active.
  startPresenceReporter();
  reportNow();
  registerSW().catch(() => { /* ignore */ });
  onSWPushMessage((data) => {
    if (data?.kind === 'jump') onJumpToMessage(data);
  });
});

</script>

<style scoped>
/* The shell is a fixed-position single-column flex stack pinned to the
   *visual* viewport, not the layout viewport. This is what defeats iOS
   Safari's keyboard-opens-and-scrolls-the-page-up behavior:
     - position: fixed + top: 0 alone isn't enough — iOS still scrolls the
       layout viewport when an input is focused, dragging fixed elements
       along with it.
     - height: var(--viewport-h) shrinks the shell to the visible area so
       the input sits above the keyboard instead of behind it.
     - translateY(var(--viewport-y)) cancels out Safari's auto-scroll so
       the top of the shell lines up with the top of the visible area.
   The 100dvh / 0 fallbacks keep the layout sensible on first paint and on
   browsers without visualViewport. */
.mchat {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: var(--viewport-h, 100dvh);
  transform: translateY(var(--viewport-y, 0));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.screen {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* Header bar (top of every screen). Uses the same accent + border colors as
   the desktop sidebar so the two layouts feel like one app. */
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.logo { color: var(--accent); font-weight: bold; }
.status.off { color: var(--bad); }
.title {
  color: var(--accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.spacer { flex: 1; }
.icon {
  background: none;
  border: none;
  color: var(--accent);
  padding: 4px 8px;
  cursor: pointer;
  font: inherit;
  text-decoration: none;
  /* Big enough touch target without dominating the header height. */
  min-width: 36px;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.icon:hover { color: var(--fg); }
.icon.back { margin-left: -4px; }

/* The buffer screen's MessageList + StatusBar + MessageInput chain mirrors
   the desktop rows but in a vertical flex. min-height: 0 on the screen +
   flex: 1 on MessageList is what lets it scroll without pushing the input
   off the visible viewport. */
.buffer :deep(.message-list) { flex: 1; min-height: 0; }
.buffer :deep(.status-bar) { flex: 0 0 auto; }
.buffer :deep(.input) { flex: 0 0 auto; }

/* Member list takes the rest of the height on its own screen. */
.members-screen :deep(.members) { flex: 1; min-height: 0; }

/* The wrap is the flex child that takes the rest of the list screen; the
   inner BufferList's own `flex: 1; overflow: auto` handles its scroll. */
.bufferlist-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.bufferlist-wrap :deep(.buffer-list) { flex: 1; min-height: 0; }
</style>
