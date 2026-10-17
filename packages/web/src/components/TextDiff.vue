<script setup lang="ts">
import { ignoreWhitespace } from '../lib/diffOptions';
import { useI18n } from 'vue-i18n';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { monaco } from '../lib/monaco';
import { settings } from '../lib/settings';

/** Read-only side-by-side diff of two texts. */
const props = defineProps<{ original: string; modified: string; language?: string }>();
const { t } = useI18n();
const host = ref<HTMLDivElement>();
let editor: monaco.editor.IStandaloneDiffEditor | null = null;
let models: monaco.editor.ITextModel[] = [];

function render() {
  models.forEach((m) => m.dispose());
  models = [monaco.editor.createModel(props.original, props.language ?? 'plaintext'), monaco.editor.createModel(props.modified, props.language ?? 'plaintext')];
  editor?.setModel({ original: models[0], modified: models[1] });
}

onMounted(() => {
  editor = monaco.editor.createDiffEditor(host.value!, {
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    ignoreTrimWhitespace: ignoreWhitespace.value,
    renderWhitespace: 'all',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    theme: settings.config?.ui.theme === 'light' ? 'vs' : 'vs-dark',
  });
  render();
});
watch(() => [props.original, props.modified], render);
onBeforeUnmount(() => {
  editor?.dispose();
  models.forEach((m) => m.dispose());
});
watch(ignoreWhitespace, value => editor?.updateOptions({ ignoreTrimWhitespace: value }));
</script>

<template>
  <label class="diff-options"><input type="checkbox" v-model="ignoreWhitespace" />{{ t('improve.ignoreWhitespace') }}</label>
  <div ref="host" class="diff" />
</template>

<style scoped>
.diff {
  width: 100%;
  height: 100%;
  min-height: 200px;
}
</style>
