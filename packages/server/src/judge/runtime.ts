import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HttpError } from '../util/fs.js';
import type { ProcSpec } from './runner.js';

/** Resolve using the trusted host PATH, never the problem's working directory. */
export async function executablePath(command: string): Promise<string> {
  const extensions = process.platform === 'win32' && !path.extname(command) ? ['.exe', '.com', ''] : [''];
  const directories = path.isAbsolute(command) ? [''] : command.includes('/') || command.includes('\\') ? [process.cwd()] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of directories) for (const ext of extensions) {
    const candidate = path.resolve(dir, command + ext);
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) return fs.realpath(candidate);
  }
  throw new HttpError(400, 'runtime_missing', `Executable not found: ${command}`);
}

const tool = /^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*|java|javac|node|ruby|perl|go|rustc|rustup|gcc|g\+\+|cc|c\+\+|clang(?:\+\+)?|fpc|kotlinc)(?:-\d+(?:\.\d+)*)?$/i;

/** Only trusted runtime installations get directory access; ordinary argv never does. */
export async function prepareRuntime(spec: ProcSpec): Promise<ProcSpec> {
  const executable = await executablePath(spec.argv[0]);
  const name = path.basename(executable).replace(/\.(exe|com)$/i, '');
  const roots = [...(spec.runtimePaths ?? [])];
  const buildRoot = spec.build ? await fs.realpath(spec.build.dir) : undefined;
  const relative = buildRoot ? path.relative(buildRoot, executable) : undefined;
  const compiledArtifact = relative !== undefined && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
  // A submission named python.cpp/java.cpp is not a trusted interpreter.
  if (tool.test(name) && !compiledArtifact) {
    const directory = path.dirname(executable);
    const root = /^(bin|scripts)$/i.test(path.basename(directory)) ? path.dirname(directory) : directory;
    roots.push(root);
    // A Python venv points to its base interpreter without executing untrusted code.
    if (/^(python|pypy)/i.test(name)) {
      const config = await fs.readFile(path.join(root, 'pyvenv.cfg'), 'utf8').catch(() => '');
      const home = /^home\s*=\s*(.+)$/mi.exec(config)?.[1].trim();
      if (home && path.isAbsolute(home)) roots.push(home);
    }
  }
  // Native Windows programs may use DLLs next to their executable. Do not grant
  // the entire directory: it can also contain inputs, answers, or user secrets.
  const readPaths = [...(spec.readPaths ?? [])];
  if (process.platform === 'win32') {
    for (const file of await fs.readdir(path.dirname(executable)).catch(() => [])) {
      if (/\.dll$/i.test(file)) readPaths.push(path.join(path.dirname(executable), file));
    }
  }
  const runtimePaths = [...new Set(await Promise.all(roots.map(root => fs.realpath(root))))];
  const systemPath = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), process.env.SystemRoot ?? 'C:\\Windows']
    : ['/usr/bin', '/bin'];
  const search = [...new Set([path.dirname(executable), ...runtimePaths.flatMap(root => [path.join(root, 'bin'), root]), ...systemPath])];
  return { ...spec, argv: [executable, ...spec.argv.slice(1)], readPaths, runtimePaths,
    env: { PATH: search.join(path.delimiter), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PYTHONNOUSERSITE: '1', ...spec.env } };
}
