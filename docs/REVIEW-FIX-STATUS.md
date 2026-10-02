# 代码审查整改状态（review fix status）

> **来源**：`docs/review/ipynb-mcp-code-review.md`（第一轮）与 `docs/review/ipynb-mcp-code-review-v2.md`（第二轮）
> **权威**：`SPEC.md` + `AGENTS.md`。整改只做「实现与被 SPEC 判定不符」的部分；
> SPEC 自身的缺陷按 AGENTS §0 记入 `DEVIATIONS.md` 后按 SPEC 继续。
>
> **本文档的 ✅ 只代表"代码里存在该实现 + 有对应的可复现验证"。**
> 第一轮曾出现 3 处"标 ✅ 但代码里不存在"的虚报（第二轮 V1–V3），本表因此按此标准重写，
> 并在每一行给出验证位置（用例名或文件）。

---

## 一、第二轮（`ipynb-mcp-code-review-v2.md`，评级 C：需返工）

### 1.1 P0 回归（R1–R3）

| # | 结论 | 修复要点 | 验证 |
|---|---|---|---|
| **R1** | ✅ | `getOrCreate` 对"会话在、transport 已死"直接 `#forgetTransport` + 摘除会话，交给 `#transportFor` 重建；`shutdown` 对死 transport 变为幂等清理（不再抛 `kernel_died` 并留住会话）；`sidecar-transport` 的 `exit`/stdio `error` 现在通过 `onExit` 通知 registry 清理其承载的全部 session | `tests/unit/kernel-registry.test.ts` [R1] ×4（含"下一次 getOrCreate 成功"与"onExit 摘除会话"）；集成 I7 补"后续 run 不再失败" |
| **R2** | ✅ | 回收循环逐 session `try/catch` + `warn`（`reclaimIdle` 公开以便确定性驱动）；`process.on('unhandledRejection')` 从 `exit(2)` 降级为记 error 后继续服务 | [R2] ×2（失败不冒泡 + 成功回收）；`src/bin.ts` 注释说明 SPEC §5.1 的退出码 2 只针对启动期 |
| **R3** | ✅ | 三条收口：① `run.ts` 在途 exec 抛 `kernel_died` 时，把**已完成 cell 写回**并放进错误 detail（此前直接 throw，一个都不写）；② `#handleKernelDied` / sidecar `onExit` 通过 `onRunAbort` 通知在途 run；③ 通知只在**目标 cell 已开始**后生效，避免"上一个会话的迟到死亡"打断刚启动的 run | 集成 [R3]（真杀 kernel，断言 `write_back.performed === true` + 已完成 cell 落盘 + 在途 cell 未落盘）；[R3] ×3 单测（三种触发源）；集成 I16 |

### 1.2 虚报（V1–V4）—— 本轮补齐实现

| # | 结论 | 修复要点 | 验证 |
|---|---|---|---|
| **V1/A20** | ✅ | 三条 stdio 流全部挂 `error` 监听；写前检查 `stdin.destroyed` / `writableEnded`；失败统一走 `#failTransport`（一次 `onExit`） | `src/kernel/sidecar-transport.ts`；`#request` 不在回调里判错（回调参数在 Node stream 上是"错误或 null"形状不一致，故统一交给 error 监听） |
| **V2/A22** | ✅ | 请求超时后 `#reclaimAfterTimeout()` 回收进程树（单次触发保护），再 `#failTransport` | 同上；`killGraceMs` 可注入 |
| **V3/A31** | ✅ | run 的**主写回**传 `signal: req.abort?.signal`；写回中被取消返回 `cancelled`（失败路径的写回仍故意不传，§4.8 规则 3） | 集成 I13；`src/run.ts` 主写回块 |
| **V4/A23** | ✅ | `SidecarTransportOptions.onExit` → registry 摘除该死 session 并通知 run（不再只 `#failAllPending`） | [R1] onExit 用例 + [R3] sidecar 退出用例 |

### 1.3 W 类（既有缺陷 / 部分修复残留）

