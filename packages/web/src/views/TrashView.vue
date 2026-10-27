<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NDataTable, NEmpty, NInput, NSelect, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui';
import { ArrowLeft, RefreshCw, RotateCcw, Trash2 } from 'lucide-vue-next';
import type { TrashEntry } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import { formatSize, problemTitle } from '../lib/format';
import { onWs } from '../lib/ws';
import AppHeader from '../components/AppHeader.vue';
import ToolWindow from '../components/ToolWindow.vue';

const { t, locale } = useI18n(), router = useRouter(), dialog = useDialog(), message = useMessage();
const entries = ref<TrashEntry[]>([]), roots = ref<string[]>([]), filter = ref('');
const loading = ref(false), busy = ref(false), error = ref('');
const restoreEntry = ref<TrashEntry | null>(null), restoreRoot = ref('');
const shown = computed(() => entries.value.filter(e => `${e.name} ${Object.values(e.title).join(' ')}`.toLowerCase().includes(filter.value.trim().toLowerCase())));
async function load() {
  loading.value = true;
  try { const result = await api.trash(); entries.value = result.entries; roots.value = result.roots; error.value = ''; }
  catch (e) { error.value = errorMessage(e); }
  finally { loading.value = false; }
}
onMounted(load);
const off = onWs(event => { if (event.type === 'trash:changed') void load(); });
onUnmounted(off);
function openRestore(entry: TrashEntry) {
  restoreEntry.value = entry;
  restoreRoot.value = roots.value.find(root => root.toLowerCase() === entry.originalRoot?.toLowerCase()) ?? roots.value[0] ?? '';
}
async function restore() {
  if (!restoreEntry.value || busy.value) return;
  busy.value = true;
  try {
    await api.restoreTrash(restoreEntry.value.key, restoreEntry.value.kind === 'problem' ? restoreRoot.value : undefined);
    restoreEntry.value = null; message.success(t('trash.restored')); await load();
  } catch (e) { message.error(errorMessage(e)); }
  finally { busy.value = false; }
}
function remove(list: TrashEntry[]) {
  const keys = list.map(entry => entry.key);
  dialog.warning({ title: t('trash.deleteForever'), content: t('trash.confirmDelete', { n: keys.length }), positiveText: t('trash.deleteForever'), negativeText: t('common.cancel'), onPositiveClick: async () => {
    busy.value = true;
    try { await api.emptyTrash(keys); message.success(t('trash.deleted')); await load(); }
    catch (e) { message.error(errorMessage(e)); await load(); }
    finally { busy.value = false; }
  } });
}
const columns = computed<DataTableColumns<TrashEntry>>(() => [
  { title: t('trash.kind'), key: 'kind', width: 90, render: entry => h(NTag, { size: 'small', bordered: false }, () => t(`trash.${entry.kind}`)) },
  { title: t('trash.name'), key: 'name', minWidth: 180, render: entry => h('div', [h('strong', problemTitle(entry.title, locale.value) || entry.name), h('div', { class: 'pf-hint' }, entry.name), entry.error ? h('div', { class: 'error' }, entry.error) : null]) },
  { title: t('trash.location'), key: 'originalDir', minWidth: 220, ellipsis: { tooltip: true }, render: entry => entry.originalDir ?? t('trash.legacyLocation') },
  { title: t('trash.deletedAt'), key: 'deletedAt', width: 170, render: entry => entry.deletedAt ? new Date(entry.deletedAt).toLocaleString() : '—' },
  { title: t('trash.size'), key: 'size', width: 100, render: entry => formatSize(entry.size) },
  { title: '', key: 'actions', width: 230, render: entry => h('div', { class: 'actions' }, [
    h(NButton, { size: 'small', disabled: busy.value || !!entry.error, onClick: () => openRestore(entry) }, { icon: () => h(RotateCcw, { size: 14 }), default: () => t('trash.restore') }),
    h(NButton, { size: 'small', type: 'error', secondary: true, disabled: busy.value, onClick: () => remove([entry]) }, { icon: () => h(Trash2, { size: 14 }), default: () => t('trash.deleteForever') }),
  ]) },
]);
</script>
<template>
  <div class="page">
    <app-header>
      <template #left><n-button size="small" quaternary @click="router.push({ name: 'problems' })"><template #icon><ArrowLeft /></template>{{ t('nav.problems') }}</n-button><strong>{{ t('trash.title') }}</strong></template>
      <n-input v-model:value="filter" size="small" clearable :placeholder="t('trash.search')" style="max-width: 300px" />
      <template #right><n-button size="small" :loading="loading" :disabled="busy" @click="load"><template #icon><RefreshCw :size="14" /></template>{{ t('common.refresh') }}</n-button><n-button size="small" type="error" secondary :disabled="busy || !entries.length" @click="remove([...entries])">{{ t('trash.empty') }}</n-button></template>
    </app-header>
    <main>
      <n-alert type="info" :show-icon="false" class="intro">{{ t('trash.hint') }}</n-alert>
      <n-alert v-if="error" type="error">{{ error }}</n-alert>
      <n-data-table v-if="entries.length || loading" :columns="columns" :data="shown" :loading="loading" :row-key="entry => entry.key" :scroll-x="1000" :bordered="false" />
      <n-empty v-else :description="t('trash.none')" class="empty" />
    </main>
    <tool-window :show="!!restoreEntry" :title="t('trash.restore')" size="md" @update:show="value => !value && !busy && (restoreEntry = null)">
      <p>{{ restoreEntry?.name }}</p>
      <template v-if="restoreEntry?.kind === 'problem'"><p>{{ t('create.root') }}</p><n-select v-model:value="restoreRoot" :options="roots.map(value => ({ value, label: value }))" :disabled="busy" /><n-alert v-if="!roots.length" type="warning" :show-icon="false">{{ t('list.noRootsHint') }}</n-alert></template>
      <p class="pf-hint">{{ t('trash.restoreHint') }}</p>
      <template #footer><n-button :disabled="busy" @click="restoreEntry = null">{{ t('common.cancel') }}</n-button><n-button type="primary" :loading="busy" :disabled="restoreEntry?.kind === 'problem' && !restoreRoot" @click="restore">{{ t('trash.restore') }}</n-button></template>
    </tool-window>
  </div>
</template>
<style scoped>
.page { height: 100%; display: flex; flex-direction: column; }
main { flex: 1; min-height: 0; overflow: auto; padding: 24px; }
.intro { margin-bottom: 16px; }
.empty { margin-top: 80px; }
:deep(.actions) { display: flex; gap: 8px; }
:deep(.error) { color: var(--pf-danger, #d03050); font-size: 12px; }
</style>
