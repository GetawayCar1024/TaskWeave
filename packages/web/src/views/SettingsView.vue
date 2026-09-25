<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { ArrowLeft, Check, X } from 'lucide-vue-next';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  NSpace,
  NSwitch,
  NSelect,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { AI_PROTOCOLS, CURRENCIES, type AiProtocol, type Currency, type EndpointPricing, type GlobalConfig, type LanguagesConfig, type SecretsResponse, type ToolProbe, type UsageGroup, type UsageStats } from '@polyforge/shared';
import AppHeader from '../components/AppHeader.vue';
import CodeEditor from '../components/CodeEditor.vue';
import DirPicker from '../components/DirPicker.vue';
import { api, errorMessage } from '../lib/api';
import { settings, saveSettings } from '../lib/settings';
import { serverText } from '../lib/serverText';

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const initialTab = typeof route.query.tab === 'string' ? route.query.tab : 'general';
const message = useMessage();

// ---- general ----
const draft = ref<GlobalConfig>(JSON.parse(JSON.stringify(settings.config)));
const saving = ref(false);
const showPicker = ref(false);

async function saveGeneral() {
  saving.value = true;
  try {
    await saveSettings(draft.value);
    draft.value = JSON.parse(JSON.stringify(settings.config));
    message.success(t('common.saved'));
  } catch (e) {
    message.error(errorMessage(e));
  } finally {
    saving.value = false;
  }
}

function addRoot(p: string) {
  if (!draft.value.problems.roots.includes(p)) draft.value.problems.roots.push(p);
}

// ---- languages ----
const langText = ref('');
const langSaved = ref('');
const langParsed = ref<LanguagesConfig>({});
const langError = ref('');
const langDirty = computed(() => langText.value !== langSaved.value);

async function loadLanguages() {
  const r = await api.languages();
  langText.value = langSaved.value = r.text;
  langParsed.value = r.languages;
  langError.value = r.error ?? '';
}

async function saveLanguages() {
  try {
    const r = await api.saveLanguages(langText.value);
    langSaved.value = r.text;
    langParsed.value = r.languages;
    langError.value = '';
    message.success(t('common.saved'));
  } catch (e) {
    langError.value = errorMessage(e);
  }
}

const probes = ref<ToolProbe[]>([]);
const detecting = ref(false);
async function detect() {
  detecting.value = true;
  try {
    probes.value = await api.detectTools();
  } catch (e) {
    message.error(errorMessage(e));
  } finally {
    detecting.value = false;
  }
}

const probeColumns = computed<DataTableColumns<ToolProbe>>(() => [
  { title: t('settings.tool'), key: 'tool', width: 90 },
  { title: t('settings.toolPath'), key: 'path', ellipsis: { tooltip: true }, render: (r) => r.path ?? '—' },
  { title: t('settings.toolVersion'), key: 'version', ellipsis: { tooltip: true }, render: (r) => r.version ?? '—' },
  {
    title: t('settings.toolStatus'),
    key: 'status',
    width: 140,
    render: (r) => {
      if (!r.found) return t('settings.notFound');
      if (r.helloWorld === 'ok') return h('span', { class: 'good status' }, [h(Check, { size: 13 }), t('settings.works')]);
      if (r.helloWorld === 'failed') return h('span', { class: 'bad status', title: r.error }, [h(X, { size: 13 }), r.error?.split('\n')[0] ?? t('settings.failed')]);
      return t('settings.found');
    },
  },
]);

// ---- Polygon ----
const secrets = ref<SecretsResponse | null>(null);
const polyKey = ref('');
const polySecret = ref('');
const polyUrl = ref('');
const testing = ref(false);
const testResult = ref<{ ok: boolean; text: string } | null>(null);

async function loadSecrets() {
  secrets.value = await api.secrets();
  polyUrl.value = secrets.value.polygon.apiUrl;
}

async function savePolygon() {
  try {
    secrets.value = await api.saveSecrets({ polygon: { key: polyKey.value, secret: polySecret.value, apiUrl: polyUrl.value } });
    polyKey.value = '';
    polySecret.value = '';
    message.success(t('common.saved'));
  } catch (e) {
    message.error(errorMessage(e));
  }
}

async function testPolygon() {
  testing.value = true;
  testResult.value = null;
  try {
    const r = await api.polygonTest();
    testResult.value = { ok: true, text: t('settings.polygonOk', { n: r.problems, ms: r.ms }) };
  } catch (e) {
    testResult.value = { ok: false, text: errorMessage(e) };
  } finally {
    testing.value = false;
  }
}

