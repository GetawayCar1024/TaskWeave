# 执行隔离与计分边界

本页说明从 0.4.6 起的安全行为和兼容性限制。0.4.5 及更早发行包不包含这里的执行隔离修复。

## 执行隔离

编译、运行解法、生成器、validator、checker、interactor，以及 AI 调用这些功能时，统一经过原生执行器。隔离准备失败会返回错误，**不会退回无隔离运行**。

| 项目 | Windows | Linux x64 |
| --- | --- | --- |
| 身份／文件系统 | 每次执行独立的 AppContainer；无外部运行时的单进程程序额外使用 LPAC。编译工具链和解释器使用兼容其子进程／系统 DLL 的 AppContainer，而非无隔离进程。 | bubblewrap 创建独立文件系统、PID、用户和 IPC 命名空间。 |
| 网络 | 不授予网络 capability，包括本机服务。 | 独立网络命名空间，seccomp 禁止创建 socket。 |
| 文件权限 | 程序及必要运行时只读；临时工作目录可写；测试数据按角色单独只读授权。 | 系统运行时和必要输入只读挂载；仅本次临时目录和明确的编译输出目录可写挂载。 |
| 子进程 | Job Object 限制数量，退出／取消时清理。 | seccomp 在单进程模式下禁止 fork；进程树监督与 PID 命名空间负责退出／取消清理。 |
| 环境变量 | 不继承宿主环境，只提供运行所需白名单变量。 | 同左。 |

解法与 interactor 的工作目录分开，解法不会因为共享临时目录而获得 interactor 的输入、参考答案或报告。编译器不能通过 `#include` 自动获得工作区外文件、私有缓存或测试答案。

Windows 在必要的文件上授予运行身份权限，执行后移除本次身份的 ACL。可信运行时安装目录保留只读 capability，以免每次递归更新整套工具链的权限；不会给 Everyone 或 ALL APPLICATION PACKAGES 新增权限。当前账户不能授权运行时目录时，需使用用户拥有的安装目录或由其管理员准备权限。不会自动提权。

编译结果先检查为普通独立文件，再由宿主保存。这样既拒绝链接型输出，也避免 Windows 的低完整性标签意外影响导出的可执行文件。读取生成输出、AI 读写和文件管理拒绝符号链接、junction 和硬链接，防止宿主替受限程序读取或修改其他文件。

### 环境要求

- Windows 10 或更新版本，使用支持 Win32 AppContainer 的系统和 g++ 工具链。
- Linux x64 需安装 `g++` 与 `bubblewrap`，并允许其创建非特权用户命名空间。例如：`sudo apt install g++ bubblewrap`。发行版的 AppArmor 限制应通过针对 bubblewrap 的系统策略处理；应用不会自动修改系统策略。
- Electron 渲染进程也保留 Chromium 沙箱。Linux 启动器不再自动添加 `--no-sandbox`；需要允许 Chromium 的用户命名空间，或正确安装可信的 `chrome-sandbox` 辅助程序。

本轮运行时专项覆盖 C++ 和 Python，不代表所有第三方语言、venv 或自定义编译脚本封装都已经验证。若其文件访问或启动方式超出授权范围，会明确失败，需要单独适配，不能通过关闭隔离解决。

### 不应误解的保证

这里不是可公开托管不可信用户的在线评测服务。应使用独立、低权限的系统账户，及时更新操作系统和工具链，不要以管理员／root 身份评测来源不明的程序。

时间、内存、输出和子进程监督不等于完整资源配额。尤其尚未提供整个可写目录的磁盘配额；不要在存有重要资料的生产环境运行刻意耗尽资源的程序。Windows AppContainer 和 Linux 运行时只读挂载也不是虚拟机，不防御操作系统内核漏洞。

AI 编辑工作副本与操作系统执行隔离是两回事：前者控制何时接受文件修改，后者限制所执行程序的权限。不能把“在副本中运行”当作安全沙箱。

## 部分分

自定义 Testlib checker 可在题目信息里指定 `quitp` 的单位：

- **比例（默认）**：`quitp(0.5)` 表示当前测试点满分的 50%。
- **绝对分数**：`quitp(7)` 表示 7 分。
- **百分比**：`quitp(50)` 表示 50%。
- **Hydro Testlib 兼容**：导入 Hydro 自定义 Testlib checker 时自动使用，遵循它将大于 1 的报告按百分比处理、逐点向下取整的规则；保留 `_pc` 报告不代表完全通过的状态。

`_pc(50)` 按 Testlib 的百分比报告解释。不能解释的 `quitpi(points_info)`、非数值或越界报告会报 FAIL，不会假装满分。历史评测记录中已保存的绝对 `points` 不会被重新解释；新记录另外保存比例。

捆绑子任务取成员实际得分的最小值，按点计分子任务求和。部分正确显示为 **PC**，不能满足“前置子任务完全通过”的依赖。

### 平台差异

- **洛谷**：`config.yml` 没有安装计分脚本的字段。导出包含整题 `score.txt` 和各 `score-subtask-<id>.txt`；上传后必须按生成的 README 分别粘贴。捆绑组中每点以组满分为上限，子任务脚本取最小值，整题脚本再处理依赖，避免丢失部分分。绝对分数 checker 缺少目标测试点满分参数，不能自动改成洛谷比例协议，会阻止导出。
- **Hydro**：min/sum、依赖和各层限制按原生配置输出。绝对分数／百分比 checker 在支持的 Testlib 子集内转为带满分参数的 Lemon 协议；不能安全转换时报错。平台的整数截断可能与本地浮点显示不同。
- **LemonLime**：自定义本地 checker 不能被默认比较器静默替换，必须选择对应 Lemon checker 或明确选择原生比较。转换支持的 `quitp` 单位；未支持的自定义报告要求人工转换。
- **Polygon**：包中的比例 checker 使用 `treat-points-from-checker-as-percent`。Polygon 的比例依赖会传播部分分，与本地“前置组必须完全通过”不同；这样的组合明确阻止转换。API 同步也不会假装支持它无法设置的 checker-percent 模式。
- **FPS、JOI／AtCoder 裸数据**：不存在统一、完整的判题配置。FPS 不保留子任务和 checker 规则；JOI 的 `taskweave.yaml` 是本工具的辅助文件，不是 AtCoder 自动加载的标准。

导出文件通过格式检查和本地回归，不等于已经在所有第三方平台实际上传验证；请用满分、部分分、错误解各一次核对目标平台的设置。

## 回归入口

```bash
pnpm --filter @taskweave/server exec tsx --test --test-concurrency=1 scripts/test-runner-isolation.ts scripts/test-workspace-isolation.ts scripts/test-checker-scoring.ts
pnpm --filter @taskweave/server exec tsx --test scripts/test-linux-runner.ts
```

参考：[Windows AppContainer](https://learn.microsoft.com/windows/win32/secauthz/appcontainer-isolation)、[bubblewrap](https://github.com/containers/bubblewrap)、[洛谷计分脚本](https://help.luogu.com.cn/manual/luogu/problem/scoring-script)、仓库内 [格式调研](research/package-formats.md)。
