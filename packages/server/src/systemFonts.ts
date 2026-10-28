import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { SystemFontStatus } from '@taskweave/shared';

/**
 * Fonts of the OI (CNOI) template that may not be redistributed (Microsoft-supplied
 * fonts by Beijing ZhongYi). They are read from the user's own system instead of being
 * bundled; `<global dir>/fonts/` is searched first so users can supply them there.
 */
export const SYSTEM_FONTS = [
  { key: 'simsun', family: 'SimSun', label: '宋体', files: ['simsun.ttc', 'simsun.ttf'] },
  { key: 'simhei', family: 'SimHei', label: '黑体', files: ['simhei.ttf'] },
  { key: 'simkai', family: 'KaiTi', label: '楷体', files: ['simkai.ttf'] },
] as const;

export function userFontDir(globalDir: string): string {
  return path.join(globalDir, 'fonts');
}

function fontDirs(globalDir: string): string[] {
  const dirs = [userFontDir(globalDir)];
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  }
  return dirs;
}

/** Absolute path of a font file, matching file names case-insensitively. */
export async function findSystemFont(globalDir: string, key: string): Promise<string | undefined> {
  const font = SYSTEM_FONTS.find(f => f.key === key);
  if (!font) return undefined;
  for (const dir of fontDirs(globalDir)) {
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    for (const wanted of font.files) {
      const hit = names.find(n => n.toLowerCase() === wanted);
      if (hit) return path.join(dir, hit);
    }
  }
  return undefined;
}

export async function systemFontStatus(globalDir: string): Promise<SystemFontStatus> {
  const fonts = await Promise.all(SYSTEM_FONTS.map(async f => ({ key: f.key, family: f.family, label: f.label, found: !!(await findSystemFont(globalDir, f.key)) })));
  return { fonts, userDir: userFontDir(globalDir) };
}
