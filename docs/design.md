# TaskWeave — 本地造题平台设计文档

> 暂定名 TaskWeave。一个本地优先（local-first）的 Polygon 替代/增强工具：文件存在本地，网页端做编辑、评测、造数据，需要时一键同步到 Polygon。

---

## 1. 设计目标

| 目标 | 具体含义 |
| --- | --- |
| 本地优先 | 磁盘上的文件是唯一真相来源（source of truth）。网页只是文件的"视图 + 操作器"，用 VSCode 等外部编辑器改文件，网页实时刷新。 |
| 比 Polygon 丝滑 | 一个页面完成所有操作：左侧文件树、中间编辑器、右侧运行结果。`Ctrl+S` 直接落盘，无"进入 → Files → Edit → Save"流程。 |
| 兼容 Polygon | 概念一一对应（validator / checker / interactor / generator / script / solution tag / groups / points），可无损推送到 Polygon，也可从 Polygon 包导入。 |
| AI 造题 | 输入题面，AI 分步生成 validator、std、暴力、generator、script、checker、错误解，并由本地评测自动交叉验证。每一步可见、可改、可重跑。 |
| 中英双语 | 界面 i18n + 题面多语言（legend/input/output/notes/tutorial 各自有中/英版本）。 |

非目标（至少第一版）：多用户协作、在线部署、比赛管理。

---

## 2. 总体架构

```
┌──────────────────────── 浏览器 (SPA) ────────────────────────┐
│  Vue 3 + Vite + Monaco Editor + Naive UI + vue-i18n + KaTeX  │
│  文件树 │ 多标签编辑器 │ 测试/评测面板 │ 题面预览 │ AI 面板   │
└───────────────▲──────────────────────────────▲──────────────┘
         REST (JSON)                   WebSocket (事件推送)
┌───────────────┴──────────────────────────────┴──────────────┐
│                Node.js 服务端 (Fastify, TypeScript)           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────┐ │
│  │Workspace │ │  Judge   │ │ Polygon  │ │    AI    │ │Watch│ │
│  │ 题目/文件 │ │编译/运行  │ │  Sync    │ │ Pipeline │ │文件  │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └──┬──┘ │
└───────┼────────────┼────────────┼────────────┼──────────┼────┘
        ▼            ▼            ▼            ▼          ▼
   题目文件夹     runner 沙箱   Polygon API   LLM API   chokidar
   + 全局目录    (native helper)
```

- **服务端只监听 `127.0.0.1`**，启动后自动打开浏览器（`npm start` / 以后可打包成 `npx taskweave`）。
- **无数据库**：所有状态都是文件。缓存（编译产物、生成的测试、hash、同步状态）放在题目内的 `.taskweave/` 隐藏目录，可随时删除重建。
- **WebSocket 推送**：文件变化、编译进度、评测进度、AI 流式输出都走 WS，前端不轮询。

### 技术选型

| 部分 | 选型 | 理由 |
| --- | --- | --- |
| 语言 | TypeScript（前后端共享类型） | 题目 schema、API 类型只写一份 |
| 后端 | Fastify + @fastify/websocket | 轻、快、schema 校验 |
| 前端 | Vue 3 + Vite + Naive UI | 组件齐全，暗色主题好看 |
| 编辑器 | Monaco | 与 VSCode 同内核，C++ 高亮/多标签/diff 视图 |
| 文件监听 | chokidar | 跨平台稳定 |
| 配置格式 | TOML（`smol-toml`） | 人类可读，适合手改 |
| 题面渲染 | 自研 Polygon-LaTeX 子集解析器 + KaTeX | 本地直接写 Polygon 格式，实时预览，展开 defs.toml 宏 |
| 进程/资源限制 | 自带小型 C++ runner（第一版只做 Windows Job Object） | Node 自身无法可靠限制内存 |
| AI | 官方 `@anthropic-ai/sdk` + `openai` SDK，均可自定义 baseURL | 同时支持官方接口和中转站 |

仓库结构（monorepo，pnpm workspace）：

