# PolyForge

本地优先的 Polygon 造题平台。设计见 [DESIGN.md](DESIGN.md)。已完成 **M1 本地核心**、**M2 评测**、**M3 Polygon 同步**、**M4 AI**、**M5 打磨**，以及比赛管理。

## 运行

```bash
pnpm install
pnpm start        # 构建前端并启动，自动打开浏览器（http://127.0.0.1:4523/?token=...）
pnpm dev          # 开发模式：API 在 4523（node --watch），Vite 在 5173；打开终端里打印的链接
pnpm typecheck
pnpm release      # 打包成独立的 npm 包到 release/（无运行时依赖）：npx ./release，或在 release/ 里 npm pack 后 npx polyforge-<版本>.tgz
```

服务端参数：`--port <n>`、`--home <dir>`（全局目录，默认 `~/.polyforge`，也可用环境变量 `POLYFORGE_HOME`）、`--no-open`。

首次启动会初始化全局目录：`config.toml`、`languages.toml`、`secrets.toml`、`shared/`（testlib.h、defs.toml、标准 checker、validator/generator 模板）、`templates/`（新建题目骨架与题面模板）。已存在的文件不会被覆盖，可以随意修改。

然后在“设置 → 题目根目录”里添加一个文件夹，其中每个含 `problem.toml` 的子文件夹就是一道题。

删除题目：题目卡片右上角的垃圾桶图标，或题目页“更多 → 删除题目”。文件夹会移到全局目录的 `trash/`，移回题目根目录即可恢复；包含它的比赛里会显示为“找不到这道题”。删除比赛：比赛页右上角的垃圾桶图标，只删除 `contest.toml`，题目不受影响。

评测目前只支持 Windows，需要 PATH 里有 g++（MinGW-w64）。首次启动会用它编译 runner。

## M1 包含

- 题目列表（完成度徽标）、新建题目（按模板生成骨架）
- 文件树（按角色 / 按目录）、右键菜单（新建、重命名、删除、设为 validator/checker/interactor、设为解并改 tag、注册 generator、std checker“复制到本题”）
- Monaco 多标签编辑，`Ctrl+S` 保存（先写临时文件再 rename），`Ctrl+P` 快速打开
- 文件监听：外部编辑器修改后实时刷新；有未保存修改时提示冲突并显示 diff
- 题目信息面板（标题、时限、空间、checker/validator 选择、解的 tag）
- 中 / 英界面切换，记忆在 `config.toml`
- 设置：题目根目录、编辑器偏好、`languages.toml` 编辑、工具链检测（g++ 会带 testlib.h 试编译）
- 安全：只绑定 127.0.0.1、每次启动随机 token、校验 Host、路径穿越防护

## M2 包含

- **runner**（`packages/server/runner/runner.cpp`）：Job Object 限制 CPU 时间、墙钟（TL×3）、内存、输出大小、进程数；交互题用管道连接解和 interactor。CPU 时间按 CPU 周期计算（Windows 的 `GetProcessTimes` 在这类 CPU 上会少算 3–5 倍）。
- **编译缓存**：按源码、语言模板、testlib.h 的 hash 缓存；`Ctrl+S` 后后台编译，错误以波浪线显示。
- **生成测试**（`Ctrl+Shift+G`）：手写测试 + `script.txt`（Polygon 语法：`gen 1 2 > $`、`> 5`、`> {1-5}`，以及 FreeMarker 常用子集 `<#list>`、`<#assign>`、`<#if>`、`${}`）→ validator 校验（带 overview）→ 标程生成答案。每一步增量缓存。
- **Invocation**：选若干解 × 全部测试，矩阵显示结论 / 时间，按 tag 标出不符合预期的格子；点格子看输入和“答案 vs 输出”的 diff；保留历史记录。
- **自测**：validator 自测、checker 自测（约定见下）。
- **快速运行**（`Ctrl+Enter`）：当前文件在自定义输入或某个测试上运行，带 checker 结论。
- **题面预览**：打开 `statement/<语言>/*.tex` 时右侧实时渲染（Polygon LaTeX 子集 + KaTeX + defs.toml 宏展开），无法识别的命令标黄；输入 `\Def` 自动补全宏，悬停显示展开内容。

### 约定

