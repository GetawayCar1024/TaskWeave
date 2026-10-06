/** Disposable local fixture for browser QA and the existing mock integration scripts. */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { GlobalStore } from '../src/global.js';
import { ProblemRegistry } from '../src/workspace/problems.js';
import { startServer } from '../src/server.js';
const home = process.argv[2] ?? await fs.mkdtemp(path.join(os.tmpdir(), 'polyforge-qa-'));
const global = new GlobalStore(home);
await global.init();
await global.saveConfig({ ...global.config, problems: { roots: [path.join(home, 'probs')] } });
const registry = new ProblemRegistry(global);
const p = (await registry.list()).find(p => p.id === 'qa-demo') ?? await registry.create({ name: 'qa-demo', title: { en: 'QA demo', zh: '回归测试题' } });
await fs.writeFile(path.join(p.dir, 'notes.md'), '# Preview\n\n**Bold** and `code`.\n\n| Input | Output |\n| --- | --- |\n| 3 | 6 |\n');
await fs.writeFile(path.join(p.dir, 'notes.tex'), '\\textbf{Standalone preview}\n\n$x^2 + y^2 = z^2$\n');
process.env.POLYFORGE_TOKEN = 'qa-local';
const server = await startServer({ home, port: 4600 });
console.log(`QA_HOME=${home}`);
process.on('SIGINT', async () => { await server.close(); process.exit(); });
