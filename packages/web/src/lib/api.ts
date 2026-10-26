import type { DefsToml } from './latex';
import type { PackageCandidate, PackageImportOptions, PackageImportResult } from '@polyforge/shared';
import { serverText } from './serverText';
import {
  TOKEN_HEADER,
  type SystemFontStatus,
  type UsageStats,
  type ContestBatchRequest,
  type ContestDetail,
  type ContestImportRequest,
  type ContestPullRequest,
  type ContestRepullRequest,
  type ContestSyncStatus,
  type ContestStatement,
  type ContestSummary,
  type CreateContestRequest,
  type UpdateContestRequest,
  type LocalCheck,
  type StressRequest,
  type AiChange,
  type AiChangeContent,
  type AiEndpoint,
  type AiSessionDetail,
  type AiSessionSummary,
  type AiTestResult,
  type CreateAiSessionRequest,
  type SaveAiEndpoint,
  type CompileResult,
  type ImportRequest,
  type ItemContent,
  type PolygonProblem,
  type PullPreview,
  type PushPreview,
  type PushRequest,
  type SaveSecretsRequest,
  type SecretsResponse,
  type Invocation,
  type InvocationSummary,
  type JobInfo,
  type QuickRunRequest,
  type QuickRunResponse,
  type TestFileResponse,
  type TestsManifest,
  type CreateProblemRequest,
  type FileContent,
  type GlobalConfig,
  type LanguagesResponse,
  type PatchProblemRequest,
  type ProblemDetail,
  type ProblemSummary,
  type SettingsResponse,
  type SharedListResponse,
  type ToolProbe,
  type WriteFileResponse,
} from '@polyforge/shared';

const TOKEN_KEY = 'polyforge-token';

/** The server prints `/?token=...`; keep it and strip it from the address bar. */
function initToken(): string {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete('token');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export const token = initToken();

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export const onUnauthorized = (fn: Listener) => unauthorizedListeners.add(fn);

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { [TOKEN_HEADER]: token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    if (res.status === 401) unauthorizedListeners.forEach((f) => f());
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText);
  }
  return data as T;
}

/** Encode each segment of a relative path, keeping the slashes. */
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const pid = (id: string) => encodeURIComponent(id);
/** AI sessions belong to a problem (its id) or to a contest ("contest:<id>"). */
const aiBase = (owner: string) => (owner.startsWith('contest:') ? `/contests/${pid(owner.slice('contest:'.length))}` : `/problems/${pid(owner)}`);
/** ?testset= for anything but the default testset. */
const tsq = (ts?: string) => (ts && ts !== 'tests' ? `?testset=${encodeURIComponent(ts)}` : '');

async function uploadPackage<T>(url: string, file: File, options: PackageImportOptions, preview = false): Promise<T> {
  const query = new URLSearchParams(Object.entries(options).filter((entry): entry is [string, string] => entry[1] !== undefined));
  if (preview) query.set('preview', '1');
  const res = await fetch(`/api${url}?${query}`, { method: 'POST', headers: { [TOKEN_HEADER]: token, 'Content-Type': 'application/zip' }, body: file });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'import_failed', data.message ?? res.statusText);
  return data;
}

