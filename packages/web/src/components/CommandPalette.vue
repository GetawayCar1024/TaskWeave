<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NCard, NInput, NModal } from 'naive-ui';

export interface Command {
  id: string;
  label: string;
  /** Shown on the right, e.g. "Ctrl+Shift+G". */
  shortcut?: string;
  group?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

/** Ctrl+K command palette (DESIGN §6.2). */
const props = defineProps<{ show: boolean; commands: Command[] }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
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

/** Subsequence match over label + group; earlier and tighter matches first. */
function score(c: Command, q: string): number {
  const hay = `${c.label} ${c.group ?? ''} ${c.id}`.toLowerCase();
  if (hay.includes(q)) return hay.indexOf(q);
  let pos = 0;
  let gaps = 0;
  for (const ch of q) {
    const i = hay.indexOf(ch, pos);
    if (i < 0) return -1;
    gaps += i - pos;
    pos = i + 1;
  }
  return 100 + gaps;
}

const results = computed(() => {
  const q = query.value.trim().toLowerCase();
  const list = props.commands.filter((c) => !c.disabled);
  if (!q) return list;
  return list
    .map((c) => ({ c, s: score(c, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.c);
});
watch(results, () => (index.value = 0));

// Run after the palette has fully closed: opening a drawer while the modal is still
// leaving (and restoring focus) closes the drawer again.
let pending: Command | null = null;
function choose(c: Command) {
  pending = c;
  emit('update:show', false);
}
async function afterLeave() {
  const c = pending;
  pending = null;
  if (c) await c.run();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    index.value = Math.min(index.value + 1, results.value.length - 1);
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    index.value = Math.max(index.value - 1, 0);
    e.preventDefault();
  } else if (e.key === 'Enter') {
    // Otherwise the Enter reaches the editor once focus returns to it.
    e.preventDefault();
    const c = results.value[index.value];
    if (c) choose(c);
  }
}
</script>

<template>
  <n-modal :show="show" @update:show="emit('update:show', $event)" @after-leave="afterLeave">
    <n-card size="small" class="palette" :bordered="false">
      <n-input ref="input" v-model:value="query" :placeholder="t('palette.placeholder')" @keydown="onKey" />
      <div class="list">
        <div
          v-for="(c, i) in results"
          :key="c.id"
          class="item"
          :class="{ sel: i === index }"
          @click="choose(c)"
          @mousemove="index = i"
        >
          <span class="label">{{ c.label }}</span>
          <span v-if="c.group" class="group">{{ c.group }}</span>
          <kbd v-if="c.shortcut" class="pf-kbd">{{ c.shortcut }}</kbd>
        </div>
        <div v-if="!results.length" class="pf-empty">{{ t('palette.none') }}</div>
      </div>
    </n-card>
  </n-modal>
</template>

<style scoped>
.palette {
  width: min(600px, 94vw);
  align-self: flex-start;
  margin-top: 10vh;
}
.list {
  max-height: 55vh;
  overflow: auto;
  margin-top: 6px;
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.item.sel {
  background: var(--pf-selected);
}
.label {
  flex: 1;
}
.group {
  font-size: 12px;
  color: var(--pf-text-secondary);
}
</style>
