/**
 * In-memory mock of the Polygon API for developing and testing sync without a real
 * account. Verifies apiSig like Polygon does and implements the methods PolyForge uses.
 *
 *   pnpm --filter @polyforge/server mock-polygon [--port 4700] [--key K] [--secret S]
 *
 * Point PolyForge at it with secrets.toml: [polygon] api_url = "http://127.0.0.1:4700/api/".
 * GET /__dump returns the whole state as JSON; GET /__contest defines a contest.
 */
import http from 'node:http';
import { parseArgs } from 'node:util';
import { apiSignature } from '../src/polygon/client.js';

const { values: args } = parseArgs({
  options: { port: { type: 'string', default: '4700' }, key: { type: 'string', default: 'mock-key' }, secret: { type: 'string', default: 'mock-secret' } },
});

interface Test {
  index: number;
  manual: boolean;
  input?: string;
  group?: string;
  points?: number;
  useInStatements?: boolean;
  inputForStatement?: string;
  outputForStatement?: string;
}

interface Testset {
  script: string;
  tests: Record<number, Test>;
  groupsEnabled: boolean;
  groups: Record<string, { name: string; pointsPolicy: string; feedbackPolicy: string; dependencies: string[] }>;
}

interface Prob {
  id: number;
  name: string;
  owner: string;
  revision: number;
  modified: boolean;
  info: { inputFile: string; outputFile: string; interactive: boolean; timeLimit: number; memoryLimit: number };
  validator: string;
  checker: string;
  interactor: string;
  source: Record<string, { text: Buffer; sourceType?: string }>;
  resource: Record<string, Buffer>;
  solutions: Record<string, { text: Buffer; tag: string; sourceType?: string }>;
  statements: Record<string, Record<string, string>>;
  statementResources: Record<string, Buffer>;
  script: string;
  tests: Record<number, Test>;
  groupsEnabled: boolean;
  pointsEnabled: boolean;
  groups: Record<string, { name: string; pointsPolicy: string; feedbackPolicy: string; dependencies: string[] }>;
  validatorTests: Record<number, { index: number; input: string; expectedVerdict: string }>;
  /** Testsets other than "tests" (create with GET /__testset?problem=ID&name=NAME). */
  extraTestsets: Record<string, Testset>;
  checkerTests: Record<number, { index: number; input: string; output: string; answer: string; expectedVerdict: string }>;
}

const problems = new Map<number, Prob>();
/** contestId -> index -> problem id (set up through GET /__contest). */
const contests = new Map<number, Record<string, number>>();
let nextId = 100000;
let calls = 0;

const DEFAULT_RESOURCES = ['olymp.sty', 'problem.tex', 'statements.ftl', 'testlib.h'];

function newProblem(name: string): Prob {
  const p: Prob = {
    id: nextId++,
    name,
    owner: 'mock',
    revision: 1,
    modified: false,
    info: { inputFile: 'stdin', outputFile: 'stdout', interactive: false, timeLimit: 1000, memoryLimit: 256 },
    validator: '',
    checker: '',
    interactor: '',
    source: {},
    resource: Object.fromEntries(DEFAULT_RESOURCES.map((n) => [n, Buffer.from(`default ${n}`)])),
    solutions: {},
    statements: {},
    statementResources: {},
    script: '',
    tests: {},
    groupsEnabled: false,
    pointsEnabled: false,
    groups: {},
    validatorTests: {},
    checkerTests: {},
    extraTestsets: {},
  };
  problems.set(p.id, p);
  return p;
}

class Fail extends Error {}

const bool = (v?: string) => v === 'true';