export const api = {
  packageCandidates: (file: File, options: PackageImportOptions) => uploadPackage<PackageCandidate[]>('/problems/import/package', file, options, true),
  importPackage: (file: File, options: PackageImportOptions, id?: string) => uploadPackage<PackageImportResult>(id ? `/problems/${pid(id)}/import/data` : '/problems/import/package', file, options),
  statementSamples: (id: string, lang?: string) => request<import('@polyforge/shared').StatementSample[]>('GET', `/problems/${pid(id)}/statement-samples${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`),
  contestDown: async (id: string, lang: string, pdf: Blob, statements: ContestStatement[], notes: string, single = false) => {
    const base64 = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(pdf); });
    const res = await fetch(`/api/${single ? 'problems' : 'contests'}/${pid(id)}/down`, { method: 'POST', headers: { [TOKEN_HEADER]: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ lang, pdf: base64, statements, notes }) });
    if (!res.ok) throw new Error((await res.json()).message ?? res.statusText);
    const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = 'down.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  },
  downSamples: async (id: string, lang: string, single = false) => {
    const res = await fetch(`/api/${single ? 'problems' : 'contests'}/${pid(id)}/down`, { method: 'POST', headers: { [TOKEN_HEADER]: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ lang, samplesOnly: true }) });
    if (!res.ok) throw new Error((await res.json()).message ?? res.statusText);
    const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = 'down.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  },
  problemDocument: (id: string) => request<ContestDetail>('GET', `/problems/${pid(id)}/document`),
  problemStatements: (id: string, lang: string) => request<ContestStatement[]>('GET', `/problems/${pid(id)}/statements?lang=${encodeURIComponent(lang)}`),
  problemTex: (id: string, lang: string, doc: string) => download(`/api/problems/${pid(id)}/tex?lang=${encodeURIComponent(lang)}&doc=${encodeURIComponent(doc)}`, `${id}-${doc}-${lang}.tex`),
  exportMarkdown: async (name: string, markdown: string, images: { problem: string; path: string; name: string }[]) => {
    const res = await fetch('/api/export/markdown', { method: 'POST', headers: { [TOKEN_HEADER]: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, markdown, images }) });
    if (!res.ok) throw new Error((await res.json()).message ?? res.statusText);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = `${name}.${images.length ? 'zip' : 'md'}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  },
  shutdownStatus: () => request<{ runningAi: boolean }>('GET', '/shutdown/status'),
  moveProblem: (id: string, root: string) => request<ProblemSummary>('POST', `/problems/${pid(id)}/relocate`, { root }),
  stopAllAi: () => request<{ ok: boolean }>('POST', '/shutdown/stop-ai'),
  clearAiScratch: (owner: string, sid: string) => request('DELETE', `${aiBase(owner)}/ai/sessions/${encodeURIComponent(sid)}/scratch`),
  clearCache: (id: string) => request('DELETE', `/problems/${pid(id)}/cache`),
  convertLemonChecker: (id: string) => request<{ source: string }>('POST', `/problems/${pid(id)}/lemon-checker`),
  contestLastResult: (id: string) => request<import('@polyforge/shared').ContestBatchResult | null>('GET', `/contests/${pid(id)}/batch/latest`),
  settings: () => request<SettingsResponse>('GET', '/settings'),
  saveSettings: (config: GlobalConfig) => request<SettingsResponse>('PUT', '/settings', config),
  languages: () => request<LanguagesResponse>('GET', '/languages'),
  saveLanguages: (text: string) => request<LanguagesResponse>('PUT', '/languages', { text }),
  detectTools: () => request<ToolProbe[]>('POST', '/tools/detect'),
  systemFonts: () => request<SystemFontStatus>('GET', '/system-fonts'),
  listDirs: (path: string) =>
    request<{ path: string; parent: string | null; dirs: string[] }>('GET', `/fs/dirs?path=${encodeURIComponent(path)}`),

  shared: () => request<SharedListResponse>('GET', '/shared'),
  sharedFile: (path: string) => request<FileContent>('GET', `/shared/file/${encPath(path)}`),

  problems: async () => {
    const result = await request<{ roots: string[]; problems: ProblemSummary[] }>('GET', '/problems');
    return { ...result, problems: result.problems.filter(p => (p.type ?? 'cf') === 'cf') };
  },
  createProblem: (req: CreateProblemRequest) => request<ProblemSummary>('POST', '/problems', req),
  problem: async (id: string) => {
    const detail = await request<ProblemDetail>('GET', `/problems/${pid(id)}`);
    if ((detail.summary.type ?? 'cf') !== 'cf') throw new ApiError(404, 'problem_not_found', 'Problem not available in this version');
    return detail;
  },
  patchProblem: (id: string, req: PatchProblemRequest) => request<ProblemDetail>('PATCH', `/problems/${pid(id)}`, req),
  statementMode: (id: string, lang: string, mode: 'whole' | 'sections') => request<ProblemDetail>('POST', `/problems/${pid(id)}/statement-mode`, { lang, mode }),
  /** Moves the problem folder to the global trash. */
  deleteProblem: (id: string) => request<{ ok: true; trash: string }>('DELETE', `/problems/${pid(id)}`),

  readFile: (id: string, path: string) => request<FileContent>('GET', `/problems/${pid(id)}/files/${encPath(path)}`),
  writeFile: (id: string, path: string, content: string, baseHash?: string) =>
    request<WriteFileResponse>('PUT', `/problems/${pid(id)}/files/${encPath(path)}`, { content, baseHash }),
  deleteFile: (id: string, path: string) => request<{ ok: true }>('DELETE', `/problems/${pid(id)}/files/${encPath(path)}`),
  moveFile: (id: string, from: string, to: string) => request<{ ok: true }>('POST', `/problems/${pid(id)}/move`, { from, to }),
  mkdir: (id: string, path: string) => request<{ ok: true }>('POST', `/problems/${pid(id)}/mkdir`, { path }),
  copyShared: (id: string, source: string, to: string) =>
    request<WriteFileResponse>('POST', `/problems/${pid(id)}/copy-shared`, { source, to }),

  // ---- judge (M2) ----
  build: (id: string, sources?: string[]) => request<CompileResult[]>('POST', `/problems/${pid(id)}/build`, { sources }),
  generateTests: (id: string, testset?: string) => request<JobInfo>('POST', `/problems/${pid(id)}/tests/generate${tsq(testset)}`),
  addManualTest: (id: string, req: { input: string; answer?: string; sample?: boolean; testset?: string; statementInput?: string; statementOutput?: string }) =>
    request<{ index: number; path: string; samples?: string }>('POST', `/problems/${pid(id)}/tests/manual`, req),
  /** `source` is the test as last seen (the server refuses if the test at `n` is another one). */
  removeTest: (id: string, n: number, source: string, testset?: string) =>
    request<{ kind: 'manual' | 'script'; removed: number[] }>(
      'DELETE',
      `/problems/${pid(id)}/tests/${n}?source=${encodeURIComponent(source)}${testset && testset !== 'tests' ? `&testset=${encodeURIComponent(testset)}` : ''}`,
    ),
  tests: (id: string, testset?: string) => request<TestsManifest | null>('GET', `/problems/${pid(id)}/tests${tsq(testset)}`),
  testFile: (id: string, n: number, kind: 'in' | 'ans' | 'overview' | 'statement-in' | 'statement-out', testset?: string) =>
    request<TestFileResponse>('GET', `/problems/${pid(id)}/tests/${n}/${kind}${tsq(testset)}`),
  run: (id: string, req: QuickRunRequest) => request<QuickRunResponse>('POST', `/problems/${pid(id)}/run`, req),
  startInvocation: (id: string, sources: string[], tests?: number[], testset?: string, selection?: import('@polyforge/shared').InvocationSelection) =>
    request<{ job: JobInfo; invocationId: string }>('POST', `/problems/${pid(id)}/invocations`, { sources, tests, testset, selection }),
  invocations: (id: string) => request<InvocationSummary[]>('GET', `/problems/${pid(id)}/invocations`),
  invocation: (id: string, inv: string) => request<Invocation>('GET', `/problems/${pid(id)}/invocations/${encodeURIComponent(inv)}`),
  invocationOutput: (id: string, inv: string, sol: number, test: number, testset?: string) =>
    request<TestFileResponse>('GET', `/problems/${pid(id)}/invocations/${encodeURIComponent(inv)}/output/${sol}/${test}${testset ? `?testset=${encodeURIComponent(testset)}` : ''}`),
  validatorTests: (id: string) => request<JobInfo>('POST', `/problems/${pid(id)}/validator-tests`),
  checkerTests: (id: string) => request<JobInfo>('POST', `/problems/${pid(id)}/checker-tests`),
  jobs: (problemId: string) => request<JobInfo[]>('GET', `/jobs?problem=${encodeURIComponent(problemId)}`),
  cancelJob: (jobId: string) => request<JobInfo>('POST', `/jobs/${encodeURIComponent(jobId)}/cancel`),
  defs: () => request<DefsToml>('GET', '/shared/defs'),

  // ---- Polygon (M3) ----
  secrets: () => request<SecretsResponse>('GET', '/secrets'),
  saveSecrets: (req: SaveSecretsRequest) => request<SecretsResponse>('PUT', '/secrets', req),
  polygonTest: () => request<{ ok: true; problems: number; ms: number }>('POST', '/polygon/test'),
  polygonProblems: () => request<PolygonProblem[]>('GET', '/polygon/problems'),
  pushPreview: (id: string) => request<PushPreview>('POST', `/problems/${pid(id)}/polygon/diff`),
  push: (id: string, req: PushRequest) => request<JobInfo>('POST', `/problems/${pid(id)}/polygon/push`, req),
  pullPreview: (id: string, testsets: string[] = []) => request<PullPreview>('POST', `/problems/${pid(id)}/polygon/pull-preview`, { testsets }),
  pull: (id: string, take: string[], merge: string[] = []) =>
    request<{ applied: string[]; merged: string[]; conflicts: string[]; warnings: string[] }>('POST', `/problems/${pid(id)}/polygon/pull`, { take, merge }),
  syncContent: (id: string, key: string) => request<ItemContent>('GET', `/problems/${pid(id)}/polygon/content?key=${encodeURIComponent(key)}`),
  importPolygon: (req: ImportRequest) => request<JobInfo>('POST', '/problems/import/polygon', req),
  job: (jobId: string) => request<JobInfo>('GET', `/jobs/${encodeURIComponent(jobId)}`),

  // ---- M5 ----
  stress: (id: string, req: StressRequest) => request<JobInfo>('POST', `/problems/${pid(id)}/stress`, req),
  exportPackage: (id: string, options?: { format?: 'polygon' | 'luogu'; testsets?: string[]; luogu?: { time: import('@polyforge/shared').LuoguAggregate; memory: import('@polyforge/shared').LuoguAggregate } }) => request<JobInfo>('POST', `/problems/${pid(id)}/export`, options),
  checks: (id: string) => request<LocalCheck[]>('GET', `/problems/${pid(id)}/checks`),
  startReview: (id: string, req: CreateAiSessionRequest) => request<AiSessionDetail>('POST', `${aiBase(id)}/ai/review`, req),
  /** Download an exported package through fetch (the token travels in a header). */
  downloadExport: (id: string, file: string) => download(`/api/problems/${pid(id)}/export/${encodeURIComponent(file)}`, file),

  // ---- contests ----
  contests: async () => (await request<ContestSummary[]>('GET', '/contests')).filter(c => (c.type ?? 'cf') === 'cf'),
  createContest: (req: CreateContestRequest) => request<ContestSummary>('POST', '/contests', req),
  contest: async (id: string) => {
    const detail = await request<ContestDetail>('GET', `/contests/${pid(id)}`);
    if ((detail.summary.type ?? 'cf') !== 'cf') throw new ApiError(404, 'contest_not_found', 'Contest not available in this version');
    return detail;
  },
  updateContest: (id: string, req: UpdateContestRequest) => request<ContestDetail>('PUT', `/contests/${pid(id)}`, req),
  deleteContest: (id: string) => request<{ ok: true }>('DELETE', `/contests/${pid(id)}`),
  contestStatements: (id: string, lang: string) => request<ContestStatement[]>('GET', `/contests/${pid(id)}/statements?lang=${encodeURIComponent(lang)}`),
  contestFiles: (id: string) => request<import('@polyforge/shared').FileNode[]>('GET', `/contests/${pid(id)}/files`),
  contestFile: (id: string, path: string) => request<FileContent>('GET', `/contests/${pid(id)}/file?path=${encodeURIComponent(path)}`),
  saveContestFile: (id: string, path: string, content: string, hash?: string) => request<{ hash: string }>('PUT', `/contests/${pid(id)}/file?path=${encodeURIComponent(path)}`, { content, hash }),
  uploadContestFile: (id: string, path: string, base64: string) => request('POST', `/contests/${pid(id)}/file?path=${encodeURIComponent(path)}`, { base64 }),
  deleteContestFile: (id: string, path: string) => request('DELETE', `/contests/${pid(id)}/file?path=${encodeURIComponent(path)}`),
  contestNotes: (id: string, lang?: string) => request<{ content: string }>('GET', `/contests/${pid(id)}/notes${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`),
  generateContestDocument: (id: string, lang: string, doc: 'statements' | 'tutorials') => request<{ path: string }>('POST', `/contests/${pid(id)}/generate-document`, { lang, doc }),
  downloadContestFile: (id: string, path: string) => download(`/api/contests/${pid(id)}/file/raw?path=${encodeURIComponent(path)}`, path.split('/').pop()!),
  contestBatch: (id: string, req: ContestBatchRequest) => request<JobInfo>('POST', `/contests/${pid(id)}/batch`, req),
  importContest: (req: ContestImportRequest) => request<JobInfo>('POST', '/contests/import/polygon', req),
  contestSyncStatus: (id: string) => request<ContestSyncStatus>('GET', `/contests/${pid(id)}/polygon/status`),
  contestPullPreview: (id: string, problems: string[]) => request<JobInfo>('POST', `/contests/${pid(id)}/polygon/pull-preview`, { problems }),
  contestPull: (id: string, req: ContestPullRequest) => request<JobInfo>('POST', `/contests/${pid(id)}/polygon/pull`, req),
  contestRepull: (id: string, req: ContestRepullRequest) => request<JobInfo>('POST', `/contests/${pid(id)}/polygon/repull`, req),
  contestTex: (id: string, lang: string, doc: string, breaks: boolean, toc: boolean) =>
    download(`/api/contests/${pid(id)}/tex?lang=${encodeURIComponent(lang)}&doc=${encodeURIComponent(doc)}&breaks=${breaks ? 1 : 0}&toc=${toc ? 1 : 0}`, `${id}-${doc}-${lang}.tex`),
  downloadContestExport: (id: string, file: string) => download(`/api/contests/${pid(id)}/export/${encodeURIComponent(file)}`, file),

  // ---- AI (M4) ----
  aiEndpoints: () => request<AiEndpoint[]>('GET', '/ai/endpoints'),
  aiUsage: () => request<UsageStats>('GET', '/ai/usage'),
  clearAiUsage: () => request<{ ok: true }>('DELETE', '/ai/usage'),
  saveAiEndpoints: (list: SaveAiEndpoint[]) => request<AiEndpoint[]>('PUT', '/ai/endpoints', list),
  testAiEndpoint: (name: string, model?: string) => request<AiTestResult>('POST', '/ai/endpoints/test', { name, model }),
  aiModels: (name: string) => request<string[]>('POST', '/ai/endpoints/models', { name }),
  aiSessions: (id: string) => request<AiSessionSummary[]>('GET', `${aiBase(id)}/ai/sessions`),
  createAiSession: (id: string, req: CreateAiSessionRequest) => request<AiSessionDetail>('POST', `${aiBase(id)}/ai/sessions`, req),
  aiSession: (id: string, sid: string) => request<AiSessionDetail>('GET', `${aiBase(id)}/ai/sessions/${sid}`),
  updateAiSession: (id: string, sid: string, patch: { title?: string; endpoint?: string; model?: string }) =>
    request<AiSessionDetail>('PATCH', `${aiBase(id)}/ai/sessions/${sid}`, patch),
  deleteAiSession: (id: string, sid: string) => request<{ ok: true }>('DELETE', `${aiBase(id)}/ai/sessions/${sid}`),
  sendAi: (id: string, sid: string, text: string) => request<AiSessionDetail>('POST', `${aiBase(id)}/ai/sessions/${sid}/messages`, { text }),
  cancelAi: (id: string, sid: string) => request<{ ok: true }>('POST', `${aiBase(id)}/ai/sessions/${sid}/cancel`),
  aiChanges: (id: string, sid: string) => request<AiChange[]>('GET', `${aiBase(id)}/ai/sessions/${sid}/changes`),
  aiChangeContent: (id: string, sid: string, path: string) =>
    request<AiChangeContent>('GET', `${aiBase(id)}/ai/sessions/${sid}/changes/content?path=${encodeURIComponent(path)}`),
  acceptAi: (id: string, sid: string, paths: string[]) => request<AiChange[]>('POST', `${aiBase(id)}/ai/sessions/${sid}/changes/accept`, { paths }),
  rejectAi: (id: string, sid: string, paths: string[]) => request<AiChange[]>('POST', `${aiBase(id)}/ai/sessions/${sid}/changes/reject`, { paths }),
};

/** Download a file through fetch (the token travels in a header). */
async function download(url: string, file: string) {
  const res = await fetch(url, { headers: { [TOKEN_HEADER]: token } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error ?? 'download_failed', data?.message ?? res.statusText);
  }
  // The server's name wins (e.g. .tex or .zip depending on the content).
  file = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? file;
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** URL for raw problem files in <img> tags (which cannot send the token header). */
export function rawUrl(id: string, path: string): string {
  return `/api/problems/${pid(id)}/raw/${encPath(path)}?token=${encodeURIComponent(token)}`;
}

/** An error for display, in the UI language (server texts are translated). */
export function errorMessage(e: unknown): string {
  return serverText(e instanceof Error ? e.message : String(e));
}
