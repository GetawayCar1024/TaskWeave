/** Rasterize the approved SVG with the installed Electron; no extra image tools needed. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'packages/desktop/package.json'));
const source = path.join(root, 'assets/branding/taskweave.svg');
const cache = path.join(root, 'node_modules/.cache');
await fs.mkdir(cache, { recursive: true });
const profile = await fs.mkdtemp(path.join(cache, 'taskweave-icons-'));
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const images = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(root, 'scripts/render-icons.cjs'), source, profile], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    child.on('error', reject);
    child.on('close', code => { if (code) reject(new Error(errors || `Icon renderer exited ${code}`)); else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } } });
  });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = sizes.map(size => Buffer.from(images[size], 'base64'));
  const directory = Buffer.alloc(6 + sizes.length * 16); directory.writeUInt16LE(1, 2); directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  for (let i = 0; i < sizes.length; i++) {
    const at = 6 + i * 16;
    directory[at] = directory[at + 1] = sizes[i] === 256 ? 0 : sizes[i];
    directory.writeUInt16LE(1, at + 4); directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(frames[i].length, at + 8); directory.writeUInt32LE(offset, at + 12); offset += frames[i].length;
  }
  const ico = Buffer.concat([directory, ...frames]);
  const desktop = path.join(root, 'packages/desktop/build'), web = path.join(root, 'packages/web/public');
  await fs.mkdir(desktop, { recursive: true }); await fs.mkdir(web, { recursive: true });
  await fs.writeFile(path.join(desktop, 'icon.png'), Buffer.from(images[512], 'base64'));
  await fs.writeFile(path.join(desktop, 'icon.ico'), ico);
  await fs.writeFile(path.join(web, 'favicon.ico'), ico);
  await fs.copyFile(source, path.join(web, 'taskweave.svg'));
  console.log('Taskweave icons: 512px PNG, 16–256px ICO, browser SVG and favicon.');
} finally { await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); }
