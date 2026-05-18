<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<template>
  <section id="data" class="settings-pane">
    <h2>data</h2>
    <p class="section-desc">
      Move your account between Lurker instances. The export contains your
      settings, networks, and channels; message history is optional. The
      import side restores into a fresh account on another instance.
    </p>

    <h3 class="subhead">export</h3>
    <p v-if="exportError" class="error inline">{{ exportError }}</p>
    <p v-if="!preview" class="muted small">Loading data summary…</p>
    <div v-else>
      <ul class="counts">
        <li>{{ preview.settingsOnly.networks || 0 }} network(s)</li>
        <li>{{ totalSmallRows }} small rows (settings, highlights, ignores, drafts, etc.)</li>
        <li v-if="preview.withMessages.messages > 0">
          {{ preview.withMessages.messages.toLocaleString() }} message(s) available with history
        </li>
      </ul>
      <label class="opt">
        <input type="checkbox" v-model="includeMessages" />
        Include message history ({{ preview.withMessages.messages.toLocaleString() }})
      </label>
      <div class="actions">
        <button class="link" @click="onDownload">download export</button>
      </div>
    </div>

    <hr class="hl-sep" />

    <h3 class="subhead">import</h3>
    <p class="section-desc">
      Imports replace nothing — the target account must be empty. Sign in to
      the new instance as a fresh user, then drop the .zip file here.
    </p>
    <p v-if="importError" class="error inline">{{ importError }}</p>
    <p v-if="importNotice" class="muted small">{{ importNotice }}</p>

    <div v-if="!chosenFile" class="picker">
      <input ref="fileInputEl" type="file" accept=".lurk,.zip" @change="onFileChosen" />
    </div>
    <div v-else class="chosen">
      <div class="chosen-row">
        <span class="filename">{{ chosenFile.name }}</span>
        <span class="muted small">({{ formatBytes(chosenFile.size) }})</span>
      </div>
      <div class="actions">
        <button
          class="link"
          :disabled="importing || !confirmed"
          @click="onImport"
        >{{ importing ? `importing… ${progress}%` : 'import' }}</button>
        <button
          v-if="!importing"
          class="link danger"
          @click="onCancelFile"
        >cancel</button>
      </div>
      <label v-if="!importing && !importNotice" class="opt">
        <input type="checkbox" v-model="confirmed" />
        I understand this will populate my empty account with the imported data.
      </label>
    </div>
  </section>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, apiMultipart } from '../../api.js';
import { resetSession } from '../../composables/useSessionReset.js';

const router = useRouter();

const preview = ref(null);
const exportError = ref('');
const includeMessages = ref(false);

const fileInputEl = ref(null);
const chosenFile = ref(null);
const importError = ref('');
const importNotice = ref('');
const importing = ref(false);
const progress = ref(0);
const confirmed = ref(false);

// `users` is always 1 (the row representing the caller); excluding it so a
// brand-new account with no real activity reads as 0 small rows instead of 1.
const SMALL_ROW_EXCLUDE = new Set(['networks', 'messages', 'user_bookmarks', 'users']);
const totalSmallRows = computed(() => {
  if (!preview.value) return 0;
  const s = preview.value.settingsOnly;
  return Object.entries(s)
    .filter(([t]) => !SMALL_ROW_EXCLUDE.has(t))
    .reduce((acc, [, n]) => acc + (n || 0), 0);
});

onMounted(async () => {
  try {
    preview.value = await api('/api/exports/preview');
  } catch (e) {
    exportError.value = e.message || 'failed to load export preview';
  }
});

function onDownload() {
  const qs = includeMessages.value ? '?include_messages=1' : '';
  // Plain navigation; the browser handles the Content-Disposition.
  window.location.href = `/api/exports${qs}`;
}

function onFileChosen(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  chosenFile.value = f;
  importError.value = '';
  importNotice.value = '';
  confirmed.value = false;
}

function onCancelFile() {
  chosenFile.value = null;
  importError.value = '';
  importNotice.value = '';
  confirmed.value = false;
  if (fileInputEl.value) fileInputEl.value.value = '';
}

async function onImport() {
  if (!chosenFile.value || importing.value) return;
  importing.value = true;
  importError.value = '';
  importNotice.value = '';
  progress.value = 0;
  try {
    const fd = new FormData();
    fd.append('archive', chosenFile.value, chosenFile.value.name);
    const result = await apiMultipart('/api/imports', fd, {
      onProgress: (p) => { progress.value = p; },
    });
    const counts = result.counts || {};
    const summary = [
      `${counts.networks || 0} network(s)`,
      `${(counts.messages || 0).toLocaleString()} message(s)`,
    ].join(', ');
    importNotice.value = `Imported ${summary}. Reloading…`;
    // Wipe stores so the post-reset bootstrap rehydrates from the server.
    resetSession();
    setTimeout(() => { router.replace('/'); window.location.reload(); }, 800);
  } catch (e) {
    importError.value = e.message || 'import failed';
  } finally {
    importing.value = false;
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
</script>

<style src="./panes.css"></style>
<style scoped>
.counts {
  list-style: disc;
  padding-left: 24px;
  margin: 4px 0 10px;
  color: var(--fg-muted);
}
.counts li { padding: 2px 0; }

.opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
}

.actions {
  display: flex;
  gap: 1ch;
  align-items: center;
  padding-top: 6px;
}

.picker { padding-top: 6px; }
.chosen-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
}
.chosen-row .filename { color: var(--fg); }
</style>
