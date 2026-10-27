import { performance } from 'node:perf_hooks';
import { ZipWriter, readZip } from '../src/util/zip.js';
let seed = 42;
const text = Buffer.from(Array.from({ length: 60000 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return String(seed % 1000000000); }).join('\n'));
const start = performance.now(), zip = new ZipWriter({ async: true });
for (let i = 1; i <= 48; i++) { zip.add(`${i}.in`, text); zip.add(`${i}.out`, text); }
const bytes = await zip.finishAsync();
console.log(JSON.stringify({ tests: 48, inputMiB: Math.round(text.length * 96 / 1024 / 1024), zipMiB: +(bytes.length / 1024 / 1024).toFixed(2), packageMs: Math.round(performance.now() - start) }));
if (readZip(bytes).size !== 96) throw new Error('Incomplete package');
