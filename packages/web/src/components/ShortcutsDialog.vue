<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { NModal } from 'naive-ui';

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
  <n-modal :show="show" preset="card" :title="t('shortcuts.title')" style="width: 420px" @update:show="emit('update:show', $event)">
    <div v-for="[k, id] in KEYS" :key="k" class="row">
      <span>{{ t(`shortcuts.${id}`) }}</span>
      <kbd>{{ k }}</kbd>
    </div>
  </n-modal>
</template>

<style scoped>
.row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 13px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.15);
}
kbd {
  font-family: Consolas, monospace;
  font-size: 12px;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid rgba(128, 128, 128, 0.4);
}
</style>
