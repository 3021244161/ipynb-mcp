# ipynb-mcp 代码审查报告（第三轮 / v3）

> **审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp` @ HEAD `a6951a8`（工作树干净）
> **本轮变更**：v2 报告（`f03a5b3`）之后新增 **7 个提交**，其中 `4c35da9` 为全树 LF 归一化
> **权威**：`SPEC.md` + `AGENTS.md`（本轮同样**未被修改**；新增偏离登记 D-018~D-021）
> **方法**：主审全程实跑门禁 + 5 条并行复核流（R1–V4 / W 类 / T 类 / 架构·质量·依赖 / 健壮性·性能·安全）+ 主审逐条亲验关键项
> **判定基准**：凡标 🔴/🟠 的结论，主审均亲自读过代码或跑过实验；子代理结论中被主审查出误报的，单独列出并撤回
> **日期**：2026-10-02

---

## 一、门禁实测（主审亲跑，HEAD `a6951a8`）

| 门禁 | 实测结果 | 与声明 |
|---|---|---|
| `pnpm typecheck` | exit 0 | ✅ 一致 |
| `pnpm lint` | `0 warnings and 0 errors`，57 文件 / 99 规则 | ✅ 一致 |
| `pnpm test` | **213 passed + 1 skipped（214）**，20 文件；唯一 skip 为 `[U20][D2]`，原因记录为"no interpreter that can start a kernel here" | ✅ 一致（`COMPATIBILITY.md` 记为 214/213+1）。⚠️ 该 skip 是**负载相关**的：子代理在 `%TEMP%` worktree 单跑同一文件时 **4 passed（不 skip）**——`vitest.config.ts` 没有 `fileParallelism:false`，全量并行时该 venv 的 pyzmq 才触发 fast-fail（见 TST-5） |
| `pnpm test:integration` | **38 passed / 38**，5 文件，292 秒，含此前稳定失败的 `[I15] notebook_locked` | ✅ 一致 |
| `pnpm build` | exit 0；`lib/bin.js` 首行 `#!/usr/bin/env node` | ✅ 一致 |
| `npm pack --dry-run` | **133 项** / 131.0 kB / unpacked 549.2 kB，含 `lib/bin.js`(4.6 kB) 与 `python/ipynb_sidecar.py`(15.2 kB) | ⚠️ 文档记 132 项（🟢 DEP-1） |
| `git ls-files --eol` | **CRLF 0 / mixed 0**，87 个跟踪文件；`.gitattributes` 存在 | ✅ 一致（上轮 53 CRLF / 5 mixed） |
| R19 进程残留（测试全跑完后） | `ipykernel = 0`、`sidecar = 0`、Node/vitest = 0 | ✅ 已完成路径上不残留 |
| 仓库工作目录残留文件 | **11 个 `tmp*.json`**（每个 281 B，内容为 jupyter kernel connection file，含 `"key"` / `"signature_scheme": "hmac-sha256"`）；`git check-ignore` 显示被 `.gitignore:32` 忽略、`git ls-files` 显示**未被跟踪** | ⚠️ 文件系统残留（见 ROB-7）；主审自己跑一轮集成测试即新增 4 个 |

**结论：四道门禁全部真实通过**。这是本项目第一次"声明与实测逐字吻合"。

---

## 二、上一轮（v2）问题的闭环核查

| v2 项 | 结论 | 主审证据 |
|---|---|---|
| **R1**（🔴 sidecar 死后永久卡死） | ✅ **真修复** | `registry.ts:196-204` 死 transport → `#forgetTransport` + `#removeSession`（不再经抛错的 shutdown）；`:425-433` 的 `shutdown` 对死 transport 改为幂等清理；`onExit`（`:312-317`）摘除该 transport 承载的全部 session。集成测试新增第二条 I7 用例 `a later run replays instead of failing with kernel_died (review R1)`，真跑 25.3 秒并通过 |
| **R2**（🔴 回收路径 exit(2)） | ✅ **真修复** | `bin.ts:121-123`：`unhandledRejection` 改为记 error 后**继续服务**，并注释引 SPEC §5.1（退出码 2 只管启动期）；`#reclaimIdle` 路径另有 `shutdown` 幂等化兜底 |
| **R3**（🔴 kernel 死亡不写回） | ✅ **真修复** | `run.ts:402-418`：`execCell` 抛 `kernel_died` 且未 abort 时改走 `failedRunError('kernel_died', …)`，写回已完成 cell 并携带 `executed`/`write_back`；`registry.ts:529-540` 的 `#handleKernelDied` 同时 `#notifyRunAborted`。集成用例 `[R3] … reports kernel_died with write_back.performed and the finished cell on disk` 通过（7.1 s） |
| **V1/A20** | ✅ 真修复 | `sidecar-transport.ts:93-95` 三条流全部挂 `error` → `#failTransport` |
| **V2/A22** | ✅ 真修复 | `#reclaimAfterTimeout()`（`:333-345`）→ `void this.#killTree()` → `#failTransport` |
| **V3/A31** | ⚠️ **修法有副作用**（见 **ROB-8**） | 主写回确实传了 `signal`（`run.ts:621`），但新增的 catch 分支（`:627-632`）绕过统一 abort 路径 |
| **V4/A23** | ⚠️ **部分**（见 **ROB-12**） | "通知 registry 清理死会话"这半真做了（`onExit` → 摘 session + 通知 run）；但"异常退出回收进程树"字面仍不存在：`#failTransport` 只置 `#exited`，`kill()`/`shutdownAll()` 因此早退。子代理真进程实验显示**未观察到孤儿**——`taskkill /F` 杀掉 sidecar 后 ipykernel 会自行退出（父进程看门狗），危害被上游机制抵消 |
| **W1**（🔴 notebook_locked 不可达） | ✅ 真修复 | `notebook-file.ts:39-53` 新增 `translateLockError`，读路径（`:34`）与写前复检读（`:144`）共用；`[I15]` 集成用例从"稳定红"变为通过（1.5 s），另有 `tests/unit/notebook-file.test.ts` 用合成 errno 覆盖三种码 |
| **W2**（门禁声明不实） | ✅ 真修复 | `COMPATIBILITY.md:16-33` 改为给出实测数字、按解释器分列，并如实登记"本机 venv 的 pyzmq 26.2.0 无法启动 kernel"与"CI 从未真跑" |
| **W3**（写回失败顶掉主错误码） | ✅ 真修复（新路径见 ROB-8） | `run.ts:752-780` 包 try/catch，失败降级为 `write_back.reason` + warn；集成 `[W3]` 断言仍报 `exec_timeout` |
| **W4**（read 图片预算坐标系） | ✅ 真修复 | `render/read.ts:98` 改为绝对 cap + 绝对游标（与 `run.ts:432` 同系）；子代理做新旧对照实测（旧形状 11 张 + 误报 `image_limit`，新形状 14 张 + 无告警） |
| **W5**（run 锁被换 session 绕过） | ⚠️ **部分**（见 **ROB-11**） | 锁已改路径键（`registry.ts:340-365` + `#runActive`），但 `getOrCreate(fresh)` 仍在 `acquireRun` 之前执行 |
| **W6**（CLI 空值） | ✅ 真修复 | `config.ts:177-183` 在通用解析器层统一把空串当"未设置"；`config.test.ts:214-235` 覆盖 `--exec-timeout-seconds=`、`--kernel-idle-seconds=`、`--python ""` |
| **W7**（`withPathLock` 清理恒假） | ✅ 真修复 | `notebook-file.ts:87-108` 存的与比的是同一个 `tail`；键用 `normalizeForCompare`；`pendingWriteLockCount()` 使泄漏可断言 |
| **W8**（status 造假 / 空 catch / abort 监听） | ⚠️ **大部分**：status 与 `Promise.all` 已修（`registry.ts:149-177`）、`{once:true}` 已加（`mcp/tools/run.ts:83`）；**`atomic.ts:58-62` 空 catch 仍在**（见 **ROB-6**） | 主审读码 |
| **W9**（清理诊断绕过 logger） | ✅ 真修复 | 三处调用点（`run.ts:625`、`run.ts:772`、`edit.ts:83`）全传 `onCleanupError` |
| **W10**（`-1` 选择器） | ✅ 真修复 | `run.ts:130-139` 判空在 `Number()` 之前；子代理逐字重放旧实现确认差异 |
| **T1**（I7 名不副实） | ✅ 真修复 | 新增第二次 run 的断言（集成输出可见，25.3 s） |
| **T2**（I10 无判别力） | ⚠️ **部分**（见 **TST-2**） | 实现者把"两 cell 间隙"这半挪到 `tests/unit/kernel-registry.test.ts` 直接断言 `acquireRun`（诚实处理），但集成 I10 本身判别力未变 |
| **T3/T4**（夹具空值 / 弱断言） | ⚠️ **部分**（见 **TST-3**） | `server.test.ts` 夹具已支持预置输出、I13 恒真式已改、I16 不再接受 `completed`；U4 真写路径守卫与 I18b 单 cell 的"only"仍弱 |
| **T5**（U20 与 CI 契约不符） | ✅ 真修复 | U20 改为"先真起一次 kernel 再决定 skip"并在无法起 kernel 时**记录原因**跳过；`ci.yml:66` 的 integration job 现在也跑 `pnpm test` |
| **T6**（编号漂移） | ⚠️ **部分**（见 **TST-4**） | 新用例加了 SPEC 前缀（如 `[A5][W4]`），但 `[R1]`/`[W3]`/`[I-smoke]` 等仍非 SPEC §10.2 词汇，未补入 SPEC 也未登记 DEVIATIONS |
| **H1–H6**（卫生） | ✅ 全部真修复 | `patch-tmp.py` 与 `.workbuddy/` 已 `git rm`；`.gitattributes` 新增 `* text=auto eol=lf` + 二进制排除；`.gitignore` 补 `.workbuddy/`、`*.tgz`、`patch-tmp*`、`tmp*.json`；`E2E-CHECKLIST` 本机路径已清；`git ls-files --eol` 显示 CRLF=0/mixed=0 |
| **Doc1–Doc6**（文档） | ✅ 全部真修复 | `COMPATIBILITY.md` 计数与缺口如实；`D-004` 加 D-015 交叉引用；**D-015 的影响面改为准确表述**（"只有单 cell 同步，2 cell 起转后台；若希望 ≤10 cell 同步常量须改 ×100"）；D-016 的假声明已删并补全豁免面；`CHANGELOG.md` 指向 D-001~D-021；README `--background-threshold-seconds` 已注明 **10×**；新增 D-018~D-021 |
| **C1–C6**（发布链） | ✅ 仍成立 | build + pack 实测（见 §一） |

**净结果**：v2 的 3 个 P0 回归全部真修复且有回归用例；上轮 4 处虚报（V1–V4）中 3 处补齐、1 处（V3）改法带来新问题；W/T/H/Doc 基本闭环。**这是本项目迄今质量最好的一轮。**

---

## 三、本轮新发现

### 维度 3：健壮性与错误处理

【ROB-8】
严重程度：🔴 阻塞
所在位置：`src/run.ts:605-635`（尤其 `:627-632`）、对照 `:513-527` 与 `:716-742`
问题描述：客户端取消若落在"执行已结束、写回尚未开始/进行中"的窗口，代码抛出一个**不带任何 detail** 的 `cancelled`，已完成 cell 的结果既没落盘、也没回报给调用方——与同一终态的既有路径语义相反。
详细分析：
1. `run.ts:609-635` 的主写回现在带 `signal: req.abort?.signal`（V3 的修复）。取消一旦在此窗口触发，`writeNotebookFile` 丢弃临时文件并抛错，`:627-632` 的 catch 直接 `throw new IpynbError('cancelled', 'run cancelled while writing results back', {})`。
2. 这个 detail 是**空的**：既无 `executed`，也无 `write_back`。而 SPEC §4.8 规则 3（`SPEC.md:543`，其列举的三种终态触发条件包含"客户端 abort"）明确要求：**"已完成的定向 cell 按 §4.7 规则 5 照常写回（当 `write_outputs=true` 且至少一个 cell 完成时），终态中必须报告 `write_back:{ performed, backup_path }`"**，理由写在同一条里——"把'已经算完的结果'丢掉，与'不会重跑你的长任务'这一产品承诺直接冲突"。
3. 对比 `:513-527` 的统一 abort 路径：它经 `failedRunError`，写回已完成 cell 并把 `executed_cells`/`executed`/`write_back` 全部塞进错误 detail（`failedRunError` 的文档注释 `:716-721` 正是这么写的）。于是**同一个终态码 `cancelled`，两条路径给出两种相反的结果形状**，取决于取消落在 `:513` 的 `isAborted` 检查之前还是之后。
4. 窗口比"写回那一瞬间"更大：`:513` 的检查之后还夹着 `mappedTruncated`、**stale 分析（一次 sidecar 往返）**、进度通知，然后才是写回。MCP 客户端在请求超时时普遍会 abort，因此这条路径的触达面不止"用户恰好在那一刻按 Esc"。
5. 该分支**零测试覆盖**（集成 `[W3]` 只覆盖 `exec_timeout`，I13 覆盖的是 abort 落在 cell 在途时的情形）——这正是它带病过门禁的原因。
6. 附带：`isAbortCause(cause, req.abort?.signal)`（`:628`）用的是**原始客户端 signal**，而不是合并了 kernel-death 的 `effectiveReq.abort.signal`（`:311-316`）。若 sidecar 在写回期间退出，合并 signal 已 abort 但客户端 signal 未 abort → 判定为 false → `throw cause` 抛出的是 `atomicWriteFile` 的裸 abort 错误，最终被 `runTool` 归为 `internal`。当前 `kernelAbortState.cellInFlight` 只在 `execCell` 前后开关（`:382`/`:391`/`:421`），写回期间为 false，故这条子路径可达性低，但判定信号选错本身是缺陷。
7. **同一数据丢失类别还有一条"间隙"路径（子代理 S4/S4b 复现）**：`cellInFlight` 门（`:305-310`）只在确有 cell 在途时闩 abort，因此 kernel 死亡若落在**两 cell 之间**，session 已被 `#handleKernelDied`/`onExit` 摘除，下一个 `execCell` 抛的是 **`kernel_not_available`**，而 `run.ts:419` 只对 `kernel_died` 特判 → 仍然 `throw cause`，**已完成 cell 全不写回、detail 里连 `executed` 都没有**（实测：`code = kernel_not_available`、`detail = {path}`、磁盘上 cell0 `execution_count = null`）。可达触发：① `notebook_kernel shutdown`/`restart` 打在同步 run 的间隙（工具层 `mcp/tools/kernel.ts:48-69` 只 abort **后台** run，I16 也只测后台）；② sidecar 进程在间隙崩溃。自发 OOM 在间隙**不会**走这条（sidecar 下次 exec 才报告，报的是 `kernel_died`，可正常写回），所以窗口比 v2 的 R3 窄，但后果同为静默丢失已完成工作。
8. **比"不写回"更危险的一条**：同一个 `restart` 打在同步 run 的间隙时，run 不会终止，而是**静默在新 kernel 上继续执行并写回**——前半段的结果在新 kernel 上不存在，写回的却是"看起来成功"的结果。
修复建议（覆盖 1–8，与 ROB-11、ROB-2 同批做）：
```ts
} catch (cause) {
  if (isAbortCause(cause, effectiveReq.abort?.signal)) {
    const code = effectiveReq.abort!.reason === 'kernel_died' ? 'kernel_died' : 'cancelled';
    throw await failedRunError(code, `run aborted (${code})`, executed, deps, abortState,
                               notebook, effectiveReq, platform, executedCellsSet);
  }
  throw cause;
}
```
并补一条用例：客户端 signal 在写回窗口内 abort（例如注入慢速 `serialize` 或大 notebook + `setTimeout(abort)`），断言"已完成 cell 已落盘 + detail 含 `write_back`"。
设计文档对齐：**违反 SPEC §4.8 规则 3 的"终态中必须报告 `write_back`"**；与 `failedRunError` 的设计意图（`:716-721`）和 §4.6.2 第 2 条"已完成的写入不回滚"不一致（该条禁止的是回滚，不是不写）。