| 内容 | 约定 |
| --- | --- |
| 手写测试 | `tests/manual/` 下的文件；文件名是数字（如 `03.in`）时就是该测试编号，其余按顺序填空位 |
| 样例 | `problem.toml` 中 `[tests] samples = "1-2"`（信息面板可改） |
| validator 自测 | `validator-tests/` 下文件名含 `valid` / `invalid`，如 `01.valid.in`、`02.invalid.in` |
| checker 自测 | `checker-tests/NAME.in` + `NAME.out`（+ `NAME.ans`），期望结论写在 `NAME.verdict` 或名字里（`02.wa`） |
| 换行 | 测试统一存为 LF（与 Polygon 一致）；编译 C/C++ 时总会加上 `-DFOR_LINUX`（即使 `languages.toml` 里没写），让 testlib 在 Windows 上也按 LF 校验 |
| 缓存 | 编译产物、生成的测试、invocation 结果都在题目的 `.polyforge/`，可随时删除 |

## M3 包含

- **设置 → Polygon**：填 API key / secret（只存在全局目录的 `secrets.toml`，接口返回时打码），“测试连接”。
- **同步对话框**（工具栏“同步”或 `Ctrl+Shift+U`）：
  - **推送**：列出变更集（新增 / 修改 / 已删除），点条目看与 Polygon 当前版本的 diff，勾选后推送；可选 commit（附说明）和构建 package。未绑定时会用短名新建 Polygon 题目，也可以填已有 ID 绑定。推送逐项记录进度，中途失败后再推只会发剩下的。Polygon 远端 revision 与上次同步不一致时会提示先拉取。
  - **拉取**：三方比较（本地 / Polygon / 上次同步），分为“Polygon 已改”“本地已改”“冲突”“仅一方有”；默认只取 Polygon 单方改动。
  - **合并**：两边都改过的文本条目（代码、题面段落、script、测试……）可以按行三方合并，改动不重叠时默认勾选“合并”，可先看合并结果的 diff；重叠的部分写成 `<<<<<<< local` / `=======` / `>>>>>>> Polygon` 冲突标记，在编辑器里处理后再推送。合并所需的共同祖先保存在 `.polyforge/sync-base/`。从未同步过的本地题目绑定 Polygon 后拉取，没有共同祖先，差异项只能二选一。
- **从 Polygon 导入**（题目列表）：浏览可访问的题目或填 ID，下载为本地题目并记录同步状态。
- 同步内容：题目信息、validator / checker / interactor、generators、资源文件、解和 tag、各语言题面（`zh` ↔ `chinese`、`en` ↔ `english`）与图片、script、手写测试、样例标记、分组与分值、validator / checker 自测。
- 同步状态在 `.polyforge/sync.json`（删掉等于“从未同步”，下次推送会全部重发）。

注意：

