import { i18n } from '../i18n';
import { lintMessage } from './serverText';
import { lintStatement } from '@polyforge/shared';
import { getDefs } from './defs';
import { buildMacros, macroPreview, type MacroTable } from './latex';
import { CF_TEX } from './cfTex';
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
        // Arguments with a default are optional [..] arguments (Codeforces defs); required ones {..}.
        insertText:
          mac.name +
          mac.args
            .map((a, i) => {
              const ph = `\${${i + 1}:${a.replace(/[$}\\]/g, '\\$&') || `arg${i + 1}`}}`;
              return a ? `[${ph}]` : `{${ph}}`;
            })
            .join(''),
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
      }));
      return { suggestions };
    },
  });

  // Codeforces / Polygon statement TeX: text commands, environments, and math inside $…$.
  const zhUi = () => i18n.global.locale.value.startsWith('zh');
  const inMath = (before: string) => (before.replace(/\\\$/g, '').match(/\$/g)?.length ?? 0) % 2 === 1;
  monaco.languages.registerCompletionItemProvider('latex', {
    triggerCharacters: ['\\'],
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const m = line.match(/\\([A-Za-z{]*)$/);
      if (!m) return { suggestions: [] };
      const range = new monaco.Range(position.lineNumber, position.column - m[1].length, position.lineNumber, position.column);
      // "\begin{" auto-closed its brace: the environment snippet brings its own, so drop that "}".
      const after = model.getLineContent(position.lineNumber).charAt(position.column - 1);
      const dropBrace =
        m[1].includes('{') && after === '}' ? [{ range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column + 1), text: '' }] : undefined;
      const math = inMath(line.slice(0, line.length - m[0].length));
      return {
        suggestions: CF_TEX.filter((c) => !!c.math === math).map((c) => ({
          label: c.name,
          kind: c.name.startsWith('begin{') ? monaco.languages.CompletionItemKind.Module : monaco.languages.CompletionItemKind.Keyword,
          detail: zhUi() ? c.zh : c.en,
          insertText: c.snippet,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          additionalTextEdits: c.name.startsWith('begin{') ? dropBrace : undefined,
          // After the defs.toml macros of the problem-setter's own library.
          sortText: `1${c.name}`,
          range,
        })),
        // Ask again as the user types, so "\begin{" sees the brace it auto-closed.
        incomplete: true,
      };
    },
  });
  monaco.languages.registerHoverProvider('latex', {
    provideHover(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const re = /\\(begin\{[a-z]+\}|[A-Za-z]+)/g;
      for (let m; (m = re.exec(line)); ) {
        const start = m.index + 1;
        const end = start + m[0].length;
        if (position.column < start || position.column > end) continue;
        const math = inMath(line.slice(0, m.index));
        const c = CF_TEX.find((x) => x.name === m![1] && !!x.math === math) ?? CF_TEX.find((x) => x.name === m![1]);
        if (!c) return null;
        return { range: new monaco.Range(position.lineNumber, start, position.lineNumber, end), contents: [{ value: `**\\${c.name}** — ${zhUi() ? c.zh : c.en}` }] };
      }
      return null;
    },
  });

  monaco.languages.registerHoverProvider('latex', {
    async provideHover(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const re = /\\([A-Za-z]+)/g;
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
    const { issues } = lintStatement(model.getValue(), { lang, allowMarkdown: true });
    monaco.editor.setModelMarkers(
      model,
      'polyforge-lint',
      issues.map((i) => ({
        severity: i.fixable ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Warning,
        message: lintMessage(i) + (i.fixable ? (i18n.global.locale.value.startsWith('zh') ? '（可自动修复）' : ' (auto-fixable)') : ''),
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