【ROB-2】
严重程度：🟠 严重
所在位置：`src/kernel/registry.ts:388-402`
问题描述：`execCell` 超时路径**先摘 session 再调 `shutdown()`**，而 `shutdown()` 首行就是 `#findSessionByNotebook()` → 必然返回 null → 立即 return，于是 SPEC §4.7 规则 6 要求的"关闭该 kernel"**从未发生**。
详细分析：
1. `:396 this.#removeSession(session)` → `:398 await this.shutdown(notebookPath)` → `:421-424` `const session = this.#findSessionByNotebook(...); if (session === null) return;`。链路必然短路。
2. 子代理用假 transport 实测：`exec status: timeout` 之后 `shutdownKernel calls = 0`（SPEC 期望 1），且 `sessions still registered = 0`、`interrupt after timeout → kernel_not_available`。
3. 后果：该 kernel 进程继续存活（sidecar 的 `op_exec_cell` 超时后只 `interrupt_kernel()` 并等 5 秒），内存里留着用户的大对象；它已从 `#sessions` 摘除，`#reclaimIdle` 永远扫不到，运行期内**没有任何路径能再回收**（`shutdownAll` 遍历 `#sessions` 也扫不到，但会遍历 `#transports` → `taskkill /T /F`，因此进程退出时仍能兜住 → 泄漏边界 = MCP 服务生命周期）。
4. `:389-395` 的注释声称"the kernel it points at is already being torn down … a failed cleanup is logged, not thrown"，描述的正是**不存在**的行为；`:399-401` 的 catch 因此是死代码，真正出问题时反而没有日志。
5. 这也是"invisible-but-alive"的再现——A30 当初正是为消除这种形态才保留 session 的。
6. **主审补充核对（子代理的真 kernel 实验）**：`execCell` 返回 `status=timeout`（39.1 s）后 registry 会话数 = 0，而 **kernel pid 仍存活**；下一次 `getOrCreate` 起了 `kernel-2` → **同一复用键下同时存在两个活 kernel**（违反 §5.3"一键一 kernel"）。回归不可见的直接原因：`tests/integration/run.test.ts:337-338` 只断言 `registry.findByNotebook(nb) === null`（记录被删），所以那个用例名里的 "kernel is gone" 是**假的**——它验证的是"记录没了"，不是"进程没了"。修法应改为按 pid 断言进程已退出。
7. 该分支在 `f7bb82e` 之前**不做** `#removeSession`，`shutdown` 能真正到达 sidecar → **本轮新引入的回归**。
修复建议：
```ts
if (result.status === 'timeout') {
  try {
    await this.shutdown(notebookPath);     // 先关：成功路径内部会 #removeSession
  } catch (shutdownCause) {
    this.#logger?.warn(`post-timeout shutdown failed for ${session.kernelId}: ${String(shutdownCause)}`);
    this.#removeSession(session);          // 关不掉也必须摘除，避免复用死 kernel
  }
}
```
并补单测：假 transport 断言 `shutdownKernel` 恰被调用 1 次（现有 `kernel-registry.test.ts` 只断言 reject，无判别力）。
设计文档对齐：不符合 SPEC §4.7 规则 6 与 §6 **R19**（不得留下孤儿 kernel）；AGENTS §7 陷阱 4 的写回规则亦以"kernel 已被关闭"为前提。

【ROB-11】
严重程度：🟠 严重
所在位置：`src/kernel/sidecar-transport.ts:133-136`（`:135` `Math.max(params.timeoutMs + 30_000, 60_000)`）、对照 `python/ipynb_sidecar.py:196-213`（中断宽限 5 s）与 `:249-254`（shell 回复等待 30 s）
问题描述：传输层给 `exec_cell` 留的余量（`timeoutMs + 30 s`）**小于** sidecar 在"中断未落地"时的最坏耗时（`timeoutMs + 5 s + 30 s = timeoutMs + 35 s`）——在**默认 `timeout_seconds=300`** 下必然倒挂：传输先超时，于是模型拿到 `kernel_died`（而不是 SPEC §4.7 规则 5/6 要求的 `exec_timeout`），并且 V2 新增的回收逻辑会**连带杀掉同一 sidecar 上其他 notebook 的 kernel**。
详细分析：
1. 主审核对的时间线：sidecar 在 `deadline` 到达时 `interrupt_kernel()` 并把 `interrupt_deadline` 设为 `now + 5.0`（`:200-207`）；到点后置 `status = "timeout"` 并 `break`（`:208-213`）；**随后**才进入 shell 回复循环，预算 `shell_deadline = now + 30`（`:249-254`）。最坏总耗时 = `timeoutMs + 35 s`。
2. 传输侧只给 `timeoutMs + 30 s`（小于 60 s 时用 60 s 下限兜住）。子代理用真 sidecar + 双 kernel 做了对照实验：`timeoutMs = 40 s`（传输 70 s，sidecar 最坏 75.1 s）→ **70.0 s 时传输判超时**，返回 `kernel_died: sidecar request timed out`，且 **k-a 与 k-b（另一个 notebook 的 kernel）同时消失**；对照组 `timeoutMs = 20 s`（传输 60 s ≥ 最坏 55.1 s）→ 55.1 s 正常返回 `status="timeout"`，两个 kernel 均存活。
3. 为什么现有测试没抓到：`[I5]` 用的是 4–6 s 的小超时，此时 **60 s 下限**主导（4+30=34 < 60），一切正常。也就是说这条倒挂**只在较大超时下出现，而 300 s 正是默认值**。
4. 后果有两个层次：① **错误码漂移**——"中断未落地"这一 SPEC §4.7 规则 5/6 明确命名的场景，默认配置下永远走不到 `exec_timeout`（好在 R3 的修复让 `kernel_died` 也会写回已完成 cell，数据损失面被兜住）；② **跨 notebook 连坐**——`#reclaimAfterTimeout`（`:333-345`）对"请求超时"一律 `#killTree()`，而一个 sidecar 按 interpreter 复用、可承载多个 notebook 的 kernel（`registry.ts` 的 `#transports` 按 `interpreterPath` 分），因此一次 `exec_cell` 超时会杀掉别人的 kernel，直接冲突 README 宣称的"不同 notebook 并行"。
5. **触发面比"exec 超时"更宽**：`#reclaimAfterTimeout`（`:292-300`/`:333-347`）挂在**所有** `#request` 超时上，包括 `kernel_status`（15 s）、`ping`（30 s）、`analyze`（60 s）——一次"慢但不卡死"的状态查询也会升级成"杀掉整棵 sidecar 树"。
修复建议（三者取其一或组合）：
```ts
// ① 让传输余量覆盖 sidecar 最坏路径：
const transportTimeout = Math.max(params.timeoutMs + 45_000, 60_000);
// ② 只对"卡死型"请求回收进程树（ping/kernel_status 连续超时），exec_cell 超时不杀树；
// ③ 把 sidecar 的 shell 等待压到传输余量以下（如 20 s），并在 SPEC 里写明这个不变式："传输余量 > sidecar 最坏耗时 + 余度"。
```
并补一条集成用例：`timeout_seconds` 取默认值附近（如 60 s）+ 不可中断的 cell，断言 `code === 'exec_timeout'` 且同 interpreter 上**另一个** notebook 的 kernel 仍存活。
设计文档对齐：违反 SPEC §4.7 规则 5/6 的错误码契约与 §5.3 的"不同 notebook 互不影响"；README「已知限制」宣称的并行性因此不成立。


【ROB-6】
严重程度：🟠 严重
所在位置：`src/kernel/registry.ts:110-113`（`#reuseKey`）、`:118`（`findByNotebook`）、`:341`（`acquireRun`）；对照 SPEC §5.3
问题描述：复用键与 run 锁的规范化只做 `normalizeForCompare`（分隔符统一 + win32/darwin 转小写），**缺 SPEC §5.3 明文要求的 `realpath`**，于是同一文件的两种拼写会各自建 kernel，且 run 级锁互不可见。
详细分析：
1. SPEC §5.3 规定复用键 `normalize = realpath 后再在 win32/darwin 转小写`；实现里 `#reuseKey` 与 `acquireRun` 都只用 `normalizeForCompare`（主审读码确认），`RunDeps` 已经把 `realpath` 注入 `run.ts` 却没传给 registry。
2. 子代理用 junction 实测：同一文件两种拼写 → `sessions = 2`、`startKernel calls = 2`（SPEC 期望 1）；`acquireRun(canonical)` 之后再 `acquireRun(viaLink)` **仍然成功**（期望 `kernel_busy`）。
3. 真实可达性高：macOS 上 `/tmp` 本身就是指向 `/private/tmp` 的符号链接（root 落在 `/tmp` 下时围栏给 `/tmp/...`、realpath 给 `/private/tmp/...`），Windows 的 junction / symlink / `subst` 同理；`--allow-outside-root` 时更多。
4. 后果：同一文件两个 ipykernel（第二个状态为空）；两个 run 可同时跑并各自写回，只被 `writeNotebookFile` 的 hash 复检挡下 → 用户看到莫名的 `file_changed`；`interrupt`/`shutdown`/`lastSeenContentHash` 只认一种拼写；`notebook_kernel status` 会列出重复 kernel。
修复建议：给 registry 注入 realpath（与 `PathFence` 同策略：失败则用原值），所有按路径查找/加锁共用同一规范化函数：
```ts
#norm(p: string): string {
  let real = p;
  try { real = this.#canonical(p); } catch { /* 目标不存在时沿用原值 */ }
  return normalizeForCompare(real, this.#platform);
}
```
设计文档对齐：**直接违反 SPEC §5.3**，且未登记 DEVIATIONS。

【ROB-5】
严重程度：🟠 严重
所在位置：`src/server.ts:72-75`（zod shape 无 `.max()`）、`src/mcp/context.ts:100-117`、`src/mcp/render/read.ts:42-44`
问题描述：`notebook_read.cell_indexes` 没有长度上限也不去重，同一索引可重复任意次，响应体积随**入参长度**线性放大。
详细分析：子代理 MCP stdio 端到端实测（5-cell notebook）：`cell_indexes` 重复 20000 次 → **5 663 335 字节**文本块（单 cell 约 280 B）；重复 3 次 → 1184 字节；基线 → 1750 字节。即 `Array(500000).fill(0)` 可产出 >100 MB → 烧 token（AGENTS §1 的验收标准明文"不烧 token"），也可能撞下游客户端的消息上限。SPEC §4.1.12 把"数组长度（如 ops 1..32）"列为**必须的服务端校验项**，`ops` 有 1..32 上限，`cell_indexes` 漏了。负值/越界校验本身正确（实测拒绝）。
修复建议：schema 加 `.max(1000)`，工具层去重排序后再校验长度：
```ts
const unique = cellIndexes === undefined ? undefined : [...new Set(cellIndexes)].sort((a, b) => a - b);
if (unique !== undefined && unique.length > notebook.cells.length) throw invalidArguments('cell_indexes', 'must not repeat indexes');
```
设计文档对齐：SPEC §4.1.12 漏项。

【ROB-1】
严重程度：🟠 严重
所在位置：`src/run.ts:678-694`（`combineAbortSignals`）、配合 `:304-316`、`:658-663`
问题描述：合并信号的 `forward` 监听器只在 signal 真的 abort 时才被 `{once:true}` 摘除；**正常完成**的 run 不摘除，于是长驻的 `kernelSignal` 上逐 run 累积监听器。
详细分析：`kernelAbort`（`:304`）每个 run 新建，但它被注册进 `registry.onRunAbort` 的闭包捕获（`:306-310`），闭包又引用挂在它上面的 `forward` → 整个闭包无法回收；同一 notebook 连续 N 次正常 run 后，该 signal 上累积 N 个监听器。Node 26 的 `AbortSignal` 不打印 `MaxListenersExceededWarning`（12 个 `addEventListener` 静默通过），因此表现为**无声的内存增长**。v2 的 W8 只修了 `mcp/tools/run.ts:75-84` 那一处，`run.ts` 这处是同类残留。
修复建议：让 `combineAbortSignals` 返回 `{ signal, cleanup }`，在 `runNotebook` 的 finally 链里 `cleanup()`（双向 `removeEventListener`，幂等）。
设计文档对齐：符合 R19"不留残留"的意图，当前只覆盖进程层未覆盖监听器层。

