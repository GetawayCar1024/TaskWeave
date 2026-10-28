import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { importPackage, inspectPackage } from '../src/imports/packages.js';
import { fpsPackage } from '../src/judge/fps.js';
import { ZipWriter } from '../src/util/zip.js';

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const item = `<item><title><![CDATA[测试 A+B]]></title><time_limit unit="s">1.5</time_limit><memory_limit unit="kb">65536</memory_limit>
<description><![CDATA[<p>Compute $a_b$ &amp; show <img src="diagram.png"></p>]]></description><input><![CDATA[Two numbers.]]></input><output>Sum.</output>
<sample_input>1 2</sample_input><sample_output>3</sample_output>
<test_input name="01"><![CDATA[a &lt; ]]]]><![CDATA[>b]]></test_input><test_output name="01">&#13;\n</test_output>
<test_input name="02"></test_input><test_output name="02"></test_output>
<solution language="C++"><![CDATA[int main(){}]]></solution><spj language="C++"><![CDATA[int main(){return 0;}]]></spj>
<img><src>diagram.png</src><base64>${image}</base64></img></item>`;
const xml = (body = item) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fps SYSTEM "http://hustoj.com/fps.current.dtd"><fps version="1.6">${body}</fps>`);
async function fixture(run: (judge: Judge, registry: ProblemRegistry) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-fps-'));
  const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
  const registry = new ProblemRegistry(global), judge = new Judge(global, registry, new WsHub());
  try { await run(judge, registry); } finally { await fs.rm(home, { recursive: true, force: true }); }
}

test('FPS XML and ZIP selection preserve Unicode, CDATA, empty tests, samples, images and source roles', async () => fixture(async judge => {
  const candidates = inspectPackage(xml(item + item), { format: 'auto', lang: 'en' });
  assert.equal(candidates.length, 2); assert.notEqual(candidates[0].entry, candidates[1].entry);
  assert.equal(candidates[0].title, '测试 A+B'); assert.equal(candidates[0].tests, 2); assert.equal(candidates[0].error, undefined);
  const imported = await importPackage(judge, xml(), { format: 'fps', name: 'fps-problem', lang: 'en' });
  assert.equal(imported.problem.timeLimit, 1500); assert.equal(imported.problem.memoryLimit, 64);
  assert.equal(await fs.readFile(path.join(imported.problem.dir, 'tests/manual/1.in'), 'utf8'), 'a &lt; ]]>b');
  assert.equal(await fs.readFile(path.join(imported.problem.dir, 'tests/manual/1.ans'), 'utf8'), '\r\n');
  assert.equal((await fs.stat(path.join(imported.problem.dir, 'tests/manual/2.ans'))).size, 0);
  assert.deepEqual(await fs.readFile(path.join(imported.problem.dir, 'statement/images/fps-image-1.png')), Buffer.from(image, 'base64'));
  assert.match(await fs.readFile(path.join(imported.problem.dir, 'statement/en/legend.tex'), 'utf8'), /\$a_b\$/);
  const config = (await judge.registry.detail(imported.problem.id)).config!;
  assert.equal(config.tests.cases?.[1].original_input, '01.in'); assert.equal(config.solutions[0].source, 'solutions/fps-1.cpp');
  assert.ok(config.testsets.samples); assert.ok(imported.warnings.some(warning => warning.includes('HUSTOJ')));
  const zip = new ZipWriter(); zip.add('one.xml', xml()); zip.add('two.xml', xml());
  assert.equal(inspectPackage(zip.finish(), { format: 'auto' }).length, 2);
}));

test('FPS export/import keeps text data including CRLF, empty bytes and markup delimiters', async () => fixture(async judge => {
  const imported = await importPackage(judge, xml(), { format: 'fps', name: 'before', lang: 'en' });
  const exported = await fpsPackage(judge, await judge.ctx(imported.problem.id), { signal: new AbortController().signal, progress() {} }, { lang: 'en', testsets: ['tests'] });
  assert.match(exported.data.toString(), /^<\?xml version="1.0" encoding="UTF-8"/);
  assert.match(exported.data.toString(), /<test_output name="2"><\/test_output>/);
  const restored = await importPackage(judge, exported.data, { format: 'auto', name: 'after', lang: 'en' });
  for (const file of ['1.in', '1.ans', '2.in', '2.ans']) assert.deepEqual(await fs.readFile(path.join(restored.problem.dir, 'tests/manual', file)), await fs.readFile(path.join(imported.problem.dir, 'tests/manual', file)));
}));

test('FPS rejects entities, mismatched test arrays and unrepresentable binary output', async () => fixture(async judge => {
  assert.throws(() => inspectPackage(Buffer.from('<!DOCTYPE fps [<!ENTITY e "x">]><fps><item><title>&e;</title></item></fps>'), { format: 'fps' }), /entit/i);
  const invalid = inspectPackage(xml('<item><title>Bad</title><test_input name="1">x</test_input><test_output name="1">x</test_output><test_output name="2">x</test_output></item>'), { format: 'fps' });
  assert.match(invalid[0].error ?? '', /counts do not match/);
  const imported = await importPackage(judge, xml(), { format: 'fps', name: 'binary' });
  await fs.writeFile(path.join(imported.problem.dir, 'tests/manual/1.ans'), Buffer.from([0, 255]));
  await assert.rejects(fpsPackage(judge, await judge.ctx(imported.problem.id), { signal: new AbortController().signal, progress() {} }), /UTF-8|control bytes/);
}));

test('named FPS test arrays pair matching names and reject conflicting mappings', async () => fixture(async judge => {
  const named = '<item><title>Named</title><test_input name="01">one</test_input><test_input name="02">two</test_input><test_output name="02">second</test_output><test_output name="01">first</test_output></item>';
  const imported = await importPackage(judge, xml(named), { format: 'auto', name: 'named-fps' });
  assert.equal(await fs.readFile(path.join(imported.problem.dir, 'tests/manual/1.ans'), 'utf8'), 'first');
  assert.equal(await fs.readFile(path.join(imported.problem.dir, 'tests/manual/2.ans'), 'utf8'), 'second');
  assert.match(inspectPackage(xml(named.replace('<test_output name="01">', '<test_output name="03">')), { format: 'auto' })[0].error ?? '', /names do not match/);
}));
