import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAutosave } from '../../web/src/lib/autosave.js';

test('autosave serializes an in-flight edit and flushes the newest value before leaving', async () => {
  let value = 'first', release!: () => void;
  const saved: string[] = [];
  const saver = createAutosave(async () => {
    const snapshot = value;
    if (!saved.length) await new Promise<void>(resolve => { release = resolve; });
    saved.push(snapshot);
  });
  saver.schedule(); const flushing = saver.flush();
  value = 'latest'; saver.schedule(); release();
  await flushing;
  assert.deepEqual(saved, ['first', 'latest']);
  saver.dispose();
});

test('failed autosaves can be retried without falsely treating the draft as saved', async () => {
  let failing = true, writes = 0;
  const saver = createAutosave(async () => { writes++; if (failing) throw new Error('fixture write failure'); });
  saver.schedule(); await assert.rejects(saver.flush(), /write failure/);
  failing = false; await saver.flush();
  assert.equal(writes, 2); saver.dispose();
});