【ROB-7】
严重程度：🟡 警告
所在位置：`python/ipynb_sidecar.py:140-150`、`:46-58`；宿主侧 `src/kernel/sidecar-transport.ts:174-201`
问题描述：kernel connection file（含 HMAC key）只在 `shutdown_kernel` 正常走完时由 jupyter_client 删除；强杀路径（协议错误、请求超时回收、宿主崩溃兜底）下 Python 侧没有清理机会，文件永久残留。
详细分析：`jupyter_client/connect.py` 用 `tempfile.mkstemp(".json")` 生成 `tmp*.json`，删除只发生在 `cleanup_connection_file()`。子代理实测仓库根已有 7 个此类文件（内容确认为 connection file 且带 `"key"` / `"signature_scheme": "hmac-sha256"`），`.gitignore:30-32` 的 `tmp*.json` 条目正是这一现象的产物——也就是说"不在用户仓库里创建除备份与 artifact 之外的文件"（SPEC §5.9）目前依赖一个未文档化的 `.gitignore` 例外，且累积无上限。
修复建议：在 sidecar 侧接管生命周期——把 `km.connection_file` 记进 `KernelEntry`，在 `KernelEntry.shutdown()` 与 `atexit` / `main()` 的 EOF 分支里 `os.remove(...)`；若不想改行为，至少在 README「已知限制」写明强杀路径会残留 `tmp*.json`，并登记 DEVIATIONS。
设计文档对齐：SPEC §5.9"净结果"要求 + R19；未登记。

【ROB-9】
严重程度：🟡 警告
所在位置：`src/fs/atomic.ts:58-62`
问题描述：`pruneStaleTempFiles` 的 `readdir` 失败被**空 catch 吞掉**，无注释无日志——AGENTS §6 **R7 明令禁止**；同一函数 `:73-75` 的 catch 却规规矩矩调了 `onWarn`，自相矛盾。
详细分析：行为上"扫不到残留就跳过"是安全的（best-effort 清理），问题在于完全不可诊断：目录权限异常、被占用、路径变动都不会留下任何线索。
修复建议：
```ts
} catch (cause) {
  // Best-effort sweep: an unreadable directory must not block the write.
  onWarn?.(`could not scan ${dir} for stale temp files: ${String(cause)}`);
  return;
}
```
设计文档对齐：违反 AGENTS §6 R7 / §5"禁止空 catch"。

【ROB-10】
严重程度：🟡 警告
所在位置：`src/kernel/sidecar-transport.ts:96-103`（stderr 以 `debug` 级转发）、`:105`（`#exitReason`）、`:288`（`new IpynbError('kernel_died', reason)`，无 detail）
问题描述：解释器"能通过 `import ipykernel` 探测、但实际无法启动 kernel"时（真实世界最常见的首次失败形态），模型只拿到 `kernel_died: sidecar exited (code=1073741845, signal=null)`——真实原因（sidecar 的 stderr）只在 `debug` 级日志里，错误本身不带任何 detail 或提示。
详细分析（主审实验）：本机 `tests/.venv-test`（python 3.11.11 / pyzmq 26.2.0）即为此形态。主审用真实 sidecar 协议分别驱动两个解释器：
```
venv(3.11.11/pyzmq 26.2.0):  ping → ok;  start_kernel → stderr "Bad file descriptor (…epoll.cpp:73)" → EXIT code=1073741845（stdout 无任何消息）
base(3.10.14/pyzmq 25.1.1):  ping → ok;  start_kernel → {"pid":26752,...}  ✅
```
主审另用最小脚本确认该 venv 在**最基础的 zmq socket 往返**上就崩溃（与 ipynb-mcp 代码无关）——因此"环境问题、非产品 bug"的论断成立（已由 `COMPATIBILITY.md:21-29` 如实登记）。但产品侧的表现仍不合格：SPEC §5.2 的候选链只在**探测期**过滤（`python -c "import ipykernel"` 会通过），运行期失败既不降级到下一候选、也不把 stderr 尾巴交给调用方，SPEC §0"干净机器 ≤60 秒跑通第一个 cell"的失败诊断因此不可自助。
修复建议：在 `#failTransport` 时保留最近 N 行 stderr，并在 sidecar 携带未完成请求而死时把它并入 detail：
```ts
#failTransport(reason: string): void {
  this.#exitReason = reason;
  const tail = this.#stderrTail.join('\n');   // 环形缓冲，最近 20 行
  ... pending.reject(new IpynbError('kernel_died', reason, tail === '' ? {} : { sidecar_stderr: tail }))
}
```
同时把 stderr 转发从 `debug` 提到 `warn`（或在携带未完成请求时提升），并把 Windows NTSTATUS 退出码翻译成名字（`1073741845` → `STATUS_FATAL_APP_EXIT`）。
设计文档对齐：SPEC §5.2 的候选链语义（探测通过后运行期失败无降级）值得在 SPEC v3.1 明确；§0 的"零配置可用"承诺需要可用来自助的失败信息。

【ROB-12】
严重程度：🟡 警告
所在位置：`src/kernel/sidecar-transport.ts:320-331`（`#failTransport` 只置 `#exited` 不杀子进程）、`:155-158`（`shutdownAll` 在 `#exited` 时早退）、`:170-175`（`kill()` 同样早退）；`src/kernel/registry.ts:542-554`（`#forgetTransport` 把 transport 从 `#transports` 摘除）
问题描述：sidecar 异常退出后**结构上不存在回收通道**——`#failTransport` 只标记不杀，而 registry 随即把该 transport 从表里摘掉，于是 `shutdownAll` 再也触及不到它（子代理伪 transport 实测：旧 transport 的 `shutdownAll` 调用数 = 0）。
详细分析：这是 V4/A23 "异常退出也回收进程树"这句声明的字面缺口。**实际危害被上游机制抵消**：子代理真进程实验（`taskkill /F /PID <sidecar>`，不带 `/T`）显示 ipykernel 在父进程死亡后会自行退出（Windows ParentPoller / POSIX `getppid()==1`），因此未观察到孤儿。唯一结构上没兜住的是"stdio 报错但进程仍活"这一种（此时 sidecar 没死、kernel 不会自杀，而 transport 已失联）——该场景未被构造出来。
修复建议：二选一并写清楚：① 认定"进程已退出则无需回收"是正确设计 → 在 `#failTransport` 注释与 DEVIATIONS 里写明理由（**并说明退出后再按 pid 补刀有 pid 复用误杀风险**，这正是当前早退的安全价值）；② 若要回收，只在"尚未观察到子进程退出"时调用 `#killTree`。
设计文档对齐：SPEC §6 R19 的意图（不留孤儿）未被代码保证，靠运行时上游机制兜住；建议登记该取舍。

【ROB-13】
严重程度：🟡 警告
所在位置：`src/kernel/registry.ts:207-217`（`#probeKernel` 为 false 时只 `#removeSession`）、`:231-241`
问题描述：探活认为 kernel 已死时，只把 session 从表里摘掉，**不尝试关闭**该 kernel——若 `kernel_status` 抖动或说谎（sidecar 侧实现错误、进程瞬间不可达），一个活着的 kernel 会被永久遗忘（同 ROB-2 的形态）。
详细分析：与 ROB-2 的区别是触发源在 sidecar 的答复而非 registry 的顺序错误；`#probeKernel` 已在查询失败时保守返回 true（`:235-240` 注释写明"unanswerable query is not proof of death"），所以只有"答复明确说 false 但实际还活着"才会踩中——属于防御性缺口，而非可达缺陷。
修复建议：探活判定为死时，`try { await session.transport.shutdownKernel(session.kernelId) } catch { /* 已经死了：忽略 */ }` 再做摘除。
设计文档对齐：R19 的对称要求。

【ROB-14】
严重程度：🟡 警告
所在位置：`src/run.ts:213`（mode 判定用的 `hasLiveKernel`）与 `src/kernel/registry.ts:207`（`getOrCreate` 的 `#probeKernel`）
问题描述：一次 `notebook_run` 会做**两次** `kernel_status` 探测（各一次 sidecar 往返），且两次结论可能不同：若 kernel 死在两次探测之间，run 已按 `resume` 语义选定模式，却在新 kernel 上执行——**模式静默漂移**（`resume` 的语义是"复用活 kernel 的既有状态"）。
详细分析：窗口极小（毫秒级），但后果是"以为在续跑、其实在空 kernel 上跑"，属静默语义漂移；两次探测本身也是每次 run 的固定额外延迟。
修复建议：把一次探测的结果同时用于 mode 判定与 `getOrCreate`（例如让 `getOrCreate` 返回"是否复用了既有 session"，mode 判定改为读该结果），或在模式判定后把 kernel 标记为"已确认存活"传给 `getOrCreate` 以跳过第二次探测。
设计文档对齐：SPEC §4.7 的 mode 矩阵语义。

【H-7 / DOC-1】
严重程度：🟢 建议（两项）
所在位置：`.gitignore`；`docs/DEVIATIONS.md`（D-018~D-021 之后）
问题描述：① `.gitignore` **缺 `__pycache__/`**——主审与子代理跑测试后工作树均出现未跟踪的 `python/__pycache__/ipynb_sidecar*.pyc`；② 本轮有三处**设计取舍未登记 DEVIATIONS**：V2 的"请求超时即回收整棵 sidecar 树"、R3 的"`cellInFlight` 门只覆盖在途 cell 死亡"、V3 的"失败路径写回故意不响应取消"（v2 报告明确要求登记），以及 R2 的"运行期未处理拒绝不再自杀"（这是有意的语义变更）。
详细分析：DEVIATIONS 是本项目"偏离必须留痕"的唯一机制（SPEC §6 R20 / AGENTS §0），本轮新增的 D-018~D-021 质量很好，但上述四处取舍直接改变了错误码与生命周期语义，属于最需要留痕的一类。
修复建议：补 `.gitignore` 一行 `__pycache__/`；在 DEVIATIONS 追加四条（或并入现有条目），每条写清现象/取舍/影响面。
设计文档对齐：SPEC §6 R20。



### 维度 4：性能与资源效率

【PERF-1】
严重程度：🟠 严重
所在位置：`src/kernel/protocol.ts:45-72`（`:46` `Buffer.concat([this.#buffer, chunk])`）
问题描述：NDJSON 分帧每收到一个 chunk 就把整个累积缓冲**全量重拷**，而 SPEC §5.8 允许单行达 64 MiB（D-017 已承认合法响应可以很大）→ 单条大行的复杂度是 O(L²/chunk)。
详细分析：子代理实测（纯 `push()`，不含 JSON.parse）：8 MiB 行 142 ms；32 MiB 行 2569 ms；**64 MiB 行 9442 ms**（同数据 1 MiB chunk 仅 631 ms，15× 差）。Windows 匿名管道实测按 ~64 KiB 分片交付，因此一个 20 MB PNG（base64 ≈27 MB）的单次 `exec_cell` 响应就要 ~1.7 秒纯拷贝，D-017 允许的 64 MiB 响应会让 stdio server 卡死近 10 秒——阻塞主线程即"模型完全无响应"，还会拖慢并发的 tools/call。内存侧 `external` 峰值 194 MiB。
修复建议：改为 chunk 列表累积 + 仅在发现 `\n` 时拼接，并把上限判定前移：
```ts
push(chunk: Buffer): string[] {
  if (this.#pending + chunk.length > MAX_LINE_BYTES && this.#buffer.indexOf(0x0a) < 0) {
    throw new ProtocolFramingError(`sidecar line exceeds ${MAX_LINE_BYTES} bytes (protocol error)`);
  }
  this.#chunks.push(chunk); this.#pending += chunk.length;
  ... // 找到 '\n' 时对涉及的 chunk 做一次 concat 切片
}
```
设计文档对齐：不改变 SPEC §5.8 的"单行"判定语义，属纯实现优化；与 D-017 暴露的大响应场景直接相关。

【PERF-2】
严重程度：🟡 警告
所在位置：`src/core/outputs.ts:107-164`（`:108-110` 先解码再判 `maxImageBytes`）、`:202-214`（`decodeBase64` 产生 3 份副本）、`:139`/`:161`（对所有图片做 SHA-256）
问题描述：`max_image_bytes` 判定发生在 base64 **解码之后**，且即使 `returnImages === false`（`images=never` / `include_outputs=summary`）也照样全量解码 + 哈希。
详细分析：子代理实测（summary + auto，图片既不返回也不物化）：`images=1×4MiB` → render 18 ms、heap +4 MiB；`images=6×4MiB`（notebook JSON 32 MiB）→ render 79 ms、RSS +32 MiB，而最终 payload 仅 1 KiB、`imageBlocks=0`。单张图瞬时峰值 ≈ `base64 + 3/4·base64 + 3/4·base64 ≈ 2.5×` 原图。
修复建议：用 base64 长度做廉价预筛并把"是否需要物化"前移：
```ts
const approxBytes = Math.floor((base64.replace(/\s+/g, '').length * 3) / 4);
if (approxBytes > options.maxImageBytes) { /* 直接 unsupported，不解码 */ }
```
设计文档对齐：与 §4.3"不返回图片块时不得物化图片"红线同向；结果不变，属效率优化。

