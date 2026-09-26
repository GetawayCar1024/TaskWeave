/** Tells the UI it runs in the desktop app (window.polyforgeDesktop). */
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('polyforgeDesktop', { desktop: true });
