import { createHash, randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from '../util/fs.js';

export type ParamValue = string | number | boolean | Buffer | undefined | null;
export type Params = Record<string, ParamValue>;

const RAND_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const toBytes = (v: string | number | boolean | Buffer): Buffer =>
  Buffer.isBuffer(v) ? v : Buffer.from(typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v), 'utf8');

/**
 * Polygon apiSig (DESIGN §4.3): rand6 + sha512hex(rand6 + "/" + method + "?" +
 * sorted "key=value" pairs joined by "&" + "#" + secret). Pairs are sorted by key, then
 * value, as raw UTF-8 bytes — the same as the reference clients.
 */
export function apiSignature(method: string, pairs: [Buffer, Buffer][], secret: string, rand?: string): string {
  const r = rand ?? Array.from({ length: 6 }, () => RAND_ALPHABET[randomInt(RAND_ALPHABET.length)]).join('');
  const sorted = [...pairs].sort((a, b) => Buffer.compare(a[0], b[0]) || Buffer.compare(a[1], b[1]));
  const argBytes = Buffer.concat(sorted.flatMap(([k, v], i) => [...(i ? [Buffer.from('&')] : []), k, Buffer.from('='), v]));
  const hash = createHash('sha512')
    .update(Buffer.concat([Buffer.from(`${r}/${method}?`), argBytes, Buffer.from('#'), Buffer.from(secret, 'utf8')]))
    .digest('hex');
  return r + hash;
}

export class PolygonError extends Error {
  constructor(
    public method: string,
    message: string,
    /** `result` of a FAILED answer, when Polygon sends one (e.g. problem.deleteTest failures). */
    public result?: unknown,
  ) {
    super(`${method}: ${message}`);
  }
}

/** No answer, a timeout, or HTTP 5xx/429: the request may be repeated (if idempotent). */
export class TransportError extends Error {}

/**
 * Methods that must not be sent twice: a lost answer does not mean nothing happened
 * (a second problem, a second commit or package, or a failure for an already deleted object).
 */
const NOT_IDEMPOTENT = /^(problem\.create|problem\.commitChanges|problem\.buildPackage|problem\.delete\w*|problem\.addIssue|problem\.runStresses|problem\.addStressCountertest)$/;

export interface ClientOptions {
  apiUrl: string;
  key: string;
  secret: string;
  /** Retries for network errors / timeouts and HTTP 5xx/429 (idempotent methods only). */
  retries?: number;
  timeoutMs?: number;
  /** First backoff delay (doubled on every retry). */
  retryDelayMs?: number;
  /** Aborts every request of this client, including the one in flight (job cancellation). */
  signal?: AbortSignal;
}

/**
 * Polygon API client. Requests are serialised (one at a time). Transport failures
 * (no answer, timeout, HTTP 5xx/429) of idempotent methods are retried with exponential
 * backoff; Polygon's own answers (HTTP 400 / `FAILED`) and other HTTP errors are not.
 */
export class PolygonClient {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly base: string;

  constructor(private opts: ClientOptions) {
    if (!opts.key || !opts.secret) throw new HttpError(400, 'no_polygon_credentials', 'Polygon API key/secret are not configured (Settings → Polygon)');
    this.base = opts.apiUrl.endsWith('/') ? opts.apiUrl : `${opts.apiUrl}/`;
  }

  /** Call a JSON method and return `result`. */
  async call<T = any>(method: string, params: Params = {}, signal?: AbortSignal): Promise<T> {
    const res = await this.raw(method, params, signal);
    let json: { status?: string; comment?: string; result?: T };
    try {
      json = JSON.parse(res.toString('utf8'));
    } catch {
      throw new PolygonError(method, 'response is not JSON');
    }
    if (json.status !== 'OK') throw new PolygonError(method, json.comment || `status ${json.status}`, json.result);
    return json.result as T;
  }

  /** Call a method returning a raw body (viewFile, script, testInput, package…). */
  async text(method: string, params: Params = {}, signal?: AbortSignal): Promise<string> {
    return (await this.raw(method, params, signal)).toString('utf8');
  }

  raw(method: string, params: Params = {}, signal?: AbortSignal): Promise<Buffer> {
    const sig = signal && this.opts.signal ? AbortSignal.any([signal, this.opts.signal]) : signal ?? this.opts.signal;
    const run = () => this.withRetry(method, params, sig);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  private async withRetry(method: string, params: Params, signal?: AbortSignal): Promise<Buffer> {
    const retries = NOT_IDEMPOTENT.test(method) ? 0 : this.opts.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        return await this.once(method, params, signal);
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        if (!(e instanceof TransportError) || attempt >= retries) throw e;
        await delay((this.opts.retryDelayMs ?? 1000) * 2 ** attempt, undefined, signal ? { signal } : undefined);
      }
    }
  }

  private async once(method: string, params: Params, signal?: AbortSignal): Promise<Buffer> {
    const pairs: [Buffer, Buffer][] = [];
    const form = new FormData();
    // Every field goes as a file part (like the reference clients): multipart string
    // fields get their line breaks normalised to CRLF, which would corrupt test data
    // and no longer match the signed bytes.
    const append = (k: string, bytes: Buffer) => form.append(k, new Blob([new Uint8Array(bytes)]), k);
    const add = (k: string, v: string | number | boolean | Buffer) => {
      const bytes = toBytes(v);
      pairs.push([Buffer.from(k, 'utf8'), bytes]);
      append(k, bytes);
    };
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) add(k, v);
    add('apiKey', this.opts.key);
    add('time', Math.floor(Date.now() / 1000));
    append('apiSig', Buffer.from(apiSignature(method, pairs, this.opts.secret)));

    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 120_000);
    let res: Response;
    let body: Buffer;
    try {
      res = await fetch(this.base + method, { method: 'POST', body: form, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      body = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (signal?.aborted) throw e;
      const err = e as Error & { cause?: { code?: string; message?: string } };
      const why = timeout.aborted ? `no answer within ${Math.round((this.opts.timeoutMs ?? 120_000) / 1000)} s` : err.cause?.code ?? err.cause?.message ?? err.message;
      throw new TransportError(`${method}: ${why}`);
    }
    // Polygon answers user errors with 400 + a JSON body; 5xx / 429 are worth another try.
    if (res.status === 400) {
      try {
        const j = JSON.parse(body.toString('utf8'));
        throw new PolygonError(method, j.comment || 'bad request', j.result);
      } catch (e) {
        if (e instanceof PolygonError) throw e;
        throw new PolygonError(method, `HTTP 400: ${body.toString('utf8').slice(0, 200)}`);
      }
    }
    if (res.status >= 500 || res.status === 429) throw new TransportError(`${method}: HTTP ${res.status}`);
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    // Raw endpoints still report failures as JSON.
    if (body[0] === 0x7b /* { */ && body.length < 4096) {
      try {
        const j = JSON.parse(body.toString('utf8'));
        if (j && j.status === 'FAILED') throw new PolygonError(method, j.comment || 'FAILED', j.result);
      } catch (e) {
        if (e instanceof PolygonError) throw e;
      }
    }
    return body;
  }
}
