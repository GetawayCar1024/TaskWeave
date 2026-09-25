<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { checkMessage } from '../lib/serverText';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCheckbox,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NModal,
  NPopconfirm,
  NScrollbar,
  NSelect,
  NSpace,
  NSpin,
  NRadioButton,
  NRadioGroup,
  NTag,
  useMessage,
} from 'naive-ui';
import type { AiChangeContent, AiFinding, AiSessionMode, AiTranscriptItem, LocalCheck } from '@polyforge/shared';
import { api, errorMessage } from '../lib/api';
import type { Ai } from '../lib/ai';
import { PRESETS, pastedStatementPrompt } from '../lib/aiPresets';
import { renderMarkdown } from '../lib/markdown';
import { languageForPath } from '../lib/monaco';
import TextDiff from './TextDiff.vue';
import { Check, ChevronDown, ChevronRight, Circle, Lightbulb, Minus, Play, Plus, RotateCw, Trash2, X } from 'lucide-vue-next';
import { FALLBACK_TOOL_ICON, TOOL_ICONS } from '../lib/icons';
import type { Workspace } from '../lib/workspace';

const props = defineProps<{ show: boolean; ai: Ai; problemId: string; ws?: Workspace }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const { t } = useI18n();
const router = useRouter();
const message = useMessage();

const input = ref('');
const pasted = ref('');
const showPaste = ref(false);
const scroller = ref<InstanceType<typeof NScrollbar>>();
const expanded = ref(new Set<string>());

const tab = ref<AiSessionMode>('agent');
const checks = ref<LocalCheck[] | null>(null);

async function loadChecks() {
  checks.value = await api.checks(props.problemId).catch(() => []);
}

watch(
  () => props.show,
  async (s) => {
    if (!s) return;
    await props.ai.init().catch((e) => message.error(errorMessage(e)));
    if (tab.value === 'review') loadChecks();
  },
);
watch(tab, async (m) => {
  if (props.ai.state.current?.mode !== m) await props.ai.openLatest(m).catch(() => {});
  if (m === 'review') loadChecks();
});

async function startReview() {
  try {
    await props.ai.startReview();
  } catch (e) {
    message.error(errorMessage(e));
  }
}

