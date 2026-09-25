<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NCard, NInput, NModal } from 'naive-ui';

/** Ctrl+P: fuzzy file finder (subsequence match, shorter/earlier matches first). */
const props = defineProps<{ show: boolean; files: string[] }>();
const emit = defineEmits<{ 'update:show': [boolean]; open: [string] }>();
const { t } = useI18n();

const query = ref('');
const index = ref(0);
const input = ref<InstanceType<typeof NInput>>();

watch(
  () => props.show,
  async (s) => {
    if (!s) return;
    query.value = '';
    index.value = 0;
    await nextTick();
    input.value?.focus();
  },
);

function score(path: string, q: string): number {
  const p = path.toLowerCase();
  let pos = 0;
  let gaps = 0;
  for (const ch of q) {
    const i = p.indexOf(ch, pos);
    if (i < 0) return -1;
    gaps += i - pos;
    pos = i + 1;
  }
  const base = p.split('/').pop()!;
  return gaps + (base.includes(q) ? 0 : 50) + path.length * 0.01;
}

const results = computed(() => {
  const q = query.value.trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return props.files.slice(0, 50);
  return props.files
    .map((f) => ({ f, s: score(f, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .slice(0, 50)
    .map((x) => x.f);
});

watch(results, () => (index.value = 0));

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    index.value = Math.min(index.value + 1, results.value.length - 1);
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    index.value = Math.max(index.value - 1, 0);
    e.preventDefault();
  } else if (e.key === 'Enter') {
    const f = results.value[index.value];
    if (f) choose(f);
  }
}

function choose(f: string) {
  emit('update:show', false);
  emit('open', f);
}
</script>

<template>
  <n-modal :show="show" @update:show="emit('update:show', $event)">
    <n-card size="small" class="qo" :bordered="false">
      <n-input ref="input" v-model:value="query" :placeholder="t('editor.quickOpenHint')" @keydown="onKey" />
      <div class="list">
        <div v-for="(f, i) in results" :key="f" class="item mono" :class="{ sel: i === index }" @click="choose(f)" @mousemove="index = i">
          <span class="base">{{ f.split('/').pop() }}</span>
          <span class="dir">{{ f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '' }}</span>
        </div>
      </div>
    </n-card>
  </n-modal>
</template>

<style scoped>
.qo {
  width: 560px;
  align-self: flex-start;
  margin-top: 12vh;
}
.list {
  max-height: 50vh;
  overflow: auto;
  margin-top: 6px;
}
.item {
  padding: 4px 8px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  gap: 10px;
}
.item.sel {
  background: rgba(99, 226, 183, 0.18);
}
.dir {
  opacity: 0.5;
}
</style>
