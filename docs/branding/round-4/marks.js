(() => {
  const colors = { top: '#FFFFFF', bottom: '#E6EBF8', mark: '#3F54C3', accent: '#8396DF', rim: '#D7DFF0', ink: '#273451' };
  const original = [
    { tone: 'accent', d: 'M59 65H102L151 191H108Z' },
    { tone: 'mark', d: 'M109 65H195L148 191H106L140 105H109Z' },
    { tone: 'mark', d: 'M109 65L140 105H181L195 65Z' },
    { tone: 'accent', d: 'M106 191H148L133 151Z' },
  ];
  const point = ([x, y]) => `${Number(x.toFixed(4))} ${Number(y.toFixed(4))}`;
  const polygon = points => `M${points.map(point).join('L')}Z`;
  /** Tiny optical corner easing; all facets share one silhouette clip. */
  function easedPolygon(points, inset) {
    const toward = (from, to) => {
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      const amount = Math.min(inset, length / 3) / length;
      return [from[0] + (to[0] - from[0]) * amount, from[1] + (to[1] - from[1]) * amount];
    };
    return points.map((p, i) => {
      const previous = points[(i + points.length - 1) % points.length], next = points[(i + 1) % points.length];
      return `${i ? 'L' : 'M'}${point(toward(p, previous))}Q${point(p)} ${point(toward(p, next))}`;
    }).join('') + 'Z';
  }
  const top = 65, bottom = 191, height = bottom - top, width = 42;
  const rearRight = y => 102 + 46 * (y - top) / height;
  const frontRight = y => 195 - 47 * (y - top) / height;
  const notch = [109, top + 7 * height / 46];
  const crossingY = top + height * 51 / 93;
  const crossing = [rearRight(crossingY), crossingY];
  const leftFoot = [106, bottom], rightFoot = [148, bottom];
  const rear = [[60, top], [102, top], rightFoot, leftFoot];
  const front = [[109, top], [195, top], rightFoot, leftFoot, [frontRight(105) - width, 105], [109, 105]];
  const outline = [[60, top], [102, top], notch, [109, top], [195, top], rightFoot, leftFoot];
  const opening = [[rearRight(105), 105], [frontRight(105) - width, 105], crossing];
  const silhouette = easedPolygon(outline, 1.25) + ' ' + easedPolygon(opening, 0.6);
  const refined = [
    { tone: 'mark', d: silhouette, evenodd: true },
    { tone: 'accent', d: polygon(rear) },
    { tone: 'mark', d: polygon(front) },
    { tone: 'accent', d: polygon([leftFoot, rightFoot, [rearRight(151), 151]]) },
  ];
  const details = [
    { id: 'notch', title: '顶部切口', box: '94 58 28 51', description: '两条边在同一交点收住，轻微钝化尖锐转角。' },
    { id: 'edge', title: '右侧斜边', box: '173 58 29 57', description: '合并重叠顶面，理顺原来略有凸点的斜边。' },
    { id: 'foot', title: '底部折角', box: '97 144 62 57', description: '三块折面共用底边，收掉两端错位的小尖角。' },
  ];
  let sequence = 0;
  function svg(kind = 'refined', { size = 256, tile = true, mono = false, viewBox = '0 0 256 256', id = `fold-${sequence++}` } = {}) {
    const parts = kind === 'original' ? original : refined;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" role="img" aria-label="Taskweave D ${kind}" data-kind="${kind}">
      <defs><linearGradient id="${id}-tile" x1="0" y1="0" x2=".3" y2="1"><stop stop-color="${colors.top}"/><stop offset="1" stop-color="${colors.bottom}"/></linearGradient><clipPath id="${id}-outline"><path d="${silhouette}" clip-rule="evenodd"/></clipPath></defs>
      ${tile ? `<rect x="8" y="8" width="240" height="240" rx="55" fill="url(#${id}-tile)"/><rect x="8.5" y="8.5" width="239" height="239" rx="54.5" fill="none" stroke="${colors.rim}"/>` : ''}
      <g${kind === 'refined' ? ` clip-path="url(#${id}-outline)"` : ''}>${parts.map(part => `<path d="${part.d}" fill="${mono ? colors.ink : colors[part.tone]}"${part.evenodd ? ' fill-rule="evenodd"' : ''}/>`).join('')}</g>
    </svg>`.replace(/[ \t]+$/gm, '');
  }
  window.foldRefinement = { colors, original, refined, details, svg };
})();
