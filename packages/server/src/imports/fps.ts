/// <reference path="../types/turndown-plugin-gfm.d.ts" />
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { compressRanges, problemTomlSchema, type PackageCandidate, type PackageImportOptions, type PackageImportResult } from '@taskweave/shared';
import type { Judge } from '../judge/index.js';
import { HttpError, validateFileName } from '../util/fs.js';
import { publishProblem } from './publish.js';
import { hydroLimit } from './data.js';
import { xmlRoot } from './input.js';

type XmlNode = Record<string, any>;
function fail(message: string): never { throw new HttpError(400, 'fps_import', message); }
const children = (node: XmlNode[], name: string): XmlNode[] => node.filter(child => Object.hasOwn(child, name));
function xmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#x[\da-f]+|#\d+);/gi, entity => {
    const known: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (known[entity]) return known[entity];
    const value = /^&#x/i.test(entity) ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    if (!Number.isInteger(value) || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff || value < 32 && ![9, 10, 13].includes(value)) fail('Invalid XML character reference.');
    return String.fromCodePoint(value);
  });
}
const text = (nodes: XmlNode[] = [], cdata = false): string => nodes.map(node => Object.entries(node).filter(([key]) => key !== ':@').map(([key, value]) => key === '#text' ? cdata ? String(value) : xmlText(String(value)) : Array.isArray(value) ? text(value, key === '#cdata') : '').join('')).join('');
const values = (node: XmlNode[], name: string) => children(node, name).map(child => ({ value: text(child[name]), attributes: Object.fromEntries(Object.entries(child[':@'] ?? {}).map(([key, value]) => [key, xmlText(String(value))])) }));
const first = (node: XmlNode[], name: string) => values(node, name)[0]?.value ?? '';
const slug = (value: string, fallback: string) => value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || fallback;
const html = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }); html.use(gfm);
function markdown(source: string): string {
  if (source.includes('[md]')) return source.replace(/\[\/?md\]/g, '');
  if (!/<[a-z][\s\S]*>/i.test(source)) return source;
  const math: string[] = [];
  const protectedSource = source.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, value => `FPSMATHPLACEHOLDER${math.push(value) - 1}END`);
  return html.turndown(protectedSource).replace(/FPSMATHPLACEHOLDER(\d+)END/g, (_, index) => math[Number(index)]);
}

