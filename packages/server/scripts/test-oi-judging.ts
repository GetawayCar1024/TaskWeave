import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { problemTomlSchema, judgeMode, polygonFeatureWarnings, type ScoringInput } from '@polyforge/shared';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry, checkGroups } from '../src/workspace/problems.js';
import { ContestRegistry } from '../src/workspace/contests.js';
import { Judge } from '../src/judge/index.js';
import { WsHub } from '../src/ws.js';
import { groupScore } from '../src/judge/scoring.js';
import { lemonTestCases, preflightLemonChecker } from '../src/judge/lemonlime.js';
import { runContestBatch, contestExportDir } from '../src/judge/contest.js';
import { readInvocation, runInvocation } from '../src/judge/invocation.js';
import { PolygonSync } from '../src/polygon/sync.js';
import { contestDown } from '../src/judge/down.js';
import { contestStatements } from '../src/judge/contest.js';
import { readSamples } from '../src/judge/samples.js';
import { contestSyncStatus } from '../src/polygon/contestSync.js';

test('subtask dependencies are transitive and independent of definition order', () => {
  const input: ScoringInput = { tests: [1,2,3].map(index => ({ index, group: String(index), points: index * 10, verdict: index === 1 ? 'WA' : 'OK' })),
    groups: [3,2,1].map(index => ({ name: String(index), points: index * 10, policy: 'COMPLETE_GROUP', dependencies: index > 1 ? [String(index-1)] : [], tests: [index] })) };
  let score = groupScore(input);
  assert.equal(score.total, 0); assert.equal(score.max, 60);
  assert.deepEqual(score.groups[0].blockedBy, ['2']); assert.equal(score.groups[1].passed, false);
  input.tests[0].verdict = 'OK';
  assert.equal(groupScore(input).total, 60);
  input.tests.pop(); assert.equal(groupScore(input).total, 30);
  input.groups[0].dependencies = ['missing'];
  input.tests.push({index: 3, group: '3', points: 30, verdict: 'OK'});
  assert.equal(groupScore(input).total, 30);
  input.groups[0].dependencies = ['2']; input.groups[2].dependencies = ['3'];
  assert.equal(groupScore(input).total, 0);
});

test('CDF preserves bundles, expands per-test scores and puts dependency targets first', () => {
  const c = problemTomlSchema.parse({ problem: { name: 'test' }, tests: { points: true, groups: true, group: [
    { name: 'full', tests: '4-5', points: 60, dependencies: ['part'] },
    { name: 'part', tests: '2-3', points: 25, policy: 'EACH_TEST', dependencies: ['basic'] },
    { name: 'basic', tests: '1', points: 15 },
  ] } });
  const rows = lemonTestCases(c, [1,2,3,4,5], 'A-test');
  assert.deepEqual(rows.map(r => r.fullScore), [15,12,13,60]);
  // Dependencies are listed transitively (a 0-point dependency could not block otherwise).
  assert.deepEqual(rows[3].inputFiles, ['A-test/4.in','A-test/5.in','1_lemon_SUbtaskDEPENDENCE_fLAg','2_lemon_SUbtaskDEPENDENCE_fLAg','3_lemon_SUbtaskDEPENDENCE_fLAg']);
  assert.equal(rows[0].timeLimit,1000); assert.equal(rows[0].memoryLimit,256);
  assert.throws(() => lemonTestCases(c,[1,2,3,4,5,6],'A-test'), /do not belong/);
  assert.throws(() => lemonTestCases(c,[1,2,3,4],'A-test'), /missing tests/);
  c.tests.group![0].points=60.125;
  assert.ok(polygonFeatureWarnings(c).length);
  assert.throws(() => lemonTestCases(c,[1,2,3,4,5],'A-test'), /integer scores/);
  for (const groups of [ [{name:'a',tests:'0'}], [{name:'a',tests:'1-999999999'}], [{name:'a',tests:'1',points:-1}], [{name:'a',dependencies:['b']},{name:'b',dependencies:['a']}], [{name:'a',tests:'1'},{name:'b',tests:'1'}] ]) assert.throws(() => checkGroups('tests',groups));
});

function unzip(bytes: Buffer) {
  const files = new Map<string,Buffer>(); let pos=0;
  while (bytes.readUInt32LE(pos) === 0x04034b50) {
    const method=bytes.readUInt16LE(pos+8), length=bytes.readUInt32LE(pos+18), names=bytes.readUInt16LE(pos+26), extra=bytes.readUInt16LE(pos+28);
    const name=bytes.subarray(pos+30,pos+30+names).toString('utf8'); const start=pos+30+names+extra;
    const data=bytes.subarray(start,start+length); files.set(name,method===8?inflateRawSync(data):data); pos=start+length;
  }
  return files;
}

