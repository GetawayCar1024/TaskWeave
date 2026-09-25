/**
 * Minimal Markdown for agent replies: fenced code, inline code, bold, italics,
 * headings and bullet lists. Everything is escaped first, so model output cannot
 * inject HTML.
 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
}

export function renderMarkdown(src: string): string {
  const out: string[] = [];
  const parts = src.split(/```[\w+-]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre class="md-code">${esc(part.replace(/\n$/, ''))}</pre>`);
      return;
    }
    let list = false;
    for (const raw of esc(part).split('\n')) {
      const line = raw.trimEnd();
      const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      if (li) {
        if (!list) out.push('<ul>');
        list = true;
        out.push(`<li>${inline(li[1])}</li>`);
        continue;
      }
      if (list) {
        out.push('</ul>');
        list = false;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) out.push(`<div class="md-h">${inline(h[2])}</div>`);
      else if (line) out.push(`<div>${inline(line)}</div>`);
      else out.push('<div class="md-gap"></div>');
    }
    if (list) out.push('</ul>');
  });
  return out.join('');
}
