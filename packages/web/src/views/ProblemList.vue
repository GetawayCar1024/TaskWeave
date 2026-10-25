<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NButtonGroup, NCard, NEmpty, NInput, NProgress, NSelect, NRadioButton, NRadioGroup, NSpin, NTag, NResult, useMessage } from 'naive-ui';
import type { ContestSummary, ProblemSummary } from '@polyforge/shared';
import AppHeader from '../components/AppHeader.vue';
import ContestDialog from '../components/ContestDialog.vue';
import CreateProblemDialog from '../components/CreateProblemDialog.vue';
import ImportDialog from '../components/ImportDialog.vue';
import { api, errorMessage } from '../lib/api';
import { onWs } from '../lib/ws';
import { problemTitle } from '../lib/format';
import { checklist, progress } from '../lib/progress';
import { Anvil, Check, Circle as CircleIcon, LayoutGrid, List, Trash2 } from 'lucide-vue-next';
import { useDialog } from 'naive-ui';
import { confirmDeleteContest, confirmDeleteProblem } from '../lib/deleteProblem';

const { t, locale } = useI18n();
const router = useRouter();
const route = useRoute();
const message = useMessage();

const problems = ref<ProblemSummary[]>([]);
const contests = ref<ContestSummary[]>([]);
const roots = ref<string[]>([]);
const loading = ref(true);
const filter = ref('');
const showCreate = ref(false);
const showImport = ref(false);
const contestDialog = ref<'create' | 'import' | null>(null);

const tab = ref<'problems' | 'contests'>(route.query.tab === 'contests' ? 'contests' : 'problems');
watch(tab, (v) => router.replace({ query: v === 'contests' ? { tab: v } : {} }));

async function load() {
  try {
    const [r, c] = await Promise.all([api.problems(), api.contests()]);
    problems.value = r.problems;
    contests.value = c;
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

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const list = q ? problems.value.filter((p) => p.name.includes(q) || Object.values(p.title).some((x) => x.toLowerCase().includes(q))) : [...problems.value];
  return list.sort((a, b) => (sort.value === 'progress' ? progress(a) - progress(b) : 0) || a.name.localeCompare(b.name));
});

function open(p: ProblemSummary) {
  router.push({ name: 'problem', params: { id: p.id } });
}

const byId = computed(() => new Map(problems.value.map((p) => [p.id, p])));
const shownContests = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return q ? contests.value.filter((c) => c.name.includes(q) || Object.values(c.title).some((x) => x.toLowerCase().includes(q))) : contests.value;
});
/** Average completion over the contest's problems (missing ones count as 0). */
function contestProgress(c: ContestSummary) {
  if (!c.problems.length) return 0;
  const sum = c.problems.reduce((acc, p) => acc + (byId.value.get(p.problem) ? progress(byId.value.get(p.problem)!) : 0), 0);
  return Math.round(sum / c.problems.length);
}
/** problem id -> the contests it is in, e.g. "round-1 · A". */
const contestsOf = computed(() => {
  const m = new Map<string, { id: string; label: string; contest: ContestSummary }[]>();
  for (const c of contests.value) {
    for (const p of c.problems) {
      if (!m.has(p.problem)) m.set(p.problem, []);
      m.get(p.problem)!.push({ id: c.id, label: `${problemTitle(c.title, locale.value) || c.name} · ${p.index}`, contest: c });
    }
  }
  return m;
});
const dialog = useDialog();
function deleteContest(c: ContestSummary) {
  confirmDeleteContest(dialog, message, c.id, problemTitle(c.title, locale.value) || c.name).then((ok) => {
    if (ok) load();
  });
}
function deleteProblem(p: ProblemSummary) {
  const inContests = (contestsOf.value.get(p.id) ?? []).map((c) => c.label);
  confirmDeleteProblem(dialog, message, p.id, inContests).then((ok) => {
    if (ok) load();
  });
}

function openContest(c: ContestSummary) {
  router.push({ name: 'contest', params: { id: c.id } });
}
</script>