```
taskweave/
├─ packages/
│  ├─ shared/        # 类型定义、problem.toml schema (zod)、常量
│  ├─ server/        # Fastify 服务
│  │  ├─ workspace/  # 题目读写、文件树、watcher
│  │  ├─ judge/      # 编译、运行、checker、测试生成
│  │  ├─ polygon/    # Polygon API 客户端 + 同步引擎
│  │  ├─ ai/         # Provider 抽象 + 造题流水线
│  │  └─ runner/     # C++ runner 源码，首次启动时编译
│  └─ web/           # Vue 前端
└─ assets/           # 内置的 testlib.h、标准 checker、模板（首次启动拷贝到全局目录）
```

---

## 3. 存储设计

### 3.1 全局目录（共有文件）

默认 `~/.taskweave/`，可在设置中修改。

```
~/.taskweave/
├─ config.toml            # 全局配置：界面语言、题目根目录、编辑器偏好
├─ secrets.toml           # Polygon key/secret、AI key（与题目分离，题目文件夹可放心 git）
├─ languages.toml         # 本地语言配置（见 §5）
├─ shared/
│  ├─ testlib.h
│  ├─ defs.toml           # Codeforces 题面宏定义（\DefSubsequence 等，见 §4.6）
│  ├─ checkers/           # ncmp.cpp wcmp.cpp lcmp.cpp fcmp.cpp hcmp.cpp
│  │                      # rcmp4/6/9.cpp yesno.cpp nyesno.cpp uncmp.cpp caseicmp.cpp ...
│  ├─ validators/         # 常用 validator 模板
│  └─ generators/         # 常用 generator 模板（随机树、随机图等）
├─ templates/
│  ├─ problem/            # 新建题目时的骨架
│  └─ statement/          # 题面模板（中/英）
└─ cache/
   └─ bin/                # 共有 checker 的编译产物（按源码 hash 缓存）
```

题目引用共有文件时**不复制**，而是在 `problem.toml` 中写 `checker = "std:ncmp"`，编译时从 `shared/` 取。需要魔改时点"复制到本题"，变成本题私有文件。

### 3.2 题目根目录（一题一文件夹）

用户在设置中指定一个或多个根目录，每个子文件夹（含 `problem.toml`）即一道题。

```
D:/problems/
└─ a-plus-b/
   ├─ problem.toml              # 题目元信息（唯一必需文件）
   ├─ statement/
   │  ├─ zh/  legend.tex input.tex output.tex interaction.tex notes.tex tutorial.tex
   │  ├─ en/  legend.tex input.tex output.tex interaction.tex notes.tex tutorial.tex
   │  └─ images/                # 题面图片，同步为 statement resources
   ├─ files/                    # 资源文件（头文件、图片等），对应 Polygon resource files
   ├─ validator.cpp
   ├─ checker.cpp               # 可选；缺省时用 problem.toml 里指定的 std checker
   ├─ interactor.cpp            # 交互题才有
   ├─ generators/
   │  ├─ gen_random.cpp
   │  └─ gen_tree.cpp
   ├─ solutions/
   │  ├─ std.cpp
   │  ├─ brute.cpp
   │  └─ wa_overflow.cpp
   ├─ tests/
   │  ├─ manual/  01.in 02.in   # 手写测试
   │  └─ script.txt             # Polygon 格式的 generator 脚本 (gen_random 10 5 > $)
   ├─ validator-tests/          # validator 自测（期望 VALID/INVALID）
   ├─ checker-tests/            # checker 自测
   └─ .taskweave/               # 缓存，可删除，建议 .gitignore
      ├─ build/                 # 编译产物
      ├─ tests/                 # 生成出的完整 .in/.ans
      ├─ runs/                  # 历次 invocation 结果
      └─ sync.json              # 每个文件上次同步到 Polygon 时的 hash
```

### 3.3 `problem.toml` 示例

```toml
[problem]
name = "a-plus-b"
title = { zh = "A 加 B", en = "A + B" }
time_limit = 1000        # ms
memory_limit = 256       # MB
input = "stdin"
output = "stdout"
interactive = false

[polygon]
id = 123456              # 绑定后写入；为空表示尚未创建
# 该题最近一次同步的 revision 等写在 .taskweave/sync.json

[checker]
source = "std:ncmp"      # 或 "checker.cpp"

[validator]
source = "validator.cpp"

[[solutions]]
source = "solutions/std.cpp"
tag = "MA"               # MA / OK / WA / TL / TL-OR-OK / ML / RE / PE / RJ / FL
[[solutions]]
source = "solutions/brute.cpp"
tag = "TL"
[[solutions]]
source = "solutions/wa_overflow.cpp"
tag = "WA"

[[generators]]
source = "generators/gen_random.cpp"

[tests]
script = "tests/script.txt"
groups = true
points = true

[[tests.group]]
name = "1"
points = 30
policy = "COMPLETE_GROUP"   # 或 EACH_TEST
dependencies = []
tests = "1-10"
```

