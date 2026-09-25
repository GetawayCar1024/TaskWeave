import type { DefsToml } from './latex';
import {
  TOKEN_HEADER,
  type UsageStats,
  type ContestBatchRequest,
  type ContestDetail,
  type ContestImportRequest,
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
/** ?testset= for anything but the default testset. */
const tsq = (ts?: string) => (ts && ts !== 'tests' ? `?testset=${encodeURIComponent(ts)}` : '');

export const api = {
  settings: () => request<SettingsResponse>('GET', '/settings'),
  saveSettings: (config: GlobalConfig) => request<SettingsResponse>('PUT', '/settings', config),
  languages: () => request<LanguagesResponse>('GET', '/languages'),
  saveLanguages: (text: string) => request<LanguagesResponse>('PUT', '/languages', { text }),
  detectTools: () => request<ToolProbe[]>('POST', '/tools/detect'),
  listDirs: (path: string) =>
    request<{ path: string; parent: string | null; dirs: string[] }>('GET', `/fs/dirs?path=${encodeURIComponent(path)}`),

  shared: () => request<SharedListResponse>('GET', '/shared'),
  sharedFile: (path: string) => request<FileContent>('GET', `/shared/file/${encPath(path)}`),

  problems: () => request<{ roots: string[]; problems: ProblemSummary[] }>('GET', '/problems'),
  createProblem: (req: CreateProblemRequest) => request<ProblemSummary>('POST', '/problems', req),
  problem: (id: string) => request<ProblemDetail>('GET', `/problems/${pid(id)}`),
  patchProblem: (id: string, req: PatchProblemRequest) => request<ProblemDetail>('PATCH', `/problems/${pid(id)}`, req),
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
  tests: (id: string, testset?: string) => request<TestsManifest | null>('GET', `/problems/${pid(id)}/tests${tsq(testset)}`),
  testFile: (id: string, n: number, kind: 'in' | 'ans' | 'overview', testset?: string) =>
    request<TestFileResponse>('GET', `/problems/${pid(id)}/tests/${n}/${kind}${tsq(testset)}`),
  run: (id: string, req: QuickRunRequest) => request<QuickRunResponse>('POST', `/problems/${pid(id)}/run`, req),
  startInvocation: (id: string, sources: string[], tests?: number[], testset?: string) =>
    request<{ job: JobInfo; invocationId: string }>('POST', `/problems/${pid(id)}/invocations`, { sources, tests, testset }),
  invocations: (id: string) => request<InvocationSummary[]>('GET', `/problems/${pid(id)}/invocations`),
  invocation: (id: string, inv: string) => request<Invocation>('GET', `/problems/${pid(id)}/invocations/${encodeURIComponent(inv)}`),
  invocationOutput: (id: string, inv: string, sol: number, test: number) =>
    request<TestFileResponse>('GET', `/problems/${pid(id)}/invocations/${encodeURIComponent(inv)}/output/${sol}/${test}`),
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
  pullPreview: (id: string) => request<PullPreview>('POST', `/problems/${pid(id)}/polygon/pull-preview`),
  pull: (id: string, take: string[], merge: string[] = []) =>
    request<{ applied: string[]; merged: string[]; conflicts: string[]; warnings: string[] }>('POST', `/problems/${pid(id)}/polygon/pull`, { take, merge }),
  syncContent: (id: string, key: string) => request<ItemContent>('GET', `/problems/${pid(id)}/polygon/content?key=${encodeURIComponent(key)}`),
  importPolygon: (req: ImportRequest) => request<JobInfo>('POST', '/problems/import/polygon', req),
  job: (jobId: string) => request<JobInfo>('GET', `/jobs/${encodeURIComponent(jobId)}`),

  // ---- M5 ----
  stress: (id: string, req: StressRequest) => request<JobInfo>('POST', `/problems/${pid(id)}/stress`, req),
  exportPackage: (id: string) => request<JobInfo>('POST', `/problems/${pid(id)}/export`),
  checks: (id: string) => request<LocalCheck[]>('GET', `/problems/${pid(id)}/checks`),
  startReview: (id: string, req: CreateAiSessionRequest) => request<AiSessionDetail>('POST', `/problems/${pid(id)}/ai/review`, req),
  /** Download an exported package through fetch (the token travels in a header). */
  downloadExport: (id: string, file: string) => download(`/api/problems/${pid(id)}/export/${encodeURIComponent(file)}`, file),

  // ---- contests ----
  contests: () => request<ContestSummary[]>('GET', '/contests'),
  createContest: (req: CreateContestRequest) => request<ContestSummary>('POST', '/contests', req),
  contest: (id: string) => request<ContestDetail>('GET', `/contests/${pid(id)}`),
  updateContest: (id: string, req: UpdateContestRequest) => request<ContestDetail>('PUT', `/contests/${pid(id)}`, req),
  deleteContest: (id: string) => request<{ ok: true }>('DELETE', `/contests/${pid(id)}`),
  contestStatements: (id: string, lang: string) => request<ContestStatement[]>('GET', `/contests/${pid(id)}/statements?lang=${encodeURIComponent(lang)}`),
  contestBatch: (id: string, req: ContestBatchRequest) => request<JobInfo>('POST', `/contests/${pid(id)}/batch`, req),
  importContest: (req: ContestImportRequest) => request<JobInfo>('POST', '/contests/import/polygon', req),
  downloadContestExport: (id: string, file: string) => download(`/api/contests/${pid(id)}/export/${encodeURIComponent(file)}`, file),

  // ---- AI (M4) ----
  aiEndpoints: () => request<AiEndpoint[]>('GET', '/ai/endpoints'),
  aiUsage: () => request<UsageStats>('GET', '/ai/usage'),
  clearAiUsage: () => request<{ ok: true }>('DELETE', '/ai/usage'),
  saveAiEndpoints: (list: SaveAiEndpoint[]) => request<AiEndpoint[]>('PUT', '/ai/endpoints', list),
  testAiEndpoint: (name: string, model?: string) => request<AiTestResult>('POST', '/ai/endpoints/test', { name, model }),
  aiModels: (name: string) => request<string[]>('POST', '/ai/endpoints/models', { name }),
  aiSessions: (id: string) => request<AiSessionSummary[]>('GET', `/problems/${pid(id)}/ai/sessions`),
  createAiSession: (id: string, req: CreateAiSessionRequest) => request<AiSessionDetail>('POST', `/problems/${pid(id)}/ai/sessions`, req),
  aiSession: (id: string, sid: string) => request<AiSessionDetail>('GET', `/problems/${pid(id)}/ai/sessions/${sid}`),
  updateAiSession: (id: string, sid: string, patch: { title?: string; endpoint?: string; model?: string }) =>
    request<AiSessionDetail>('PATCH', `/problems/${pid(id)}/ai/sessions/${sid}`, patch),
  deleteAiSession: (id: string, sid: string) => request<{ ok: true }>('DELETE', `/problems/${pid(id)}/ai/sessions/${sid}`),
  sendAi: (id: string, sid: string, text: string) => request<AiSessionDetail>('POST', `/problems/${pid(id)}/ai/sessions/${sid}/messages`, { text }),
  cancelAi: (id: string, sid: string) => request<{ ok: true }>('POST', `/problems/${pid(id)}/ai/sessions/${sid}/cancel`),
  aiChanges: (id: string, sid: string) => request<AiChange[]>('GET', `/problems/${pid(id)}/ai/sessions/${sid}/changes`),
  aiChangeContent: (id: string, sid: string, path: string) =>
    request<AiChangeContent>('GET', `/problems/${pid(id)}/ai/sessions/${sid}/changes/content?path=${encodeURIComponent(path)}`),
  acceptAi: (id: string, sid: string, paths: string[]) => request<AiChange[]>('POST', `/problems/${pid(id)}/ai/sessions/${sid}/changes/accept`, { paths }),
  rejectAi: (id: string, sid: string, paths: string[]) => request<AiChange[]>('POST', `/problems/${pid(id)}/ai/sessions/${sid}/changes/reject`, { paths }),
};

/** Download a file through fetch (the token travels in a header). */
async function download(url: string, file: string) {
  const res = await fetch(url, { headers: { [TOKEN_HEADER]: token } });
  if (!res.ok) throw new ApiError(res.status, 'download_failed', res.statusText);
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

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
