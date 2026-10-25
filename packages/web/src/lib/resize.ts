import { ref } from 'vue';

export type ResizeEdge = 'top' | 'bottom' | 'left' | 'right';

/**
 * A panel size changed by dragging one of its borders (a `.pf-resize-handle` placed
 * on that edge). The size is kept in localStorage under `key`; double-clicking the
 * handle restores the initial size.
 *
 *   const h = useResizable('polyforge-x-height', { edge: 'bottom', initial: 180, min: 60 });
 *   <div :style="{ height: `${h.size.value}px` }">…<div class="pf-resize-handle bottom" @pointerdown="h.start" @dblclick="h.reset" /></div>
 */
export function useResizable(key: string | null, opts: { edge: ResizeEdge; initial: number; min: number; max?: () => number }) {
  const max = () => opts.max?.() ?? (opts.edge === 'top' || opts.edge === 'bottom' ? window.innerHeight * 0.85 : window.innerWidth * 0.85);
  const clamp = (v: number) => Math.round(Math.min(Math.max(v, opts.min), Math.max(opts.min, max())));
  const saved = key ? Number(localStorage.getItem(key)) : 0;
  const size = ref(saved >= opts.min ? saved : opts.initial);
  const dragging = ref(false);

  function start(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const vertical = opts.edge === 'top' || opts.edge === 'bottom';
    const sign = opts.edge === 'bottom' || opts.edge === 'right' ? 1 : -1;
    const p0 = vertical ? e.clientY : e.clientX;
    const s0 = size.value;
    dragging.value = true;
    document.body.classList.add(vertical ? 'pf-resizing-y' : 'pf-resizing-x');
    const move = (ev: PointerEvent) => {
      size.value = clamp(s0 + sign * ((vertical ? ev.clientY : ev.clientX) - p0));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('pf-resizing-y', 'pf-resizing-x');
      dragging.value = false;
      if (key) localStorage.setItem(key, String(size.value));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function reset() {
    size.value = opts.initial;
    if (key) localStorage.removeItem(key);
  }

  return { size, dragging, start, reset };
}
