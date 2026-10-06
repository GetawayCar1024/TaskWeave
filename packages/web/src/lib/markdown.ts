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
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
      `<a href="${url.replace(/"/g, '&quot;').replace(/'/g, '&#39;')}" target="_blank" rel="noopener noreferrer">${label}</a>`);
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
    const lines = esc(part).split('\n');
    const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim());
    for (let row = 0; row < lines.length; row++) {
      const raw = lines[row];
      const line = raw.trimEnd();
      if (line.includes('|') && lines[row + 1]?.includes('-') && cells(lines[row + 1]).every(c => /^:?-{3,}:?$/.test(c))) {
        if (list) { out.push('</ul>'); list = false; }
        out.push('<table><thead><tr>' + cells(line).map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
        row++;
        while (row + 1 < lines.length && lines[row + 1].includes('|') && lines[row + 1].trim()) {
          out.push('<tr>' + cells(lines[++row]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
        }
        out.push('</tbody></table>');
        continue;
      }
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
      else if (line.startsWith('&gt; ')) out.push(`<blockquote>${inline(line.slice(5))}</blockquote>`);
      else if (line) out.push(`<div>${inline(line)}</div>`);
      else out.push('<div class="md-gap"></div>');
    }
    if (list) out.push('</ul>');
  });
  return out.join('');
}