**文件角色约定优先于配置**：`validator.cpp`、`checker.cpp`、`solutions/*` 放到对应位置即被识别；`problem.toml` 只记录约定推不出来的东西（tag、分组、限制）。这样在外部编辑器里新建文件也能被正确识别。

---

## 4. 核心模块

### 4.1 Workspace（题目与文件）

- 扫描题目根目录生成题目列表（名称、状态徽标：validator ✓ / std ✓ / 测试数 / 同步状态）。
- 文件 CRUD、重命名、移动；所有写操作先写临时文件再 rename，防止写坏。
- chokidar 监听题目目录 → WS 推 `file:changed` → 前端若该文件已打开且无未保存修改则静默刷新，否则提示冲突（展示 diff）。
- 为防止自己保存引起的回环事件，写盘时记录 hash，watcher 收到相同 hash 忽略。

### 4.2 Judge（本地评测）

**编译**：按 `languages.toml` 模板编译，按"源码 hash + 语言 + 编译参数"缓存产物，未改动不重编。

**runner**：一个 ~300 行的 C++ 小程序，首次启动时用本机编译器编译：
- Windows（第一版）：Job Object 限制内存（`JOB_OBJECT_LIMIT_PROCESS_MEMORY`）和进程数（`ACTIVE_PROCESS`，防 fork 炸弹），`QueryInformationJobObject` 取峰值内存，`GetProcessTimes` 取 CPU 时间；墙钟超时（默认 TL×3）用 `TerminateJobObject` 强杀。调用 `SetErrorMode` 避免程序崩溃时弹出 Windows 错误对话框。
- 栈空间：C++ 编译模板默认加 `-Wl,--stack=268435456`，贴近 Codeforces 环境。
- 默认编译器：MSYS2 / MinGW-w64 g++（首次启动引导指定路径）。
- Linux/macOS（以后）：`setrlimit` + `wait4` 获取 rusage，runner 的输入输出接口保持不变。
- 输出 JSON：`{status, time_ms, memory_kb, exit_code}`。
- Node 侧并发调度（默认 `CPU 核数 - 1` 个 worker）。

**功能**：
| 功能 | 说明 |
| --- | --- |
| 生成测试 | 解析 `script.txt`（兼容 Polygon 语法，包括 `gen 1 2 > $`、`gen 10 > {5-10}` 等），运行 generator，逐个跑 validator，再用 MA 解生成 `.ans` |
| Validator 自测 | 跑 `validator-tests/`，检查 VALID/INVALID 是否符合预期；支持 testlib 的 `--testOverviewLogFileName` 展示变量覆盖情况 |
| Checker 自测 | 同上 |
| Invocation | 选若干解 × 全部测试，输出矩阵（与 Polygon 的 invocation 视图一致），自动对照 tag 标红"不符合预期"的格子 |
| 对拍 (stress) | 选 generator + 参数模板 + 两个解，无限跑直到发现差异，自动把反例存为手写测试 |
| 快速运行 | 编辑器里对当前文件"输入框 → 运行"，像在线 IDE 一样 |

### 4.3 Polygon 同步

**API 客户端**：Polygon API（`https://polygon.codeforces.com/api/{method}`），签名规则：
`apiSig = rand6 + sha512hex(rand6 + "/" + method + "?" + 排序后的参数 + "#" + secret)`，参数含 `apiKey`、`time`。

**推送流程**（本地 → Polygon）：
1. 若 `polygon.id` 为空：调用 `problem.create` 创建题目，写回 id。
2. 对每个文件计算 hash，与 `.taskweave/sync.json` 比较，得到变更集。
3. 在界面上展示变更集（新增/修改/删除），用户确认。
4. 按依赖顺序调用：`updateInfo` → `saveFile`（resource / source）→ `setValidator` / `setChecker` / `setInteractor` → `saveSolution`（带 tag）→ `saveStatement` → `saveScript` / `saveTest` → `enableGroups`/`enablePoints`/`saveTestGroup`。
5. 可选 `commitChanges`（附带 message）和 `buildPackage`。
6. 成功后更新 `sync.json`。

