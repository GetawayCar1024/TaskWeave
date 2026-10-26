# 更新日志

每个版本的使用说明位于 [docs/releases/](docs/releases/)，详细改动位于 [docs/changes/](docs/changes/)。下载见 [GitHub Releases](https://github.com/GetawayCar1024/polyforge/releases)。

## 0.3.2 — 2026-10-26

修复 Polygon 导入按钮的目录与凭据校验、比赛文件预览主题；比赛 notes 支持多语言。新增整体／分段题面转换、纯数据模式、洛谷 data.zip 导入导出、Hydro 整题与数据导入，以及单题文档、数据和下发包导出。外部包的额外文件与原始配置保留在“其他文件”中。

[发布说明](docs/releases/0.3.2.md) · [改动明细](docs/changes/0.3.2.md)

## 0.3.1 — 2026-10-25

开源发布（AGPL-3.0-or-later）。按最新 Polygon API 改进同步（远端删除、小数分值、冲突基线、其他测试集与样例拉取、比赛全部重新拉取）；新增洛谷导出、跨测试集批量评测、子任务独立 validator、OI 数据范围与样例解释、OI 目录页开关；统一工具窗口样式；OI 排版不再内置不可分发的中文字体，改为读取本机字体。

[发布说明](docs/releases/0.3.1.md) · [改动明细](docs/changes/0.3.1.md)

## 0.3.0 — 2026-10-18

OI 题面排版（CNOI）、Polygon TeX 与 Markdown 混写、grader 交互题、子任务分数／捆绑／依赖、LemonLime 评测包、选手下发包 down.zip、比赛文件工作区。安装包因内置不可分发的字体已从 Release 移除，请使用 0.3.1。

[发布说明](docs/releases/0.3.0.md) · [改动明细](docs/changes/0.3.0.md) · [发布检查](docs/releases/0.3.0-review.md)

## 0.2.3 — 2026-10-17

题面与比赛 Markdown 导出，编辑器、AI、比赛管理与批量评测改进，修复 Polygon 比赛导入与构建提示。

[发布说明](docs/releases/0.2.3.md) · [改动明细](docs/changes/0.2.3.md)

## 0.2.2 — 2026-10-11

界面打磨，题目与比赛页的 AI 改为可调整宽度的右侧栏，每份源码只保留一个 exe 缓存。

[发布说明](docs/releases/0.2.2.md)

## 0.2.1 — 2026-10-06

修复反馈的编辑器、评测、Polygon 同步与 AI 工作区问题。

[修复记录](docs/changes/0.2.1-issues.md)

## 0.2.0 — 2026-09-26

改为 Electron 桌面应用，替代浏览器版本。

## 0.1.0 – 0.1.2 — 2026-09

最初的浏览器版本：本地题目工作区、评测、测试生成、Polygon 同步与 AI 辅助。
