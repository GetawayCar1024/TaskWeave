<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NProgress, NTooltip, NSelect, useMessage } from 'naive-ui';
import { errorMessage } from '../lib/api';
import { isSourceFile } from '@polyforge/shared';
import type { Ai } from '../lib/ai';
import type { Judge } from '../lib/judge';
import { wsConnected } from '../lib/ws';
import { Check, X } from 'lucide-vue-next';
import type { Workspace } from '../lib/workspace';

/** Bottom status bar: connection, Polygon binding, tests, running jobs, AI, cursor. */
const props = defineProps<{ ws: Workspace; judge: Judge; ai: Ai }>();
const emit = defineEmits<{ open: ['tests' | 'sync' | 'ai' | 'invocation'] }>();
const { t } = useI18n();
const message = useMessage();
async function setLanguage(lang: string) {
  if (!props.ws.state.active) return;
  try { await props.ws.patch({ language: { source: props.ws.state.active, lang } }); }
  catch (e) { message.error(errorMessage(e)); }
}

const summary = computed(() => props.ws.state.detail?.summary);
const manifest = computed(() => props.judge.state.manifest);
const jobs = computed(() => Object.values(props.judge.state.jobs).filter((j) => j?.status === 'running'));

// Cursor position of the active editor.
const cursor = ref<{ line: number; col: number } | null>(null);
let sub: { dispose(): void } | null = null;
watch(
  () => props.ws.editorRef.value,
  (ed) => {
    sub?.dispose();
    sub = ed?.onDidChangeCursorPosition((e) => (cursor.value = { line: e.position.lineNumber, col: e.position.column })) ?? null;
  },
  { immediate: true },
);
onBeforeUnmount(() => sub?.dispose());

const activeLang = computed(() => {
  const p = props.ws.state.active;
  return p ? props.ws.languageFor(p)?.name ?? p.split('.').pop()?.toUpperCase() : '';
});
</script>

<template>
  <footer class="status">
    <n-tooltip v-if="!wsConnected">
      <template #trigger>
        <span class="item"><span class="dot" :class="{ on: wsConnected }" /></span>
      </template>
      {{ wsConnected ? t('app.connected') : t('app.disconnected') }}
    </n-tooltip>
    <span class="item link" @click="emit('open', 'sync')">
      {{ summary?.status.polygonId !== undefined ? `Polygon #${summary.status.polygonId}` : t('status.unbound') }}
    </span>
    <span class="item link" @click="emit('open', 'tests')">
      <template v-if="manifest">
        {{ t('status.tests', { n: manifest.tests.length }) }}
        <check v-if="manifest.ok" :size="12" class="good" /><span v-else class="bad icon-text"><x :size="12" />{{ manifest.errors.length }}</span>
      </template>
      <template v-else>{{ t('status.noTests') }}</template>
    </span>
    <span v-for="j in jobs" :key="j.id" class="item job">
      {{ t(`status.job.${j.kind}`) }}
      <n-progress
        type="line"
        :percentage="j.progress.total ? Math.round((j.progress.done / j.progress.total) * 100) : 0"
        :show-indicator="false"
        :height="4"
        style="width: 80px"
      />
    </span>
    <span v-if="ai.running.value || ai.state.changes.length" class="item link" @click="emit('open', 'ai')">
      AI
      <template v-if="ai.running.value">· {{ t('ai.working') }}</template>
      <template v-if="ai.state.changes.length"> · {{ t('status.aiChanges', { n: ai.state.changes.length }) }}</template>
    </span>
    <span class="spacer" />
    <n-select v-if="ws.state.active && isSourceFile(ws.state.active)" size="tiny" style="width: 150px" :value="ws.languageFor(ws.state.active)?.id" :options="Object.entries(ws.state.languages).map(([value, l]) => ({value, label:l.name}))" @update:value="setLanguage" />
    <span v-else-if="activeLang" class="item">{{ activeLang }}</span>
    <span v-if="cursor && ws.state.active" class="item link" @click="ws.editorRef.value?.trigger('status', 'editor.action.gotoLine', null)">{{ t('status.cursor', cursor) }}</span>
    <span class="item">LF</span>
  </footer>
</template>

<style scoped>
.status {
  height: 24px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  font-size: 12px;
  border-top: 1px solid rgba(128, 128, 128, 0.25);
  background: rgba(128, 128, 128, 0.06);
  user-select: none;
}
.item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  height: 100%;
  opacity: 0.85;
}
.link {
  cursor: pointer;
}
.link:hover {
  background: rgba(128, 128, 128, 0.15);
}
.spacer {
  flex: 1;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d03050;
}
.dot.on {
  background: #18a058;
}
.good {
  color: #63e2b7;
}
.icon-text {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.bad {
  color: #e88080;
}
</style>
