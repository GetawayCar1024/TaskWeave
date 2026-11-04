# TaskWeave Linux 版

从 0.4.2 起，发行版包含 Linux x64 桌面应用。构建与验证流程位于 [Linux CI](https://github.com/GetawayCar1024/TaskWeave/actions/workflows/linux-preview.yml)，使用 Ubuntu 22.04、Node.js 24 和系统 g++。

## 下载与运行

从 [Releases](https://github.com/GetawayCar1024/TaskWeave/releases/latest) 下载：

- `TaskWeave-<版本>-linux-x86_64.AppImage`
- `TaskWeave-<版本>-linux-x64.tar.gz`

`SHA256SUMS.txt` 列出全部发行附件的校验值。使用 AppImage：

```bash
chmod +x TaskWeave-*-linux-x86_64.AppImage
./TaskWeave-*-linux-x86_64.AppImage
```

tar.gz 解压后运行其中的 `taskweave`。运行环境需提供 GTK 3、NSS、GBM 和 ALSA；本地评测需要 g++ 与 bubblewrap（例如 `sudo apt install g++ bubblewrap`）。AppImage 需要 FUSE 2：Ubuntu 22.04 及以后默认没有，可运行 `sudo apt install libfuse2t64`（22.04 为 `libfuse2`），或者用 `./TaskWeave-*.AppImage --appimage-extract-and-run` 直接运行。

`taskweave` 是一个启动脚本：Chromium 沙箱需要 root 所有、带 setuid 的 `chrome-sandbox`，或者允许非特权用户命名空间；Ubuntu 23.10 起用 AppArmor 限制后者。从 0.4.6 起，两者都不满足时脚本给出错误，不再自动添加 `--no-sandbox`。在可信 tar.gz 发行包中可由管理员执行 `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`；bubblewrap 仍需要可用的用户命名空间权限。

全局目录为 `~/.taskweave`，可用 `TASKWEAVE_HOME` 指定。OI 排版所需的宋体、黑体、楷体不随应用分发：Linux 上先找 `~/.taskweave/fonts/` 和系统字体目录中的 `simsun.ttc`、`simhei.ttf`、`simkai.ttf`；缺少时自动改用已安装的中文字体（Noto CJK、思源、文泉驿、AR PL 等，Ubuntu 桌面版通常已带 Noto CJK，否则 `sudo apt install fonts-noto-cjk`），文字完整，字形与 NOI 官方题面略有不同。

## 从源码构建

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter @taskweave/server exec tsx --test scripts/test-linux-runner.ts
pnpm build
node scripts/build-desktop.mjs --linux
```

产物位于 `packages/desktop/dist/`。`--dir` 仅构建可直接运行的应用目录。CI 使用 Xvfb 启动打包后的 Electron，实际生成测试、整场导入 LemonLime 比赛、导出 Lemon／FPS 并恢复初始答案；通过后上传 `TaskWeave-linux-x64`（AppImage、tar.gz、对应源码与 `SHA256SUMS.txt`），发行版使用其中的 Linux 包。

## 评测内核

- Linux 使用独立 C++ supervisor、`fork/execvp` 和双向管道；参数直接传给程序，不经 shell。
- CPU 与常驻内存从进程树读取，每 5 ms 检查预算；退出时补充 `wait4` 资源统计。CPU 秒级后备限制及普通文件输出上限由 `rlimit` 执行。
- 内存采用 RSS，和 Windows 的提交内存统计口径不同。取消、超限或根进程退出时终止其进程组与已跟踪的后代，回收退出进程。
- 沿用旧语言配置时，会在 Linux 编译阶段移除 PE 链接器专用的 `--stack` 参数；运行时把默认栈上限提升至 256 MiB（受系统硬上限约束），内存预算仍按 RSS 独立执行。
- 默认允许一个进程，支持单独配置多进程预算；交互题为解法和 interactor 分别计量。
- 从 0.4.6 起，在独立 bubblewrap 命名空间中启动每个程序，按角色只读挂载必要文件，工作目录单独可写，清理宿主环境，禁止网络和危险系统调用。隔离不可用时报错，不降级运行；见 [安全与计分边界](security.md)。0.4.5 及之前的发行包不包含这一改动。

## 名称与数据迁移

显示名称统一为 **TaskWeave**；工作区包名为 `@taskweave/*`，API、桌面 IPC、新题包扩展及隐藏状态目录统一使用 `taskweave`。

升级读取器会迁移旧默认配置目录、题目／比赛状态与回收站。持久身份、会话、初始答案、密钥字节和编译源文件继续保留；遇到已有的新旧状态冲突时保留双方并报告路径。旧题包仍可读取，新包使用统一命名。旧拼写只集中在迁移常量中，用于识别升级来源。
