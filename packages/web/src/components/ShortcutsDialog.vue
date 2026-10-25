<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import ToolWindow from './ToolWindow.vue';

defineProps<{ show: boolean }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const { t } = useI18n();

const KEYS: [string, string][] = [
  ['Ctrl+K', 'palette'],
  ['Ctrl+P', 'quickOpen'],
  ['Ctrl+S', 'save'],
  ['Ctrl+Enter', 'run'],
  ['Ctrl+Shift+G', 'generate'],
  ['Ctrl+Shift+U', 'sync'],
  ['Ctrl+Shift+L', 'lint'],
  ['Ctrl+/', 'help'],
];
</script>

<template>
  <tool-window :show="show" :title="t('shortcuts.title')" size="sm" @update:show="emit('update:show', $event)">
    <div v-for="[k, id] in KEYS" :key="k" class="row">
      <span>{{ t(`shortcuts.${id}`) }}</span>
      <kbd class="pf-kbd">{{ k }}</kbd>
    </div>
  </tool-window>
</template>

<style scoped>
.row {
  display: flex;
  justify-content: space-between;
  padding: 5px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--pf-border);
}
.row:last-child {
  border-bottom: none;
}
</style>
