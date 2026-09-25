import type { DefsToml } from './latex';
import {
  TOKEN_HEADER,
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
  generateTests: (id: string) => request<JobInfo>('POST', `/problems/${pid(id)}/tests/generate`),
  tests: (id: string) => request<TestsManifest | null>('GET', `/problems/${pid(id)}/tests`),
  testFile: (id: string, n: number, kind: 'in' | 'ans' | 'overview') =>
    request<TestFileResponse>('GET', `/problems/${pid(id)}/tests/${n}/${kind}`),
  run: (id: string, req: QuickRunRequest) => request<QuickRunResponse>('POST', `/problems/${pid(id)}/run`, req),
  startInvocation: (id: string, sources: string[], tests?: number[]) =>
    request<{ job: JobInfo; invocationId: string }>('POST', `/problems/${pid(id)}/invocations`, { sources, tests }),
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
  pull: (id: string, take: string[]) => request<{ applied: string[]; warnings: string[] }>('POST', `/problems/${pid(id)}/polygon/pull`, { take }),
  syncContent: (id: string, key: string) => request<ItemContent>('GET', `/problems/${pid(id)}/polygon/content?key=${encodeURIComponent(key)}`),
  importPolygon: (req: ImportRequest) => request<JobInfo>('POST', '/problems/import/polygon', req),
  job: (jobId: string) => request<JobInfo>('GET', `/jobs/${encodeURIComponent(jobId)}`),
};

/** URL for raw problem files in <img> tags (which cannot send the token header). */
export function rawUrl(id: string, path: string): string {
  return `/api/problems/${pid(id)}/raw/${encPath(path)}?token=${encodeURIComponent(token)}`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
