import { isSourceFile } from '@taskweave/shared';
import type { monaco } from './monaco';
import { settings } from './settings';

/** Options every Monaco editor shares at creation (problem workspace, contest files, settings). */
export const EDITOR_BASE_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  scrollBeyondLastLine: false,
  fontFamily: "Consolas, 'Cascadia Code', 'Courier New', monospace",
  renderWhitespace: 'selection',
};

export interface EditorTabItem {
  path: string;
  label: string;
  hint?: string;
  dirty: boolean;
  readOnly?: boolean;
  gone?: boolean;
}

/**
 * Tabs with the same name (statement/zh/input.tex, statement/en/input.tex) get the
 * shortest part of their folder that tells them apart, as a dim hint: "zh", "en".
 */
export function tabHints(paths: string[], label: (path: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const p of paths) groups.set(label(p), [...(groups.get(label(p)) ?? []), p]);
  for (const same of groups.values()) {
    if (same.length < 2) continue;
    const dirs = same.map((p) => p.split('/').slice(0, -1));
    const max = Math.max(...dirs.map((d) => d.length));
    for (let depth = 1; depth <= max; depth++) {
      const tails = dirs.map((d) => d.slice(-depth).join('/'));
      if (new Set(tails).size === tails.length || depth === max) {
        same.forEach((p, i) => out.set(p, tails[i] || '/'));
        break;
      }
    }
  }
  return out;
}

/** Font, tabs, wrapping, minimap and theme from the editor settings; prose files always wrap. */
export function editorOptions(path: string): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  const ed = settings.config?.editor;
  return {
    fontSize: ed?.font_size ?? 14,
    tabSize: ed?.tab_size ?? 4,
    wordWrap: ed?.word_wrap || !isSourceFile(path) ? 'on' : 'off',
    minimap: { enabled: !!ed?.minimap },
    theme: settings.config?.ui.theme === 'light' ? 'vs' : 'vs-dark',
  };
}
