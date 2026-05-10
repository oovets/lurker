<template>
  <form ref="formEl" class="input" @submit.prevent="submit">
    <span class="clock">[{{ clock }}]</span>
    <span class="prompt">{{ promptLabel }}<span v-if="awayLabel" class="away">&nbsp;{{ awayLabel }}</span>&nbsp;&gt;</span>
    <input
      ref="inputEl"
      v-model="text"
      :placeholder="placeholder"
      :disabled="!active"
      autocomplete="off"
      spellcheck="false"
      @keydown="onKeydown"
      @blur="resetCompletion"
    />
    <TypingIndicator class="typing" />
    <NickPicker
      :open="pickerOpen"
      :query="pickerQuery"
      :buffer="buffer"
      :self-nick="ownNick"
      :anchor="formEl"
      @select="onPickerSelect"
      @close="closePicker"
    />
  </form>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount, onMounted } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { socketSend } from '../composables/useSocket.js';
import { formatTimestamp } from '../utils/timestamp.js';
import TypingIndicator from './TypingIndicator.vue';
import NickPicker from './NickPicker.vue';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const settings = useSettingsStore();
const text = ref('');
const inputEl = ref(null);
const formEl = ref(null);
const pickerOpen = ref(false);
const pickerQuery = ref('');
let pickerTokenStart = -1;
let pickerTokenEnd = -1;

const active = computed(() => networks.activeBuffer);
const buffer = computed(() => (active.value
  ? buffers.byKey(`${active.value.networkId}::${active.value.target}`)
  : null));
const ownNick = computed(() => {
  const a = active.value;
  if (!a) return '';
  return networks.states[a.networkId]?.nick || '';
});
const isServer = computed(() => active.value?.target?.startsWith(':server:'));
const sendable = computed(() => !!active.value && !isServer.value);
const placeholder = computed(() => {
  if (!active.value) return 'Select a buffer';
  if (isServer.value) return '/raw <line>';
  return 'try /help';
});
const promptLabel = computed(() => {
  if (!active.value) return '[—]';
  const state = networks.states[active.value.networkId];
  const nick = state?.nick;
  if (!nick) return '[—]';
  const modes = state?.userModes || '';
  return modes ? `[${nick}(${modes})]` : `[${nick}]`;
});

const awayLabel = computed(() => {
  if (!active.value) return '';
  const msg = networks.states[active.value.networkId]?.away?.message;
  return msg ? `(${msg})` : '';
});

const tsFormat = computed(() => settings.effective('look.bar.time_format') || 'HH:mm');
const now = ref(new Date());
let clockTimer = null;
onMounted(() => { clockTimer = setInterval(() => { now.value = new Date(); }, 1000); });
onBeforeUnmount(() => { if (clockTimer) clearInterval(clockTimer); });
const clock = computed(() => formatTimestamp(now.value.toISOString(), tsFormat.value));

let typingState = null;
let lastActiveSentAt = 0;
let inactivityTimer = null;
let typingTarget = null;

function sendTyping(networkId, target, state) {
  socketSend({ type: 'typing', networkId, target, state });
}

function clearInactivityTimer() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}

function endTypingTo(target) {
  if (!target) return;
  if (typingState && typingTarget && typingTarget.target === target.target && typingTarget.networkId === target.networkId) {
    sendTyping(target.networkId, target.target, 'done');
  }
  typingState = null;
  typingTarget = null;
  clearInactivityTimer();
}

// Tab completion session — null when no Tab cycle is active. Reset on any
// non-Tab keydown, blur, submit, or buffer change.
let completion = null;
let cycling = false;  // true while we're programmatically rewriting `text`

function tokenAtCursor(value, cursor) {
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  let end = cursor;
  while (end < value.length && !/\s/.test(value[end])) end++;
  return { token: value.slice(start, end), start, end };
}