function handle(method: string, a: Record<string, string>, files: Record<string, Buffer>): unknown {
  const get = (): Prob => {
    const p = problems.get(Number(a.problemId));
    if (!p) throw new Fail('problemId: Problem not found');
    return p;
  };
  const touch = (p: Prob) => (p.modified = true);
  /** The testset named by the testset parameter ("tests" is the problem itself). */
  const set = (p: Prob): Testset => {
    const name = a.testset ?? 'tests';
    if (name === 'tests') return p;
    const t = p.extraTestsets[name];
    if (!t) throw new Fail(`testset: Testset "${name}" not found`);
    return t;
  };
  const content = (k: string) => files[k] ?? (a[k] !== undefined ? Buffer.from(a[k]) : undefined);
  const brief = (p: Prob) => ({ id: p.id, name: p.name, owner: p.owner, accessType: 'OWNER', revision: p.revision, modified: p.modified, deleted: false });

  switch (method) {
    case 'problems.list':
      return [...problems.values()].filter((p) => (!a.id || p.id === Number(a.id)) && (!a.name || p.name === a.name)).map(brief);
    case 'problem.create': {
      if (!/^[a-z0-9-]+$/.test(a.name ?? '')) throw new Fail('name: Invalid problem name');
      if ([...problems.values()].some((p) => p.name === a.name)) throw new Fail('name: Problem with this name already exists');
      return brief(newProblem(a.name));
    }
    case 'problem.info':
      return get().info;
    case 'problem.updateInfo': {
      const p = get();
      if (a.inputFile) p.info.inputFile = a.inputFile;
      if (a.outputFile) p.info.outputFile = a.outputFile;
      if (a.interactive) p.info.interactive = bool(a.interactive);
      if (a.timeLimit) p.info.timeLimit = Number(a.timeLimit);
      if (a.memoryLimit) p.info.memoryLimit = Number(a.memoryLimit);
      touch(p);
      return null;
    }
    case 'problem.validator':
      return get().validator;
    case 'problem.checker':
      return get().checker;
    case 'problem.interactor':
      return get().interactor;
    case 'problem.setValidator':
    case 'problem.setChecker':
    case 'problem.setInteractor': {
      const p = get();
      const role = method.slice('problem.set'.length).toLowerCase() as 'validator' | 'checker' | 'interactor';
      const name = a[role];
      if (!name.startsWith('std::') && !p.source[name]) throw new Fail(`${role}: No such source file ${name}`);
      p[role] = name;
      touch(p);
      return null;
    }
    case 'problem.files': {
      const p = get();
      const f = (n: string, len: number, sourceType?: string) => ({ name: n, modificationTimeSeconds: 0, length: len, sourceType });
      return {
        resourceFiles: Object.entries(p.resource).map(([n, b]) => f(n, b.length)),
        sourceFiles: Object.entries(p.source).map(([n, s]) => f(n, s.text.length, s.sourceType ?? 'cpp.g++17')),
        auxFiles: [],
      };
    }
    case 'problem.viewFile': {
      const p = get();
      const f = a.type === 'source' ? p.source[a.name]?.text : a.type === 'resource' ? p.resource[a.name] : undefined;
      if (!f) throw new Fail('name: File not found');
      return { raw: f };
    }
    case 'problem.saveFile': {
      const p = get();
      const file = content('file');
      if (!file) throw new Fail('file: Field should not be empty');
      if (a.type === 'source') p.source[a.name] = { text: file, sourceType: a.sourceType };
      else if (a.type === 'resource') p.resource[a.name] = file;
      else throw new Fail('type: invalid');
      touch(p);
      return null;
    }
    case 'problem.solutions':
      return Object.entries(get().solutions).map(([name, s]) => ({ name, modificationTimeSeconds: 0, length: s.text.length, sourceType: s.sourceType ?? 'cpp.g++17', tag: s.tag }));
    case 'problem.viewSolution': {
      const s = get().solutions[a.name];
      if (!s) throw new Fail('name: Solution not found');
      return { raw: s.text };
    }
    case 'problem.saveSolution': {
      const p = get();
      const file = content('file');
      if (!file) throw new Fail('file: Field should not be empty');
      if (!['MA', 'OK', 'RJ', 'TL', 'TO', 'WA', 'PE', 'ML', 'RE', 'TM', 'NR'].includes(a.tag)) throw new Fail(`tag: invalid tag ${a.tag}`);
      if (a.tag === 'MA' && Object.entries(p.solutions).some(([n, s]) => s.tag === 'MA' && n !== a.name)) throw new Fail('tag: Only one main solution is allowed');
      p.solutions[a.name] = { text: file, tag: a.tag, sourceType: a.sourceType };
      touch(p);
      return null;
    }
    case 'problem.statements':
      return get().statements;
    case 'problem.saveStatement': {
      const p = get();
      const st = (p.statements[a.lang] ??= { encoding: 'UTF-8' });
      for (const k of ['name', 'legend', 'input', 'output', 'scoring', 'interaction', 'notes', 'tutorial']) if (a[k] !== undefined) st[k] = a[k];
      touch(p);
      return null;
    }
    case 'problem.statementResources':
      return Object.entries(get().statementResources).map(([name, b]) => ({ name, modificationTimeSeconds: 0, length: b.length }));
    case 'problem.viewStatementResource': {
      const r = get().statementResources[a.name];
      if (!r) throw new Fail('name: not found');
      return { raw: r };
    }
    case 'problem.saveStatementResource': {
      const p = get();
      p.statementResources[a.name] = content('file') ?? Buffer.alloc(0);
      touch(p);
      return null;
    }
    case 'problem.script':
      return { raw: Buffer.from(set(get()).script) };
    case 'problem.saveScript': {
      const p = get();
      const ts = set(p);
      // As on Polygon: "> N" must not hit a manual test, "> $" takes the next free index.
      const tests = ts.tests;
      for (const [i, t] of Object.entries(tests)) if (!t.manual) delete tests[Number(i)];
      const used = new Set(Object.keys(tests).map(Number));
      let next = 1;
      for (const raw of String(a.source ?? '').split('\n')) {
        const m = raw.trim().match(/>\s*(\$|\d+)\s*$/);
        if (!m) continue;
        let idx: number;
        if (m[1] === '$') {
          while (used.has(next)) next++;
          idx = next;
        } else {
          idx = Number(m[1]);
          if (tests[idx]?.manual) throw new Fail(`source: test ${idx} is a manual test`);
        }
        used.add(idx);
        tests[idx] = { index: idx, manual: false };
      }
      ts.script = a.source ?? '';
      touch(p);
      return null;
    }
    case 'problem.tests':
      return Object.values(set(get()).tests)
        .sort((x, y) => x.index - y.index)
        .map((t) => ({ index: t.index, manual: t.manual, input: t.manual ? t.input : undefined, group: t.group ?? '', points: t.points ?? 0, useInStatements: !!t.useInStatements, description: '', inputForStatement: t.inputForStatement ?? '', outputForStatement: t.outputForStatement ?? '' }));
    case 'problem.testInput': {
      const t = set(get()).tests[Number(a.testIndex)];
      if (!t) throw new Fail('testIndex: not found');
      return { raw: Buffer.from(t.input ?? '') };
    }
    case 'problem.saveTest': {
      const p = get();
      const i = Number(a.testIndex);
      if (a.testInput !== undefined && set(p).tests[i] && !set(p).tests[i].manual) throw new Fail(`testIndex: test ${i} is generated by the script`);
      const t = (set(p).tests[i] ??= { index: i, manual: a.testInput !== undefined });
      if (a.testInput !== undefined) Object.assign(t, { manual: true, input: a.testInput });
      if (a.testGroup !== undefined) t.group = a.testGroup;
      if (a.testPoints !== undefined) {
        if (!p.pointsEnabled) throw new Fail('testPoints: Points are disabled for this problem');
        t.points = Number(a.testPoints);
      }
      if (a.testUseInStatements !== undefined) t.useInStatements = bool(a.testUseInStatements);
      if (a.testInputForStatements !== undefined) t.inputForStatement = a.testInputForStatements;
      if (a.testOutputForStatements !== undefined) t.outputForStatement = a.testOutputForStatements;
      touch(p);
      return null;
    }
    case 'problem.enableGroups': {
      const p = get();
      set(p).groupsEnabled = bool(a.enable);
      touch(p);
      return null;
    }
    case 'problem.enablePoints': {
      const p = get();
      p.pointsEnabled = bool(a.enable);
      touch(p);
      return null;
    }
    case 'problem.viewTestGroup': {
      const p = get();
      if (!set(p).groupsEnabled) throw new Fail('testset: Groups are not enabled');
      return Object.values(set(p).groups).filter((g) => !a.group || g.name === a.group);
    }
    case 'problem.saveTestGroup': {
      const p = get();
      if (!set(p).groupsEnabled) throw new Fail('testset: Groups are not enabled');
      set(p).groups[a.group] = { name: a.group, pointsPolicy: a.pointsPolicy ?? 'COMPLETE_GROUP', feedbackPolicy: a.feedbackPolicy ?? 'COMPLETE', dependencies: a.dependencies ? a.dependencies.split(',') : [] };
      touch(p);
      return null;
    }
    case 'problem.setTestGroup': {
      const p = get();
      if (!set(p).groupsEnabled) throw new Fail('testset: Groups are not enabled');
      const idx = a.testIndices ? a.testIndices.split(',').map(Number) : [Number(a.testIndex)];
      for (const i of idx) (set(p).tests[i] ??= { index: i, manual: false }).group = a.testGroup;
      touch(p);
      return null;
    }
    case 'problem.validatorTests':
      return Object.values(get().validatorTests);
    case 'problem.saveValidatorTest': {
      const p = get();
      const i = Number(a.testIndex);
      p.validatorTests[i] = { index: i, input: a.testInput ?? '', expectedVerdict: a.testVerdict };
      touch(p);
      return null;
    }
    case 'problem.checkerTests':
      return Object.values(get().checkerTests);
    case 'problem.saveCheckerTest': {
      const p = get();
      const i = Number(a.testIndex);
      p.checkerTests[i] = { index: i, input: a.testInput ?? '', output: a.testOutput ?? '', answer: a.testAnswer ?? '', expectedVerdict: a.testVerdict };
      touch(p);
      return null;
    }
    case 'problem.commitChanges': {
      const p = get();
      if (p.modified) p.revision++;
      p.modified = false;
      return null;
    }
    case 'contest.problems': {
      const c = contests.get(Number(a.contestId));
      if (!c) throw new Fail('contestId: Contest not found');
      return Object.fromEntries(Object.entries(c).map(([idx, id]) => [idx, { ...brief(problems.get(id)!), index: idx }]));
    }
    case 'problem.buildPackage':
      get();
      return null;
    default:
      throw new Fail(`Unknown method ${method}`);
  }
}