【PERF-3】
严重程度：🟡 警告
所在位置：`src/core/stale.ts:66-74`、`:97-104`；`src/run.ts:575-584`（`codeCellIndexes.indexOf(i)` 的显式 O(n²)）
问题描述：stale 分析的"每个受检 cell 回扫 `0..j` 并在内层做 `defs.some(name => uses.includes(name))`"与 run 里的 `indexOf` 映射都是 O(n²)。
详细分析：子代理实测（每 cell 一 def 一 use）：500 cell 2.3 ms → 2000 cell 9.6 ms → 4000 cell 41.3 ms → **8000 cell 179.7 ms**（4000→8000 为 4.4×，确认平方级）。同规模下 parse 6 ms / serialize 3 ms / selfcheck 6 ms，`analyzeStale` 是唯一的非线性项。SPEC §8 与验收数据把"10 MB+ JSON、数千 cell"列为目标场景。
修复建议：`run.ts` 一次正向扫描建 `Map<cellIndex, codePosition>`；`stale.ts` 维护"名字 → 最新定义它的已执行 cell"倒排表，把内层降为 O(|U(j)|)：
```ts
const latestDefiner = new Map<string, number>();
for (let i = 0; i < cell.cell_index; i++) if (executed.has(i)) for (const d of defs[i] ?? []) latestDefiner.set(d, i);
```
设计文档对齐：纯等价改写，判定结果不变（SPEC §5.6）。

【PERF-4】
严重程度：🟢 建议
所在位置：`src/kernel/registry.ts:149-177`（`:150-151` 注释）
问题描述：v2 W8 把 N 个 `kernel_status` 查询改为 `Promise.all`，注释称"N sessions answered serially cost up to N x 15s"；但 N 个请求落在**同一个 sidecar**，其收益是消除排队而非真正并行，注释与收益不匹配。
详细分析：N 由"不同 interpreter/kernelspec 组合数"决定，正常为 1–3；`Promise.all` 在这台机器上不会造成问题，只是描述失真。
修复建议：把注释改为"避免 N 次串行往返的排队延迟"；若要严格限流，用手写信号量限 4 路。
设计文档对齐：SPEC 未定义该工具时延要求。

### 维度 5：安全性

【SEC-1】
严重程度：🟡 警告
所在位置：`src/server.ts:70-85`、`:118-130`（zod shape 无 `.strict()`）；`src/mcp/tools/read.ts:23-27`
问题描述：未知 MCP 参数被 SDK 的 zod 静默剥离，工具层也不检查 → 参数名写错时按**默认值**执行而不报错。
详细分析：子代理端到端实测：把 `cell_selector`（run 的参数名）误传给 `notebook_read` → **无错误、无 warning**，读回全部 5 个 cell（1750 B，与基线逐字相同）。SPEC §4.1.11 专门为"两个选 cell 的参数名必须不同"立了强制条款，理由正是"模型在连续调用中写错会白白浪费一轮往返"；当前实现把"写错名字"变成"静默按默认值执行"，比浪费一轮往返更糟——模型拿到它没要的 cell，且不知道自己传错了。
修复建议：工具层显式拒绝未知字段（不改返回字段，只加校验）：
```ts
export function rejectUnknown(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw invalidArguments(key, 'unknown argument');
}
```
设计文档对齐：不违反 §4.1.11 的字面（它只要求名字不同），但未落实其防护目的；建议作为改进项登记。

【SEC-2】
严重程度：🟡 警告
所在位置：`src/mcp/tools/result.ts:45-51`（`:49` `detail: { stack: String(cause.stack ?? cause.message) }`）
问题描述：任何非 `IpynbError` 的意外异常，其**完整堆栈**（含服务端源码行与绝对路径）都会进入模型可见的 `detail`。
详细分析：`detail` 是模型可见字段。堆栈至少携带源码绝对路径、出错行源码片段与依赖包布局。SPEC §5.10 只禁止把 cell 源码/输出写进**日志**，因此这不是违规；但它是唯一会把服务端内部结构交给模型与客户端日志的通道，"路径可接受、源码行不必要"。
修复建议：只回 `name + message`，堆栈留给 stderr：
```ts
const detail: JsonValue = { error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) };
deps.logger?.warn(`unexpected internal failure: ${cause instanceof Error ? String(cause.stack) : String(cause)}`);
```
设计文档对齐：不违反 SPEC（未新增错误码、未改返回字段集合），属信息最小化。

**维度 5 阴性结论（已验证，逐项列出以说明覆盖面）**：
- **路径遍历**：`PathFence` 真实实现跑了 19 例绕过矩阵，**全部按预期拒绝或放行**——`../outside`、`sub/../../outside`、`C:/Windows/win.ini`、`//server/share/...`（UNC）、`\\?\C:\Windows\win.ini`、`\\?\<root>\nb.ipynb`、`/nb.ipynb`、junction 逃逸（`link/secret`）、大小写变体；artifact 与备份文件名由整数索引 + sha256/sha1 + 固定扩展名拼成，**不含任何用户可控字符串**。
- **命令注入**：全部进程创建走参数数组、无 `shell: true`（`spawn(interpreter, ['-u', sidecarPath])`、`spawn('taskkill', ['/T','/F','/PID', String(pid)])`、`execFile(cmd, ['-c', ...])`）。
- **`analyze` 绝不执行代码**：`python/ipynb_sidecar.py:319-338` 只用 `symtable.symtable(source, "<cell>", "exec")`（第三参数是编译模式名），子代理用真实 Python 调用确认只返回名字集合；唯一的代码执行路径是 `op_exec_cell` 交给 ipykernel（产品既定功能）。
- **敏感信息**：全仓 grep `password|api[_-]?key|secret|private key|ghp_|npm_<36>|BEGIN RSA|Bearer` 仅命中 `progressToken` 变量名；日志只接字符串且不含 cell 源码/输出（`src/log.ts` 是唯一出口，sidecar 的 `send_log` 调用点只含 kernel_id 与异常摘要）。
- **反序列化**：三处 `JSON.parse` 输入端分别受 SDK 校验、try/catch →`parse_failed`、try/catch→warn 保护；depth 60000 的 JSON 与 `__proto__` 键实测均无崩溃/污染。
- **6 个工具的入口校验链路**逐个核对：`wrap()`（`server.ts:29-37`）包住全部 handler，`assertWritableAllowed`（`:184-187`）与各 handler 自身守卫形成双保险，**没有"假设上游已校验"**；`notebook_kernel` 的 `status` 在只读下放行、其余 action 抛 `read_only_mode`。

### 维度 3 补充：既有行为中的其他加固（阴性）

- **60 处 `catch` 逐条读过**：真正"什么都不做"的只有 4 处 `catch {}`——`fs/atomic.ts:36`（注入式 `stat` 的"不存在→null"语义）、`fs/atomic.ts:60`（**已单列为 ROB-9**）、`fs/fence.ts:98`/`:115`（realpath 失败→向上找存在祖先，是该算法控制流本体）。其余全部满足 R7（转错误码上抛或记 warn）。唯一"产出物不足"的是 `run.ts:559` 的 `catch { degraded = true; }`：`analyze` 失败原因丢失，只留 `stale_analysis_degraded` warning（语义正确，可诊断性弱）。
- **参数校验/类型混淆**：端到端 8 例 + `fieldType` 矩阵 7 例（`cell_index` 传 `"0"`/`-1`/`1.5`/`null`/`true`/`[]`/`{}`）全部按 SPEC 拒绝。
- **资源与定时器**：`registry` 的 `setInterval` 有 `unref()` 且 `stop()` 在 `shutdownAll` 内；`#waitExit` 超时分支摘掉 `once('exit')`；`atomic.ts` 的 `open`/`close` 在 `finally`；未发现文件句柄泄漏。
- **sidecar 协议健壮性**：非法 JSON → warn 继续；未知 op → `internal`；缺失字段 → `handle_request` 兜住；kernel 崩溃 → iopub 轮询 `is_alive()` 并 `send_kernel_died`；iopub 等待有界（`min(wait, 5.0)`）。

### 维度 1、2、7：架构、代码质量、依赖与配置

【ARCH-1】
严重程度：🔴 阻塞
所在位置：`src/mcp/render/read.ts:214-257`（`normalizeRawOutput`）；同类较轻处 `:153`（`doc.nbformat_minor >= 5` 自判 `has_stable_cell_ids`）、`src/mcp/tools/run.ts:63,68-71`（在 mcp 层过滤 `cell_type === 'code'`）
问题描述：**mcp 层自己解析 nbformat 输出结构**——`normalizeRawOutput()` 读 `output_type`/`data`/`text`/`name`/`ename`/`evalue`/`traceback`/`metadata` 并组装 `RawOutput`（该类型定义在 `src/core/outputs.ts`），违反"`src/mcp/*` 禁止解析 notebook 语义"。
详细分析：主审已读全文确认（`read.ts:220` 是 `src/` 内**唯一**读 `output_type` 的地方，即 core 侧根本没有对应转换器）。AGENTS §4 模块铁律与 SPEC §4.1.1（"转换只发生在 `parse.ts` 边界"，D15）都被绕过；后果有三层：① nbformat 结构知识出现在 mcp 层，未来格式演进要改投影层；② 该函数内含**静默语义决策**——`:229-233` 只保留 `typeof value === 'string'` 的 `data` 值，而 nbformat 允许多行字符串写成数组（对比 `:237-239` 对 `text` 数组做了 join）→ **`data['text/plain']` 为数组时该输出被静默丢弃**，两条分支对同类形状的处理自相矛盾，且这条决策在 core 层无法被单测覆盖；③ 未登记 DEVIATIONS。
修复建议：把转换器整体上移到 core（`export function rawOutputsOfCell(cell): RawOutput[]`），mcp 侧只留一行调用；`has_stable_cell_ids` 同样改为 `core/parse.ts` 的 `hasStableCellIds(doc)`；数组形式的 `data` 值按 nbformat 语义 join 而不是丢弃。
设计文档对齐：**否** —— 违反 AGENTS §4 模块铁律与 SPEC §4.1.1；未登记。

【ARCH-2】
严重程度：🟠 严重
所在位置：`src/kernel/interpreter.ts:408`（模块级 `const sharedProbeCache = new Map<string, boolean>()`），注入点 `:436`
问题描述：`ipykernel` 探测结果缓存在模块级可变状态里且**永不失效**（全仓无任何 `delete`/`clear`），违背 AGENTS §4"可变状态只允许存在于 `KernelRegistry` 与 run-store 的 run 表"，并与 SPEC §5.2/D23"每次解析候选链"的语义不符。
详细分析：主审已确认该 Map 只有声明与注入两处引用，无失效点。行为后果非常具体：我们的错误信息本身就会引导用户执行 `pip install ipykernel`（README:66 写明"with a ready-to-run `pip install ipykernel` command"），但用户照做之后，**同一解释器路径的 `false` 结论仍然生效**，`notebook_run` / `notebook_kernel start` 会一直报 `ipykernel_missing`，**必须重启 MCP server 才能恢复**——即"照错误提示修复后仍然失败"。
修复建议：给缓存加 TTL（如 30 s）+ 失败时不缓存，或在抛出 `ipykernel_missing` 前清掉本次命中项；若刻意保留永久缓存，必须登记 DEVIATIONS。
设计文档对齐：**否** —— 违反 AGENTS §4 与 SPEC §5.2/D23 的"每次解析"语义；未登记。

【ARCH-3】
严重程度：🟡 警告
所在位置：`src/fs/notebook-file.ts:85`（`const writeLocks = new Map<string, Promise<unknown>>()`）、`lockKey()` 使用 `process.platform`（`:87-89`）
问题描述：这是第二处 AGENTS §4 禁止的模块级可变状态（D-014 只登记了"per-path 写互斥"这个**行为**，没登记它引入的状态），且 `lockKey()` **忽略已注入的 `options.platform`**，用 `process.platform`。
详细分析：`writeNotebookFile` 的签名里就有 `WriteOptions.platform`（同一函数后面还在用它做原子写决策），锁键却读全局——在 win32 上以 `platform: 'linux'` 跑单测时语义不一致；现有 W7 用例恰好靠平台折叠才通过，属"注入项未贯穿"的复发形状（v2 的 C6d 修过同类）。
修复建议：`withPathLock(absolutePath, platform, fn)` 由调用方传入 `options.platform ?? process.platform`；并在 DEVIATIONS 补一句"§3.3.1 例外：fs/notebook-file.ts 的 per-path 写锁表"。
设计文档对齐：**部分否** —— 行为已由 D-014 覆盖，状态位置与 platform 贯穿未登记。

【ARCH-4】
严重程度：🟡 警告
所在位置：`src/kernel/interpreter.ts`（406 行）；`docs/DEVIATIONS.md` D-011 的清单
问题描述：`src/kernel/interpreter.ts` 不在 SPEC §8 的 kernel 目录穷举清单里，D-011 的"新增 5 个文件"也不含它，只在 D-016 的"影响面"里被顺带提到——属**未登记的结构性偏离**（SPEC §6 R20 要求偏离必须登记）。
详细分析：审阅者按 SPEC §8 核对时会认为 kernel 层只有 4 个文件；实际多出一个 406 行、承担候选链 + 探测 + 缓存的模块。同类的 `mcp/tools/run-status.ts` 落在 `tools/*` 通配内，不算问题。
修复建议：追加一条 D-022 登记该文件及其存在理由（解释器候选链需要同时触碰 fs/进程/缓存，放进 registry 会让注册表承担解释器解析）。
设计文档对齐：**否**（未登记）；实现本身符合 §5.2/D23。

【ARCH-5】
严重程度：🟡 警告
所在位置：`AGENTS.md:88-97`（§4 仓库结构）
问题描述：仓库的 `AGENTS.md` §4 目录树**仍未与实际同步**（v2 的 B3 遗留）：仍列 `progress.ts` / `model` / `lock`，缺 `src/run.ts`、`hash.ts`、`fs/markdown-targets.ts`、`fs/notebook-file.ts`、`mcp/context.ts`、`mcp/tools/result.ts`；D-007~D-011 已登记偏离，但"给后续 agent 看的地图"没更新。
详细分析：`AGENTS.md` 是本仓库面向 AI agent 的工作规范（与 SPEC 不同，它可以改）。地图与实物不符会让后续 agent 按错误路径建模，且"违反即回退"的模块铁律失去了可核对的清单。
修复建议：把 §4 的树按 `git ls-files src` 重写一次，并在 §4 末尾加一句"本树以 `src/` 实际结构为准，偏离见 `docs/DEVIATIONS.md` D-007~D-011"。
设计文档对齐：AGENTS 内部一致性问题（非 SPEC 偏离）。