interface FpsItem { entry: string; file: string; index: number; nodes: XmlNode[]; original: Buffer }
function items(files: Map<string, Buffer>): FpsItem[] {
  const out: FpsItem[] = [];
  for (const [file, original] of files) {
    if (!/\.xml$/i.test(file) || xmlRoot(original) !== 'fps') continue;
    let source: string;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(original); } catch { return fail(`${file}: FPS must be UTF-8 XML.`); }
    if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(source)) fail(`${file}: XML entity declarations are not supported.`);
    source = source.replace(/<!DOCTYPE\s+fps\s+(?:PUBLIC\s+"[^"]*"\s+|SYSTEM\s+)(?:"[^"]*"|'[^']*')\s*>/i, '');
    const valid = XMLValidator.validate(source); if (valid !== true) fail(`${file}: Invalid FPS XML: ${valid.err.msg}`);
    const tree = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', trimValues: false, parseTagValue: false, parseAttributeValue: false, cdataPropName: '#cdata', processEntities: false }).parse(source) as XmlNode[];
    const fps = tree.find(node => Array.isArray(node.fps)); if (!fps) fail(`${file}: Missing fps root.`);
    for (const [index, item] of children(fps.fps, 'item').entries()) out.push({ entry: `${file}#${index + 1}`, file, index, nodes: item.item, original });
  }
  if (!out.length) fail('No FPS items found in the XML or package.');
  return out;
}
function pairs(nodes: XmlNode[], input: string, output: string, legacy = false, warnings: string[] = []) {
  let ins = values(nodes, input), outs = values(nodes, output);
  const alternating = legacy && ins.length && !outs.length && ins.length % 2 === 0;
  if (alternating) { outs = ins.filter((_, index) => index % 2 === 1); ins = ins.filter((_, index) => index % 2 === 0); }
  if (ins.length !== outs.length) fail(`FPS ${input}/${output} counts do not match.`);
  if (!alternating && [...ins, ...outs].some(entry => entry.attributes.name)) {
    const byName = new Map(outs.map((entry, index) => [String(entry.attributes.name || index + 1), entry]));
    if (byName.size !== outs.length) fail(`FPS ${output} has duplicate test names.`);
    const ordered = ins.map((entry, index) => byName.get(String(entry.attributes.name || index + 1)) ?? fail(`FPS ${input}/${output} names do not match.`));
    if (ordered.some((entry, index) => entry !== outs[index])) warnings.push(`FPS ${input}/${output} order was corrected using the explicit test names.`);
    outs = ordered;
  }
  const names = new Set<string>();
  return ins.map((value, index) => {
    const name = (entry: typeof value, extension: string) => String(entry.attributes.filename ?? `${entry.attributes.name || index + 1}.${extension}`);
    const inputName = name(value, 'in'), outputName = name(outs[index], 'out');
    validateFileName(inputName); validateFileName(outputName);
    const key = inputName.toLowerCase(); if (names.has(key)) fail(`Duplicate FPS input name: ${inputName}`); names.add(key);
    return { inputName, outputName, input: Buffer.from(value.value), output: Buffer.from(outs[index].value) };
  });
}
function plan(item: FpsItem, options: PackageImportOptions) {
  const node = item.nodes;
  const title = markdown(first(node, 'title')).trim() || `Imported problem ${item.index + 1}`;
  const name = options.name || slug(title, `fps-${item.index + 1}`);
  const lang = /^[a-z]{2,8}$/.test(options.lang ?? '') ? options.lang! : 'zh';
  const time = values(node, 'time_limit')[0], memory = values(node, 'memory_limit')[0];
  const timeLimit = options.timeLimit ?? hydroLimit(`${time?.value || '1'}${time?.attributes.unit || 's'}`, 'time', 1000);
  const memoryLimit = options.memoryLimit ?? hydroLimit(`${memory?.value || '256'}${memory?.attributes.unit || 'mb'}`, 'memory', 256);
  const files = new Map<string, Buffer>(), warnings: string[] = [];
  const tests = pairs(node, 'test_input', 'test_output', true, warnings), samples = pairs(node, 'sample_input', 'sample_output', false, warnings);
  files.set(`other/fps/${item.file}`, item.original);
  const imageMap = new Map<string, string>();
  for (const [index, image] of children(node, 'img').entries()) {
    const src = first(image.img, 'src'), base64 = first(image.img, 'base64').replace(/\s/g, '');
    if (!src || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) fail('Invalid FPS embedded image.');
    const extension = src.split(/[?#]/)[0].match(/\.(png|jpe?g|gif|bmp|svg|webp|avif)$/i)?.[1] ?? 'bin';
    const name = `fps-image-${index + 1}.${extension}`;
    files.set(`statement/images/${name}`, Buffer.from(base64, 'base64')); imageMap.set(src, name);
  }
  for (const [field, section] of [['description', 'legend'], ['input', 'input'], ['output', 'output'], ['hint', 'notes']] as const) {
    let source = first(node, field);
    for (const [src, destination] of imageMap) source = source.split(src).join(destination);
    files.set(`statement/${lang}/${section}.tex`, Buffer.from(markdown(source)));
  }
  const source = first(node, 'source'); if (source) files.set('other/fps/source.txt', Buffer.from(source));
  const url = first(node, 'url'); if (url) files.set('other/fps/url.txt', Buffer.from(url));
  const cases: Record<string, { original_input: string; original_output: string }> = {};
  tests.forEach((pair, index) => { files.set(`tests/manual/${index + 1}.in`, pair.input); files.set(`tests/manual/${index + 1}.ans`, pair.output); cases[index + 1] = { original_input: pair.inputName, original_output: pair.outputName }; });
  const doc: Record<string, any> = { problem: { name, title: options.title ?? { [lang]: title }, data_only: true, time_limit: timeLimit, memory_limit: memoryLimit, input: 'stdin', output: 'stdout' },
    tests: { manual: 'tests/manual', answers: 'provided', points: true, cases, groups: true, group: tests.length ? [{ name: 'all', tests: `1-${tests.length}`, points: 100, policy: 'EACH_TEST' }] : [] }, checker: { source: 'std:wcmp' } };
  if (samples.length) {
    samples.forEach((pair, index) => { files.set(`tests/samples/${index + 1}.in`, pair.input); files.set(`tests/samples/${index + 1}.ans`, pair.output); });
    doc.testsets = { samples: { manual: 'tests/samples', answers: 'provided', samples: compressRanges(samples.map((_, index) => index + 1)), groups: true, group: [{ name: 'samples', tests: `1-${samples.length}`, points: 0, policy: 'EACH_TEST' }] } };
  }
  const extension = (language: string) => ({ 'c++': 'cpp', cpp: 'cpp', c: 'c', python: 'py', python3: 'py', java: 'java', javascript: 'js', pascal: 'pas' })[language.toLowerCase()] ?? 'txt';
  for (const [index, solution] of values(node, 'solution').entries()) {
    const file = `solutions/fps-${index + 1}.${extension(String(solution.attributes.language ?? 'text'))}`;
    files.set(file, Buffer.from(solution.value)); (doc.solutions ??= []).push({ source: file, tag: index === 0 ? 'MA' : 'OK' });
  }
  for (const role of ['spj', 'tpj', 'interactor', 'prepend', 'template', 'append']) for (const [index, entry] of values(node, role).entries()) {
    const file = `other/fps/${role}-${index + 1}.${extension(String(entry.attributes.language ?? 'text'))}`;
    files.set(file, Buffer.from(entry.value));
    if (role === 'tpj') doc.checker = { source: file };
    if (role === 'interactor') { doc.interactor = { source: file }; warnings.push('FPS interactor source was preserved. Configure the interaction before enabling full authoring.'); }
    if (role === 'spj') warnings.push('FPS HUSTOJ special judge source was preserved; it uses input/answer/output order and requires conversion for local Testlib judging.');
  }
  if (first(node, 'remote_oj')) warnings.push('FPS remote-judge references were preserved in the source XML; configure local data before judging.');
  if (!tests.length) warnings.push('FPS contains no judged tests. Statement samples were retained separately.');
  problemTomlSchema.parse(doc);
  return { title, name, lang, timeLimit, memoryLimit, tests: tests.length, files, doc, warnings };
}

export function fpsCandidates(files: Map<string, Buffer>, options: PackageImportOptions): PackageCandidate[] {
  return items(files).map(item => {
    try { const value = plan(item, options); return { entry: item.entry, title: value.title, name: value.name, tests: value.tests, files: value.files.size, size: item.original.length, timeLimit: value.timeLimit, memoryLimit: value.memoryLimit, warnings: value.warnings }; }
    catch (e) { return { entry: item.entry, name: `fps-${item.index + 1}`, title: first(item.nodes, 'title'), error: (e as Error).message }; }
  });
}
export async function importFps(judge: Judge, files: Map<string, Buffer>, options: PackageImportOptions, problemId?: string): Promise<PackageImportResult> {
  const candidates = items(files), item = candidates.find(item => item.entry === options.entry) ?? (candidates.length === 1 && !options.entry ? candidates[0] : undefined);
  if (!item) fail('Select an FPS problem from the package.');
  const value = plan(item, options);
  if (problemId) {
    const data = new Map<string, Buffer>();
    for (const [file, bytes] of value.files) if (file.startsWith('tests/manual/')) data.set(file.slice('tests/manual/'.length), bytes);
    data.set('fps-original.xml', item.original);
    const { importPackage } = await import('./packages.js');
    const result = await importPackage(judge, data, { ...options, format: 'data', entry: undefined }, problemId);
    return { ...result, warnings: [...result.warnings, ...value.warnings] };
  }
  return { problem: await publishProblem(judge, value.files, value.doc, options.root, options.folder), tests: value.tests, extras: [...value.files.keys()].filter(file => file.startsWith('other/')), warnings: value.warnings };
}
