import {
  TOKEN_HEADER,
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
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