【ARCH-6】
严重程度：🟠 严重
所在位置：`src/run.ts:169-664`（`runNotebook` 单函数约 **496 行**）；`src/kernel/registry.ts` 650 行 / `src/core/edit.ts` 614 行（`applyEditOps` 219 行）
问题描述：核心编排函数 `runNotebook` 一个函数内串了"解释器解析 → getOrCreate → 取 run 锁 → 回放前缀 → 执行循环 → 图片物化 → stale 分析 → 写回 → 三类终态错误"共约 10 个阶段，圈复杂度与阅读成本都偏高（文件共 746 行）。
详细分析：这不是功能性缺陷（各阶段边界清晰、注释到位），但它直接放大了本轮 ROB-8 那类"新增分支绕过既有终态路径"的风险——两条终态路径相距 100+ 行、语义又必须严格一致。`registry.ts` 的 `getOrCreate`/`execCell`/`shutdownAll` 也有类似倾向。
修复建议：把三个自洽块抽成同文件内的私有函数（不改公共 API、不改行为）：`executeCells(...)`（含快照/清空/中断语义）、`materializeRunImages(...)`、`computeStaleReport(...)`，并让 `finishAborted`/`finishTimedOut` 共用同一个 `finalizeRun(...)`，从结构上消除"两条终态路径"。
设计文档对齐：SPEC 未规定文件/函数规模；AGENTS §10"不要顺手重构"只约束**无关**重构，此处属可维护性改进，建议与 ROB-8 同批做。

【QUAL-1】
严重程度：🟠 严重
所在位置：`src/run.ts:422-495`（**整段**比正确缩进浅一级：for 体应为 8 空格实为 6，`:495` 的 `}` 为 4 应为 6），另 `:658-663` 的嵌套 `finally` 边界
问题描述：本轮提交 `f7bb82e` 留下两处**缩进错乱**（`:421` 的 `kernelAbortState.cellInFlight = false;` 少缩一层；`:660` 的 `}` 比同级多缩一层），使控制流在阅读时极易误判。
详细分析：语法有效、行为正确，但 `:658-663` 是两个嵌套 `finally` 的边界，缩进错乱恰好出现在最需要一眼看清结构的位置。工具链里**没有任何格式化器**（devDependencies 仅 `@types/node`/`oxlint`/`typescript`/`vitest`，`lint` 只跑 oxlint 不做格式检查），因此这类痕迹只能靠人眼发现——上一轮的 `patch-tmp.py` 脚本改码就是同类成因（本轮已无脚本，但手改同样留下了痕迹）。
修复建议：加 `prettier`（或启用 oxlint 的格式规则）并 `--check` 进 CI；至少先把这两处对齐。
设计文档对齐：AGENTS §5"编码规范"未含格式化条款，建议补一条。

【QUAL-6】
严重程度：🟡 警告
所在位置：`src/fs/atomic.ts:74`、`:145-147`、`:165-166`（消息自带 `[ipynb-mcp] warn ` 前缀 + 一处物理换行）；`src/log.ts:48`（`Logger` 自身输出 `[ipynb-mcp] <ts> <level> <msg>`）
问题描述：这三处 warn 文案硬编码了前缀与级别，而生产路径注入的 sink 是 `logger.warn`（`run.ts:625`/`:772`、`edit.ts:83`）→ 实际输出**双前缀双级别**：`[ipynb-mcp] 2026-… warn [ipynb-mcp] warn directory fsync failed for …`。
详细分析：前缀是为"未注入 logger 时的 `process.stderr.write` 兜底"准备的（`:145`/`:165`），但当 logger 存在时就成了噪音，且是用户贴 issue 时最容易引起困惑的形态。AGENTS §5 要求日志一律经 `src/log.ts`。
修复建议：消息里去掉前缀，由兜底 sink 负责加：`const sink = options.onCleanupError ?? ((m) => process.stderr.write(\`[ipynb-mcp] warn ${m}\n\`))`。
设计文档对齐：AGENTS §5 日志条款。

【QUAL-3】
严重程度：🟡 警告
所在位置：`src/mcp/render/read.ts:45-46`、`:117`（W4 修复留下的死变量）；`tsconfig.json:12-14`（缺 `noUnusedLocals`/`noUnusedParameters`，门禁抓不到）
问题描述：W4 的修复把 `maxImages` 改为绝对 cap 后，`imageBudget` 变量（`:45-46` 初始化、`:117` 递减）成了死代码，却没有任何门禁能发现——`tsconfig.json` 开了 `strict`/`noUncheckedIndexedAccess`/`noImplicitOverride`，但**没有 `noUnusedLocals`/`noUnusedParameters`**。
详细分析：死代码本身无害，但它会让下一个读代码的人以为预算仍在按"剩余量"计算（正是 W4 当初的 bug 形态）。子代理已确认删除该变量不影响行为。
修复建议：删掉 `imageBudget`；在 `tsconfig.json` 打开 `noUnusedLocals` + `noUnusedParameters`（若担心测试夹具，可只在 `tsconfig.json`（src）开启）。
设计文档对齐：SPEC 无相关条款；属工程加固。

【ARCH-7】
严重程度：🟢 建议
所在位置：`src/fs/artifact.ts:144-159`（`shouldReturnImages`）；消费方 `src/mcp/render/read.ts:9,88`、`src/run.ts:11,428`
问题描述：SPEC §4.4 的图片返回策略（`auto/never/always` × `outputsFull`）住在 fs 层，导致 mcp 与根层为问一个布尔值而 import fs 模块。
详细分析：`shouldReturnImages` 是纯产品策略（无 I/O），与"物化"同文件才被误置；`fs/*` 的定位是"唯一做 I/O"，策略上移不改变任何行为。
修复建议：`ImagesPolicy` + `shouldReturnImages` 移到 `src/core/outputs.ts`；`fs/artifact.ts` 只保留 `applyImagePolicy` 并 `import type`。
设计文档对齐：无明文冲突，属分层整洁性。

【QUAL-2】
严重程度：🟡 警告
所在位置：`src/log.ts:13`（`isLogLevel`）、`src/kernel/protocol.ts:80`（`isSidecarResponse`）、`src/mcp/context.ts:25`（`fieldPath`）、`src/fs/backup.ts:124`（`backupPathDetail`）、`src/mcp/tools/run.ts:260`（`export { cellSource }`）、`src/mcp/tools/edit.ts:20-28`（`isAbortCause`）、`src/core/stale.ts:26`（`StaleAnalysisResult`）
问题描述：7 处死导出/重复实现，全仓（含 tests）零引用。
详细分析：`isSidecarResponse` 零引用，而 `sidecar-transport.ts:244` **内联重写**了同一判据（死代码 + DRY 违规，将来会漂移）；`edit.ts:20` 的 `isAbortCause` 与 `run.ts:701-709` 几乎逐行重复（后者多一个 `signal.aborted` 前置），两份实现的语义差异是潜在 bug 面。
修复建议：删除 5 个未引用导出与 1 行 re-export；`sidecar-transport.ts:244` 改用 `isSidecarResponse`；`isAbortCause` 只保留一份。
设计文档对齐：AGENTS §5 死代码禁令同类。

【QUAL-4】
严重程度：🟡 警告
所在位置：errno：`src/fs/notebook-file.ts:194-199`、`src/fs/atomic.ts:170-184`、`src/fs/backup.ts:68`、`src/fs/artifact.ts:107`、`src/kernel/interpreter.ts:388`；warning 去重：`src/core/edit.ts:597-601`、`src/run.ts:201,442,531,565`、`src/mcp/render/read.ts:134`、`src/kernel/interpreter.ts:214-218`；写回选项块：`src/run.ts:612-626` ↔ `:763-773`
问题描述：五类逻辑各被手写 4~6 份，是本仓最集中的 DRY 债务。
详细分析：① errno 有 3 个私有 helper + 3 处裸 `(cause as NodeJS.ErrnoException).code === '…'`；② "warning 只推一次"有 4 种实现（`pushOnce`/`warnings.some`×4/`pushMismatch`/`limitWarned` 状态机），`image_limit` 去重在 `fs/artifact.ts:87-93` 与 `render/read.ts:108-115` 各写一遍；③ 图片游标协议在 run 侧与 read 侧各实现一次；④ **两处 `writeNotebookFile` 的 6 选项块只有 `signal` 不同**——最坏的漂移形状（将来加选项容易只改一处，正是 ROB-8 的成因土壤）；⑤ `file_changed` 六行样板重复 4 次。
修复建议：新增 `src/fs/errno.ts`（`errnoOf`/`isLockError`/`isErrno` 唯一实现）与 `core/errors.ts` 的 `pushWarningOnce`；`run.ts` 用 `writeOptions(signal?)` 工厂函数消掉重复块。
设计文档对齐：无明文冲突，属可维护性；建议单独提交。

【QUAL-5】
严重程度：🟡 警告
所在位置：`src/fs/backup.ts:75-77`
问题描述：`throw new Error('could not find a free backup name …')` 抛的是**裸 `Error`**，违反"只抛 `IpynbError`"。
详细分析：主审已确认（`grep 'throw new Error('` 在 `src/` 仅两处，另一处 `sidecar-transport.ts:304` 在局部 try 内立即包装成 `kernel_died`）。传播链 `createBackup` → `writeNotebookFile`（只转换 lock 类）→ `runTool` → **`internal` + "unexpected internal failure"**：本该可诊断的备份命名冲突（并发编辑的极端场景）丢了 detail。
修复建议：改为 `throw new IpynbError('internal', …, { path, attempted, timestamp })`。
设计文档对齐：违反 AGENTS §5 错误规范（R7 未违反，错误没被吞）。

【QUAL-7】
严重程度：🟡 警告
所在位置：`src/core/edit.ts:492-497`（不可达分支）、`:640-659`（死参数 + `void opIndex;`）、`:609-611`（一行包装）、`:558-559`（重复计算）、`src/kernel/interpreter.ts:245-247`（死参数）
问题描述：一组"活着但永不生效"的形状，重构后未清理。
详细分析：`lastTouchedCell()` 的 `insert_cell` 分支不可达（唯一调用点 `:313` 已排除该 op），且它对同一 op **第二次**调用 `locate()`（含 `cell_id` 线性搜索）——每个非结构性 op 都多付一次解析；`trackMarkdownWrite(..., opIndex, _warnings)` 两个参数无用而 6 个调用点仍传；`defaultSpecName(_deps)` 恒返回 `'python3'`；`truncateText(currentSource)` 在大源码时算两遍。
修复建议：删 `lastTouchedCell` 并复用循环内已解析的 cell；去掉死参数；内联 `opIndexOfCell`；缓存 `truncateText` 结果。
设计文档对齐：AGENTS §5 无用代码禁令同类。

【QUAL-8】
严重程度：🟠 严重
所在位置：`src/mcp/tools/run-status.ts:51-72`（`:65` 的 `sleep(50)`）
问题描述：`notebook_run_cancel` 用"`abort()` + 等 50 ms"赌状态收敛，**可能返回 `state: "running"`**，而 SPEC §4.8 给该工具规定的返回枚举是 `"cancelled" | "completed" | "failed"`。
详细分析：主审已读原文确认。SPEC §4.8.1 强制"该 run **立即**转为终态（不阻塞等待在途 cell 结束）"。对照两条路径：**做对的一侧**是 `mcp/tools/kernel.ts:52-68`（同步置 `abortReason` + `abort()` + 立即写 `state='failed'`/`error`）；**欠缺的一侧**是这里——state 仍由后台任务在 in-flight `execCell` 解开后才写（`tools/run.ts:214-219`）。而取消要经 `interrupt` 走一次 sidecar 往返（sidecar 还有 5 s 中断宽限），50 ms 远远不够 → 越界枚举值可达；且没有任何测试断言 cancel 的返回 state（grep `kernel_shutdown` 无测试命中）。
修复建议：按 SPEC §4.8 规则 1 立即置终态并删除 sleep：
```ts
handle.abortReason = 'cancelled';
handle.abortController.abort();
handle.state = 'cancelled';
handle.error = { code: 'cancelled', message: 'run cancelled by the client' };
void ctx.registry.interrupt(handle.notebookPath).catch((c) => ctx.logger.warn(…));
```
设计文档对齐：**违反 SPEC §4.8/§4.8.1**；与 kernel 工具路径的既有正确实现不一致。

【QUAL-9】
严重程度：🟡 警告
所在位置：`src/kernel/sidecar-transport.ts:125,129,136,148,152`（5 处 `as unknown as Promise<XxxResult>`）
问题描述：sidecar 的 JSON 结果**不做任何运行时形状校验**就断言成强类型——D-021 修掉的"字段名不匹配导致失败索引被静默丢弃"正是这一机制造成的，而机制仍在。
详细分析：`#request()` 返回 `Record<string, unknown>`；若 `exec_cell` 少发 `rawOutputs`，`run.ts:422` 的 `mapRawOutputs(undefined)` 抛 TypeError → `internal`（detail 只有 stack）；若 `analyze` 的 `failedCellIndexes` 再拼错，会静默变 `undefined` → `analysis.ok` 仍为 true → 采用被污染的 AST 结果（违反 SPEC §5.6.1 的降级前提）。AGENTS §5 只禁 `any`/`as any`/`@ts-ignore`，故这是"合规但危险"。
修复建议：给每个 op 加 5–10 行形状守卫（如 `expectExecCellResult`），至少先覆盖 `analyze`（D-021 的回归面）。
设计文档对齐：不违反字面规则，但违反 §5.8 降级路径的可用性前提。