**拉取/导入**（Polygon → 本地）：用 `problem.files`、`problem.solutions`、`problem.statements`、`problem.script`、`problem.tests` 等读取，或直接下载 package 解析，转换为本地目录结构。冲突时（本地和远端都改了）逐文件展示 diff 让用户选择。

**限速与重试**：请求串行 + 失败指数退避；进度通过 WS 推给前端。

> 实现前需要逐一核对 Polygon API 文档里各方法的确切参数（例如 `problem.create` 的可用性、`saveTest` 的参数），以文档为准。

### 4.4 AI 造题

**Provider 抽象**：两种协议 × 任意地址。设置里可以配置多个"AI 端点"：

```toml
# secrets.toml
[[ai.endpoints]]
name = "Claude 官方"
protocol = "anthropic"            # anthropic | openai
base_url = "https://api.anthropic.com"
api_key = "sk-ant-..."
models = ["claude-opus-5-5", "claude-sonnet-5"]

[[ai.endpoints]]
name = "某中转站"
protocol = "openai"               # 中转站多数兼容 OpenAI 协议，也有兼容 Anthropic 协议的
base_url = "https://example-proxy.com/v1"
api_key = "sk-..."
models = ["gpt-5", "claude-sonnet-5"]
```

- `anthropic` 走 Messages API，`openai` 走 Chat Completions，内部统一成 `chat(messages, { stream, maxTokens })` 接口。
- 设置页有"测试连接"按钮（发一条极短请求，显示延迟或报错），以及"拉取模型列表"（调用 `/v1/models`，拉不到就手填）。
- 流水线的每个阶段可以指定不同的端点和模型（例如 std 用强模型，generator 用便宜模型）。

**流水线**（每一步都是一个独立"阶段"，可单独重跑，结果以 diff 形式呈现、用户确认后才落盘）：

```
题面 ──► ① 解析：提取输入格式、约束、样例、输出是否唯一
       ──► ② validator.cpp（testlib）            ─┐
       ──► ③ std.cpp（MA）                        │
       ──► ④ brute.cpp（暴力，小数据正确）         ├─► ⑧ 自动验证
       ──► ⑤ generators + script.txt（含边界/极限/特殊构造）│
       ──► ⑥ checker：选 std checker 或写自定义    │
       ──► ⑦ 错误解（WA/TL 各若干，用于检验数据强度）┘
⑧ 自动验证：
   - 编译全部文件，编译错误回喂 AI 修正（最多 N 轮）
   - 样例通过 std / brute
   - 所有测试通过 validator
   - 小数据上 std 与 brute 对拍
   - 跑 invocation，检查错误解是否都被卡掉；没被卡掉 → 让 AI 补数据
⑨ 生成报告：哪些检查通过、哪些需要人工关注
```

- 流水线状态保存到 `.taskweave/ai/`，关掉页面后可以继续。
- 右侧 AI 面板流式显示输出；也支持在任意文件上"让 AI 改这个文件"（带上下文：题面 + 当前文件 + 最近运行错误）。
- AI 永远不直接覆盖文件：先给出 diff，用户接受后才写盘。

### 4.5 i18n

- 界面：`vue-i18n`，`locales/zh-CN.json`、`locales/en.json`，右上角一键切换，记忆在 `config.toml`。
- 题面：每种语言一个子目录，编辑器支持左右分栏对照编辑（中文 | 英文），并可"AI 翻译到另一语言"。
- 同步时 `zh` → Polygon 的 `chinese`，`en` → `english`，内容原样上传（本地就是 Polygon 格式，不需要转换）。

### 4.6 题面：Polygon LaTeX + defs.toml

本地题面**直接按 Polygon 的要求写**（`\begin{itemize}`、`\textbf{}`、`\t{}`、`$...$`、`\footnote{}` 等），同步时不做任何转换。

**预览渲染器**：Polygon 题面只用到 LaTeX 的一个小子集，自己写解析器即可覆盖：
- 文本命令：`\textbf \textit \emph \underline \t \texttt \tt \bf \it \sc \footnote \url \href`
- 环境：`itemize enumerate center tabular verbatim lstlisting`
- 图片：`\includegraphics[...]{x.png}`（从题目的 `statement/images/` 读取）
- 排版：`~`、`--`、`---`、` `` '' `、`\\`、空行分段
- 公式：`$...$`、`$$...$$` 交给 KaTeX
- 识别不了的命令用黄色高亮原样显示，方便发现笔误（相当于一个轻量 lint）。

