import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseData } from '../src/imports/data.js';
const files = (values: Record<string, string>) => new Map(Object.entries(values).map(([name, value]) => [name, Buffer.from(value)]));

test('Hydro references repair only unique paths and answer suffixes while recording warnings', () => {
  const result = parseData(files({
    'case01.IN': 'input', 'case01.out': 'answer',
    'config.yaml': 'subtasks:\n  - id: 1\n    score: 100\n    type: sum\n    cases:\n      - input: old/case01.in\n        output: old/case01.ans\n',
  }), 'hydro');
  assert.deepEqual(result.pairs.map(pair => [pair.input, pair.output]), [['case01.IN', 'case01.out']]);
  assert.equal(result.warnings.filter(message => message.startsWith('Package reference corrected:')).length, 2);
});

test('Luogu config entries follow actual filename casing and stale references cannot disappear silently', () => {
  const result = parseData(files({ 'One.IN': '1', 'One.OUT': '2', 'config.yml': 'one.in: { score: 73, timeLimit: 2000 }' }), 'luogu');
  assert.equal(result.cases[1].points, 73); assert.equal(result.cases[1].time_limit, 2000);
  assert.ok(result.warnings.some(message => message.includes('one.in -> One.IN')));
  assert.throws(() => parseData(files({ '1.in': '1', '1.out': '2', 'config.yml': 'missing.in: { score: 100 }' }), 'luogu'), /Missing file referenced/);
});

test('ambiguous mappings and conflicting answers are rejected instead of assigning the wrong bytes', () => {
  assert.throws(() => parseData(files({ 'a/1.in': 'a', 'b/1.in': 'b', '1.out': 'answer', 'config.yaml': 'cases: [{ input: old/1.in, output: 1.out }]' }), 'hydro'), /Ambiguous file reference/);
  assert.throws(() => parseData(files({ '1.in': 'a', '1.out': 'answer', '1.ans': 'other answer' }), 'auto'), /Ambiguous answers/);
  assert.throws(() => parseData(files({ '1.in': 'a', 'config.yaml': 'cases: [{ input: 1.in, output: 1.out }]' }), 'hydro'), /Missing file referenced/);
});

test('explicit answer extensions win over suffix recovery after correcting path casing', () => {
  const result = parseData(files({ 'Case.in': 'input', 'Case.ans': 'intended', 'Case.out': 'different', 'config.yaml': 'cases: [{ input: case.in, output: case.ans }]' }), 'hydro');
  assert.equal(result.pairs[0].output, 'Case.ans'); assert.equal(result.pairs[0].outputData.toString(), 'intended');
});