// ---- AI endpoints ----
interface EditEndpoint {
  name: string;
  previousName?: string;
  protocol: AiProtocol;
  baseUrl: string;
  apiKey: string;
  maskedKey: string;
  models: string;
  status?: { ok: boolean; text: string };
  currency: Currency;
  prices: PriceRow[];
  showPrices: boolean;
}
/** Prices per 1M tokens; null = not set (cache prices then follow the protocol default). */
interface PriceRow {
  model: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}
const endpoints = ref<EditEndpoint[]>([]);
const aiBusy = ref<string | null>(null);

async function loadEndpoints() {
  endpoints.value = (await api.aiEndpoints()).map((e) => ({
    name: e.name,
    previousName: e.name,
    protocol: e.protocol,
    baseUrl: e.baseUrl,
    apiKey: '',
    maskedKey: e.hasKey ? e.apiKey : '',
    models: e.models.join(', '),
    currency: e.pricing?.currency ?? 'USD',
    prices: Object.entries(e.pricing?.prices ?? {}).map(([model, p]) => ({ model, input: p.input, output: p.output, cacheRead: p.cacheRead ?? null, cacheWrite: p.cacheWrite ?? null })),
    showPrices: false,
  }));
}

function pricingOf(e: EditEndpoint): EndpointPricing | undefined {
  const rows = e.prices.filter((p) => p.model.trim() && p.input !== null && p.output !== null);
  if (!rows.length) return undefined;
  return {
    currency: e.currency,
    prices: Object.fromEntries(rows.map((p) => [p.model.trim(), { input: p.input!, output: p.output!, cacheRead: p.cacheRead ?? undefined, cacheWrite: p.cacheWrite ?? undefined }])),
  };
}
function addPrice(e: EditEndpoint) {
  const used = new Set(e.prices.map((p) => p.model));
  const model = e.models.split(/[\s,]+/).filter(Boolean).find((m) => !used.has(m)) ?? (used.has('*') ? '' : '*');
  e.prices.push({ model, input: null, output: null, cacheRead: null, cacheWrite: null });
  e.showPrices = true;
}

function addEndpoint(protocol: AiProtocol) {
  endpoints.value.push({
    name: protocol === 'anthropic' ? 'Claude' : 'OpenAI-compatible',
    protocol,
    baseUrl: protocol === 'anthropic' ? '' : 'https://api.openai.com/v1',
    apiKey: '',
    maskedKey: '',
    models: protocol === 'anthropic' ? 'claude-opus-5, claude-sonnet-5' : '',
    currency: 'USD',
    prices: [],
    showPrices: false,
  });
}

async function saveEndpoints() {
  const list = endpoints.value.map((e) => ({
    name: e.name,
    previousName: e.previousName,
    protocol: e.protocol,
    baseUrl: e.baseUrl,
    apiKey: e.apiKey,
    models: e.models.split(/[\s,]+/).filter(Boolean),
    pricing: pricingOf(e),
  }));
  // Keep per-row UI state (status line, open price table) across the reload.
  const ui = new Map(endpoints.value.map((e) => [e.name, { status: e.status, showPrices: e.showPrices }]));
  await api.saveAiEndpoints(list);
  await loadEndpoints();
  for (const e of endpoints.value) Object.assign(e, ui.get(e.name) ?? {});
}

/** Saving reloads the list, so look the endpoint up again afterwards. */
const fresh = (name: string, fallback: EditEndpoint) => endpoints.value.find((x) => x.name === name) ?? fallback;

async function saveAi() {
  try {
    await saveEndpoints();
    await saveSettings(JSON.parse(JSON.stringify({ ...settings.config, ai: draft.value.ai })));
    message.success(t('common.saved'));
  } catch (e) {
    message.error(errorMessage(e));
  }
}

async function testEndpoint(e: EditEndpoint) {
  const name = e.name;
  aiBusy.value = name;
  try {
    await saveEndpoints();
    const ep = fresh(name, e);
    const r = await api.testAiEndpoint(name, ep.models.split(/[\s,]+/).filter(Boolean)[0]);
    ep.status = r.ok ? { ok: true, text: `${r.ms} ms · ${r.reply ?? ''}` } : { ok: false, text: serverText(r.error) };
    if (!r.ok) message.error(serverText(r.error) || t('settings.failed'));
  } catch (err) {
    fresh(name, e).status = { ok: false, text: serverText(errorMessage(err)) };
    message.error(serverText(errorMessage(err)));
  } finally {
    aiBusy.value = null;
  }
}

