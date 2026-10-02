# COMPATIBILITY — 实测过的客户端与版本矩阵

## 客户端矩阵

| 客户端 | 版本 | 状态 | 备注 |
|---|---|---|---|
| Claude Code | — | 未测试 | 计划 E8（手工端到端） |
| Cursor | — | 未测试 | 计划 E9（手工端到端） |
| VS Code | — | 未测试 | — |
| dsh | — | 未测试 | 计划 E7（经 `dsh-ipynb-mcp` bundle，本地就绪未发布） |

> 单元/集成测试使用的"MCP 客户端"为 `@modelcontextprotocol/sdk` 的 Client + InMemoryTransport（U24/I13/I16）与真实 stdio 子进程（I12）。

## 运行时矩阵（本地实测）

> **计数更新（2026-10-02，第二轮复核整改后）**：本表此前写 `148/148 ✅ | 26/26 ✅`，已过期两轮。
> 现在的数字按**文件**给出，因为它们并不一致 —— 见"已知缺口"。

| 平台 | Node | Python | unit | integration |
|---|---|---|---|---|
| Windows 11 x64 | 22.22.2 | 3.10.14（base anaconda：ipykernel 6.25.2 / jupyter_client 8.3.1 / pyzmq 25.1.1） | **214（213 passed + 1 skipped）** | 5 个文件全绿（`kernel.test.ts` 自动回退到 base 解释器，见下） |
| Windows 11 x64 | 22.22.2 | 3.11.11（测试 venv `tests/.venv-test`，base conda env 内含 **pyzmq 26.2.0**） | 同上 | **该解释器无法启动 kernel**：sidecar 以 `0xC0000409`（`STATUS_STACK_BUFFER_OVERRUN`）退出，stderr 为 `Bad file descriptor (epoll.cpp:73)` |
| ubuntu | 22 / 24 | 3.10 / 3.12 | CI | CI |
| macos | 22 / 24 | — | CI | **不跑 integration**（见下） |

## 已知缺口

- **本机 `tests/.venv-test` 继承的 pyzmq 26.2.0 无法启动 kernel。** 现象：sidecar 一收到 `start_kernel` 就以 `0xC0000409` 退出，Python 侧打印 `Bad file descriptor (zmq …/epoll.cpp:73)`；同一台机器上 pyzmq 25.1.1 的 base anaconda 解释器一切正常。这是**解释器环境**问题，不是 ipynb-mcp 的代码问题（`ping`、`analyze` 正常，`run/server/stale/locked-file` 四个集成文件全绿）。
  **处理方式**：`tests/integration/kernel.test.ts` 现在会在 `beforeAll` 里真正起一次 kernel 做候选择探测——venv 能起就用 venv，起不来就回退到 base 解释器并在 stderr 记录一行说明。因此该文件在两种环境下都是绿的，而"环境坏了"不会被误读成"代码坏了"。真正的修复（给测试 venv 一个能用的 pyzmq）属环境操作，未执行。
- **`analyze-op.test.ts` 的 U20 用例在无 kernel 能力的环境下显式 skip**（记录原因），因此单测在无 Python / 无 ipykernel 的机器上仍然全绿（AGENTS §3 要求）。
- **macOS 仅通过 unit 层验证**（SPEC §9 CI 矩阵的既定决策：macOS 不跑 integration；其 kernel 生命周期语义与 Linux 一致，unit 层覆盖其平台特有分支——路径规范化、缓存目录、`.venv/bin/python`）。
- 集成测试在 vitest 下**按文件串行**（`fileParallelism: false`）：真实 kernel 的时序敏感用例（I16）在并行文件下不稳定，串行是准确性优先的取舍。
- **CI 从未真跑**（仓库无 `git remote`）：`ci.yml` 的 12 个矩阵组合仍属纸面配置；已知 unit job 不装 ipykernel（U20 已按上面的方式 skip，不再是失败）、integration job 不跑 `pnpm test`。


