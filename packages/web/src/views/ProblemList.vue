<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { NButton, NButtonGroup, NCard, NEmpty, NInput, NProgress, NSelect, NSpin, NTag, NResult, useMessage } from 'naive-ui';
import type { ProblemSummary } from '@polyforge/shared';
import AppHeader from '../components/AppHeader.vue';
import CreateProblemDialog from '../components/CreateProblemDialog.vue';
import ImportDialog from '../components/ImportDialog.vue';
import { api, errorMessage } from '../lib/api';
import { onWs } from '../lib/ws';
import { problemTitle } from '../lib/format';

const { t, locale } = useI18n();
const router = useRouter();
const message = useMessage();

const problems = ref<ProblemSummary[]>([]);
const roots = ref<string[]>([]);
const loading = ref(true);
const filter = ref('');
const showCreate = ref(false);
const showImport = ref(false);

async function load() {
  try {
    const r = await api.problems();
    problems.value = r.problems;
    roots.value = r.roots;
  } catch (e) {
    message.error(errorMessage(e));
  } finally {
    loading.value = false;
  }
}

// Any change may affect the status badges; coalesce bursts into one reload.
let timer: ReturnType<typeof setTimeout> | undefined;
const off = onWs(() => {
  clearTimeout(timer);
  timer = setTimeout(load, 300);
});
onMounted(load);
onUnmounted(() => {
  off();
  clearTimeout(timer);
});

const view = ref<'grid' | 'list'>((localStorage.getItem('polyforge-list-view') as 'grid' | 'list') || 'grid');
const sort = ref<'name' | 'progress'>((localStorage.getItem('polyforge-list-sort') as 'name' | 'progress') || 'name');
watch(view, (v) => localStorage.setItem('polyforge-list-view', v));
watch(sort, (v) => localStorage.setItem('polyforge-list-sort', v));

const progress = (p: ProblemSummary) => {
  const items = checklist(p);
  return Math.round((items.filter((c) => c.ok).length / items.length) * 100);
};

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const list = q ? problems.value.filter((p) => p.name.includes(q) || Object.values(p.title).some((x) => x.toLowerCase().includes(q))) : [...problems.value];
  return list.sort((a, b) => (sort.value === 'progress' ? progress(a) - progress(b) : 0) || a.name.localeCompare(b.name));
});

function checklist(p: ProblemSummary) {
  const s = p.status;
  return [
    { key: 'statement', ok: s.statement },
    { key: 'tutorial', ok: s.statementLangs.length > 0 && s.statementLangs.every((x) => s.tutorialLangs.includes(x)) && s.tutorialLangs.every((x) => s.statementLangs.includes(x)) },
    { key: 'validator', ok: s.validator },
    { key: 'checker', ok: s.checker },
    { key: 'std', ok: s.std },
    { key: 'tests', ok: s.manualTests > 0 || s.hasScript },
    { key: 'synced', ok: s.polygonId !== undefined },
  ];
}

function open(p: ProblemSummary) {
  router.push({ name: 'problem', params: { id: p.id } });
}
</script>