【QUAL-10】
严重程度：🟢 建议
所在位置：`src/run.ts:4`、`src/core/edit.ts:44`、`src/fs/notebook-file.ts:1-3`、`src/kernel/interpreter.ts:365-368`、`src/config.ts:240`、`.gitignore`（`tmp*.json` 段注释）
问题描述：6 处过时/误导注释，其中 2 处会让读者对行为作出错误判断。
详细分析：`run.ts:4` 的 "exposed to MCP tools in **step 9**" 与 `edit.ts:44` 的 "wired in **step 5**" 是施工期措辞（功能早已接线）；`notebook-file.ts:1-3` 的 "only moves bytes" 不实（它决定 `file_changed`/`notebook_locked`、做写前复检与备份编排）；`interpreter.ts:365-368` 的注释错位贴在 import 之上（`config.ts:240` 同样是文件中部 import）；**`.gitignore` 里"jupyter_client 默认落在 cwd"的因果是错的**——`connect.py:89` 是 `tempfile.mkstemp(".json")`（走 `gettempdir()`），cwd 只是 Python 候选列表的最后一档兜底；这条错误注释正是把 DEP-1 的真实泄漏当成"测试痕迹"放过的原因。
修复建议：删掉施工期措辞与不实描述；中部 import 移到文件头；`.gitignore` 注释按 DEP-1 的实测因果改写。
设计文档对齐：AGENTS §5"只写为什么"+ 禁止过时描述。

【DEP-1】
严重程度：🟠 严重
所在位置：`python/ipynb_sidecar.py:9-11,120,140`（无连接文件清理）、`src/kernel/sidecar-transport.ts:76-84`（spawn 未固定 cwd）；`.gitignore` 的 `tmp*.json`；DEVIATIONS 缺登记
问题描述：jupyter_client 的 kernel connection file 会被写进**服务进程的工作目录**（当解释器的 temp 目录不可用时即用户的项目目录）且**永不删除**——连接文件里带 kernel 的 HMAC `key`。
详细分析（主审亲验 + 子代理补充）：① 主审实测 `tests/.venv-test/Scripts/python.exe -c "import tempfile;print(tempfile.gettempdir())"` → **`E:\Work\ipynb-mcp\ipynb-mcp`**（仓库根！），而同 shell 的 `TEMP` 明明指向 `C:\Users\ADMINI~1\AppData\Local\Temp`、anaconda python 也返回用户临时目录 → 说明该解释器的 tempdir 解析落到 cwd 兜底，而 MCP 客户端用 `npx` 拉起服务时 cwd = **用户的 notebook 项目目录**；② 主审实测仓库根 `tmp*.json` 为 **11 个**（自己跑一轮集成测试即新增 4 个），内容确认为 connection file（`"key": "d9a17426-…"`、`signature_scheme: hmac-sha256`），且**未被 git 跟踪**（`.gitignore:32` 覆盖）；③ 子代理补充：`%TEMP%` 下同类文件 56 个，其中只有 7 个端口仍在 listen → **优雅 shutdown 之外的所有路径都不清理**；④ 因此违反 SPEC §5.8（sidecar 禁止读写任何文件）与 §5.9（禁止在用户仓库内创建除备份与 artifact 之外的文件），而用户的仓库不会有这条 `.gitignore`。
修复建议：在 sidecar 侧显式钉住位置并接管生命周期——`km.connection_file = os.path.join(tempfile.gettempdir(), f"ipynb-mcp-{kernel_id}.json")`，并在 `KernelEntry.shutdown()`、`op_shutdown_all`、`main()` 退出前 `os.unlink`（`OSError` 忽略）；同时补 README「已知限制」+ 一条 DEVIATIONS（含"硬杀路径仍可能残留"）。注意**不要**把 sidecar 的 cwd 钉到别处（kernel 子进程继承 cwd，会改变用户 cell 的相对路径语义）。
设计文档对齐：**违反 SPEC §5.8/§5.9**；未登记。

【DEP-2】
严重程度：🟡 警告
所在位置：`src/server.ts:27`（`new McpServer({ name: 'ipynb-mcp', version: '0.1.0' })`）对照 `package.json:3`
问题描述：MCP `serverInfo.version` 硬编码，与 `package.json` 形成**双真源**，改版本号不会同步（客户端据 `initialize` 的版本记录/比对）。
详细分析：`prepublishOnly` 会跑 typecheck+lint+test，但没有任何机制校验这两个字面量一致；D22 的 1.x 兼容承诺以版本握手为前提。
修复建议：沿用本仓"源码扫描测试"的既有套路加一条守卫（`src/server.ts` 必须包含 `version: '<package.json version>'`），或由构建生成 `src/version.ts`。
设计文档对齐：SPEC 未规定，属配置单一真源问题。

【DEP-3】
严重程度：🟢 建议
所在位置：`package.json:26`（`"prepack": "pnpm build"`）
问题描述：R15 的字面要求（无 `prepare`/`postinstall`）已满足，但 npm 把 `prepack` 也列在"安装 git 依赖"时运行，而那时 `pnpm` 与 `typescript` 并不存在。
详细分析：不影响 registry 安装路径（`npx -y ipynb-mcp` 走 tarball），只影响 `npm i github:…`：可能安装失败，或产出缺 `lib/` 的包。
修复建议：`"prepack": "tsc -p tsconfig.json"`（不依赖 pnpm），构建产物仍由 prepack 保证。
设计文档对齐：R15 未违反；SPEC §8 发布规则 1 的意图在 git 安装路径上不成立。

【DEP-4】
严重程度：🟢 建议
所在位置：`docs/review/ipynb-mcp-code-review.md:3,12,1371`、`docs/review/ipynb-mcp-code-review-v2.md:3,327`
问题描述：本轮归档进仓库的两份审查报告含机器绝对路径（`E:\Work\ipynb-mcp\ipynb-mcp`），是 H5 已修问题在 docs 下的残留。
详细分析：`docs/E2E-CHECKLIST.md` 已按 H5 改为 `<repo>` 占位符，审查报告未同步处理——影响很小（不在 npm `files` 内），但同一仓库两套写法。
修复建议：统一替换为 `<repo>`。
设计文档对齐：无明文冲突，一致性建议。

【DEP-5】
严重程度：🟢 建议
所在位置：`docs/REVIEW-FIX-STATUS.md:12`、`docs/COMPATIBILITY.md`；对照主审实测
问题描述：文档记 `npm pack --dry-run` 为 **132** 个文件，主审实测为 **133**（131.0 kB / unpacked 549.2 kB），差 1 个文件。
详细分析：不影响功能（`lib/`、`python/ipynb_sidecar.py`、shebang 均已验证在内），属文档漂移；但也说明这类"实测数字"没有配套的可复现命令与时间戳。
修复建议：把数字改成命令 + 日期（如"`npm pack --dry-run` → 133 files @ a6951a8"），避免每次都要重数。
设计文档对齐：AGENTS §2 要求"凡改动对外行为/配置项/限制，同一提交内更新文档"。

**维度 1/2/7 阴性结论（已验证）**：
- **模块铁律（硬边界）**：`src/core/**` import `node:*` 计数 **0**（R11 成立，且无 `Date`/`Math.random`/`performance`/`uuid`/`hrtime`/`process.` 命中）；`src/mcp/**` 无 `node:fs`/`node:child_process`（仅 `tools/edit.ts:4` 的 `node:path`，不属禁止项）；`src/fs/**` 不解析 notebook 结构（唯一命中是注释）；`src/kernel/**` 不解析 notebook 结构；`python/*.py` 无 `open(`/`Path(`/`os.path`/`io.`/`shutil`/`glob`/`tempfile`（**但见 DEP-1：jupyter_client 会代它写文件**）。⚠️ **唯一的越界是 `src/mcp/render/read.ts` 的 nbformat 输出解析（ARCH-1）**——我在首轮自查中只 grep 了 `node:*` 而漏了"语义解析"，这一条是子代理发现、主审复核确认的。
- **类型纪律**：`any` / `as any` / `@ts-ignore` / `@ts-expect-error` 全仓 **0 命中**（唯一匹配是一句英文注释里的 "any error-severity")。
- **硬编码路径**：`src/`、`python/` 内 `E:\`/`C:\`/`/Users/`/`/home/` 仅 1 处，且是 `notebook-file.ts:82` 的注释（解释大小写归一化），**非可执行代码**。
- **依赖与配置**：运行期依赖仅 `@modelcontextprotocol/sdk`（+ 官方非可选 peer `zod`，D-005 已登记）；devDeps 四项且必要；无 `prepare`/`postinstall`（R15 合规；`prepack`/`prepublishOnly` 是 C1 要求的发布门禁）；`engines.node >= 22`、`files`、`bin`、`type: module` 齐备；`.gitattributes` 已补且行尾符已归一。
- **循环依赖**：**已用 import 图 DFS 验证无环**（32 个 `src` 文件、35 条边，三色检测 `CYCLES: none`）；唯一反向边是 `mcp/run-store.ts:4-5` 对根层类型的 `import type`（D-010 已登记，运行时零开销）；跨层方向单调（core 只被上层引用，根层 `run.ts` 是唯一跨层组合点）。
- **可变状态的例外（首轮遗漏，见 ARCH-2/3）**：AGENTS §4 规定"可变状态只允许存在于 `KernelRegistry` 与 run-store 的 run 表"，实际另有 **2 处模块级可变状态**——`kernel/interpreter.ts:408` 的 `sharedProbeCache`（且永不失效）与 `fs/notebook-file.ts:85` 的 `writeLocks`。
- **错误码与错误类型**：24 个 error code + 11 个 warning code 全部落在 `src/core/errors.ts` 的闭集内，**无新增、无未使用**；空 `catch` 0 处（R7 成立）；**唯一裸 `Error` 是 `fs/backup.ts:76`**（QUAL-5）。

### 维度 6：测试覆盖与自测质量

【TST-1】
严重程度：🟡 警告
所在位置：`tests/integration/run.test.ts:45-74`、`tests/integration/kernel.test.ts:41-74`；`python/ipynb_sidecar.py` 环境
问题描述：新增的"能否起 kernel"探测在失败时**静默回退到 base 解释器**（只往 stderr 写一行说明），没有任何 CI 约束——环境坏掉时套件依旧全绿。
详细分析：回退本身是合理的（正是它让"本机 venv 的 pyzmq 坏"不再表现为 8 个用例变红），但它把两类完全不同的原因合并成同一结果：① 测试环境坏；② **我们的 spawn/路径逻辑坏**（例如 venv 解释器路径处理引入回归）。后者会让套件在 `canStartKernel(VENV_PY)` 失败后落到 base 并保持绿色，缺陷直达用户。
修复建议：CI 下把回退视为失败（CI 的解释器由 `setup-python` + `pip install ipykernel` 提供，本应永远可用），或要求显式开关：
```ts
if (usedFallback && process.env['CI'] === 'true') {
  throw new Error(`test interpreter fallback in CI (${VENV_PY} could not start a kernel) — refusing to mask it`);
}
```
设计文档对齐：AGENTS §9"集成测试用测试专用虚拟环境"；§3"单测必须能在没有 Python 的机器上全部通过"（U20 的 skip 已合规）。

【TST-2】
严重程度：🟡 警告
所在位置：`tests/integration/run.test.ts:589-618`（I10）
问题描述：集成 I10 的判别力问题**仍在**：第二个 run 必然落在第一个 run 唯一的 `time.sleep(3)` cell 内，因此仅靠 per-exec 的 `busy` 也会抛 `kernel_busy`——把 `registry.acquireRun` 整个删掉，该用例仍然绿。
详细分析：实现者把"两 cell 之间的间隙"这半**诚实地挪到** `tests/unit/kernel-registry.test.ts`（直接断言 `acquireRun` 在无在途 exec 时拒绝），这是可接受的取舍（集成层无法确定性制造该间隙）；但集成断言本身没变强，"删掉锁仍绿"这一点在集成层依旧成立，A6/W5 的集成护栏名不副实。
**变异实测（子代理 E2）**：把 `src/run.ts:333` 的 `const releaseRun = deps.registry.acquireRun(req.path)` 换成 no-op 后，`kernel-registry.test.ts` **15/15 绿**、`run.test.ts` **整文件 17 passed 绿**（含 I10 本身）——即"删掉 `acquireRun` 该用例仍绿"在**调用点**层面完全成立；只有删掉**方法本身**才会因 `[W5]` 断言或编译失败。也就是说 `[W5]` 守的是"方法语义"，`runNotebook` **是否调用它**零覆盖。⚠️ 顺带后果：调用点消失后 `#runActive` 恒空，`registry.ts:645-649` 的"回收不得打断整个 run"守卫变成死代码（空闲回收可能在 run 的两 cell 间隙杀掉 kernel）——这是第二处无覆盖行为。另：`DEVIATIONS.md` D-019 与 `REVIEW-FIX-STATUS.md` 的 T2 行都声称"[W5] 与 I10"是 D-019 的回归用例，实测 **I10 对 D-019 的接线零判别力**，属过度声明。
修复建议：补一条**接线断言**（例如让 registry 记 `acquireRun` 调用次数，或在 `runNotebook` 层用 spy registry 断言"被调用且在 `finally` 释放"）；同时让第一个 run 的目标是一个快 cell、其后有一个慢 cell，第二个 run 卡在两者之间发起；至少把该用例改名以反映它实际验证的是"在途重叠被拒"。
设计文档对齐：SPEC §10.2 I10 的判定是"同一 kernel 上并发 run → `kernel_busy`"，当前实现更强（run 级），但集成用例只覆盖了弱的那一半。

