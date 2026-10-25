import { createTypstCompiler, CompileFormatEnum } from '@myriaddreamin/typst.ts/compiler';
import { disableDefaultFontAssets, loadFonts, withAccessModel, withPackageRegistry } from '@myriaddreamin/typst.ts/options.init';
import { MemoryAccessModel } from '@myriaddreamin/typst.ts/dist/esm/fs/memory.mjs';
import { FetchPackageRegistry } from '@myriaddreamin/typst.ts/dist/esm/fs/package.mjs';
import wasm from '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url';
import getProcessor from '../vendor/cnoi/compiler/getProcessor';
import plugins from '../vendor/cnoi/cnoi/unifiedPlugins';
import { createTypstRenderer } from '@myriaddreamin/typst.ts/renderer';
import rendererWasm from '@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url';
import { cnoiFootnotes, cnoiTemplate } from './cnoiTemplate';

const templates = import.meta.glob<string>('../vendor/cnoi/cnoi/typst/*', { query: '?raw', import: 'default', eager: true });
const fontNames = ['FiraMono-Regular.ttf', 'FiraMono-Bold.ttf', 'FiraMono-Medium.ttf', 'lmroman10-bold.otf', 'lmroman10-bolditalic.otf', 'lmroman10-italic.otf', 'lmroman10-regular.otf', 'lmroman12-bold.otf', 'lmroman12-italic.otf', 'lmroman12-regular.otf', 'lmroman17-regular.otf', 'NewCMMath-Regular.otf', 'NewCMMath-Book.otf', 'NewCMMath-Bold.otf', 'NewCMSansMath-Regular.otf'];
/** SimSun / SimHei / KaiTi may not be redistributed: they come from the user's system through the local server. */
const systemFontKeys = ['simsun', 'simhei', 'simkai'];
let missingFonts: string[] = [];
const compiler = createTypstCompiler();
const renderer = createTypstRenderer();
const processor = getProcessor(plugins);
let initialized: Promise<void> | undefined;
async function fetchBytes(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`无法加载 OI 排版资源：${url} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
async function systemFonts(token: string) {
  const loaded: Uint8Array[] = [];
  missingFonts = [];
  for (const key of systemFontKeys) {
    const response = await fetch(`/api/system-fonts/${key}?token=${encodeURIComponent(token)}`);
    if (response.ok) loaded.push(new Uint8Array(await response.arrayBuffer()));
    else if (response.status === 404) missingFonts.push(key);
    else throw new Error(`无法加载 OI 排版资源：${key} (${response.status})`);
  }
  return loaded;
}
async function init(token: string) {
  const access = new MemoryAccessModel();
  const registry = new FetchPackageRegistry(access);
  const packages = new Map(await Promise.all(['mitex-0.2.5', 'oxifmt-1.0.0'].map(async name => [name, await fetchBytes(`/cnoi/packages/${name}.tar.gz`)] as const)));
  // Resolve exclusively from bundled packages, even on the first offline run.
  registry.pullPackageData = spec => packages.get(`${spec.name}-${spec.version}`);
  const fonts = [...await Promise.all(fontNames.map(n => fetchBytes(`/cnoi/fonts/${n}`))), ...await systemFonts(token)];
  await compiler.init({ getModule: () => wasm, beforeBuild: [disableDefaultFontAssets(), loadFonts(fonts), withAccessModel(access), withPackageRegistry(registry)] });
  await renderer.init({ getModule: () => rendererWasm });
  for (const [name, source] of Object.entries(templates)) compiler.addSource('/' + name.split('/').pop(), source);
}
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent) => {
  queue = queue.then(async () => {
    try {
      await (initialized ??= init(data.token ?? '').catch(e => { initialized = undefined; throw e; }));
      compiler.addSource('/content.json', JSON.stringify(data.content));
      const main = Object.entries(templates).find(([name]) => name.endsWith('/main.typ'))![1];
      compiler.addSource('/main.typ', cnoiTemplate(main, data.content.lang));
      const sources = data.content.problems.map((p: { markdown: string }, i: number) => [`/problem-${i}.typ`, p.markdown]);
      sources.push(['/extra-precaution.typ', data.content.extraContents.precaution.markdown]);
      for (const [name, markdown] of sources) {
        const result = processor.processSync(markdown);
        for (const asset of result.data.assets ?? []) {
          const url = new URL(asset.assetUrl, self.location.origin);
          if (url.origin !== self.location.origin || !url.pathname.startsWith('/api/')) throw new Error('OI PDF 只支持比赛或题目中的本地图片');
          compiler.mapShadow('/' + asset.filename, await fetchBytes(url.href));
        }
        compiler.addSource(name, cnoiFootnotes(result.toString()));
      }
      const preview = await compiler.compile({ mainFilePath: '/main.typ', format: CompileFormatEnum.vector, diagnostics: 'unix' });
      if (!preview.result) throw new Error(JSON.stringify(preview.diagnostics));
      const svg = await renderer.runWithSession(async session => {
        renderer.manipulateData({ renderSession: session, action: 'reset', data: preview.result! });
        return renderer.renderSvg({ renderSession: session });
      });
      const result = await compiler.compile({ mainFilePath: '/main.typ', format: CompileFormatEnum.pdf, diagnostics: 'unix' });
      if (!result.result) throw new Error(JSON.stringify(result.diagnostics));
      self.postMessage({ pdf: result.result, svg, missingFonts });
    } catch (e) {
      let error = e instanceof Error ? e.message : String(e);
      if (data.content.lang !== 'zh') error = error
        .replace('不支持代码块内过长的单词。为了可读性，请直接下发文件，而非在 PDF 中直接显示。', 'A word in a code block is too long. Distribute the code as a file instead of placing it directly in the PDF.')
        .replace('OI PDF 只支持比赛或题目中的本地图片', 'OI documents only support local images from the contest or its problems.')
        .replace('无法加载 OI 排版资源：', 'Could not load an OI typesetting resource: ');
      self.postMessage({ error });
    }
  });
};