| # | 结论 | 修复要点 | 验证 |
|---|---|---|---|
| **W1** | ✅ | `isLockError` 映射到**读路径**（`readNotebookFile` 与写前复检读），EBUSY/EPERM/EACCES → `notebook_locked` | 集成 I15（Windows 独占句柄）；`tests/unit/notebook-file.test.ts` [W1] 用合成 errno 覆盖三种码与反例 |
| **W2** | ✅ | `COMPATIBILITY.md` 计数改为按文件如实记录；`REVIEW-FIX-STATUS.md`（本文件）重写；`CHANGELOG.md` 补记 | 见 `docs/COMPATIBILITY.md` |
| **W3** | ✅ | 失败路径写回包 try/catch：`exec_timeout` / `cancelled` / `kernel_died` 始终是主错误码，写回失败以 `write_back.reason` + `warn` 呈现 | 集成 [W3]（运行中篡改文件 → 仍报 `exec_timeout`，`write_back.reason` 含 `file_changed`） |
| **W4** | ✅ | read 侧 `maxImages` 传**调用级绝对量** `maxImagesPerCall`（原来传"剩余预算"却配"绝对游标"，两套坐标系） | `tests/unit/render-read.test.ts` [A5][W4] ×3，含"9 张 + 5 张不误报 image_limit"与"12 + 20 截断到 20 且只告警一次"；**已做变异验证**（改回旧写法这两条变红） |
| **W5** | ✅ | run 锁改为 registry 内以**规范化 notebook 路径**为键的独立表（`#runKeys`/`#runActive`），与 session 生命周期解耦 | [W5] ×2（`restart` 换 session 后仍 `kernel_busy`；无 kernel 时 `kernel_not_available`）；集成 I10 改为在两 cell 之间断言 |
| **W6** | ✅ | CLI 空值（`--opt=` / `--opt ""` / 全空白）一律按"未设置"处理，不再落进 `Number('') === 0` | `tests/unit/config.test.ts` [W6] ×5（含"空 CLI 值不遮蔽 env"） |
| **W7** | ✅ | 写锁键改为 `normalizeForCompare(resolve(path))`；清理分支比较**同一个** `tail` promise（原来每次 `.catch()` 都建新 promise，删除分支恒假） | `tests/unit/notebook-file.test.ts` [W7] ×3（用 `pendingWriteLockCount()` 断言不泄漏，含失败路径） |
| **W8** | ✅ | `kernel_status` 失败保留 transport 推导的 `alive`（不再谎报 `false`）+ `warn`；`Promise.all` 并发查询；`run.ts` 的 abort 监听加 `{ once: true }` | [W8] ×2；`src/kernel/registry.ts` `listKernelsWithStatus` |
| **W9** | ✅ | run 主写回传 `onCleanupError` → 注入 logger（此前落到 `atomic.ts` 的裸 stderr） | `src/run.ts` 主写回块 |
| **W10** | ✅ | 选择器段为空串（`-1` / `0-` / `-` / `1--2`）→ `invalid_targets`（原来 `Number('') === 0` 把 `-1` 读成范围 `0-1`） | `tests/unit/cell-selector.test.ts` [W10] |

### 1.4 T 类（测试维度）

| # | 结论 | 修复要点 |
|---|---|---|
| **T1** | ✅ | I7 补"后续 run 不再 `kernel_died`"；死 sidecar 的确定性恢复由 `kernel-registry.test.ts` [R1] 覆盖 |
| **T2** | ✅ | I10 改为"第一个 run 在 cell 1 超时后重建 kernel 的间隙里发起第二次调用"，断言第二次被拒（`kernel_busy` 或 `kernel_not_available`——两者都意味着"第一个 run 仍独占该 notebook"；删掉 `acquireRun` 后第二次会真的开始执行，用例变红） |
| **T3** | ✅ | `server.test.ts` 夹具改为可带**预置输出**（I16 的 cell 2–4 带 seed，未执行 cell 必须保住 seed）；I13 的 reject 分支从恒真式改为 `instanceof Error` + abort/cancel 形状；I16 断言集合不再接受 `completed` |
| **T4** | ✅ | I18b 标题改为单 cell 可验证的说法；其余"校验先于写入"的守卫由 `tests/unit/edit-tool.test.ts` 的真写路径用例承担 |
| **T5** | ✅ | U20 用例在无法启动 kernel 的环境下**显式 skip 并记录原因**（先起一次 kernel 探针，而不是只探测解释器是否存在），单测在无 Python / 无 ipykernel 机器上全绿 | 
| **T6** | ⚠️ | 编号漂移是**记录问题**而非行为问题：新增用例使用 `[W*]`/`[R*]`/`[A*]`/`[D-0xx]` 等非 SPEC §10.2 词汇。**处理方式**：本轮把这类用例全部加上对应 SPEC 编号前缀（如 `[A5][W4]`、`[R1]`），并在 `DEVIATIONS.md` D-018~D-021 说明新增偏离；SPEC §10.2 不新增用例编号（那是 SPEC 的事） |

