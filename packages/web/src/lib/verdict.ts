import type { Verdict } from '@polyforge/shared';

type TagType = 'success' | 'info' | 'warning' | 'error' | 'default';

export function verdictType(v: Verdict | undefined): TagType {
  switch (v) {
    case 'OK':
      return 'success';
    case 'TL':
    case 'ML':
    case 'OL':
      return 'warning';
    case 'WA':
    case 'PE':
    case 'RE':
      return 'error';
    case 'FAIL':
    case 'IE':
      return 'info';
    default:
      return 'default';
  }
}

/** Cell background for the invocation matrix. */
export function verdictBg(v: Verdict): string {
  switch (verdictType(v)) {
    case 'success':
      return 'rgba(24, 160, 88, 0.22)';
    case 'warning':
      return 'rgba(240, 160, 32, 0.25)';
    case 'error':
      return 'rgba(208, 48, 80, 0.25)';
    case 'info':
      return 'rgba(112, 72, 232, 0.3)';
    default:
      return 'rgba(128, 128, 128, 0.12)';
  }
}

/** Cell class (global .pf-v-* in style.css): background and text colour for the verdict. */
export const verdictClass = (v: Verdict) => `pf-v-${verdictType(v)}`;

export const fmtMem = (kb: number) => (kb >= 1024 ? `${(kb / 1024).toFixed(kb >= 10240 ? 0 : 1)} MB` : `${kb} KB`);
