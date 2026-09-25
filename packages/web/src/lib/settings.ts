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

export async function saveSettings(next: GlobalConfig) {
  const r = await api.saveSettings(next);
  settings.config = r.config;
  setLocale(r.config.ui.locale);
}

export async function patchSettings(fn: (c: GlobalConfig) => void) {
  if (!settings.config) return;
  // structuredClone cannot clone reactive proxies.
  const next = JSON.parse(JSON.stringify(settings.config)) as GlobalConfig;
  fn(next);
  await saveSettings(next);
}