async function fixFinding(f: AiFinding) {
  try {
    tab.value = 'agent';
    await props.ai.fix(f);
  } catch (e) {
    message.error(errorMessage(e));
  }
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;
const findings = computed(() =>
  [...(s.value.current?.mode === 'review' ? s.value.current.findingList : [])].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
);
const SEV_TYPE = { error: 'error', warning: 'warning', info: 'info' } as const;

defineExpose({ openTab: (m: AiSessionMode) => (tab.value = m) });

const s = computed(() => props.ai.state);
const sessionOptions = computed(() =>
  s.value.sessions
    .filter((x) => x.mode === tab.value)
    .map((x) => ({ label: `${x.title}${x.changes ? ` · ${x.changes}` : ''}${x.mode === 'review' ? ` · ${x.findings}` : ''}`, value: x.id })),
);
const endpointOptions = computed(() => s.value.endpoints.map((e) => ({ label: `${e.name} (${e.protocol})`, value: e.name })));
const modelOptions = computed(() => {
  const ep = s.value.endpoints.find((e) => e.name === s.value.current?.endpoint);
  const list = [...(ep?.models ?? [])];
  const cur = s.value.current?.model;
  if (cur && !list.includes(cur)) list.unshift(cur);
  return list.map((m) => ({ label: m, value: m }));
});

// Keep the newest output in view while streaming.
const tail = computed(() => {
  const items = props.ai.transcript.value;
  const last = items[items.length - 1] as { text?: string; result?: string } | undefined;
  return `${items.length}:${last?.text?.length ?? 0}:${last?.result?.length ?? 0}`;
});
watch(
  tail,
  async () => {
    await nextTick();
    scroller.value?.scrollTo({ top: 1e9 });
  },
);

async function send(text = input.value) {
  const msg = text.trim();
  if (!msg || props.ai.running.value) return;
  try {
    await props.ai.send(msg);
    if (text === input.value) input.value = '';
  } catch (e) {
    message.error(errorMessage(e));
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    send();
  }
}

async function newSession() {
  try {
    await props.ai.create(s.value.current?.endpoint, s.value.current?.model);
  } catch (e) {
    message.error(errorMessage(e));
  }
}

function toolLabel(item: Extract<AiTranscriptItem, { kind: 'tool' }>): string {
  const i = (item.input ?? {}) as Record<string, unknown>;
  const detail = i.path ?? (i.test ? `test ${i.test}` : i.index ? `test ${i.index} ${i.part ?? ''}` : '');
  return `${t(`ai.tool.${item.name}`, item.name)}${detail ? ` · ${detail}` : ''}`;
}


function toggle(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

async function openAt(file: string, line?: number) {
  if (!props.ws) return;
  await props.ws.openFile(file).catch((e) => message.error(errorMessage(e)));
  const ed = props.ws.editorRef.value;
  if (ed && line) {
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
  }
}

// ---- change review ----
const picked = ref(new Set<string>());
watch(
  () => s.value.changes.map((c) => c.path).join('|'),
  () => (picked.value = new Set(s.value.changes.map((c) => c.path))),
);
const diff = ref<AiChangeContent | null>(null);

async function openDiff(path: string) {
  if (!s.value.current) return;
  try {
    diff.value = await api.aiChangeContent(props.problemId, s.value.current.id, path);
  } catch (e) {
    message.error(errorMessage(e));
  }
}

async function review(accept: boolean, paths = [...picked.value]) {
  if (!paths.length) return;
  try {
    if (accept) await props.ai.accept(paths);
    else await props.ai.reject(paths);
    message.success(accept ? t('ai.accepted', { n: paths.length }) : t('ai.rejected', { n: paths.length }));
    diff.value = null;
  } catch (e) {
    message.error(errorMessage(e));
  }
}

const STATUS_TYPE = { added: 'success', modified: 'warning', deleted: 'error' } as const;
</script>

<template>
  <n-drawer :show="show" placement="right" :default-width="620" resizable :mask-closable="true" @update:show="emit('update:show', $event)">
    <n-drawer-content :native-scrollbar="false" body-content-style="padding: 0; height: 100%" closable>
      <template #header>
        <span>AI</span>
      </template>
      <div class="ai">
        <n-radio-group v-model:value="tab" size="small" class="mode-tabs">
          <n-radio-button value="agent">{{ t('ai.tabChat') }}</n-radio-button>
          <n-radio-button value="review">{{ t('ai.tabReview') }}</n-radio-button>
        </n-radio-group>
        <div v-if="tab === 'review'" class="checks">
          <div class="checks-head">
            <strong>{{ t('ai.localChecks') }}</strong>
            <n-button size="tiny" quaternary @click="loadChecks"><rotate-cw :size="13" /></n-button>
          </div>
          <div v-if="checks && !checks.length" class="small good row-icon"><check :size="13" /> {{ t('ai.noLocalIssues') }}</div>
          <div v-for="(c, i) in checks ?? []" :key="i" class="check">
            <n-tag size="tiny" :type="SEV_TYPE[c.level]" :bordered="false">{{ t(`ai.sev.${c.level}`) }}</n-tag>
            <span>{{ checkMessage(c) }}</span>
            <a v-if="c.file && ws" class="mono path" @click="openAt(c.file, c.line)">{{ c.file }}</a>
          </div>
        </div>
        <div v-if="!s.loading && !s.endpoints.length && tab === 'review'" class="small dim">{{ t('ai.reviewNeedsAi') }}</div>
        <div v-if="!s.loading && !s.endpoints.length && tab === 'agent'" class="empty">
          <n-empty :description="t('ai.noEndpoint')">
            <template #extra>
              <n-button size="small" type="primary" @click="router.push({ name: 'settings', query: { tab: 'ai' } })">{{ t('ai.configure') }}</n-button>
            </template>
          </n-empty>
        </div>
        <template v-else>
          <div v-if="tab === 'review'" class="bar">
            <n-button size="small" type="primary" :loading="ai.running.value && s.current?.mode === 'review'" :disabled="ai.running.value" @click="startReview">
              {{ t('ai.startReview') }}
            </n-button>
          </div>
          <div class="bar">
            <n-select
              size="small"
              :value="s.current?.id ?? null"
              :options="sessionOptions"
              :placeholder="t('ai.noSession')"
              style="flex: 1; min-width: 0"
              @update:value="(v: string) => ai.open(v)"
            />
            <n-button v-if="tab === 'agent'" size="small" @click="newSession"><template #icon><plus /></template>{{ t('ai.newSession') }}</n-button>
            <n-popconfirm v-if="s.current" @positive-click="ai.remove(s.current!.id)">
              <template #trigger><n-button size="small" quaternary><trash2 :size="15" /></n-button></template>
              {{ t('ai.deleteSession') }}
            </n-popconfirm>
          </div>
          <div v-if="s.current" class="bar">
            <n-select
              size="small"
              :value="s.current.endpoint"
              :options="endpointOptions"
              style="width: 45%"
              @update:value="(v: string) => ai.setModel(v, s.endpoints.find((e) => e.name === v)?.models[0] ?? s.current!.model)"
            />
            <n-select
              size="small"
              :value="s.current.model"
              :options="modelOptions"
              filterable
              tag
              style="flex: 1"
              @update:value="(v: string) => ai.setModel(s.current!.endpoint, v)"
            />
          </div>

          <div v-if="s.current?.plan.length" class="plan">
            <div v-for="(p, i) in s.current.plan" :key="i" :class="['step', p.status]">
              <span class="mark"><check v-if="p.status === 'done'" :size="12" /><play v-else-if="p.status === 'in_progress'" :size="11" /><minus v-else-if="p.status === 'skipped'" :size="12" /><circle v-else :size="10" /></span>
              {{ p.title }}
            </div>
          </div>

          <div v-if="tab === 'review' && findings.length" class="findings">
            <div v-for="f in findings" :key="f.id" class="finding" :class="f.severity">
              <div class="finding-head">
                <n-tag size="tiny" :type="SEV_TYPE[f.severity]" :bordered="false">{{ t(`ai.sev.${f.severity}`) }}</n-tag>
                <strong>{{ f.title }}</strong>
                <span class="small dim">{{ t(`ai.cat.${f.category}`) }}</span>
                <n-button size="tiny" class="fix" :disabled="ai.running.value" @click="fixFinding(f)">{{ t('ai.fixIt') }}</n-button>
              </div>
              <div class="small">{{ f.detail }}</div>
              <div v-if="f.suggestion" class="small dim row-icon"><lightbulb :size="12" /> {{ f.suggestion }}</div>
              <a v-if="f.file" class="mono path small" @click="openAt(f.file, f.line)">{{ f.file }}{{ f.line ? `:${f.line}` : '' }}</a>
            </div>
          </div>
          <n-scrollbar ref="scroller" class="log">
            <div v-if="!ai.transcript.value.length" class="hint">{{ tab === 'review' ? t('ai.reviewIntro') : t('ai.intro') }}</div>
            <template v-for="(item, i) in ai.transcript.value" :key="i">
              <div v-if="item.kind === 'user'" class="msg user">{{ item.text }}</div>
              <div v-else-if="item.kind === 'assistant'" class="msg assistant" v-html="renderMarkdown(item.text)" />
              <details v-else-if="item.kind === 'thinking'" class="thinking">
                <summary>{{ t('ai.thinking') }}</summary>
                <div class="thinking-text">{{ item.text }}</div>
              </details>
              <div v-else-if="item.kind === 'tool'" class="tool" :class="{ error: item.isError, pending: item.result === undefined }">
                <div class="tool-head" @click="toggle(item.id)">
                  <component :is="TOOL_ICONS[item.name] ?? FALLBACK_TOOL_ICON" :size="13" class="tool-icon" />
                  <span class="tool-label">{{ toolLabel(item) }}</span>
                  <n-spin v-if="item.result === undefined" :size="12" />
                  <x v-else-if="item.isError" :size="13" class="bad" />
                  <component :is="expanded.has(item.id) ? ChevronDown : ChevronRight" :size="13" class="chev" />
                </div>
                <div v-if="expanded.has(item.id)" class="tool-body">
                  <pre class="mono">{{ JSON.stringify(item.input, null, 1).slice(0, 3000) }}</pre>
                  <pre v-if="item.result !== undefined" class="mono result">{{ item.result }}</pre>
                </div>
              </div>
              <n-alert v-else-if="item.kind === 'notice'" :type="item.level === 'info' ? 'info' : item.level" :show-icon="false" class="notice">{{ item.text }}</n-alert>
            </template>
            <div v-if="ai.running.value" class="working"><n-spin :size="14" /> {{ t('ai.working') }}</div>
          </n-scrollbar>

          <div v-if="tab === 'agent' && s.changes.length" class="changes">
            <div class="changes-head">
              <strong>{{ t('ai.changes', { n: s.changes.length }) }}</strong>
              <n-space size="small">
                <n-button size="tiny" type="primary" :disabled="!picked.size || ai.running.value" @click="review(true)">{{ t('ai.accept', { n: picked.size }) }}</n-button>
                <n-button size="tiny" :disabled="!picked.size || ai.running.value" @click="review(false)">{{ t('ai.reject') }}</n-button>
              </n-space>
            </div>
            <div v-for="c in s.changes" :key="c.path" class="change">
              <n-checkbox
                :checked="picked.has(c.path)"
                @update:checked="(v: boolean) => { const n = new Set(picked); v ? n.add(c.path) : n.delete(c.path); picked = n; }"
              />
              <n-tag size="tiny" :type="STATUS_TYPE[c.status]" :bordered="false">{{ t(`ai.status.${c.status}`) }}</n-tag>
              <a class="mono path" @click="openDiff(c.path)">{{ c.path }}</a>
            </div>
          </div>

          <div v-if="tab === 'agent'" class="presets">
            <n-button v-for="p in PRESETS" :key="p.key" size="tiny" secondary :disabled="ai.running.value" @click="send(p.prompt)">
              {{ t(`ai.preset.${p.key}`) }}
            </n-button>
            <n-button size="tiny" secondary :type="showPaste ? 'primary' : 'default'" @click="showPaste = !showPaste">{{ t('ai.preset.paste') }}</n-button>
          </div>
          <div v-if="tab === 'agent' && showPaste" class="paste">
            <n-input v-model:value="pasted" type="textarea" :autosize="{ minRows: 4, maxRows: 12 }" :placeholder="t('ai.pastePlaceholder')" />
            <n-button size="small" type="primary" :disabled="!pasted.trim() || ai.running.value" @click="send(pastedStatementPrompt(pasted)); showPaste = false">
              {{ t('ai.buildFromPaste') }}
            </n-button>
          </div>
          <div v-if="tab === 'agent' || s.current?.mode === 'review'" class="input">
            <n-input v-model:value="input" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }" :placeholder="t('ai.placeholder')" @keydown="onKey" />
            <n-button v-if="ai.running.value" type="warning" @click="ai.cancel()">{{ t('ai.stop') }}</n-button>
            <n-button v-else type="primary" :disabled="!input.trim()" @click="send()">{{ t('ai.send') }}</n-button>
          </div>
        </template>
      </div>
    </n-drawer-content>
  </n-drawer>

  <n-modal :show="!!diff" preset="card" :title="diff?.path" style="width: 90vw" @update:show="(v: boolean) => !v && (diff = null)">
    <template v-if="diff">
      <div class="labels">
        <span>{{ t('ai.original') }}</span>
        <span>{{ t('ai.proposed') }}</span>
      </div>
      <div class="diff-box">
        <text-diff :original="diff.original ?? ''" :modified="diff.modified ?? ''" :language="languageForPath(diff.path)" />
      </div>
    </template>
    <template #footer>
      <n-space justify="end">
        <n-button @click="diff && review(false, [diff.path])">{{ t('ai.reject') }}</n-button>
        <n-button type="primary" @click="diff && review(true, [diff.path])">{{ t('ai.acceptOne') }}</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.ai {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mode-tabs {
  flex-shrink: 0;
}
.checks {
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 4px;
  padding: 4px 8px;
  max-height: 170px;
  overflow: auto;
  flex-shrink: 0;
}
.checks-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}
.check {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  padding: 1px 0;
}
.findings {
  max-height: 38%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}
.finding {
  border-left: 3px solid rgba(128, 128, 128, 0.5);
  padding: 4px 8px;
  background: rgba(128, 128, 128, 0.07);
  border-radius: 0 4px 4px 0;
}
.finding.error {
  border-left-color: #e88080;
}
.finding.warning {
  border-left-color: #f0a020;
}
.finding.info {
  border-left-color: #70c0e8;
}
.finding-head {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
}
.finding-head .fix {
  margin-left: auto;
}
.small {
  font-size: 12px;
}
.dim {
  opacity: 0.65;
}
.good {
  color: #63e2b7;
}
.bar {
  display: flex;
  gap: 6px;
  align-items: center;
}
.plan {
  font-size: 12px;
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 4px;
  padding: 4px 8px;
}
.step.done {
  opacity: 0.6;
}
.step.in_progress {
  color: #63e2b7;
}
.mark {
  display: inline-flex;
  width: 16px;
  vertical-align: -1px;
}
.row-icon {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tool-icon {
  opacity: 0.7;
  flex-shrink: 0;
}
.log {
  flex: 1;
  min-height: 0;
}
.hint {
  font-size: 12px;
  opacity: 0.65;
  padding: 16px 4px;
  white-space: pre-line;
}
.msg {
  margin: 6px 0;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
}
.msg.user {
  background: rgba(99, 226, 183, 0.12);
  border-radius: 6px;
  padding: 6px 10px;
  white-space: pre-wrap;
  margin-left: 40px;
}
.msg.assistant :deep(code) {
  background: rgba(128, 128, 128, 0.2);
  padding: 0 3px;
  border-radius: 3px;
  font-family: Consolas, monospace;
  font-size: 12px;
}
.msg.assistant :deep(.md-code) {
  background: rgba(128, 128, 128, 0.14);
  padding: 6px;
  border-radius: 4px;
  font-size: 12px;
  overflow-x: auto;
}
.msg.assistant :deep(.md-h) {
  font-weight: 600;
  margin-top: 4px;
}
.msg.assistant :deep(.md-gap) {
  height: 6px;
}
.msg.assistant :deep(ul) {
  margin: 2px 0;
  padding-left: 18px;
}
.thinking {
  font-size: 12px;
  opacity: 0.7;
  margin: 4px 0;
}
.thinking-text {
  white-space: pre-wrap;
  padding: 4px 8px;
  border-left: 2px solid rgba(128, 128, 128, 0.4);
}
.tool {
  font-size: 12px;
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 4px;
  margin: 3px 0;
}
.tool.error {
  border-color: rgba(232, 128, 128, 0.5);
}
.tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  cursor: pointer;
}
.tool-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chev {
  opacity: 0.5;
}
.tool-body pre {
  margin: 0;
  padding: 4px 8px;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 11px;
  border-top: 1px solid rgba(128, 128, 128, 0.15);
}
.tool-body .result {
  opacity: 0.85;
}
.bad {
  color: #e88080;
}
.notice {
  margin: 4px 0;
  padding: 2px 8px;
  font-size: 12px;
}
.working {
  font-size: 12px;
  opacity: 0.7;
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 4px 0;
}
.changes {
  border: 1px solid rgba(240, 160, 32, 0.45);
  border-radius: 4px;
  padding: 4px 8px;
  max-height: 180px;
  overflow: auto;
}
.changes-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  margin-bottom: 2px;
}
.change {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.path {
  cursor: pointer;
}
.path:hover {
  text-decoration: underline;
}
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.paste {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-end;
}
.input {
  display: flex;
  gap: 6px;
  align-items: flex-end;
}
.labels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  font-size: 12px;
  opacity: 0.7;
}
.diff-box {
  height: 65vh;
}
</style>