<template>
  <div class="page">
    <app-header>
      <template #left><strong class="brand"><anvil :size="18" /> PolyForge</strong></template>
      <n-radio-group v-model:value="tab" size="small">
        <n-radio-button value="problems">{{ t('list.problems') }} {{ problems.length || '' }}</n-radio-button>
        <n-radio-button value="contests">{{ t('list.contests') }} {{ contests.length || '' }}</n-radio-button>
      </n-radio-group>
      <n-input v-model:value="filter" size="small" clearable :placeholder="t(tab === 'contests' ? 'list.searchContests' : 'list.search')" style="max-width: 280px" />
      <n-select
        v-if="tab === 'problems'"
        v-model:value="sort"
        size="small"
        style="width: 150px"
        :options="[
          { label: t('list.sortName'), value: 'name' },
          { label: t('list.sortProgress'), value: 'progress' },
        ]"
      />
      <n-button-group v-if="tab === 'problems'" size="small">
        <n-button :type="view === 'grid' ? 'primary' : 'default'" @click="view = 'grid'"><layout-grid :size="14" /></n-button>
        <n-button :type="view === 'list' ? 'primary' : 'default'" @click="view = 'list'"><list :size="14" /></n-button>
      </n-button-group>
      <template #right>
        <template v-if="tab === 'problems'">
          <n-button size="small" type="primary" :disabled="roots.length === 0" @click="showCreate = true">{{ t('list.new') }}</n-button>
          <n-button size="small" :disabled="roots.length === 0" @click="showImport = true">{{ t('list.import') }}</n-button>
        </template>
        <template v-else>
          <n-button size="small" type="primary" :disabled="roots.length === 0" @click="contestDialog = 'create'">{{ t('contest.new') }}</n-button>
          <n-button size="small" @click="contestDialog = 'import'">{{ t('list.import') }}</n-button>
        </template>
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
      <template v-else-if="tab === 'contests'">
        <n-empty v-if="contests.length === 0" :description="t('contest.none')" style="margin-top: 80px">
          <template #extra>
            <n-button type="primary" @click="contestDialog = 'create'">{{ t('contest.new') }}</n-button>
          </template>
        </n-empty>
        <div v-else class="grid">
          <n-card v-for="c in shownContests" :key="c.id" size="small" hoverable class="card" @click="openContest(c)">
            <template #header>
              <div class="title">{{ problemTitle(c.title, locale) || c.name }}</div>
              <div class="sub mono">{{ c.id }}</div>
            </template>
            <template #header-extra>
              <n-tag v-if="c.polygonId" size="small" :bordered="false">#{{ c.polygonId }}</n-tag>
              <n-button size="tiny" quaternary class="card-del" :title="t('contest.delete')" @click.stop="deleteContest(c)"><trash2 :size="13" /></n-button>
            </template>
            <div v-if="c.error" class="error">{{ c.error }}</div>
            <n-progress
              type="line"
              :percentage="contestProgress(c)"
              :height="4"
              :show-indicator="false"
              :status="contestProgress(c) === 100 ? 'success' : 'default'"
              style="margin-bottom: 8px"
            />
            <div class="checks">
              <n-tag
                v-for="p in c.problems"
                :key="p.index"
                size="small"
                :type="!p.found ? 'error' : byId.get(p.problem) && progress(byId.get(p.problem)!) === 100 ? 'success' : 'default'"
                :bordered="false"
                :title="p.problem"
              >
                {{ p.index }}<span class="tag-sub">{{ byId.get(p.problem) ? problemTitle(byId.get(p.problem)!.title, locale) || p.problem : p.problem }}</span>
              </n-tag>
            </div>
          </n-card>
        </div>
      </template>
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
            <n-tag v-for="c in checklist(p)" :key="c.key" size="tiny" :type="c.ok ? 'success' : 'default'" :bordered="false">{{ t(`check.${c.label ?? c.key}`) }}</n-tag>
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
            <n-button size="tiny" quaternary class="card-del" :title="t('problem.delete')" @click.stop="deleteProblem(p)"><trash2 :size="13" /></n-button>
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
              <span class="check-tag"><span class="ci"><check v-if="c.ok" :size="11" /><circle-icon v-else :size="7" /></span><span>{{ t(`check.${c.label ?? c.key}`) }}</span></span>
            </n-tag>
            <n-tag v-if="p.interactive" size="small" type="info" :bordered="false">{{ t('problem.interactive') }}</n-tag>
          </div>
          <div v-if="contestsOf.get(p.id)" class="in-contest">
            <a v-for="c in contestsOf.get(p.id)" :key="c.id" class="link" @click.stop="openContest(c.contest)">{{ c.label }}</a>
          </div>
          <div v-if="roots.length > 1" class="root mono" :title="p.dir">{{ p.root }}</div>
        </n-card>
      </div>
    </main>

    <create-problem-dialog v-model:show="showCreate" :roots="roots" @created="open" />
    <import-dialog v-model:show="showImport" :roots="roots" @imported="open" />
    <contest-dialog
      :show="contestDialog !== null"
      :mode="contestDialog ?? 'create'"
      :roots="roots"
      :problems="problems"
      @update:show="(v: boolean) => !v && (contestDialog = null)"
      @created="openContest"
    />
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.card-del {
  margin-left: 4px;
  opacity: 0;
}
.card:hover .card-del {
  opacity: 0.7;
}
/* Same icon box for done / not done so the text of all tags lines up. */
.ci {
  width: 12px;
  height: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.check-tag {
  line-height: 1;
  /* Middle, not baseline: the first child (the icon box) would set the baseline. */
  vertical-align: middle;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.body {
  flex: 1;
  overflow: auto;
  padding: 24px;
}
.center {
  display: flex;
  justify-content: center;
  padding: 80px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}
.card {
  cursor: pointer;
  box-shadow: var(--pf-shadow);
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.card:hover { border-color: var(--pf-accent); box-shadow: 0 4px 20px #007aff12; }
.card:focus-within .card-del { opacity: 1; }
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
.in-contest {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  margin-top: 6px;
  font-size: 12px;
  opacity: 0.75;
}
.link:hover {
  text-decoration: underline;
}
.tag-sub {
  margin-left: 6px;
  opacity: 0.7;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.warn {
  color: light-dark(#986415, #e8b060);
  font-size: 12px;
  margin-bottom: 6px;
}
.error {
  color: light-dark(#c53b3b, #e88080);
  font-size: 12px;
  margin-bottom: 6px;
  word-break: break-all;
}
</style>
