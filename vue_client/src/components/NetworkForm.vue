<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<template>
  <div class="modal" @click.self="$emit('close')">
    <form class="card" @submit.prevent="submit">
      <h2>{{ isEdit ? 'Edit network' : 'Add network' }}</h2>
      <label>
        <span>Name</span>
        <input v-model="form.name" placeholder="Libera" required />
      </label>
      <div class="row">
        <label class="grow">
          <span>Host</span>
          <input v-model="form.host" placeholder="irc.libera.chat" required />
        </label>
        <label class="port">
          <span>Port</span>
          <input v-model.number="form.port" type="number" min="1" max="65535" />
        </label>
        <label class="tls">
          <span>TLS</span>
          <input v-model="form.tls" type="checkbox" />
        </label>
      </div>
      <label>
        <span>Nick</span>
        <input v-model="form.nick" required />
      </label>
      <label>
        <span>Real name (optional)</span>
        <input v-model="form.realname" />
      </label>
      <label>
        <span>Server password (optional)</span>
        <input
          v-model="form.server_password"
          type="password"
          autocomplete="off"
          :placeholder="isEdit && props.network?.has_password ? '(saved — type to replace)' : ''"
        />
      </label>
      <div class="row">
        <label class="grow">
          <span>SASL account (optional)</span>
          <input v-model="form.sasl_account" :placeholder="form.nick || 'defaults to nick'" autocomplete="off" />
        </label>
        <label class="grow">
          <span>SASL password (optional)</span>
          <input
            v-model="form.sasl_password"
            type="password"
            autocomplete="off"
            :placeholder="isEdit && props.network?.has_sasl_password ? '(saved — type to replace)' : ''"
          />
        </label>
      </div>
      <label v-if="!isEdit">
        <span>Default channel</span>
        <input v-model="form.default_channel" placeholder="#lurker" />
      </label>
      <label class="check">
        <input v-model="form.autoconnect" type="checkbox" />
        <span>Reconnect automatically</span>
      </label>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="actions">
        <button v-if="isEdit" type="button" class="danger" :disabled="loading" @click="remove">Delete</button>
        <button v-if="isEdit" type="button" class="ghost" :disabled="loading" @click="reconnect">Reconnect</button>
        <span class="spacer"></span>
        <button type="button" class="ghost" @click="$emit('close')">Cancel</button>
        <button type="submit" :disabled="loading">{{ loading ? 'Saving…' : (isEdit ? 'Save' : 'Save & connect') }}</button>
      </div>
    </form>
  </div>
</template>

<script setup>
import { reactive, ref, computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';

const props = defineProps({
  network: { type: Object, default: null },
});
const emit = defineEmits(['close']);
const networks = useNetworksStore();

const isEdit = computed(() => !!props.network);

const form = reactive({
  name: props.network?.name ?? '',
  host: props.network?.host ?? '',
  port: props.network?.port ?? 6697,
  tls: props.network ? !!props.network.tls : true,
  nick: props.network?.nick ?? '',
  realname: props.network?.realname ?? '',
  server_password: '',
  sasl_account: props.network?.sasl_account ?? '',
  sasl_password: '',
  default_channel: '#lurker',
  autoconnect: props.network ? !!props.network.autoconnect : true,
});

const loading = ref(false);
const error = ref(null);

// Editing host/port/tls/nick/credentials only takes effect on the next
// connection — a saved row otherwise sits untouched while the live IRC client
// keeps using the old config. Detect those changes and reconnect after PATCH
// so save-then-nothing-happens isn't the default UX.
function connectionChanged() {
  if (!props.network) return false;
  const orig = props.network;
  if ((form.host || '') !== (orig.host || '')) return true;
  if (Number(form.port) !== Number(orig.port)) return true;
  if (!!form.tls !== !!orig.tls) return true;
  if ((form.nick || '') !== (orig.nick || '')) return true;
  if ((form.realname || '') !== (orig.realname || '')) return true;
  if ((form.sasl_account || '') !== (orig.sasl_account || '')) return true;
  // Passwords are write-only on the API, so any non-empty value is a new value.
  if (form.server_password) return true;
  if (form.sasl_password) return true;
  return false;
}

async function submit() {
  loading.value = true;
  error.value = null;
  try {
    if (isEdit.value) {
      const patch = {
        name: form.name,
        host: form.host,
        port: form.port,
        tls: form.tls,
        nick: form.nick,
        realname: form.realname,
        sasl_account: form.sasl_account,
        autoconnect: form.autoconnect,
      };
      if (form.server_password) patch.server_password = form.server_password;
      if (form.sasl_password) patch.sasl_password = form.sasl_password;
      const willReconnect = connectionChanged();
      await networks.update(props.network.id, patch);
      if (willReconnect) await networks.reconnect(props.network.id);
    } else {
      await networks.create({ ...form });
    }
    emit('close');
  } catch (err) {
    error.value = err.message || 'failed to save network';
  } finally {
    loading.value = false;
  }
}

async function reconnect() {
  loading.value = true;
  error.value = null;
  try {
    await networks.reconnect(props.network.id);
    emit('close');
  } catch (err) {
    error.value = err.message || 'failed to reconnect';
    loading.value = false;
  }
}

async function remove() {
  if (!confirm(`Delete network "${props.network.name}"? This disconnects and removes its history.`)) return;
  loading.value = true;
  error.value = null;
  try {
    await networks.remove(props.network.id);
    emit('close');
  } catch (err) {
    error.value = err.message || 'failed to delete network';
    loading.value = false;
  }
}
</script>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.card {
  background: var(--bg);
  border: 1px solid var(--accent);
  padding: 16px 20px;
  width: 400px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
h2 {
  margin: 0 0 4px;
  color: var(--accent);
  text-transform: lowercase;
  font-weight: 600;
}
label { display: flex; flex-direction: column; gap: 3px; color: var(--fg-muted); }
label span { text-transform: uppercase; letter-spacing: 0.04em; }
/* width:100% + border-box keeps inputs sized to their label rather than their
   intrinsic (size=20) width, so flex columns can't be pushed wider than the
   card. */
label input { color: var(--fg); width: 100%; box-sizing: border-box; }
.row { display: flex; gap: 8px; align-items: end; }
/* min-width:0 lets a flex item shrink below its content's intrinsic width —
   without it two side-by-side inputs (the SASL row) overflow the card. */
.grow { flex: 1; min-width: 0; }
.port { width: 80px; }
.tls { width: 48px; align-items: center; }
.tls input { width: auto; transform: scale(1.1); }
.check { flex-direction: row; align-items: center; gap: 8px; }
.check input { width: auto; }
.check span { text-transform: none; letter-spacing: normal; color: var(--fg); font-size: inherit; }
.actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.spacer { flex: 1; }
.ghost { border-color: var(--border); }
.danger { color: var(--bad); border-color: var(--bad); }
.danger:hover:not(:disabled) { background: var(--bad); color: var(--bg); border-color: var(--bad); }
.error { color: var(--bad); margin: 0; }
</style>
