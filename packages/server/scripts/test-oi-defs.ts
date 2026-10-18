import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GlobalStore } from '../src/global.js';
import { readSharedDefs, parseDefsToml, defsForProblem } from '../src/defs.js';
import { expandMacros } from '../src/ai/macros.js';
import { buildMacros, renderLatex, type DefsToml } from '../../web/src/lib/latex.js';

test('OI definitions install without replacing custom CF macros and expand in preview/export in both languages', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-oi-defs-'));
  try {
    const global = new GlobalStore(home);
    await fs.mkdir(global.sharedDir, { recursive: true });
    const custom = "[[english.command]]\nname = 'CustomTerm'\nargs = []\nbody = 'Custom content'\n";
    await fs.writeFile(path.join(global.sharedDir, 'defs.toml'), custom);
    await global.init();
    assert.equal(await fs.readFile(path.join(global.sharedDir, 'defs.toml'), 'utf8'), custom);
    const text = await readSharedDefs(global.sharedDir), defs = parseDefsToml(text) as DefsToml;
    const source = String.raw`\OIInputFile[trip.in]

\OIOutputFile[trip.out]

\OIConstraints{1 \le n \le 10^5}

\OISubtask[1][30]{n \le 100}

\OILargeSample[2][trip]

\OIStandardInput

\OIGraderInterface{solve}[grader.h]`;
    for (const lang of ['zh', 'en']) {
      const html = renderLatex(source, { macros: buildMacros(defs, lang), imageUrl: s => s });
      assert.deepEqual(html.unknown, []);
      assert.match(html.html, /trip\/trip2\.in/);
      assert.match(html.html, /grader\.h/);
      assert.match(html.html, lang === 'zh' ? /从文件/ : /Read the input from/);
      assert.match(html.html, /katex/);
      const tex = await expandMacros(global.sharedDir, source, lang);
      assert.doesNotMatch(tex, /\\OI[A-Za-z]+/);
      assert.match(tex, /\\t\{trip.in\}/);
      assert.match(tex, /\$1 \\le n \\le 10\^5\$/);
    }
    const exported = parseDefsToml(defsForProblem(text, false)) as DefsToml;
    assert.equal(exported.chinese, undefined);
    assert.ok(exported.english?.command?.some(c => c.name === 'OIInputFile'));
    const oiPath = path.join(global.sharedDir, 'oi', 'defs.toml');
    await fs.appendFile(oiPath, "\n[[english.command]]\nname = 'OIExtra'\nargs = []\nbody = 'custom OI content'\n");
    assert.equal(await expandMacros(global.sharedDir, '\\OIExtra', 'en'), 'custom OI content');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
