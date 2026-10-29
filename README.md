# TaskWeave

<img src="assets/branding/taskweave.svg" width="80" height="80" align="right" alt="TaskWeave 图标" />

**本地优先的出题、数据编排与评测桌面工具。**

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/GetawayCar1024/taskweave)](https://github.com/GetawayCar1024/taskweave/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%20x64%20%7C%20Linux%20x64-lightgrey)

题面、程序和测试数据都保存在本地文件夹里。TaskWeave 在一个窗口中完成编写、生成数据、评测、对拍、比赛管理与 Polygon 双向同步，并能导出 Polygon package、LemonLime、Hydro、洛谷与 JOI / AtCoder 数据包及 OI 风格的 PDF；也可以让 AI 在独立副本中协助修改，再逐个文件审阅后接受。

[下载](https://github.com/GetawayCar1024/taskweave/releases/latest) · [使用指南](docs/guide.md) · [更新日志](CHANGELOG.md) · [问题反馈](https://github.com/GetawayCar1024/taskweave/issues)

## 功能一览

- **本地优先**：磁盘上的文件就是唯一的数据来源，可以用 Git 管理，也可以同时用 VS Code 等外部编辑器修改，界面会实时刷新并提示冲突。
- **编辑器**：Monaco 多标签编辑，按文件角色（题面 / validator / checker / 生成器 / 解法 / 测试）组织，编译错误直接标在代码上；题面实时预览，支持 Polygon TeX 与 Markdown 混写、KaTeX 公式和 `defs.toml` 宏。
- **测试与评测**：兼容 Polygon 的 `script.txt`（含 FreeMarker 子集）；生成输入、validator 校验、标程生成答案全部带缓存；批量评测可跨测试集任意选择测试点，按解法标签检查结论；快速运行、validator / checker 自测、对拍。
- **题型与计分**：传统题、I/O 交互题、grader 交互题；多测试集、子任务分值、捆绑与按点计分、传递依赖，每个子任务可指定单独的 validator。
- **Polygon 同步**：推送、拉取、三方合并、导入题目与比赛、提交与构建包；本地删除会同步删除远端对象，冲突不会被静默覆盖。
- **比赛**：一场比赛引用已有题目，整场生成测试、批量评测、检查、同步和导出；比赛文件工作区管理公告与注意事项。
- **文档与导出**：CF 风格的 PDF / HTML / Markdown / TeX；内置 [CNOI](https://github.com/Mr-Python-in-China/cnoi-statement-generator) 排版引擎生成 tuack 风格的 OI PDF，离线可用，无需安装 TeX；选手下发包 `down.zip`。
- **题面模式**：按语言选择整体 `statement.tex` 或 Polygon 分段文件，支持双向转换；整体题面同步 Polygon 时自动放入 `legend.tex` 并警告。
- **数据包交换**：ZIP、已解压目录和 Hydro FPS XML 中的每道题独立识别格式；LemonLime 比赛在比赛页整场导入；支持 Polygon、Hydro、洛谷与 JOI / AtCoder 工作流，导入前整批核对配置、实际文件与重名，修复说明可预览，额外文件和原配置保留。导入完成即扫描数据；单题及比赛可导出各平台题包。
- **文件管理**：题目／比赛支持与磁盘对应的嵌套文件夹，短名称在所在文件夹内唯一并与题目文件夹同步重命名；持久身份保留比赛引用与历史，回收站采用原盘移动。
- **兼容模式**：只有 `.in/.out` 或 `.in/.ans` 与分数配置也能管理样例、编排子任务和导出；可选择解法重造输出，保留唯一的初始备份并一键恢复。
- **评测包**：Polygon package、LemonLime（原生比较模式与等效本地实现、六种 Lemon checker 模板、Windows / Linux 目标及 g++ 编译脚本）、洛谷（数据、`config.yml`、处理捆绑与依赖的计分脚本）。
- **AI 辅助（可选）**：支持 Anthropic、OpenAI Chat Completions、OpenAI Responses 协议及兼容服务；AI 可读写文件、编译、生成测试和评测，改动经过审阅后应用。兼容模式支持文件／数据整理，转为完整造题保留会话；接受修改时保护编辑器草稿。
- **统一工作区与自动设置**：CF／OI 为文档样式选择，题库与比赛共同管理；设置修改自动应用并保存，设置编辑器持续保存，离开时等待写入完成。
- **中英文界面**，深色 / 浅色主题。

## 安装

提供 **Windows x64** 与 **Linux x64** 桌面版，使用发行版不需要 Node.js。

### Windows

1. 从 [Releases](https://github.com/GetawayCar1024/taskweave/releases/latest) 下载 `TaskWeave-<版本>-setup.exe`（安装版）或 `TaskWeave-<版本>-portable.exe`（免安装版）。
2. 安装 [MinGW-w64](https://www.mingw-w64.org/)（例如 [WinLibs](https://winlibs.com/) 或 MSYS2），把 `g++` 所在目录加入 `PATH`，在终端运行 `g++ --version` 确认。首次评测时会自动编译自带的 runner。
3. 可选：Python、Java、Kotlin、Rust、Go 等其他语言的编译器或解释器。

安装版会创建桌面和开始菜单快捷方式。全局目录为 `%USERPROFILE%\.taskweave`；升级自动迁移旧版配置、题库身份、密钥、会话与答案备份。

### Linux

1. 从 [Releases](https://github.com/GetawayCar1024/taskweave/releases/latest) 下载 `TaskWeave-<版本>-linux-x86_64.AppImage`（`chmod +x` 后直接运行）或 `TaskWeave-<版本>-linux-x64.tar.gz`（解压后运行 `taskweave`）。
2. 安装 g++（例如 `sudo apt install g++`）。运行环境需提供 GTK 3、NSS、GBM 和 ALSA；AppImage 需要 FUSE。
3. 可选：其他语言的编译器或解释器。

全局目录为 `~/.taskweave`。更多说明见 [Linux 版](docs/linux.md)。

## 快速上手

1. 打开 **设置**：在“题目根目录”中添加一个存放题目的文件夹；在“工具链检测”中点击“检测”，确认 g++ 可用；在“语言配置”中勾选需要的编程语言。
2. 回到首页 **新建题目**（传统题 / I/O 交互题 / Grader 交互题），模板会生成题面骨架、validator、随机生成器、标程和测试脚本。
3. 在右侧“信息”面板设置时限、内存、checker 和解法标签；编辑 `tests/script.txt` 或添加手写测试，然后 **生成测试**（`Ctrl+Shift+G`）。
4. 打开 **批量评测**，选择解法与测试点运行，检查每份解法的结论是否符合其标签。
5. 如需与 Polygon 同步：在“设置 → Polygon”填写 API key 与 secret，之后可以导入已有题目或比赛，或把本地题目推送为新题（`Ctrl+Shift+U`）。
6. 创建 **比赛**，加入题目后可以整场评测、导出 CF / OI 题面与评测包。

各功能的详细说明见 [使用指南](docs/guide.md)。

## 数据存放

| 位置 | 内容 |
| --- | --- |
| 题目根目录 | 每道题一个文件夹，`problem.toml` 记录题目信息，其余是题面、程序和测试（结构见[使用指南](docs/guide.md#题目文件夹)）。 |
| `%USERPROFILE%\.taskweave\`（Linux：`~/.taskweave/`） | 全局目录（用环境变量 `TASKWEAVE_HOME` 指定）：`config.toml`、`languages.toml`、`secrets.toml`（Polygon 与 AI 密钥）、共享的 testlib / checker / 宏、题目模板、默认比赛目录 `contests/`、回收站索引 `trash/`、可选的字体目录 `fonts/`。 |
| 题目中的 `.taskweave/` | 编译与测试缓存、评测记录、同步基线和 AI 会话；请用应用中的“清除缓存”清理。 |

密钥只保存在全局目录的 `secrets.toml` 中，不会写入题目文件夹，题目可以放心提交到 Git。

## 注意事项与限制

- 本地评测在 Windows 上使用 Job Object、在 Linux 上使用原生监督程序限制时间与内存（Linux 按常驻内存统计）；计时受系统粒度和负载影响，结果不保证与 Polygon 一致。本地编译通过也不代表 Polygon 的编译器一定通过。
- OI 排版所用的宋体、黑体、楷体版权不允许随应用分发，排版时读取本机字体（Windows 自带）。缺少时预览上方会提示，也可以把 `simsun.ttc`、`simhei.ttf`、`simkai.ttf` 放到全局目录的 `fonts/` 中；Linux 上只从该目录读取。
- Polygon API 不能新建或列出额外测试集，额外测试集需先在 Polygon 上创建；grader 题、以文件下发的大样例、子任务单独的 validator 等 Polygon 不支持的功能会在同步前提示。
- Polygon 同步、LemonLime 与洛谷导出主要通过模拟接口和本地检查验证，欢迎反馈实际使用中的问题。
- 启用 AI 时，请求会发送到你配置的服务，可能包含题面、程序、测试和工具输出；不配置 AI 不影响其他功能。

## 从源码构建

需要 Node.js 20+ 与 [pnpm](https://pnpm.io/)；本地评测需要 g++。在 Windows 上打包得到安装版与免安装版，在 Linux 上得到 AppImage 与 tar.gz（见 [docs/linux.md](docs/linux.md)）。

```bash
git clone https://github.com/GetawayCar1024/taskweave.git
cd taskweave
pnpm install --frozen-lockfile
pnpm dev            # 开发模式：API 在 127.0.0.1:4523，Vite 在 127.0.0.1:5173，打开终端打印的链接
```

```bash
pnpm typecheck      # 全部工作区的类型检查
pnpm test           # 自动回归测试（部分用例需要 g++）
pnpm build          # 构建前端
pnpm desktop:run    # 构建并运行 Electron 桌面版
pnpm desktop        # 构建当前系统的发行包（Windows 安装版／免安装版，Linux AppImage／tar.gz），输出到 packages/desktop/dist/
```

回归测试（使用临时数据目录，部分用例需要 g++）：

```bash
pnpm test
```

Polygon 与 AI 的模拟服务和集成脚本位于 `packages/server/scripts/`。更多构建细节见 [docs/building.md](docs/building.md)。

### 项目结构

```text
packages/desktop   Electron 主进程与桌面集成
packages/web       界面：Vue 3、Naive UI、Monaco、KaTeX；OI 排版（typst.ts + CNOI）
packages/server    本地服务：Fastify API、文件与题目管理、评测、Polygon 同步、AI
packages/shared    共享的数据类型、配置 schema、题面转换与检查规则
assets/            默认配置、题目模板、testlib、标准 checker 与宏
scripts/           桌面构建脚本
docs/              使用指南、设计文档、各版本说明与改动明细
```

服务只监听本机地址，每次启动生成随机 token 校验所有 API 请求。架构与早期设计见 [docs/design.md](docs/design.md)（可能包含尚未实现的规划）。

## 参与贡献

欢迎通过 [Issues](https://github.com/GetawayCar1024/taskweave/issues) 反馈问题或提出建议，反馈时请附上版本号、复现步骤，以及相关的题目配置或报错信息（注意去掉密钥）。提交 Pull Request 前请确保 `pnpm typecheck` 与相关回归测试通过，并保持与周围代码一致的风格；界面文字需要同时提供中文与英文。提交的代码将以与本项目相同的许可证发布。

## 许可证

TaskWeave 以 [GNU Affero General Public License v3.0 或更高版本](LICENSE)（AGPL-3.0-or-later）发布。

内置的第三方组件保留各自的许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：

- [CNOI Statement Generator](https://github.com/Mr-Python-in-China/cnoi-statement-generator)（AGPL-3.0）提供 OI 排版的编译模块与模板；
- [testlib](https://github.com/MikeMirzayanov/testlib) 与 [Testlib for Lemons](https://github.com/GitPinkRabbit/Testlib-for-Lemons)（MIT）；[LemonLime](https://github.com/Project-LemonLime/Project_LemonLime) 原生比较适配（GPL-3.0-or-later）；
- Fira Mono（SIL OFL 1.1）、Latin Modern 与 New Computer Modern（GUST Font License）字体；
- [typst.ts](https://github.com/Myriad-Dreamin/typst.ts)、Monaco Editor、KaTeX、Vue、Naive UI、Fastify 等开源依赖。

TaskWeave 与 Codeforces、Polygon、洛谷、LemonLime 均无关联，相关名称归各自所有者。
