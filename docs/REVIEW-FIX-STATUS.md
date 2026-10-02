# 代码审查整改状态（review fix status）

> **来源**：`docs/review/ipynb-mcp-code-review.md`（第一轮）、`…-v2.md`（第二轮）、`…-v3.md`（第三轮）
> **权威**：`SPEC.md` + `AGENTS.md`。整改只做「实现与被 SPEC 判定不符」的部分；
> SPEC 自身的缺陷按 AGENTS §0 记入 `DEVIATIONS.md` 后按 SPEC 继续。
>
> 各轮的逐条闭环记录见本文件末尾的「第三轮」「第二轮」「第一轮」三节；**门禁数字以本节为准**。
>
> **本文档的 ✅ 只代表"代码里存在该实现 + 有对应的可复现验证"。**
> 第一轮曾出现 3 处"标 ✅ 但代码里不存在"的虚报（第二轮 V1–V3），本表因此按此标准重写，
> 并在每一行给出验证位置（用例名或文件）。
>
> **门禁实测（第三轮整改后）**：`pnpm typecheck` 0 错 / `pnpm lint` 0 警（57 文件 99 规则 + `scripts/check-format.mjs`）/
> 单测 **223（222 passed + 1 skipped）** / 集成 **39/39**（5 文件全绿）/ `npm pack --dry-run` 133 文件 / 全树 LF。
> 唯一 skip 是 U20（本机无法起 kernel，已记录原因并区分"环境不足"与"start_kernel 回归"）。集成用到的解释器见 `COMPATIBILITY.md`。

---

## 〇、第三轮（`ipynb-mcp-code-review-v3.md`，本轮）

> 该报告对 v2 的闭环核查结论是"四道门禁全部真实通过、逐字吻合"（本项目第一次），
> 同时给出 5 条 🟠 与若干 🟡/🟢。逐条状态：

### 0.1 🟠 项

| # | 结论 | 修复要点 | 验证 |
|---|---|---|---|
| **ROB-8** | ✅ | 四条收口：① 写回窗口内的取消改走与中途取消**同一条终态路径**（`abortedRunError`），detail 带 `executed`/`write_back`；② abort 判定改用**合并后**的 signal；③ `kernel_not_available` 与 `kernel_died` 同等对待；④ 目标 cell 前校验承载它的 session 未被换掉（仅 `resume`） | 集成 `[ROB-8]`（取消落在写回窗口，断言 `write_back.performed` + 盘上 `execution_count`，**已做变异验证**：改回旧实现即变红）；[R3]/I16 回归 | 
| **ROB-2** | ✅ | 超时路径改为**先 `shutdown()` 后摘 session**（原顺序让 `shutdown` 查不到 session 直接返回 → 关闭从未发生、kernel 泄漏） | 用例 `[ROB-2]` ×2（断言 `shutdownKernel` 恰被调用一次 + 无残留 session + 下次是 `kernel-2`；**已做变异验证**） |
| **ROB-11** | ✅ | `exec_cell` 余量改为 `timeoutMs + sidecar 最坏耗时 + 10s`；"超时回收进程树"限定为只对 `exec_cell`（`kernel_status`/`ping`/`analyze` 超时不再连坐其他 notebook） | D-027 登记 + 常量按 sidecar 预算命名；现有 I5/I18/W3（依赖 `exec_timeout` 语义）全绿 |
| **DEP-1** | ✅ | sidecar 把 connection file **钉在 OS 临时目录**并在三个出口删除 | D-023 登记；实测：改造后新起的 kernel 在仓库根与 `%TEMP%` 均无残留（旧行为会各留一份） |
| **QUAL-8** | ✅ | `notebook_run_cancel` 立即置终态 + 不再 sleep；`interrupt` 失败只记 warn | `src/mcp/tools/run-status.ts`；终态语义与 §4.8 的响应枚举一致 |
| **ARCH-1** | ✅ | nbformat 输出形状下沉到 `core/outputs.ts` 的 `rawOutputsOfCell`（`hasStableCellIds` 一并下沉）；顺带修掉**数组形式 `data` 值被静默丢弃** | `grep` 确认 `src/mcp/*` 不再解析输出形状；U15/U16/U17/U21/U21b 回归 |

### 0.2 🟡 项

