/**
 * PolyForge desktop: the server runs in this (Electron main) process and the UI in one
 * window. There is no browser around it, so Ctrl+W / Ctrl+Shift+T and the other
 * shortcuts belong to PolyForge. The window opens maximized; F11 toggles fullscreen.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { startServer, type RunningServer } from '../../server/src/server.js';

// The 'electron' module has no ESM named exports for a bundled main: take them from the default.
const { app, BrowserWindow, dialog, Menu, shell, nativeTheme, ipcMain } = electron;
type BrowserWindow = InstanceType<typeof electron.BrowserWindow>;

const here = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;
let server: RunningServer | null = null;

ipcMain.on('polyforge:theme', (event, theme: unknown) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return;
  if (theme !== 'light' && theme !== 'dark') return;
  nativeTheme.themeSource = theme;
  win.setBackgroundColor(theme === 'light' ? '#f2f2f7' : '#1c1c1e');
});

// One PolyForge at a time: a second start focuses the running window.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

async function createWindow() {
  // No menu: its accelerators (Ctrl+W closes the window, Ctrl+R reloads, …) would take the keys.
  Menu.setApplicationMenu(null);
  try {
    // POLYFORGE_HOME: another global directory (tests, a second setup).
    server = await startServer({ home: process.env.POLYFORGE_HOME });
  } catch (e) {
    dialog.showErrorBox('PolyForge', `The server could not start:\n${(e as Error).message}`);
    app.quit();
    return;
  }
  nativeTheme.themeSource = server.global.config.ui?.theme === 'light' ? 'light' : 'dark';
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    title: 'PolyForge',
    icon: path.join(here, 'icon.png'),
    backgroundColor: nativeTheme.themeSource === 'light' ? '#f2f2f7' : '#1c1c1e',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true },
  });
  win = w;
  w.maximize();
  w.once('ready-to-show', () => w.show());

  // Pages of PolyForge stay in the app; everything else opens in the system browser.
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
    else if (input.key === 'F12' || (input.control && input.shift && key === 'i')) w.webContents.toggleDevTools();
    else if (input.key === 'F5') w.webContents.reload();
    else return;
    e.preventDefault();
  });
  w.on('page-title-updated', (e) => e.preventDefault());
  w.on('closed', () => (win = null));

  await w.loadURL(server.url);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', async () => {
  await server?.close().catch(() => {});
  app.quit();
});
