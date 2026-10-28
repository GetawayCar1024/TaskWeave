/** Set in the desktop app's window (its preload); undefined in a browser (development). */
export const desktop = (window as Window & { taskweaveDesktop?: { desktop: true; setTheme: (theme: 'light' | 'dark') => void; onCloseRequested: (callback: () => void) => () => void; confirmClose: () => void; printToPdf?: (name: string) => Promise<string | null> } }).taskweaveDesktop;
