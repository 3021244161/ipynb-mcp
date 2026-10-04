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

> **计数更新（2026-10-04，第九轮复核整改后）**：数字按**文件**给出，因为它们并不一致 —— 见"已知缺口"。
> 第六轮的主要变化是**验证能力**：Linux 从"只在 CI 上跑"变成"本机可复现"（`scripts/linux-check.sh`），
> 因为 CI 首次运行的 8 个失败全在非 Windows 上，而 Windows 上一直是绿的。
> 第七轮补上了另一半：**CI 现在真的装 `nbformat`**（外部权威）并设 `IPYNB_REQUIRE_NBFORMAT=1`，
> 此前那两条"用外部权威校验产物"的断言被 `if` 挡着，在唯一会自动运行的环境里从未执行。
> 第九轮给 `pnpm lint` 加了文档不变量检查（`scripts/check-docs.mjs`），并把连接文件清扫的检查器
> `scripts/check-connection-sweep.py` 接进 CI 的 integration job（`pnpm check:package` 与 `pnpm smoke` 从第八轮起就在那里）。
> 因此本表的数字按**最近一次本机实跑**给出，单位是"通过数 / 文件数"。

| 平台 | Node | Python | unit | integration |
|---|---|---|---|---|
| Windows 11 x64 | 22.22.2 | 3.10.14（base anaconda：ipykernel 6.25.2 / jupyter_client 8.3.1 / pyzmq 25.1.1） | **596（全绿）**，30 文件 | **73/73**，11 文件全绿（第十二轮本机实跑；新增 `v12-run-image-warnings.test.ts`。`kernel.test.ts` / `run.test.ts` 自动回退到 base 解释器，见下） |
| Windows 11 x64 | 22.22.2 | 3.11.11（测试 venv，base conda env 内含 **pyzmq 26.2.0**） | 同上 | **该解释器无法启动 kernel**：sidecar 以 `0xC0000409`（`STATUS_STACK_BUFFER_OVERRUN`）退出，stderr 为 `Bad file descriptor (epoll.cpp:73)` |
| **WSL Ubuntu 22.04（本机实跑）** | **v22.22.0** | 3.x（无 ipykernel → U20 显式 skip） | **381（全绿）**，25 文件 —— 第八轮实测（**第十至十二轮均未在 WSL 复跑单测**，新增用例只在 Windows 跑过）；**第十一轮与第十二轮均未在 WSL 复跑单测**，只在 WSL 复跑了 `scripts/linux-check.sh --selftest`（**cases=26 failed=0**，`prefix-only` 变异 4 条转红） | 未在本机跑（需真实 kernel，见下） |
| ubuntu-latest | 22 / 24 | 3.10 / 3.12 | CI | CI（`pip install ipykernel jupyter_client nbformat` + `IPYNB_REQUIRE_NBFORMAT=1`） |
| windows-latest | 22 / 24 | 3.x | CI | CI |
| macos-latest | **22 only** | — | CI | **不跑 integration**（见下） |

**其他实测项（第十二轮本机实跑）**：`pnpm typecheck` exit 0；`pnpm lint` 0 警（oxlint **78 文件 / 99 规则** + `scripts/check-format.mjs` + `scripts/check-indent.mjs`（**28 个自测样本**）+ `scripts/check-docs.mjs`（**17 个自测变异**，真文档对照通过；变异源由当前文本推导，合法修订不会误报；另有条目**指纹**与状态表 ✅ 的**可 grep 产物**两条机械门禁））；
`pnpm smoke` **26/26**（真 stdio server + 真 SDK 客户端，含 `data:` URL 图片的读写与 `nbformat.validate`）；
`pnpm check:package` **ok（140 文件，22 个变异全被抓到）**；`npm pack --dry-run` **140 项**，含 `lib/bin.js`（shebang ✓）与 `python/ipynb_sidecar.py`；
`git ls-files --eol` 全树 LF（110 个 tracked 文件，0 CRLF / 0 mixed）。

> **macOS 在 unit 矩阵里只跑 Node 22。** macOS runner 按 10 倍计费，而这一层的目的是发现平台特有的路径/大小写语义，
> 与 Node 版本无关；SPEC §9 已把 macOS 排除出 integration，同一理由。若要排查 macOS 上的 Node 24 行为，先看 `.github/workflows/ci.yml` 的 `exclude`。
## 已知缺口

