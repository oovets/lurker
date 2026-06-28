<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div
    class="chat"
    :class="{
      'sidebar-collapsed': !showChannels,
      'system-active': isSystemBuffer,
    }"
    @click="onChatClick"
  >
    <aside class="sidebar" :class="{ collapsed: !showChannels }">
      <!-- The "lurker" header + connection dot live in BufferList's LURKER row
           (#355); the collapse control lives there too. When collapsed the list
           is unmounted, so the expand control returns to the top of the rail. -->
      <BufferList v-if="showChannels" />
      <button v-else class="link rail-toggle" title="Show channel list" @click="toggleChannels">
        <i class="fa-solid fa-angles-right"></i>
      </button>
      <div ref="footEl" class="sidebar-foot" :class="{ 'foot-wrapped': footWrapped }">
        <button class="link" @click="openSettings" title="Settings">
          <i class="fa-solid fa-gear"></i>
        </button>
        <button class="link" @click="showSearch = true" title="Search messages">
          <i class="fa-solid fa-magnifying-glass"></i>
        </button>
        <button class="link" @click="showHighlights = true" title="Highlights">
          <i class="fa-solid fa-bell"></i>
        </button>
        <button class="link" @click="showBookmarks = true" title="Saved messages">
          <i class="fa-solid fa-bookmark"></i>
        </button>
        <button class="link" @click="showUploads = true" title="Recent uploads">
          <i class="fa-solid fa-paperclip"></i>
        </button>
        <button class="link" @click="openAddNetwork" title="Add network">
          <i class="fa-solid fa-plus"></i>
        </button>
      </div>
    </aside>

    <div class="panes" :style="{ '--pane-cols': gridCols, '--pane-rows': gridRows }">
      <ChatPane
        v-for="(pane, i) in networks.panes"
        :key="pane.id"
        :ref="(el) => setPaneRef(pane.id, el)"
        :pane="pane"
        :pending-scroll-id="pendingScrollId"
        :style="
          i === networks.panes.length - 1 && lastSpan > 1
            ? { gridColumn: `span ${lastSpan}` }
            : undefined
        "
        @view-activity="onViewActivity"
      />
    </div>
    <StatusBar />
    <MessageInput v-if="hasInput" ref="messageInputRef" />

    <NetworkForm
      v-if="networkEditor.isOpen"
      :network="networkEditor.editingNetwork ?? undefined"
      @close="closeNetworkForm"
    />
    <HighlightsModal
      v-if="showHighlights"
      @close="showHighlights = false"
      @jump="onJumpToMessage"
    />
    <BookmarksModal v-if="showBookmarks" @close="showBookmarks = false" @jump="onJumpToMessage" />
    <ChannelListModal
      v-if="channelListModal.isOpen && channelListModal.networkId !== null"
      :network-id="channelListModal.networkId!"
      @close="channelListModal.close()"
    />
    <RecentUploadsModal v-if="showUploads" @close="showUploads = false" />
    <QuickSwitcher v-if="showSwitcher" @close="showSwitcher = false" />
    <SearchModal v-if="showSearch" @close="showSearch = false" @jump="onJumpToMessage" />
    <KeyboardHelpModal v-if="showKbdHelp" @close="showKbdHelp = false" />
    <ImageViewerModal
      v-if="imageModal.isOpen && imageModal.url !== null"
      :url="imageModal.url"
      @close="imageModal.close()"
    />
    <UserProfileModal
      v-if="whois.viewer.open && whois.viewer.networkId != null"
      :nick="whois.viewer.nick"
      :network-id="whois.viewer.networkId"
    />
    <!-- NickNoteModal comes last so when both are open (edit-note-from-profile)
         it lands on top — AppModal uses a fixed z-index, so DOM order is the
         tiebreaker. -->
    <NickNoteModal
      v-if="nickNotes.editor.open && nickNotes.editor.networkId != null"
      :nick="nickNotes.editor.nick"
      :network-id="nickNotes.editor.networkId"
    />
    <ConfigureFriendModal v-if="friends.editor.open" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useBuffersStore } from '../stores/buffers.js';
