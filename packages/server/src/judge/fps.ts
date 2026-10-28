import { promises as fs } from 'node:fs';
import path from 'node:path';
import { judgeMode, testsetsOf, type ProblemExportRequest } from '@polyforge/shared';
import type { Judge, ProblemCtx } from './index.js';
import type { JobCtx } from '../jobs.js';
import { HttpError, safeJoin } from '../util/fs.js';
import { exportedTests, exportTestsets } from './lemonlime.js';
import { inputPath, answerPath } from './tests.js';
import { readSamples } from './samples.js';
import { readStatementSections } from '../workspace/statements.js';
import { parseDefsToml, readSharedDefs } from '../defs.js';
import { hydroMarkdown } from './hydro.js';
import type { DefsToml } from '../../../web/src/lib/latex.js';

const fail = (message: string): never => { throw new HttpError(400, 'fps_export', message); };
const validXml = (value: string, label: string) => {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) fail(`${label}: FPS XML cannot represent these control bytes. Use the ordinary Hydro ZIP format.`);
  return value;
};
const escaped = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r/g, '&#13;');
const cdata = (value: string) => '<![CDATA[' + validXml(value, 'Text').replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
function dataText(bytes: Buffer, label: string) {
  let value: string;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail(`${label}: FPS requires UTF-8 text data. Use the ordinary Hydro ZIP for binary data.`); }
  return escaped(validXml(value, label));
}

/** Hydro's FPS importer reads these fields, and intentionally supplies no checker/subtask config. */
export async function fpsItem(judge: Judge, ctx: ProblemCtx, job: JobCtx, options: Pick<ProblemExportRequest, 'testsets' | 'lang'> = {}) {
  const config = ctx.config, p = config.problem, warnings: string[] = [];
  if (judgeMode(p) !== 'batch') fail('Hydro FPS cannot install interactors or graders. Use the ordinary Hydro ZIP format for these problems.');
  if (config.checker?.source && !config.checker.source.startsWith('std:')) warnings.push('Hydro FPS does not install special judges. The target uses Hydro default comparison; use ordinary Hydro ZIP when this checker is required.');
  if (config.lemon_checker || config.lemon_comparison) warnings.push('Hydro FPS does not carry Lemon comparison settings; the target uses Hydro default comparison.');
  const sets = exportTestsets(ctx, p.name, options.testsets);
  if (sets.length > 1 || testsetsOf(config).some(ts => sets.includes(ts.name) && (ts.group.some(group => group.dependencies?.length || group.policy !== 'EACH_TEST' || group.time_limit || group.memory_limit || group.test_points !== undefined) || Object.keys(ts.cases ?? {}).some(index => ts.cases?.[index].points !== undefined || ts.cases?.[index].time_limit !== undefined || ts.cases?.[index].memory_limit !== undefined)))) warnings.push('FPS has no subtask scores, dependencies, per-case limits or testset names. Hydro imports the exported cases with its default scoring.');
  if (p.input !== 'stdin' || p.output !== 'stdout') warnings.push('FPS has no file-IO basename; Hydro imports standard input/output settings.');
  const languages = (await judge.registry.summary(ctx.ref)).status.statementLangs;
  const lang = options.lang ?? (languages.includes('zh') ? 'zh' : languages[0] ?? 'en');
  if (!/^[a-z]{2,8}$/.test(lang)) fail('Invalid FPS statement language.');
  if (languages.length > 1) warnings.push(`FPS exports the ${lang} statement. It has no multilingual statement manifest.`);
  const defs = parseDefsToml(await readSharedDefs(judge.global.sharedDir)) as DefsToml;
  const sections = await readStatementSections(ctx.ref.dir, lang);
  const images = new Map<string, { source: string; file: string }>();
  const convert = (value: string) => {
    const result = hydroMarkdown(value, defs, lang, name => {
      const file = safeJoin(ctx.ref.dir, `statement/images/${name}`);
      const source = `fps-assets/${p.name}/${name}`;
      images.set(source, { source, file }); return source;
    });
    warnings.push(...result.warnings); return result.markdown;
  };
  const statement = Object.fromEntries([['description', sections.legend ?? ''], ['input', sections.input ?? ''], ['output', sections.output ?? ''], ['hint', [sections.scoring, sections.notes].filter(Boolean).join('\n\n')]].map(([key, value]) => [key, convert(value)]));
  const samples = (await readSamples(ctx, true, lang)).map(row => row.sample);
  const sampleInputs: string[] = [], sampleOutputs: string[] = [];
  for (const sample of samples) {
    sampleInputs.push(`<sample_input>${escaped(validXml(sample.input, 'Sample input'))}</sample_input>`);
    sampleOutputs.push(`<sample_output>${escaped(validXml(sample.output, 'Sample output'))}</sample_output>`);
  }
  const inputs: string[] = [], outputs: string[] = [];
  for (const set of await exportedTests(judge, ctx, sets, p.name, job)) for (const index of set.tests) {
    job.signal.throwIfAborted();
    const name = inputs.length + 1;
    inputs.push(`<test_input name="${name}">${dataText(await fs.readFile(inputPath(ctx, index, set.name)), `Test ${index} input`)}</test_input>`);
    outputs.push(`<test_output name="${name}">${dataText(await fs.readFile(answerPath(ctx, index, set.name)), `Test ${index} output`)}</test_output>`);
  }
  const embedded: string[] = [];
  for (const image of images.values()) embedded.push(`<img><src>${cdata(image.source)}</src><base64>${(await fs.readFile(image.file)).toString('base64')}</base64></img>`);
  const attachments = await fs.readdir(path.join(ctx.ref.dir, 'attachments')).catch(() => []);
  if (attachments.length) warnings.push('FPS cannot carry arbitrary attachments; use the ordinary Hydro ZIP to include them.');
  const solutions: string[] = [];
  for (const solution of config.solutions) {
    const extension = path.extname(solution.source).slice(1).toLowerCase();
    const language = ({ cpp: 'C++', cc: 'C++', cxx: 'C++', c: 'C', py: 'Python3', java: 'Java', js: 'JavaScript', pas: 'Pascal' })[extension] ?? extension;
    const bytes = await fs.readFile(safeJoin(ctx.ref.dir, solution.source));
    solutions.push(`<solution language="${escaped(language)}">${dataText(bytes, solution.source)}</solution>`);
  }
  const xml = `<item>\n<title>${cdata(p.title[lang] || p.title.en || p.title.zh || p.name)}</title>\n<time_limit unit="ms">${p.time_limit}</time_limit>\n<memory_limit unit="mb">${Math.ceil(p.memory_limit)}</memory_limit>\n` +
    Object.entries(statement).map(([name, value]) => `<${name}>${cdata(`[md]${value}[/md]`)}</${name}>`).join('\n') + '\n' +
    [...sampleInputs, ...sampleOutputs, ...inputs, ...outputs, ...solutions, ...embedded].join('\n') + '\n</item>';
  return { xml, tests: inputs.length, warnings: [...new Set(warnings)] };
}
export const fpsDocument = (items: string[]) => Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<fps version="1.6" url="https://github.com/zhblue/freeproblemset/"><generator name="Taskweave"/>\n' + items.join('\n') + '\n</fps>\n');
export async function fpsPackage(judge: Judge, ctx: ProblemCtx, job: JobCtx, options: Pick<ProblemExportRequest, 'testsets' | 'lang'> = {}) {
  const result = await fpsItem(judge, ctx, job, options);
  return { data: fpsDocument([result.xml]), tests: result.tests, warnings: result.warnings };
}
