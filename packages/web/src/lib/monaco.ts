import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker();
    return new EditorWorker();
  },
};

/** Minimal Polygon-LaTeX highlighting for statement files. */
monaco.languages.register({ id: 'latex', extensions: ['.tex'], aliases: ['LaTeX'] });
monaco.languages.setMonarchTokensProvider('latex', {
  tokenizer: {
    root: [
      [/%.*$/, 'comment'],
      [/\$\$/, { token: 'string', next: '@displaymath' }],
      [/\$/, { token: 'string', next: '@math' }],
      // With groups, every character of the match must be in a group (backslash included).
      [/(\\(?:begin|end))(\{)([^}]*)(\})/, ['keyword', 'delimiter', 'type', 'delimiter']],
      [/\\Def[A-Za-z]*/, 'type.identifier'],
      [/\\[A-Za-z@]+/, 'keyword'],
      [/\\./, 'keyword'],
      [/[{}[\]]/, 'delimiter'],
      [/~|--?-?|``|''/, 'operator'],
    ],
    math: [
      [/\\\$/, 'string'],
      [/\$/, { token: 'string', next: '@pop' }],
      [/\\[A-Za-z]+/, 'string.escape'],
      [/./, 'string'],
    ],
    displaymath: [
      [/\$\$/, { token: 'string', next: '@pop' }],
      [/\\[A-Za-z]+/, 'string.escape'],
      [/./, 'string'],
    ],
  },
});
monaco.languages.setLanguageConfiguration('latex', {
  comments: { lineComment: '%' },
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '$', close: '$' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '$', close: '$' },
  ],
});

/** TOML (problem.toml, languages.toml). Monaco has no built-in TOML. */
monaco.languages.register({ id: 'toml', extensions: ['.toml'], aliases: ['TOML'] });
monaco.languages.setMonarchTokensProvider('toml', {
  tokenizer: {
    root: [
      [/#.*$/, 'comment'],
      [/^\s*\[\[[^\]]*\]\]/, 'type'],
      [/^\s*\[[^\]]*\]/, 'type'],
      [/[A-Za-z0-9_.-]+(?=\s*=)/, 'variable'],
      [/"""/, { token: 'string', next: '@mlstring' }],
      [/'''/, { token: 'string', next: '@mlrawstring' }],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'[^']*'/, 'string'],
      [/\b(true|false)\b/, 'keyword'],
      [/[+-]?\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/, 'number'],
    ],
    mlstring: [
      [/"""/, { token: 'string', next: '@pop' }],
      [/./, 'string'],
    ],
    mlrawstring: [
      [/'''/, { token: 'string', next: '@pop' }],
      [/./, 'string'],
    ],
  },
});
monaco.languages.setLanguageConfiguration('toml', {
  comments: { lineComment: '#' },
  brackets: [
    ['[', ']'],
    ['{', '}'],
  ],
  autoClosingPairs: [
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: '"', close: '"' },
  ],
});

const EXT_LANG: Record<string, string> = {
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'cpp', c: 'c',
  py: 'python', java: 'java', kt: 'kotlin', rs: 'rust', go: 'go', pas: 'pascal', js: 'javascript', ts: 'typescript',
  tex: 'latex', toml: 'toml', json: 'json', md: 'markdown', html: 'html', css: 'css', sh: 'shell', bat: 'bat',
};

export function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG[ext] ?? 'plaintext';
}

export { monaco };
