import { lintStatement } from '@polyforge/shared';
import { getDefs } from './defs';
import { buildMacros, macroPreview, type MacroTable } from './latex';
import { monaco } from './monaco';

let registered = false;

/** Language of a statement model from its path: statement/<lang>/x.tex. */
function langOf(model: monaco.editor.ITextModel): string {
  return model.uri.path.match(/\/statement\/(\w+)\//)?.[1] ?? 'en';
}

/** Completion and hover for defs.toml macros (`\DefSubsequence` …) in .tex files. */
export function registerLatexMacros() {
  if (registered) return;
  registered = true;
  const tables = new Map<string, MacroTable>();
  const macrosFor = async (lang: string) => {
    if (!tables.has(lang)) tables.set(lang, buildMacros(await getDefs(), lang));
    return tables.get(lang)!;
  };

  monaco.languages.registerCompletionItemProvider('latex', {
    triggerCharacters: ['\\'],
    async provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const m = line.match(/\\([A-Za-z]*)$/);
      if (!m) return { suggestions: [] };
      const range = new monaco.Range(position.lineNumber, position.column - m[1].length, position.lineNumber, position.column);
      const macros = await macrosFor(langOf(model));
      const suggestions = [...macros.values()].map((mac) => ({
        label: mac.name,
        kind: monaco.languages.CompletionItemKind.Function,
        detail: mac.args.length ? `${mac.args.length} arg(s): ${mac.args.map((a) => a || '…').join(', ')}` : 'no arguments',
        documentation: macroPreview(mac),
        insertText: mac.name + mac.args.map((a, i) => `{\${${i + 1}:${a.replace(/[$}\\]/g, '\\$&') || `arg${i + 1}`}}}`).join(''),
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
      }));
      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider('latex', {
    async provideHover(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const re = /\\(Def[A-Za-z]*)/g;
      for (let m; (m = re.exec(line)); ) {
        const start = m.index + 1;
        const end = start + m[0].length;
        if (position.column < start || position.column > end) continue;
        const mac = (await macrosFor(langOf(model))).get(m[1]);
        if (!mac) return null;
        return {
          range: new monaco.Range(position.lineNumber, start, position.lineNumber, end),
          contents: [{ value: `**\\${mac.name}**` }, { value: macroPreview(mac) }],
        };
      }
      return null;
    },
  });
}

/** Show statement lint issues as editor warnings while typing (statement/<lang>/*.tex). */
export function attachStatementLint(model: monaco.editor.ITextModel, lang: string): monaco.IDisposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    if (model.isDisposed()) return;
    const { issues } = lintStatement(model.getValue(), { lang });
    monaco.editor.setModelMarkers(
      model,
      'polyforge-lint',
      issues.map((i) => ({
        severity: i.fixable ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Warning,
        message: i.message + (i.fixable ? ' (auto-fixable)' : ''),
        startLineNumber: i.line,
        startColumn: i.col,
        endLineNumber: i.line,
        endColumn: Math.min(i.col + 3, model.getLineMaxColumn(Math.min(i.line, model.getLineCount()))),
      })),
    );
  };
  update();
  const sub = model.onDidChangeContent(() => {
    clearTimeout(timer);
    timer = setTimeout(update, 400);
  });
  return { dispose: () => (clearTimeout(timer), sub.dispose()) };
}
