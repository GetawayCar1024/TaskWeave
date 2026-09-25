# PolyForge

本地优先的 Polygon 造题平台。设计见 [DESIGN.md](DESIGN.md)。当前完成 **M1 本地核心**。

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

## M1 包含

- 题目列表（完成度徽标）、新建题目（按模板生成骨架）
- 文件树（按角色 / 按目录）、右键菜单（新建、重命名、删除、设为 validator/checker/interactor、设为解并改 tag、注册 generator、std checker“复制到本题”）
- Monaco 多标签编辑，`Ctrl+S` 保存（先写临时文件再 rename），`Ctrl+P` 快速打开
- 文件监听：外部编辑器修改后实时刷新；有未保存修改时提示冲突并显示 diff
- 题目信息面板（标题、时限、空间、checker/validator 选择、解的 tag）
- 中 / 英界面切换，记忆在 `config.toml`
- 设置：题目根目录、编辑器偏好、`languages.toml` 编辑、工具链检测（g++ 会带 testlib.h 试编译）
- 安全：只绑定 127.0.0.1、每次启动随机 token、校验 Host、路径穿越防护

## 结构

```
packages/shared   类型、problem.toml schema（zod）、文件角色识别
packages/server   Fastify + WebSocket；global.ts（全局目录）、workspace/（题目、文件、watcher）
packages/web      Vue 3 + Naive UI + Monaco + vue-i18n
assets/           首次启动拷贝到全局目录的默认文件
```
