/** Tells the UI it runs in the desktop app (window.taskweaveDesktop). */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('taskweaveDesktop', {
  desktop: true,
  setTheme: (theme: 'light' | 'dark') => ipcRenderer.send('taskweave:theme', theme),
  onCloseRequested: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('taskweave:request-close', listener);
    ipcRenderer.send('taskweave:close-ready');
    return () => ipcRenderer.removeListener('taskweave:request-close', listener);
  },
  confirmClose: () => ipcRenderer.send('taskweave:confirm-close'),
  /** Saves the current page as PDF (print media); resolves to the path, or null when cancelled. */
  printToPdf: (name: string): Promise<string | null> => ipcRenderer.invoke('taskweave:print-pdf', name),
});
