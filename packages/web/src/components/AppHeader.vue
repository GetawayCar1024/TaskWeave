<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { NButton, NButtonGroup, NTooltip } from 'naive-ui';
import { settings, patchSettings } from '../lib/settings';
import { wsConnected } from '../lib/ws';

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
  height: 44px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.25);
  flex-shrink: 0;
}
.left,
.right {
  display: flex;
  align-items: center;
  gap: 8px;
}
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
