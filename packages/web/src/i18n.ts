import { createI18n } from 'vue-i18n';
import type { UiLocale } from '@polyforge/shared';
import zhCN from './locales/zh-CN.json';
import en from './locales/en.json';

export const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'en',
  messages: { 'zh-CN': zhCN, en },
});

export function setLocale(l: UiLocale) {
  i18n.global.locale.value = l;
  document.documentElement.lang = l;
}
