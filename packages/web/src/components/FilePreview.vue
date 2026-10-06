<script setup lang="ts">
import { ref, watch, onBeforeUnmount, computed } from 'vue';
import type { Tab } from '../lib/workspace';
import { renderLatex, buildMacros } from '../lib/latex';
import { renderMarkdown } from '../lib/markdown';
import { getDefs } from '../lib/defs';
import { rawUrl } from '../lib/api';
import 'katex/dist/katex.min.css';
const props = defineProps<{ tab: Tab; problemId: string }>();
const source = ref('');
const macros = ref(buildMacros(null, 'en'));
let sub: { dispose(): void } | undefined;
watch(() => props.tab, async tab => {
  sub?.dispose();
  source.value = tab.model.getValue();
  sub = tab.model.onDidChangeContent(() => source.value = tab.model.getValue());
  macros.value = buildMacros(await getDefs(), tab.path.match(/^statement\/([^/]+)/)?.[1] ?? 'en');
}, { immediate: true });
onBeforeUnmount(() => sub?.dispose());
const html = computed(() => /\.md$/i.test(props.tab.path) ? renderMarkdown(source.value) : renderLatex(source.value, {
  macros: macros.value, imageUrl: name => rawUrl(props.problemId, `${props.tab.path.split('/').slice(0, -1).join('/')}/${name}`.replace(/^\//, '')),
}).html);
</script>
<template><article class="file-preview" v-html="html" /></template>
<style scoped>
.file-preview { padding: 24px; line-height: 1.7; overflow-wrap: anywhere; }
.file-preview :deep(pre) { overflow: auto; padding: 12px; background: #8882; }
.file-preview :deep(img) { max-width: 100%; }
.file-preview :deep(.md-gap) { height: 12px; }
.file-preview :deep(.md-h) { font-weight: 600; margin: 12px 0; font-size: 1.2em; }
</style>
