# ipynb-mcp 真实使用验证（2026-10-04 凌晨，大主管实测）

## 背景

Boss 要求"直接去看看、直接去用一下"。原计划口头分析 → 改为**真实端到端验证**。

## 一、项目实际状态（远超记忆中的印象）

- 本地 `E:\Work\ipynb-mcp\ipynb-mcp`，git 已推进到 **v8 轮**（`docs: record the v8 round` 等），提交历史专业
- **单元测试：25 个测试文件 / 381 个测试全部通过**（11.38s）
- **CI：最新 run 绿**（37147844188，2026-10-03T19:25:39Z success）；此前有一次 failure（19:17）已修
- **issue #1 仍 OPEN**（10-03 14:49 创建）
- 包信息：`ipynb-mcp@0.1.0`，MIT，node>=22，依赖 `@modelcontextprotocol/sdk` + `zod`
- src 分层清晰：`core/`（edit/errors/markdown/outputs/parse/stale）、`fs/`（artifact/atomic/backup/fence/notebook-file）、`kernel/`（interpreter/protocol/registry/transport）、`mcp/tools/`（read/edit/run/run-status/kernel）
- **6 个工具**：notebook_read、notebook_edit、notebook_run、notebook_run_status、notebook_run_cancel、notebook_kernel
- README 质量高：三条核心承诺（零服务 / CAS 防静默损坏 / 不重跑长任务）+ 完整配置表 + 非常诚实的 Known limitations

## 二、🔴 真实端到端发现：核心功能有 bug（可复现）

**`node scripts/e2e-smoke.mjs --python E:\tool\anaconda\ana\python.exe`**（真实 MCP client SDK + 真实 stdio server + Python nbformat.validate 校验）

**结果：14/19 通过，5 个失败；连跑两次完全一致（可复现）。**

失败项（全部集中在 `notebook_run` 的输出写回）：

1. `notebook_run completes and reports write_back.performed` — FAIL
2. `stored outputs use nbformat keys (no protocol-shaped outputType)` — FAIL
3. `the execute_result carries execution_count (nbformat requires it there)` — FAIL
4. `notebook_read reads back the TEXT that was written — outputs=0` — FAIL
5. `a cell that outlives its timeout does not report success — interrupted: undefined` — FAIL

**独立证据**：直接解析 smoke 工作区产出的 notebook（`%TEMP%\ipynb-mcp-smoke-*\smoke.ipynb`）——
```
0 code exec_count= None outputs= []
1 code exec_count= None outputs= []
2 code exec_count= None outputs= []
```
**即：所有 code cell 的 outputs 全空、execution_count 为 null → `notebook_run` 执行了但结果没写回文件。**

注意 `the written notebook passes Python nbformat.validate` 是 **PASS**——文件格式合法，只是**内容缺失**（少了执行结果）。

## 三、为什么 CI 绿还没发现

- 单测 381 全绿 + CI 绿，但 smoke **没有在 CI 里跑**（或环境不满足被跳过：CI 干净 Python 缺 `jupyter_client`，见 issue #1）
- 这正是 smoke 脚本自己注释里警告的："a smoke run with a real client found a 🔴 that three rounds of unit + integration review had missed, because the whole suite spoke the same private dialect the writer spoke"——**历史重演**

## 四、结论（回答"有没有价值"）

- **不是"没有价值"**：项目已从想法走到"能跑通大半、有真实核心缺陷"的阶段——这是工程真实存在的形态
- **核心承诺"run 并把结果写回"目前是坏的**，这是真实用户（包括 Boss 自己）第一个会撞到的问题
- **产品价值的新证据**：另一个 AI 第一次真实使用就能抓到核心 bug，说明它确实在被使用（至少可被使用），不是空想
- 下一步优先级：①修 write_back 写回路径 ②把 smoke 纳入 CI（否则同类问题继续溜过）③自用验证 ≥3 次/周

## 五、待办

- [ ] 定位 `src/run.ts` writeBackCompleted / `src/core/outputs.ts` 的写回逻辑为何产出空 outputs
- [ ] 修完后重跑 smoke 至 19/19
- [ ] smoke 加入 CI（配好 Python 依赖）