| # | 结论 | 修复要点 |
|---|---|---|
| **ROB-6** | ✅ | 复用键/run 锁/路径查找统一 `realpath` + 折叠（`canonicalPath` 可注入，生产注入 `realpathSync`）；用例 `[ROB-6]` ×2 |
| **ROB-5** | ✅ | `cell_indexes` 去重 + 限长 1000（工具层拒绝，保持 `invalid_arguments`）；用例 `[ROB-5]`（200 次重复 → 只渲染 1 个 cell；1001 项 → 拒绝） |
| **ROB-13 / ROB-14** | ✅ | 探活说死了也**先尝试关闭**再摘除；`liveKernel` 一次探测的结果传给 `getOrCreate`（`knownAlive`），不再二次探测；用例 `[ROB-13]`/`[ROB-14]` |
| **ROB-10** | ✅ | sidecar stderr 进入环形缓冲（20 行）并随 `kernel_died` 的 detail 返回；stderr 转发从 debug 提升为 warn；退出码带 `STATUS_*` 符号名；D-030 登记"候选链只在解析期降级" |
| **ROB-12** | ✅ | 按 D-031 如实登记：异常退出后不再按 pid 补刀（子进程已退出，pid 复用有误杀风险；实测无孤儿） |
| **QUAL-1** | ✅ | 修掉两处缩进错乱；新增零依赖 `scripts/check-format.mjs`（tab / 行尾空白）并接进 `pnpm lint`。未加 prettier：新增依赖需先问人类（AGENTS §11），且检查故意不做可疑的"块嵌套启发式" |
| **QUAL-2** | ✅ | 删除 7 处死导出/重复实现；`sidecar-transport` 改用 `isSidecarResponse`；`isAbortCause` 收敛为一份（run.ts 用 `isAbortError` 引用它） |
| **QUAL-3** | ✅ | 删除 `read.ts` 的死变量 `imageBudget`；`tsconfig` 打开 `noUnusedLocals`/`noUnusedParameters`（随即发现并清掉 2 处未用参数） |
| **QUAL-6** | ✅ | `atomic.ts` 的三处 warn 文案去掉硬编码 `[ipynb-mcp] warn` 前缀，前缀由兜底 sink 负责（消除了双前缀双级别） |
| **QUAL-7** | ✅ | 删掉恒真的 `else if (… || true)` 分支；`lastTouchedCell`（每次 op 重复 `locate()` 的线性查找）随死分支一起删除；`truncateText` 不再对同一源码算两遍；`defaultSpecName(_deps)` 改为常量 |
| **QUAL-10** | ✅ | 修掉 5 处与代码不符/已失效的注释（`run.ts` 头、`edit.ts` "step 5"、nbformat 形状声明、`lastTouchedCell`、registry 并发说法） |
| **SEC-1** | ✅ | 六个工具 schema 改为 **strict**：未知参数名不再被静默剥离（原状：对外声明 `additionalProperties:false`，实际静默丢弃）。代价（协议错误而非工具错误）按 D-024 登记；用例 `[SEC-1]` |
| **SEC-2** | ✅ | `runTool` 不再把 stack 放进模型可见的 `detail`（改为 `error: name: message`），stack 经 logger 落 stderr；用例见 U24 系列 |
| **PERF-1** | ✅ | NDJSON 分帧改分块累积：64 MiB 单行实测 **9333 ms → 1884 ms**（旧实现用 `git stash` 回放同机对比） |
| **PERF-2** | ✅ | 图片按 base64 长度下界在解码前拒绝（省解码 + SHA-256）；`outputs.test.ts` 的边界例全绿 |
| **PERF-3** | ✅ | `analyzeStale` 改一次线性扫描（原为每 cell 回扫 + 嵌套 `includes`）；`run.ts` 的 code-index 映射改 Map；`stale.test.ts` 11 例全绿 |
| **ARCH-2** | ✅ | 解释器探测缓存加 TTL（成功 30s / 失败 1s）：按提示安装 ipykernel 后无需重启服务；D-022 登记 `kernel/interpreter.ts` |
| **ARCH-3** | ✅ | 写锁键用调用方的 `options.platform`，不再读进程全局 |
| **ARCH-5** | ✅ | `AGENTS.md` §4 的树按 `git ls-files src` 重写（补 `run.ts`/`hash.ts`/`kernel/interpreter.ts`/`fs/notebook-file.ts`/`mcp/context.ts` 等），并注明以实际结构为准 |
| **ARCH-6** | ⚠️ 部分 | 本轮做了**风险消除**的部分：两条终态路径合并为 `abortedRunError`/`failedRunError`（ROB-8 的根因）；`runNotebook` 的其余拆分（`executeCells`/`materializeRunImages`/`computeStaleReport`）未做——属纯结构重构，AGENTS §10 禁止"顺手重构"，且当前无行为风险点 |
| **ARCH-4/ARCH-7** | ⬜ | 未做，理由见 §三「剩余事项」：`applyEditOps`/`runNotebook` 的进一步拆分与 `shouldReturnImages` 的层次迁移都属重构，随下一次接口变更批次一起做 |
| **DEP-2/DEP-3/DEP-6** | ✅ | `server.ts` 版本号对齐 `package.json`；`prepack` 改 `tsc -p tsconfig.json`；CI 去掉与 `packageManager` 冲突的 `version: 11` |
| **DEP-1（文档计数）** | ✅ | COMPATIBILITY 与本文件的计数改为实测值（并注明"按文件给数字"的原因） |
| **TST-1/TST-5/TST-6/TST-7** | ✅ | 见 CHANGELOG「Tests」段：解释器回退在 CI 上直接失败、U20 区分"环境不足"与"回归"、I9 改为可证伪断言、I12 覆盖 edit+run、`[TST-7]` 补读路径映射（**已做变异验证**） |
| **TST-2/TST-3/TST-4** | ✅ | 已在 v2 轮完成（本报告确认）；本轮未回退 |
| **H-2/H-3/H-5/H-6/H-7** | ✅ | `.gitattributes` 生效（0 CRLF / 0 mixed）；`scripts/` 入库；`__pycache__`、`tmp*.json` 等已 ignore；`docs/review/` 三份报告入库 |
| **DOC-1 ~ DOC-6** | ✅ | 新增 D-022~D-031（含 D-028 的"取消信号取舍"与 D-024 的"未知参数"取舍）；README 补四条已知限制；本文件重写门禁数字 |