function buildNickMatches(buf, networkId, prefix) {
  const lower = prefix.toLowerCase();
  const seen = new Set();
  const out = [];
  // Speakers first (reverse-chronological).
  const speakers = Object.values(buf.speakers || {})
    .sort((a, b) => b.lastTime - a.lastTime);
  for (const s of speakers) {
    if (!s.nick.toLowerCase().startsWith(lower)) continue;
    if (seen.has(s.nick.toLowerCase())) continue;
    seen.add(s.nick.toLowerCase());
    out.push(s.nick);
  }
  // Channel members not already represented (alphabetical).
  const memberNames = (buf.members || [])
    .map((m) => (typeof m === 'string' ? m : m.nick))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  for (const n of memberNames) {
    const lc = n.toLowerCase();
    if (seen.has(lc)) continue;
    if (!lc.startsWith(lower)) continue;
    seen.add(lc);
    out.push(n);
  }
  // Own nick last (only if it matches the prefix).
  const own = networks.states[networkId]?.nick;
  if (own && own.toLowerCase().startsWith(lower) && !seen.has(own.toLowerCase())) {
    out.push(own);
  }
  return out;
}

function buildChannelMatches(networkId, prefix) {
  const lower = prefix.toLowerCase();
  return buffers.forNetwork(networkId)
    .map((b) => b.target)
    .filter((t) => t.startsWith('#') && t.toLowerCase().startsWith(lower))
    .sort((a, b) => a.localeCompare(b));
}

function applyCompletion() {
  if (!completion || !completion.matches.length) return;
  const pick = completion.matches[completion.index];
  const suffix = (completion.atLineStart && !completion.isChannel) ? ': ' : '';
  cycling = true;
  text.value = completion.prefix + pick + suffix + completion.tail;
  cycling = false;
  // Move caret to just after the inserted nick + suffix.
  const caret = completion.prefix.length + pick.length + suffix.length;
  // Set on the next tick so v-model has propagated.
  Promise.resolve().then(() => {
    const el = inputEl.value;
    if (!el) return;
    el.setSelectionRange(caret, caret);
    completion.caret = caret;
  });
}

function resetCompletion() {
  completion = null;
}

function onKeydown(e) {
  if (e.key !== 'Tab') {
    if (completion) resetCompletion();
    return;
  }
  if (!sendable.value) return;
  e.preventDefault();
  const el = inputEl.value;
  if (!el) return;

  if (completion) {
    const dir = e.shiftKey ? -1 : 1;
    const n = completion.matches.length;
    if (n === 0) return;
    completion.index = (completion.index + dir + n) % n;
    applyCompletion();
    return;
  }

  const value = text.value;
  const cursor = el.selectionStart ?? value.length;
  const { token, start, end } = tokenAtCursor(value, cursor);
  if (!token) return;

  const buf = buffer.value;
  if (!buf) return;
  const networkId = active.value.networkId;

  const isChannel = token.startsWith('#');
  const stripped = isChannel ? token.slice(1) : token;
  const matches = isChannel
    ? buildChannelMatches(networkId, token)
    : buildNickMatches(buf, networkId, stripped);
  if (!matches.length) return;

  const prefix = value.slice(0, start);
  const tail = value.slice(end);
  const atLineStart = /^\s*$/.test(prefix);

  completion = { prefix, tail, token, isChannel, atLineStart, matches, index: 0, caret: 0 };
  applyCompletion();
}

function closePicker() {
  pickerOpen.value = false;
  pickerQuery.value = '';
  pickerTokenStart = -1;
  pickerTokenEnd = -1;
}

function refreshPicker() {
  const el = inputEl.value;
  if (!el) { closePicker(); return; }
  const value = text.value;
  const cursor = el.selectionStart ?? value.length;
  const { token, start, end } = tokenAtCursor(value, cursor);
  if (!token.startsWith('@')) {
    if (pickerOpen.value) closePicker();
    return;
  }
  pickerOpen.value = true;
  pickerQuery.value = token.slice(1);
  pickerTokenStart = start;
  pickerTokenEnd = end;
}

