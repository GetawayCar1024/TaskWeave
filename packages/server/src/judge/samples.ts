import { promises as fs } from 'node:fs';
import { parseIndexList, sampleFileNames, type StatementSample } from '@polyforge/shared';
import { exists, HttpError, safeJoin, sha1 } from '../util/fs.js';
import type { ProblemCtx } from './index.js';
import { answerPath, inputPath, readManifest, sampleStatementPaths } from './tests.js';

/** The same sample order and statement overrides feed previews and down.zip. */
export async function readSamples(ctx: ProblemCtx, strict = false) {
  const manifest = await readManifest(ctx);
  const indices = [...new Set(parseIndexList(ctx.config.tests.samples ?? ''))].sort((a,b) => a-b);
  const large = new Set(parseIndexList(ctx.config.tests.large_samples ?? ''));
  const rows: { sample: StatementSample; input: Buffer; output: Buffer }[] = [];
  for (const [i, index] of indices.entries()) {
    const test = manifest?.tests.find(t => t.index === index);
    if (!test) { if (strict) throw new HttpError(400, 'missing_sample', `Sample test ${index} has not been generated.`); continue; }
    const overrides = sampleStatementPaths(test);
    const customInput = await exists(safeJoin(ctx.ref.dir, overrides.input));
    const customOutput = await exists(safeJoin(ctx.ref.dir, overrides.output));
    const read = async (file: string) => fs.readFile(file).catch(() => {
      if (strict) throw new HttpError(400, 'missing_sample', `Sample test ${index} is missing an input or answer. Generate tests first.`);
      return Buffer.alloc(0);
    });
    const input = await read(customInput ? safeJoin(ctx.ref.dir, overrides.input) : inputPath(ctx,index));
    const output = await read(customOutput ? safeJoin(ctx.ref.dir, overrides.output) : answerPath(ctx,index));
    if (!large.has(index) && Math.max(input.length, output.length) > 256 * 1024) throw new HttpError(400, 'large_sample', `Sample test ${index} exceeds 256 KiB. Mark it as a large sample to display a file reference.`);
    rows.push({ input, output, sample: { index, number: i+1, large: large.has(index),
      ...sampleFileNames(ctx.config.problem.name, i+1), inputHash: sha1(input), outputHash: sha1(output),
      input: large.has(index) ? '' : input.toString('utf8'), output: large.has(index) ? '' : output.toString('utf8'),
      inputCases: customInput ? undefined : test.inputCases } });
  }
  return rows;
}
