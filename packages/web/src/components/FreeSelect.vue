<script setup lang="ts">
import { computed, ref } from 'vue';
import { NSelect, type SelectOption } from 'naive-ui';
defineOptions({ inheritAttrs: false });
const props = defineProps<{ value?: string | number | (string | number)[] | null; options?: SelectOption[]; multiple?: boolean }>();
const emit = defineEmits<{ 'update:value': [any]; blur: [FocusEvent]; draft: [boolean] }>();
const pending = ref('');
const options = computed(() => {
  const result = [...(props.options ?? [])];
  const values = Array.isArray(props.value) ? props.value : props.value == null ? [] : [props.value];
  for (const value of values) if (!result.some(option => option.value === value)) result.push({ value, label: String(value) });
  return result;
});
function selected(value: unknown) { pending.value = ''; emit('draft', false); emit('update:value', value); }
function search(text: string) { pending.value = text; emit('draft', !!text.trim()); }
function commit() {
  const text = pending.value.trim(); pending.value = '';
  emit('draft', false);
  if (text) emit('update:value', props.multiple ? [...new Set([...(Array.isArray(props.value) ? props.value : []), text])] : text);
}
function blurred(event: FocusEvent) { commit(); emit('blur', event); }
defineExpose({ commit });
</script>
<template>
  <n-select v-bind="$attrs" :value="value" :multiple="multiple" :options="options" filterable tag @search="search" @update:value="selected" @blur="blurred" />
</template>
