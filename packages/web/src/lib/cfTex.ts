/**
 * The TeX that Codeforces / Polygon renders in HTML statements ("Statements TeX
 * manual"), for editor completion and hover. `snippet` is Monaco snippet syntax
 * without the leading backslash; lists use two-space indented \item, like the lint fix.
 */
export interface CfTexCommand {
  name: string;
  snippet: string;
  zh: string;
  en: string;
  /** Only meaningful inside $…$. */
  math?: boolean;
}

const text = (name: string, zh: string, en: string): CfTexCommand => ({ name, snippet: `${name}{\${1}}`, zh, en });
const size = (name: string, zh: string, en: string): CfTexCommand => ({ name, snippet: `${name}{\${1}}`, zh: `字号：${zh}`, en: `Font size: ${en}` });
const env = (name: string, body: string, zh: string, en: string): CfTexCommand => ({ name: `begin{${name}}`, snippet: `begin{${name}}${body}\n\\end{${name}}`, zh, en });

export const CF_TEX: CfTexCommand[] = [
  text('textbf', '粗体', 'Bold text'),
  text('textit', '斜体', 'Italic text'),
  text('t', '等宽字体（Codeforces 常用）', 'Monospaced text (Codeforces style)'),
  text('texttt', '等宽字体', 'Monospaced text'),
  text('emph', '强调（斜体）', 'Emphasis (italic)'),
  text('underline', '下划线', 'Underlined text'),
  text('sout', '删除线', 'Strike-through text'),
  text('textsc', '小型大写字母', 'Small capitals'),
  { name: 'bf', snippet: 'bf ', zh: '之后的文字为粗体（旧写法，建议 \\textbf{…}）', en: 'Bold from here on (old style; prefer \\textbf{…})' },
  { name: 'it', snippet: 'it ', zh: '之后的文字为斜体（旧写法，建议 \\textit{…}）', en: 'Italic from here on (old style; prefer \\textit{…})' },
  { name: 'tt', snippet: 'tt ', zh: '之后的文字为等宽（旧写法，建议 \\t{…}）', en: 'Monospaced from here on (old style; prefer \\t{…})' },
  { name: 'verb', snippet: 'verb|${1}|', zh: '原样输出的代码片段', en: 'Verbatim fragment' },
  size('tiny', '最小', 'tiny'),
  size('scriptsize', '很小', 'script size'),
  size('small', '小', 'small'),
  size('normalsize', '正常', 'normal'),
  size('large', '大', 'large'),
  size('Large', '较大', 'Large'),
  size('LARGE', '很大', 'LARGE'),
  size('huge', '巨大', 'huge'),
  size('Huge', '最大', 'Huge'),
  env('itemize', '\n  \\item ${1}', '无序列表（\\item 缩进两个空格）', 'Bulleted list (\\item indented by two spaces)'),
  env('enumerate', '\n  \\item ${1}', '有序列表（\\item 缩进两个空格）', 'Numbered list (\\item indented by two spaces)'),
  env('center', '\n${1}', '居中', 'Centered block'),
  env('lstlisting', '\n${1}', '代码块（原样显示）', 'Code listing (verbatim)'),
  env('tabular', '{${1:|c|c|}}\n\\hline\n${2} & ${3} \\\\\\\\\n\\hline', '表格，列格式如 |c|c|', 'Table; column spec like |c|c|'),
  { name: 'item', snippet: 'item ${1}', zh: '列表项', en: 'List item' },
  { name: 'hline', snippet: 'hline', zh: '表格横线', en: 'Horizontal table rule' },
  { name: 'cline', snippet: 'cline{${1:1}-${2:2}}', zh: '表格中跨若干列的横线', en: 'Table rule over some columns' },
  { name: 'multicolumn', snippet: 'multicolumn{${1:2}}{${2:|c|}}{${3}}', zh: '合并多列的单元格', en: 'Cell spanning several columns' },
  { name: 'multirow', snippet: 'multirow{${1:2}}{*}{${2}}', zh: '合并多行的单元格', en: 'Cell spanning several rows' },
  { name: 'url', snippet: 'url{${1}}', zh: '链接（显示网址）', en: 'Link showing the URL' },
  { name: 'href', snippet: 'href{${1:url}}{${2:text}}', zh: '带文字的链接', en: 'Link with text' },
  { name: 'includegraphics', snippet: 'includegraphics[width=${1:6cm}]{${2:image.png}}', zh: '插入图片（放在 statement/images/）', en: 'Image (from statement/images/)' },
  { name: 'epigraph', snippet: 'epigraph{${1:text}}{${2:source}}', zh: '题记：引文与出处（右对齐）', en: 'Epigraph: quotation and source' },
  { name: 'footnote', snippet: 'footnote{${1}}', zh: '脚注（Codeforces 用 ∗ † ‡ … 标记）', en: 'Footnote (marked ∗ † ‡ … on Codeforces)' },
  { name: 'def', snippet: 'def\\\\${1:name}{${2}}', zh: '定义宏', en: 'Define a macro' },
  { name: 'htmlPixelsInCm', snippet: 'htmlPixelsInCm{${1:40}}', zh: 'HTML 中 1cm 对应的像素数（影响图片尺寸）', en: 'Pixels per cm in HTML (image sizes)' },
  // Common inside formulas (MathJax renders any math; these are the usual ones in statements).
  ...(
    [
      ['le', '≤'], ['ge', '≥'], ['ne', '≠'], ['lt', '<'], ['gt', '>'], ['cdot', '·'], ['times', '×'], ['ldots', '…'], ['cdots', '⋯'],
      ['oplus', '⊕ 异或 / xor'], ['bmod', 'mod'], ['pmod', '(mod n)'], ['gcd', 'gcd'], ['lcm', 'lcm'], ['max', 'max'], ['min', 'min'], ['log', 'log'],
      ['infty', '∞'], ['in', '∈'], ['notin', '∉'], ['subseteq', '⊆'], ['cup', '∪'], ['cap', '∩'], ['emptyset', '∅'], ['to', '→'], ['leftarrow', '←'],
      ['oplus', '⊕'], ['land', '∧'], ['lor', '∨'], ['neg', '¬'], ['forall', '∀'], ['exists', '∃'], ['equiv', '≡'], ['approx', '≈'], ['pm', '±'],
    ] as const
  ).map(([name, sym]): CfTexCommand => ({ name, snippet: name, zh: `公式符号 ${sym}`, en: `Math symbol ${sym}`, math: true })),
  { name: 'frac', snippet: 'frac{${1}}{${2}}', zh: '分数', en: 'Fraction', math: true },
  { name: 'sqrt', snippet: 'sqrt{${1}}', zh: '根号', en: 'Square root', math: true },
  { name: 'sum', snippet: 'sum_{${1:i=1}}^{${2:n}}', zh: '求和', en: 'Sum', math: true },
  { name: 'prod', snippet: 'prod_{${1:i=1}}^{${2:n}}', zh: '连乘', en: 'Product', math: true },
  { name: 'lfloor', snippet: 'lfloor ${1} \\rfloor', zh: '向下取整 ⌊ ⌋', en: 'Floor ⌊ ⌋', math: true },
  { name: 'lceil', snippet: 'lceil ${1} \\rceil', zh: '向上取整 ⌈ ⌉', en: 'Ceiling ⌈ ⌉', math: true },
  { name: 'binom', snippet: 'binom{${1:n}}{${2:k}}', zh: '组合数', en: 'Binomial coefficient', math: true },
  { name: 'operatorname', snippet: 'operatorname{${1}}', zh: '自定义运算符名（如 mex）', en: 'Operator name (e.g. mex)', math: true },
  { name: 'texttt', snippet: 'texttt{${1}}', zh: '公式中的等宽文字（如字符串）', en: 'Monospaced text in a formula (strings)', math: true },
  { name: 'text', snippet: 'text{${1}}', zh: '公式中的普通文字', en: 'Plain text in a formula', math: true },
].filter((c, i, all) => all.findIndex((d) => d.name === c.name && !!d.math === !!c.math) === i);