async function fetchModels(e: EditEndpoint) {
  const name = e.name;
  aiBusy.value = name;
  try {
    await saveEndpoints();
    const models = await api.aiModels(name);
    const ep = fresh(name, e);
    const before = ep.models.split(/[\s,]+/).filter(Boolean);
    const merged = [...new Set([...before, ...models])];
    ep.models = merged.join(', ');
    // Keep the fetched list.
    await saveEndpoints();
    const added = merged.length - before.length;
    fresh(name, e).status = { ok: true, text: t('settings.aiModelsFetched', { n: models.length, added }) };
    message.success(t('settings.aiModelsFetched', { n: models.length, added }));
  } catch (err) {
    fresh(name, e).status = { ok: false, text: serverText(errorMessage(err)) };
    message.error(serverText(errorMessage(err)));
  } finally {
    aiBusy.value = null;
  }
}

// ---- usage statistics ----
const usage = ref<UsageStats | null>(null);
async function loadUsage() {
  usage.value = await api.aiUsage().catch(() => null);
}
async function clearUsage() {
  await api.clearAiUsage();
  await loadUsage();
}
const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const SYMBOL: Record<string, string> = { USD: '$', CNY: '¥' };
function fmtCost(g: UsageGroup) {
  const parts = Object.entries(g.cost).map(([c, v]) => `${SYMBOL[c] ?? c}${(v as number) < 0.01 ? (v as number).toFixed(4) : (v as number).toFixed(2)}`);
  if (!parts.length) return g.usage.requests ? t('settings.usageNoPrice') : '—';
  return parts.join(' + ') + (g.unpriced ? ` (${t('settings.usagePartial')})` : '');
}
const usageRows = computed(() => (usage.value ? [usage.value.today, usage.value.month, usage.value.all] : []));

const endpointNames = computed(() => endpoints.value.map((e) => ({ label: e.name, value: e.name })));

onMounted(() => {
  loadLanguages().catch((e) => message.error(errorMessage(e)));
  loadSecrets().catch((e) => message.error(errorMessage(e)));
  loadEndpoints().catch((e) => message.error(errorMessage(e)));
  loadUsage();
});
</script>

