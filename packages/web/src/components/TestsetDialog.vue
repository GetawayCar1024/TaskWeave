<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NInput, NInputNumber, NSelect, NSwitch, NTag, useMessage } from 'naive-ui';
import { Plus, Trash2, X } from 'lucide-vue-next';
import { DEFAULT_TESTSET, GROUP_POLICIES, TESTSET_NAME_RE, parseIndexList, testsetsOf, type TestGroup, type TestsetPatch } from '@polyforge/shared';
import { errorMessage } from '../lib/api';
import type { Judge } from '../lib/judge';
import type { Workspace } from '../lib/workspace';
import ToolWindow from './ToolWindow.vue';

/** Testsets (Polygon) and their groups / subtasks with points. */
const props = defineProps<{ show: boolean; ws: Workspace; judge: Judge; initial?: string }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const { t } = useI18n();
const message = useMessage();

interface EditGroup {
  name: string;
  tests: string;
  points: number | null;
  policy: (typeof GROUP_POLICIES)[number];
  dependencies: string[];
  /** Validator for the tests of this group; '' = the problem validator. */
  validator: string;
}
interface EditTestset {
  answers: 'provided' | 'generated';
  name: string;
  isNew: boolean;
  script: string;
  manual: string;
  groups: boolean;
  group: EditGroup[];
}

const cfg = computed(() => props.ws.state.detail?.config ?? null);
const form = reactive({ points: false, sets: [] as EditTestset[], deleted: [] as string[] });
const current = ref(DEFAULT_TESTSET);
const newName = ref('');
const saving = ref(false);
const error = ref('');

function reset() {
  const c = cfg.value;
  error.value = '';
  if (!c) return;
  form.points = !!c.tests.points;
  form.deleted = [];
  form.sets = testsetsOf(c).map((ts) => ({
    name: ts.name,
    answers: ts.answers ?? (c.problem.data_only ? 'provided' : 'generated'),
    isNew: false,
    script: ts.script ?? '',
    manual: ts.manual,
    groups: ts.groups,
    group: ts.group.map((g) => ({ name: g.name, tests: g.tests ?? '', points: g.points ?? null, policy: g.policy ?? 'COMPLETE_GROUP', dependencies: [...(g.dependencies ?? [])], validator: g.validator ?? '' })),
  }));
  current.value = props.initial && form.sets.some((s) => s.name === props.initial) ? props.initial : DEFAULT_TESTSET;
}
watch(() => props.show, (s) => s && reset());

const set = computed(() => form.sets.find((s) => s.name === current.value) ?? form.sets[0]);
const scripts = computed(() => props.ws.files.value.filter((f) => f.path.endsWith('.txt') && f.path.startsWith('tests/')).map((f) => f.path));
const manifest = computed(() => props.judge.state.manifests[current.value] ?? (current.value === DEFAULT_TESTSET ? props.judge.state.manifest : null));
const testCount = computed(() => manifest.value?.tests.length ?? 0);
watch([() => props.show, current], ([s, ts]) => {
  if (s && ts !== DEFAULT_TESTSET && !(ts in props.judge.state.manifests) && form.sets.some((x) => x.name === ts && !x.isNew)) void props.judge.loadManifest(ts);
});

function addTestset() {
  const name = newName.value.trim();
  if (!TESTSET_NAME_RE.test(name)) return message.error(t('testsets.badName'));
  if (form.sets.some((s) => s.name === name)) return message.error(t('testsets.exists', { name }));
  form.sets.push({ name, isNew: true, answers: cfg.value?.problem.data_only ? 'provided' : 'generated', script: '', manual: `tests/${name}`, groups: false, group: [] });
  form.deleted = form.deleted.filter((d) => d !== name);
  current.value = name;
  newName.value = '';
}
function removeTestset(name: string) {
  form.sets = form.sets.filter((s) => s.name !== name);
  if (!form.sets.find((s) => s.name === name)) form.deleted.push(name);
  current.value = DEFAULT_TESTSET;
}