function onPickerSelect(nick) {
  const value = text.value;
  if (pickerTokenStart < 0) { closePicker(); return; }
  const before = value.slice(0, pickerTokenStart);
  const after = value.slice(pickerTokenEnd);
  cycling = true;
  text.value = before + nick + ' ' + after;
  cycling = false;
  closePicker();
  Promise.resolve().then(() => {
    const el = inputEl.value;
    if (!el) return;
    const caret = before.length + nick.length + 1;
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}

function onInput() {
  if (!sendable.value) return;
  if (cycling) return;
  if (completion) resetCompletion();
  refreshPicker();
  const { networkId, target } = active.value;
  const trimmed = text.value.trim();

  if (trimmed === '' || text.value.startsWith('/')) {
    if (typingState) {
      sendTyping(networkId, target, 'done');
      typingState = null;
      typingTarget = null;
    }
    clearInactivityTimer();
    return;
  }

  const now = Date.now();
  if (typingState !== 'active' || now - lastActiveSentAt > 3000) {
    sendTyping(networkId, target, 'active');
    typingState = 'active';
    typingTarget = { networkId, target };
    lastActiveSentAt = now;
  }

  clearInactivityTimer();
  const tNet = networkId;
  const tTarget = target;
  inactivityTimer = setTimeout(() => {
    if (typingState === 'active' && text.value.trim() !== '') {
      sendTyping(tNet, tTarget, 'paused');
      typingState = 'paused';
    }
    inactivityTimer = null;
  }, 3000);
}

watch(text, onInput);

watch(active, (newActive, oldActive) => {
  resetCompletion();
  closePicker();
  if (oldActive && (!newActive || oldActive.target !== newActive.target || oldActive.networkId !== newActive.networkId)) {
    endTypingTo(oldActive);
  }
});

onBeforeUnmount(() => {
  if (active.value) endTypingTo(active.value);
});

defineExpose({
  focus: () => inputEl.value?.focus(),
});

function submit() {
  resetCompletion();
  closePicker();
  const raw = text.value;
  if (!raw.trim() || !active.value) return;
  const { networkId, target } = active.value;

  if (raw.startsWith('/')) {
    handleCommand(raw, networkId, target);
  } else if (sendable.value) {
    socketSend({ type: 'send', networkId, target, text: raw });
    typingState = null;
    typingTarget = null;
    clearInactivityTimer();
  } else {
    return;
  }
  text.value = '';
}

function handleCommand(line, networkId, target) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const argLine = line.slice(1 + cmd.length).trim();
  switch (cmd.toLowerCase()) {
    case 'me':
      socketSend({ type: 'action', networkId, target, text: argLine });
      break;
    case 'msg':
    case 'query': {
      const [who, ...msgParts] = rest;
      if (!who) return;
      const body = msgParts.join(' ');
      if (body) socketSend({ type: 'send', networkId, target: who, text: body });
      buffers.activate(networkId, who);
      break;
    }
    case 'join':
      if (rest[0]) {
        const ch = rest[0].startsWith('#') ? rest[0] : `#${rest[0]}`;
        socketSend({ type: 'join', networkId, channel: ch });
      }
      break;
    case 'part':
    case 'leave': {
      // /part leaves the channel but KEEPS the buffer so the user can scroll
      // history and rejoin later. The buffer just renders dimmed in the
      // sidebar. Use /close to actually drop a buffer.
      const channel = rest[0] || target;
      const reason = rest.slice(1).join(' ');
      socketSend({ type: 'part', networkId, channel, reason });
      break;
    }
    case 'close':
      // Close the current buffer. For channels this also PARTs; for DMs it
      // just hides the buffer. Server pseudo-buffers can't be closed.
      socketSend({ type: 'close-buffer', networkId, target });
      break;
    case 'raw':
    case 'quote':
      socketSend({ type: 'raw', networkId, line: argLine });
      break;
    case 'away':
      // Empty arg → clear away. Server treats it the same as /back.
      socketSend({ type: 'away', message: argLine });
      break;
    case 'back':
      socketSend({ type: 'back' });
      break;
    case 'help':
      alert('Commands: /me, /msg <nick> <text>, /join #chan, /part [#chan] [reason], /close, /away [message], /back, /raw <line>');
      break;
    default:
      socketSend({ type: 'raw', networkId, line: line.slice(1) });
  }
}
</script>

<style scoped>
.input {
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
}
.clock { color: var(--fg-muted); }
.prompt {
  color: var(--accent);
  white-space: pre;
  user-select: none;
}
.prompt .away { color: var(--warn); }
input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  padding: 0;
  color: var(--fg);
}
input:focus { outline: none; }
input::placeholder { color: var(--fg-muted); font-style: italic; }
.typing { flex: 0 0 auto; }
</style>
