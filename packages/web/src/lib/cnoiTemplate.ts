/** Small, explicit adaptations to the pinned upstream template; never change user text. */
export function cnoiTemplate(source: string, lang: string): string {
  if (lang === 'zh') return source;
  const replacements: [string, string][] = [
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
  for (const [from, to] of replacements) {
    if (!source.includes(from)) throw new Error(`CNOI template no longer matches the localization patch: ${from}`);
    source = source.replaceAll(from, to);
  }
  return source;
}

/** Upstream emits a paragraph break before a footnote's first paragraph.
 * In its two-column footnote grid that creates an empty line under the marker. */
export function cnoiFootnotes(source: string): string {
  return source.replace(/#footnote\[\s+/g, '#footnote[');
}
