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

> **计数更新（2026-10-03，第六轮复核整改后）**：数字按**文件**给出，因为它们并不一致 —— 见"已知缺口"。
> 这一轮的主要变化不是数字，而是**验证能力**：Linux 从"只在 CI 上跑"变成"本机可复现"
> （`scripts/linux-check.sh`），因为 CI 首次运行的 8 个失败全在非 Windows 上，而 Windows 上一直是绿的。

| 平台 | Node | Python | unit | integration |
|---|---|---|---|---|
| Windows 11 x64 | 22.22.2 | 3.10.14（base anaconda：ipykernel 6.25.2 / jupyter_client 8.3.1 / pyzmq 25.1.1） | **251（250 passed + 1 skipped）**，20 文件 | **45/45**，6 文件全绿（`kernel.test.ts` / `run.test.ts` 自动回退到 base 解释器，见下） |
| Windows 11 x64 | 22.22.2 | 3.11.11（测试 venv，base conda env 内含 **pyzmq 26.2.0**） | 同上 | **该解释器无法启动 kernel**：sidecar 以 `0xC0000409`（`STATUS_STACK_BUFFER_OVERRUN`）退出，stderr 为 `Bad file descriptor (epoll.cpp:73)` |
| **WSL Ubuntu 22.04（本机实跑）** | **v22.22.0** | 3.x（无 ipykernel → U20 显式 skip） | **238 passed + 1 skipped**，20 文件 | 未在本机跑（需真实 kernel，见下） |
| ubuntu-latest | 22 / 24 | 3.10 / 3.12 | CI | CI（`pip install ipykernel jupyter_client`） |
| windows-latest | 22 / 24 | 3.x | CI | CI |
| macos-latest | **22 only** | — | CI | **不跑 integration**（见下） |

**其他实测项**：`pnpm lint` 0 警（63 文件 / 99 规则 + `scripts/check-format.mjs` + `scripts/check-indent.mjs`）；
`pnpm smoke` **19/19**；`npm pack --dry-run` 133 项，含 `lib/bin.js`（shebang ✓）与 `python/ipynb_sidecar.py`；
`git ls-files --eol` 全树 LF（0 CRLF / 0 mixed）。

> **macOS 在 unit 矩阵里只跑 Node 22。** macOS runner 按 10 倍计费，而这一层的目的是发现平台特有的路径/大小写语义，
> 与 Node 版本无关；SPEC §9 已把 macOS 排除出 integration，同一理由。若要排查 macOS 上的 Node 24 行为，先看 `.github/workflows/ci.yml` 的 `exclude`。
## 已知缺口

- **测试 venv 现在位于系统临时目录**（`%TEMP%\ipynb-mcp-test-venv` / `$TMPDIR/ipynb-mcp-test-venv`，可用 `IPYNB_TEST_VENV` 覆盖）。它此前建在 `tests/.venv-test`，即**工作树内部**：跑一次测试就在仓库里留下一个虚拟环境（v5 TST-5）。仓库里那份已删除；`.gitignore` 仍保留 `tests/.venv*/` 以防旧检出残留。
- **该 venv 继承的 pyzmq 26.2.0 无法启动 kernel。** 现象：sidecar 一收到 `start_kernel` 就以 `0xC0000409` 退出，Python 侧打印 `Bad file descriptor (zmq …/epoll.cpp:73)`；同一台机器上 pyzmq 25.1.1 的 base anaconda 解释器一切正常。这是**解释器环境**问题，不是 ipynb-mcp 的代码问题（`ping`、`analyze` 正常，`run/server/stale/locked-file` 四个集成文件全绿）。
  **处理方式**：把 `IPYNB_TEST_PYTHON` 指向 base anaconda 解释器即可让集成套件全绿；`tests/integration/kernel.test.ts` 与 `run.test.ts` 里直接用 transport 的用例，现在会在 `beforeAll` 里**真正起一次 kernel**做候选探测——venv 能起就用 venv，起不来就回退到 base 解释器（`kernel.test.ts` 会在 stderr 记录一行说明；走 `runNotebook` 的用例本就用 SPEC §5.2 候选链，不受影响）。因此集成套件在两种环境下都全绿，"环境坏了"不会被误读成"代码坏了"。真正的修复（给测试 venv 一个能用的 pyzmq）属环境操作，未执行。
- **`analyze-op.test.ts` 的 U20 用例在无 kernel 能力的环境下显式 skip**（记录原因：无解释器 / 无 ipykernel / pyzmq 起不了 socket），因此单测在无 Python / 无 ipykernel 的机器上仍然全绿（AGENTS §3 要求）；而"解释器自称能起 kernel 却起不来"（`start_kernel` 回归）会**失败**而不是 skip（TST-5，已用变异验证）。
- **macOS 仅通过 unit 层验证**（SPEC §9 CI 矩阵的既定决策：macOS 不跑 integration；其 kernel 生命周期语义与 Linux 一致，unit 层覆盖其平台特有分支——路径规范化、缓存目录、`.venv/bin/python`）。
- 集成测试在 vitest 下**按文件串行**（`fileParallelism: false`）：真实 kernel 的时序敏感用例（I16）在并行文件下不稳定，串行是准确性优先的取舍。
- **CI 已真跑**（2026-10-03，run `37130350485`）：10 个 job 里 8 个失败，全部在非 Windows 上。四类根因分别是平台假设写死在用例里（含一处**实现**按宿主规则判绝对路径）、探针与 sidecar 的真实依赖不一致、`I15` 用例自身的相位错误、以及 unhandled rejection。逐条修复见 `CHANGELOG.md` 与 `review-fix-status.md`，本机 Linux 复现由 `scripts/linux-check.sh` 承担。CI 上设 `IPYNB_TEST_REQUIRE_VENV=1`：解释器回退会直接失败，避免环境问题被"更绿"的表象掩盖（TST-1）。
- **`pnpm test` 的并行度保持 vitest 默认值**：`analyze-op.test.ts` 建的是**临时目录**里的 venv，六个用临时目录的文件互不共享状态，串行只会让单测慢一倍（v5 TST-5 的另一半，裁定为"不需要改"）。集成套件相反，仍按文件串行。


