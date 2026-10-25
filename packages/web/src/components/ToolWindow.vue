<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NModal, NProgress, NTag } from 'naive-ui';
import type { JobInfo } from '@polyforge/shared';
import { serverText } from '../lib/serverText';

/**
 * The common frame of every dialog and tool window (forms, sync, batch judging,
 * stress, lint …): a card with title + job status + actions in the header, an
 * optional progress line, an optional error, the body and a footer with secondary
 * content left and the buttons right (secondary buttons left of the primary one).
 *
 * Closing the window never stops its job: it keeps running and the window shows it
 * again when reopened.
 */
const props = withDefaults(
  defineProps<{
    show: boolean;
    title: string;
    /** Width tier: sm (short forms), md (forms), lg (tools), xl (side-by-side tools), full (diffs). */
    size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
    /** Overrides the size tier. */
    width?: string;
    status?: JobInfo['status'] | null;
    progress?: JobInfo['progress'] | null;
    /** Shown above the body (server texts are translated). */
    error?: string | null;
    /** The body takes a fixed share of the window height (content scrolls inside). */
    fill?: boolean;
  }>(),
  { size: 'lg', width: undefined, status: null, progress: null, error: null },
);
const emit = defineEmits<{ 'update:show': [boolean] }>();
const { t } = useI18n();

const WIDTHS = { sm: 'min(460px, 94vw)', md: 'min(600px, 94vw)', lg: 'min(960px, 94vw)', xl: 'min(1200px, 96vw)', full: '92vw' } as const;
const running = computed(() => props.status === 'running');
const pct = computed(() => (props.progress?.total ? Math.round((props.progress.done / props.progress.total) * 100) : 0));
const STATUS_TYPE = { running: 'info', done: 'success', failed: 'error', cancelled: 'warning' } as const;
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    class="pf-tool-window"
    :style="{ width: width ?? WIDTHS[size] }"
    :segmented="{ content: true, footer: 'soft' }"
    :content-style="{ padding: '0' }"
    @update:show="emit('update:show', $event)"
  >
    <template #header>
      <div class="tw-head">
        <span class="tw-title">{{ title }}</span>
        <n-tag v-if="status" size="small" round :bordered="false" :type="STATUS_TYPE[status]">
          <span v-if="running" class="pf-run-dot" />{{ t(`tool.status.${status}`) }}
        </n-tag>
        <slot name="header" />
      </div>
    </template>
    <template #header-extra>
      <div class="tw-actions"><slot name="actions" /></div>
    </template>
    <div class="tw-main" :class="{ fill }">
      <div v-if="running" class="tw-progress">
        <n-progress type="line" :percentage="pct" :height="4" :show-indicator="false" :processing="true" />
        <div class="tw-progress-text">
          <span>{{ serverText(progress?.message) }}<template v-if="progress?.total"> · {{ progress.done }}/{{ progress.total }}</template></span>
          <span class="tw-bg">{{ t('tool.background') }}</span>
        </div>
      </div>
      <div class="tw-body">
        <n-alert v-if="error" type="error" :show-icon="false" class="tw-error"><pre class="tw-error-text">{{ serverText(error) }}</pre></n-alert>
        <slot />
      </div>
    </div>
    <template v-if="$slots.footer || $slots['footer-left']" #footer>
      <div class="tw-foot">
        <div class="tw-foot-left"><slot name="footer-left" /></div>
        <div class="tw-foot-right"><slot name="footer" /></div>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.tw-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.tw-title {
  font-weight: 600;
  white-space: nowrap;
}
.tw-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 8px;
}
.tw-main {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.tw-main.fill {
  height: min(74vh, 900px);
}
.tw-progress {
  padding: 8px 20px 6px;
  border-bottom: 1px solid var(--pf-border);
  flex-shrink: 0;
}
.tw-progress-text {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--pf-text-secondary);
}
.tw-bg {
  opacity: 0.8;
}
.tw-body {
  padding: 14px 20px;
  min-height: 0;
  max-height: min(74vh, 900px);
  overflow: auto;
}
.tw-error {
  margin-bottom: 10px;
  flex-shrink: 0;
}
.tw-error-text {
  margin: 0;
  font: inherit;
  font-size: 12px;
  white-space: pre-wrap;
  max-height: 30vh;
  overflow: auto;
}
.fill .tw-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tw-foot {
  display: flex;
  align-items: center;
  gap: 12px;
}
.tw-foot-left {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--pf-text-secondary);
}
.tw-foot-right {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