【TST-3】
严重程度：🟡 警告
所在位置：`tests/integration/server.test.ts`（夹具与 I13/I16）、`tests/unit/edit-tool.test.ts:135`（U4）、`tests/integration/run.test.ts:329-341`（I18b）
问题描述：v2 的 T3/T4 只完成了一部分：`server.test.ts` 夹具已支持预置输出，但**"真写路径上的校验守卫"与几处弱断言仍在**。
详细分析：① I18b 的标题说 "clears **only** the cell about to run"，而用例只有 1 个 code cell，"only"不可验证；② U4（markdown 校验先于写入）在 `dry_run:true` 下断言"文件未变"，而该模式下本来就不写，真写路径仍无守卫；③ SPEC §10.1 的 U4 用例编号只在 core 层纯函数上被覆盖。
修复建议：I18b 改为 2–3 个 code cell（前两个带 seed），断言"只有目标 cell 的 seed 被清、其余原样"；U4 补一条 `dry_run:false` + 非法 markdown → `markdown_invalid` 且文件字节不变 的用例。
设计文档对齐：AGENTS §7 陷阱 12"不要为了让测试变绿而放宽断言"。

【TST-4】
严重程度：🟢 建议
所在位置：全仓测试名；`SPEC.md` §10.2；`docs/DEVIATIONS.md`
问题描述：编号体系仍有两套：本轮的护栏用例用 `[R1]`/`[R3]`/`[W3]`/`[W5]`/`[A5][W4]`/`[I-smoke]`/`[I18]`/`[D-015]` 等，SPEC §10.2 只到 I17——既未补入 SPEC，也未在 DEVIATIONS 说明。
详细分析：AGENTS §5 把"用例名里能搜到 SPEC 编号"定为验收时定位覆盖率的**唯一手段**。子代理用 `vitest list --json` 全量枚举（**252 个用例 = 214 unit + 38 integration**）后统计：**携带 SPEC §10.1/§10.2 编号的用例 99/252 = 39.3%**，而 v2 时是 `100/220 = 45.5%` → **比例不升反降 6.2 个百分点**（绝对数 100→99，分母涨 32）；111 个 `describe` 中 58 个只带非 SPEC 词汇，**251 个 `it` 标题里 0 个**带 SPEC 编号。仍在使用的非 SPEC 词汇包括 `step1..step9`、`A5…A16`、`C6a/C6b/C6e`、`D2/D3/D7/D-015`、`R1/R2/R3`、`W1…W10`、`I18/I18b/I-env/I-smoke/I-replay-fresh`。`DEVIATIONS.md` 的 D-018~D-021 质量不错，但**没有一条把"测试编号体系"作为偏离登记**；`SPEC.md` §10.2 仍到 I17（`git diff 3a9c6d3 HEAD -- SPEC.md AGENTS.md` 为空 ✓ 这点做对了）。另：`REVIEW-FIX-STATUS.md` 的 T6 行称"本轮把这类用例**全部**加上对应 SPEC 编号前缀"，实为不实——`[I18]`/`[I-env]`/`[R1]`/`[W5]` 等原样存在。
修复建议：在 `docs/COMPATIBILITY.md` 或新的 `docs/TEST-MAP.md` 里维护"非 SPEC 编号 → 对应条款"的映射表（成本最低），或把 `[I18]/[I-smoke]/[R*]/[W*]` 正式补成 SPEC §10.2 的 I18–I22。
设计文档对齐：AGENTS §5。

【TST-5】
严重程度：🟠 严重
所在位置：`tests/unit/analyze-op.test.ts:107-122`（U20 用例内的建 venv 与 boot 探针）、`:24-26`（`PYTHON_AVAILABLE`）；`.github/workflows/ci.yml`
问题描述：T5 的修复（"先真起一次 kernel 再决定 skip"）**会吞掉真实的产品回归**，同时在**没有 Python 的机器上把单测直接弄红**——两处都与它想修的目标相反。
详细分析：
1. **掩盖失败（子代理变异实测 E7）**：把 `sidecar-transport.ts` 的 `startKernel` 改成恒抛 `Error('MUTATION: start_kernel is broken by a regression')` → 套件输出 `3 passed | 1 skipped`，**全绿**，skip 原因写作"no interpreter that can start a kernel here"。`probeKernelStartup` 的 `catch` 无法区分"环境没有 ipykernel"与"产品把 `start_kernel` 改坏了"，而 vitest 的 skip 既不让 CI 变红也不产生告警。这正是本项目反复出现的"绿灯掩盖真实缺陷"机制，且出现在最能证明该机制有害的位置。
2. **无 Python 的机器上单测变红（违反 AGENTS §9）**：建 venv 的 `execFileSync(BASE_PYTHON, ['-m','venv', …])`（`:110-112`）在**所有守卫之前**无条件执行。主审已读码确认顺序；子代理把 PATH 收窄到不含 Python 后实测：`× [U20][D2] … → spawnSync python ENOENT`、`1 failed | 3 skipped`。AGENTS §9 要求"单测必须能在**没有 Python 的机器上全部通过**"，提交 `dc6b7d3` 的信息也自述"so `pnpm test` stays green on a machine with no Python"——**该契约现在被自己的修复破坏**。
3. 顺带：该"单测"在仓库内 `tests/.venv-test` 建 venv（非临时目录、不清理），仍违反 AGENTS §9"副作用只能落在临时目录且必须清理"。
修复建议：① 把建 venv 与 boot 探针一起放到守卫**之后**（一个 `if` 顺序问题）；② 探针只在"解释器存在但 `import ipykernel` 失败"时 skip，**其它任何异常必须 fail**（`expect(...).rejects` 或直接 throw）；③ 给测试 venv 换一个可用的 pyzmq，或给 unit 配置加 `fileParallelism:false` 消除不确定性。
设计文档对齐：**违反 AGENTS §9**；与提交信息自述矛盾。

【TST-6】
严重程度：🟡 警告
所在位置：`tests/integration/kernel.test.ts:190`（I9 编号）、`:198,206`（`executionCount` 断言）、`:184-188`（`alive` 断言）；`tests/integration/server.test.ts:365-369`（`fresh.execution_count`）、`:373-446`（I12 口径）
问题描述：三处"断言看似在验规格、实际结构恒真或口径缩水"。
详细分析：① **I9 的编号不可搜索**——唯一用例写成 `it('restart gives a new kernel id and runs no cells (I9)')`，编号在圆括号里，全仓 grep `\[I9\]` 零命中，违反 AGENTS §5"用例必须能在测试名里搜到 SPEC 编号"；② **`executionCount` 断言恒真**——`registry.ts:274` 的 `#startNew` 把 `executionCount` 硬编码为 `null`，除 `execCell` 外无任何路径改它，因此 `expect(...).toBeNull()` 在 kernel.test.ts:198/206 与 server.test.ts:365-369 都**不构成对"无 cell 被执行"的验证**（用例注释自己也承认"a real check would itself be an execution"）；③ **I12 口径缩水**——SPEC 的判定是"**完整跑一遍上述用例**并抓取 stdout"，实测只自发 3 条 JSON-RPC（initialize / tools-list / notebook_read）就断言，拿不到 run/edit 期间 progress 通知等真实负载下的 stdout 纯净性。
修复建议：I9 改名带 `[I9]`；把"无 cell 被执行"改为可证伪的断言（例如用一个会写标记文件的 cell 源码 + 目标 cell 的 `execution_count` 仍为旧值/`outputs` 未变，或断言 sidecar 的 exec 计数为 0）；I12 在同一 stdio 会话里追加 edit/run 调用再断言逐行可解析。
设计文档对齐：AGENTS §5；SPEC §10.2 I9/I12。

【TST-7】
严重程度：🟡 警告
所在位置：`tests/unit/notebook-file.test.ts:44-58`（W1 单测）；对照 `tests/integration/locked-file.test.ts`（I15）
问题描述：W1 的新单测只守**函数体**、不守**接线**——变异实测证明它抓不到 W1 的原缺陷。
详细分析：子代理变异 E3——把 `notebook-file.ts:34` 的 `throw translateLockError(...)` 改回 `throw cause`（精确复原 W1）→ `notebook-file.test.ts` **5/5 仍全绿**，而同一变异下 `locked-file.test.ts`（I15）变红（`expected 'internal' to be 'notebook_locked'`）。也就是说 W1 的真正护栏只有 I15 一条**Windows-only** 用例；新单测守的是错误映射函数本身的语义，不是"读路径是否调用它"。同类：T2 的 `acquireRun`（[W5] 守方法语义，不守 `runNotebook` 是否调用）、`notebook-file.test.ts` 的 W7（**变异 E8 后 2 例变红 ✅，这条是真护栏**）。
修复建议：给 W1 单测补一条"经 `readNotebookFile`/`writeNotebookFile` 走一遍"的用例（注入 `readFile` 抛 `EBUSY`，断言错误码为 `notebook_locked`），把接线也钉住。
设计文档对齐：AGENTS §9"不许 mock 掉被测逻辑本身"的同类（守了实现、漏了接线）。

【DEP-6】
严重程度：🔴 阻塞（CI 层面，首次运行必然全红）
所在位置：`.github/workflows/ci.yml:19-21`（unit job）与 `:48-50`（integration job）的 `uses: pnpm/action-setup@v4` + `with: version: 11`；对照 `package.json:19` 的 `"packageManager": "pnpm@11.7.0"`
问题描述：两处都显式传 `version: 11`，而 `package.json` 同时声明了 `packageManager: pnpm@11.7.0`——`pnpm/action-setup@v4` 在两者都存在且字符串不等时**直接抛错**（`Multiple versions of pnpm specified`），于是**每个 job 都会停在 "Install pnpm"，`pnpm install/build/test` 一步都跑不到**。
详细分析：主审已确认两处配置（`version: 11` vs `11.7.0`，字符串不等）。该 action 的 `readTarget` 行为是 v4 的已知设计（同时指定且不一致即报错，避免"声明的版本"与"实际安装的版本"不一致）。由于仓库 `git remote` 为空、CI 从未运行，这条目前是**潜在**故障——但一旦推上 GitHub 或接入任何 CI，第一次运行就是全红，且失败点在安装步骤，会让人误以为是网络或 runner 问题。
修复建议：删掉两处 `with: version: 11`（让 action 读 `packageManager`），或把值统一为 `11.7.0`。修完请顺带核对 unit job 里 ubuntu 镜像自带 `python3-venv` 的可用性（U20 建 venv 依赖它），以及 `IPYNB_TEST_PYTHON=python` 在 Linux 上依赖 setup-python 提供的 `python` 名。
设计文档对齐：SPEC §9 的 CI 矩阵（3 OS × node 22/24 + 2 OS × py 3.10/3.12）目前是**纸面配置**，本条是它变成真实门禁前的第一道拦路石。

**测试维度阴性结论（含被变异证明为"真护栏"的部分——本轮最有价值的产出）**：`pnpm test` 无 `it.only`/`it.skip`/`todo` 残留（仅 2 处运行时 `context.skip`）；`JUPYTER_PATH` 的保存/恢复已补（`run.test.ts`/`server.test.ts`，`stale.test.ts` 仍设而不恢复，属同型小遗漏）；I11 自包含且断言"被检查集合非空"；D2 的分析器用例经"真 sidecar vs 朴素 AST"对照实验证明确有判别力（换回朴素遍历会变红）。

**经变异实测确认为"真护栏"的用例（应记功）**：`kernel-registry.test.ts` 的 `[R1]`（精确复原 v2 的 R1 缺陷 → **2 例变红**）与 `[R2]`（删掉 `reclaimIdle` 的 try/catch → 变红）、`notebook-file.test.ts` 的 `[W7]`（复原旧的清理判断 → **2 例变红**）、`render-read.test.ts` 的 `[A5][W4]`（真驱动 `renderReadResult`，断言 14 张全物化且无 `image_limit`）；反向对照：`[W1]` 单测与 `[W5]` 单测只守函数体/方法语义、**不守接线**（见 TST-7/TST-2）。**SPEC 用例编号覆盖**：U1–U27（含 U19b/U21b）与 I1–I17 共 **46 个编号全部都有对应用例**；有名无实或口径缩水的仅 I7 / I9 / I10 / I12 / U4 / I16-fresh / I18b（见 T1–T4、TST-2、TST-6、TST-7）。

---

## 四、复核中被判定为**误报**的项（诚实记录）

| 子代理结论 | 主审复核 | 说明 |
|---|---|---|
| ROB-2：`analyzeStale` 规则 2（out-of-order）在 `U(j) == []` 时是死代码，导致 SPEC §5.6 漏报 | ❌ **误报，撤回** | `src/core/stale.ts:52-64`：空 `uses` 分支**自身**就执行了规则 2（`:55 hasTargetAfter` → push `out-of-order-execution`），随后 `:63 continue`；`:83-90` 只是**非空 uses** 路径上的规则 2。两条路径合起来完整实现了 SPEC §5.6 的判定表，`U(j)==[]` 不会被漏报。子代理把 `:83-90` 误认为唯一实现点 |

---

## 五、总体评估

### 1. 整体质量评级：**B（小修后合并）**

**依据**：四道门禁首次全部真通过（typecheck 0 / lint 0 / 单测 213+1skip / 集成 **38/38** / build+pack 实测）；v2 的 3 个 P0 回归全部真修复并带上判别力用例；卫生（H1–H6）与文档（Doc1–Doc6）全部闭环；路径围栏（19 例绕过矩阵）、命令注入、凭据、日志泄露、依赖与配置、行尾符均为阴性，且**循环依赖经 import 图 DFS 证明为零**。

**与上一轮的关键差别**：上轮的问题是"核心承诺被打破且无测试"（永久卡死、服务自杀、数据丢失）；本轮的问题是"**边界与契约收口不严 + 若干规格违反**"——所有缺陷都是局部、边界清晰、修法明确的（多为数行到数十行），没有任何一项需要架构返工或推倒重来。因此仍判 B 而非 C。

