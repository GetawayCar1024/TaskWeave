import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { commonContestLanguages, CONTEST_ACTIONS, type ContestBatchRequest, type ContestImportRequest, type ContestPullRequest, type ContestRepullRequest, type CreateContestRequest, type UpdateContestRequest } from '@polyforge/shared';
import { contestPull, contestPullPreview, contestRepull, contestSyncStatus } from '../polygon/contestSync.js';
import type { JobManager } from '../jobs.js';
import { contestExportDir, contestStatements, importContest, runContestBatch, type ContestDeps } from '../judge/contest.js';
import { contestTex } from '../judge/statementTex.js';
import { contestDown } from '../judge/down.js';
import { atomicWrite, exists, HttpError, validateFileName } from '../util/fs.js';
import { buildTree, FileService, SelfWrites } from '../workspace/files.js';
import { contestFile, contestNotes } from '../workspace/contestFiles.js';
import { convertStatement, largeSampleNotice } from '@polyforge/shared';
import type { WsHub } from '../ws.js';

/** Contest jobs use `contest:<id>` as their owner so the contest page can find them. */
export const contestJobOwner = (id: string) => `contest:${id}`;

export function contestRoutes(app: FastifyInstance, deps: ContestDeps & { aiRunning?: (owner: string) => boolean }, jobs: JobManager, hub: WsHub) {
  const { contests, judge } = deps;
  type P = { Params: { id: string } };

  app.get('/api/contests', async () => contests.list());

  app.post<{ Body: CreateContestRequest }>('/api/contests', async (req, reply) => {
    const c = await contests.create(req.body ?? ({} as CreateContestRequest));
    hub.broadcast({ type: 'contests:changed' });
    return reply.code(201).send(c);
  });

  app.get<P>('/api/contests/:id', async (req) => contests.detail(req.params.id));
  app.post<P & { Body: Parameters<typeof contestDown>[3] }>('/api/contests/:id/down', async (req, reply) => {
    const data = await contestDown(judge, contests, req.params.id, req.body);
    return reply.type('application/zip').header('content-disposition', 'attachment; filename="down.zip"').send(data);
  });
  const files = new FileService(new SelfWrites());
  app.get<P>('/api/contests/:id/files', async req => buildTree(path.join((await contests.get(req.params.id)).dir, 'files')));
  type FP = P & { Querystring: { path: string } };
  app.get<FP>('/api/contests/:id/file', async req => {
    const ref = await contests.get(req.params.id);
    await contestFile(ref.dir, req.query.path);
    return files.read(path.join(ref.dir, 'files'), req.query.path);
  });
  app.get<FP>('/api/contests/:id/file/raw', async (req, reply) => {
    const ref = await contests.get(req.params.id);
    const abs = await contestFile(ref.dir, req.query.path);
    const ext = path.extname(abs).toLowerCase();
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' };
    return reply.type(mime[ext] ?? 'application/octet-stream').header('x-content-type-options', 'nosniff').send(await fsp.readFile(abs));
  });
  app.put<FP & { Body: { content: string; hash?: string } }>('/api/contests/:id/file', async req => {
    const ref = await contests.get(req.params.id);
    await contestFile(ref.dir, req.query.path);
    if (typeof req.body?.content !== 'string') throw new HttpError(400, 'bad_request', 'content required');
    return { hash: await files.write(path.join(ref.dir, 'files'), req.query.path, req.body.content, req.body.hash) };
  });
  app.post<FP & { Body: { base64: string } }>('/api/contests/:id/file', { bodyLimit: 24 * 1024 * 1024 }, async req => {
    const ref = await contests.get(req.params.id);
    const abs = await contestFile(ref.dir, req.query.path);
    if (typeof req.body?.base64 !== 'string') throw new HttpError(400, 'bad_request', 'base64 required');
    const data = Buffer.from(req.body.base64, 'base64');
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, data, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'EEXIST') throw new HttpError(409, 'exists', 'File already exists');
      throw e;
    });
    return { ok: true };
  });
  app.delete<FP>('/api/contests/:id/file', async req => {
    const ref = await contests.get(req.params.id);
    const abs = await contestFile(ref.dir, req.query.path);
    if (req.query.path === 'notes.tex') await atomicWrite(abs, '');
    else await fsp.unlink(abs);
    return { ok: true };
  });
  app.get<P>('/api/contests/:id/notes', async req => ({ content: await contestNotes((await contests.get(req.params.id)).dir) }));
  // Editable snapshot: each source section is included, with local copies of images.
  app.post<P & { Body: { lang: string; doc: 'statements' | 'tutorials' } }>('/api/contests/:id/generate-document', async req => {
    const { lang, doc } = req.body ?? {};
    if (!/^[a-z]{2,8}$/.test(lang) || !['statements', 'tutorials'].includes(doc)) throw new HttpError(400, 'bad_request', 'Invalid document or language');
    const { ref, config } = await contests.config(req.params.id);
    const detail = await contests.detail(ref.id);
    if (!commonContestLanguages(detail.problems, doc).includes(lang)) {
      throw new HttpError(400, 'incomplete_document_language', `Cannot generate ${doc} in ${lang}: every contest problem must have non-empty content in this language.`);
    }
    const statements = await contestStatements(judge, contests, ref.id, lang);
    const folder = `${doc}-${lang}-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const esc = (text: string) => text.replace(/[\\{}%&#_$]/g, c => c === '\\' ? '\\textbackslash{}' : '\\' + c);
    const out: string[] = [`% polyforge-language: ${lang}`, `\\section*{${esc(config.contest.title[lang] || config.contest.name)}}`];
    const copyImages = async (source: string, from: string, prefix: string) => {
      // Snapshots are PolyForge documents (rendered by its TeX preview, never compiled as
      // LaTeX nor sent to Polygon): the preview dialect keeps them rendering exactly like
      // the sources (the conversion is idempotent) and normalises Markdown images to
      // \includegraphics, which are copied next to the snapshot.
      let text = convertStatement(source, 'preview').tex;
      for (const match of [...text.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)]) {
        const name = match[1].trim(); validateFileName(name);
        const asset = `images/${prefix}/${name}`;
        const dest = await contestFile(ref.dir, `${folder}/${asset}`);
        const original = prefix === 'contest' ? await contestFile(ref.dir, name) : path.join(from, name);
        if (!(await exists(original))) throw new HttpError(400, 'missing_image', `Missing image: ${prefix}/${name}`);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(original, dest);
        text = text.replace(match[0], match[0].replace(`{${match[1]}}`, `{${asset}}`));
      }
      return text;
    };
    const notes = await contestNotes(ref.dir);
    if (notes.trim()) out.push(`\\subsection*{${lang === 'zh' ? '注意事项' : 'Instructions'}}`, await copyImages(notes, '', 'contest'));
    const labels: Record<string, string> = lang === 'zh' ? { legend: '题目描述', input: '输入格式', output: '输出格式', interaction: '交互', scoring: '评分', notes: '说明', tutorial: '题解' } : { legend: 'Description', input: 'Input', output: 'Output', interaction: 'Interaction', scoring: 'Scoring', notes: 'Notes', tutorial: 'Tutorial' };
    for (const s of statements) {
      out.push(`\\subsection*{${s.index}. ${esc(s.title)}}`);
      if (doc === 'statements') out.push(`${lang === 'zh' ? '时间限制' : 'Time limit'}: ${s.timeLimit / 1000} s\\\\\n${lang === 'zh' ? '空间限制' : 'Memory limit'}: ${s.memoryLimit} MB\\\\\n${esc(s.input || 'stdin')} / ${esc(s.output || 'stdout')}`);
      const parts = doc === 'tutorials' ? [['tutorial', s.sections.tutorial ?? '']] : s.body ? [['legend', s.body]] : ['legend', 'input', 'output', 'interaction', 'scoring'].map(k => [k, s.sections[k] ?? '']);
      if (doc === 'statements' && !s.body) {
        s.samples.forEach((sample, i) => {
          if (sample.large) { parts.push([`${lang === 'zh' ? '样例' : 'Sample'} ${sample.number ?? i + 1}`, esc(largeSampleNotice(sample, lang, sample.number ?? i + 1))]); return; }
          parts.push([`${lang === 'zh' ? '样例' : 'Sample'} ${i + 1}`, `\\begin{verbatim}\n${sample.input}\n\\end{verbatim}\n\n\\begin{verbatim}\n${sample.output}\n\\end{verbatim}`]);
        });
        parts.push(['notes', s.sections.notes ?? '']);
      }
      for (const [key, source] of parts) {
        if (!source.trim()) continue;
        const problem = await judge.registry.get(s.problem);
        const text = await copyImages(source, path.join(problem.dir, 'statement', 'images'), s.problem);
        out.push(`\\subsubsection*{${labels[key] ?? key}}`, text);
      }
    }
    const rel = `${folder}/${doc}.tex`;
    await atomicWrite(await contestFile(ref.dir, rel), out.join('\n\n') + '\n');
    return { path: rel };
  });
  app.get<P>('/api/contests/:id/attachments', async (req, reply) => {
    const { config } = await contests.config(req.params.id);
    if (config.contest.type !== 'oi') throw new HttpError(400, 'oi_only', 'Attachments are only available for OI contests');
    const { ZipWriter } = await import('../util/zip.js');
    const { addAttachments } = await import('../workspace/attachments.js');
    const zip = new ZipWriter();
    for (const p of config.problems) {
      const ctx = await judge.ctx(p.problem);
      await addAttachments(zip, ctx.ref.dir, `${p.index}/${ctx.config.problem.name}/`);
    }
    return reply.type('application/zip').header('content-disposition', `attachment; filename="${config.contest.name}-attachments.zip"`).send(zip.finish());
  });
  app.get<P>('/api/contests/:id/batch/latest', async req => {
    const ref = await contests.get(req.params.id);
    return JSON.parse(await fsp.readFile(path.join(ref.dir, '.polyforge', 'batches', 'latest.json'), 'utf8').catch(() => 'null'));
  });

  app.put<P & { Body: UpdateContestRequest }>('/api/contests/:id', async (req) => {
    if (req.body?.problems) {
      const current = await contests.detail(req.params.id);
      const owners = new Set([contestJobOwner(req.params.id), ...current.problems.map(p => p.problem)]);
      if (jobs.list().some(j => j.status === 'running' && owners.has(j.problemId))) throw new HttpError(409, 'busy', 'Wait for running contest/problem tasks before changing indices');
    }
    const d = await contests.update(req.params.id, req.body ?? {});
    hub.broadcast({ type: 'contests:changed' });
    return d;
  });

  app.delete<P>('/api/contests/:id', async (req) => {
    const ref = await contests.get(req.params.id);
    if (jobs.list(contestJobOwner(ref.id)).some(j => j.status === 'running') || deps.aiRunning?.(contestJobOwner(ref.id))) {
      throw new HttpError(409, 'busy', 'Wait for running tasks of this contest before deleting it');
    }
    await contests.remove(ref.id);
    hub.broadcast({ type: 'contests:changed' });
    return { ok: true };
  });

  /** Statements or tutorials as a self-contained .tex (a .zip when there are images). */
  app.get<P & { Querystring: { lang?: string; doc?: string; breaks?: string; toc?: string } }>('/api/contests/:id/tex', async (req, reply) => {
    const ref = await contests.get(req.params.id);
    const lang = /^[a-z]{2,8}$/.test(req.query.lang ?? '') ? req.query.lang! : 'zh';
    const doc = req.query.doc === 'tutorials' ? 'tutorials' : 'statements';
    const r = await contestTex(judge, contests, ref.id, lang, doc, req.query.breaks !== '0', req.query.toc !== '0');
    const file = `${ref.id}-${doc}-${lang}.${r.ext}`;
    return reply
      .type(r.ext === 'zip' ? 'application/zip' : 'application/x-tex; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file}"`)
      .send(r.data);
  });

  app.get<P & { Querystring: { lang?: string } }>('/api/contests/:id/statements', async (req) => {
    const lang = req.query.lang ?? 'en';
    if (!/^[a-z]{2,8}$/.test(lang)) throw new HttpError(400, 'bad_lang', 'Invalid language');
    return contestStatements(judge, contests, req.params.id, lang);
  });

  app.post<P & { Body: ContestBatchRequest }>('/api/contests/:id/batch', async (req) => {
    const body = req.body;
    if (!body || !CONTEST_ACTIONS.includes(body.action)) throw new HttpError(400, 'bad_request', `action must be one of ${CONTEST_ACTIONS.join(', ')}`);
    const ref = await contests.get(req.params.id);
    const owner = contestJobOwner(ref.id);
    const running = jobs.running(owner, 'contest');
    if (running) throw new HttpError(409, 'busy', 'Another batch is running for this contest');
    return jobs.start('contest', owner, async (job) => {
      const r = await runContestBatch(deps, ref.id, body, job);
      if (body.action === 'polygon-push') hub.broadcast({ type: 'problems:changed' });
      return r;
    });
  });

  // ---- Polygon sync of the whole contest: status, then pull only what changed there ----
  app.get<P>('/api/contests/:id/polygon/status', async (req) => contestSyncStatus(deps, (await contests.get(req.params.id)).id));

  const exclusive = (id: string, run: (job: Parameters<Parameters<JobManager['start']>[2]>[0]) => Promise<unknown>) => {
    const owner = contestJobOwner(id);
    if (jobs.running(owner, 'contest')) throw new HttpError(409, 'busy', 'Another batch is running for this contest');
    return jobs.start('contest', owner, run);
  };
  app.post<P & { Body: { problems?: string[] } }>('/api/contests/:id/polygon/pull-preview', async (req) => {
    const ref = await contests.get(req.params.id);
    const problems = Array.isArray(req.body?.problems) ? req.body.problems.map(String) : [];
    if (!problems.length) throw new HttpError(400, 'bad_request', 'problems required');
    return exclusive(ref.id, (job) => contestPullPreview(deps, ref.id, problems, job));
  });
  app.post<P & { Body: ContestPullRequest }>('/api/contests/:id/polygon/pull', async (req) => {
    const ref = await contests.get(req.params.id);
    const body = req.body;
    if (!body || !Array.isArray(body.problems)) throw new HttpError(400, 'bad_request', 'problems required');
    return exclusive(ref.id, async (job) => {
      const r = await contestPull(deps, ref.id, body, job);
      hub.broadcast({ type: 'problems:changed' });
      return r;
    });
  });
  // Re-pull everything: Polygon's version wins, also over conflicts and local edits.
  app.post<P & { Body: ContestRepullRequest }>('/api/contests/:id/polygon/repull', async (req) => {
    const ref = await contests.get(req.params.id);
    const body: ContestRepullRequest = { deleteLocal: req.body?.deleteLocal === true, problems: Array.isArray(req.body?.problems) ? req.body.problems.map(String) : undefined };
    return exclusive(ref.id, async (job) => {
      try { return await contestRepull(deps, ref.id, body, job); }
      finally { hub.broadcast({ type: 'problems:changed' }); }
    });
  });

  app.get<{ Params: { id: string; file: string } }>('/api/contests/:id/export/:file', async (req, reply) => {
    const ref = await contests.get(req.params.id);
    if (!/^[\w.-]+\.zip$/.test(req.params.file)) throw new HttpError(400, 'bad_file', 'Invalid file name');
    const data = await fsp.readFile(path.join(contestExportDir(ref), req.params.file)).catch(() => {
      throw new HttpError(404, 'file_not_found', 'Export not found');
    });
    return reply.type('application/zip').header('content-disposition', `attachment; filename="${req.params.file}"`).send(data);
  });

  app.post<{ Body: ContestImportRequest }>('/api/contests/import/polygon', async (req) => {
    const body = req.body;
    if (!body || !Number.isInteger(body.contestId) || !body.name) throw new HttpError(400, 'bad_request', 'contestId and name required');
    return jobs.start('contest-import', '', async (job) => {
      try { return await importContest(deps, body, job); }
      finally {
        await deps.afterImport?.();
        hub.broadcast({ type: 'problems:changed' });
        hub.broadcast({ type: 'contests:changed' });
      }
    });
  });
}
