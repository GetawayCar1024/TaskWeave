/** Tells the UI it runs in the desktop app (window.polyforgeDesktop). */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('polyforgeDesktop', {
  desktop: true,
  setTheme: (theme: 'light' | 'dark') => ipcRenderer.send('polyforge:theme', theme),
  onCloseRequested: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('polyforge:request-close', listener);
    ipcRenderer.send('polyforge:close-ready');
    return () => ipcRenderer.removeListener('polyforge:request-close', listener);
  },
  confirmClose: () => ipcRenderer.send('polyforge:confirm-close'),
});
