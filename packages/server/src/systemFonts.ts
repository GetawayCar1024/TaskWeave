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

/**
 * Substitutes from common Linux packages (fonts-noto-cjk, fonts-arphic, fonts-wqy, Droid),
 * loaded only when a template font is missing so Chinese text is never blank. Typst falls back
 * per glyph to them; the layout then differs slightly from the official NOI look.
 */
export const FALLBACK_FONTS = [
  { key: 'cjkserif', label: 'CJK serif', files: ['notoserifcjk-regular.ttc', 'notoserifcjksc-regular.otf', 'sourcehanserifsc-regular.otf', 'sourcehanserif-regular.ttc', 'uming.ttc', 'fandolsong-regular.otf'] },
  { key: 'cjksans', label: 'CJK sans', files: ['notosanscjk-regular.ttc', 'notosanscjksc-regular.otf', 'sourcehansanssc-regular.otf', 'sourcehansans-regular.ttc', 'wqy-zenhei.ttc', 'wqy-microhei.ttc', 'droidsansfallbackfull.ttf', 'msyh.ttc'] },
  { key: 'cjkkai', label: 'CJK kai', files: ['ukai.ttc', 'fandolkai-regular.otf', 'lxgwwenkai-regular.ttf'] },
] as const;

export function userFontDir(globalDir: string): string {
  return path.join(globalDir, 'fonts');
}

function fontDirs(globalDir: string): string[] {
  const dirs = [userFontDir(globalDir)];
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  } else {
    const home = process.env.HOME ?? '';
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.local/share/fonts'), path.join(home, '.fonts'), '/Library/Fonts', path.join(home, 'Library/Fonts'));
  }
  return dirs;
}

/** Font files below a folder (Linux keeps them in sub-folders), at most a few levels deep. */
async function fontFiles(dir: string, depth = 4): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, left: number) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && left > 0) await walk(p, left - 1);
      else if (e.isFile() || e.isSymbolicLink()) out.push(p);
    }
  };
  await walk(dir, depth);
  return out;
}

/** Absolute path of a font file, matching file names case-insensitively. */
export async function findSystemFont(globalDir: string, key: string): Promise<string | undefined> {
  const font = [...SYSTEM_FONTS, ...FALLBACK_FONTS].find(f => f.key === key);
  if (!font) return undefined;
  for (const dir of fontDirs(globalDir)) {
    const files = await fontFiles(dir, dir === userFontDir(globalDir) ? 0 : 4);
    for (const wanted of font.files) {
      const hit = files.find(f => path.basename(f).toLowerCase() === wanted);
      if (hit) return hit;
    }
  }
  return undefined;
}

export async function systemFontStatus(globalDir: string): Promise<SystemFontStatus> {
  const fonts = await Promise.all(SYSTEM_FONTS.map(async f => ({ key: f.key, family: f.family, label: f.label, found: !!(await findSystemFont(globalDir, f.key)) })));
  const fallbacks = await Promise.all(FALLBACK_FONTS.map(async f => { const file = await findSystemFont(globalDir, f.key); return { key: f.key, label: f.label, found: !!file, file: file ? path.basename(file) : undefined }; }));
  return { fonts, fallbacks, userDir: userFontDir(globalDir) };
}
