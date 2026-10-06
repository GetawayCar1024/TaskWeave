import { reactive, watch, onBeforeUnmount } from 'vue';
import type {
  CheckerTestResult,
  CompileResult,
  JobInfo,
  JobKind,
  SelfTestReport,
  TestsManifest,
  ValidatorTestResult,
  WsEvent,
  ProblemToml,
} from '@polyforge/shared';
import { api } from './api';
import { monaco } from './monaco';
import type { Workspace } from './workspace';

const MARKER_OWNER = 'polyforge-compile';

/**
 * Per-problem judge state: running jobs, the tests manifest, compile results (shown
 * as Monaco markers), self-test reports and the invocation being viewed.
 */
export function useJudge(problemId: string, ws: Workspace) {
  const state = reactive({
    jobs: {} as Partial<Record<JobKind, JobInfo>>,
    /** Manifest of the "tests" testset (statements, samples, most panels). */
    manifest: null as TestsManifest | null,
    /** Manifests of every testset loaded so far, by name. */
    manifests: {} as Record<string, TestsManifest | null>,
    compile: {} as Record<string, CompileResult>,
    compiling: {} as Record<string, boolean>,
    validatorReport: null as SelfTestReport<ValidatorTestResult> | null,
    checkerReport: null as SelfTestReport<CheckerTestResult> | null,
    /** Invocation shown in the matrix view. */
    invocationId: null as string | null,
    invocationVersion: 0,
  });

  async function loadManifest(testset = 'tests') {
    const m = await api.tests(problemId, testset).catch(() => null);
    state.manifests[testset] = m;
    if (testset === 'tests') state.manifest = m;
  }

  const reloadManifests = () => Promise.all([...new Set(['tests', ...Object.keys(state.manifests)])].map((ts) => loadManifest(ts)));

  async function init() {
    await loadManifest();
    for (const j of await api.jobs(problemId).catch(() => [] as JobInfo[])) trackJob(j);
    const recent = await api.invocations(problemId).catch(() => []);
    if (recent[0]) state.invocationId = recent[0].id;
  }

  /** Jobs known to have finished; a later "running" snapshot of them is stale. */
  const finished = new Set<string>();

  function trackJob(j: JobInfo) {
    // A fast job can finish (WS job:done) before the HTTP response that started it
    // arrives with its initial "running" snapshot.
    if (j.status === 'running' && finished.has(j.id)) return;
    if (j.status !== 'running') finished.add(j.id);
    const cur = state.jobs[j.kind];
    // Ignore stale events of an older job of the same kind.
    if (cur && cur.id !== j.id && cur.status === 'running' && j.startedAt < cur.startedAt) return;
    state.jobs[j.kind] = j;
  }

  function applyMarkers(result: CompileResult) {
    const tab = ws.state.tabs.find((t) => t.path === result.source);
    if (!tab || tab.model.isDisposed()) return;
    const markers = result.diagnostics
      .filter((d) => d.file === result.source)
      .map((d) => ({
        severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        message: d.message,
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.line,
        endColumn: tab.model.getLineMaxColumn(Math.min(d.line, tab.model.getLineCount())),
      }));
    monaco.editor.setModelMarkers(tab.model, MARKER_OWNER, markers);
  }

  /** Re-apply known markers when a file is opened. */
  function refreshMarkers(path: string) {
    const r = state.compile[path];
    if (r) applyMarkers(r);
  }

  async function build(source: string): Promise<CompileResult | undefined> {
    state.compiling[source] = true;
    try {
      const [r] = await api.build(problemId, [source]);
      return r;
    } finally {
      state.compiling[source] = false;
    }
  }

  async function generate(testset = 'tests') {
    trackJob(await api.generateTests(problemId, testset));
  }

  async function startInvocation(sources: string[], tests?: number[], testset?: string) {
    const r = await api.startInvocation(problemId, sources, tests, testset);
    trackJob(r.job);
    state.invocationId = r.invocationId;
    state.invocationVersion++;
    return r.invocationId;
  }

  async function validatorTests() {
    trackJob(await api.validatorTests(problemId));
  }

  async function checkerTests() {
    trackJob(await api.checkerTests(problemId));
  }

  async function cancel(kind: JobKind) {
    const j = state.jobs[kind];
    if (j?.status === 'running') await api.cancelJob(j.id);
  }

  const running = (kind: JobKind) => state.jobs[kind]?.status === 'running';

  /*
   * Keep the tests in step with their sources: after a manual test or script is added,
   * changed or deleted (or problem.toml changes samples / groups), regenerate the
   * testsets that were generated before. Generation is incremental, so this is cheap.
   */
  let regenTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  onBeforeUnmount(() => { disposed = true; clearTimeout(regenTimer); });
  const generationConfig = (c: ProblemToml | null | undefined) => c ? JSON.stringify({
    problem: { ...c.problem, title: undefined }, tests: { ...c.tests, samples: undefined },
    testsets: c.testsets, solutions: c.solutions, validator: c.validator, interactor: c.interactor,
    generators: c.generators, source_languages: c.source_languages,
  }) : '';
  watch(() => ws.state.detail?.config, (next, prev) => {
    if (!next || !prev) return;
    if (generationConfig(next) !== generationConfig(prev)) scheduleRegenerate();
    else void reloadManifests();
  });
  function scheduleRegenerate() {
    if (disposed) return;
    clearTimeout(regenTimer);
    regenTimer = setTimeout(async () => {
      if (running('generate')) return scheduleRegenerate();
      for (const ts of Object.keys(state.manifests)) {
        if (!state.manifests[ts]) continue;
        await generate(ts).catch(() => {});
        // One job at a time: wait for it before starting the next testset.
        while (!disposed && running('generate')) await new Promise((r) => setTimeout(r, 200));
        if (disposed) return;
      }
    }, 800);
  }

  function onWsEvent(e: WsEvent) {
    if (e.type === 'file:changed' && e.problemId === problemId && e.path.startsWith('tests/')) {
      if (/\.statement\.(in|out)$/.test(e.path) || e.path.startsWith('tests/_statement/')) { void reloadManifests(); return; }
      if (Object.values(state.manifests).some(Boolean)) scheduleRegenerate();
    }
    if (e.type === 'build:done' && e.problemId === problemId) {
      state.compile[e.result.source] = e.result;
      applyMarkers(e.result);
    } else if ((e.type === 'job:progress' || e.type === 'job:done') && e.job.problemId === problemId) {
      trackJob(e.job);
      if (e.job.kind === 'invocation') state.invocationVersion++;
      if (e.type === 'job:done') {
        if (e.job.kind === 'generate' && (e.job.result as TestsManifest | undefined)?.testset) loadManifest((e.job.result as TestsManifest).testset);
        else if (e.job.kind === 'generate' || e.job.kind === 'invocation') reloadManifests();
        if (e.job.kind === 'validator-tests' && e.job.result) state.validatorReport = e.job.result as SelfTestReport<ValidatorTestResult>;
        if (e.job.kind === 'checker-tests' && e.job.result) state.checkerReport = e.job.result as SelfTestReport<CheckerTestResult>;
      }
    }
  }

  return { state, init, loadManifest, build, generate, startInvocation, validatorTests, checkerTests, cancel, running, onWsEvent, refreshMarkers };
}

export type Judge = ReturnType<typeof useJudge>;
