import { promises as fs } from 'node:fs';
import { parseIndexList, sampleFileNames, sampleNotePath, testsetsOf, type StatementSample } from '@taskweave/shared';
import { exists, HttpError, safeJoin, sha1 } from '../util/fs.js';
import type { ProblemCtx } from './index.js';
import { answerPath, inputPath, readManifest, sampleStatementPaths } from './tests.js';

/**
 * The same sample order and statement overrides feed previews and down.zip: samples of
 * "tests" first, then those of the other testsets, each ascending; numbered continuously.
 * With `lang`, each sample carries its OI explanation (statement/<lang>/samples/…) if any.
 */
export async function readSamples(ctx: ProblemCtx, strict = false, lang?: string) {
  const rows: { sample: StatementSample; input: Buffer; output: Buffer }[] = [];
  for (const ts of testsetsOf(ctx.config)) {
    const indices = [...new Set(parseIndexList(ts.samples ?? ''))].sort((a, b) => a - b);
    if (!indices.length) continue;
    const manifest = await readManifest(ctx, ts.name);
    const large = new Set(parseIndexList(ts.largeSamples ?? ''));
    const label = (index: number) => (ts.name === 'tests' ? `${index}` : `${index} (${ts.name})`);
    for (const index of indices) {
      const test = manifest?.tests.find(t => t.index === index);
      if (!test) { if (strict) throw new HttpError(400, 'missing_sample', `Sample test ${label(index)} has not been generated.`); continue; }
      const overrides = sampleStatementPaths(test, ts.name);
      if (lang) {
        const prefix = sampleNotePath(lang, index, ts.name).replace(/\.tex$/, '');
        if (await exists(safeJoin(ctx.ref.dir, prefix + '.in'))) overrides.input = prefix + '.in';
        if (await exists(safeJoin(ctx.ref.dir, prefix + '.out'))) overrides.output = prefix + '.out';
      }
      const customInput = await exists(safeJoin(ctx.ref.dir, overrides.input));
      const customOutput = await exists(safeJoin(ctx.ref.dir, overrides.output));
      const read = async (file: string) => fs.readFile(file).catch(() => {
        if (strict) throw new HttpError(400, 'missing_sample', `Sample test ${label(index)} is missing an input or answer. Generate tests first.`);
        return Buffer.alloc(0);
      });
      const input = await read(customInput ? safeJoin(ctx.ref.dir, overrides.input) : inputPath(ctx, index, ts.name));
      const output = await read(customOutput ? safeJoin(ctx.ref.dir, overrides.output) : answerPath(ctx, index, ts.name));
      if (!large.has(index) && Math.max(input.length, output.length) > 256 * 1024) throw new HttpError(400, 'large_sample', `Sample test ${label(index)} exceeds 256 KiB. Mark it as a large sample to display a file reference.`);
      const number = rows.length + 1;
      const note = lang ? (await fs.readFile(safeJoin(ctx.ref.dir, sampleNotePath(lang, index, ts.name)), 'utf8').catch(() => '')) : '';
      rows.push({ input, output, sample: { testset: ts.name, index, number, large: large.has(index),
        ...sampleFileNames(ctx.config.problem.name, number), inputHash: sha1(input), outputHash: sha1(output),
        input: large.has(index) ? '' : input.toString('utf8'), output: large.has(index) ? '' : output.toString('utf8'),
        inputCases: customInput ? undefined : test.inputCases, ...(note.trim() ? { note } : {}) } });
    }
  }
  return rows;
}
