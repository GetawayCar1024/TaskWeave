<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { monaco } from '../lib/monaco';
import { settings } from '../lib/settings';
import { EDITOR_BASE_OPTIONS, editorOptions } from '../lib/editorOptions';

/**
 * A single-document Monaco editor bound with v-model (used outside the workspace).
 * Same font, theme and editor settings as the problem editor; `path` decides wrapping.
 */
const props = defineProps<{ modelValue: string; language: string; readOnly?: boolean; path?: string }>();
const emit = defineEmits<{ 'update:modelValue': [string]; save: []; scroll: [] }>();

const el = ref<HTMLDivElement>();
let editor: monaco.editor.IStandaloneCodeEditor | null = null;

onMounted(() => {
  editor = monaco.editor.create(el.value!, {
    value: props.modelValue,
    language: props.language,
    readOnly: props.readOnly,
    ...EDITOR_BASE_OPTIONS,
    ...editorOptions(props.path ?? ''),
  });
  editor.onDidChangeModelContent(() => emit('update:modelValue', editor!.getValue()));
  editor.onDidScrollChange(() => emit('scroll'));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit('save'));
});
watch(() => [settings.config, props.path], () => editor?.updateOptions(editorOptions(props.path ?? '')), { deep: true });
defineExpose({ editor: () => editor });

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
