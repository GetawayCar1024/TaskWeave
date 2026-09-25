import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'smol-toml';
import {
  globalConfigSchema,
  languageSchema,
  type GlobalConfig,
  type LanguagesConfig,
  type LanguagesResponse,
} from '@polyforge/shared';
import { atomicWrite, copyMissing, exists, HttpError } from './util/fs.js';

/** Repository `assets/` directory, bundled defaults copied into the global directory. */
export const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets');

export function defaultGlobalDir(): string {
  return process.env.POLYFORGE_HOME || path.join(os.homedir(), '.polyforge');
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
    for (const f of ['config.toml', 'languages.toml', 'secrets.toml']) {
      const dest = path.join(this.dir, f);
      if (!(await exists(dest))) await fsp.copyFile(path.join(ASSETS_DIR, f), dest);
    }
    await fsp.mkdir(path.join(this.cacheDir, 'bin'), { recursive: true });
    await this.loadConfig();
  }

  async loadConfig(): Promise<GlobalConfig> {
    const text = await fsp.readFile(this.configPath, 'utf8');
    let raw: unknown;
    try {
      raw = parse(text);
    } catch (e) {
      console.warn(`[polyforge] config.toml is invalid, using defaults: ${(e as Error).message}`);
      raw = {};
    }
    const parsed = globalConfigSchema.safeParse(raw);
    this.config = parsed.success ? parsed.data : globalConfigSchema.parse({});
    return this.config;
  }

  async saveConfig(next: unknown): Promise<GlobalConfig> {
    const parsed = globalConfigSchema.safeParse(next);
    if (!parsed.success) throw new HttpError(400, 'invalid_config', parsed.error.message);
    const roots: string[] = [];
    for (const r of parsed.data.problems.roots) {
      if (!path.isAbsolute(r)) throw new HttpError(400, 'invalid_root', `Root must be an absolute path: ${r}`);
      const norm = path.resolve(r);
      if (!roots.some((x) => samePath(x, norm))) roots.push(norm);
    }
    parsed.data.problems.roots = roots;
    await atomicWrite(this.configPath, '# PolyForge 全局配置\n\n' + stringify(parsed.data) + '\n');
    this.config = parsed.data;
    return this.config;
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
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}