### 0.3 v3 报告对 v2 的核查异议

- **V3/A31 被标"修法有副作用"**：其副作用（写回窗口内取消丢失 detail）已按 ROB-8 修好，两条写回的信号取舍按 D-028 登记。
- **V4/A23 被标"部分"**：按 D-031 如实登记为"不再按 pid 补刀"，理由与实测（无孤儿）写在条目里，不再声称字面实现。

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
| **T1** | ✅ | I7 补"后续 run 是冷启动（`mode_used === 'replay'`）"；死 sidecar 的确定性恢复由 `kernel-registry.test.ts` [R1] 覆盖。两个集成文件现在都**探测解释器能否真正起 kernel** 再决定用哪个（本机 venv 的 pyzmq 坏，否则 8 个用例会因环境变红） |
| **T2** | ✅ | 两半分开验证：**在途重叠**由集成 I10 覆盖；**两 cell 之间的间隙**（此时没有任何在途 exec）由 `kernel-registry.test.ts` [W5] 直接断言 `acquireRun` 仍抛 `kernel_busy`——集成层无法确定性地制造那个间隙，硬做会变成竞态用例 |
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
| 2 | **CI 首次真跑**：仓库无 `git remote`，`ci.yml` 的 12 个矩阵组合从未执行。本轮已修掉两处**必然失败**的配置（pnpm 版本双重声明；integration job 未跑单测），并加了 `IPYNB_TEST_REQUIRE_VENV=1` 防止解释器回退掩盖环境问题——但结论仍以真实 runner 为准 | **boss** |
| 3 | **本机 venv 的 pyzmq 26.2.0 缺口**：该解释器起不了 kernel（详见 `COMPATIBILITY.md`）。集成文件已能自动探测并回退，**未修改任何解释器环境**（R5） | 环境 |
| 4 | npm 发布与 `dsh-ipynb-mcp` bundle 发布（OPEN_QUESTIONS Q5/Q6）：按默认先不发布 | **boss** |
| 5 | **结构重构类建议未做**（AGENTS §10 禁止"顺手重构"，且当前无行为风险点）：ARCH-4（`applyEditOps` 219 行）、ARCH-6 剩余部分（`executeCells`/`materializeRunImages`/`computeStaleReport` 抽取）、ARCH-7（`shouldReturnImages` 迁到 `core/outputs.ts`）。建议与下一次接口变更同批做 | 下一轮 |
| 6 | SPEC v3.1 建议修订：D14 判定式量纲、R6 豁免措辞（含 artifact 默认根与 sidecar connection file）、§5.8 上限公式/分帧与 `failedCellIndexes` 字段名、§4.1.12 与 §4.6.3 的"未知参数"分工（D-024）、§5.2 的运行期降级语义（D-030） | 人类 / 下一轮 |
