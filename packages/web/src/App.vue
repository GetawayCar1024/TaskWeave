<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NGlobalStyle,
  NResult,
  NSpin,
  darkTheme,
  zhCN,
  dateZhCN,
  enUS,
  dateEnUS,
} from 'naive-ui';
import { onUnauthorized, errorMessage } from './lib/api';
import { settings, loadSettings } from './lib/settings';
import { startWs } from './lib/ws';
import { monaco } from './lib/monaco';
import ExitGuard from './components/ExitGuard.vue';
import { desktop } from './lib/desktop';
import type { GlobalThemeOverrides } from 'naive-ui';

const { t, locale } = useI18n();
const unauthorized = ref(false);
const loadError = ref('');

onUnauthorized(() => (unauthorized.value = true));

onMounted(async () => {
  try {
    await loadSettings();
    startWs();
  } catch (e) {
    if (!unauthorized.value) loadError.value = errorMessage(e);
  }
});

const dark = computed(() => settings.config?.ui.theme !== 'light');
watchEffect(() => {
  const mode = dark.value ? 'dark' : 'light';
  document.documentElement.style.colorScheme = mode;
  document.documentElement.dataset.theme = mode;
  desktop?.setTheme(mode);
  monaco.editor.setTheme(dark.value ? 'vs-dark' : 'vs');
});
const overrides = computed<GlobalThemeOverrides>(() => ({
  common: {
    primaryColor: dark.value ? '#409cff' : '#007aff',
    primaryColorHover: dark.value ? '#70b5ff' : '#0062cc',
    primaryColorPressed: dark.value ? '#0a84ff' : '#0054b0',
    primaryColorSuppl: '#007aff',
    borderRadius: '7px',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif",
    bodyColor: dark.value ? '#1c1c1e' : '#f2f2f7',
    cardColor: dark.value ? '#2c2c2e' : '#ffffff',
    modalColor: dark.value ? '#2c2c2e' : '#ffffff',
    popoverColor: dark.value ? '#2c2c2e' : '#ffffff',
    tableColor: dark.value ? '#242426' : '#ffffff',
    borderColor: dark.value ? '#3a3a3c' : '#dcdce2',
  },
  Card: { borderRadius: '10px' },
  Dialog: { borderRadius: '12px' },
}));
const theme = computed(() => (dark.value ? darkTheme : null));
const nLocale = computed(() => (locale.value === 'en' ? enUS : zhCN));
const nDateLocale = computed(() => (locale.value === 'en' ? dateEnUS : dateZhCN));
</script>

<template>
  <n-config-provider :theme="theme" :theme-overrides="overrides" :locale="nLocale" :date-locale="nDateLocale" style="height: 100%">
    <n-global-style />
    <n-message-provider>
      <n-dialog-provider>
        <exit-guard />
        <div v-if="unauthorized" class="center">
          <n-result status="403" :title="t('app.unauthorized')" :description="t('app.unauthorizedHint')" />
        </div>
        <div v-else-if="loadError" class="center">
          <n-result status="error" :title="t('app.loadFailed')" :description="loadError" />
        </div>
        <div v-else-if="!settings.loaded" class="center"><n-spin /></div>
        <router-view v-else :key="$route.path" />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<style scoped>
.center {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
