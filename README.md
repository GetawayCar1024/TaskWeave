# PolyForge

PolyForge 是面向 Codeforces Polygon 的本地造题桌面工具。题面、程序和测试数据保存在本地文件夹中，可以在同一个工作区完成编写、生成数据、评测、比赛管理和 Polygon 同步，也可以让 AI 协助修改文件，再逐项审阅改动。

[下载 0.3.0](https://github.com/GetawayCar1024/PolyForge/releases/tag/v0.3.0) · [更新说明](RELEASE_NOTES_0.3.0.md) · [改动明细](CHANGES_0.3.0.md) · [问题反馈](https://github.com/GetawayCar1024/PolyForge/issues)

0.3.0 增加 OI 排版、grader、LemonLime 评测包和选手下发包；Release 同时提供完整对应源码与构建说明。

## 安装与开始使用

目前提供 **Windows x64** 桌面版，本地评测使用 Windows runner。

1. 从 [Releases](https://github.com/GetawayCar1024/PolyForge/releases) 下载 `PolyForge-0.3.0-setup.exe` 安装，或直接运行免安装版 `PolyForge-0.3.0-portable.exe`。
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

### OI 子任务与 grader 交互题

新建题目时可选择“传统题 / I/O 交互题 / Grader 交互题”，已有题目可在“信息”中修改。Grader 题将选手 C++ 函数实现与提供 `main` 的 grader 一起编译；在信息页选择 grader 源文件及下发头文件。新建时包含加法示例。标程生成答案、快速运行、批量评测与对拍均使用这套链接方式；grader 和头文件的改动会使同一 exe 缓存失效。

在“测试 → 测试集与子任务”中启用分值，设置每个子任务的测试点、分数、捆绑或按测试点计分，以及前置依赖。捆绑子任务须全部通过才得分；依赖及其前置依赖须全部通过，与列表排列顺序无关。循环依赖、重复分组、非法测试编号和负分会被拒绝。

Polygon 支持整数分值的分组、捆绑及依赖。Grader 题不能连接或同步 Polygon；小数子任务分值、仅下发文件的大样例也会在同步预览中警告并阻止不兼容的推送。

## 题面、题解与导出

题面使用 Polygon / Codeforces 的分段文件，如 `statement/zh/legend.tex`、`input.tex`、`output.tex`、`notes.tex`；题解位于同语言目录下的 `tutorial.tex`。同一个题面文件可混写 Polygon TeX 与 Markdown：标题、粗斜体、列表、表格、代码围栏、链接和本地图片会在内存中转换为 TeX 再预览，不修改文件。原有 TeX 命令、公式、注释和 verbatim 内容优先按 TeX 处理，继续支持 KaTeX 与 `defs.toml` 宏。修改任意已打开段落后，完整题面同步更新。

例如，`**答案为 $n$**` 与 `\textbf{答案为 $n$}` 都可使用；以 `> ` 开头的段落渲染为引用框，`~~文字~~` 显示删除线。行内代码与代码围栏里的 TeX、公式和 Markdown 标记保持字面内容。图片路径相对于 `statement/images/`。普通 `.tex` 和 `.md` 文件也可独立预览。

题面检查能提示常见格式问题，并在 diff 审阅后应用自动修复，例如部分数学写法、括号与排版问题。合法的 Markdown 不再被标记为必须转换的错误，也不会被自动改写成 TeX。样例默认来自测试输入和标程答案，也可以单独设置“题面输入 / 题面输出”，不影响实际评测数据。

| 导出方式 | 用途 |
| --- | --- |
| Markdown | 单题预览可导出当前题面或题解；比赛可导出整份题面或题解。正文清理多余空白，代码与样例保留原有空格和空行，复杂格式使用 HTML，含图片时打包为 ZIP。 |
| PDF | 比赛“题面与题解”页面可选 CF / OI。CF 通过打印对话框另存为 PDF；OI 自动显示排版预览，再下载使用同一套排版的 PDF。 |
| HTML | 比赛题面或题解导出为独立 HTML，保留排版并内嵌图片；公式字体通过 KaTeX CDN 加载。 |
| TeX | 比赛题面或题解导出为独立 TeX，展开 defs 宏；中文使用 ctex，需 XeLaTeX 编译。含图片时打包为 ZIP。 |
| Polygon package | 导出题目包或比赛包，包含题面、程序、测试、答案及相关配置。 |
| LemonLime | 比赛页“导出比赛包”中选择；ZIP 包含配置好的 `.cdf`、`data/` 及空的 `source/`。 |
| down.zip | 比赛页直接导出，或从 OI 预览导出。包含整场 OI PDF 和每题的全部样例文件。 |

比赛导出的“目录页”是题目总览表：题号、题目、输入、输出、时间限制、空间限制；题解目录只包含题号和题目。可通过开关关闭。Markdown 中比赛标题、题目标题及时空限制居中，目录里的题名可跳转到对应题目。

Markdown 的复杂排版需要阅读器支持 HTML、公式和 MathML，具体字体、间距与分页可能不同。复杂矩阵、嵌套环境等公式不保证自动折行，可手动使用 `aligned` 等结构。OI 是比赛文档的导出样式，不改变题目类型或 Polygon 同步方式。

### 大样例与下发包

在测试列表中选中一个样例，关闭“在题面中展示”即可标记为大样例。题目预览及比赛题面将显示“样例 2 见选手目录下的 …”文件提示；小样例继续显示输入输出。全部样例按原测试编号升序连续编号。

“导出 down.zip”会先生成数据并刷新 OI 预览，再打包同一份 PDF。包内是 `statement.pdf` 和按题目英文名命名的目录，例如题目 `trip` 的样例为 `trip/trip1.in`、`trip/trip1.out`、`trip/trip2.in`、`trip/trip2.out`，小样例也包含在内。设置过题面输入／输出覆盖时，下发同一份覆盖文件；大样例不截断。正式测试、标程和 grader 不进入下发包。比赛中题目的英文名须唯一；题面或样例在预览后发生修改时，需重新导出。

### LemonLime 统一评测

比赛页“导出比赛包 → LemonLime”导出默认 `tests` 测试集，自动生成输入与答案，设置时空限制、标准流／文件输入输出、checker、子任务分数、捆绑及依赖。没有分值配置的传统测试按总分 100 分分配；启用子任务时须配置整数分值并覆盖全部测试。导出会按依赖顺序排列 LemonLime 子任务，按点计分的组拆成单点子任务。任一题失败时不生成残缺的 ZIP。

在题目“信息 → Lemon 检查器”中单独选择源码，对应 `problem.toml` 的 `[lemon_checker] source = "lemon-checker.cpp"`。普通 checker 仍用于本地评测及 Polygon。Lemon checker 使用内置的 [Testlib for Lemons](assets/shared/lemon/README.md)：包含 `"lemon/testlib.h"`，用 `registerLemonChecker(argc, argv)` 初始化。需要按比例给部分分时，先设置 `quitpRelativeScoring = true` 再调用 `quitp`。导出前检查所有题的配置和编译结果；生成数据后以首个测试的标准答案验证评分文件及满分结果，普通 testlib 协议不能冒充 Lemon checker。

也可以点击“从普通检查器转换”：支持标准 checker 和本地 C++ checker，将直接引用的 `testlib.h` 改为 `lemon/testlib.h`，将单个 `registerTestlibCmd(argc, argv)` 调用改为 `registerLemonChecker(argc, argv)`；简单 `quitp` 保留按比例计分。新文件自动设为 Lemon checker，原源码和普通 checker 配置不变；同名文件存在时另建编号副本。复杂计分接口、宏封装或无法识别的初始化调用需手动处理。转换后可直接查看源码，导出时仍执行编译和评分协议检查。

解压后用 LemonLime 打开 `.cdf`，数据目录为 `data/题目英文名/`（例如 `data/trip/`），将提交放入 `source/选手名/题目英文名/题目英文名.cpp`。支持传统题和 grader 题（LemonLime Communication 模式）；I/O 管道交互题暂不支持。Grader 使用声明的源文件和头文件，文件名须不冲突、引入头文件时不含子目录。检查器导出为当前系统的原生程序，使用 Lemon Special Judge 模式，附源码及所引用的本地／共享头文件；跨系统时从 `checker-sources/problem/` 的源码重新编译，并将 `checker-sources/shared/` 加入头文件搜索路径。在 LemonLime 配置编译器；导出会匹配常用的 g++ 标准／优化配置，不存在时 LemonLime 回退为默认配置。

### OI 常用术语宏

内置 [shared/oi/defs.toml](assets/shared/oi/defs.toml)，自动与原有 `defs.toml` 一起用于题面预览、PDF、Markdown、TeX 和 AI 题面读取。中文、英文题面使用对应语言的描述。左侧资源列表可打开 `oi/defs.toml (shared)` 查看全部定义；如需修改，在全局目录的 `shared/oi/defs.toml` 中编辑，升级不会覆盖已有文件。默认同步／打包的 `defs.toml` 也包含这些宏；若题目自备 `files/defs.toml`，需自行加入所用宏的定义。

| 用法 | 中文效果 |
| --- | --- |
| `\OIInputFile[trip.in]` | 从文件 trip.in 中读入数据。 |
| `\OIOutputFile[trip.out]` | 将答案输出到文件 trip.out 中。 |
| `\OIStandardInput` / `\OIStandardOutput` | 标准输入／标准输出说明。 |
| `\OIConstraints{1 \le n \le 10^5}` | 对于所有测试数据，保证给定范围。 |
| `\OIPartialConstraints[30]{n \le 100}` | 对于 30% 的测试数据，保证给定范围。 |
| `\OISubtask[1][30]{n \le 100}` | 子任务 1（30 分）的数据范围。 |
| `\OIBundledScoring` / `\OISubtaskDependency[2][1]` | 子任务捆绑／依赖计分说明。 |
| `\OILargeSample[2][trip]` | 样例 2 的 trip/trip2.in、trip/trip2.out 文件提示。 |
| `\OIIntegerOutput` | 输出一行一个整数，表示答案。 |
| `\OIGraderInterface{solve}[grader.h]` | 实现函数、包含头文件及不定义 main 的说明。 |

宏仅生成题面文字，不会修改文件输入输出或子任务评测配置；请确保文字与“信息”“测试集与子任务”中的设置一致。

### 比赛文件与 OI 排版

比赛页的“比赛文件”打开三栏工作区：左侧文件列表，中间编辑器／预览，右侧比赛信息、整场文档生成及当前文件语言。支持新建文本文件、上传、编辑、预览和下载公告等资料。文件修改受未保存提醒和保存冲突检查保护。比赛 AI 可以通过 `files/文件名` 访问这些资料，修改仍需在 AI 面板中审阅并接受。

- `files/notes.tex` 默认为空；非空时在目录表下显示“注意事项”，CF 的 PDF、HTML、Markdown 和 TeX 导出都会带上它。关闭 CF 目录页时也隐藏注意事项。
- 编辑 `notes.tex` 时可点击“插入 CNOI 注意事项模板”，填入参考项目 CSP-S 2024 示例中的条目，选择 `en` 可插入英文版。请按实际比赛调整机器配置、编译环境和提交规则；插入不会自动保存。
- “生成整场题面 / 题解”分别只允许选择所有题目都有非空题面／题解的语言；没有共有语言时不可生成，后端也会校验。按比赛顺序拼接内容，将可编辑快照和本地图片保存到 `files/` 下的新目录。重复生成使用新目录，原题文件和旧快照不受影响。生成文件携带语言标记，宏始终按该文件语言展开；旧文件从生成目录名识别语言。普通公告和 notes.tex 可独立选择预览语言。
- 比赛预览选择 **OI** 后自动显示页面，修改场次、起止时间和编译选项会自动更新，再通过“导出”选择 PDF 或 Markdown。封面、总览表、注意事项、正文、代码框、字体及页眉页脚使用 [cnoi-statement-generator](https://github.com/Mr-Python-in-China/cnoi-statement-generator) 的编译模块与模板，并适配英文文案和脚注首行对齐。字体、WASM 和公式依赖随应用内置，首次预览也能离线使用，无需安装 TeX。排版标签跟随题面语言，操作控件跟随界面语言。

OI 通过内容适配层将现有 Polygon TeX / Markdown 题面送入上游 Markdown → Typst 流程。无法识别的 TeX 和合并单元格会明确报错；上游对于代码块过长单词等限制仍然适用。OI 支持 PDF 和 Markdown：Markdown 复用 CF 的导出器，包含 OI 总览表、注意事项和正文，图片打包为 ZIP，复杂格式使用 HTML。CF 预览继续提供 HTML 和 TeX 导出。

内置上游版本固定为 `43d437ba80d2cd42e04344d59928cfa23fdeb569`，采用 AGPL-3.0。源码位置、许可证及再分发要求见 [第三方说明](packages/web/src/vendor/cnoi/UPSTREAM.md)；发布包含此组件的发行版时需履行对应的源码与许可证义务。

混合题面的 PDF 和 HTML 沿用预览结果。独立 TeX 导出使用对应的 LaTeX 命令，并为引用框、删除线和分隔线附带环境定义及所需宏包；引用框使用可跨页的 `framed` / `leftbar` 环境，删除线使用 `ulem`，链接使用 `hyperref`。Markdown 导出中的普通粗体公式保留为 `**文字 $公式$**`。

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

混合题面在推送和导出 Polygon package 时转换为 TeX，本地源文件保持原样。引用框、删除线、分隔线等 Polygon 不支持的排版会在同步预览中显示文件、行号与警告；继续同步时保留文字并降级为普通内容，不上传 PolyForge 专用环境。比赛同步同样显示这些警告。同步 diff 和共同基线使用转换后的内容，避免反复报告同一份 Markdown 有未同步改动。

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
pnpm --filter @polyforge/server exec tsx --test scripts/test-regressions.ts scripts/test-october-fixes.ts scripts/test-problem-types.ts scripts/test-responses.ts scripts/test-statement-markup.ts
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
