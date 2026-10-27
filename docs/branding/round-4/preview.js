(() => {
  const { svg, details } = window.foldRefinement;
  const el = id => document.getElementById(id);
  let mono = false;
  function render() {
    for (const kind of ['original', 'refined']) el(`${kind}-art`).innerHTML = svg(kind, { size: 272, mono });
    el('details').innerHTML = details.map(detail => `<article class="detail"><h3>${detail.title}</h3><div class="detail-pair">${['original', 'refined'].map(kind => `<figure>${svg(kind, { size: 126, tile: false, mono, viewBox: detail.box })}<figcaption>${kind === 'original' ? '原稿' : '精修'}</figcaption></figure>`).join('')}</div><p>${detail.description}</p></article>`).join('');
    el('sizes').innerHTML = ['original', 'refined'].map(kind => `<div class="size-row"><span>${kind === 'original' ? '原稿' : '精修'}</span>${[16, 24, 32, 48].map(size => `<figure>${svg(kind, { size, mono })}<figcaption>${size} px</figcaption></figure>`).join('')}</div>`).join('');
    el('dark-art').innerHTML = svg('refined', { size: 48, mono }) + '<span>Taskweave</span>';
    el('bare-art').innerHTML = svg('refined', { size: 64, tile: false, mono });
    el('mono').setAttribute('aria-pressed', String(mono));
  }
  el('mono').addEventListener('click', () => { mono = !mono; render(); });
  document.querySelectorAll('[data-download]').forEach(button => button.addEventListener('click', () => {
    const kind = button.dataset.download;
    const file = `taskweave-d-${kind}-porcelain.svg`;
    const url = URL.createObjectURL(new Blob([svg(kind, { id: 'taskweave' })], { type: 'image/svg+xml' }));
    const link = document.createElement('a'); link.href = url; link.download = file; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    el('download-status').textContent = `已导出 ${file}`;
  }));
  const dialog = el('zoom');
  document.querySelectorAll('[data-zoom]').forEach(button => button.addEventListener('click', () => {
    const kind = button.dataset.zoom;
    el('zoom-art').innerHTML = svg(kind, { size: 440, mono });
    el('zoom-title').textContent = kind === 'original' ? 'D / 原稿' : 'D / 边角精修';
    dialog.showModal();
  }));
  el('close-zoom').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  render();
})();
