<script setup lang="ts">
import { ref, watch } from 'vue';
import { NSelect } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import type { LibraryKind } from '@taskweave/shared';
import { api } from '../lib/api';
const props = defineProps<{ value?: string; kind: LibraryKind; root?: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:value': [string] }>();
const { t } = useI18n();
const folders = ref<{ path: string; name: string }[]>([]), loading = ref(false);
let revision = 0;
watch(() => [props.kind, props.root], async () => {
  const version = ++revision; loading.value = true;
  try { const result = await api.libraryFolders({ kind: props.kind, root: props.root, recursive: true }); if (version === revision) folders.value = result.folders; }
  catch { if (version === revision) folders.value = []; }
  finally { if (version === revision) loading.value = false; }
}, { immediate: true });
</script>
<template><n-select :value="value ?? ''" :disabled="disabled" :loading="loading" filterable :options="[{ label: t('library.root'), value: '' }, ...folders.map(folder => ({ label: folder.path, value: folder.path }))]" @update:value="value => emit('update:value', value)" /></template>
