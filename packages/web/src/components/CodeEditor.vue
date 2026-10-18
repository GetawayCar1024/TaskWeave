<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { monaco } from '../lib/monaco';
import { settings } from '../lib/settings';

/** A single-document Monaco editor bound with v-model (used outside the workspace). */
const props = defineProps<{ modelValue: string; language: string; readOnly?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [string]; save: [] }>();

const el = ref<HTMLDivElement>();
let editor: monaco.editor.IStandaloneCodeEditor | null = null;

onMounted(() => {
  const ed = settings.config?.editor;
  editor = monaco.editor.create(el.value!, {
    value: props.modelValue,
    language: props.language,
    readOnly: props.readOnly,
    automaticLayout: true,
    theme: settings.config?.ui.theme === 'light' ? 'vs' : 'vs-dark',
    fontSize: ed?.font_size ?? 14,
    tabSize: ed?.tab_size ?? 4,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
  });
  editor.onDidChangeModelContent(() => emit('update:modelValue', editor!.getValue()));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit('save'));
});

watch(
  () => props.modelValue,
  (v) => {
    if (editor && v !== editor.getValue()) editor.setValue(v);
  },
);
watch(() => props.readOnly, value => editor?.updateOptions({ readOnly: !!value }));

onBeforeUnmount(() => editor?.dispose());
</script>

<template>
  <div ref="el" class="code-editor" />
</template>

<style scoped>
.code-editor {
  width: 100%;
  height: 100%;
  min-height: 200px;
}
</style>
