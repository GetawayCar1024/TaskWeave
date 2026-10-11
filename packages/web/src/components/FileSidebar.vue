<script setup lang="ts">
import { computed, h, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NButtonGroup, NDropdown, NTag, NTooltip, NTree, type DropdownOption, type TreeOption } from 'naive-ui';
import {
  ROLE_ORDER,
  SOLUTION_TAGS,
  STATEMENT_SECTIONS,
  STD_PREFIX,
  isSourceFile,
  statementLanguages,
  type FileNode,
  type FileRole,
  type PatchProblemRequest,
  type SolutionTag,
} from '@polyforge/shared';
import { SHARED_TAB, type Workspace } from '../lib/workspace';
import { tagType } from '../lib/tags';
import { FilePlus, Folder, FolderPlus, Image, Languages, Plus } from 'lucide-vue-next';
import { ROLE_ICONS } from '../lib/icons';

export type SidebarAction =
  | { kind: 'newFile'; dir: string }
  | { kind: 'newDir'; dir: string }
  | { kind: 'rename'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'copyPath'; path: string }
  | { kind: 'copyStd'; ref: string }
  | { kind: 'patch'; req: PatchProblemRequest }
  | { kind: 'createTutorials'; langs: string[] };

const props = defineProps<{ ws: Workspace }>();
const emit = defineEmits<{ action: [SidebarAction] }>();
const { t } = useI18n();

const mode = ref<'roles' | 'dirs'>((localStorage.getItem('polyforge-tree-mode') as 'roles' | 'dirs') || 'roles');
watch(mode, (m) => localStorage.setItem('polyforge-tree-mode', m));


/** Where "new file" in a role group puts the file by default. */
const ROLE_DIR: Record<FileRole, string> = {
  config: '',
  statement: 'statement/zh/',
  tutorial: 'statement/',
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
  tutorial: 'statement/',
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
  /** Virtual entry: a statement language that has no tutorial yet. */
  missingLang?: string;
  /** Tutorial in a language without a statement. */
  orphan?: boolean;
  /** Sub-group of the statement files of one language (or "images"). */
  langGroup?: string;
  group?: FileRole;
  role?: FileRole;
  children?: Node[];
}

const config = computed(() => props.ws.state.detail?.config ?? null);
const tagOf = (path: string) => config.value?.solutions.find((s) => s.source === path)?.tag;

