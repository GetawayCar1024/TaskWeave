<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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

const { t, locale } = useI18n();
const unauthorized = ref(false);
const loadError = ref('');

onUnauthorized(() => (unauthorized.value = true));

/**
 * "Fullscreen on open": a page may only enter fullscreen from a user gesture, so do it on
 * the first click / key press after opening (once per page load).
 */
function firstGesture() {
  window.removeEventListener('pointerdown', firstGesture, true);
  window.removeEventListener('keydown', firstGesture, true);
  if (settings.config?.ui.fullscreen === false || document.fullscreenElement) return;
  document.documentElement.requestFullscreen?.().catch(() => {});
}
window.addEventListener('pointerdown', firstGesture, true);
window.addEventListener('keydown', firstGesture, true);

onMounted(async () => {
  try {
    await loadSettings();
    startWs();
    // Right away where the browser allows it; otherwise the first gesture does it.
    if (settings.config?.ui.fullscreen !== false && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  } catch (e) {
    if (!unauthorized.value) loadError.value = errorMessage(e);
  }
});

const dark = computed(() => settings.config?.ui.theme !== 'light');
const theme = computed(() => (dark.value ? darkTheme : null));
const nLocale = computed(() => (locale.value === 'en' ? enUS : zhCN));
const nDateLocale = computed(() => (locale.value === 'en' ? dateEnUS : dateZhCN));
</script>

<template>
  <n-config-provider :theme="theme" :locale="nLocale" :date-locale="nDateLocale" style="height: 100%">
    <n-global-style />
    <n-message-provider>
      <n-dialog-provider>
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
