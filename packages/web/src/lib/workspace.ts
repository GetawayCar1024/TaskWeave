import { computed, markRaw, reactive, shallowRef } from 'vue';
import {
  classifyFile,
  flattenFiles,
  type FileRole,
  type LanguagesConfig,
  type PatchProblemRequest,
  type ProblemDetail,
  type SharedListResponse,
  type WsEvent,
} from '@polyforge/shared';
import { api, ApiError } from './api';
import { attachStatementLint } from './latexEditor';
import { monaco, languageForPath } from './monaco';

/** Tabs for read-only files from the global shared/ directory use this prefix. */
export const SHARED_TAB = '@shared/';

export interface Tab {
  /** Problem-relative path, or `@shared/<path>` for shared files. */
  path: string;
  model: monaco.editor.ITextModel;
  savedVersion: number;
  savedHash: string;
  dirty: boolean;
  readOnly: boolean;
  binary?: boolean;
  truncated?: boolean;
  /** External modification state: the disk changed/vanished while we had unsaved edits. */
  disk: 'ok' | 'changed' | 'deleted';
  viewState: monaco.editor.ICodeEditorViewState | null;
}

export type SaveResult = 'ok' | 'conflict' | 'readonly';

export function useWorkspace(problemId: string) {
  const state = reactive({
    detail: null as ProblemDetail | null,
    loadError: '',
    tabs: [] as Tab[],
    active: null as string | null,
    fileOpenRevision: 0,
    contentRevision: 0,
    languages: {} as LanguagesConfig,
    shared: null as SharedListResponse | null,
  });
  const disposables: monaco.IDisposable[] = [];

  const activeTab = computed(() => state.tabs.find((t) => t.path === state.active) ?? null);
  const files = computed(() => (state.detail ? flattenFiles(state.detail.tree) : []));
  const roleOf = (path: string): FileRole => classifyFile(path, state.detail?.config ?? null);
  const hasDirty = computed(() => state.tabs.some((t) => t.dirty));

  async function loadDetail() {
    try {
      state.detail = await api.problem(problemId);
      state.loadError = '';
    } catch (e) {
      state.loadError = e instanceof Error ? e.message : String(e);
    }
  }

  let detailTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleDetail() {
    clearTimeout(detailTimer);
    detailTimer = setTimeout(loadDetail, 120);
  }

  async function init() {
    await Promise.all([
      loadDetail(),
      api.languages().then((r) => (state.languages = r.languages)).catch(() => {}),
      api.shared().then((r) => (state.shared = r)).catch(() => {}),
    ]);
  }

  const uriFor = (path: string) => monaco.Uri.from({ scheme: 'pf', path: `/${problemId}/${path}` });

  function findTab(path: string) {
    return state.tabs.find((t) => t.path === path);
  }

  async function openFile(path: string) {
    state.fileOpenRevision++;
    const existing = findTab(path);
    if (existing) {
      state.active = path;
      return;
    }
    const shared = path.startsWith(SHARED_TAB);
    const fc = shared ? await api.sharedFile(path.slice(SHARED_TAB.length)) : await api.readFile(problemId, path);
    // Another openFile for the same path may have finished while we awaited.
    if (findTab(path)) {
      state.active = path;
      return;
    }
    const uri = uriFor(path);
    monaco.editor.getModel(uri)?.dispose();
    const model = markRaw(monaco.editor.createModel(fc.content, languageForPath(path), uri));
    const tab = reactive({
      path,
      model,
      savedVersion: model.getAlternativeVersionId(),
      savedHash: fc.hash,
      dirty: false,
      readOnly: shared || path.startsWith('.polyforge/') || !!fc.binary || !!fc.truncated,
      binary: fc.binary,
      truncated: fc.truncated,
      disk: 'ok',
      viewState: null,
    }) as Tab;
    disposables.push(
      model.onDidChangeContent(() => {
        tab.dirty = model.getAlternativeVersionId() !== tab.savedVersion;
        state.contentRevision++;
      }),
    );
    const lintLang = path.match(/^statement\/([^/]+)\/[^/]+\.tex$/)?.[1];
    if (lintLang && lintLang !== 'images') disposables.push(attachStatementLint(model, lintLang));
    state.tabs.push(tab);
    state.active = path;
  }

  function closeTab(path: string) {
    const i = state.tabs.findIndex((t) => t.path === path);
    if (i < 0) return;
    const [tab] = state.tabs.splice(i, 1);
    tab.model.dispose();
    if (state.active === path) state.active = state.tabs[Math.min(i, state.tabs.length - 1)]?.path ?? null;
  }

  /** Replace the model content with disk content, keeping undo history. */
  function applyDisk(tab: Tab, content: string, hash: string) {
    if (tab.model.getValue() !== content) {
      tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: content }], () => null);
    }
    tab.savedVersion = tab.model.getAlternativeVersionId();
    tab.savedHash = hash;
    tab.dirty = false;
    tab.disk = 'ok';
  }

  async function reloadFromDisk(path: string) {
    const tab = findTab(path);
    if (!tab || path.startsWith(SHARED_TAB)) return;
    try {
      const fc = await api.readFile(problemId, path);
      applyDisk(tab, fc.content, fc.hash);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) tab.disk = 'deleted';
      else throw e;
    }
  }

  /**
   * Save a tab. Unless `force`, the write is conditional on the disk still holding
   * what we loaded, so external edits are never silently overwritten.
   */
  async function save(path: string, force = false): Promise<SaveResult> {
    const tab = findTab(path);
    if (!tab) return 'ok';
    if (tab.readOnly) return 'readonly';
    const content = tab.model.getValue();
    const version = tab.model.getAlternativeVersionId();
    const baseHash = force ? undefined : tab.disk === 'deleted' ? '' : tab.savedHash;
    try {
      const { hash } = await api.writeFile(problemId, path, content, baseHash);
      tab.savedHash = hash;
      tab.savedVersion = version;
      tab.dirty = tab.model.getAlternativeVersionId() !== version;
      tab.disk = 'ok';
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (tab.disk === 'ok') tab.disk = 'changed';
        return 'conflict';
      }
      throw e;
    }
    // The watcher suppresses our own writes, so refresh derived state here.
    // Also when a file becomes empty / non-empty (tutorial and statement status depend on it).
    const known = files.value.find((f) => f.path === path);
    if (path === 'problem.toml' || !known || (known.size === 0) !== (content.length === 0)) await loadDetail();
    return 'ok';
  }

  async function createFile(path: string, content = '') {
    await api.writeFile(problemId, path, content, '');
    await loadDetail();
    await openFile(path);
  }

  async function createDir(path: string) {
    await api.mkdir(problemId, path);
    await loadDetail();
  }

  const affected = (p: string, target: string) => p === target || p.startsWith(target + '/');

  async function rename(from: string, to: string) {
    const tabs = state.tabs.filter((t) => affected(t.path, from));
    if (tabs.some((t) => t.dirty)) throw new Error('dirty');
    await api.moveFile(problemId, from, to);
    const wasActive = state.active;
    for (const t of tabs) closeTab(t.path);
    await loadDetail();
    for (const t of tabs) await openFile(to + t.path.slice(from.length));
    if (wasActive && affected(wasActive, from)) state.active = to + wasActive.slice(from.length);
  }

  async function remove(path: string) {
    await api.deleteFile(problemId, path);
    for (const t of state.tabs.filter((t) => affected(t.path, path))) closeTab(t.path);
    await loadDetail();
  }

  async function patch(req: PatchProblemRequest) {
    const previousDir = state.detail?.summary.dir;
    state.detail = await api.patchProblem(problemId, req);
    // Folder moves pause the watcher, so refresh an open config tab explicitly.
    if (state.detail.summary.dir !== previousDir) {
      const tab = findTab('problem.toml');
      if (tab) {
        const file = await api.readFile(problemId, tab.path);
        if (findTab(tab.path) !== tab) return;
        if (tab.dirty) tab.disk = file.hash === tab.savedHash ? 'ok' : 'changed';
        else applyDisk(tab, file.content, file.hash);
      }
    }
  }

  async function copyShared(source: string, to: string) {
    await api.copyShared(problemId, source, to);
    await loadDetail();
  }

  async function onWsEvent(e: WsEvent) {
    if (e.type === 'problems:changed' || (e.type === 'problem:changed' && e.problemId === problemId)) {
      scheduleDetail();
      return;
    }
    if (e.type === 'settings:changed') {
      api.languages().then((r) => (state.languages = r.languages)).catch(() => {});
      return;
    }
    if (e.type !== 'file:changed' || e.problemId !== problemId) return;
    if (e.kind !== 'change' || e.path === 'problem.toml') scheduleDetail();
    const tab = findTab(e.path);
    if (!tab) return;
    if (e.kind === 'unlink') {
      tab.disk = 'deleted';
    } else if (e.kind === 'add' || e.kind === 'change') {
      if (e.hash && e.hash === tab.savedHash) {
        tab.disk = 'ok';
        return;
      }
      if (tab.dirty) tab.disk = 'changed';
      else await reloadFromDisk(e.path);
    }
  }

  function dispose() {
    clearTimeout(detailTimer);
    disposables.forEach((d) => d.dispose());
    for (const t of state.tabs) t.model.dispose();
    state.tabs = [];
  }

  /** First language in languages.toml whose extensions match (DESIGN §5). */
  function languageFor(path: string) {
    const c = state.detail?.config;
    const override = c?.source_languages?.[path] ?? [c?.validator, c?.checker, c?.interactor, ...(c?.solutions ?? []), ...(c?.generators ?? [])].find(e => e?.source === path)?.lang;
    if (override && state.languages[override]) return { id: override, ...state.languages[override] };
    const ext = '.' + (path.split('.').pop() ?? '').toLowerCase();
    for (const [id, l] of Object.entries(state.languages)) if (l.extensions.includes(ext)) return { id, ...l };
    return null;
  }

  return {
    state,
    activeTab,
    files,
    hasDirty,
    roleOf,
    init,
    loadDetail,
    openFile,
    closeTab,
    reloadFromDisk,
    save,
    createFile,
    createDir,
    rename,
    remove,
    patch,
    copyShared,
    onWsEvent,
    dispose,
    languageFor,
    editorRef: shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null),
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