import { SYSTEM_KEY } from '../lib/virtualBuffers.js';
import { useSocket } from '../composables/useSocket.js';
import { useNetworksStore } from '../stores/networks.js';
import { useChatBootstrap } from '../composables/useChatBootstrap.js';
import { useActiveBuffer } from '../composables/useActiveBuffer.js';
import { useSettingsStore } from '../stores/settings.js';
import BufferList from '../components/BufferList.vue';
import ChatPane from '../components/ChatPane.vue';
import MessageInput from '../components/MessageInput.vue';
import StatusBar from '../components/StatusBar.vue';
import NetworkForm from '../components/NetworkForm.vue';
import HighlightsModal from '../components/HighlightsModal.vue';
import BookmarksModal from '../components/BookmarksModal.vue';
import ChannelListModal from '../components/ChannelListModal.vue';
import RecentUploadsModal from '../components/RecentUploadsModal.vue';
import QuickSwitcher from '../components/QuickSwitcher.vue';
import SearchModal from '../components/SearchModal.vue';
import KeyboardHelpModal from '../components/KeyboardHelpModal.vue';
import NickNoteModal from '../components/NickNoteModal.vue';
import ConfigureFriendModal from '../components/ConfigureFriendModal.vue';
import UserProfileModal from '../components/UserProfileModal.vue';
import ImageViewerModal from '../components/ImageViewerModal.vue';
import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useFriendsStore } from '../stores/friends.js';
import { useSearchStore } from '../stores/search.js';
import { useWhoisStore } from '../stores/whois.js';
import { useChannelListModal } from '../composables/useChannelListModal.js';
import { useImageModal } from '../composables/useImageModal.js';
import { useNetworkEditor } from '../composables/useNetworkEditor.js';
import { useJumpToMessage } from '../composables/useJumpToMessage.js';

const networks = useNetworksStore();
const buffers = useBuffersStore();
// Registers the WebSocket connect lifecycle (onMounted) for the desktop shell —
// must be called even though we don't read `connected` here (the LURKER row's
// status light reads the exported `connected` ref directly). Without this call
// the socket never opens: red status light + no buffers (#355 regression).
useSocket();

// Land on the system buffer instead of a blank "No messages yet." pane when
// nothing else is active on load (#355). The last-active buffer isn't persisted,
// so activeKey is null on every fresh load; the system buffer always exists in
// the store, so this is always a valid target. Guarded on null so a deep-link /
// push-jump that set a buffer first still wins.
onMounted(() => {
  if (networks.activeKey == null) buffers.activate(null, SYSTEM_KEY);
});
// Focused-pane state for the shell's own bits: the type-ahead guard (don't
// grab focus when no real buffer is active), the system-active input border,
// and whether to render the single shared input. Per-pane header/messages/
// nicklist live in ChatPane now.
const { active, isSystemBuffer, hasInput } = useActiveBuffer();

const settings = useSettingsStore();
// Stores read by the shell-level modals rendered below (profile, note, friend).
const nickNotes = useNickNotesStore();
const friends = useFriendsStore();
const whois = useWhoisStore();

const channelListModal = reactive(useChannelListModal());
const imageModal = reactive(useImageModal());
const networkEditor = reactive(useNetworkEditor());
const showHighlights = ref(false);
const showBookmarks = ref(false);
const showUploads = ref(false);
const showSwitcher = ref(false);
const showSearch = ref(false);
const showKbdHelp = ref(false);
const pendingScrollId = ref<number | null>(null);

// "View activity" from the Friends overview: open Search with the scoped query
// (from:<nick> on:<network>) and run it immediately.
function onViewActivity(query: string) {
  useSearchStore().runQuery(query);
  showSearch.value = true;
}
const messageInputRef = ref<{ focus: () => void } | null>(null);
// One ChatPane handle per pane id, so keyboard PageUp/Down scrolls the FOCUSED
// pane's message list. Vue calls the function ref with the instance on mount
// and null on unmount, so the map stays in sync as panes open/close.
const paneRefs = new Map<string, { scrollByPage: (dir: number) => void }>();
function setPaneRef(id: string, el: unknown) {
  if (el) paneRefs.set(id, el as { scrollByPage: (dir: number) => void });
  else paneRefs.delete(id);
}

// Auto-wrapping 2D grid for the panes. Columns grow as the square root of the
// pane count so the layout stays balanced (1→1×1, 2→2×1, 3→2×2, 4→2×2, 5→3×2…)
// instead of an ever-thinner single row. A short last row is filled by spanning
// its final pane across the leftover columns, so there's no empty cell.
const paneCount = computed(() => networks.panes.length);
const gridCols = computed(() => Math.ceil(Math.sqrt(paneCount.value)));
const gridRows = computed(() => Math.ceil(paneCount.value / gridCols.value));
const lastSpan = computed(() => {
  const lastRowCount = paneCount.value - (gridRows.value - 1) * gridCols.value;
  return gridCols.value - lastRowCount + 1;
});

// Any modal open? Type-ahead must not steal focus from a modal's own fields.
const anyModalOpen = computed(
  () =>
    networkEditor.isOpen ||
    showHighlights.value ||
    showBookmarks.value ||
    channelListModal.isOpen ||
    imageModal.isOpen ||
    showUploads.value ||
    showSwitcher.value ||
    showSearch.value ||
    showKbdHelp.value,
);

