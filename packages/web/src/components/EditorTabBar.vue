<script setup lang="ts">
import { Lock, X } from 'lucide-vue-next';
import type { EditorTabItem } from '../lib/editorOptions';

/** Editor tab strip shared by the problem workspace and the contest files editor. */
defineProps<{ tabs: EditorTabItem[]; active: string | null }>();
const emit = defineEmits<{ select: [path: string]; close: [path: string] }>();

function onAuxClick(e: MouseEvent, path: string) {
  if (e.button !== 1) return;
  e.preventDefault();
  emit('close', path);
}
</script>

<template>
  <div class="tabs">
    <div
      v-for="tab in tabs"
      :key="tab.path"
      class="tab"
      :class="{ active: tab.path === active }"
      :title="tab.path"
      @click="emit('select', tab.path)"
      @mousedown.middle.prevent
      @auxclick="onAuxClick($event, tab.path)"
    >
      <span class="name" :class="{ gone: tab.gone }">{{ tab.label }}</span>
      <span v-if="tab.hint" class="hint">{{ tab.hint }}</span>
      <lock v-if="tab.readOnly" :size="11" class="ro" />
      <span class="close" :class="{ dirty: tab.dirty }" @click.stop="emit('close', tab.path)">
        <span class="dot" /><x class="x" :size="12" />
      </span>
    </div>
    <div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  overflow-x: auto;
  flex-shrink: 0;
  border-bottom: 1px solid var(--pf-border);
  background: var(--pf-toolbar-bg);
  padding: 5px 6px 0;
  gap: 3px;
  scrollbar-width: thin;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 12px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  border-radius: 7px 7px 0 0;
  opacity: 0.7;
  user-select: none;
}
.tab.active {
  opacity: 1;
  background: var(--pf-selected);
  box-shadow: inset 0 -2px 0 var(--pf-accent);
}
.tab:hover { background: var(--pf-selected); opacity: 1; }
.name.gone {
  text-decoration: line-through;
}
.hint {
  margin-left: 4px;
  font-size: 11px;
  opacity: 0.55;
}
.ro {
  opacity: 0.6;
}
.close {
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
}
.close:hover {
  background: rgba(128, 128, 128, 0.3);
}
.close .dot {
  display: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.close.dirty .dot {
  display: inline-block;
}
.close.dirty .x {
  display: none;
}
.close.dirty:hover .dot {
  display: none;
}
.close.dirty:hover .x {
  display: inline-block;
}
.actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 5px 12px;
  flex-shrink: 0;
}
</style>