<template>
  <div class="page">
    <app-header>
      <template #left><strong class="brand">⚒ PolyForge</strong></template>
      <n-input v-model:value="filter" size="small" clearable :placeholder="t('list.search')" style="max-width: 280px" />
      <n-select
        v-model:value="sort"
        size="small"
        style="width: 150px"
        :options="[
          { label: t('list.sortName'), value: 'name' },
          { label: t('list.sortProgress'), value: 'progress' },
        ]"
      />
      <n-button-group size="small">
        <n-button :type="view === 'grid' ? 'primary' : 'default'" @click="view = 'grid'">▦</n-button>
        <n-button :type="view === 'list' ? 'primary' : 'default'" @click="view = 'list'">☰</n-button>
      </n-button-group>
      <template #right>
        <n-button size="small" type="primary" :disabled="roots.length === 0" @click="showCreate = true">{{ t('list.new') }}</n-button>
        <n-button size="small" :disabled="roots.length === 0" @click="showImport = true">{{ t('list.import') }}</n-button>
        <n-button size="small" @click="router.push({ name: 'settings' })">{{ t('nav.settings') }}</n-button>
      </template>
    </app-header>

    <main class="body">
      <div v-if="loading" class="center"><n-spin /></div>
      <n-result v-else-if="roots.length === 0" status="info" :title="t('list.noRoots')" :description="t('list.noRootsHint')">
        <template #footer>
          <n-button type="primary" @click="router.push({ name: 'settings' })">{{ t('list.goSettings') }}</n-button>
        </template>
      </n-result>
      <n-empty v-else-if="problems.length === 0" :description="t('list.empty')" style="margin-top: 80px">
        <template #extra>
          <n-button type="primary" @click="showCreate = true">{{ t('list.new') }}</n-button>
        </template>
      </n-empty>
      <div v-else-if="view === 'list'" class="rows">
        <div v-for="p in shown" :key="p.id" class="row" @click="open(p)">
          <span class="row-title">{{ problemTitle(p.title, locale) || p.name }}</span>
          <span class="mono sub">{{ p.id }}</span>
          <n-progress type="line" :percentage="progress(p)" :height="6" :show-indicator="false" style="width: 120px" :status="progress(p) === 100 ? 'success' : 'default'" />
          <span class="checks">
            <n-tag v-for="c in checklist(p)" :key="c.key" size="tiny" :type="c.ok ? 'success' : 'default'" :bordered="false">{{ t(`check.${c.key}`) }}</n-tag>
          </span>
          <span class="limits">{{ p.timeLimit / 1000 }}s / {{ p.memoryLimit }}MB</span>
        </div>
      </div>
      <div v-else class="grid">
        <n-card v-for="p in shown" :key="p.id" size="small" hoverable class="card" @click="open(p)">
          <template #header>
            <div class="title">{{ problemTitle(p.title, locale) || p.name }}</div>
            <div class="sub mono">{{ p.id }}</div>
          </template>
          <template #header-extra>
            <span class="limits">{{ p.timeLimit / 1000 }}s / {{ p.memoryLimit }}MB</span>
          </template>
          <div v-if="p.error" class="error">{{ p.error }}</div>
          <div v-if="p.status.tutorialLangs.length && p.status.tutorialLangs.join() !== p.status.statementLangs.join()" class="warn">
            {{ t('list.langMismatch', { s: p.status.statementLangs.join('/') || '—', t: p.status.tutorialLangs.join('/') }) }}
          </div>
          <n-progress
            type="line"
            :percentage="progress(p)"
            :height="4"
            :show-indicator="false"
            :status="progress(p) === 100 ? 'success' : 'default'"
            style="margin-bottom: 8px"
          />
          <div class="checks">
            <n-tag v-for="c in checklist(p)" :key="c.key" size="small" :type="c.ok ? 'success' : 'default'" :bordered="false">
              {{ c.ok ? '✓' : '·' }} {{ t(`check.${c.key}`) }}
            </n-tag>
            <n-tag v-if="p.interactive" size="small" type="info" :bordered="false">{{ t('problem.interactive') }}</n-tag>
          </div>
          <div v-if="roots.length > 1" class="root mono" :title="p.dir">{{ p.root }}</div>
        </n-card>
      </div>
    </main>

    <create-problem-dialog v-model:show="showCreate" :roots="roots" @created="open" />
    <import-dialog v-model:show="showImport" :roots="roots" @imported="open" />
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.brand {
  font-size: 15px;
}
.body {
  flex: 1;
  overflow: auto;
  padding: 16px;
}
.center {
  display: flex;
  justify-content: center;
  padding: 80px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.card {
  cursor: pointer;
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.row:hover {
  background: rgba(128, 128, 128, 0.1);
}
.row-title {
  font-weight: 600;
  min-width: 160px;
}
.row .checks {
  flex: 1;
}
.title {
  font-weight: 600;
}
.sub,
.root {
  font-size: 12px;
  opacity: 0.6;
}
.root {
  margin-top: 6px;
}
.limits {
  font-size: 12px;
  opacity: 0.7;
}
.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.warn {
  color: #e8b060;
  font-size: 12px;
  margin-bottom: 6px;
}
.error {
  color: #e88080;
  font-size: 12px;
  margin-bottom: 6px;
  word-break: break-all;
}
</style>
