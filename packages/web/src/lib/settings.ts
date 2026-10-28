import { reactive } from 'vue';
import type { GlobalConfig } from '@polyforge/shared';
import { api } from './api';
import { setLocale } from '../i18n';

export const settings = reactive<{ loaded: boolean; config: GlobalConfig | null; globalDir: string; cpus?: number; defaultParallel?: number }>({
  loaded: false,
  config: null,
  globalDir: '',
});

export async function loadSettings() {
  const r = await api.settings();
  settings.config = r.config;
  settings.globalDir = r.globalDir;
  settings.cpus = r.cpus;
  settings.defaultParallel = r.defaultParallel;
  settings.loaded = true;
  setLocale(r.config.ui.locale);
}

let revision = 0;
let writes: Promise<unknown> = Promise.resolve();
export function applySettings(next: GlobalConfig) {
  revision++;
  settings.config = JSON.parse(JSON.stringify(next));
  setLocale(next.ui.locale);
}

export async function saveSettings(next: GlobalConfig, apply = true) {
  const snapshot = JSON.parse(JSON.stringify(next)) as GlobalConfig;
  if (apply) applySettings(snapshot);
  const version = revision;
  const request = writes.then(() => api.saveSettings(snapshot));
  writes = request.catch(() => {});
  const r = await request;
  if (version === revision) applySettings(r.config);
  return r.config;
}

export async function patchSettings(fn: (c: GlobalConfig) => void) {
  if (!settings.config) return;
  // structuredClone cannot clone reactive proxies.
  const next = JSON.parse(JSON.stringify(settings.config)) as GlobalConfig;
  fn(next);
  await saveSettings(next);
}