const roleTree = computed<Node[]>(() => {
  const groups = new Map<FileRole, Node[]>();
  if (!props.ws.files.value.some(f => f.path === 'files/defs.toml')) {
    const path = `${SHARED_TAB}defs.toml`;
    groups.set('resource', [{key: path, label: 'defs.toml (shared)', path, role: 'resource', isLeaf: true}]);
  }
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
  // Tutorials follow the statement languages: one per language, created on demand.
  const langs = statementLanguages(props.ws.files.value);
  const tut = groups.get('tutorial') ?? [];
  for (const n of tut) n.orphan = langs.orphanTutorial.includes(n.path!.split('/')[1]);
  for (const lang of langs.statement) {
    if (!tut.some((n) => n.path === `statement/${lang}/tutorial.tex`)) {
      tut.push({ key: `missing-tutorial:${lang}`, label: t('tree.missingTutorial', { lang }), missingLang: lang, isLeaf: true });
    }
  }
  // Label tutorials by language, Chinese first, like the statement languages.
  const tutLang = (n: Node) => n.missingLang ?? n.path!.split('/')[1];
  for (const n of tut) if (!n.missingLang) n.label = LANG_NAMES[tutLang(n)] ? `${LANG_NAMES[tutLang(n)]} (${tutLang(n)})` : `${tutLang(n)}/tutorial.tex`;
  const rank = (l: string) => (l === 'zh' ? 0 : l === 'en' ? 1 : 2);
  tut.sort((a, b) => rank(tutLang(a)) - rank(tutLang(b)) || tutLang(a).localeCompare(tutLang(b)));
  if (tut.length) groups.set('tutorial', tut);

  // Statement files by language (zh, en, …), sections in statement order; images apart.
  const stmt = groups.get('statement');
  if (stmt) {
    const byLang = new Map<string, Node[]>();
    for (const n of stmt) {
      const m = n.path!.match(/^statement\/([^/]+)\/(.+)$/);
      const lang = m ? m[1] : '';
      if (!byLang.has(lang)) byLang.set(lang, []);
      byLang.get(lang)!.push({ ...n, label: m ? m[2] : n.label });
    }
    const order = (p: string) => {
      const i = (STATEMENT_SECTIONS as readonly string[]).indexOf(p.replace(/\.tex$/, ''));
      return i < 0 ? 99 : i;
    };
    const langRank = (l: string) => (l === 'images' ? 2 : l === '' ? 3 : l === 'zh' ? 0 : l === 'en' ? 0.5 : 1);
    groups.set(
      'statement',
      [...byLang]
        .sort(([a], [b]) => langRank(a) - langRank(b) || a.localeCompare(b))
        .map(([lang, nodes]) =>
          lang === ''
            ? nodes
            : [
                {
                  key: `lang:${lang}`,
                  label: lang === 'images' ? t('tree.images') : LANG_NAMES[lang] ? `${LANG_NAMES[lang]} (${lang})` : lang,
                  langGroup: lang,
                  dir: `statement/${lang}`,
                  children: nodes.sort((a, b) => order(String(a.label)) - order(String(b.label)) || String(a.label).localeCompare(String(b.label))),
                  isLeaf: false,
                },
              ],
        )
        .flat(),
    );
  }

  const out: Node[] = [];
  const cfg = groups.get('config');
  if (cfg) out.push(...cfg.map((n) => ({ ...n, label: 'problem.toml' })));
  for (const role of ROLE_ORDER) {
    if (role === 'config') continue;
    const children = groups.get(role);
    const always = ['statement', 'tutorial', 'validator', 'checker', 'generator', 'solution', 'test'].includes(role);
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

const LANG_NAMES: Record<string, string> = { zh: '中文', en: 'English', ru: 'Русский' };
const countLeaves = (n: Node): number => (n.children ?? []).reduce((a, c) => a + (c.isLeaf ? 1 : countLeaves(c)), 0);

const expanded = ref<string[]>(JSON.parse(localStorage.getItem('polyforge-tree-expanded') ?? 'null') ?? [
  'group:statement',
  'group:tutorial',
  'group:validator',
  'group:checker',
  'group:interactor',
  'group:generator',
  'group:solution',
]);
watch(expanded, (v) => localStorage.setItem('polyforge-tree-expanded', JSON.stringify(v)));
const seenLangKeys = new Set<string>(JSON.parse(localStorage.getItem('polyforge-tree-seen-langs') ?? '[]'));
watch(
  roleTree,
  (tree) => {
    const keys = (tree.find((n) => n.key === 'group:statement')?.children ?? []).filter((n) => n.langGroup).map((n) => n.key);
    const fresh = keys.filter((k) => !seenLangKeys.has(k));
    if (!fresh.length) return;
    fresh.forEach((k) => seenLangKeys.add(k));
    localStorage.setItem('polyforge-tree-seen-langs', JSON.stringify([...seenLangKeys]));
    expanded.value = [...new Set([...expanded.value, ...fresh])];
  },
  { immediate: true },
);

const selected = computed(() => (props.ws.state.active ? [props.ws.state.active] : []));

const BADGES: [RegExp, string, string][] = [
  [/\.(cpp|cc|cxx|c|h|hpp)$/i, 'C++', 'b-cpp'],
  [/\.py$/i, 'PY', 'b-py'],
  [/\.(java|kt)$/i, 'JV', 'b-java'],
  [/\.tex$/i, 'TEX', 'b-tex'],
  [/\.toml$/i, 'CFG', 'b-cfg'],
  [/\.(png|jpe?g|gif|svg)$/i, 'IMG', 'b-img'],
  [/\.(txt|md)$/i, 'TXT', 'b-txt'],
];
function badge(path: string) {
  const b = BADGES.find(([re]) => re.test(path));
  return h('span', { class: ['badge', b ? b[2] : 'b-data'] }, b ? b[1] : 'DAT');
}

function renderLabel({ option }: { option: TreeOption }) {
  const n = option as Node;
  if (n.langGroup) return h('span', { class: 'group-dir' }, [h(n.langGroup === 'images' ? Image : Languages, { size: 13, class: 'gi' }), n.label as string]);
  if (n.group) return h('span', { class: 'group' }, [h(ROLE_ICONS[n.group], { size: 14, class: 'gi' }), n.label as string]);
  const tab = n.path ? props.ws.state.tabs.find((x) => x.path === n.path) : undefined;
  const cls = ['file', tab?.dirty ? 'dirty' : ''].join(' ');
  if (mode.value === 'dirs' && n.dir !== undefined) return h('span', { class: 'group-dir' }, [h(Folder, { size: 14, class: 'gi' }), n.label as string]);
  if (n.missingLang) return h('span', { class: 'missing' }, [h(Plus, { size: 12, class: 'gi' }), n.label as string]);
  return h('span', { class: cls, title: n.path }, [badge(n.path ?? ''), n.label as string]);
}

function renderSuffix({ option }: { option: TreeOption }) {
  const n = option as Node;
  if (n.group || n.langGroup) return h('span', { class: 'count' }, String(n.group === 'statement' ? countLeaves(n) : n.children?.length ?? 0));
  if (n.orphan) return h(NTag, { size: 'tiny', type: 'warning', bordered: false, title: t('tree.orphanTutorial') }, () => '!');
  if (n.role === 'tutorial' && n.path && !props.ws.files.value.find((f) => f.path === n.path)?.size) {
    return h('span', { class: 'count' }, t('tree.empty'));
  }
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
      if (n.missingLang) emit('action', { kind: 'createTutorials', langs: [n.missingLang] });
      else if (n.path) props.ws.openFile(n.path);
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
  if (n.group === 'tutorial') {
    const missing = statementLanguages(props.ws.files.value).missingTutorial;
    return [{ key: 'createTutorials', label: t('tree.createTutorials'), disabled: !missing.length }];
  }
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
  if (key === 'createTutorials') return act({ kind: 'createTutorials', langs: statementLanguages(props.ws.files.value).missingTutorial });
  if (key === 'newFile' || key === 'newDir') return act({ kind: key, dir: (option as { dir: string }).dir });
  if (key === 'open') return props.ws.openFile(path);
  if (key === 'rename' || key === 'delete' || key === 'copyPath') return act({ kind: key, path });
  if (key === 'copyStd') return act({ kind: 'copyStd', ref: path.slice(SHARED_TAB.length) });
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
          <n-button size="tiny" quaternary @click="emit('action', { kind: 'newFile', dir: '' })"><file-plus :size="15" /></n-button>
        </template>
        {{ t('tree.newFile') }}
      </n-tooltip>
      <n-tooltip>
        <template #trigger>
          <n-button size="tiny" quaternary @click="emit('action', { kind: 'newDir', dir: '' })"><folder-plus :size="15" /></n-button>
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
  background: var(--pf-toolbar-bg);
  border-right: 1px solid var(--pf-border);
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
  padding: 8px 4px;
  font-size: 13px;
}
.tree :deep(.group) {
  font-weight: 600;
}
.tree :deep(.group),
.tree :deep(.group-dir),
.tree :deep(.missing) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tree :deep(.gi) {
  opacity: 0.75;
  flex-shrink: 0;
}
.tree :deep(.file.dirty)::after {
  content: ' ●';
  opacity: 0.7;
}
.tree :deep(.badge) {
  display: inline-block;
  min-width: 28px;
  margin-right: 6px;
  padding: 0 3px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 600;
  text-align: center;
  line-height: 14px;
  opacity: 0.85;
  font-family: Consolas, monospace;
}
.tree :deep(.b-cpp) {
  background: rgba(80, 140, 230, 0.25);
  color: var(--pf-accent);
}
.tree :deep(.b-py) {
  background: rgba(230, 200, 60, 0.22);
  color: light-dark(#846400, #e8cc60);
}
.tree :deep(.b-java) {
  background: rgba(230, 120, 60, 0.22);
  color: light-dark(#a44f12, #f0a070);
}
.tree :deep(.b-tex) {
  background: rgba(80, 200, 140, 0.22);
  color: light-dark(#14734b, #63e2b7);
}
.tree :deep(.b-cfg) {
  background: rgba(170, 120, 230, 0.22);
  color: light-dark(#7743a8, #c09cf0);
}
.tree :deep(.b-img) {
  background: rgba(230, 100, 160, 0.22);
  color: light-dark(#ac326e, #f090c0);
}
.tree :deep(.b-txt),
.tree :deep(.b-data) {
  background: rgba(128, 128, 128, 0.22);
  color: inherit;
}
.tree :deep(.missing) {
  opacity: 0.55;
  font-style: italic;
}
.tree :deep(.count) {
  font-size: 11px;
  opacity: 0.5;
  padding-right: 6px;
}
</style>
