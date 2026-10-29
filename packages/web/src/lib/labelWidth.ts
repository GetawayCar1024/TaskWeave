import { computed } from 'vue';
import { i18n } from '../i18n';

/**
 * Fixed form label widths. Naive's label-width="auto" clears the inline width of a label that
 * mounts later (a field shown after a choice) and restores it only on that item's next render,
 * so the field jumps into alignment once the user types.
 */
export const labelWidth = (zh: number, en: number) => computed(() => String(i18n.global.locale.value).startsWith('zh') ? zh : en);
