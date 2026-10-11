<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { NButton, NButtonGroup, NTooltip } from 'naive-ui';
import { settings, patchSettings } from '../lib/settings';
import { wsConnected } from '../lib/ws';
import { Sun, Moon } from 'lucide-vue-next';

const { t } = useI18n();

function switchLocale(l: 'zh-CN' | 'en') {
  if (settings.config?.ui.locale !== l) patchSettings((c) => (c.ui.locale = l));
}
</script>

<template>
  <header class="header">
    <div class="left"><slot name="left" /></div>
    <div class="center"><slot /></div>
    <div class="right">
      <slot name="right" />
      <n-button quaternary size="small" :aria-label="t('palette.toggleTheme')" :title="t('palette.toggleTheme')" @click="patchSettings(c => c.ui.theme = c.ui.theme === 'light' ? 'dark' : 'light')">
        <template #icon><sun v-if="settings.config?.ui.theme !== 'light'" /><moon v-else /></template>
      </n-button>
      <n-tooltip>
        <template #trigger>
          <span class="dot" :class="{ on: wsConnected }" />
        </template>
        {{ wsConnected ? t('app.connected') : t('app.disconnected') }}
      </n-tooltip>
      <n-button-group size="tiny">
        <n-button :type="settings.config?.ui.locale === 'zh-CN' ? 'primary' : 'default'" @click="switchLocale('zh-CN')">中</n-button>
        <n-button :type="settings.config?.ui.locale === 'en' ? 'primary' : 'default'" @click="switchLocale('en')">EN</n-button>
      </n-button-group>
    </div>
  </header>
</template>

<style scoped>
.header {
  min-height: 52px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--pf-border);
  background: var(--pf-toolbar-bg);
  backdrop-filter: blur(18px);
  flex-shrink: 0;
}
.left,
.right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.right { flex-wrap: wrap; justify-content: flex-end; }
.center {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d03050;
  display: inline-block;
}
.dot.on {
  background: #18a058;
}
</style>