**defs.toml 宏展开**：`shared/defs.toml` 是 Codeforces 的题面宏定义，结构为：

```toml
[[english.command]]     # 另有 [[russian.command]]、[[common.command]]
name = "DefFlush"
args = ["$-1$"]         # 参数个数 = 数组长度；元素是默认值，空串表示必填
disable-args-inspection = true   # 可选
body = '...#1...#2...'
```

- 预览时按题面语言选表：`en` → `english`；`zh` → `chinese`（目前的 defs.toml 没有这张表，找不到时回退到 `english`，以后你可以自己加 `[[chinese.command]]`），最后再查 `common`。
- 展开 `\DefXxx{a}{b}` 时，缺省参数用默认值；展开结果继续递归渲染（body 里还会有 `\begin{itemize}` 等）。
- 编辑器里输入 `\Def` 时自动补全宏名，鼠标悬停显示展开后的文字。
- AI 写题面时，把宏列表（名字 + 英文 body 摘要）放进提示词，让它优先用标准宏。
- **同步到 Polygon 时原样保留宏**，由 Polygon / Codeforces 一侧展开。

**以后的"自动修改"**：在渲染器基础上加 lint 和自动修复，例如把 Markdown 的 `**粗体**` 改成 `\textbf{}`、把 `<=` 改成 `\le`、调整全角标点与公式之间的空格等，以 diff 形式给出。

---

## 5. 语言配置 `languages.toml`

```toml
[cpp17]
name = "C++17 (GCC)"
extensions = [".cpp", ".cc"]
compile = "g++ -std=c++17 -O2 -Wall -I{shared} -o {exe} {src}"
run = "{exe}"
polygon = "cpp.g++17"          # 同步到 Polygon 时使用的语言 id

[cpp20]
name = "C++20 (GCC)"
extensions = [".cpp"]
compile = "g++ -std=c++20 -O2 -I{shared} -o {exe} {src}"
run = "{exe}"
polygon = "cpp.gcc14-64-msys2-g++23"

[py3]
name = "Python 3"
extensions = [".py"]
run = "python {src}"
polygon = "python.3"

[java21]
name = "Java 21"
extensions = [".java"]
compile = "javac -d {dir} {src}"
run = "java -cp {dir} {class}"
polygon = "java21"
```

- 占位符：`{src} {exe} {dir} {class} {shared}`（`{shared}` 指向全局 `shared/`，这样 `#include "testlib.h"` 直接可用）。
- 设置页有"检测"按钮：自动探测 PATH 里的 g++/clang++/python/java 并测试编译一个 Hello World。
- 每个文件可以单独覆盖语言（默认按扩展名选择第一个匹配项）。

---

## 6. 交互设计（"丝滑"的关键）

### 6.1 主界面布局

```
┌───────────────────────────────────────────────────────────────────┐
│ ◀ 题目列表 │ a-plus-b  1s/256MB  [生成测试][Invocation][同步↑][AI] 中/EN │
├──────────┬──────────────────────────────────────┬─────────────────┤
│ 📄 题面   │  validator.cpp ● │ std.cpp │ legend.md │  测试 (24)       │
│ ✅ Valid. │ ─────────────────────────────────────│  #1 manual  ✓    │
│ ✅ Checker│  #include "testlib.h"                 │  #2 gen 10  ✓    │
│ 🧩 Gens   │  int main(int argc, char* argv[]) {  │  #3 gen 1e5 ✓    │
│ 💡 Sols   │      registerValidation(argc, argv); │  ───────────     │
│   std MA │      ...                              │  运行结果 / 输出  │
│   brute TL│                                      │  预览 / 报错      │
│ 🧪 Tests  │                                      │                  │
└──────────┴──────────────────────────────────────┴─────────────────┘
```

- 左侧按**角色**而不是目录分组（题面 / validator / checker / generators / solutions / tests），右键可"设为 validator""改 tag""复制为新解"。
- 标签页上的 `●` 表示未保存；`Ctrl+S` 保存并触发后台增量编译，编译错误直接以 Monaco 波浪线显示。
- 题面标签页自动左右分屏：左边 LaTeX 源码，右边实时渲染（含 defs.toml 宏展开）。

