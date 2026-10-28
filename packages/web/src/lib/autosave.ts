/** Serialize saves and flush edits made while a previous request is in flight. */
export function createAutosave(write: () => Promise<void>, delay = 500) {
  let revision = 0, saved = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let disposed = false;
  async function flush(): Promise<void> {
    clearTimeout(timer);
    if (running) return running;
    if (saved === revision || disposed) return;
    running = (async () => {
      while (!disposed && saved !== revision) {
        const version = revision;
        await write();
        saved = version;
      }
    })().finally(() => { running = undefined; });
    return running;
  }
  function schedule(wait = delay) {
    if (disposed) return;
    revision++; clearTimeout(timer);
    timer = setTimeout(() => { void flush().catch(() => {}); }, wait);
  }
  function dispose() { disposed = true; clearTimeout(timer); }
  return { schedule, flush, dispose };
}
