import { PROBLEM_NAME_RE, type ContestStatement } from '@polyforge/shared';
import { HttpError } from '../util/fs.js';
import { ZipWriter } from '../util/zip.js';
import { contestNotes } from '../workspace/contestFiles.js';
import type { ContestRegistry } from '../workspace/contests.js';
import { contestStatements } from './contest.js';
import { singleProblemDocument } from './contest.js';
import type { Judge } from './index.js';
import { readSamples } from './samples.js';
import { generateTests } from './tests.js';
import { testsetsOf } from '@polyforge/shared';

/** PDF is the browser's current upstream OI render. Recheck its input snapshot
 * before packaging public samples, so concurrent edits never silently mismatch. */
export async function contestDown(judge: Judge, contests: ContestRegistry, id: string, req: { lang: string; pdf?: string; statements?: ContestStatement[]; notes?: string; samplesOnly?: boolean }, single = false) {
  if (!req || !/^[a-z]{2,8}$/.test(req.lang)) throw new HttpError(400, 'bad_request', 'A valid language is required.');
  const { ref, config } = single ? await singleProblemDocument(judge, id) : await contests.config(id);
  if (req.samplesOnly) {
    if (!config.problems.length) throw new HttpError(400, 'empty_contest', 'No problems to export.');
    const zip = new ZipWriter(), names = new Set<string>();
    for (const p of config.problems) {
      const ctx = await judge.ctx(p.problem), name = ctx.config.problem.name;
      if (!PROBLEM_NAME_RE.test(name) || names.has(name.toLowerCase())) throw new HttpError(400, 'duplicate_name', `down.zip requires unique English problem names: ${name}`);
      names.add(name.toLowerCase()); zip.add(`${name}/`, '');
      for (const ts of testsetsOf(ctx.config).filter(ts => ts.samples?.trim())) {
        const m = await generateTests(judge, ctx, { signal: new AbortController().signal, progress() {} }, ts.name);
        if (!m.ok) throw new HttpError(400, 'missing_sample', m.errors.join('\n'));
      }
      for (const row of await readSamples(ctx, true, req.lang)) {
        zip.add(row.sample.inputFile!, row.input); zip.add(row.sample.outputFile!, row.output);
      }
    }
    return zip.finish();
  }
  if (typeof req.pdf !== 'string' || !Array.isArray(req.statements)) throw new HttpError(400, 'bad_request', 'OI PDF and statement snapshot are required.');
  const pdf = Buffer.from(req.pdf, 'base64');
  if (pdf.subarray(0,5).toString() !== '%PDF-' || pdf.length > 40 * 1024 * 1024) throw new HttpError(400, 'invalid_pdf', 'A PDF of at most 40 MiB is required.');
  const current = await contestStatements(judge, contests, id, req.lang, single);
  const stale = () => { throw new HttpError(409, 'stale_down', 'Statements or samples changed. Refresh the OI preview and export down.zip again.'); };
  if (JSON.stringify(current) !== JSON.stringify(req.statements) || (single ? '' : await contestNotes(ref.dir, req.lang)) !== req.notes) stale();
  if (!config.problems.length || current.some(s => !s.body?.trim() && !s.sections.legend?.trim())) throw new HttpError(400, 'missing_statement', 'Every contest problem must have a statement in the selected language.');
  const zip = new ZipWriter();
  zip.add('statement.pdf', pdf);
  const names = new Set<string>();
  for (const p of config.problems) {
    const ctx = await judge.ctx(p.problem);
    const name = ctx.config.problem.name;
    if (!PROBLEM_NAME_RE.test(name) || names.has(name.toLowerCase())) throw new HttpError(400, 'duplicate_name', `down.zip requires unique English problem names: ${name}`);
    names.add(name.toLowerCase()); zip.add(`${name}/`, '');
    const rows = await readSamples(ctx, true, req.lang);
    const previous = current.find(s => s.problem === p.problem)!;
    // A statement.tex document prints no generated samples (the snapshot has none): nothing to compare.
    if (!previous.body && JSON.stringify(rows.map(row => row.sample)) !== JSON.stringify(previous.samples)) stale();
    for (const row of rows) {
      zip.add(row.sample.inputFile!, row.input);
      zip.add(row.sample.outputFile!, row.output);
    }
  }
  return zip.finish();
}