/** Next free range after the last group, so adding groups in order is quick. */
function addGroup() {
  const s = set.value;
  const used = s.group.flatMap((g) => parseIndexList(g.tests));
  const from = (used.length ? Math.max(...used) : 0) + 1;
  let name = String(s.group.length + 1);
  for (let n = 1; s.group.some(g => g.name === name); n++) name = String(n);
  s.group.push({ name, tests: from <= testCount.value ? `${from}-${testCount.value}` : '', points: null, policy: 'COMPLETE_GROUP', dependencies: [], validator: '' });
  s.groups = true;
}
/** Renaming a group keeps the dependencies on it; removing it drops them. */
function renameGroup(g: EditGroup, name: string) {
  for (const x of set.value.group) x.dependencies = x.dependencies.map((d) => (d === g.name ? name : d));
  g.name = name;
}
function removeGroup(i: number) {
  const [g] = set.value.group.splice(i, 1);
  for (const x of set.value.group) x.dependencies = x.dependencies.filter((d) => d !== g.name);
}
const validatorOptions = computed(() => [
  { label: t('testsets.problemValidator'), value: '' },
  ...props.ws.files.value.filter((f) => /\.(cpp|cc|cxx)$/i.test(f.path)).map((f) => ({ label: f.path, value: f.path })),
]);
/** Per-subtask points as each test sees them (Luogu / LemonLime need integers). */
const unevenGroups = computed(() => form.points ? set.value?.group.filter((g) => {
  const n = new Set(parseIndexList(g.tests)).size;
  return g.points !== null && n > 0 && (!Number.isInteger(g.points) || g.points % n !== 0);
}).map((g) => g.name) ?? [] : []);

// Coverage summary: tests outside groups / in two groups.
const coverage = computed(() => {
  const s = set.value;
  if (!s?.groups || !testCount.value) return null;
  const seen = new Map<number, number>();
  for (const g of s.group) for (const i of parseIndexList(g.tests)) seen.set(i, (seen.get(i) ?? 0) + 1);
  const all = manifest.value!.tests.map((x) => x.index);
  const known = new Set(all);
  return { loose: all.filter((i) => !seen.has(i)), twice: [...seen].filter(([, n]) => n > 1).map(([i]) => i), missing: [...seen.keys()].filter((i) => !known.has(i)).sort((a, b) => a - b) };
});
const pointsSum = computed(() => set.value?.group.reduce((a, g) => a + (g.points ?? 0), 0) ?? 0);