### 1.5 文档与卫生（Doc1–Doc6 / H1–H5）

| # | 结论 | 动作 |
|---|---|---|
| **Doc1** | ✅ | `COMPATIBILITY.md` 计数改为按文件如实记录（并写明本机 venv 的 pyzmq 缺口） |
| **Doc2** | ✅ | D-015 重写：判定式是 `timeout × cells > threshold × 10`，**默认配置下只有单 cell 同步**；D-004 补交叉引用；README 的 `--background-threshold-seconds` 行同步 |
| **Doc3** | ✅ | D-016 更正：不再声称"豁免面集中声明在 `src/kernel/interpreter.ts`"（该文件无此声明），改为如实列出 `config.ts` / `kernel/interpreter.ts` / `fs/artifact.ts` 三处，并写明 artifact 默认根在 root 之外 |
| **Doc4** | ✅ | D-004 与 D-015 不再互相冲突（D-004 指向 D-015 为唯一权威描述） |
| **Doc5** | ✅ | 新增 D-018（`docs/archive/` 无实体）、D-019（run 级锁比 SPEC 更严）、D-020（`clear_outputs` 非 code cell 与两种选择器错误码分工）、D-021（`failedCellIndexes` 字段名） |
| **Doc6** | ✅ | 见 D-021 |
| **H1** | ✅ | 删除仓库根的 `patch-tmp.py`（一次性补丁脚本，内容已在代码里；也是行尾符污染源） |
| **H2** | ✅ | `.workbuddy/` 加入 `.gitignore` 并从索引移除（含本机绝对路径的工作记忆） |
| **H3** | ✅ | 新增 `.gitattributes`（`* text=auto eol=lf`）；行尾符归一化单独提交 |
| **H4** | ✅ | `.gitignore` 补 `.workbuddy/`、`patch-tmp*`、`*.tgz` |
| **H5** | ✅ | `docs/E2E-CHECKLIST.md` 的本机绝对路径改为 `<repo>` 占位符 |

---

## 二、第一轮（`ipynb-mcp-code-review.md`）—— 复核结论

第二轮报告确认了第一轮下列项**真修**（A1 主路径、A2、A8/A9/A11/A13–A15/A21/A24/A26/A27/A29、B1/B2/B4/B6、C1–C6、D2/D3/D5/D6/D7/D9、E3）。
第一轮曾标 ✅ 但第二轮查明不实的三项（A20/A22/A31）已在本轮**补齐实现**（见 1.2）。
`REVIEW-FIX-STATUS.md` 第一轮的批次表与门禁数字已不再维护（保留在 git 历史中）；**当前状态以本文件第一节为准**。

---

## 三、剩余事项（需人类/CI）

| # | 事项 | 归属 |
|---|---|---|
| 1 | **E1–E9 手工端到端**（DoD 最后一项）：清单见 `docs/E2E-CHECKLIST.md`，需真实 MCP 客户端 | **boss** |
| 2 | **CI 首次真跑**：仓库无 `git remote`，`ci.yml` 的 12 个矩阵组合从未执行；已知两处需修（unit job 不装 ipykernel 而 U20 要真 kernel——本轮已改为显式 skip，但 CI 的分工仍建议调整：integration job 也应跑 `pnpm test`） | **boss / 下一轮** |
| 3 | **本机 venv 的 pyzmq 26.2.0 缺口**：`tests/integration/kernel.test.ts` 在本机失败（详见 `COMPATIBILITY.md`） | 环境 |
| 4 | npm 发布与 `dsh-ipynb-mcp` bundle 发布（OPEN_QUESTIONS Q5/Q6）：按默认先不发布 | **boss** |
| 5 | SPEC v3.1 建议修订：D14 判定式量纲、R6 豁免措辞（含 artifact 默认根）、§5.8 上限公式/分帧、§5.8 的 `failedCellIndexes` 字段名、D-004 交叉引用 | 人类 / 下一轮 |
