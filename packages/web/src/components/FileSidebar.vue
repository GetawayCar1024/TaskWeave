<script setup lang="ts">
import { computed, h, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NButtonGroup, NDropdown, NTag, NTooltip, NTree, type DropdownOption, type TreeOption } from 'naive-ui';
import {
  ROLE_ORDER,
  SOLUTION_TAGS,
  STD_PREFIX,
  isSourceFile,
  type FileNode,
  type FileRole,
  type PatchProblemRequest,
  type SolutionTag,
} from '@polyforge/shared';
import { SHARED_TAB, type Workspace } from '../lib/workspace';
import { tagType } from '../lib/tags';

export type SidebarAction =
  | { kind: 'newFile'; dir: string }
  | { kind: 'newDir'; dir: string }
  | { kind: 'rename'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'copyPath'; path: string }
  | { kind: 'copyStd'; ref: string }
  | { kind: 'patch'; req: PatchProblemRequest };

const props = defineProps<{ ws: Workspace }>();
const emit = defineEmits<{ action: [SidebarAction] }>();
const { t } = useI18n();

const mode = ref<'roles' | 'dirs'>((localStorage.getItem('polyforge-tree-mode') as 'roles' | 'dirs') || 'roles');
watch(mode, (m) => localStorage.setItem('polyforge-tree-mode', m));

const ROLE_ICON: Record<FileRole, string> = {
  config: '⚙️',
  statement: '📄',
  validator: '✅',
  checker: '⚖️',
  interactor: '🔁',
  generator: '🧩',
  solution: '💡',
  test: '🧪',
  'validator-test': '🧫',
  'checker-test': '🧫',
  resource: '📦',
  other: '📁',
};

/** Where "new file" in a role group puts the file by default. */
const ROLE_DIR: Record<FileRole, string> = {
  config: '',
  statement: 'statement/zh/',
  validator: '',
  checker: '',
  interactor: '',
  generator: 'generators/',
  solution: 'solutions/',
  test: 'tests/manual/',
  'validator-test': 'validator-tests/',
  'checker-test': 'checker-tests/',
  resource: 'files/',
  other: '',
};

const STRIP: Partial<Record<FileRole, string>> = {
  statement: 'statement/',
  generator: 'generators/',
  solution: 'solutions/',
  test: 'tests/',
  'validator-test': 'validator-tests/',
  'checker-test': 'checker-tests/',
  resource: 'files/',
};

interface Node extends TreeOption {
  key: string;
  path?: string;
  dir?: string;
  group?: FileRole;
  role?: FileRole;
  children?: Node[];
}

const config = computed(() => props.ws.state.detail?.config ?? null);
const tagOf = (path: string) => config.value?.solutions.find((s) => s.source === path)?.tag;

const roleTree = computed<Node[]>(() => {
  const groups = new Map<FileRole, Node[]>();
  for (const f of props.ws.files.value) {
    const role = props.ws.roleOf(f.path);
    const strip = STRIP[role];
    const label = strip && f.path.startsWith(strip) ? f.path.slice(strip.length) : f.path;
    if (!groups.has(role)) groups.set(role, []);
    groups.get(role)!.push({ key: f.path, label, path: f.path, role, isLeaf: true });
  }
  // A std checker lives in the global shared dir; show it as a virtual entry.
  const chk = config.value?.checker?.source;
  if (chk?.startsWith(STD_PREFIX)) {
    const path = `${SHARED_TAB}checkers/${chk.slice(STD_PREFIX.length)}.cpp`;
    if (!groups.has('checker')) groups.set('checker', []);
    groups.get('checker')!.unshift({ key: path, label: chk, path, role: 'checker', isLeaf: true });
  }
  const out: Node[] = [];
  const cfg = groups.get('config');
  if (cfg) out.push(...cfg.map((n) => ({ ...n, label: 'problem.toml' })));
  for (const role of ROLE_ORDER) {
    if (role === 'config') continue;
    const children = groups.get(role);
    const always = ['statement', 'validator', 'checker', 'generator', 'solution', 'test'].includes(role);
    if (!children && !always) continue;
    if (role === 'interactor' && !children && !props.ws.state.detail?.summary.interactive) continue;
    out.push({ key: `group:${role}`, label: t(`roles.${role}`), group: role, children: children ?? [], isLeaf: false });
  }
  return out;
});

