# TaskWeave Linux 试制版

当前开发版本为 **0.4.2-dev**。Linux x64 试制流程位于 [Linux preview CI](https://github.com/GetawayCar1024/TaskWeave/actions/workflows/linux-preview.yml)，使用 Ubuntu 22.04、Node.js 24 和系统 g++。

## 产物

CI 在原生运行测试、完整回归和打包应用验证通过后，上传 `TaskWeave-linux-x64`：

- `TaskWeave-<版本>-linux-x86_64.AppImage`
- `TaskWeave-<版本>-linux-x64.tar.gz`
- `TaskWeave-<版本>-source.zip`，与该次 CI 提交逐文件对应
- `SHA256SUMS.txt`

使用 AppImage：

```bash
chmod +x TaskWeave-*-linux-x86_64.AppImage
./TaskWeave-*-linux-x86_64.AppImage
```

tar.gz 解压后运行其中的 `taskweave`。运行环境需提供 GTK 3、NSS、GBM 和 ALSA；本地评测需要 g++。AppImage 使用系统 FUSE；无 FUSE 环境可用其 `--appimage-extract` 功能解压后运行 `AppRun`。

## 从源码构建

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter @taskweave/server exec tsx --test scripts/test-linux-runner.ts
pnpm build
node scripts/build-desktop.mjs --linux
```

产物位于 `packages/desktop/dist/`。`--dir` 仅构建可直接运行的应用目录。CI 使用 Xvfb 启动打包后的 Electron，实际生成测试、导入 CDF、导出 Lemon/FPS 并恢复初始答案。

## 评测内核

- Linux 使用独立 C++ supervisor、`fork/execvp` 和双向管道；参数直接传给程序，不经 shell。
- CPU 与常驻内存从进程树读取，每 5 ms 检查预算；退出时补充 `wait4` 资源统计。CPU 秒级后备限制及普通文件输出上限由 `rlimit` 执行。
- 内存采用 RSS，和 Windows 的提交内存统计口径不同。取消、超限或根进程退出时终止其进程组与已跟踪的后代，回收退出进程。
- 沿用旧语言配置时，会在 Linux 编译阶段移除 PE 链接器专用的 `--stack` 参数；运行时把默认栈上限提升至 256 MiB（受系统硬上限约束），内存预算仍按 RSS 独立执行。
- 默认允许一个进程，支持单独配置多进程预算；交互题为解法和 interactor 分别计量。
- 当前机制用于本地运行和资源监督，不提供文件系统／网络隔离。

## 名称与数据迁移

显示名称统一为 **TaskWeave**；工作区包名为 `@taskweave/*`，API、桌面 IPC、新题包扩展及隐藏状态目录统一使用 `taskweave`。

升级读取器会迁移旧默认配置目录、题目／比赛状态与回收站。持久身份、会话、初始答案、密钥字节和编译源文件继续保留；遇到已有的新旧状态冲突时保留双方并报告路径。旧题包仍可读取，新包使用统一命名。旧拼写只集中在迁移常量中，用于识别升级来源。