async function save() {
  saving.value = true;
  error.value = '';
  try {
    const testsets: Record<string, TestsetPatch | null> = {};
    for (const s of form.sets) {
      testsets[s.name] = {
        answers: cfg.value?.problem.data_only ? 'provided' : s.answers,
        // A cleared select sets null.
        script: s.answers === 'provided' ? null : (s.script ?? '').trim() || null,
        groups: s.groups,
        group: s.group.map(
          (g): TestGroup => ({
            name: g.name.trim(),
            tests: g.tests.trim() || undefined,
            points: g.points !== null ? g.points : undefined,
            policy: g.policy,
            dependencies: g.dependencies.length ? g.dependencies : undefined,
            validator: g.validator || undefined,
          }),
        ),
      };
    }
    for (const d of form.deleted) testsets[d] = null;
    await props.ws.patch({ points: form.points, testsets });
    message.success(t('common.saved'));
    emit('update:show', false);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}

const policyOptions = computed(() => GROUP_POLICIES.map((p) => ({ label: t(`testsets.policy.${p}`), value: p })));
</script>

<template>
  <tool-window :show="show" :title="t('testsets.title')" size="xl" :error="error" @update:show="emit('update:show', $event)">
    <div v-if="set" class="layout">
      <aside class="sets">
        <div
          v-for="s in form.sets"
          :key="s.name"
          class="pf-row"
          :class="{ active: s.name === current }"
          @click="current = s.name"
        >
          <span class="mono">{{ s.name }}</span>
          <n-tag v-if="s.groups" size="tiny" :bordered="false">{{ t('testsets.nGroups', { n: s.group.length }) }}</n-tag>
          <n-button v-if="s.name !== 'tests'" size="tiny" quaternary class="del" :title="t('testsets.delete')" @click.stop="removeTestset(s.name)">
            <trash2 :size="12" />
          </n-button>
        </div>
        <div class="add-set">
          <n-input v-model:value="newName" size="small" placeholder="pretests" class="mono" @keyup.enter="addTestset" />
          <n-button size="small" :disabled="!newName.trim()" @click="addTestset"><plus :size="14" /></n-button>
        </div>
        <div class="problem-wide">
          <label class="opt"><n-switch v-model:value="form.points" size="small" /> {{ t('testsets.points') }}</label>
        </div>
      </aside>

      <section class="detail">
        <n-alert v-if="cfg && testsetsOf(cfg).find(ts => ts.name === current)?.unresolvedScoring" type="warning" :show-icon="false">{{ t('packages.unresolvedScoring') }}</n-alert>
        <div class="row"><span class="label">{{ t('packages.answers') }}</span><n-select v-model:value="set.answers" size="small" :disabled="!!cfg?.problem.data_only" :options="[{ value: 'generated', label: t('packages.generatedAnswers') }, { value: 'provided', label: t('packages.providedAnswers') }]" /></div>
        <div class="row">
          <span class="label">{{ t('testsets.script') }}</span>
          <n-select
            v-model:value="set.script"
            :disabled="set.answers === 'provided'"
            size="small"
            filterable
            tag
            clearable
            :options="scripts.map((p) => ({ label: p, value: p }))"
            :placeholder="set.name === 'tests' ? 'tests/script.txt' : `tests/script-${set.name}.txt`"
            style="flex: 1"
          />
        </div>
        <div class="row">
          <span class="label">{{ t('testsets.manual') }}</span>
          <span class="mono small">{{ set.manual }}/</span>
          <span class="small dim">{{ testCount ? t('testsets.generated', { n: testCount }) : t('testsets.notGenerated') }}</span>
        </div>
        <div class="row">
          <label class="opt"><n-switch v-model:value="set.groups" size="small" /> {{ t('testsets.groups') }}</label>
          <span v-if="set.groups && form.points" class="small" :class="pointsSum === 100 ? 'dim' : 'warn'">{{ t('testsets.pointsSum', { n: pointsSum }) }}</span>
        </div>

        <template v-if="set.groups">
          <n-alert type="info" :show-icon="false">{{ t('oiFeatures.subtaskHint') }}</n-alert>
          <table class="groups">
            <thead>
              <tr>
                <th>{{ t('testsets.groupName') }}</th>
                <th>{{ t('testsets.groupTests') }}</th>
                <th v-if="form.points">{{ t('testsets.groupPoints') }}</th>
                <th>{{ t('testsets.groupPolicy') }}</th>
                <th>{{ t('testsets.groupDeps') }}</th>
                <th>{{ t('testsets.groupValidator') }}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="(g, i) in set.group" :key="i">
                <td><n-input :value="g.name" size="small" class="mono" style="width: 70px" @update:value="(v: string) => renameGroup(g, v)" /></td>
                <td><n-input v-model:value="g.tests" size="small" class="mono" placeholder="1-5, 8" /></td>
                <td v-if="form.points"><n-input-number v-model:value="g.points" size="small" :min="0" :show-button="false" style="width: 70px" /></td>
                <td><n-select v-model:value="g.policy" size="small" :options="policyOptions" style="width: 130px" /></td>
                <td>
                  <n-select
                    v-model:value="g.dependencies"
                    size="small"
                    multiple
                    :options="set.group.filter((x) => x !== g && x.name).map((x) => ({ label: x.name, value: x.name }))"
                    style="min-width: 120px"
                  />
                </td>
                <td><n-select v-model:value="g.validator" size="small" filterable :options="validatorOptions" style="min-width: 140px" /></td>
                <td><n-button size="tiny" quaternary @click="removeGroup(i)"><x :size="13" /></n-button></td>
              </tr>
            </tbody>
          </table>
          <n-button size="small" dashed @click="addGroup"><template #icon><plus /></template>{{ t('testsets.addGroup') }}</n-button>
          <n-alert v-if="coverage && (coverage.loose.length || coverage.twice.length || coverage.missing.length)" type="warning" :show-icon="false" class="coverage">
            <div v-if="coverage.loose.length">{{ t('testsets.loose', { list: coverage.loose.slice(0, 30).join(', ') }) }}</div>
            <div v-if="coverage.twice.length">{{ t('testsets.twice', { list: coverage.twice.join(', ') }) }}</div>
            <div v-if="coverage.missing.length">{{ t('testsets.missingTests', { list: coverage.missing.slice(0, 30).join(', ') }) }}</div>
          </n-alert>
          <n-alert v-if="unevenGroups.length" type="info" :show-icon="false" class="coverage">{{ t('testsets.uneven', { list: unevenGroups.join(', ') }) }}</n-alert>
        </template>
        <div class="small dim note">{{ t('testsets.note') }}</div>
      </section>
    </div>
    <template #footer>
      <n-button @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
      <n-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</n-button>
    </template>
  </tool-window>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 16px;
  min-height: 360px;
}
.sets {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-right: 1px solid var(--pf-border);
  padding-right: 12px;
}
.del {
  margin-left: auto;
}
.add-set {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
.problem-wide {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--pf-border);
}
.detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.label {
  font-size: 12px;
  opacity: 0.7;
  min-width: 70px;
}
.opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.groups {
  border-collapse: collapse;
  width: 100%;
}
.groups th {
  text-align: left;
  font-size: 12px;
  font-weight: 500;
  opacity: 0.7;
  padding: 2px 4px;
}
.groups td {
  padding: 2px 4px;
}
.coverage {
  font-size: 12px;
}
.note {
  margin-top: auto;
}
.small {
  font-size: 12px;
}
.dim {
  color: var(--pf-text-secondary);
}
.warn {
  color: light-dark(#986415, #e8b060);
}
</style>
