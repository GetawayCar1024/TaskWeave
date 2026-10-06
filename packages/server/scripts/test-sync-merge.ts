/**
 * End-to-end check of Polygon pull + three-way merge against the mock.
 * Needs: `pnpm mock-polygon` on :4700 and a PolyForge server on :4600 started with
 * POLYFORGE_TOKEN=tok and a home whose problem root is <home>/probs.
 *   npx tsx scripts/test-sync-merge.ts <home>
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { PolygonClient } from '../src/polygon/client.js';

const HOME = process.argv[2];
const PROBS = path.join(HOME, 'probs');
const H = { 'x-polyforge-token': process.env.POLYFORGE_TOKEN ?? 'tok', 'content-type': 'application/json' };
const api = async (method: string, p: string, body?: unknown): Promise<any> => {
  const res = await fetch(`http://127.0.0.1:4600/api${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = await res.json();
  while (data?.kind && data.status === 'running') {
    await new Promise((r) => setTimeout(r, 150));
    data = await (await fetch(`http://127.0.0.1:4600/api/jobs/${data.id}`, { headers: H })).json();
  }
  if (!res.ok) throw new Error(`${method} ${p}: ${JSON.stringify(data)}`);
  return data;
};
const poly = new PolygonClient({ apiUrl: 'http://127.0.0.1:4700/api/', key: 'mock-key', secret: 'mock-secret' });
const counts = (items: { status: string }[]) => items.reduce((c: Record<string, number>, i) => ((c[i.status] = (c[i.status] ?? 0) + 1), c), {});
const check = (cond: boolean, msg: string) => {
  console.log(cond ? '  ✓' : '  ✗', msg);
  if (!cond) process.exitCode = 1;
};

await api('PUT', '/secrets', { polygon: { key: 'mock-key', secret: 'mock-secret', apiUrl: 'http://127.0.0.1:4700/api/' } });

console.log('1. create + push everything');
await api('POST', '/problems', { name: 'merge-test', title: { en: 'Merge', zh: '合并' } });
let diff = await api('POST', '/problems/merge-test/polygon/diff');
let job = await api('POST', '/problems/merge-test/polygon/push', { keys: diff.items.map((i: any) => i.key), commit: true, buildPackage: false });
check(job.status === 'done', `pushed ${job.result?.pushed.length} items`);
const pid = job.result.polygonId;

console.log('2. concurrent edits');
const P = path.join(PROBS, 'merge-test');
const std = await fsp.readFile(path.join(P, 'solutions/std.cpp'), 'utf8');
// local: change the include line; Polygon: change the output line -> should merge cleanly
await fsp.writeFile(path.join(P, 'solutions/std.cpp'), std.replace('#include <bits/stdc++.h>', '#include <bits/stdc++.h> // local'));
await poly.call('problem.saveSolution', { problemId: pid, name: 'std.cpp', file: Buffer.from(std.replace("cout << sum << '\\n';", "cout << sum << endl; // polygon")), tag: 'MA' });
// same line on both sides -> conflict
await fsp.writeFile(path.join(P, 'statement/zh/legend.tex'), '本地版本的描述。\n');
await poly.call('problem.saveStatement', { problemId: pid, lang: 'chinese', encoding: 'UTF-8', legend: 'Polygon 版本的描述。' });
// multi-line statement, different paragraphs edited
const input = await fsp.readFile(path.join(P, 'statement/en/input.tex'), 'utf8');
const [p1, p2] = input.trimEnd().split('\n\n');
await fsp.writeFile(path.join(P, 'statement/en/input.tex'), `${p1} (local note)\n\n${p2}\n`);
await poly.call('problem.saveStatement', { problemId: pid, lang: 'english', encoding: 'UTF-8', input: `${p1}\n\n${p2} (polygon note)` });
await poly.call('problem.commitChanges', { problemId: pid, message: 'remote' });

console.log('3. pull preview');
const pre = await api('POST', '/problems/merge-test/polygon/pull-preview');
console.log('   ', counts(pre.items));
const byKey = Object.fromEntries(pre.items.map((i: any) => [i.key, i]));
for (const k of ['solution:std.cpp', 'statement:english:input']) check(byKey[k]?.status === 'conflict' && byKey[k].mergeable && byKey[k].mergeConflicts === 0, `${k}: conflict, merges cleanly`);
check(byKey['statement:chinese:legend']?.status === 'conflict' && byKey['statement:chinese:legend'].mergeConflicts === 1, 'statement:chinese:legend: conflict, 1 conflicting region');
const content = await api('GET', `/problems/merge-test/polygon/content?key=${encodeURIComponent('solution:std.cpp')}`);
check(!!content.merged?.includes('// local') && content.merged.includes('// polygon'), 'content endpoint returns a merged preview with both edits');

console.log('4. pull with merge');
const merge = ['solution:std.cpp', 'statement:english:input', 'statement:chinese:legend'];
const res = await api('POST', '/problems/merge-test/polygon/pull', { take: [], merge });
check(res.merged.length === 3, `merged ${res.merged.join(', ')}`);
check(res.conflicts.length === 1 && res.conflicts[0] === 'statement:chinese:legend', `conflict markers left in ${res.conflicts}`);
const stdNow = await fsp.readFile(path.join(P, 'solutions/std.cpp'), 'utf8');
check(stdNow.includes('// local') && stdNow.includes('// polygon'), 'std.cpp contains both edits');
const inNow = await fsp.readFile(path.join(P, 'statement/en/input.tex'), 'utf8');
check(inNow.includes('(local note)') && inNow.includes('(polygon note)'), 'en/input.tex contains both edits');
const zh = await fsp.readFile(path.join(P, 'statement/zh/legend.tex'), 'utf8');
check(zh.includes('<<<<<<< local') && zh.includes('本地版本') && zh.includes('Polygon 版本') && zh.includes('>>>>>>> Polygon'), 'zh legend has conflict markers with both versions');

console.log('5. resolve, push, verify in sync');
await fsp.writeFile(path.join(P, 'statement/zh/legend.tex'), '合并后的描述。\n');
diff = await api('POST', '/problems/merge-test/polygon/diff');
const modified = diff.items.filter((i: any) => i.status !== 'unchanged').map((i: any) => i.key);
check(modified.sort().join() === merge.sort().join(), `push shows exactly the merged items as modified: ${modified.join(', ')}`);
check(diff.warnings.length === 0, `no revision warning (${diff.warnings.join(' | ')})`);
job = await api('POST', '/problems/merge-test/polygon/push', { keys: modified, commit: true, buildPackage: false });
check(job.status === 'done', 'pushed merged result');
const after = await api('POST', '/problems/merge-test/polygon/pull-preview');
check(after.items.every((i: any) => i.status === 'same'), `after push everything is the same: ${JSON.stringify(counts(after.items))}`);

console.log('6. bind a never-synced local problem to the Polygon problem and pull');
await api('POST', '/problems', { name: 'local-only', title: { en: 'Local' } });
const LP = path.join(PROBS, 'local-only');
await fsp.writeFile(path.join(LP, 'solutions/std.cpp'), '// my own std\nint main() {}\n');
await api('PATCH', '/problems/local-only', { polygonId: pid });
const bp = await api('POST', '/problems/local-only/polygon/pull-preview');
console.log('   ', counts(bp.items));
check(bp.items.some((i: any) => i.key === 'solution:std.cpp' && i.status === 'conflict' && !i.mergeable), 'differing std.cpp without a common base is a conflict (not mergeable)');
check(bp.items.some((i: any) => i.key === 'statement:english:output' && i.status === 'same'), 'identical template files are "same"');
const take = bp.items.filter((i: any) => i.status !== 'same' && i.status !== 'local-only').map((i: any) => i.key);
const r2 = await api('POST', '/problems/local-only/polygon/pull', { take });
check(r2.applied.length === take.length, `took ${r2.applied.length} items from Polygon`);
const final = await api('POST', '/problems/local-only/polygon/pull-preview');
check(final.items.every((i: any) => i.status === 'same' || i.status === 'local-only'), `now in sync: ${JSON.stringify(counts(final.items))}`);
console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED');
