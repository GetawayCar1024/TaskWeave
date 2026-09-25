<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { NButton, NCard, NEmpty, NInput, NSpin, NTag, NResult, useMessage } from 'naive-ui';
import type { ProblemSummary } from '@polyforge/shared';
import AppHeader from '../components/AppHeader.vue';
import CreateProblemDialog from '../components/CreateProblemDialog.vue';
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

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return problems.value;
  return problems.value.filter((p) => p.name.includes(q) || Object.values(p.title).some((x) => x.toLowerCase().includes(q)));
});

function checklist(p: ProblemSummary) {
  const s = p.status;
  return [
    { key: 'statement', ok: s.statement },
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
      <template #right>
        <n-button size="small" type="primary" :disabled="roots.length === 0" @click="showCreate = true">{{ t('list.new') }}</n-button>
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
.error {
  color: #e88080;
  font-size: 12px;
  margin-bottom: 6px;
  word-break: break-all;
}
</style>
