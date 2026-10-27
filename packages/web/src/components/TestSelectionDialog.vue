<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NDataTable, NInput, type DataTableColumns } from 'naive-ui';
import { compressRanges, originalTestName, parseIndexList, type TestInfo } from '@polyforge/shared';
import ToolWindow from './ToolWindow.vue';

const props = defineProps<{ show: boolean; name: string; value: string; tests: TestInfo[]; groups: { name: string; tests: string }[] }>();
const emit = defineEmits<{ 'update:show': [boolean]; select: [string] }>();
const { t } = useI18n();
const search = ref(''), selected = ref<number[]>([]);
watch(() => props.show, show => { if (show) { search.value = ''; selected.value = [...new Set(parseIndexList(props.value))]; } });
const memberships = computed(() => {
  const result = new Map<number, string[]>();
  for (const group of props.groups) for (const index of new Set(parseIndexList(group.tests))) {
    const names = result.get(index) ?? []; names.push(group.name); result.set(index, names);
  }
  return result;
});
const filtered = computed(() => {
  const words = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return props.tests.filter(test => words.every(word => `${test.index} ${originalTestName(test)} ${test.originalOutput ?? ''}`.toLocaleLowerCase().includes(word)));
});
const columns = computed<DataTableColumns<TestInfo>>(() => [
  { type: 'selection' }, { title: '#', key: 'index', width: 62 },
  { title: t('testsets.inputName'), key: 'source', ellipsis: { tooltip: true }, render: originalTestName },
  { title: t('testsets.outputName'), key: 'originalOutput', ellipsis: { tooltip: true }, render: row => row.originalOutput?.replace(/\\/g, '/').split('/').pop() ?? '—' },
  { title: t('testsets.memberships'), key: 'groups', width: 160, ellipsis: { tooltip: true }, render: row => (memberships.value.get(row.index) ?? []).join(', ') || '—' },
]);
function choose(mode: 'all' | 'invert' | 'none') {
  const next = new Set(selected.value);
  for (const test of filtered.value) {
    if (mode === 'none' || mode === 'invert' && next.has(test.index)) next.delete(test.index); else next.add(test.index);
  }
  selected.value = [...next];
}
function apply() { emit('select', compressRanges(selected.value)); emit('update:show', false); }
</script>

<template>
  <tool-window :show="show" :title="t('testsets.selectFor', { name })" size="lg" @update:show="emit('update:show', $event)">
    <div class="selection-toolbar">
      <n-input v-model:value="search" clearable :placeholder="t('testsets.searchFiles')" :aria-label="t('testsets.searchFiles')" />
      <n-button size="small" @click="choose('all')">{{ t('testsets.selectVisible') }}</n-button>
      <n-button size="small" @click="choose('invert')">{{ t('testsets.invertVisible') }}</n-button>
      <n-button size="small" @click="choose('none')">{{ t('testsets.clearVisible') }}</n-button>
    </div>
    <n-data-table :data="filtered" :columns="columns" :row-key="(row: TestInfo) => row.index" :checked-row-keys="selected"
      @update:checked-row-keys="keys => selected = keys.map(Number)" :max-height="420" virtual-scroll size="small" :bordered="false" />
    <template #footer-left>{{ t('testsets.selectedCount', { n: selected.length, total: tests.length }) }}</template>
    <template #footer>
      <n-button @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
      <n-button type="primary" @click="apply">{{ t('common.confirm') }}</n-button>
    </template>
  </tool-window>
</template>

<style scoped>
.selection-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.selection-toolbar .n-input { flex: 1; min-width: 120px; }
@media (max-width: 680px) { .selection-toolbar { flex-wrap: wrap; } .selection-toolbar .n-input { flex-basis: 100%; } }
</style>