<template>
  <div class="page">
    <app-header>
      <template #left>
        <n-button size="small" quaternary @click="router.push({ name: 'problems' })"><template #icon><arrow-left /></template>{{ t('nav.problems') }}</n-button>
      </template>
      <strong>{{ t('nav.settings') }}</strong>
    </app-header>

    <main class="body">
      <n-tabs type="line" animated :default-value="initialTab">
        <n-tab-pane name="general" :tab="t('settings.general')">
          <n-card size="small">
            <n-form label-placement="left" label-width="160">
              <n-form-item :label="t('settings.globalDir')">
                <span class="mono">{{ settings.globalDir }}</span>
              </n-form-item>
              <n-form-item :label="t('settings.roots')">
                <div class="roots">
                  <div v-for="(r, i) in draft.problems.roots" :key="r" class="root-row">
                    <span class="mono">{{ r }}</span>
                    <n-button size="tiny" quaternary type="error" @click="draft.problems.roots.splice(i, 1)">{{ t('common.remove') }}</n-button>
                  </div>
                  <n-button size="small" dashed @click="showPicker = true">+ {{ t('settings.addRoot') }}</n-button>
                </div>
              </n-form-item>
              <n-form-item :label="t('settings.locale')">
                <n-radio-group v-model:value="draft.ui.locale">
                  <n-radio-button value="zh-CN">简体中文</n-radio-button>
                  <n-radio-button value="en">English</n-radio-button>
                </n-radio-group>
              </n-form-item>
              <n-form-item :label="t('settings.theme')">
                <n-radio-group v-model:value="draft.ui.theme">
                  <n-radio-button value="dark">{{ t('settings.dark') }}</n-radio-button>
                  <n-radio-button value="light">{{ t('settings.light') }}</n-radio-button>
                </n-radio-group>
              </n-form-item>
              <n-form-item :label="t('settings.fontSize')">
                <n-input-number v-model:value="draft.editor.font_size" :min="8" :max="40" style="width: 120px" />
              </n-form-item>
              <n-form-item :label="t('settings.tabSize')">
                <n-input-number v-model:value="draft.editor.tab_size" :min="1" :max="8" style="width: 120px" />
              </n-form-item>
              <n-form-item :label="t('settings.wordWrap')"><n-switch v-model:value="draft.editor.word_wrap" /></n-form-item>
              <n-form-item :label="t('settings.minimap')"><n-switch v-model:value="draft.editor.minimap" /></n-form-item>
            </n-form>
            <n-space justify="end">
              <n-button type="primary" :loading="saving" @click="saveGeneral">{{ t('common.save') }}</n-button>
            </n-space>
          </n-card>
        </n-tab-pane>

        <n-tab-pane name="languages" :tab="t('settings.languages')">
          <div class="lang-layout">
            <n-card size="small" class="lang-editor" :title="'languages.toml'">
              <template #header-extra>
                <n-button size="small" type="primary" :disabled="!langDirty" @click="saveLanguages">{{ t('common.save') }}</n-button>
              </template>
              <n-alert v-if="langError" type="error" :show-icon="false" style="margin-bottom: 8px">{{ langError }}</n-alert>
              <div class="editor-box">
                <code-editor v-model="langText" language="toml" @save="saveLanguages" />
              </div>
            </n-card>
            <div class="lang-side">
              <n-card size="small" :title="t('settings.configured')">
                <div v-for="(l, id) in langParsed" :key="id" class="lang-item">
                  <n-tag size="small" :bordered="false">{{ id }}</n-tag>
                  <span>{{ l.name }}</span>
                  <span class="mono ext">{{ l.extensions.join(' ') }}</span>
                  <span v-if="l.polygon" class="mono ext">Polygon: {{ l.polygon }}</span>
                </div>
              </n-card>
              <n-card size="small" :title="t('settings.detect')">
                <template #header-extra>
                  <n-button size="small" :loading="detecting" @click="detect">{{ t('settings.detectRun') }}</n-button>
                </template>
                <n-data-table v-if="probes.length" size="small" :columns="probeColumns" :data="probes" :bordered="false" />
              </n-card>
            </div>
          </div>
        </n-tab-pane>
        <n-tab-pane name="ai" tab="AI">
          <n-card size="small">
            <div v-for="(e, i) in endpoints" :key="i" class="endpoint">
              <div class="ep-row">
                <n-input v-model:value="e.name" size="small" :placeholder="t('settings.aiName')" style="width: 180px" />
                <n-select v-model:value="e.protocol" size="small" :options="AI_PROTOCOLS.map((p) => ({ label: p, value: p }))" style="width: 120px" />
                <n-input v-model:value="e.baseUrl" size="small" class="mono" :placeholder="e.protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://…/v1'" style="flex: 1" />
                <n-button size="small" quaternary type="error" @click="endpoints.splice(i, 1)">{{ t('common.remove') }}</n-button>
              </div>
              <div class="ep-row">
                <n-input v-model:value="e.apiKey" size="small" type="password" show-password-on="click" class="mono" :placeholder="e.maskedKey ? e.maskedKey + ' (' + t('settings.keepEmpty') + ')' : 'API key'" style="width: 300px" />
                <n-input v-model:value="e.models" size="small" class="mono" :placeholder="t('settings.aiModels')" style="flex: 1" />
              </div>
              <div class="ep-row">
                <n-button size="tiny" :loading="aiBusy === e.name" :disabled="!e.name" @click="testEndpoint(e)">{{ t('settings.testConnection') }}</n-button>
                <n-button size="tiny" :loading="aiBusy === e.name" :disabled="!e.name" @click="fetchModels(e)">{{ t('settings.aiFetchModels') }}</n-button>
                <n-button size="tiny" quaternary @click="e.prices.length ? (e.showPrices = !e.showPrices) : addPrice(e)">
                  {{ t('settings.prices') }}{{ e.prices.length ? ` (${e.prices.length})` : '' }}
                </n-button>
                <span v-if="e.status" class="small status" :class="e.status.ok ? 'good' : 'bad'"><check v-if="e.status.ok" :size="13" /><x v-else :size="13" />{{ e.status.text }}</span>
              </div>
              <div v-if="e.showPrices" class="prices">
                <div class="price-head">
                  <span>{{ t('settings.priceModel') }}</span><span>{{ t('settings.priceInput') }}</span><span>{{ t('settings.priceOutput') }}</span>
                  <span>{{ t('settings.priceCacheRead') }}</span><span>{{ t('settings.priceCacheWrite') }}</span>
                  <n-select v-model:value="e.currency" size="tiny" :options="CURRENCIES.map((c) => ({ label: c, value: c }))" style="width: 80px" />
                </div>
                <div v-for="(p, pi) in e.prices" :key="pi" class="price-row">
                  <n-select
                    v-model:value="p.model"
                    size="tiny"
                    filterable
                    tag
                    :options="['*', ...e.models.split(/[\s,]+/).filter(Boolean)].map((m) => ({ label: m === '*' ? t('settings.priceOther') : m, value: m }))"
                  />
                  <n-input-number v-model:value="p.input" size="tiny" :min="0" :show-button="false" placeholder="—" />
                  <n-input-number v-model:value="p.output" size="tiny" :min="0" :show-button="false" placeholder="—" />
                  <n-input-number v-model:value="p.cacheRead" size="tiny" :min="0" :show-button="false" :placeholder="e.protocol === 'anthropic' ? '×0.1' : '='" />
                  <n-input-number v-model:value="p.cacheWrite" size="tiny" :min="0" :show-button="false" :placeholder="e.protocol === 'anthropic' ? '×1.25' : '='" />
                  <n-button size="tiny" quaternary @click="e.prices.splice(pi, 1)">×</n-button>
                </div>
                <div class="price-foot">
                  <n-button size="tiny" dashed @click="addPrice(e)">+ {{ t('settings.priceAdd') }}</n-button>
                  <span class="small dim">{{ t('settings.priceHint') }}</span>
                </div>
              </div>
            </div>
            <n-space>
              <n-button size="small" dashed @click="addEndpoint('anthropic')">+ Anthropic</n-button>
              <n-button size="small" dashed @click="addEndpoint('openai')">+ OpenAI {{ t('settings.aiCompatible') }}</n-button>
            </n-space>
            <n-form label-placement="left" label-width="160" style="margin-top: 16px">
              <n-form-item :label="t('settings.aiDefault')">
                <n-space>
                  <n-select v-model:value="draft.ai.endpoint" :options="endpointNames" clearable size="small" style="width: 200px" />
                  <n-input v-model:value="draft.ai.model" size="small" class="mono" placeholder="claude-opus-5" style="width: 220px" />
                </n-space>
              </n-form-item>
            </n-form>
            <n-space justify="end">
              <n-button type="primary" @click="saveAi">{{ t('common.save') }}</n-button>
            </n-space>
          </n-card>
          <n-card size="small" :title="t('settings.usage')" style="margin-top: 12px">
            <template #header-extra>
              <n-space size="small">
                <n-button size="tiny" quaternary @click="loadUsage">{{ t('settings.usageRefresh') }}</n-button>
                <n-popconfirm @positive-click="clearUsage">
                  <template #trigger><n-button size="tiny" quaternary type="error">{{ t('settings.usageClear') }}</n-button></template>
                  {{ t('settings.usageClearConfirm') }}
                </n-popconfirm>
              </n-space>
            </template>
            <table v-if="usage" class="usage">
              <thead>
                <tr>
                  <th />
                  <th>{{ t('settings.usageRequests') }}</th>
                  <th>{{ t('settings.priceInput') }}</th>
                  <th>{{ t('settings.priceOutput') }}</th>
                  <th>{{ t('settings.priceCacheRead') }}</th>
                  <th>{{ t('settings.priceCacheWrite') }}</th>
                  <th>{{ t('settings.usageCost') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="g in usageRows" :key="g.key">
                  <td>{{ t(`settings.usagePeriod.${g.key}`) }}</td>
                  <td>{{ g.usage.requests }}</td>
                  <td>{{ fmtTokens(g.usage.input) }}</td>
                  <td>{{ fmtTokens(g.usage.output) }}</td>
                  <td>{{ fmtTokens(g.usage.cacheRead) }}</td>
                  <td>{{ fmtTokens(g.usage.cacheWrite) }}</td>
                  <td><strong>{{ fmtCost(g) }}</strong></td>
                </tr>
                <tr v-if="usage.byModel.length" class="sep"><td colspan="7">{{ t('settings.usageByModel') }}</td></tr>
                <tr v-for="g in usage.byModel" :key="'m' + g.key">
                  <td class="mono small">{{ g.key }}</td>
                  <td>{{ g.usage.requests }}</td>
                  <td>{{ fmtTokens(g.usage.input) }}</td>
                  <td>{{ fmtTokens(g.usage.output) }}</td>
                  <td>{{ fmtTokens(g.usage.cacheRead) }}</td>
                  <td>{{ fmtTokens(g.usage.cacheWrite) }}</td>
                  <td>{{ fmtCost(g) }}</td>
                </tr>
                <tr v-if="usage.byProblem.length" class="sep"><td colspan="7">{{ t('settings.usageByProblem') }}</td></tr>
                <tr v-for="g in usage.byProblem" :key="'p' + g.key">
                  <td class="mono small">{{ g.key }}</td>
                  <td>{{ g.usage.requests }}</td>
                  <td>{{ fmtTokens(g.usage.input) }}</td>
                  <td>{{ fmtTokens(g.usage.output) }}</td>
                  <td>{{ fmtTokens(g.usage.cacheRead) }}</td>
                  <td>{{ fmtTokens(g.usage.cacheWrite) }}</td>
                  <td>{{ fmtCost(g) }}</td>
                </tr>
              </tbody>
            </table>
          </n-card>
        </n-tab-pane>
        <n-tab-pane name="polygon" tab="Polygon">
          <n-card size="small">
            <n-form label-placement="left" label-width="160">
              <n-form-item label="API key">
                <n-input v-model:value="polyKey" :placeholder="secrets?.polygon.hasKey ? secrets.polygon.key + ' (' + t('settings.keepEmpty') + ')' : ''" class="mono" />
              </n-form-item>
              <n-form-item label="API secret">
                <n-input v-model:value="polySecret" type="password" show-password-on="click" :placeholder="secrets?.polygon.hasSecret ? '•••••••• (' + t('settings.keepEmpty') + ')' : ''" class="mono" />
              </n-form-item>
              <n-form-item label="API URL">
                <n-input v-model:value="polyUrl" class="mono" />
              </n-form-item>
            </n-form>
            <p class="hint">{{ t('settings.polygonHint') }}</p>
            <n-space justify="space-between" align="center">
              <span v-if="testResult" class="small status" :class="testResult.ok ? 'good' : 'bad'"><check v-if="testResult.ok" :size="13" /><x v-else :size="13" />{{ testResult.text }}</span><span v-else />
              <n-space>
                <n-button :loading="testing" :disabled="!secrets?.polygon.hasKey" @click="testPolygon">{{ t('settings.testConnection') }}</n-button>
                <n-button type="primary" @click="savePolygon">{{ t('common.save') }}</n-button>
              </n-space>
            </n-space>
          </n-card>
        </n-tab-pane>
      </n-tabs>
    </main>

    <dir-picker v-model:show="showPicker" :initial="draft.problems.roots[0] ?? ''" @pick="addRoot" />
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.body {
  flex: 1;
  overflow: auto;
  padding: 12px 20px;
}
.roots {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.root-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.lang-layout {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 12px;
}
.lang-side {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.editor-box {
  height: calc(100vh - 230px);
  min-height: 300px;
}
.lang-item {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 3px 0;
}
.ext {
  font-size: 12px;
  opacity: 0.65;
}
.hint {
  font-size: 12px;
  opacity: 0.7;
  margin: 0 0 8px;
}
.small {
  font-size: 12px;
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.good {
  color: #63e2b7;
}
.bad {
  color: #e88080;
}
.endpoint {
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 4px;
  padding: 8px;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.prices {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 0 0;
  border-top: 1px dashed rgba(128, 128, 128, 0.3);
}
.price-head,
.price-row {
  display: grid;
  grid-template-columns: minmax(160px, 1.6fr) repeat(4, minmax(70px, 1fr)) 80px;
  gap: 6px;
  align-items: center;
}
.price-head {
  font-size: 12px;
  opacity: 0.7;
}
.price-foot {
  display: flex;
  gap: 10px;
  align-items: center;
}
.dim {
  opacity: 0.6;
}
.usage {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.usage th {
  text-align: right;
  font-weight: 500;
  font-size: 12px;
  opacity: 0.7;
  padding: 2px 8px;
}
.usage td {
  text-align: right;
  padding: 3px 8px;
}
.usage td:first-child,
.usage th:first-child {
  text-align: left;
}
.usage tr.sep td {
  text-align: left;
  font-size: 12px;
  opacity: 0.6;
  padding-top: 10px;
}
.ep-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
</style>