function toDirNodes(nodes: FileNode[]): Node[] {
  return nodes.map((n) =>
    n.type === 'dir'
      ? { key: `dir:${n.path}`, label: n.name, dir: n.path, children: toDirNodes(n.children ?? []), isLeaf: false }
      : { key: n.path, label: n.name, path: n.path, role: props.ws.roleOf(n.path), isLeaf: true },
  );
}
const dirTree = computed<Node[]>(() => toDirNodes(props.ws.state.detail?.tree ?? []));

const expanded = ref<string[]>(JSON.parse(localStorage.getItem('polyforge-tree-expanded') ?? 'null') ?? [
  'group:statement',
  'group:validator',
  'group:checker',
  'group:interactor',
  'group:generator',
  'group:solution',
]);
watch(expanded, (v) => localStorage.setItem('polyforge-tree-expanded', JSON.stringify(v)));

const selected = computed(() => (props.ws.state.active ? [props.ws.state.active] : []));

function renderLabel({ option }: { option: TreeOption }) {
  const n = option as Node;
  if (n.group) return h('span', { class: 'group' }, [`${ROLE_ICON[n.group]} `, n.label as string]);
  const tab = n.path ? props.ws.state.tabs.find((x) => x.path === n.path) : undefined;
  const cls = ['file', tab?.dirty ? 'dirty' : ''].join(' ');
  if (mode.value === 'dirs' && n.dir !== undefined) return h('span', `📁 ${n.label}`);
  return h('span', { class: cls, title: n.path }, n.label as string);
}

function renderSuffix({ option }: { option: TreeOption }) {
  const n = option as Node;
  if (n.group) return h('span', { class: 'count' }, String(n.children?.length ?? 0));
  if (n.role === 'solution' && n.path) {
    const tag = tagOf(n.path);
    if (tag) return h(NTag, { size: 'tiny', type: tagType(tag), bordered: false }, () => tag);
  }
  return null;
}

// ---- context menu ----
const menu = ref({ show: false, x: 0, y: 0, node: null as Node | null });

function nodeProps({ option }: { option: TreeOption }) {
  const n = option as Node;
  return {
    onClick() {
      if (n.path) props.ws.openFile(n.path);
    },
    onContextmenu(e: MouseEvent) {
      e.preventDefault();
      menu.value.show = false;
      nextTick(() => (menu.value = { show: true, x: e.clientX, y: e.clientY, node: n }));
    },
  };
}

const menuOptions = computed<DropdownOption[]>(() => {
  const n = menu.value.node;
  if (!n) return [];
  if (n.group || n.dir !== undefined) {
    const dir = n.group ? ROLE_DIR[n.group] : `${n.dir}/`;
    return [
      { key: 'newFile', label: t('tree.newFile') },
      { key: 'newDir', label: t('tree.newDir') },
      ...(n.dir !== undefined
        ? [{ type: 'divider', key: 'd0' }, { key: 'rename', label: t('tree.rename') }, { key: 'delete', label: t('tree.delete') }]
        : []),
    ].map((o) => ({ ...o, dir }));
  }
  const path = n.path!;
  if (path.startsWith(SHARED_TAB)) {
    return [{ key: 'copyStd', label: t('tree.copyStd') }];
  }
  const cfg = config.value;
  const opts: DropdownOption[] = [
    { key: 'open', label: t('tree.open') },
    { key: 'rename', label: t('tree.rename') },
    { key: 'delete', label: t('tree.delete') },
    { key: 'copyPath', label: t('tree.copyPath') },
  ];
  if (cfg && isSourceFile(path)) {
    opts.push({ type: 'divider', key: 'd1' });
    const tag = tagOf(path);
    const tagChildren = SOLUTION_TAGS.map((tg) => ({ key: `tag:${tg}`, label: tg, disabled: tg === tag }));
    if (tag) {
      opts.push({ key: 'tagMenu', label: t('tree.changeTag'), children: tagChildren });
      opts.push({ key: 'unsolution', label: t('tree.removeSolution') });
    } else {
      opts.push({ key: 'tagMenu', label: t('tree.addSolution'), children: tagChildren });
    }
    const set = (key: 'validator' | 'checker' | 'interactor') => {
      if (cfg[key]?.source === path) opts.push({ key: `unset:${key}`, label: t('tree.unset', { role: t(`roles.${key}`) }) });
      else if (key !== 'interactor' || cfg.problem.interactive) opts.push({ key: `set:${key}`, label: t('tree.setAs', { role: t(`roles.${key}`) }) });
    };
    set('validator');
    set('checker');
    set('interactor');
    if (cfg.generators.some((g) => g.source === path)) opts.push({ key: 'ungen', label: t('tree.unregisterGen') });
    else opts.push({ key: 'gen', label: t('tree.registerGen') });
  }
  return opts;
});

