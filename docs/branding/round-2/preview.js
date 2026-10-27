(() => {
  const { names, palettes, marks } = window.brandRoundTwo;
  let name = 'CaseWeave', palette = 'indigo', selected = 'A';
  let sequence = 0;
  const svg = (mark, size = 128, tile = true) => {
    const colors = palettes[palette], id = `tile-${sequence++}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" role="img" aria-label="${mark.title}" style="--mark:${tile ? colors.mark : colors.bottom};--accent:${tile ? colors.accent : palettes.indigo.top}">
      ${tile ? `<defs><linearGradient id="${id}" x1="0" y1="0" x2=".3" y2="1"><stop stop-color="${colors.top}"/><stop offset="1" stop-color="${colors.bottom}"/></linearGradient></defs><rect x="8" y="8" width="240" height="240" rx="55" fill="url(#${id})"/><rect x="8.5" y="8.5" width="239" height="239" rx="54.5" fill="none" stroke="${colors.outline}" stroke-opacity=".55"/>` : ''}
      ${mark.paths}</svg>`;
  };
  const download = (mark) => {
    const url = URL.createObjectURL(new Blob([svg(mark, 256)], { type: 'image/svg+xml' }));
    const link = document.createElement('a'); link.href = url; link.download = `${name.toLowerCase()}-${mark.key}-${palette}.svg`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  function update() {
    document.querySelector('#chosen-name').textContent = name;
    document.querySelector('#chosen-caption').textContent = names.find(candidate => candidate.name === name).description;
    document.querySelectorAll('[data-name]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.name === name)));
    document.querySelectorAll('[data-palette]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.palette === palette)));
    document.querySelector('#marks').innerHTML = marks.map(mark => `<article class="mark ${selected === mark.id ? 'selected' : ''}" data-mark="${mark.id}">
      <button class="mark-art" data-enlarge="${mark.id}" aria-label="放大 ${mark.id} ${mark.title}">${svg(mark, 128)}<span>放大查看</span></button>
      <div class="mark-title"><h3><span>${mark.id}</span>${mark.title}</h3>${mark.recommended ? '<span class="recommendation">优先看</span>' : ''}</div>
      <p>${mark.caption}</p>
      <div class="small-previews">${svg(mark, 16)}${svg(mark, 24)}${svg(mark, 40)}<div class="mono-preview">${svg(mark, 40, false)}</div><span class="dark-preview">${svg(mark, 34)}</span></div>
      <div class="mark-actions"><button data-choose="${mark.id}" class="choose">${selected === mark.id ? '已选图形' : '选这个图形'}</button><button data-download="${mark.id}" class="download">SVG</button></div>
    </article>`).join('');
    document.querySelector('#app-preview').innerHTML = `${svg(marks.find(mark => mark.id === selected), 52)}<div><strong>${name}</strong><span>Problem workspace</span></div>`;
    document.querySelector('#selection-text').textContent = `${name} + ${selected} / ${marks.find(mark => mark.id === selected).title}`;
  }
  document.querySelector('#name-options').innerHTML = names.map(candidate => `<button data-name="${candidate.name}" aria-pressed="false"><span>${candidate.name}</span><small>${candidate.caption}</small></button>`).join('');
  document.querySelector('#palettes').innerHTML = Object.entries(palettes).map(([key, colors]) => `<button data-palette="${key}" aria-pressed="false"><i style="background:${colors.bottom}"></i>${colors.label}</button>`).join('');
  document.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.name) { name = button.dataset.name; update(); }
    if (button.dataset.palette) { palette = button.dataset.palette; update(); }
    if (button.dataset.choose) { selected = button.dataset.choose; update(); document.querySelector(`[data-choose="${selected}"]`).focus({ preventScroll: true }); }
    if (button.dataset.download) download(marks.find(mark => mark.id === button.dataset.download));
    if (button.dataset.enlarge) {
      const mark = marks.find(mark => mark.id === button.dataset.enlarge);
      const dialog = document.querySelector('#zoom');
      dialog.querySelector('.zoom-art').innerHTML = svg(mark, 240);
      dialog.querySelector('h2').textContent = `${name} / ${mark.id}`;
      dialog.querySelector('.zoom-caption').textContent = mark.description;
      dialog.showModal();
    }
    if (button.id === 'close-zoom') document.querySelector('#zoom').close();
  });
  document.querySelector('#zoom').addEventListener('click', event => { if (event.target.id === 'zoom') event.target.close(); });
  update();
  window.brandPreview = { svg, marks, palettes, selectPalette: key => { palette = key; update(); } };
})();
