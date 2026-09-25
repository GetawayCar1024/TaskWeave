# PolyForge

本地优先的 Polygon 造题平台。设计见 [DESIGN.md](DESIGN.md)。当前完成 **M1 本地核心**、**M2 评测** 和 **M3 Polygon 同步**。

## 运行

```bash
pnpm install
pnpm start        # 构建前端并启动，自动打开浏览器（http://127.0.0.1:4523/?token=...）
pnpm dev          # 开发模式：API 在 4523（node --watch），Vite 在 5173；打开终端里打印的链接
pnpm typecheck
```

服务端参数：`--port <n>`、`--home <dir>`（全局目录，默认 `~/.polyforge`，也可用环境变量 `POLYFORGE_HOME`）、`--no-open`。

首次启动会初始化全局目录：`config.toml`、`languages.toml`、`secrets.toml`、`shared/`（testlib.h、defs.toml、标准 checker、validator/generator 模板）、`templates/`（新建题目骨架与题面模板）。已存在的文件不会被覆盖，可以随意修改。

然后在“设置 → 题目根目录”里添加一个文件夹，其中每个含 `problem.toml` 的子文件夹就是一道题。

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
| 换行 | 测试统一存为 LF（与 Polygon 一致）；C++ 模板带 `-DFOR_LINUX`，让 testlib 在 Windows 上也按 LF 校验 |
| 缓存 | 编译产物、生成的测试、invocation 结果都在题目的 `.polyforge/`，可随时删除 |

> testlib：内置的是原版 0.9.44（未修改）。用 GCC 15 编译时，0.9.44 的 `vtos()` 带 `__attribute__((const))`，会导致 checker 消息里的数字显示成 `0`（结论不受影响）。需要的话把 `~/.polyforge/shared/testlib.h` 换成上游 0.9.45 即可，编译缓存会自动失效。

## M3 包含

- **设置 → Polygon**：填 API key / secret（只存在全局目录的 `secrets.toml`，接口返回时打码），“测试连接”。
- **同步对话框**（工具栏“同步 ↑”或 `Ctrl+Shift+U`）：
  - **推送**：列出变更集（新增 / 修改 / 已删除），点条目看与 Polygon 当前版本的 diff，勾选后推送；可选 commit（附说明）和构建 package。未绑定时会用短名新建 Polygon 题目，也可以填已有 ID 绑定。推送逐项记录进度，中途失败后再推只会发剩下的。Polygon 远端 revision 与上次同步不一致时会提示先拉取。
  - **拉取**：三方比较（本地 / Polygon / 上次同步），分为“Polygon 已改”“本地已改”“冲突”“仅一方有”；默认只取 Polygon 单方改动，冲突逐项看 diff 自己选。
- **从 Polygon 导入**（题目列表）：浏览可访问的题目或填 ID，下载为本地题目并记录同步状态。
- 同步内容：题目信息、validator / checker / interactor、generators、资源文件、解和 tag、各语言题面（`zh` ↔ `chinese`、`en` ↔ `english`）与图片、script、手写测试、样例标记、分组与分值、validator / checker 自测。
- 同步状态在 `.polyforge/sync.json`（删掉等于“从未同步”，下次推送会全部重发）。

注意：

- Polygon API 没有删除接口：本地删掉的文件只会提示，需到 Polygon 上手动删除（题面段落和样例标记可以清空）。
- tag 对应：`TL-OR-OK` ↔ `TO`；Polygon 没有 `FL`，推送时按 `RJ` 发送。
- 方法和参数按 [polygon-py](https://github.com/citxx/polygon-py)（与官方 API 文档一致）核对过，签名与其算法逐字节一致。自带的 mock（`pnpm --filter @polyforge/server mock-polygon`，在 `secrets.toml` 里设 `[polygon] api_url = "http://127.0.0.1:4700/api/"`）会校验签名，推送、拉取、导入都在它上面测过。**还没有在真实 Polygon 账号上跑过**，第一次建议用一道测试题试。

## 结构

```
packages/shared   类型、problem.toml schema（zod）、文件角色识别、tag 规则
packages/server   Fastify + WebSocket；global.ts（全局目录）、workspace/（题目、文件、watcher）、
                  judge/（runner、编译、script、测试生成、invocation、自测）、runner/runner.cpp、
                  polygon/（API 客户端、同步条目、推送 / 拉取 / 导入）、scripts/mock-polygon.ts
packages/web      Vue 3 + Naive UI + Monaco + vue-i18n + KaTeX
assets/           首次启动拷贝到全局目录的默认文件
```