useKeyboardShortcuts({
  onOpenSwitcher: () => {
    showSwitcher.value = true;
  },
  onOpenHelp: () => {
    showKbdHelp.value = true;
  },
  onOpenSearch: () => {
    showSearch.value = true;
  },
  onTypeAhead: () => {
    if (anyModalOpen.value || !active.value) return;
    messageInputRef.value?.focus();
  },
  onScrollMessages: (dir) => {
    if (anyModalOpen.value) return;
    paneRefs.get(networks.focusedPaneId)?.scrollByPage(dir);
  },
});

const showChannels = computed(() => settings.effective('look.layout.show_channel_list'));

// Sidebar-foot wrap detector. At large `look.font.size` settings the six icons
// overflow the fixed 220px sidebar and flex-wrap to a second row. Browser's
// natural wrap packs as-many-as-fit on row 1 (5+1 or 4+2 looks lopsided);
// we'd rather show a clean 3+3 split. Measure offsetTop of first vs last
// icon in the natural flex layout — when they differ, the row wrapped, and
// `.foot-wrapped` swaps the flex layout for a 3-column grid. The class is
// stripped before measuring so we read the flex state, not our own override
// (otherwise the icons would always be on different rows and we'd be stuck
// in 3+3 even after the user shrinks the font back down). The detector
// also bails out and clears the flag while the sidebar is collapsed: the
// collapsed rail uses `flex-direction: column` so every icon stacks on its
// own row, which would otherwise stick the flag true and force the 3-col
// grid on re-expand even at default font.
const footEl = ref<HTMLElement | null>(null);
const footWrapped = ref(false);
async function measureFootWrap() {
  const el = footEl.value;
  if (!el || el.children.length < 2) return;
  if (!showChannels.value) {
    footWrapped.value = false;
    return;
  }
  if (footWrapped.value) {
    footWrapped.value = false;
    await nextTick();
  }
  const first = (el.children[0] as HTMLElement).offsetTop;
  const last = (el.children[el.children.length - 1] as HTMLElement).offsetTop;
  footWrapped.value = first !== last;
}
watch(
  () => settings.effective('look.font.size'),
  () => void measureFootWrap(),
);
// Re-measure when the sidebar expands — we cleared the flag on collapse, so
// without this the foot would stay flex-wrapped (5+1 / 4+2) even at fonts
// that triggered the grid before the user collapsed.
watch(showChannels, async (open) => {
  if (!open) return;
  await nextTick();
  void measureFootWrap();
});
onMounted(measureFootWrap);

function toggleChannels() {
  settings.setValue('look.layout.show_channel_list', !showChannels.value);
}

// Forward stray clicks anywhere in the chat frame (topic bar, message list,
// member list, sidebar gutter, etc.) into the message input. The selector
// excludes anything genuinely interactive — buttons, links, form controls,
// and modal contents — and we bail if the user is in the middle of selecting
// text so we don't kill their selection.
function onChatClick(e: MouseEvent) {
  if (
    (e.target as Element).closest(
      'button, a, input, textarea, select, label, .modal, [contenteditable=true]',
    )
  )
    return;
  const sel = window.getSelection();
  if (sel && sel.toString().length > 0) return;
  messageInputRef.value?.focus();
}

const onJumpToMessage = useJumpToMessage({ pendingScrollId });

const router = useRouter();
// Collapsed-only footer affordance: the settings cog normally lives on the
// LURKER sidebar row, but that whole list is unmounted when the sidebar is
// collapsed (BufferList v-if), so the rail offers the cog here instead (#355).
function openSettings() {
  router.push('/settings');
}

function openAddNetwork() {
  networkEditor.open();
}
function closeNetworkForm() {
  networkEditor.close();
}

useChatBootstrap({ onJump: onJumpToMessage });
</script>

<style scoped>
/* WeeChat-style frame: the sidebar runs full height on the left; the panes row
   fills the middle; and the status + input bars span the full width to the
   right of the sidebar at the bottom.

   The per-pane topic/divider/messages/members layout now lives inside ChatPane
   (one column per split pane). DesktopChat only owns the outer sidebar | content
   split and the single shared status + input. The sidebar width is a custom
   property so .sidebar-collapsed can shrink it to a 36px rail. */
.chat {
  --sidebar-w: 220px;
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  grid-template-rows: 1fr auto auto;
  grid-template-areas:
    'sidebar panes'
    'sidebar status'
    'sidebar input';
  /* Height sized to the dynamic viewport. iOS scrolls the page
     naturally when the keyboard opens; the input row at the bottom
     stays visible above the keyboard, and the upper portion (sidebar,
     panes, older messages) scrolls off the top of the visible area.
     See issue #85. */
  height: 100dvh;
  overflow: hidden;
}
.chat.sidebar-collapsed {
  --sidebar-w: 36px;
}
/* The status bar carries the separator border above the input, but it's hidden
   in the system buffer (no network state to show). Give the input its own top
   border there so it stays visually divided from the message list. */