- Polygon API 没有删除接口：本地删掉的文件只会提示，需到 Polygon 上手动删除（题面段落和样例标记可以清空）。
- tag 对应：`TL-OR-OK` ↔ `TO`；Polygon 没有 `FL`，推送时按 `RJ` 发送。
- 方法和参数按 [polygon-py](https://github.com/citxx/polygon-py)（与官方 API 文档一致）核对过，签名与其算法逐字节一致。自带的 mock（`pnpm --filter @polyforge/server mock-polygon`，在 `secrets.toml` 里设 `[polygon] api_url = "http://127.0.0.1:4700/api/"`）会校验签名，推送、拉取、导入都在它上面测过。**还没有在真实 Polygon 账号上跑过**，第一次建议用一道测试题试。

## M4 包含

- **设置 → AI**：可配置多个端点，协议为 `anthropic`（官方或兼容中转站）或 `openai`（Chat Completions，兼容各类中转站），base URL 与 key 自定义，保存在 `secrets.toml` 的 `[[ai.endpoints]]`；“测试连接”“拉取模型列表”；默认端点 / 模型存在 `config.toml` 的 `[ai]`。
- **AI 面板**（工具栏“AI”）：一个可以修改整道题所有文件的 agent。它在题目副本（`.polyforge/ai/<会话>/work`）里工作，工具包括：列出 / 读取 / 写入 / 按片段修改 / 删除任意文件、读共享库（std checker、模板、testlib.h）、编译、运行、生成测试、查看测试、跑 invocation、validator / checker 自测、更新计划清单。它会自己编译和判题来检查改动；对 `problem.toml` 的修改必须保持合法。
- **改动确认**：agent 的改动汇总成改动列表，逐个文件看 diff 后“接受”（写入题目，打开的编辑器会自动刷新）或“放弃”。AI 不会直接改动你的题目文件。
- **快捷任务**：整题生成、分析题面、validator、标程、暴力、造数据、checker、错误解、全面验证、翻译题面、题面检查，以及“贴题面”（任意格式的题面 → Polygon LaTeX → 整题）。任务可以随时重跑或接着对话调整。
- 会话保存在 `.polyforge/ai/`，关掉页面后可以继续；运行中可以“停止”。
- **用量与费用**：每次请求的 token（输入、输出、缓存读取 / 写入）记在全局目录的 `cache/ai-usage.jsonl`；AI 面板显示当前会话的请求数、token 和费用，设置 → AI 的“用量与费用”按今天 / 本月 / 全部、按模型、按题目汇总。价格在每个端点的“价格”里按模型设置（每百万 token，USD 或 CNY，`*` 表示其他模型），不内置任何价格；未设置价格时只统计 token。费用按当前价格计算，改了价格历史也随之更新。
- 题面里的 defs 宏（如 `DefLimitSum[n][5 cdot 10^5]`）在 AI 读取题面文件时会附上展开后的文字，AI 会把它当作题面的一部分。
- Anthropic 协议默认 `claude-opus-5`，开启 adaptive thinking（面板里可展开思考摘要），系统提示和工具列表做了 prompt caching。连接官方 API 时额外开启：服务端拒答回退（`fallbacks: "default"`，被拒答时自动换模型继续）和工具输入的流式传输；连接中转站时这些 beta 功能都不启用，以免被拒绝。

测试：`scripts/mock-llm.ts` 是按脚本回复的 Anthropic / OpenAI 双协议 mock，会检查 thinking 块是否原样回传、工具结果是否正确返回；`scripts/test-agent.ts` 用它对两种协议跑完整流程（14 次工具调用、4 个文件的改动、接受 / 放弃）。**还没有接真实模型跑过**，真实模型的造题质量需要你用自己的 key 试。

## M5 包含

- **对拍**（工具栏“对拍”）：generator（参数里的 `{seed}` 换成每轮种子）→ 待测解 vs 标程，发现差异时给出输入、两边输出和种子，可一键存为手写测试。
- **题面检查与自动修复**（`Ctrl+Shift+L`）：检查 Markdown 残留（`**粗体**`、`` `代码` ``、`#` 标题、列表）、ASCII 运算符（`<=` → `\le`）、直引号、省略号、数学里的 `10^18` / `1e5` / `*`、中文排版（中英文间距、全角标点）、未闭合的 `$` 和括号；可修复项在 diff 里确认后一键写入。`.tex` 文件在编辑器里同时显示波浪线。
- **题解**：`statement/<语言>/tutorial.tex`，与题面一样多语言、实时预览。题解语言应与题面语言一一对应：文件树、题目卡片、本地检查和导出都会提示缺失或多余的语言，文件树里可以一键补齐。
- **导出 package**（“更多 → 导出”）：Polygon 格式的 zip（`problem.xml`、各语言 `problem.tex` / `tutorial.tex` 与分段题面、样例、全部测试和答案、程序、script、分组）。
- **AI 检查**（AI 面板“检查”页，需要配置 AI 端点，手动开始）：先列出本地检查结果（缺少的部分、语言不对应、题面格式、测试生成错误），再由 AI 只读地通读题目、自己编译判题，逐条列出问题；每个问题可以一键交给 AI 修复。
- **命令面板**（`Ctrl+K`）、快捷键一览（`Ctrl+/`）、底部状态栏（连接状态、Polygon 绑定、测试数、编译状态、语言、换行符）；题目列表有完成度进度条、排序、卡片 / 列表视图。
- 界面图标统一用 [lucide](https://lucide.dev) 的 SVG 图标。

## 测试集与子任务

与 Polygon 的概念一致：

```toml
[tests]                     # 测试集 "tests"（题面样例、答案都用它）
script = "tests/script.txt"
samples = "1"
points = true               # 启用分值（整道题）
groups = true               # 启用子任务（分组）

[[tests.group]]
name = "1"
tests = "1-10"
points = 40
policy = "COMPLETE_GROUP"   # 全部通过才得分；EACH_TEST 按测试点得分

[[tests.group]]
name = "2"
tests = "11-30"
points = 60
policy = "EACH_TEST"
dependencies = ["1"]        # 子任务 1 未全部通过时本组不得分

[testsets.pretests]         # 其他测试集：手写测试默认在 tests/pretests/
script = "tests/script-pretests.txt"
```

- 测试面板可切换测试集，“子任务”按钮（层叠图标）打开编辑器：增删测试集、编辑子任务（名称、测试点、分值、计分方式、依赖），会提示没有归入子任务或重复归入的测试点；validator 按 Polygon 的方式收到 `--testset` 和 `--group`。
- 批量评测按 Polygon 的方式选择：勾选解法，选测试集，再勾选测试点（按子任务分块，可整块勾选；全选 / 全不选 / 样例 / 反选；Shift 点击选一段；也可以输入 `1-5, 8`）。启用分值后，结果表头显示每个解法的得分，底部列出每个子任务的得分和总分；只跑了部分测试点时只统计跑过的子任务。
- 计分规则：测试点通过得该点分值（checker 用 `quitp` 给了分数时以它为准）；`COMPLETE_GROUP` 全部通过才得全组分，`EACH_TEST` 累加；依赖的子任务没有全部通过时得 0 分。分值推送到 Polygon 时换算到每个测试点（`COMPLETE_GROUP` 的分数放在组内最后一个测试点上）。
- 导出的 package 为每个测试集写一个 `<testset>`（文件在 `<测试集名>/01` …），带分组、分值和依赖。
- 同步：其他测试集（脚本、手写测试、分组、分值）作为一个条目推送 / 拉取。Polygon API 不能新建测试集，也不能列出已有的测试集：推送前要在 Polygon 的 Tests 页面建好同名测试集；拉取只取本地已有的测试集，从 Polygon 导入新题时只导入 `tests`。

## 比赛

比赛是题目根目录下含 `contest.toml` 的文件夹，只引用题目（按题目 ID，即文件夹名），题目仍在各自的文件夹里，一道题可以属于多场比赛：

```toml
[contest]
name = "round-1"
title = { zh = "第一轮", en = "Round 1" }

[polygon]
id = 12345            # 可选：对应的 Polygon 比赛

[[problems]]
index = "A"
problem = "a-plus-b"
```

- 题目列表的“比赛”页：新建比赛（选题后按顺序编号 A、B、C…），或“从 Polygon 导入”一场比赛（`contest.problems`；本地已绑定同一 Polygon 题目的直接复用，其余逐题导入）。
- 比赛页：题目表（编号、标题、限制、完成度、Polygon 绑定），可添加、移除、调整顺序（编号随顺序重排）。
- 批量操作，逐题执行，每题单独给出结果和详情：生成测试、运行 invocation（全部非 NR 的解，检查是否符合 tag）、本地检查、导出比赛包（`contest.xml` + `problems/<短名>/` 下的完整 package）、推送到 Polygon（推送所有改动并 commit；Polygon 上被改过的题会跳过并提示先拉取）。
- 题面汇总：某一语言的全部题面（可附带题解），按纸张排版，每题分页，用浏览器打印或存为 PDF；缺少该语言题面或题解的题会标出来。

## 结构

```
packages/shared   类型、problem.toml schema（zod）、文件角色识别、tag 规则
packages/server   Fastify + WebSocket；global.ts（全局目录）、workspace/（题目、比赛、文件、watcher）、
                  judge/（runner、编译、script、测试生成、invocation、自测、对拍、导出、本地检查、比赛批量操作）、runner/runner.cpp、
                  polygon/（API 客户端、同步条目、推送 / 拉取 / 导入、三方合并）、
                  ai/（provider、agent、sandbox、工具、系统提示）、
                  scripts/（mock-polygon、mock-llm 与端到端测试）
packages/web      Vue 3 + Naive UI + Monaco + vue-i18n + KaTeX
assets/           首次启动拷贝到全局目录的默认文件
```
