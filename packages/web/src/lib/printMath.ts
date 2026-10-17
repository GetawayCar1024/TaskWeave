import katex from 'katex';

/** Split only between top-level terms; nested structures are kept indivisible. */
export function mathTerms(tex: string): string[] {
  if (/\\(?:begin|left|right)\b/.test(tex)) return [tex];
  const terms: string[] = [];
  let braces = 0, brackets = 0, start = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === '{') braces++;
    else if (c === '}') braces--;
    else if (c === '(' || c === '[') brackets++;
    else if (c === ')' || c === ']') brackets--;
    if (!braces && !brackets && i > start && (/[=+−-]/.test(c) || /^\\(?:leq?|geq?|neq|approx)\b/.test(tex.slice(i)))) { terms.push(tex.slice(start, i)); start = i; }
    if (c === '\\') { const m = tex.slice(i).match(/^\\(?:[a-zA-Z]+|.)/); if (m) i += m[0].length - 1; }
  }
  terms.push(tex.slice(start));
  return terms;
}

export function fitPrintMath(root: HTMLElement): number {
  let overflow = 0;
  for (const box of root.querySelectorAll<HTMLElement>('.math-display')) {
    const original = box.dataset.originalTex ?? box.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (!original) continue;
    box.dataset.originalTex = original;
    box.style.fontSize = '';
    const render = (tex: string) => katex.renderToString(tex, { displayMode: true, throwOnError: true, output: 'htmlAndMathml' });
    try {
      box.innerHTML = render(original);
      const width = () => {
        const html = box.querySelector<HTMLElement>('.katex-html');
        if (!html) return 0;
        // KaTeX's display wrapper is a full-width block even when its contents
        // overflow. Measure the formula itself, not that constrained wrapper.
        const range = document.createRange();
        range.selectNodeContents(html);
        return range.getBoundingClientRect().width;
      };
      const available = box.clientWidth;
      if (!available || width() <= available) continue;
      const terms = mathTerms(original);
      const lines: string[] = [];
      let line = '';
      for (const term of terms) {
        box.innerHTML = render(line + term);
        if (line && width() > available) { lines.push(line); line = term; }
        else line += term;
      }
      if (line) lines.push(line);
      box.innerHTML = render(lines.length > 1 ? `\\begin{aligned}${lines.map(s => '&{}' + s).join('\\\\')}\\end{aligned}` : original);
      if (width() > available) {
        const factor = available / width();
        const size = parseFloat(getComputedStyle(box).fontSize);
        box.style.fontSize = `${size * Math.max(0.8, factor)}px`;
        if (factor < 0.8) overflow++;
      }
    } catch {
      // A failed split must never leave a partially rendered candidate behind.
      try { box.innerHTML = render(original); } catch { /* Keep the original error visible. */ }
      overflow++;
    }
  }
  return overflow;
}
