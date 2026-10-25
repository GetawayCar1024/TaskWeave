<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NInput, NInputGroup, NScrollbar, useMessage } from 'naive-ui';
import { api, errorMessage } from '../lib/api';
import ToolWindow from './ToolWindow.vue';
import { ArrowUp, Folder } from 'lucide-vue-next';

/** Server-side directory browser: the browser itself cannot reveal absolute paths. */
const props = defineProps<{ show: boolean; initial?: string }>();
const emit = defineEmits<{ 'update:show': [boolean]; pick: [string] }>();
const { t } = useI18n();
const message = useMessage();

const current = ref('');
const parent = ref<string | null>(null);
const dirs = ref<string[]>([]);
const typed = ref('');

async function go(p: string) {
  try {
    const r = await api.listDirs(p);
    current.value = r.path;
    parent.value = r.parent;
    dirs.value = r.dirs;
    typed.value = r.path;
  } catch (e) {
    message.error(errorMessage(e));
  }
}

watch(
  () => props.show,
  (s) => s && go(props.initial ?? ''),
);

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

function pick() {
  const p = typed.value.trim();
  if (!p) return;
  emit('pick', p);
  emit('update:show', false);
}
</script>

<template>
  <tool-window :show="show" :title="t('dirPicker.title')" size="md" @update:show="emit('update:show', $event)">
    <n-input-group>
      <n-button :disabled="parent === null" @click="go(parent ?? '')"><arrow-up :size="15" /></n-button>
      <n-input v-model:value="typed" class="mono" @keyup.enter="go(typed)" />
      <n-button @click="go(typed)">{{ t('dirPicker.go') }}</n-button>
    </n-input-group>
    <n-scrollbar class="dirs">
      <div v-for="d in dirs" :key="d" class="pf-row" @click="go(d)"><folder :size="14" /> {{ baseName(d) }}</div>
      <div v-if="dirs.length === 0" class="pf-empty">{{ t('dirPicker.empty') }}</div>
    </n-scrollbar>
    <template #footer-left>{{ t('dirPicker.hint') }}</template>
    <template #footer>
      <n-button @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
      <n-button type="primary" :disabled="!typed.trim()" @click="pick">{{ t('dirPicker.choose') }}</n-button>
    </template>
  </tool-window>
</template>

<style scoped>
.dirs {
  max-height: 360px;
  margin-top: 8px;
}
</style>
