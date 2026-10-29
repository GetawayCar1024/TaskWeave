import { promises as fsp, realpathSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import {
  globalConfigSchema,
  languageSchema,
  type GlobalConfig,
  type LanguagesConfig,
  type LanguagesResponse,
  type SaveSecretsRequest,
  type SecretsResponse,
  AI_PROTOCOLS,
  type AiEndpoint,
  type AiProtocol,
  type SaveAiEndpoint,
  CURRENCIES,
  type EndpointPricing,
  type ModelPrice,
  legacyEnv,
} from '@taskweave/shared';

export interface RawAiEndpoint {
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  apiKey: string;
  models: string[];
  pricing?: EndpointPricing;
}

export const DEFAULT_POLYGON_API = 'https://polygon.codeforces.com/api/';
import { ASSETS_DIR } from './paths.js';
import { atomicWrite, copyMissing, exists, HttpError } from './util/fs.js';
import { migrateDefaultProfile, migrateProfilePaths, migrateTrashEntry, migrateStateIgnore } from './workspace/migrateNames.js';


export function defaultGlobalDir(): string {
  const override = process.env.TASKWEAVE_HOME || process.env[legacyEnv('HOME')];
  if (override) return path.resolve(override);
  return migrateDefaultProfile(os.homedir());
}

/**
 * The global directory (DESIGN §3.1): config, languages, secrets, shared files, templates.
 */
export class GlobalStore {
  config!: GlobalConfig;

  constructor(public readonly dir: string) {}

  get sharedDir() {
    return path.join(this.dir, 'shared');
  }
  get templatesDir() {
    return path.join(this.dir, 'templates');
  }
  /** Contests folder: config contests.dir, or <global dir>/contests. */
  get contestsDir() {
    const d = this.config.contests?.dir?.trim();
    return d ? path.resolve(d) : path.join(this.dir, 'contests');
  }
  get cacheDir() {
    return path.join(this.dir, 'cache');
  }
  private get configPath() {
    return path.join(this.dir, 'config.toml');
  }
  private get languagesPath() {
    return path.join(this.dir, 'languages.toml');
  }

  /**
   * First-run initialisation. Bundled assets are copied without overwriting, so user
   * edits survive and newly bundled files (e.g. new checkers) appear after upgrades.
   */
  async init(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    await copyMissing(path.join(ASSETS_DIR, 'shared'), this.sharedDir);
    await copyMissing(path.join(ASSETS_DIR, 'templates'), this.templatesDir);
    await migrateStateIgnore(path.join(this.templatesDir, 'problem', '.gitignore'));
    for (const f of ['config.toml', 'languages.toml', 'secrets.toml']) {
      const dest = path.join(this.dir, f);
      if (!(await exists(dest))) await fsp.copyFile(path.join(ASSETS_DIR, f), dest);
    }
    await fsp.mkdir(path.join(this.cacheDir, 'bin'), { recursive: true });
    await migrateProfilePaths(this.dir);
    await this.loadConfig();
    for (const entry of await fsp.readdir(path.join(this.dir, 'trash'), { withFileTypes: true }).catch(() => [])) if (entry.isDirectory() && !entry.isSymbolicLink()) await migrateTrashEntry(path.join(this.dir, 'trash', entry.name));
    await this.checkTestlib();
  }

  /** Existing shared files are never overwritten: say so when testlib.h is not the bundled version. */
  private async checkTestlib() {
    const version = (file: string) =>
      fsp.readFile(file, 'utf8').then((t) => t.match(/#define VERSION "([^"]+)"/)?.[1], () => undefined);
    const [mine, bundled] = await Promise.all([version(path.join(this.sharedDir, 'testlib.h')), version(path.join(ASSETS_DIR, 'shared', 'testlib.h'))]);
    if (mine && bundled && mine !== bundled) {
      console.log(`[taskweave] shared/testlib.h is ${mine}; TaskWeave ships ${bundled}. To update: copy ${path.join(ASSETS_DIR, 'shared', 'testlib.h')} to ${path.join(this.sharedDir, 'testlib.h')}`);
    }
  }

  async loadConfig(): Promise<GlobalConfig> {
    const text = await fsp.readFile(this.configPath, 'utf8');
    let raw: unknown;
    try {
      raw = parse(text);
    } catch (e) {
      console.warn(`[taskweave] config.toml is invalid, using defaults: ${(e as Error).message}`);
      raw = {};
    }
    const parsed = globalConfigSchema.safeParse(raw);
    this.config = parsed.success ? parsed.data : globalConfigSchema.parse({});
    this.config.problems.roots = this.config.problems.roots.map(canonicalRoot);
    return this.config;
  }

  async saveConfig(next: unknown): Promise<GlobalConfig> {
    const parsed = globalConfigSchema.safeParse(next);
    if (!parsed.success) throw new HttpError(400, 'invalid_config', parsed.error.message);
    const roots: string[] = [];
    for (const r of parsed.data.problems.roots) {
      if (!path.isAbsolute(r)) throw new HttpError(400, 'invalid_root', `Root must be an absolute path: ${r}`);
      const norm = canonicalRoot(r);
      if (!roots.some((x) => samePath(x, norm))) roots.push(norm);
    }
    parsed.data.problems.roots = roots;
    await atomicWrite(this.configPath, '# TaskWeave 全局配置\n\n' + stringify(parsed.data) + '\n');
    this.config = parsed.data;
    return this.config;
  }

  private get secretsPath() {
    return path.join(this.dir, 'secrets.toml');
  }

  /** Raw secrets.toml (DESIGN §8: keys live only here, never in problem folders). */
  async readSecrets(): Promise<Record<string, any>> {
    try {
      return parse(await fsp.readFile(this.secretsPath, 'utf8')) as Record<string, any>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new HttpError(500, 'bad_secrets', `secrets.toml: ${(e as Error).message}`);
    }
  }

  async polygonCredentials(): Promise<{ key: string; secret: string; apiUrl: string }> {
    const p = (await this.readSecrets()).polygon ?? {};
    return { key: String(p.key ?? '').trim(), secret: String(p.secret ?? '').trim(), apiUrl: String(p.api_url || DEFAULT_POLYGON_API) };
  }

  async maskedSecrets(): Promise<SecretsResponse> {
    const c = await this.polygonCredentials();
    const mask = (s: string) => (s.length <= 8 ? (s ? '••••' : '') : `${s.slice(0, 4)}…${s.slice(-2)}`);
    return { polygon: { key: mask(c.key), hasKey: !!c.key, hasSecret: !!c.secret, apiUrl: c.apiUrl } };
  }

  async saveSecrets(req: SaveSecretsRequest): Promise<SecretsResponse> {
    const doc = await this.readSecrets();
    doc.polygon ??= {};
    const p = req.polygon ?? {};
    if (p.key?.trim()) doc.polygon.key = p.key.trim();
    if (p.secret?.trim()) doc.polygon.secret = p.secret.trim();
    if (p.apiUrl !== undefined) {
      if (p.apiUrl.trim() && p.apiUrl.trim() !== DEFAULT_POLYGON_API) doc.polygon.api_url = p.apiUrl.trim();
      else delete doc.polygon.api_url;
    }
    await atomicWrite(this.secretsPath, '# 密钥文件：Polygon key/secret 与 AI 端点。不要放进题目目录。\n\n' + stringify(doc) + '\n');
    return this.maskedSecrets();
  }

  /** AI endpoints from `[[ai.endpoints]]` in secrets.toml, keys included. */
  async aiEndpointsRaw(): Promise<RawAiEndpoint[]> {
    const list = (await this.readSecrets()).ai?.endpoints;
    if (!Array.isArray(list)) return [];
    return list
      .filter((e) => e && typeof e.name === 'string')
      .map((e) => ({
        name: String(e.name),
        protocol: e.protocol === 'openai' || e.protocol === 'openai-chat' ? 'openai-chat' : e.protocol === 'openai-responses' ? 'openai-responses' : 'anthropic',
        baseUrl: String(e.base_url ?? ''),
        apiKey: String(e.api_key ?? ''),
        models: Array.isArray(e.models) ? e.models.map(String) : [],
        pricing: readPricing(e),
      }));
  }

  async aiEndpoint(name?: string): Promise<RawAiEndpoint> {
    const list = await this.aiEndpointsRaw();
    const want = name || this.config.ai?.endpoint;
    const ep = (want ? list.find((e) => e.name === want) : undefined) ?? list[0];
    if (!ep) throw new HttpError(400, 'no_ai_endpoint', 'No AI endpoint configured (Settings → AI)');
    return ep;
  }

  async maskedAiEndpoints(): Promise<AiEndpoint[]> {
    const mask = (s: string) => (s.length <= 8 ? (s ? '••••' : '') : `${s.slice(0, 4)}…${s.slice(-2)}`);
    return (await this.aiEndpointsRaw()).map((e) => ({ ...e, apiKey: mask(e.apiKey), hasKey: !!e.apiKey }));
  }

  async saveAiEndpoints(next: SaveAiEndpoint[]): Promise<AiEndpoint[]> {
    const old = await this.aiEndpointsRaw();
    const names = new Set<string>();
    const endpoints = next.map((e) => {
      // Accept older clients as well as migrating stored configurations.
      if ((e.protocol as string) === 'openai') e = { ...e, protocol: 'openai-chat' };
      const name = e.name.trim();
      if (!name) throw new HttpError(400, 'bad_endpoint', 'Endpoint name is required');
      if (names.has(name)) throw new HttpError(400, 'bad_endpoint', `Duplicate endpoint name: ${name}`);
      names.add(name);
      if (!AI_PROTOCOLS.includes(e.protocol)) throw new HttpError(400, 'bad_endpoint', `Unknown protocol: ${e.protocol}`);
      const prev = old.find((o) => o.name === (e.previousName ?? name));
      const apiKey = e.apiKey?.trim() || prev?.apiKey || '';
      return { name, protocol: e.protocol, base_url: e.baseUrl?.trim() || '', api_key: apiKey, models: e.models.map((m) => m.trim()).filter(Boolean), ...writePricing(e.pricing) };
    });
    const doc = await this.readSecrets();
    doc.ai = { ...(doc.ai ?? {}), endpoints };
    await atomicWrite(this.secretsPath, '# 密钥文件：Polygon key/secret 与 AI 端点。不要放进题目目录。\n\n' + stringify(doc) + '\n');
    return this.maskedAiEndpoints();
  }

  async readLanguages(): Promise<LanguagesResponse> {
    const text = await fsp.readFile(this.languagesPath, 'utf8');
    try {
      return { text, languages: parseLanguages(text) };
    } catch (e) {
      return { text, languages: {}, error: (e as Error).message };
    }
  }

  async writeLanguages(text: string): Promise<LanguagesResponse> {
    let languages: LanguagesConfig;
    try {
      languages = parseLanguages(text);
    } catch (e) {
      throw new HttpError(400, 'invalid_languages', (e as Error).message);
    }
    await atomicWrite(this.languagesPath, text);
    return { text, languages };
  }
}

/** Expand Windows 8.3 aliases before fs.watch (libuv can abort on mixed long/short paths). */
function canonicalRoot(value: string): string {
  const abs = path.resolve(value);
  try { return realpathSync.native(abs); }
  catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(canonicalRoot(parent), path.basename(abs));
  }
}

function parseLanguages(text: string): LanguagesConfig {
  const raw = parse(text) as Record<string, unknown>;
  const out: LanguagesConfig = {};
  for (const [id, v] of Object.entries(raw)) {
    const r = languageSchema.safeParse(v);
    if (!r.success) throw new Error(`[${id}]: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    out[id] = r.data;
  }
  return out;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** Map key for a directory: equal for paths that `samePath` treats as the same. */
export function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** [[ai.endpoints]] currency = "USD" and [ai.endpoints.prices."<model>"] input / output / cache_read / cache_write per 1M tokens. */
function readPricing(e: Record<string, any>): EndpointPricing | undefined {
  if (!e.prices || typeof e.prices !== 'object') return undefined;
  const prices: Record<string, ModelPrice> = {};
  for (const [model, p] of Object.entries(e.prices as Record<string, any>)) {
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    const input = num(p?.input);
    const output = num(p?.output);
    if (input === undefined || output === undefined) continue;
    prices[model] = { input, output, cacheRead: num(p?.cache_read), cacheWrite: num(p?.cache_write) };
  }
  return { currency: CURRENCIES.includes(e.currency) ? e.currency : 'USD', prices };
}

function writePricing(p: EndpointPricing | undefined): Record<string, unknown> {
  if (!p || !Object.keys(p.prices ?? {}).length) return {};
  const prices: Record<string, Record<string, number>> = {};
  for (const [model, v] of Object.entries(p.prices)) {
    const m = model.trim();
    if (!m || !(v.input >= 0) || !(v.output >= 0)) continue;
    prices[m] = { input: Number(v.input), output: Number(v.output), ...(v.cacheRead !== undefined && v.cacheRead !== null ? { cache_read: Number(v.cacheRead) } : {}), ...(v.cacheWrite !== undefined && v.cacheWrite !== null ? { cache_write: Number(v.cacheWrite) } : {}) };
  }
  return { currency: CURRENCIES.includes(p.currency) ? p.currency : 'USD', prices };
}
