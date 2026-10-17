<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { useDialog, useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { desktop } from '../lib/desktop';
import { api, errorMessage } from '../lib/api';
import { approveExit, prepareExit } from '../lib/exitGuards';

const dialog = useDialog();
const message = useMessage();
const { t } = useI18n();
let checking = false;
const off = desktop?.onCloseRequested(async () => {
  if (checking) return;
  checking = true;
  try {
    if (!(await prepareExit())) return;
    if ((await api.shutdownStatus()).runningAi) {
      const stop = await new Promise<boolean>(resolve => dialog.warning({
        title: t('improve.shutdownAi'), content: t('improve.shutdownAiBody'),
        positiveText: t('improve.stopClose'), negativeText: t('improve.cancelExit'), maskClosable: false,
        onPositiveClick: () => resolve(true), onNegativeClick: () => resolve(false), onClose: () => resolve(false), onEsc: () => resolve(false),
      }));
      if (!stop) return;
    }
    await api.stopAllAi();
    approveExit();
    desktop?.confirmClose();
  } catch (e) { message.error(errorMessage(e)); }
  finally { checking = false; }
});
onBeforeUnmount(() => off?.());
</script>
<template><span style="display: none" /></template>
