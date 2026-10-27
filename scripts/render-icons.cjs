/** Isolated Electron renderer used by build-icons.mjs. */
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');
app.disableHardwareAcceleration();
app.setPath('userData', process.argv[3]);
app.whenReady().then(async () => {
  const svg = readFileSync(process.argv[2], 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const images = await win.webContents.executeJavaScript(`(async () => {
    const url = URL.createObjectURL(new Blob([${JSON.stringify(svg)}], { type: 'image/svg+xml' }));
    const image = new Image(); image.src = url; await image.decode();
    const out = {};
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image, 0, 0, size, size);
      out[size] = canvas.toDataURL('image/png').split(',')[1];
    }
    URL.revokeObjectURL(url); return out;
  })()`);
  process.stdout.write(JSON.stringify(images), () => app.exit(0));
}).catch(error => { console.error(error); app.exit(1); });