test('grader references follow file/directory renames and deletion keeps TOML readable', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-grader-refs-'));
  try {
    const global = new GlobalStore(home); await global.init(); global.config.problems.roots = [path.join(home, 'problems')];
    const registry = new ProblemRegistry(global), p = await registry.create({ name: 'rename-grader', judgeMode: 'grader' });
    await fs.rename(path.join(p.dir, 'grader'), path.join(p.dir, 'supplied'));
    await registry.fileChanged(p.id, 'grader', 'supplied');
    let detail = await registry.detail(p.id);
    assert.deepEqual(detail.config?.grader, { sources: ['supplied/grader.cpp'], headers: ['supplied/grader.h'] });
    await fs.rename(path.join(p.dir, 'supplied/grader.cpp'), path.join(p.dir, 'supplied/main.cpp'));
    await registry.fileChanged(p.id, 'supplied/grader.cpp', 'supplied/main.cpp');
    assert.deepEqual((await registry.detail(p.id)).config?.grader?.sources, ['supplied/main.cpp']);
    await fs.unlink(path.join(p.dir, 'supplied/grader.h'));
    await registry.fileChanged(p.id, 'supplied/grader.h', undefined, true);
    assert.deepEqual((await registry.detail(p.id)).config?.grader?.headers, []);
    await fs.unlink(path.join(p.dir, 'supplied/main.cpp'));
    await registry.fileChanged(p.id, 'supplied/main.cpp', undefined, true);
    detail = await registry.detail(p.id);
    assert.ok(detail.config); assert.equal(detail.config.grader, undefined);
    assert.equal(judgeMode(detail.config.problem), 'grader');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('grader builds, cache invalidation, real judging, Polygon rejection and complete LemonLime archive', { timeout: 120000 }, async () => {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'pf-oi-judge-'));
  try {
    const global=new GlobalStore(home); await global.init(); global.config.problems.roots=[path.join(home,'problems')];
    const registry=new ProblemRegistry(global), contests=new ContestRegistry(registry,global), judge=new Judge(global,registry,new WsHub());
    const p=await registry.create({name:'grader-demo',judgeMode:'grader'});
    await registry.patch(p.id,{validator:null, testsets:{ tests:{script:null} }});
    await fs.writeFile(path.join(p.dir,'tests/manual/01.in'),'2 3\n');
    await fs.writeFile(path.join(p.dir,'tests/manual/02.in'),'8 9\n');
    await registry.patch(p.id,{points:true,testsets:{tests:{groups:true,group:[{name:'advanced',tests:'2',points:70,dependencies:['basic']},{name:'basic',tests:'1',points:30}]}}});
    let ctx=await judge.ctx(p.id);
    assert.equal(judgeMode(ctx.config.problem),'grader'); assert.equal(ctx.config.problem.interactive,false);
    const first=await judge.compile(ctx,'solutions/std.cpp'); assert.ok(first.result.ok,first.result.log);
    const cached=await judge.compile(ctx,'solutions/std.cpp'); assert.equal(cached.result.cached,true);
    await fs.appendFile(path.join(p.dir,'grader/grader.h'),'\n// Header revision\n');
    const changed=await judge.compile(ctx,'solutions/std.cpp'); assert.ok(changed.result.ok,changed.result.log); assert.equal(changed.result.cached,false);
    assert.equal(changed.program!.argv[0],first.program!.argv[0]); assert.notEqual(changed.program!.hash,first.program!.hash);
    await fs.writeFile(path.join(p.dir,'solutions/wrong.cpp'),'#include "grader.h"\nlong long solve(long long a,long long b){return a == 2 ? 0 : a+b;}\n');
    await registry.patch(p.id,{solution:{source:'solutions/wrong.cpp',tag:'WA'}});ctx=await judge.ctx(p.id);
    const job={signal:new AbortController().signal,progress:()=>{}};
    const id=await runInvocation(judge,ctx,['solutions/std.cpp','solutions/wrong.cpp'],undefined,job,()=>{});
    const inv=await readInvocation(ctx,id);
    assert.equal(inv.status,'done',inv.error ?? 'invocation should finish'); assert.equal(inv.solutions[0].score?.total,100);
    assert.equal(inv.solutions[1].score?.total,0); assert.equal(inv.cells[1][1]?.verdict,'OK');
    assert.deepEqual(inv.solutions[1].score?.groups[0].blockedBy,['basic']);
    const sync=new PolygonSync(judge);
    const preview=await sync.pushPreview(ctx);assert.equal(preview.blocked,true);assert.ok(preview.warnings[0].includes('Grader'));
    await assert.rejects(sync.push(ctx,{keys:[],commit:false,buildPackage:false},job),/Grader/);
    await assert.rejects(registry.patch(p.id,{polygonId:123}),/Grader/);
    const traditional=await registry.create({name:'batch-demo'});
    await registry.patch(traditional.id,{validator:null,testsets:{tests:{script:null}},input:'batch-demo.in',output:'batch-demo.out'});
    await fs.writeFile(path.join(traditional.dir,'solutions/std.cpp'),'#include <cstdio>\nint main(){freopen("batch-demo.in","r",stdin);freopen("batch-demo.out","w",stdout);long long a,b;scanf("%lld%lld",&a,&b);printf("%lld\\n",a+b);}\n');
    const contest=await contests.create({name:'oi-round',problems:[{index:'B',problem:p.id},{index:'A',problem:traditional.id}]});
    const fakeSync = Object.create(sync) as PolygonSync;
    fakeSync.client = async () => ({ call: async () => [] }) as any;
    const status = await contestSyncStatus({judge,contests,sync:fakeSync},contest.id);
    assert.equal(status.rows[0].blocked,true); assert.equal(status.rows[1].blocked,false);
    assert.ok(status.warnings.some(w=>w.includes('Grader')));
    await assert.rejects(runContestBatch({judge,contests,sync},contest.id,{action:'export',exportFormat:'lemonlime'},job), /no Lemon checker configured/);
    await assert.rejects(fs.stat(path.join(traditional.dir,'.polyforge','tests')), /ENOENT/);
    for (const problem of [p,traditional]) {
      await fs.writeFile(path.join(problem.dir,'lemon-checker.cpp'), '#include "lemon/testlib.h"\nint main(int argc,char**argv){registerLemonChecker(argc,argv);long long a=ans.readLong(),b=ouf.readLong();if(a!=b)quitf(_wa,"mismatch");quitf(_ok,"ok");}\n');
      await registry.patch(problem.id,{lemonChecker:'lemon-checker.cpp'});
      assert.equal((await registry.detail(problem.id)).config?.checker?.source,'std:ncmp');
    }
    const lemonCtx=await judge.ctx(p.id);
    const lemonBuild=await preflightLemonChecker(judge,lemonCtx,'B');
    await fs.appendFile(path.join(global.sharedDir,'lemon','testlib.h'),'\n// updated header\n');
    const lemonRebuild=await preflightLemonChecker(judge,lemonCtx,'B');
    assert.ok(lemonBuild && lemonRebuild);
    assert.notEqual(lemonBuild.hash,lemonRebuild.hash);
    assert.equal(lemonBuild.argv[0],lemonRebuild.argv[0]);
    const result=await runContestBatch({judge,contests,sync},contest.id,{action:'export',exportFormat:'lemonlime'},job);
    assert.ok(result.file);
    const archive=unzip(await fs.readFile(path.join(contestExportDir(await contests.get(contest.id)),result.file!)));
    assert.ok(archive.has('source/'));assert.equal([...archive.keys()].filter(k=>k.startsWith('source/')).length,1);
    const cdf=JSON.parse(archive.get('oi-round.cdf')!.toString());assert.equal(cdf.version,'1.0');assert.deepEqual(cdf.contestants,[]);
    assert.deepEqual(cdf.tasks.map((t:any)=>t.taskType),[3,0]);assert.equal(cdf.tasks[1].standardInputCheck,false);assert.equal(cdf.tasks[1].inputFileName,'batch-demo.in');
    assert.ok(cdf.tasks.every((t:any)=>t.comparisonMode===4));
    assert.ok(archive.has('data/grader-demo/checker-sources/shared/lemon/testlib.h'));
    assert.equal(cdf.tasks[0].compilerConfiguration['g++'],'C++17 O2');
    for(const task of cdf.tasks) for(const row of task.testCases) for(const file of [...row.inputFiles,...row.outputFiles].filter((f:string)=>!f.endsWith('_lemon_SUbtaskDEPENDENCE_fLAg'))) assert.ok(archive.has('data/'+file),file);
    // Execute exactly the files and compilation layout consumed by LemonLime Communication.
    const runDir=path.join(home,'lemon-run');await fs.mkdir(runDir);
    const task=cdf.tasks[0];
    for(let i=0;i<task.graderFilesPath.length;i++) await fs.writeFile(path.join(runDir,task.graderFilesName[i]),archive.get('data/'+task.graderFilesPath[i])!);
    await fs.copyFile(path.join(p.dir,'solutions/std.cpp'),path.join(runDir,'grader-demo.cpp'));
    const exe=path.join(runDir,process.platform==='win32'?'grader-demo.exe':'grader-demo');
    // Like PolyForge's Windows compiler preset, make the standalone fixture independent of MinGW runtime DLLs.
    execFileSync('g++',['-std=c++17',...(process.platform === 'win32' ? ['-static'] : []),'-o',exe,'grader-demo.cpp',...task.graderFilesName],{cwd:runDir,windowsHide:true});
    assert.equal(execFileSync(exe,[],{input:'2 3\n',windowsHide:true}).toString().trim(),'5');
    // The packaged checker speaks Lemon's six-argument protocol and rejects wrong output.
    const checkerExe=path.join(runDir,path.basename(task.specialJudge));
    await fs.writeFile(checkerExe,archive.get('data/'+task.specialJudge)!);
    await fs.chmod(checkerExe,0o755);
    await fs.writeFile(path.join(runDir,'in'),'2 3\n');await fs.writeFile(path.join(runDir,'ans'),'5\n');
    for(const [answer,score] of [['5\n','37'],['6\n','0']]) {
      await fs.writeFile(path.join(runDir,'out'),answer);
      execFileSync(checkerExe,['in','out','ans','37','score','message'],{cwd:runDir,windowsHide:true});
      assert.equal((await fs.readFile(path.join(runDir,'score'),'utf8')).trim(),score);
    }
    await fs.writeFile(path.join(traditional.dir,'lemon-checker.cpp'),'#include "testlib.h"\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);quitf(_ok,"ok");}\n');
    await assert.rejects(runContestBatch({judge,contests,sync},contest.id,{action:'export',exportFormat:'lemonlime'},job),/Lemon checker protocol check failed/);
    // Public sample numbering follows sorted test indices; never include private tests.
    await registry.patch(p.id,{samples:'1-2',largeSamples:'2'});
    await fs.writeFile(path.join(p.dir,'tests/manual/02.statement.in'),Buffer.alloc(300000,65));
    await fs.writeFile(path.join(p.dir,'tests/manual/02.statement.out'),'large sample answer\n');
    const samples=await readSamples(await judge.ctx(p.id),true);
    assert.equal(samples[1].sample.input,'');assert.equal(samples[1].sample.large,true);
    assert.equal(samples[1].sample.inputFile,'grader-demo/grader-demo2.in');assert.equal(samples[1].input.length,300000);
    const statements=await contestStatements(judge,contests,contest.id,'en');
    const downReq={lang:'en',pdf:Buffer.from('%PDF-1.7\nfixture').toString('base64'),statements,notes:''};
    const down=unzip(await contestDown(judge,contests,contest.id,downReq));
    assert.deepEqual([...down.keys()],['statement.pdf','grader-demo/','grader-demo/grader-demo1.in','grader-demo/grader-demo1.out','grader-demo/grader-demo2.in','grader-demo/grader-demo2.out','batch-demo/','batch-demo/batch-demo1.in','batch-demo/batch-demo1.out']);
    assert.equal(down.get('grader-demo/grader-demo2.in')!.length,300000);assert.equal(down.get('grader-demo/grader-demo2.out')!.toString(),'large sample answer\n');
    await fs.appendFile(path.join(p.dir,'tests/manual/02.statement.out'),'changed');
    await assert.rejects(contestDown(judge,contests,contest.id,downReq),/changed/);
    await assert.rejects(registry.patch(p.id,{largeSamples:'3'}),/subset/);
    const normalLarge=await registry.patch(traditional.id,{largeSamples:'1'});
    assert.equal((await sync.pushPreview(await judge.ctx(traditional.id))).blocked,true);
    assert.ok(polygonFeatureWarnings(normalLarge.config!).some(s=>s.includes('large samples')));
    await registry.patch(traditional.id,{samples:''});
    assert.equal((await registry.detail(traditional.id)).config?.tests.large_samples,undefined);
    const io=await registry.create({name:'io-demo',judgeMode:'io'});
    assert.equal((await registry.detail(io.id)).config?.problem.interactive,true);
    await contests.update(contest.id,{problems:[{index:'A',problem:io.id}]});
    const before=await fs.readdir(contestExportDir(await contests.get(contest.id)));
    await assert.rejects(runContestBatch({judge,contests,sync},contest.id,{action:'export',exportFormat:'lemonlime'},job),/I\/O interactive/);
    assert.deepEqual(await fs.readdir(contestExportDir(await contests.get(contest.id))),before);
  } finally { await fs.rm(home,{recursive:true,force:true}); }
});
