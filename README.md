# PolyForge

PolyForge 是面向 Codeforces Polygon 的本地造题桌面工具。题面、程序和测试数据保存在本地文件夹中，可以在同一个工作区完成编写、生成数据、评测、比赛管理和 Polygon 同步，也可以让 AI 协助修改文件，再逐项审阅改动。

[下载 0.2.3](https://github.com/GetawayCar1024/PolyForge/releases/tag/v0.2.3) · [更新说明](RELEASE_NOTES_0.2.3.md) · [修复明细](CHANGES_0.2.3.md) · [问题反馈](https://github.com/GetawayCar1024/PolyForge/issues)

## 安装与开始使用

目前提供 **Windows x64** 桌面版，本地评测使用 Windows runner。

1. 从 [Releases](https://github.com/GetawayCar1024/PolyForge/releases) 下载 `PolyForge-0.2.3-setup.exe` 安装，或直接运行免安装版 `PolyForge-0.2.3-portable.exe`。
2. 安装 MinGW-w64，将 `g++` 所在目录加入 `PATH`。可在终端运行 `g++ --version` 确认，再到应用设置中检测工具链。首次评测会自动编译 runner。
3. 在“设置 → 题目根目录”中添加一个存放题目的文件夹。
4. 新建题目，或配置 Polygon API 后导入已有题目、比赛。

使用发行版不需要另外安装 Node.js 或 pnpm。安装版会创建桌面和开始菜单快捷方式；免安装版默认仍将全局配置保存在用户目录中。

## 编写与验证一道题

每道题对应一个包含 `problem.toml` 的文件夹。左侧可以按文件角色或目录浏览，中间使用 Monaco 多标签编辑器，右侧提供“信息、测试、运行、自测、AI”面板。支持深浅主题、中英文界面、外部文件变更检测与冲突比较。

常用流程：

1. 在“信息”中设置标题、时间与空间限制、输入输出方式，以及 validator、checker 和解法角色。
2. 编写各语言题面、标程、数据生成器和校验器；在题面或题解区域右键可新增语言。
3. 添加手写测试，或用 `tests/script.txt` 编排生成器调用，再“生成测试”：运行生成器、校验输入、使用标程生成答案。
4. 批量评测多份解法，查看逐测试点的结论、耗时、分数与输入输出。支持选择测试集、子任务及部分测试点。
5. 使用快速运行、自测和对拍补充验证。对拍发现的反例可手动保存为测试。

同一份源码只保留一个 exe 编译缓存，修改源码或编译配置后替换；编译失败会清理失效 exe。默认评测并发为 1，批量评测在编译前显示测试表格，随后逐步更新结果。

切换文件会保留光标、选择区和滚动位置。diff 默认显示空白字符，并可选择是否忽略首尾空白差异。关闭程序时，会依次询问未保存文件；若 AI 仍在运行，还可选择取消退出或停止 AI 后关闭。

## 题面、题解与导出

题面使用 Polygon / Codeforces 的分段 LaTeX 格式，如 `statement/zh/legend.tex`、`input.tex`、`output.tex`、`notes.tex`；题解位于同语言目录下的 `tutorial.tex`。预览支持 Polygon LaTeX 子集、KaTeX 公式和 `defs.toml` 宏，修改任意已打开段落后完整题面同步更新。普通 `.tex` 和 `.md` 文件也可独立预览。

题面检查能提示常见格式问题，并在 diff 审阅后应用自动修复，例如 Markdown 粗体、列表、完整代码围栏及部分数学写法。样例默认来自测试输入和标程答案，也可以单独设置“题面输入 / 题面输出”，不影响实际评测数据。

| 导出方式 | 用途 |
| --- | --- |
| Markdown | 单题预览可导出当前题面或题解；比赛可导出整份题面或题解。正文清理多余空白，代码与样例保留原有空格和空行，复杂格式使用 HTML，含图片时打包为 ZIP。 |
| PDF | 比赛“题面与题解”页面通过打印对话框另存为 PDF，采用 A4 排版。长公式尝试在安全运算符处折行，必要时缩小。 |
| HTML | 比赛题面或题解导出为独立 HTML，保留排版并内嵌图片；公式字体通过 KaTeX CDN 加载。 |
| TeX | 比赛题面或题解导出为独立 TeX，展开 defs 宏；中文使用 ctex，需 XeLaTeX 编译。含图片时打包为 ZIP。 |
| Polygon package | 导出题目包或比赛包，包含题面、程序、测试、答案及相关配置。 |

比赛导出的“目录页”是题目总览表：题号、题目、输入、输出、时间限制、空间限制；题解目录只包含题号和题目。可通过开关关闭。Markdown 中比赛标题、题目标题及时空限制居中，目录里的题名可跳转到对应题目。

Markdown 的复杂排版需要阅读器支持 HTML、公式和 MathML，具体字体、间距与分页可能不同。复杂矩阵、嵌套环境等公式不保证自动折行，可手动使用 `aligned` 等结构。本版前端提供 Polygon / Codeforces 工作流，实验性的 OI 功能暂未开放。

## 比赛管理

比赛引用已有题目，不复制题目文件；同一道题可加入多场比赛。比赛默认存放在全局目录的 `contests/` 下，也可在设置中指定比赛目录。

- 新建比赛后可添加、移除或调整题目顺序，并通过“修改题号”窗口统一编辑编号。编辑过程中允许临时重复，保存时检查唯一性；检查结果跟随原题。
- 支持整场比赛生成测试、批量评测、本地检查、Polygon 同步，以及题面、题解和比赛包导出。
- 比赛 AI 从顶栏“AI”按钮打开，可在一次会话中处理多道题。进入比赛时默认收起侧栏，AI 和检查结果区域均可调整大小。
- 题目“更多”菜单可将题目移动到其他根目录，保留 ID、比赛引用与历史记录；移动前需保存文件并结束运行任务。

删除比赛不会删除引用的题目。删除题目会将文件夹移入全局目录的 `trash/`，关联比赛中会显示题目缺失。

## Polygon 同步

在“设置 → Polygon”中填写 API key 和 secret，再测试连接。题目可从 Polygon 导入，也可将本地题目绑定到已有 Polygon ID，或推送为新题。

- **推送**：选择变更条目，可附带 commit 和 Standard / Full 包构建。构建后检查远端状态，失败或无法确认时给出提示。部分条目失败时保留成功进度，便于重试。
- **拉取与合并**：比较本地、Polygon 和上次同步内容；双方都改动的文本可做三方合并，冲突在编辑器中处理。没有共同祖先时需选择保留哪一侧。
- **导入比赛**：可选择题目的存储目录。若部分题目导入失败，会列出原因且不创建缺题比赛；成功题目保留，重试可复用。

同步范围包括题目信息、各语言题面与题解、图片、程序、资源、测试脚本、手写测试、样例覆盖、分组及自测。部分限制来自 Polygon API：它不提供通用文件删除接口，也不能新建或枚举额外测试集；额外测试集需先在 Polygon 创建。

Polygon 同步、导入和构建失败已使用模拟接口验证，尚未连接真实账号实测。本地与远端编译器可能不同，例如 `__int128` 对架构的要求；本地编译成功不代表远端一定成功。

## AI 辅助

在“设置 → AI”中配置端点、API key 和模型。支持 Anthropic、OpenAI Chat Completions 与 OpenAI Responses 协议，可配置多个端点并查看用量；模型价格由用户填写，未配置时只统计 token。

题目页从右侧“AI”标签进入，比赛页使用顶栏“AI”按钮。AI 可读取和修改题目、编译运行、生成测试、评测、自测，或只读检查题面与程序。修改在独立工作副本中进行，完成后逐个文件查看 diff，再选择接受或放弃。AI 可删除语言目录，删除同样需要审阅改动。

会话与未发送草稿在切换面板时保留；停止任务后，已经收到的正文、思考内容和工具结果仍会保存。`scratch/` 用于 AI 的临时实验，跨轮保留，可单独清理，不进入接受改动列表。

本地编写和评测不依赖 AI 服务。启用 AI 后，请求会发送到所配置的端点，并可能包含题面、程序、测试及工具输出；真实模型的效果取决于模型与端点，协议测试使用模拟服务。

## 数据与配置

默认全局目录是 `%USERPROFILE%\.polyforge`，可通过环境变量 `POLYFORGE_HOME` 指定其他位置。

| 位置 | 内容 |
| --- | --- |
| `config.toml` | 题目根目录、界面、评测及其他应用设置。 |
| `languages.toml` | 语言、编译命令和运行命令。 |
| `secrets.toml` | Polygon 凭据和 AI 端点密钥。 |
| `shared/`、`templates/` | testlib、标准 checker、defs 宏和新建题目模板。 |
| `contests/` | 默认比赛目录，保存比赛配置和批量操作记录。 |
| `trash/` | 已删除题目的回收目录。 |
| 题目中的 `.polyforge/` | 编译与测试缓存、评测历史、同步基线和 AI 会话。 |

升级时已有的配置和共享模板不会被覆盖。已有用户如需 `ONLINE_JUDGE` 宏，应在自己的 C++ 编译命令中补上 `-DONLINE_JUDGE`；程序会自动附加 `-DFOR_LINUX`，让 testlib 按 LF 换行校验。

备份时建议同时保留题目根目录、比赛目录和全局配置。清理编译、评测缓存请使用应用中的“清除缓存”，避免直接删除包含同步状态和 AI 历史的整个 `.polyforge/`。密钥文件应单独妥善保存。

Windows CPU 计时受系统粒度影响，极短程序可能显示 0 ms；并行评测和其他系统负载仍会影响测量结果，耗时不保证与 Polygon 一致。

## 常用快捷键

以下快捷键用于桌面版，具体操作取决于当前页面或编辑器焦点。

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+S` | 保存当前文件。 |
| `Ctrl+P` | 快速打开文件。 |
| `Ctrl+W` / `Ctrl+Shift+T` | 关闭当前文件 / 重新打开刚关闭的文件。 |
| `Ctrl+Enter` | 快速运行当前程序。 |
| `Ctrl+Shift+G` | 生成测试。 |
| `Ctrl+Shift+U` | 打开 Polygon 同步。 |
| `Ctrl+Shift+L` | 题面检查。 |
| `Ctrl+K` / `Ctrl+/` | 命令面板 / 快捷键一览。 |
| `F11` | 切换全屏。 |

鼠标中键在弹起时关闭文件标签。正式发行版禁用 DevTools；开发环境可用 `F12` 或 `Ctrl+Shift+I` 打开或关闭。

## 从源码开发

需要 Node.js 20 或更高版本、pnpm；本地评测和 Windows 打包还需要 Windows 环境，评测需 g++。

```bash
git clone https://github.com/GetawayCar1024/PolyForge.git
cd PolyForge
pnpm install
pnpm dev
```

开发模式的 API 默认位于 `127.0.0.1:4523`，Vite 位于 `127.0.0.1:5173`。在浏览器中打开终端打印的链接；`Ctrl+W` 等快捷键在浏览器中可能由浏览器接管。

```bash
pnpm desktop:run  # 构建并运行 Electron 桌面版，不生成安装包
pnpm desktop      # 构建安装版和免安装版，输出至 packages/desktop/dist/
pnpm build        # 仅构建生产前端
pnpm typecheck    # 检查全部工作区的 TypeScript 类型
```

主要回归测试：

```bash
pnpm --filter @polyforge/server exec tsx --test scripts/test-regressions.ts scripts/test-october-fixes.ts scripts/test-problem-types.ts scripts/test-responses.ts
```

测试使用临时数据目录，其中真实编译、评测用例需要 g++。Polygon 和 AI 的模拟接口与集成脚本位于 `packages/server/scripts/`。服务仅监听本机地址，并使用启动时生成的 token 校验 API 请求。

## 项目结构

```text
packages/desktop  Electron 主进程与桌面集成
packages/web      Vue 3、Naive UI、Monaco、KaTeX 界面
packages/server   本地 API、文件管理、评测、Polygon 同步与 AI
packages/shared   数据类型、配置 schema、题面检查规则
assets/           默认配置、模板、testlib 与共享文件
scripts/          桌面构建脚本
```

架构与早期设计见 [DESIGN.md](DESIGN.md)，历史问题修复见 [FIXES.md](FIXES.md)，待发布改动见 [CHANGES_UNRELEASED.md](CHANGES_UNRELEASED.md)。设计文档可能包含尚未开放的功能，以当前界面和版本说明为准。