function onMenu(key: string, option: DropdownOption) {
  const n = menu.value.node;
  menu.value.show = false;
  if (!n) return;
  const path = n.path ?? n.dir ?? '';
  const act = (a: SidebarAction) => emit('action', a);
  if (key === 'newFile' || key === 'newDir') return act({ kind: key, dir: (option as { dir: string }).dir });
  if (key === 'open') return props.ws.openFile(path);
  if (key === 'rename' || key === 'delete' || key === 'copyPath') return act({ kind: key, path });
  if (key === 'copyStd') return act({ kind: 'copyStd', ref: config.value?.checker?.source ?? '' });
  if (key.startsWith('tag:')) return act({ kind: 'patch', req: { solution: { source: path, tag: key.slice(4) as SolutionTag } } });
  if (key === 'unsolution') return act({ kind: 'patch', req: { solution: { source: path, tag: null } } });
  if (key.startsWith('set:')) return act({ kind: 'patch', req: { [key.slice(4)]: path } });
  if (key.startsWith('unset:')) return act({ kind: 'patch', req: { [key.slice(6)]: null } });
  if (key === 'gen' || key === 'ungen') return act({ kind: 'patch', req: { generator: { source: path, enabled: key === 'gen' } } });
}
</script>

<template>
  <div class="sidebar">
    <div class="toolbar">
      <n-button-group size="tiny">
        <n-button :type="mode === 'roles' ? 'primary' : 'default'" @click="mode = 'roles'">{{ t('tree.byRole') }}</n-button>
        <n-button :type="mode === 'dirs' ? 'primary' : 'default'" @click="mode = 'dirs'">{{ t('tree.byDir') }}</n-button>
      </n-button-group>
      <span class="spacer" />
      <n-tooltip>
        <template #trigger>
          <n-button size="tiny" quaternary @click="emit('action', { kind: 'newFile', dir: '' })">＋📄</n-button>
        </template>
        {{ t('tree.newFile') }}
      </n-tooltip>
      <n-tooltip>
        <template #trigger>
          <n-button size="tiny" quaternary @click="emit('action', { kind: 'newDir', dir: '' })">＋📁</n-button>
        </template>
        {{ t('tree.newDir') }}
      </n-tooltip>
    </div>
    <div class="tree">
      <n-tree
        block-line
        :data="mode === 'roles' ? roleTree : dirTree"
        v-model:expanded-keys="expanded"
        :selected-keys="selected"
        :render-label="renderLabel"
        :render-suffix="renderSuffix"
        :node-props="nodeProps"
        :animated="false"
        virtual-scroll
        style="height: 100%"
      />
    </div>
    <n-dropdown
      trigger="manual"
      placement="bottom-start"
      :show="menu.show"
      :x="menu.x"
      :y="menu.y"
      :options="menuOptions"
      @select="onMenu"
      @clickoutside="menu.show = false"
    />
  </div>
</template>

<style scoped>
.sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);
}
.spacer {
  flex: 1;
}
.tree {
  flex: 1;
  min-height: 0;
  padding: 4px 0;
  font-size: 13px;
}
.tree :deep(.group) {
  font-weight: 600;
}
.tree :deep(.file.dirty)::after {
  content: ' ●';
  opacity: 0.7;
}
.tree :deep(.count) {
  font-size: 11px;
  opacity: 0.5;
  padding-right: 6px;
}
</style>
