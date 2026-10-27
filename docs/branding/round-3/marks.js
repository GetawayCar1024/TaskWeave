(() => {
  const colors = { top: '#FFFFFF', bottom: '#E6EBF8', mark: '#3F54C3', accent: '#8396DF', rim: '#D7DFF0', ink: '#273451' };
  const marks = [
    {
      id: 'D', key: 'original', title: 'Fold', caption: '第二轮原稿',
      description: '保留原 D 作参照：窄横折面、倾斜的双层带子，以及底部回折。',
      parts: [
        { tone: 'accent', d: 'M59 65H102L151 191H108Z' },
        { tone: 'mark', d: 'M109 65H195L148 191H106L140 105H109Z' },
        { tone: 'mark', d: 'M109 65L140 105H181L195 65Z' },
        { tone: 'accent', d: 'M106 191H148L133 151Z' },
      ],
    },
    {
      id: 'D1', key: 'soft-crease', title: 'Soft crease', caption: '更接近原 D，T 藏在折面里',
      description: '拓宽上方横折面，收紧右侧带宽。浅色背带与底部回折围着蓝色正形，让倾斜的 T 若隐若现。',
      reveal: '淡化背带后，蓝色正面本身就是一个倾斜的 T。',
      tPath: 'M94 64H198L184 102H161L129 193H107L139 102H108Z',
      parts: [
        { tone: 'accent', d: 'M58 64H100L149 193H107Z' },
        { tone: 'mark', d: 'M94 64H198L184 102H161L129 193H107L139 102H108Z' },
        { tone: 'accent', d: 'M107 193H149L132 149Z' },
      ],
    },
    {
      id: 'D2', key: 'counterfold', title: 'Counterfold', caption: 'T 藏在留白里，正负形切换',
      description: '延续 D 的收拢轮廓，让横向留白转入一条倾斜的竖笔。看蓝色是折带，看中间的瓷白又是 T。',
      reveal: '将原本瓷白的留白显色：这块完整的 T 是图形中的真实镂空。',
      recommended: true,
      material: 'M58 62H198L150 194H108Z M96 94H173L168 108H148L130 159H115L133 108H101Z',
      tPath: 'M96 94H173L168 108H148L130 159H115L133 108H101Z',
      parts: [
        { tone: 'mark', d: 'M58 62H198L150 194H108Z' },
        { tone: 'accent', d: 'M58 62H105L154 194H108Z' },
        { tone: 'mark', d: 'M108 194H150L135 153Z', opacity: 0.55 },
      ],
    },
    {
      id: 'D3', key: 'ribbon-t', title: 'Ribbon T', caption: 'T 更明确，保留双层折带',
      description: '横梁向左展开，T 的字形更容易读到；浅色带子从背面绕到底部，形成前后交叠。',
      reveal: '淡化背面的回折带，查看较完整的 T 字形。',
      tPath: 'M76 64H201L187 100H157L125 196H94L126 100H90Z',
      parts: [
        { tone: 'accent', d: 'M56 64H97L146 196H105Z' },
        { tone: 'mark', d: 'M76 64H201L187 100H157L125 196H94L126 100H90Z' },
        { tone: 'ink', d: 'M126 100H157L150 121H119Z', opacity: 0.16 },
        { tone: 'accent', d: 'M105 196H146L128 148Z' },
      ],
    },
  ];
  let sequence = 0;
  function svg(mark, { size = 256, tile = true, mono = false, reveal = false, id = `study-${sequence++}` } = {}) {
    const parts = mark.parts.map(part => `<path d="${part.d}" fill="${mono ? colors.ink : colors[part.tone]}"${!mono && part.opacity ? ` opacity="${part.opacity}"` : ''}/>`).join('');
    const cutout = mark.material ? `<clipPath id="${id}-cut"><path d="${mark.material}" clip-rule="evenodd"/></clipPath>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" role="img" aria-label="Taskweave ${mark.id} ${mark.title}" data-variant="${mark.id}">
      <defs><linearGradient id="${id}-tile" x1="0" y1="0" x2=".3" y2="1"><stop stop-color="${colors.top}"/><stop offset="1" stop-color="${colors.bottom}"/></linearGradient>${cutout}</defs>
      ${tile ? `<rect x="8" y="8" width="240" height="240" rx="55" fill="url(#${id}-tile)"/><rect x="8.5" y="8.5" width="239" height="239" rx="54.5" fill="none" stroke="${colors.rim}"/>` : ''}
      <g${mark.material ? ` clip-path="url(#${id}-cut)"` : ''}${reveal && mark.tPath ? ' opacity=".14"' : ''}>${parts}</g>
      ${reveal && mark.tPath ? `<path d="${mark.tPath}" fill="${mono ? colors.ink : colors.mark}"/>` : ''}
    </svg>`.replace(/[ \t]+$/gm, '');
  }
  window.taskweaveStudies = { colors, marks, svg };
})();
