/** Tells the UI it runs in the desktop app (window.polyforgeDesktop). */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('polyforgeDesktop', {
  desktop: true,
  setTheme: (theme: 'light' | 'dark') => ipcRenderer.send('polyforge:theme', theme),
});
