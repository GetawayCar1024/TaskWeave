<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NInput, NInputNumber, NModal, NSelect, NSpace, NSwitch, NTag, useMessage } from 'naive-ui';
import { Plus, Trash2, X } from 'lucide-vue-next';
import { DEFAULT_TESTSET, GROUP_POLICIES, TESTSET_NAME_RE, parseIndexList, testsetsOf, type TestGroup, type TestsetPatch } from '@polyforge/shared';
import { errorMessage } from '../lib/api';
import type { Judge } from '../lib/judge';
import type { Workspace } from '../lib/workspace';

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
}
interface EditTestset {
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

function reset() {
  const c = cfg.value;
  if (!c) return;
  form.points = !!c.tests.points;
  form.deleted = [];
  form.sets = testsetsOf(c).map((ts) => ({
    name: ts.name,
    isNew: false,
    script: ts.script ?? '',
    manual: ts.manual,
    groups: ts.groups,
    group: ts.group.map((g) => ({ name: g.name, tests: g.tests ?? '', points: g.points ?? null, policy: g.policy ?? 'COMPLETE_GROUP', dependencies: [...(g.dependencies ?? [])] })),
  }));
  current.value = props.initial && form.sets.some((s) => s.name === props.initial) ? props.initial : DEFAULT_TESTSET;
}
watch(() => props.show, (s) => s && reset());

const set = computed(() => form.sets.find((s) => s.name === current.value) ?? form.sets[0]);
const scripts = computed(() => props.ws.files.value.filter((f) => f.path.endsWith('.txt') && f.path.startsWith('tests/')).map((f) => f.path));
const manifest = computed(() => props.judge.state.manifests[current.value] ?? (current.value === DEFAULT_TESTSET ? props.judge.state.manifest : null));
const testCount = computed(() => manifest.value?.tests.length ?? 0);

function addTestset() {
  const name = newName.value.trim();
  if (!TESTSET_NAME_RE.test(name)) return message.error(t('testsets.badName'));
  if (form.sets.some((s) => s.name === name)) return message.error(t('testsets.exists', { name }));
  form.sets.push({ name, isNew: true, script: '', manual: `tests/${name}`, groups: false, group: [] });
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
  const name = String(s.group.length + 1);
  s.group.push({ name, tests: from <= testCount.value ? `${from}-${testCount.value}` : '', points: null, policy: 'COMPLETE_GROUP', dependencies: [] });
  s.groups = true;
}

// Coverage summary: tests outside groups / in two groups.
const coverage = computed(() => {
  const s = set.value;
  if (!s?.groups || !testCount.value) return null;
  const seen = new Map<number, number>();
  for (const g of s.group) for (const i of parseIndexList(g.tests)) seen.set(i, (seen.get(i) ?? 0) + 1);
  const all = manifest.value!.tests.map((x) => x.index);
  return { loose: all.filter((i) => !seen.has(i)), twice: [...seen].filter(([, n]) => n > 1).map(([i]) => i) };
});
const pointsSum = computed(() => set.value?.group.reduce((a, g) => a + (g.points ?? 0), 0) ?? 0);

async function save() {
  saving.value = true;
  try {
    const testsets: Record<string, TestsetPatch | null> = {};
    for (const s of form.sets) {
      testsets[s.name] = {
        script: s.script.trim() || null,
        groups: s.groups,
        group: s.group.map(
          (g): TestGroup => ({
            name: g.name.trim(),
            tests: g.tests.trim() || undefined,
            points: form.points && g.points !== null ? g.points : undefined,
            policy: g.policy,
            dependencies: g.dependencies.length ? g.dependencies : undefined,
          }),
        ),
      };
    }
    for (const d of form.deleted) testsets[d] = null;
    await props.ws.patch({ points: form.points, testsets });
    message.success(t('common.saved'));
    emit('update:show', false);
  } catch (e) {
    message.error(errorMessage(e));
  } finally {
    saving.value = false;
  }
}

const policyOptions = computed(() => GROUP_POLICIES.map((p) => ({ label: t(`testsets.policy.${p}`), value: p })));
</script>

<template>
  <n-modal :show="show" preset="card" :title="t('testsets.title')" style="width: 920px" @update:show="emit('update:show', $event)">
    <div v-if="set" class="layout">
      <aside class="sets">
        <div
          v-for="s in form.sets"
          :key="s.name"
          class="set"
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
        <div class="row">
          <span class="label">{{ t('testsets.script') }}</span>
          <n-select
            v-model:value="set.script"
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
          <table class="groups">
            <thead>
              <tr>
                <th>{{ t('testsets.groupName') }}</th>
                <th>{{ t('testsets.groupTests') }}</th>
                <th v-if="form.points">{{ t('testsets.groupPoints') }}</th>
                <th>{{ t('testsets.groupPolicy') }}</th>
                <th>{{ t('testsets.groupDeps') }}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="(g, i) in set.group" :key="i">
                <td><n-input v-model:value="g.name" size="small" class="mono" style="width: 70px" /></td>
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
                <td><n-button size="tiny" quaternary @click="set.group.splice(i, 1)"><x :size="13" /></n-button></td>
              </tr>
            </tbody>
          </table>
          <n-button size="small" dashed @click="addGroup"><template #icon><plus /></template>{{ t('testsets.addGroup') }}</n-button>
          <n-alert v-if="coverage && (coverage.loose.length || coverage.twice.length)" type="warning" :show-icon="false" class="coverage">
            <div v-if="coverage.loose.length">{{ t('testsets.loose', { list: coverage.loose.slice(0, 30).join(', ') }) }}</div>
            <div v-if="coverage.twice.length">{{ t('testsets.twice', { list: coverage.twice.join(', ') }) }}</div>
          </n-alert>
        </template>
        <div class="small dim note">{{ t('testsets.note') }}</div>
      </section>
    </div>
    <template #footer>
      <n-space justify="end">
        <n-button @click="emit('update:show', false)">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</n-button>
      </n-space>
    </template>
  </n-modal>
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
  border-right: 1px solid rgba(128, 128, 128, 0.25);
  padding-right: 12px;
}
.set {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.set:hover {
  background: rgba(128, 128, 128, 0.12);
}
.set.active {
  background: rgba(99, 226, 183, 0.15);
}
.set .del {
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
  border-top: 1px solid rgba(128, 128, 128, 0.25);
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
  opacity: 0.6;
}
.warn {
  color: #e8b060;
}
</style>
