<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NRadioButton,
  NRadioGroup,
  NSpace,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import type { GlobalConfig, LanguagesConfig, SecretsResponse, ToolProbe } from '@polyforge/shared';
import AppHeader from '../components/AppHeader.vue';
import CodeEditor from '../components/CodeEditor.vue';
import DirPicker from '../components/DirPicker.vue';
import { api, errorMessage } from '../lib/api';
import { settings, saveSettings } from '../lib/settings';

const { t } = useI18n();
const router = useRouter();
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
      if (r.helloWorld === 'ok') return '✓ ' + t('settings.works');
      if (r.helloWorld === 'failed') return '✗ ' + (r.error?.split('\n')[0] ?? t('settings.failed'));
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
const testResult = ref('');

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
  testResult.value = '';
  try {
    const r = await api.polygonTest();
    testResult.value = '✓ ' + t('settings.polygonOk', { n: r.problems, ms: r.ms });
  } catch (e) {
    testResult.value = '✗ ' + errorMessage(e);
  } finally {
    testing.value = false;
  }
}

onMounted(() => {
  loadLanguages().catch((e) => message.error(errorMessage(e)));
  loadSecrets().catch((e) => message.error(errorMessage(e)));
});
</script>

<template>
  <div class="page">
    <app-header>
      <template #left>
        <n-button size="small" quaternary @click="router.push({ name: 'problems' })">◀ {{ t('nav.problems') }}</n-button>
      </template>
      <strong>{{ t('nav.settings') }}</strong>
    </app-header>

    <main class="body">
      <n-tabs type="line" animated>
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
                  <span v-if="l.polygon" class="mono ext">→ {{ l.polygon }}</span>
                </div>
              </n-card>
              <n-card size="small" :title="t('settings.detect')">
                <template #header-extra>
                  <n-button size="small" :loading="detecting" @click="detect">{{ t('settings.detectRun') }}</n-button>
                </template>
                <p class="hint">{{ t('settings.detectHint') }}</p>
                <n-data-table v-if="probes.length" size="small" :columns="probeColumns" :data="probes" :bordered="false" />
              </n-card>
            </div>
          </div>
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
              <span class="small">{{ testResult }}</span>
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
</style>
