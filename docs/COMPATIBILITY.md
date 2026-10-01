# COMPATIBILITY — 实测过的客户端与版本矩阵

> 发布前更新（SPEC §8 发布规则 5）。当前为骨架，随实现进度逐步补齐。

## 客户端矩阵

| 客户端 | 版本 | 状态 | 备注 |
|---|---|---|---|
| Claude Code | — | 未测试 | 计划 E8 |
| Cursor | — | 未测试 | 计划 E9 |
| VS Code | — | 未测试 | — |
| dsh | — | 未测试 | 计划 E7（经 `dsh-ipynb-mcp` bundle） |

## 运行时矩阵（本地实测）

| 平台 | Node | Python | unit | integration |
|---|---|---|---|---|
| Windows 11 x64 | 22.22.2 | 3.11.11（测试专用 venv，ipykernel 6.29.5） | 待测 | 待测 |
| ubuntu | 22 / 24 | 3.10 / 3.12 | CI | CI |
| macos | 22 / 24 | — | CI | **不跑 integration**（见下） |

## 已知缺口

- **macOS 仅通过 unit 层验证**（SPEC §9 CI 矩阵的既定决策：macOS 不跑 integration；其 kernel 生命周期语义与 Linux 一致，unit 层覆盖其平台特有分支——路径规范化、缓存目录、`.venv/bin/python`）。
