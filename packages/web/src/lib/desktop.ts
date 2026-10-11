/** Set in the desktop app's window (its preload); undefined in a browser (development). */
export const desktop = (window as Window & { polyforgeDesktop?: { desktop: true; setTheme: (theme: 'light' | 'dark') => void } }).polyforgeDesktop;
