import type { LintIssue, LocalCheck } from '@polyforge/shared';
import { i18n } from '../i18n';

/**
 * Chinese for the English texts the server produces (job progress, test generation
 * errors, sync item labels and warnings, contest batch results, export warnings).
 * Unknown texts are returned unchanged. Composite texts ("A · B", "x; y", "a, b") are
 * translated piece by piece.
 */
type Rule = [RegExp, (m: RegExpMatchArray, tr: (s: string) => string) => string];

const SECTION: Record<string, string> = {
  name: '标题',
  legend: '题目描述',
  input: '输入格式',
  output: '输出格式',
  interaction: '交互',
  scoring: '评分',
  notes: '说明',
  tutorial: '题解',
};
const LANG: Record<string, string> = { chinese: '中文', english: '英文', russian: '俄文' };
const ROLE: Record<string, string> = { validator: '校验器', checker: '检查器', interactor: '交互器', generator: '生成器', source: '源文件', 'Main solution': '主解法', Validator: '校验器', Checker: '检查器', Interactor: '交互器', Generator: '生成器' };

const RULES: Rule[] = [
  // ---- job progress ----
  [/^compiling$/, () => '编译中'],
  [/^running$/, () => '运行中'],
  [/^packing$/, () => '打包中'],
  [/^writing$/, () => '写入中'],
  [/^writing files$/, () => '写入文件'],
  [/^done$/, () => '完成'],
  [/^downloading from Polygon$/, () => '从 Polygon 下载'],
  [/^generating tests(?: (\d+\/\d+))?$/, (m) => `生成测试${m[1] ? ` ${m[1]}` : ''}`],
  [/^generating ([\w-]+)(?: (\d+\/\d+))?$/, (m) => `生成测试集 ${m[1]}${m[2] ? ` ${m[2]}` : ''}`],
  [/^input (\d+)$/, (m) => `生成输入 ${m[1]}`],
  [/^validate (\d+)$/, (m) => `校验 ${m[1]}`],
  [/^answer (\d+)$/, (m) => `生成答案 ${m[1]}`],
  [/^seed (\d+)$/, (m) => `种子 ${m[1]}`],
  [/^clear (.+)$/, (m) => `清除 ${m[1]}`],

  // ---- test generation ----
  [/^Test (\d+) is defined twice: (.+) and (.+)$/, (m) => `测试点 ${m[1]} 定义了两次：${m[2]} 和 ${m[3]}`],
  [/^Test indices must be contiguous; missing: (.+)$/, (m) => `测试点编号必须连续，缺少：${m[1]}`],
  [/^No main solution: tag one solution as MA to generate answers$/, () => '没有主解法：请把一个解法的标签设为 MA，才能生成答案'],
  [/^Interactive problem without an interactor$/, () => '交互题没有交互器'],
  [/^Unknown generator "(.+)" \(expected generators\/.+\.cpp or a registered generator\)$/, (m) => `未知的生成器“${m[1]}”（应为 generators/${m[1]}.cpp 或已注册的生成器）`],
  [/^Test (\d+) is invalid: ([\s\S]*)$/, (m) => `测试点 ${m[1]} 未通过校验：${m[2]}`],
  [/^Test (\d+): ([\s\S]+)$/, (m, tr) => `测试点 ${m[1]}：${tr(m[2])}`],
  [/^generator "(.+)" unavailable$/, (m) => `生成器“${m[1]}”不可用`],
  [/^generator failed: ([\s\S]*)$/, (m) => `生成器运行失败：${m[1]}`],
  [/^generator did not create a file for test (\d+) \(expected (.+)\)$/, (m) => `生成器没有为测试点 ${m[1]} 生成文件（应为 ${m[2]}）`],
  [/^main solution: ([\s\S]+)$/, (m) => `主解法：${m[1]}`],
  [/^invalid test$/, () => '测试点无效'],
  [/^no answer$/, () => '没有答案'],
  [/^compilation error$/, () => '编译错误'],
  [/^(Main solution|Validator|Checker|Interactor|Generator) (\S+) failed to compile:([\s\S]*)$/, (m) => `${ROLE[m[1]]} ${m[2]} 编译失败：${m[3]}`],
  [/^Select at least one solution$/, () => '请至少选择一个解法'],
  [/^No checker configured$/, () => '没有设置检查器'],
  [/^Unknown testset: (.+)$/, (m) => `未知的测试集：${m[1]}`],

  // ---- sync item labels ----
  [/^problem info$/, () => '题目信息'],
  [/^validator \/ checker \/ interactor \/ groups$/, () => '校验器 / 检查器 / 交互器 / 子任务'],
  [/^test groups$/, () => '测试点分组'],
  [/^test script$/, () => '测试脚本'],
  [/^(validator|checker|interactor|generator|source): (.+)$/, (m) => `${ROLE[m[1]]}：${m[2]}`],
  [/^resource: (.+)$/, (m) => `资源文件：${m[1]}`],
  [/^solution: (.+)$/, (m) => `解法：${m[1]}`],
  [/^statement \((\w+)\): (\w+)$/, (m) => `题面（${LANG[m[1]] ?? m[1]}）：${SECTION[m[2]] ?? m[2]}`],
  [/^tutorial \((\w+)\)$/, (m) => `题解（${LANG[m[1]] ?? m[1]}）`],
  [/^statement resource: (.+)$/, (m) => `题面资源：${m[1]}`],
  [/^local file: (.+)$/, (m) => `本地文件：${m[1]}`],
  [/^manual test (\d+)(?: \((.+)\))?$/, (m) => `手写测试 ${m[1]}${m[2] ? `（${m[2]}）` : ''}`],
  [/^test (\d+) is a sample$/, (m) => `测试点 ${m[1]} 为样例`],
  [/^validator test (\d+)(?: \((.+)\))?$/, (m) => `校验器自测 ${m[1]}${m[2] ? `（${m[2]}）` : ''}`],
  [/^checker test (\d+)(?: \((.+)\))?$/, (m) => `检查器自测 ${m[1]}${m[2] ? `（${m[2]}）` : ''}`],
  [/^testset (.+)$/, (m) => `测试集 ${m[1]}`],

  // ---- sync warnings ----
  [/^(.+) was removed locally; Polygon has no delete API, remove it there by hand if needed$/, (m) => `${m[1]} 已在本地删除；Polygon 没有删除接口，需要时请到 Polygon 上手动删除`],
  [/^Polygon revision is (\d+) but the last sync saw (\d+): the problem was changed on Polygon\. Pull first to avoid overwriting\.$/, (m) => `Polygon 上的版本是 ${m[1]}，上次同步时是 ${m[2]}：题目在 Polygon 上被修改过，请先拉取，以免覆盖`],
  [/^Could not reach Polygon: ([\s\S]+)$/, (m) => `无法连接 Polygon：${m[1]}`],
  [/^files\/(.+): Polygon resource files cannot be in folders; skipped$/, (m) => `files/${m[1]}：Polygon 的资源文件不能放在子文件夹里，已跳过`],
  [/^Solution (.+) is listed in problem\.toml but missing$/, (m) => `problem.toml 里登记了解法 ${m[1]}，但文件不存在`],
  [/^Solutions (.+) and (.+) share the Polygon name "(.+)"; skipping (.+)$/, (m) => `解法 ${m[1]} 和 ${m[2]} 在 Polygon 上同名“${m[3]}”，已跳过 ${m[4]}`],
  [/^Polygon file names are flat: (.+) and (.+) would both be "(.+)"; skipping (.+)$/, (m) => `Polygon 的文件名不分目录：${m[1]} 和 ${m[2]} 都会变成“${m[3]}”，已跳过 ${m[4]}`],
  [/^(.+): Polygon has no FL tag; it is sent as RJ$/, (m) => `${m[1]}：Polygon 没有 FL 标签，按 RJ 发送`],
  [/^checker-tests\/(.+): no expected verdict; skipped$/, (m) => `checker-tests/${m[1]}：没有期望结论，已跳过`],
  [/^(.+): the local copy does not round-trip exactly$/, (m) => `${m[1]}：本地副本与 Polygon 上的内容不能完全对应`],
  [/^points of test (\d+): ([\s\S]+)$/, (m) => `测试点 ${m[1]} 的分值：${m[2]}`],
  [/^buildPackage: ([\s\S]+)$/, (m) => `构建题目包：${m[1]}`],
  [/^(.+) — create the testset "(.+)" on Polygon first \(Tests page → testsets\), then push again$/, (m) => `${m[1]} —— 请先在 Polygon 的 Tests 页面建好测试集“${m[2]}”，再重新推送`],

  [
    /^script\.txt: duplicate commands \(Polygon does not allow them; change an argument, e\.g\. a seed\): (.+)$/,
    (m) =>
      `script.txt：有重复的命令（Polygon 不允许，请改动一个参数，例如加一个种子）：${m[1]
        .split('; ')
        .map((d) => d.replace(/^line (\d+) repeats line (\d+): /, '第 $1 行与第 $2 行相同：').replace(/^\(\+(\d+) more\)$/, '另有 $1 处'))
        .join('；')}`,
  ],

  [/^Test (\d+) comes from a template loop in (.+); edit the script instead$/, (m) => `测试点 ${m[1]} 由 ${m[2]} 中的模板循环生成，请直接编辑 script`],
  [/^Test (\d+) does not exist$/, (m) => `测试点 ${m[1]} 不存在`],
  [/^Test (\d+) is now (.+), not (.+); regenerate the tests and try again$/, (m) => `测试点 ${m[1]} 现在是 ${m[2]}，不是 ${m[3]}；请重新生成测试后再试`],
  [/^Sample test (\d+) does not exist \(tests\.samples\)$/, (m) => `样例 ${m[1]} 对应的测试点不存在（tests.samples）`],
  [/^Folder already exists: (.+)$/, (m) => `文件夹已存在：${m[1]}`],
  [/^Name must be lowercase letters, digits and dashes$/, () => '名称只能包含小写字母、数字和连字符'],
  [/^Invalid problem index: (.*)$/, (m) => `题号无效：${m[1]}（应为大写字母开头，最多 4 位，如 A、B、C1）`],
  [/^Duplicate index (.+)$/, (m) => `题号 ${m[1]} 重复了`],
  [/^Problem (.+) is listed twice$/, (m) => `题目 ${m[1]} 重复加入`],

  // ---- AI endpoints ----
  [/^This endpoint does not provide a model list \(([\s\S]*)\)\. Enter the model names by hand, then use Test connection\.$/, (m, tr) => `这个端点不提供模型列表（${tr(m[1])}）。请手动填写模型名称，再点“测试连接”确认。`],
  [/^HTTP (\d+): the server returned a web page(?: \((.+)\))? instead of an API response$/, (m) => `HTTP ${m[1]}：服务器返回的是网页${m[2] ? `（${m[2]}）` : ''}，不是 API 响应`],
  [/^the server returned a web page(?: \((.+)\))? instead of an API response$/, (m) => `服务器返回的是网页${m[1] ? `（${m[1]}）` : ''}，不是 API 响应`],

  // ---- export warnings ----
  [/^no checker configured$/, () => '没有设置检查器'],
  [/^statement language (\w+) has no tutorial$/, (m) => `题面语言 ${m[1]} 没有题解`],
  [/^tutorial language (\w+) has no statement$/, (m) => `题解语言 ${m[1]} 没有对应的题面`],
  [/^([\w-]+): test (\d+) has no answer$/, (m) => `${m[1]}：测试点 ${m[2]} 没有答案`],

  // ---- contest batch results ----
  [/^(\d+) tests?$/, (m) => `${m[1]} 个测试点`],
  [/^(\d+) errors?$/, (m) => `${m[1]} 个错误`],
  [/^(\d+) warnings?$/, (m) => `${m[1]} 个警告`],
  [/^(\d+) × (\d+) tests?$/, (m) => `${m[1]} 个解法 × ${m[2]} 个测试点`],
  [/^(\d+) solutions? not as tagged$/, (m) => `${m[1]} 个解法与标签不符`],
  [/^(\d+) items? → #(\d+)(?: r(\d+))?$/, (m) => `推送 ${m[1]} 项 → #${m[2]}${m[3] ? `（版本 ${m[3]}）` : ''}`],
  [/^no issues$/, () => '没有问题'],
  [/^no solutions$/, () => '没有解法'],
  [/^up to date$/, () => '已是最新'],
  [/^changed on Polygon \(revision (\d+)\); pull it first$/, (m) => `Polygon 上已修改（版本 ${m[1]}），请先拉取`],
  [/^Problem not found: (.+)$/, (m) => `找不到题目：${m[1]}`],
  [/^(.+) \[(.+)\]: (.+)$/, (m, tr) => `${m[1]} [${m[2]}]：${m[3].split('; ').map(tr).join('；')}`],
  [/^(.+): compilation error$/, (m) => `${m[1]}：编译错误`],
  [/^unexpected on tests (.+)$/, (m) => `在测试点 ${m[1]} 上结果不符`],
  [/^never got (.+)$/, (m) => `从未得到 ${m[1]}`],
  [/^([\w-]+): ([\s\S]+)$/, (m, tr) => {
    // "<testset>: <text>" prefixes (contest batch, export).
    const inner = tr(m[2]);
    return inner === m[2] ? `${m[1]}: ${m[2]}` : `${m[1]}：${inner}`;
  }],
];

function translate(s: string): string {
  for (const [re, fn] of RULES) {
    const m = s.match(re);
    if (m) return fn(m, translate);
  }
  // Composite texts: translate the parts when each of them is known.
  for (const [sep, join] of [[' · ', ' · '], ['; ', '；'], [', ', '，']] as const) {
    if (!s.includes(sep)) continue;
    const parts = s.split(sep);
    const out = parts.map(translate);
    if (out.some((x, i) => x !== parts[i])) return out.join(join);
  }
  return s;
}

/** Localize a server-produced text for the current UI language. */
export function serverText(s: string | undefined | null): string {
  if (!s) return '';
  return String(i18n.global.locale.value).startsWith('zh') ? translate(s) : s;
}


/** A local check in the UI language (by code; generation errors are translated too). */
export function checkMessage(c: LocalCheck): string {
  const t = i18n.global.t as (k: string, p?: Record<string, unknown>) => string;
  const te = i18n.global.te as (k: string) => boolean;
  const key = `checks.${c.code}`;
  if (!c.code || !te(key)) return serverText(c.message);
  const params: Record<string, unknown> = { ...c.params };
  if (typeof params.error === 'string') params.error = serverText(params.error);
  return t(key, params);
}

/** A statement lint issue in the UI language (by rule). */
export function lintMessage(i: LintIssue): string {
  const t = i18n.global.t as (k: string) => string;
  const te = i18n.global.te as (k: string) => boolean;
  const key = `lintRule.${i.rule}`;
  return te(key) ? t(key) : i.message;
}