const server = http.createServer(async (req, res) => {
  const send = (code: number, body: string | Buffer, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type });
    res.end(body);
  };
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/__dump') {
    const replacer = (_k: string, v: any) => (v && v.type === 'Buffer' && Array.isArray(v.data) ? Buffer.from(v.data).toString('utf8') : v);
    return send(200, JSON.stringify([...problems.values()], replacer, 1));
  }
  if (url.pathname === '/__testset') {
    const p = problems.get(Number(url.searchParams.get('problem')));
    const name = url.searchParams.get('name') ?? '';
    if (!p || !name || name === 'tests') return send(400, JSON.stringify({ error: 'bad problem or name' }));
    p.extraTestsets[name] ??= { script: '', tests: {}, groupsEnabled: false, groups: {} };
    return send(200, JSON.stringify({ ok: true }));
  }
  // GET /__contest?id=5&problems=A:100000,B:100001 defines a contest for contest.problems.
  if (url.pathname === '/__contest') {
    const map: Record<string, number> = {};
    for (const part of (url.searchParams.get('problems') ?? '').split(',').filter(Boolean)) {
      const [idx, id] = part.split(':');
      if (!problems.has(Number(id))) return send(400, JSON.stringify({ error: 'unknown problem ' + id }));
      map[idx] = Number(id);
    }
    contests.set(Number(url.searchParams.get('id')), map);
    return send(200, JSON.stringify({ ok: true }));
  }
  const m = url.pathname.match(/^\/api\/([\w.]+)$/);
  if (!m) return send(404, 'not found', 'text/plain');
  const method = m[1];
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: Buffer.concat(chunks) }).formData();
  const a: Record<string, string> = {};
  const files: Record<string, Buffer> = {};
  const pairs: [Buffer, Buffer][] = [];
  let sig = '';
  for (const [k, v] of form.entries()) {
    const bytes = typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(await v.arrayBuffer());
    if (k === 'apiSig') {
      sig = bytes.toString();
      continue;
    }
    pairs.push([Buffer.from(k), bytes]);
    if (typeof v === 'string') a[k] = v;
    else {
      files[k] = bytes;
      a[k] = bytes.toString('utf8');
    }
  }
  calls++;
  const fail = (comment: string) => send(400, JSON.stringify({ status: 'FAILED', comment }));
  if (a.apiKey !== args.key) return fail('apiKey: Incorrect API key');
  if (Math.abs(Number(a.time) - Date.now() / 1000) > 300) return fail('time: Incorrect time');
  if (!sig || apiSignature(method, pairs, args.secret!, sig.slice(0, 6)) !== sig) return fail('apiSig: Incorrect signature');
  try {
    const result = handle(method, a, files);
    if (result && typeof result === 'object' && 'raw' in (result as object)) return send(200, (result as { raw: Buffer }).raw, 'application/octet-stream');
    send(200, JSON.stringify({ status: 'OK', result }));
  } catch (e) {
    if (e instanceof Fail) return fail(e.message);
    console.error(e);
    send(500, 'internal error', 'text/plain');
  }
});

server.listen(Number(args.port), '127.0.0.1', () => console.log(`[mock-polygon] http://127.0.0.1:${args.port}/api/  key=${args.key} secret=${args.secret}`));
process.on('SIGINT', () => {
  console.log(`[mock-polygon] ${calls} calls`);
  process.exit(0);
});