- **测试 venv 现在位于系统临时目录**（`%TEMP%\ipynb-mcp-test-venv` / `$TMPDIR/ipynb-mcp-test-venv`，可用 `IPYNB_TEST_VENV` 覆盖）。它此前建在 `tests/.venv-test`，即**工作树内部**：跑一次测试就在仓库里留下一个虚拟环境（v5 TST-5）。仓库里那份已删除；`.gitignore` 仍保留 `tests/.venv*/` 以防旧检出残留。
- **该 venv 继承的 pyzmq 26.2.0 无法启动 kernel。** 现象：sidecar 一收到 `start_kernel` 就以 `0xC0000409` 退出，Python 侧打印 `Bad file descriptor (zmq …/epoll.cpp:73)`；同一台机器上 pyzmq 25.1.1 的 base anaconda 解释器一切正常。这是**解释器环境**问题，不是 ipynb-mcp 的代码问题（`ping`、`analyze` 正常，`run/server/stale/locked-file` 四个集成文件全绿）。
  **处理方式**：把 `IPYNB_TEST_PYTHON` 指向 base anaconda 解释器即可让集成套件全绿；`tests/integration/kernel.test.ts` 与 `run.test.ts` 里直接用 transport 的用例，现在会在 `beforeAll` 里**真正起一次 kernel**做候选探测——venv 能起就用 venv，起不来就回退到 base 解释器（`kernel.test.ts` 会在 stderr 记录一行说明；走 `runNotebook` 的用例本就用 SPEC §5.2 候选链，不受影响）。因此集成套件在两种环境下都全绿，"环境坏了"不会被误读成"代码坏了"。真正的修复（给测试 venv 一个能用的 pyzmq）属环境操作，未执行。
- **`analyze-op.test.ts` 的 U20 用例在无 kernel 能力的环境下显式 skip**（记录原因：无解释器 / 缺 `SIDECAR_REQUIRED_MODULES` 中的模块 / pyzmq 起不了 socket），因此单测在无 Python / 无 ipykernel 的机器上仍然全绿（AGENTS §3 要求）；而"解释器自称能起 kernel 却起不来"（`start_kernel` 回归）会**失败**而不是 skip（TST-5，已用变异验证）。
  **该文件现在只有一个解释器决策**：`beforeAll` 里的 `prepareVenv()`（`tests/integration/test-venv.ts`，第九轮删掉了本文件里第六份复制；第十轮把 `afterAll` 的断言收窄为"运行前存在**且可用**的 venv，运行后仍在"）先看既有 venv 能否服务 sidecar —— 能就直接用；不能时**只删自己创建的那个**（marker 文件 `.ipynb-mcp-test-venv`），外来 venv（用 `IPYNB_TEST_VENV` 指过来的那份）原样留下并回退到基础解释器；只在基础解释器能服务时才新建 venv 并再次验证；否则直接用基础解释器。该文件的 `afterAll` 还断言"运行前存在且可用的 venv，运行后仍在"，专门钉住"解析解释器 ≠ 拥有它"（v9 V8-12；v10 修正了判据，见 V10-9②）。此前"探针问的是 `interpreter()`、用例却自己建 venv"导致同一个 commit 在 CI 上先过后败（run `37134640458`）—— 留下的 venv 让第二次运行的探针看到了另一个解释器。
- **macOS 仅通过 unit 层验证**（SPEC §9 CI 矩阵的既定决策：macOS 不跑 integration；其 kernel 生命周期语义与 Linux 一致，unit 层覆盖其平台特有分支——路径规范化、缓存目录、`.venv/bin/python`）。
- 集成测试在 vitest 下**按文件串行**（`fileParallelism: false`）：真实 kernel 的时序敏感用例（I16）在并行文件下不稳定，串行是准确性优先的取舍。
- **CI 全绿且外部权威真的跑了**（2026-10-04，run `37143775026`，9 个 job）：integration job 装 `nbformat` 并设 `IPYNB_REQUIRE_NBFORMAT=1`，日志里三条 nbformat 断言均为 ✓ 而非 skip。首次运行（`37130350485`）10 个 job 里 8 个失败，全部在非 Windows 上；
  四类根因（平台假设写死在用例里、探针与 sidecar 真实依赖不一致、`I15`/`U20` 两个用例的自身相位与解释器选择问题）逐条修复，
  过程见 `CHANGELOG.md` 与本文件上方矩阵。**本机 Linux 复现由 `scripts/linux-check.sh` 承担** —— 这些失败在 Windows 上全都看不到。
  CI 上设 `IPYNB_TEST_REQUIRE_VENV=1`：解释器回退会直接失败，避免环境问题被"更绿"的表象掩盖（TST-1）。
- **单测现在也按文件串行**（`vitest.config.ts` 的 `fileParallelism: false`，第九轮 v9 V8-12 改的）。原文这条写的是"保持 vitest 默认值，因为六个用临时目录的文件互不共享状态"——**那个前提不成立**：`analyze-op.test.ts` 会真的起 sidecar，而且与集成套件**共用同一个 `IPYNB_TEST_VENV`**，两个文件并行就有"一个套件删掉另一个正在用的 venv"的窗口。串行关掉的是同一进程内那一半；跨进程那一半由"只删自己创建的 venv"的所有权规则兜住（`tests/integration/test-venv.ts` 的 marker），并用 `tests/unit/test-venv-ownership.test.ts` 的 3 条用例驱动真实 helper 钉住（外来 venv 绝不删、自己人不可用才删、`requireVenv` 失败时也不删）。集成套件一直按文件串行，理由不变（真实 kernel 的时序敏感用例在并行文件下不稳定）。


