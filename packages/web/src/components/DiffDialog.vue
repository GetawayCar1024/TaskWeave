<script setup lang="ts">
import { ignoreWhitespace } from '../lib/diffOptions';
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NModal, NSpace, NSpin } from 'naive-ui';
import { monaco, languageForPath } from '../lib/monaco';
import { settings } from '../lib/settings';

/** Conflict view: disk version (left) vs. unsaved buffer (right). */
const props = defineProps<{ show: boolean; path: string; disk: string | null; mine: string }>();
const emit = defineEmits<{ 'update:show': [boolean]; keepMine: []; useDisk: [] }>();
const { t } = useI18n();

const host = ref<HTMLDivElement>();
let diff: monaco.editor.IStandaloneDiffEditor | null = null;
let models: monaco.editor.ITextModel[] = [];

function cleanup() {
  diff?.dispose();
  diff = null;
  models.forEach((m) => m.dispose());
  models = [];
}

watch(
  () => [props.show, props.disk] as const,
  async ([show, disk]) => {
    cleanup();
    if (!show || disk === null) return;
    await nextTick();
    if (!host.value) return;
    const lang = languageForPath(props.path);
    models = [monaco.editor.createModel(disk, lang), monaco.editor.createModel(props.mine, lang)];
    diff = monaco.editor.createDiffEditor(host.value, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      ignoreTrimWhitespace: ignoreWhitespace.value,
      renderWhitespace: 'all',
      theme: settings.config?.ui.theme === 'light' ? 'vs' : 'vs-dark',
    });
    diff.setModel({ original: models[0], modified: models[1] });
  },
);

onBeforeUnmount(cleanup);
watch(ignoreWhitespace, value => diff?.updateOptions({ ignoreTrimWhitespace: value }));
</script>

<template>
  <n-modal :show="show" preset="card" :title="`${t('diff.title')} — ${path}`" style="width: 90vw" @update:show="emit('update:show', $event)">
    <label class="diff-options"><input type="checkbox" v-model="ignoreWhitespace" />{{ t('improve.ignoreWhitespace') }}</label>
    <div class="labels">
      <span>{{ t('diff.disk') }}</span>
      <span>{{ t('diff.mine') }}</span>
    </div>
    <div v-if="disk === null" class="loading"><n-spin /></div>
    <div v-else ref="host" class="host" />
    <template #footer>
      <n-space justify="end">
        <n-button @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
        <n-button @click="emit('useDisk')">{{ t('diff.useDisk') }}</n-button>
        <n-button type="warning" @click="emit('keepMine')">{{ t('diff.keepMine') }}</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.labels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  font-size: 12px;
  opacity: 0.7;
  margin-bottom: 4px;
}
.host {
  height: 65vh;
}
.loading {
  height: 65vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
