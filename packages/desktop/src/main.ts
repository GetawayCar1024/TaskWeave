/**
 * TaskWeave desktop: the server runs in this (Electron main) process and the UI in one
 * window. There is no browser around it, so Ctrl+W / Ctrl+Shift+T and the other
 * shortcuts belong to TaskWeave. The window opens maximized; F11 toggles fullscreen.
 */
import { promises as fsp, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { startServer, type RunningServer } from '../../server/src/server.js';
import { legacyEnv } from '@taskweave/shared';
import { migrateDesktopProfile } from '../../server/src/workspace/migrateNames.js';

// The 'electron' module has no ESM named exports for a bundled main: take them from the default.
const { app, BrowserWindow, dialog, Menu, shell, nativeTheme, ipcMain } = electron;
type BrowserWindow = InstanceType<typeof electron.BrowserWindow>;

const here = path.dirname(fileURLToPath(import.meta.url));
app.setName('TaskWeave');
// New identifiers use the product name; existing profile data is moved on upgrade.
if (process.platform === 'win32') app.setAppUserModelId('dev.taskweave.desktop');
const customHome = process.env.TASKWEAVE_HOME || process.env[legacyEnv('HOME')];
if (customHome) {
  const profile = path.resolve(customHome, 'desktop');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
} else {
  const profile = migrateDesktopProfile(app.getPath('appData'));
  mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
}
let win: BrowserWindow | null = null;
let server: RunningServer | null = null;
let closeApproved = false;
let rendererReady = false;
ipcMain.on('taskweave:close-ready', event => { if (event.sender === win?.webContents && event.senderFrame === win.webContents.mainFrame) rendererReady = true; });
ipcMain.on('taskweave:confirm-close', event => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return;
  closeApproved = true;
  win.close();
});

// PDF export of the print view: Chromium's own PDF output keeps text selectable and
// links clickable (the system print dialog can rasterize pages and drops links).
ipcMain.handle('taskweave:print-pdf', async (event, name: unknown) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return null;
  const file = typeof name === 'string' && /^[^\\/:*?"<>|\r\n]{1,200}$/.test(name) ? name : 'document';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), `${file}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  const data = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, generateDocumentOutline: true });
  await fsp.writeFile(filePath, data);
  return filePath;
});

ipcMain.on('taskweave:theme', (event, theme: unknown) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return;
  if (theme !== 'light' && theme !== 'dark') return;
  nativeTheme.themeSource = theme;
  win.setBackgroundColor(theme === 'light' ? '#f2f2f7' : '#1c1c1e');
});

// One instance per profile: a second start focuses the running window.
// app.quit() is asynchronous: the second instance must never reach startServer().
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

async function createWindow() {
  if (!primary) return;
  // No menu: its accelerators (Ctrl+W closes the window, Ctrl+R reloads, …) would take the keys.
  Menu.setApplicationMenu(null);
  try {
    // The server resolves the configured profile and its upgrade aliases.
    server = await startServer();
  } catch (e) {
    dialog.showErrorBox('TaskWeave', `The server could not start:\n${(e as Error).message}`);
    app.quit();
    return;
  }
  nativeTheme.themeSource = server.global.config.ui?.theme === 'light' ? 'light' : 'dark';
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    title: 'TaskWeave',
    icon: path.join(here, 'icon.png'),
    backgroundColor: nativeTheme.themeSource === 'light' ? '#f2f2f7' : '#1c1c1e',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, devTools: !app.isPackaged },
  });
  win = w;
  w.maximize();
  w.once('ready-to-show', () => w.show());

  // Pages of TaskWeave stay in the app; everything else opens in the system browser.
  const origin = new URL(server.url).origin;
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(origin)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(origin)) return;
    e.preventDefault();
    void shell.openExternal(url);
  });

  // The few keys the app itself handles: F11 fullscreen, F12 / Ctrl+Shift+I devtools, F5 reload.
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (input.key === 'F11') w.setFullScreen(!w.isFullScreen());
    else if (input.key === 'F12' || (input.control && input.shift && key === 'i')) { if (!app.isPackaged) w.webContents.toggleDevTools(); }
    else if (input.key === 'F5') w.webContents.reload();
    else return;
    e.preventDefault();
  });
  w.on('page-title-updated', (e) => e.preventDefault());
  w.on('closed', () => (win = null));
  w.on('close', e => {
    if (closeApproved || !rendererReady || w.webContents.isCrashed()) return;
    e.preventDefault();
    w.webContents.send('taskweave:request-close');
  });

  await w.loadURL(server.url);
}

if (primary) app.whenReady().then(createWindow);
app.on('window-all-closed', async () => {
  await server?.close().catch(() => {});
  app.quit();
});
