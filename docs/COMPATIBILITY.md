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

| 平台 | Node | Python | unit | integration |
|---|---|---|---|---|
| Windows 11 x64 | 22.22.2 | 3.11.11（ipykernel 6.29.5 / jupyter_client 8.6.3，测试专用 venv `tests/.venv-test`，base 为 conda env `yolo`） | 148/148 ✅ | 26/26 ✅ |
| ubuntu | 22 / 24 | 3.10 / 3.12 | CI | CI |
| macos | 22 / 24 | — | CI | **不跑 integration**（见下） |

## 已知缺口

- **macOS 仅通过 unit 层验证**（SPEC §9 CI 矩阵的既定决策：macOS 不跑 integration；其 kernel 生命周期语义与 Linux 一致，unit 层覆盖其平台特有分支——路径规范化、缓存目录、`.venv/bin/python`）。
- 集成测试在 vitest 下**按文件串行**（`fileParallelism: false`）：真实 kernel 的时序敏感用例（I16）在并行文件下不稳定，串行是准确性优先的取舍。
