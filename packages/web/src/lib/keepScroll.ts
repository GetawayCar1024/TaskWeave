import type { Directive } from 'vue';

/**
 * v-keep-scroll="key": remembers the scroll position of a panel (per key, e.g.
 * "tests:<problem>") and restores it when the panel is shown again — after a tab
 * switch remounts it, or a hidden (display: none) panel becomes visible.
 *
 * The element may be the scroll container itself, or contain one: a Naive UI
 * scrollbar (.n-scrollbar-container) or virtual list (.v-vl); the outermost wins.
 */

const STORE = 'polyforge-scroll';
const positions = new Map<string, { top: number; left: number }>(
  (() => {
    try {
      return Object.entries(JSON.parse(sessionStorage.getItem(STORE) ?? '{}')) as [string, { top: number; left: number }][];
    } catch {
      return [];
    }
  })(),
);
let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(Object.fromEntries([...positions].slice(-200))));
    } catch {
      /* storage full or unavailable */
    }
  }, 300);
}

function scrollerOf(el: HTMLElement): HTMLElement | null {
  const style = getComputedStyle(el);
  if (/(auto|scroll)/.test(style.overflowY + style.overflowX)) return el;
  return el.querySelector<HTMLElement>('.n-scrollbar-container, .v-vl, [data-keep-scroll]');
}

interface State {
  key: string;
  onScroll: (e: Event) => void;
  onUser: () => void;
  observer: ResizeObserver;
  /** Restoring is in progress until the content is tall enough or the user scrolls. */
  restoring: number;
  /** Scroll events caused by restoring are not saved. */
  busy: boolean;
  visible: boolean;
}

function stop(s: State) {
  cancelAnimationFrame(s.restoring);
  s.busy = false;
}
const states = new WeakMap<HTMLElement, State>();

function restore(el: HTMLElement, s: State) {
  stop(s);
  const want = positions.get(s.key);
  if (!want || (!want.top && !want.left)) return;
  const until = performance.now() + 1500;
  s.busy = true;
  const step = () => {
    const sc = scrollerOf(el);
    if (sc && sc.clientHeight > 0) {
      sc.scrollTop = want.top;
      sc.scrollLeft = want.left;
      // Content still loading: keep trying for a moment.
      const done = Math.abs(sc.scrollTop - want.top) < 2 && Math.abs(sc.scrollLeft - want.left) < 2;
      if (done) return void setTimeout(() => (s.busy = false), 50);
    }
    if (performance.now() < until) s.restoring = requestAnimationFrame(step);
    else s.busy = false;
  };
  s.restoring = requestAnimationFrame(step);
}

function keyOf(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** The user taking over stops a pending restore. */
const USER_EVENTS = ['wheel', 'pointerdown', 'keydown'] as const;

function attach(el: HTMLElement, key: string) {
  const s: State = {
    key,
    restoring: 0,
    busy: false,
    visible: false,
    onUser: () => stop(s),
    onScroll: (e) => {
      if (s.busy) return;
      const sc = scrollerOf(el);
      if (!sc || e.target !== sc || sc.clientHeight === 0) return;
      positions.set(s.key, { top: sc.scrollTop, left: sc.scrollLeft });
      persist();
    },
    observer: new ResizeObserver(() => {
      const visible = el.offsetWidth > 0 || el.offsetHeight > 0;
      if (visible && !s.visible) restore(el, s);
      s.visible = visible;
    }),
  };
  states.set(el, s);
  el.addEventListener('scroll', s.onScroll, { capture: true, passive: true });
  for (const type of USER_EVENTS) el.addEventListener(type, s.onUser, { passive: true });
  s.observer.observe(el);
}

export const vKeepScroll: Directive<HTMLElement, string | null | undefined> = {
  mounted(el, binding) {
    const key = keyOf(binding.value);
    if (key) attach(el, key);
  },
  updated(el, binding) {
    const s = states.get(el);
    const key = keyOf(binding.value);
    if (!key) return;
    if (!s) return attach(el, key);
    if (key === s.key) return;
    s.key = key;
    restore(el, s);
  },
  beforeUnmount(el) {
    const s = states.get(el);
    if (!s) return;
    stop(s);
    el.removeEventListener('scroll', s.onScroll, { capture: true });
    for (const type of USER_EVENTS) el.removeEventListener(type, s.onUser);
    s.observer.disconnect();
    states.delete(el);
  },
};
