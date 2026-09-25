<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NModal, NButton, NInput, NInputGroup, NList, NListItem, NSpace, NScrollbar, useMessage } from 'naive-ui';
import { api, errorMessage } from '../lib/api';
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
  <n-modal :show="show" preset="card" :title="t('dirPicker.title')" style="width: 600px" @update:show="emit('update:show', $event)">
    <n-input-group>
      <n-button :disabled="parent === null" @click="go(parent ?? '')"><arrow-up :size="15" /></n-button>
      <n-input v-model:value="typed" class="mono" @keyup.enter="go(typed)" />
      <n-button @click="go(typed)">{{ t('dirPicker.go') }}</n-button>
    </n-input-group>
    <n-scrollbar style="max-height: 360px; margin-top: 8px">
      <n-list hoverable clickable size="small">
        <n-list-item v-for="d in dirs" :key="d" @click="go(d)"><span class="dir"><folder :size="14" /> {{ baseName(d) }}</span></n-list-item>
        <n-list-item v-if="dirs.length === 0"><span style="opacity: 0.6">{{ t('dirPicker.empty') }}</span></n-list-item>
      </n-list>
    </n-scrollbar>
    <template #footer>
      <n-space justify="space-between" align="center">
        <span style="font-size: 12px; opacity: 0.7">{{ t('dirPicker.hint') }}</span>
        <n-space>
          <n-button @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :disabled="!typed.trim()" @click="pick">{{ t('dirPicker.choose') }}</n-button>
        </n-space>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.dir {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>