.chat.system-active .input {
  border-top: 1px solid var(--border);
}
/* min-height/min-width 0 lets flex/scrolling children stay inside their row. */
.chat > * {
  min-width: 0;
  min-height: 0;
}

/* The panes area: an auto-wrapping 2D grid of ChatPane cells. --pane-cols and
   --pane-rows are set inline from the pane count (see gridCols/gridRows), and
   `1px` gaps over a --border background paint the dividing lines between panes
   in both axes — vertical rules between columns, horizontal rules between rows.
   minmax(0, 1fr) lets the scrolling message lists shrink inside their cells. */
.panes {
  grid-area: panes;
  display: grid;
  grid-template-columns: repeat(var(--pane-cols, 1), minmax(0, 1fr));
  grid-template-rows: repeat(var(--pane-rows, 1), minmax(0, 1fr));
  gap: 1px;
  background: var(--border);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.panes > .pane {
  min-width: 0;
  min-height: 0;
  /* Cover the --border container background; the 1px gaps stay visible as the
     inter-pane divider lines. */
  background: var(--bg);
}

.sidebar {
  grid-area: sidebar;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
/* Pin the collapse toggle flush-left and the plus (add network) flush-right;
   the middle icons distribute evenly between them. Flex with space-between
   scales to any number of middle icons without re-tuning the column count.
   `padding: 1ch 12px 8px` (not the original symmetric 8px) makes the foot's
   top padding scale with the font the way the status bar's does — both have
   `padding-top: 1ch` — so the foot's top border lines up with the status
   bar's top border at any font size in the two-row wrapped state, and the
   top icon row sits the same `1ch` below its border as the status text does
   below its own. Bottom stays at 8px so the bottom row stays vertically
   centered with the input bar's text (whose box also has `padding: 8px`).
   flex-wrap so a large `look.font.size` setting (which scales icons but
   not the fixed 220px sidebar) wraps the rightmost icons to a second row
   inside the foot instead of overflowing into the input bar to the right
   (issue #64). */
.sidebar-foot {
  margin-top: auto;
  padding: 1ch var(--space-6) var(--space-4);
  border-top: 1px solid var(--border);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  /* Match the input bar's line-height (1.4) — the body default of 1.55
     would leave the foot's content row visibly taller than the input's
     content row at the same font size. See the matching override on
     .status-bar. */
  line-height: 1.4;
}
/* When the icons wrap, swap to a 3-column grid so the six icons split
   evenly into 2 rows of 3 instead of the browser's natural "as many as fit
   then leftovers" packing (which lands at 5+1 or 4+2 at borderline fonts).
   Only kicks in when the foot is expanded — the collapsed rail's own
   flex-column override below takes precedence. */
.sidebar:not(.collapsed) .sidebar-foot.foot-wrapped {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  justify-items: center;
}
/* Collapsed rail: swap the foot to a vertical stack and center everything in
   the 36px column. The expand toggle sits at the top of the rail (.rail-toggle);
   the foot holds the stacked tool icons + settings cog. */
.sidebar.collapsed .sidebar-foot {
  flex-direction: column;
  padding: var(--space-4) 0;
  gap: var(--space-4);
  justify-content: flex-end;
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
/* Expand control at the top of the collapsed rail — the in-list collapse
   button is unmounted with the channel list, so this brings it back up top.
   Mirrors the LURKER header it stands in for so its bottom rule lines up with
   the topic divider: full-rail width, the same var(--space-4) block padding,
   and the icon in a normal line box (not flex — that sized to the glyph, ~1em,
   leaving the rule too high; text-align keeps the headers' line-height box). */
.rail-toggle {
  align-self: stretch;
  text-align: center;
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--border);
}
/* The global `button:hover` repaints border-color to --accent, which would
   recolor the bottom rule on hover. Pin it back to --border — and keep it a
   real border (not a box-shadow) so the rule's 1px keeps the toggle the same
   height as the LURKER header / topic bar it lines up with. Specificity here
   (0,3,0) beats the global `button:hover:not(:disabled)` (0,2,1). */
.rail-toggle:hover:not(:disabled) {
  border-color: var(--border);
}

/* These selectors target the root elements of the imported components.
   Vue 3 scoped CSS attaches the parent's data-v attribute to a child
   component's root element, so .status-bar / .input here match the rendered
   roots of StatusBar / MessageInput. (The per-pane topic/messages/members
   styling now lives in ChatPane.) */
.status-bar {
  grid-area: status;
}
.input {
  grid-area: input;
}
</style>
