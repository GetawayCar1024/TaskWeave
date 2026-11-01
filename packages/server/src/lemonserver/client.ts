import type { LemonServerStatus } from '@taskweave/shared';
import type { GlobalStore } from '../global.js';
import { HttpError } from '../util/fs.js';

/** LemonLime Server error, e.g. a rejected import (its JSON `error`). */
export class LemonServerError extends HttpError {
  constructor(public status: number, public remote: string) {
    super(502, 'lemonserver_error', `LemonLime Server: ${remote}`);
  }
}

/** Same rule as the server: no path characters, no surrounding blanks, at most 128 characters. */
export function validLemonContestName(name: string): boolean {
  return !!name && name === name.trim() && name !== '.' && name !== '..' && !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !name.endsWith('.') && name.length <= 128;
}

/**
 * Client for the HTTP API of LemonLime Server. The stored credential may be an API key or the
 * server's access token: an access token is exchanged for a session (POST /api/auth/login).
 */
export class LemonServerClient {
  private credential = '';
  status?: { version: string; platform: string; setupRequired: boolean };

  constructor(readonly url: string, private key: string, private signal?: AbortSignal) {}

  static async fromSettings(global: GlobalStore, signal?: AbortSignal) {
    const c = await global.lemonServerCredentials();
    if (!c.url) throw new HttpError(400, 'no_lemonserver', 'LemonLime Server is not configured (Settings → LemonLime Server).');
    if (!c.key) throw new HttpError(400, 'no_lemonserver', 'The LemonLime Server API key or access token is not set (Settings → LemonLime Server).');
    return new LemonServerClient(c.url.replace(/\/+$/, ''), c.key, signal);
  }

  private async fetch(path: string, init: RequestInit & { auth?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const auth = init.auth ?? this.credential;
    if (auth) headers.set('authorization', `Bearer ${auth}`);
    try {
      return await fetch(this.url + path, { ...init, headers, signal: this.signal });
    } catch (e) {
      if (this.signal?.aborted) throw e;
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new HttpError(502, 'lemonserver_unreachable', `Cannot reach LemonLime Server at ${this.url}: ${cause?.code ?? cause?.message ?? (e as Error).message}`);
    }
  }

  private async read<T>(res: Response): Promise<T> {
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : {}; } catch { body = undefined; }
    if (!res.ok) {
      const message = (body as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
      throw new LemonServerError(res.status, message);
    }
    if (body === undefined) throw new HttpError(502, 'lemonserver_bad_response', `${this.url} did not answer as a LemonLime Server.`);
    return body as T;
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.credential) await this.login();
    const raw = Buffer.isBuffer(body);
    const res = await this.fetch(path, { method, body: raw ? new Uint8Array(body) : body === undefined ? undefined : JSON.stringify(body), headers: raw ? { 'content-type': 'application/octet-stream' } : body === undefined ? {} : { 'content-type': 'application/json' } });
    return this.read<T>(res);
  }

  /** Raw download (zip of a folder). */
  async download(path: string): Promise<Buffer> {
    if (!this.credential) await this.login();
    const res = await this.fetch(path);
    if (!res.ok) await this.read(res);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Check the credential: an API key works directly, an access token gives a session. */
  async login(): Promise<void> {
    type Status = { authenticated?: boolean; version?: string; lemonlimeVersion?: string; platform?: string; setupRequired?: boolean };
    const status = await this.read<Status>(await this.fetch('/api/auth/status', { auth: this.key }));
    if (typeof status.authenticated !== 'boolean') throw new HttpError(502, 'lemonserver_bad_response', `${this.url} did not answer as a LemonLime Server.`);
    if (status.authenticated) this.credential = this.key;
    else {
      const res = await this.fetch('/api/auth/login', { method: 'POST', auth: '', body: JSON.stringify({ token: this.key }), headers: { 'content-type': 'application/json' } });
      if (res.status === 401) throw new HttpError(401, 'lemonserver_auth', 'LemonLime Server rejected the API key or access token.');
      this.credential = (await this.read<{ session: string }>(res)).session;
    }
    // Only LemonServer's own version is shown (it also reports its LemonLime core's as lemonlimeVersion).
    const version = status.version ? `LemonServer ${status.version}` : '';
    this.status = { version, platform: status.platform ?? '', setupRequired: !!status.setupRequired };
  }

  /** Packages are built for the server's system: checker paths and executables differ. */
  get target(): 'windows' | 'linux' {
    return /windows/i.test(this.status?.platform ?? '') ? 'windows' : 'linux';
  }

  /** 0.1.3+: per-contest judging / busy (judged or queued); older servers judge one contest, the current one. */
  async contests(): Promise<{ current?: string; judging: boolean; judgingContest?: string; contests: { name: string; judging?: boolean; busy?: boolean; queuedJobs?: number }[] }> {
    return this.call('GET', '/api/contests');
  }

  async test(): Promise<LemonServerStatus> {
    const started = Date.now();
    await this.login();
    const list = this.status!.setupRequired ? { contests: [] } : await this.contests();
    return { ok: true, url: this.url, version: this.status!.version, platform: this.status!.platform, target: this.target, setupRequired: this.status!.setupRequired, contests: list.contests.length, names: list.contests.map(c => c.name), ms: Date.now() - started };
  }
}

export const contestPath = (name: string, rest = '') => `/api/contests/${encodeURIComponent(name)}${rest}`;
/** Percent-encoded query string: Qt does not read "+" as a space, so URLSearchParams cannot be used. */
export const query = (q: Record<string, string | number | undefined>) => {
  const s = Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  return s ? `?${s}` : '';
};
