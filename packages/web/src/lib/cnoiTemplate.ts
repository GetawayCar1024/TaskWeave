/** Small, explicit adaptations to the pinned upstream template; never change user text. */
export function cnoiTemplate(source: string, lang: string): string {
  source = source.replace(/\r\n/g, '\n');
  const patch = (from: string, to: string) => {
    if (!source.includes(from)) throw new Error(`CNOI template no longer matches the localization patch: ${from}`);
    source = source.replaceAll(from, to);
  };
  // Optional contents page (`pf_toc` in content.json): cover, overview tables and
  // instructions. Without it the first problem starts on the first page.
  const toc = 'data.at("pf_toc", default: true)';
  const cover = source.indexOf('#align(center)[');
  const coverEnd = source.indexOf('#set table(\n  stroke: (x, y)');
  if (cover < 0 || coverEnd < cover) throw new Error('CNOI template no longer matches the contents page patch');
  source = `${source.slice(0, cover)}#if ${toc} [\n${source.slice(cover, coverEnd)}]\n\n${source.slice(coverEnd)}`;
  patch('#include "extra-precaution.typ"', `#if ${toc} { v(1.2em); include "extra-precaution.typ" }`);
  patch('  pagebreak()\n  heading(level: 1', `  if ${toc} or i > 0 { pagebreak() }\n  heading(level: 1`);
  if (lang === 'zh') return source;
  const replacements: [string, string][] = [
    // Latin text: slightly tighter paragraphs than the CJK defaults.
    ['#set par(first-line-indent: (amount: 2em, all: true), spacing: 0.7em, leading: 0.7em)', '#set par(first-line-indent: (amount: 2em, all: true), spacing: 0.6em, leading: 0.65em)'],
    ['lang: "zh"', 'lang: "en"'],
    ['"时间："', '"Time: "'],
    ['"{}年{}月{}日{:02}:{:02}"', '"{}-{:02}-{:02} {:02}:{:02}"'],
    ['"{}年{}月{}日"', '"{}-{:02}-{:02} "'],
    ['[题目名称]', '[Problem]'], ['[题目类型]', '[Problem type]'], ['[目录]', '[Directory]'],
    ['[可执行文件名]', '[Executable]'], ['[输入文件名]', '[Input file]'], ['[输出文件名]', '[Output file]'],
    ['[每个测试点时限]', '[Time limit per test]'], ['[内存限制]', '[Memory limit]'],
    ['[测试点数目]', '[Test cases]'], ['[子任务数目]', '[Subtasks]'],
    ['[测试点是否等分 ]', '[Equal points per test]'], ['[预测试点数目]', '[Pretests]'],
    ['提交源程序文件名', 'Source file names'], ['编译选项', 'Compiler options'],
    ['[对于#context calc_language_name_content(data.support_languages.at(i).name)语言]', '[#data.support_languages.at(i).name]'],
    ['[对于#context calc_language_name_content(lang.name)语言]', '[#lang.name]'],
    ['#prob.title（#prob.name）', '#prob.title (#prob.name)'], ['#p.title（#p.name）', '#p.title (#p.name)'],
    ['[第 #(now) 页 ~~~~ 共 #link((page: total, x: 2.5cm, y: 1.5cm))[#text(fill: rgb("#0000ff"))[#(total)]] 页]', '[Page #(now) of #link((page: total, x: 2.5cm, y: 1.5cm))[#text(fill: rgb("#0000ff"))[#(total)]]]'],
  ];
  for (const [from, to] of replacements) patch(from, to);
  return source;
}

/**
 * Footnotes are endnotes of their section, as in the CF statements: marks are
 * private-use tokens in the Markdown, turned into Typst below.
 */
export const ENDNOTE = {
  ref: (mark: string) => `\uE010${mark}\uE011`,
  start: '\uE012',
  entry: (mark: string) => `\uE014${mark}\uE015`,
  end: '\uE013',
};

/** Upstream emits a paragraph break before a footnote's first paragraph.
 * In its two-column footnote grid that creates an empty line under the marker.
 * Section endnotes (see ENDNOTE) become a small block under a short rule. */
export function cnoiFootnotes(source: string): string {
  source = source.replace(/#footnote\[\s+/g, '#footnote[');
  source = source.replace(/#par\[#"\uE012"\]\n([\s\S]*?)#par\[#"\uE013"\]\n/g, (_, body: string) => {
    const parts = body.split(/#par\[#"\uE014([^"\uE015]*)\uE015"\]\n/);
    const cells: string[] = [];
    for (let i = 1; i < parts.length; i += 2) cells.push(`  super("${parts[i]}"), [${parts[i + 1].trim()}],\n`);
    return '#block(width: 100%, above: 1em, below: 1em)[\n#set text(size: 10pt)\n#set par(first-line-indent: 0pt, spacing: 0.5em)\n'
      + '#line(length: 25%, stroke: 0.4pt)\n#grid(columns: (auto, 1fr), column-gutter: 0.25em, row-gutter: 0.6em, align: (right + top, left + top),\n'
      + cells.join('') + ')\n]\n';
  });
  return source.replace(/\uE010([^\uE011"]*)\uE011/g, '"#super("$1")#"');
}