### 6.2 快捷操作

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl+K` | 命令面板（"生成测试""跑 invocation""新建 generator""同步到 Polygon"……） |
| `Ctrl+P` | 快速打开文件 |
| `Ctrl+S` | 保存并编译 |
| `Ctrl+Enter` | 用当前文件在选中测试上运行 |
| `Ctrl+Shift+G` | 重新生成测试 |
| `Ctrl+Shift+U` | 推送到 Polygon |

### 6.3 其他体验细节

- 测试面板：点一下看 `.in/.ans` 预览（大文件只读前 N KB）、看是哪条 script 命令生成的、validator 的 overview。
- Invocation 矩阵：格子悬停显示时间/内存/checker 信息，点击看 diff。
- 题目列表页：卡片视图，显示每题的完成度清单（题面 / validator / std / 测试 / 已同步），一眼看出还差什么。
- 新建题目向导：填名字 + 限制 → 选模板 → 可选"贴题面让 AI 生成"。

---

## 7. 服务端 API 草案

REST（前缀 `/api`）：

```
GET    /problems                         列出所有题目（含状态摘要）
POST   /problems                         新建题目
GET    /problems/:id                     problem.toml + 文件树
PATCH  /problems/:id                     修改元信息
GET    /problems/:id/files/*path         读文件
PUT    /problems/:id/files/*path         写文件
DELETE /problems/:id/files/*path
POST   /problems/:id/files/move
POST   /problems/:id/build               编译（全部或指定文件）
POST   /problems/:id/tests/generate      按 script 生成测试
POST   /problems/:id/run                 在输入/测试上运行某个程序
POST   /problems/:id/invocations         发起 invocation → 返回 jobId
POST   /problems/:id/stress              发起对拍 → jobId
POST   /problems/:id/polygon/diff        计算与 Polygon 的变更集
POST   /problems/:id/polygon/push        推送 → jobId
POST   /problems/import/polygon          从 Polygon 导入
POST   /problems/:id/ai/pipeline         启动 AI 造题 → jobId
POST   /jobs/:jobId/cancel
GET/PUT /settings, /languages, /secrets
GET    /shared/*path                     共有文件
```

WebSocket 事件：`file:changed`、`build:progress`、`job:progress`、`job:done`、`ai:token`、`ai:stage`。

---

## 8. 安全

- 服务只绑定 `127.0.0.1`，启动时生成随机 token，前端请求需带上（防止其他网页通过 localhost 调用接口执行代码）。
- 所有文件路径做规范化并校验必须位于题目目录或全局目录内（防路径穿越）。
- 密钥只放 `secrets.toml`，永不写进题目目录，API 返回时打码。

---

## 9. 开发路线

| 阶段 | 内容 | 可用性 |
| --- | --- | --- |
| **M1 本地核心** | 项目骨架、全局目录初始化（内置 testlib 与 std checker）、题目列表/新建、文件树 + Monaco 编辑 + 保存、文件监听、i18n、语言配置 | 能当本地编辑器用 |
| **M2 评测** | runner、编译缓存、script 解析与测试生成、validator/checker 自测、invocation 矩阵、快速运行、题面预览 | 能完整在本地造完一道题 |
| **M3 Polygon 同步** | API 客户端、推送变更集、导入已有题目、冲突处理 | 能替代日常的 Polygon 网页操作 |
| **M4 AI** | Provider 抽象、造题流水线、自动验证循环、单文件 AI 修改 | 贴题面出整题 |
| **M5 打磨** | 对拍、命令面板、完成度看板、打包成 `npx` 一键启动、Polygon package 导出 | — |

---

## 10. 已确定的决策

| 问题 | 决定 |
| --- | --- |
| defs.toml | Codeforces 题面宏定义，放在 `shared/`，用于预览展开、编辑器补全和 AI 提示词（§4.6） |
| 前端框架 | Vue 3 + Vite + Naive UI |
| AI | 支持 Anthropic 和 OpenAI 两种协议；每个端点可自定义 base_url + api_key，覆盖中转站（§4.4） |
| 平台 | 第一版只做 Windows（runner 用 Job Object，默认 MinGW g++） |
| 题面格式 | 本地直接写 Polygon LaTeX，同步时不转换；以后再加 lint / 自动修复 |