(() => {
  const { marks, svg } = window.taskweaveStudies;
  const params = new URLSearchParams(location.search);
  let selected = marks.find(mark => mark.id === params.get('mark')) ?? marks.find(mark => mark.id === 'D2');
  let reveal = false, mono = false;
  const byId = id => document.getElementById(id);
  function update() {
    byId('hero-art').innerHTML = svg(selected, { size: 292, tile: !mono, mono, reveal });
    byId('study-title').textContent = `${selected.id} / ${selected.title}`;
    byId('study-description').textContent = selected.description;
    byId('guide-note').textContent = reveal ? selected.reveal : '先看折带，再看 T。点击图标可放大。';
    byId('reveal').disabled = !selected.tPath;
    byId('reveal').setAttribute('aria-pressed', String(reveal));
    byId('reveal').textContent = reveal ? '收起 T 的提示' : '显示隐藏 T';
    byId('mono').setAttribute('aria-pressed', String(mono));
    byId('download').textContent = `下载 ${selected.id} SVG`;
    byId('selection-text').textContent = `Taskweave + ${selected.id} / Porcelain`;
    document.querySelectorAll('[data-select]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.select === selected.id)));
    byId('sizes').innerHTML = [16, 24, 32, 48].map(size => `<figure><div>${svg(selected, { size })}</div><figcaption>${size} px</figcaption></figure>`).join('');
    byId('dark-art').innerHTML = [24, 40, 56].map(size => svg(selected, { size })).join('');
    byId('window-icon').innerHTML = svg(selected, { size: 20 });
    byId('plain-mark').innerHTML = svg(selected, { size: 68, tile: false });
    byId('mono-mark').innerHTML = svg(selected, { size: 68, tile: false, mono: true });
  }
  byId('options').innerHTML = marks.map(mark => `<button type="button" class="option" data-select="${mark.id}" aria-pressed="false">
    <span class="option-art">${svg(mark, { size: 136 })}</span>
    <span class="option-title"><span>${mark.id}</span> ${mark.title}${mark.recommended ? '<small>建议先看</small>' : ''}</span>
    <span class="option-caption">${mark.caption}</span>
  </button>`).join('');
  byId('options').addEventListener('click', event => {
    const button = event.target.closest('[data-select]');
    if (!button) return;
    selected = marks.find(mark => mark.id === button.dataset.select);
    if (!selected.tPath) reveal = false;
    const url = new URL(location.href); url.searchParams.set('mark', selected.id); history.replaceState(null, '', url);
    update();
  });
  byId('reveal').addEventListener('click', () => { reveal = !reveal; update(); });
  byId('mono').addEventListener('click', () => { mono = !mono; update(); });
  byId('download').addEventListener('click', () => {
    // A study download is always the clean artwork, even when the guide is visible.
    const file = `taskweave-${selected.id.toLowerCase()}-${selected.key}-porcelain.svg`;
    const url = URL.createObjectURL(new Blob([svg(selected, { id: 'taskweave' })], { type: 'image/svg+xml' }));
    const link = document.createElement('a'); link.href = url; link.download = file; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    byId('download-status').textContent = `已导出 ${file}`;
  });
  const dialog = byId('zoom');
  byId('hero-art').addEventListener('click', () => {
    byId('zoom-art').innerHTML = svg(selected, { size: 440, tile: !mono, mono, reveal });
    byId('zoom-title').textContent = `Taskweave / ${selected.id} / Porcelain`;
    byId('zoom-description').textContent = reveal ? selected.reveal : selected.description;
    dialog.showModal();
  });
  byId('close-zoom').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  update();
})();
