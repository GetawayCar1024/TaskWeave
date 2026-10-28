<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { lintMessage } from '../lib/serverText';
import { useI18n } from 'vue-i18n';
import { NButton, NEmpty, NScrollbar, NSpin, NTag, useMessage } from 'naive-ui';
import ToolWindow from './ToolWindow.vue';
import { lintStatement, type LintResult } from '@taskweave/shared';
import { api, errorMessage } from '../lib/api';
import type { Workspace } from '../lib/workspace';
import TextDiff from './TextDiff.vue';

/** Lint + auto-fix for all statement and tutorial files (DESIGN §4.6). */
const props = defineProps<{ show: boolean; ws: Workspace; problemId: string }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const { t } = useI18n();
const message = useMessage();

interface FileLint {
  path: string;
  lang: string;
  original: string;
  result: LintResult;
}
const files = ref<FileLint[]>([]);
const loading = ref(false);
const active = ref<string | null>(null);

async function run() {
  loading.value = true;
  try {
    const paths = props.ws.files.value.map((f) => f.path).filter((p) => /^statement\/[^/]+\/[^/]+\.tex$/.test(p) && !p.startsWith('statement/images/'));
    const out: FileLint[] = [];
    for (const p of paths) {
      // Unsaved editor content is what the user sees, so lint that.
      const tab = props.ws.state.tabs.find((x) => x.path === p);
      const text = tab ? tab.model.getValue() : (await api.readFile(props.problemId, p)).content;
      const lang = p.split('/')[1];
      out.push({ path: p, lang, original: text, result: lintStatement(text, { lang, allowMarkdown: true }) });
    }
    files.value = out.filter((f) => f.result.issues.length);
    active.value = files.value[0]?.path ?? null;
  } catch (e) {
    message.error(errorMessage(e));
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.show,
  (s) => s && run(),
);

const current = computed(() => files.value.find((f) => f.path === active.value) ?? null);
const fixable = (f: FileLint) => f.result.issues.filter((i) => i.fixable).length;

async function apply(list: FileLint[]) {
  try {
    for (const f of list) {
      if (!f.result.changed) continue;
      const tab = props.ws.state.tabs.find((x) => x.path === f.path);
      if (tab) {
        // Keep undo history in the editor; save only if there was nothing unsaved.
        const wasDirty = tab.dirty;
        tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: f.result.fixed }], () => null);
        if (!wasDirty) await props.ws.save(f.path);
      } else {
        const cur = await api.readFile(props.problemId, f.path);
        await api.writeFile(props.problemId, f.path, f.result.fixed, cur.hash);
      }
    }
    message.success(t('lint.applied', { n: list.filter((f) => f.result.changed).length }));
    await run();
  } catch (e) {
    message.error(errorMessage(e));
  }
}
</script>

<template>
  <tool-window :show="show" :title="t('lint.title')" size="xl" @update:show="emit('update:show', $event)">
    <div v-if="loading" class="pf-center"><n-spin /></div>
    <n-empty v-else-if="!files.length" :description="t('lint.clean')" style="padding: 40px" />
    <div v-else class="body">
      <n-scrollbar class="list">
        <div v-for="f in files" :key="f.path" class="pf-row file" :class="{ active: active === f.path }" @click="active = f.path">
          <div class="mono">{{ f.path.replace('statement/', '') }}</div>
          <div class="pf-hint">{{ t('lint.count', { n: f.result.issues.length, fix: fixable(f) }) }}</div>
        </div>
      </n-scrollbar>
      <div v-if="current" class="detail">
        <n-scrollbar class="issues">
          <div v-for="(i, k) in current.result.issues" :key="k" class="issue">
            <span class="mono pf-hint">{{ i.line }}:{{ i.col }}</span>
            <n-tag size="tiny" :type="i.fixable ? 'info' : 'warning'" :bordered="false">{{ i.fixable ? t('lint.auto') : t('lint.manual') }}</n-tag>
            <span>{{ lintMessage(i) }}</span>
          </div>
        </n-scrollbar>
        <div class="diff">
          <text-diff v-if="current.result.changed" :original="current.original" :modified="current.result.fixed" language="latex" />
          <div v-else class="pf-center pf-hint">{{ t('lint.nothingToFix') }}</div>
        </div>
      </div>
    </div>
    <template #actions>
      <n-button size="small" :disabled="loading" @click="run">{{ t('lint.recheck') }}</n-button>
    </template>
    <template #footer>
      <n-button :disabled="!current?.result.changed" @click="current && apply([current])">{{ t('lint.applyOne') }}</n-button>
      <n-button type="primary" :disabled="!files.some((f) => f.result.changed)" @click="apply(files)">{{ t('lint.applyAll') }}</n-button>
    </template>
  </tool-window>
</template>

<style scoped>
.body {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 10px;
  height: 68vh;
}
.list {
  border-right: 1px solid var(--pf-border);
  padding-right: 6px;
}
.file {
  display: block;
}
.detail {
  display: grid;
  grid-template-rows: minmax(80px, 30%) 1fr;
  gap: 8px;
  min-height: 0;
}
.issue {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  padding: 2px 0;
}
.diff {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--pf-border);
  border-radius: 4px;
}
</style>