未给 A 的原因：本轮合计 **3 项 🔴 + 12 项 🟠**：
- 🔴 **ROB-8** 取消落在写回窗口 → 已完成 cell 既不落盘也不回报（违反 §4.8 规则 3 的"终态必须报告 `write_back`"，零测试覆盖）；
- 🔴 **ARCH-1** `src/mcp/render/read.ts:214-257` 自行解析 nbformat 输出结构（违反 AGENTS §4 模块铁律与 SPEC §4.1.1，且内含静默丢弃数组型 `data` 的语义决策）；
- 🔴 **DEP-6** CI 的 `pnpm/action-setup@v4` 与 `packageManager` 版本冲突 → 首次运行全部 job 在安装步骤即红（CI 层面阻塞，非产品缺陷）；
- 🟠 **ROB-2**（超时后 `shutdownKernel` 调用 0 次 → 同一复用键两个活 kernel，违反 §4.7 规则 6/§5.3/R19）、**ROB-11**（默认 300 s 下传输超时早于 sidecar 最坏耗时 → `exec_timeout` 漂移成 `kernel_died` 并连带杀掉同 sidecar 上其他 notebook 的 kernel）——两者同属"任何 cell 超时都会让系统进入错误状态"这一触发类；
- 🟠 **DEP-1**（connection file 含 HMAC key 落进**用户项目目录**且永不清理，违反 §5.8/§5.9）、**QUAL-8**（`notebook_run_cancel` 可能返回 SPEC 枚举外的 `state:"running"`）、**ROB-6**（复用键与 run 锁缺 realpath，违反 §5.3）、**ROB-5**（`cell_indexes` 无长度上限，违反 §4.1.12）、**ROB-1**（abort 监听器逐 run 累积）、**PERF-1**（分帧 O(L²)，64 MiB 行实测 9.4 秒主线程 CPU）、**ARCH-2**（探测缓存永不失效，导致用户照提示装好 ipykernel 仍需重启服务）、**TST-5**（U20 的新守卫会把 `start_kernel` 的真实回归吞成 skip，且建 venv 在守卫之前，使无 Python 的机器上单测直接红——违反 AGENTS §9）、**ARCH-6/QUAL-1**（496 行上帝函数与整段错位缩进：可维护性）。
若把上述规格违反视为发布门槛（建议如此），则**发布前必须清完 🔴 与涉及 SPEC 条文的 🟠**；其余 🟡/🟢 可排入后续迭代。

### 2. TOP 3 必须优先修复

| # | 问题 | 为什么优先 | 修复量 |
|---|---|---|---|
| 1 | **ROB-8** 取消落在写回窗口 → 已完成 cell 既不落盘也不回报（违反 §4.8 规则 3） | 唯一会"静默丢掉已算完结果"的缺陷；直接冲突"不会重跑你的长任务"这一卖点；修复方式是让新分支复用既有的 `failedRunError`（约 5 行），顺带把"两条终态路径"合并；**零测试覆盖** | 小 |
| 2 | **ROB-2 + ROB-11**（同一触发类：任何 cell 超时都会让系统进入错误状态） | 中断落地时 → `shutdownKernel` 调用 0 次、同一复用键两个活 kernel（R19/§5.3）；中断未落地时（**默认 300 s 必然如此**）→ 传输先超时，`exec_timeout` 漂移成 `kernel_died`，并 `taskkill /T` 掉整棵 sidecar，**连带杀掉其他 notebook 的 kernel**（README 却宣称并行）。两处互为补集，必须一起修并补"按 pid 断言进程已退出""跨 notebook 不连坐"两条用例 | 中 |
| 3 | **DEP-1** connection file（含 HMAC key）写进用户项目目录且永不清理 | 唯一直接损害**用户磁盘**的缺陷：违反 §5.8/§5.9（"不得在用户仓库内创建除备份与 artifact 之外的文件"），且用户仓库没有 `.gitignore` 兜底；主审实测本机该解释器的 `gettempdir()` 就是仓库根，跑一轮测试即新增 4 个文件（现存 11 个，`%TEMP%` 下 56 个） | 小 |

**第 0 步（一行修复，决定 CI 能否成为真门禁）**：**DEP-6** —— `.github/workflows/ci.yml` 两个 job 的 `pnpm/action-setup@v4` 都传了 `version: 11`，而 `package.json:19` 声明 `packageManager: pnpm@11.7.0`，v4 在两者不等时直接抛 `Multiple versions of pnpm specified`；因仓库无 remote，CI 从未运行，所以这是**潜在**故障，但一旦接入 CI，**第一次运行就是全部 job 全红且失败在安装步骤**（最易被误判为 runner/网络问题）。删掉 `version: 11` 即可。

紧随其后（同为必修或强烈建议）：**ARCH-1**（🔴 模块铁律：把 `normalizeRawOutput` 移回 core，并修掉数组型 `data` 被静默丢弃）、**QUAL-8**（cancel 立即终态，删除 `sleep(50)`）、**ROB-6**（registry 注入 realpath）、**ROB-5**（`cell_indexes` 上限与去重）、**PERF-1**（分帧改 chunk 列表）、**ARCH-2**（探测缓存加 TTL，否则"照提示装完仍需重启"）、**TST-5**（U20 的守卫会吞掉真实回归，且在建 venv 前就 red 掉无 Python 的机器）、**W5 顺序残留**（`getOrCreate(fresh)` 提到 `acquireRun` 之前）。

### 3. 与原始设计文档的偏离清单

| 偏离 | 性质 | 处置建议 |
|---|---|---|
| `src/mcp/render/read.ts:214-257` 自行解析 nbformat 输出结构 | **架构偏离（违反 AGENTS §4 铁律 + SPEC §4.1.1）** | 按 ARCH-1 把转换器移回 `core`（并修掉数组型 `data` 被静默丢弃） |
| 超时后不关闭 kernel（`shutdownKernel` 调用 0 次） | **行为偏离（违反 §4.7 规则 6 + §5.3 + R19）** | 按 ROB-2 修复；建议同时把 I5 的断言从"记录为 null"改成"按 pid 断言进程已退出" |
| 传输层 `exec_cell` 超时余量（+30 s）小于 sidecar 最坏耗时（+35 s） | **行为偏离（默认 300 s 下 `exec_timeout` 不可达 + 跨 notebook 连坐）** | 按 ROB-11 修复，并把这个不变式写进 SPEC |
| connection file 写入服务进程 cwd（用户项目目录）且永不清理 | **行为偏离（违反 §5.8 + §5.9）** | 按 DEP-1 修复 + 补 DEVIATIONS/README |
| `notebook_run_cancel` 可能返回 `state:"running"` | **契约偏离（违反 §4.8 返回枚举与"立即终态"）** | 按 QUAL-8 修复 |
| `kernel/interpreter.ts:408` 的探测缓存（模块级可变状态且永不失效） | **架构偏离（违反 AGENTS §4 状态约束 + §5.2 每次解析语义）** | 按 ARCH-2 加 TTL 或登记 DEVIATIONS |
| `fs/notebook-file.ts:85` 的写锁表（第二处模块级可变状态，且 `lockKey` 未用注入的 platform） | 部分已登记（D-014 记了行为，未记状态位置） | 按 ARCH-3 修 platform 贯穿 + 补登记 |
| `fs/backup.ts:76` 抛裸 `Error` | **行为偏离（违反 AGENTS §5"只抛 IpynbError"）** | 按 QUAL-5 修复 |
| V2/R3/V3/R2 四处设计取舍未登记（超时回收整棵树、`cellInFlight` 门、失败路径不传 signal、运行期不自杀） | 流程偏离（SPEC §6 R20） | 按 H-7/DOC-1 补 DEVIATIONS 四条 |
| CI 的 pnpm 版本双重声明（action `version: 11` vs `packageManager: pnpm@11.7.0`） | **配置矛盾（首次 CI 必然全红）** | 按 DEP-6 删掉 `with: version: 11` |
| U20 的 skip 守卫会吞掉 `start_kernel` 的真实回归；建 venv 在守卫之前（无 Python 机器上单测直接红） | **测试契约偏离（违反 AGENTS §9"单测无需 Python / 副作用只在临时目录"）** | 按 TST-5 调整守卫顺序与判定口径 |
| 三个新单测只守函数体、不守接线（W1 / `acquireRun` 调用点） | 覆盖缺口（AGENTS §9"不许 mock 掉被测逻辑本身"的同类） | 按 TST-2/TST-7 补接线断言 |
| `#reuseKey`/`acquireRun` 未按 §5.3 做 realpath | **架构偏离（违反明文）** | 按 §三 ROB-6 修复；修复前不应发布 |
| 超时后不关闭 kernel | **行为偏离（违反 §4.7 规则 6 + R19）** | 按 ROB-2 修复 |
| `cell_indexes` 无数组长度校验 | **行为偏离（违反 §4.1.12）** | 按 ROB-5 修复 |
| 取消窗口的终态不报告 `write_back` | **行为偏离（违反 §4.8 规则 3）** | 按 ROB-8 修复 |
| 未知 MCP 参数被静默忽略 | 未落实 §4.1.11 的立法目的（非字面违反） | 建议登记为改进项 |
| `AGENTS.md` §4 目录树与实际不符 | 内部文档一致性（D-007~D-011 已登记代码侧偏离） | 按 ARC-1 重写该树 |
| 新增测试编号（`[R1]`/`[W3]`/`[I-smoke]` 等）不属 SPEC §10.2 | 测试词汇漂移 | 建映射表或补进 SPEC §10.2 |
| `docs/archive/` 无 v1/v2 实体 | 已登记 **D-018**（如实说明，不伪造） | 无需动作 |
| run 级锁强于 §5.3 字面（两 cell 间隙也拒绝） | 已登记 **D-019**（方向安全） | 无需动作 |
| `clear_outputs` 非 code cell → `invalid_ops`、选择器错误码分工 | 已登记 **D-020** | 无需动作 |
| sidecar 私有协议字段 `failedCellIndexes` vs §5.8 的 snake_case | 已登记 **D-021**（含修掉一个真 bug 的说明） | 建议 SPEC v3.1 采纳实现写法 |

### 4. 后续开发建议

- **必须补的测试**（按价值排序）：① 取消落在写回窗口 → 断言 `write_back` 与文件已落盘（ROB-8，零覆盖）；② 超时 → 断言 `shutdownKernel` 恰被调用 1 次（ROB-2，现有用例只断言 reject）；③ 同一 notebook 的两种路径拼写 → 只允许一个 kernel、`acquireRun` 仍拒绝（ROB-6）；④ `cell_indexes` 上限与去重（ROB-5）；⑤ 64 MiB 单行的分帧耗时上限（PERF-1，可用性能断言或改为结构性断言"chunk 数无关"）；⑥ CI 下的解释器回退必须失败（TST-1）。
- **需要补的文档**：`AGENTS.md` §4 目录树（ARC-1）；`README.md`「已知限制」补"kernel 启动失败时你只会看到 `kernel_died` + 退出码，真实原因在 `--log-level debug` 的 stderr"（ROB-10）与"强杀路径会残留 `tmp*.json`"（ROB-7）；`docs/COMPATIBILITY.md` 的 pack 文件数改为"命令 + 日期"（DEP-1）。
- **需要补的监控/可观测性**：`ROB-10` 的 sidecar stderr 尾缓冲 + 退出码符号化（这是"零配置可用"承诺的失败面）；`run.ts:559` 的 `analyze` 失败原因（当前只降级不留因）；`write_back.reason` 进入 `notebook_run_status`（ROB-4）。
- **工程加固**：引入格式化器并纳入 CI（QUA-2 的成因）；打开 `noUnusedLocals`/`noUnusedParameters`（QUA-4 的成因）；把"两条终态路径"重构为单一 `finalizeRun`（QUA-1 与 ROB-8 的根因）。
- **发布前**：`E1–E9` 手工端到端仍未执行（`docs/E2E-CHECKLIST.md` 证据列全空，SPEC §10.4 DoD 未达成）；CI 仍从未真跑（仓库无 `git remote`），首次接入时请先验证新加的 `pnpm test`（integration job）与"回退即失败"约束。

---

## 附录：本报告的验证分工与局限

- **主审亲验（全部结论的一手依据）**：四道门禁实跑 + build/pack；R1/R2/R3/V1/V2/V4 的代码与调用链；ROB-2/6/8/9/10 的代码；PERF-1 的代码；W1/W4/W5/W6/W7/W8 的关键行；T1（集成输出）；H1–H6（`git ls-files --eol`、`.gitattributes`、`git ls-files`）；Doc1–Doc6；维度 1/2/7 的 grep 面（core 无 `node:*`、mcp 无 fs、无 `any`、无硬编码路径、无格式化器、文件规模）；pyzmq 环境论断的独立实验（两个解释器 × 最少依赖脚本 + 真实 sidecar 协议四步）。
- **子代理验证（各带独立实验，主审已抽查最关键处并撤回 1 条误报）**：W 类（含真实独占句柄验证 W1、变异对照验证 W4、旧实现逐字重放验证 W10）；T 类（变异测试与覆盖率统计）；架构·质量·依赖；健壮性·性能·安全（19 例围栏绕过矩阵、分帧吞吐、base64 峰值、stale 复杂度、连接文件残留、60 处 catch 逐条）。
- **局限**：① 五条验证流（R1–V4、W 类、T 类、架构·质量·依赖、健壮性·性能·安全）**已全部收尾并完整并入本文**，各自的实测手段见 §附录与各条目内的 `[实跑]/[变异]/[读码]` 标注；② 未做 macOS/Linux 实跑（ROB-6 的 realpath 问题在 macOS 上更易触发，本机无法复现；CI 相关结论亦未经真实 runner 验证）；③ 未做真实 MCP 客户端端到端（E1–E9 仍为空）；④ 子代理结论中**已有 1 条被主审复核判定为误报并撤回**（见 §四），其余 🔴/🟠 项主审均亲自读过代码或跑过实验；⑤ 变异测试覆盖了 R1/R2/W1/W7/W5/`#probeKernel`/`start_kernel`/`acquireRun` 调用点等关键面，但未做全量系统性变异。
