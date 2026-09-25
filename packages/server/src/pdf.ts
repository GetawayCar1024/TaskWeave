import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exists, HttpError } from './util/fs.js';

/**
 * PDF export through the locally installed Edge / Chrome in headless mode: the print
 * page is rendered exactly as in the browser, with its @page size and margins and
 * without the browser's own headers and footers (which the print dialog adds and
 * which change the margins).
 */
export async function findBrowser(): Promise<string | null> {
  const env = process.env.POLYFORGE_BROWSER;
  if (env && (await exists(env))) return env;
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const candidates = [
    ...pf.map((d) => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...pf.map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

export async function printToPdf(url: string): Promise<Buffer> {
  const browser = await findBrowser();
  if (!browser) throw new HttpError(501, 'no_browser', 'No Edge or Chrome found for PDF export (set POLYFORGE_BROWSER to its path)');
  const dir = path.join(os.tmpdir(), `polyforge-pdf-${randomBytes(6).toString('hex')}`);
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, 'out.pdf');
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        browser,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          `--user-data-dir=${path.join(dir, 'profile')}`,
          '--no-pdf-header-footer',
          // Let the page load its data and render formulas before printing.
          '--virtual-time-budget=20000',
          `--print-to-pdf=${out}`,
          url,
        ],
        { timeout: 90_000, windowsHide: true },
        (err) => (err && !(err as { killed?: boolean }).killed ? reject(err) : resolve()),
      );
    });
    if (!(await exists(out))) throw new HttpError(500, 'pdf_failed', 'The browser did not produce a PDF');
    return await fsp.readFile(out);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
