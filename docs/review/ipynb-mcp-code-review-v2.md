# ipynb-mcp 代码审查复审报告（v2）

> **审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp` @ HEAD `f03a5b3`（工作树干净，无未提交改动）
> **上一轮**：`docs/review/ipynb-mcp-code-review.md`（评级 C，31A + 6B + 6C + 9D + 3E）
> **本轮变更**：审查报告提交 `3a9c6d3` 之后新增 **14 个提交 / 48 个文件 / +2694 −988 行**
> **权威**：`SPEC.md` + `AGENTS.md`（**两者自始至终未被修改 —— 这一点做对了**，偏离一律记 `DEVIATIONS.md`）
> **审查日期**：2026-10-02
> **方法**：4 个并行复核子代理 + 主审自查；**可以运行命令了**（本会话已切 `danger-full-access`，PowerShell 5.1 / node v26.7.0 / pnpm 11.7.0 / git 2.45.2 可用），因此本轮**首次具备实跑门禁的能力**。证据分三类并逐条标注：`[实跑]` 命令输出、`[实验]` 只读复现实验、`[读码]` 文件:行。

---

## 一、门禁实测结果（本轮最重要的新增信息）

| 门禁 | 实现者声明 | **我实测** | 结论 |
|---|---|---|---|
| `pnpm typecheck` | 0 错 | exit 0 `[实跑]` | ✅ 真 |
| `pnpm lint` | 0 警 | `Found 0 warnings and 0 errors`（55 文件 / 99 规则）`[实跑]` | ✅ 真 |
| `pnpm test`（单测） | 185/185 | **185 passed (185)，18 文件** `[实跑]` | ✅ 真 |
| `pnpm test:integration`（集成） | **35/35** | **34 passed / 1 failed + 1 Unhandled Rejection**（连跑两次均如此）`[实跑]` | ❌ **声明不实** |
| `npm pack` 内容 | 132 文件含 `lib/` + sidecar | 132 项，含 `lib/bin.js`(4163B, shebang ✓) 与 `python/ipynb_sidecar.py`(15682B) `[实跑]` | ✅ 真 |
| CI | 矩阵已配好 | **`git remote` 为空 → CI 从未运行过** `[实跑]` | ⚠️ 纸面配置 |

失败的那一条是 `tests/integration/locked-file.test.ts`（SPEC §10.2 **I15**）：

```
FAIL tests/integration/locked-file.test.ts > [I15] exclusive-open writes raise notebook_locked (Windows)
AssertionError: expected 'internal' to be 'notebook_locked'
```

**这说明：`REVIEW-FIX-STATUS.md` 第八节的"最终门禁：集成 35/35"是不成立的，此前的"26/26"同样不成立**（该测试文件自 `6f8d647`（SPEC 第 10 步）以来从未改动，`git log -- tests/integration/locked-file.test.ts` 只有一个提交）。这是本轮最需要严肃对待的**过程问题**：门禁数字被当成结论书写，而没有真正跑过。

---

## 二、31 项 A 类 + B/C/D/E 的修复验证矩阵

**真正闭环（代码 + 有判别力的用例，我或子代理亲自验证）**

| 项 | 判据 |
|---|---|
| **A1（主路径）** | 逐 cell 快照 + 清空 + 三条还原路径（`run.ts:324-329,336-348,397-404,409-421`）；I5/I18 用预置 outputs 断言保留，回退即变红 `[读码+子代理]` |
| **A2** | `registry.ts:261 env: process.env`，唯一 transport 构造点；I-env 真断言 PATH/HOME |
| **A8 / A9 / A11 / A13 / A14 / A15 / A21 / A24 / A26 / A27 / A29** | 逐条代码到位，多数带回归用例 `[子代理读码 + 对照 git show]` |
| **A19** | `server.ts:34 wrap→runTool`，6 个工具全经此路；形状 `{code,message,detail}` 正确 |
| **B1 / B2 / B4 / B6** | `src/mcp/**` 递归 grep 零 `node:fs`/`node:child_process`；解释器解析收敛 `resolveForNotebook`；`readNotebookMetadata` 消除三处重复；D-007~D-011 登记到位 |
| **C1–C6** | prepack/prepublishOnly/files/CI build + shebang + typecheck 字面 + 7 小项；**tarball 实测通过** |
| **D3 / D5 / D6 / D7** | 工具层 CAS/dry_run 真断言；常量改独立字面量；JUPYTER_PATH 保存恢复；4 项边界值齐备 |
| **D2** | 真驱动 sidecar `analyze`；子代理用**真 sidecar + 朴素 AST 遍历对照实验**证明"换回朴素遍历会变红" ✅ |
| **E3** | D-017 如实自标"部分实现"，README 披露与实现一致 |
| **D9** | 无 `it.only/skip/todo`；SPEC.md/AGENTS.md 未被改动 |

**未修复却标 ✅（虚报，逐条已亲验）**：A20、A22、A31（见 V1–V3），A23 半句（V4）。
**修出新回归**：A30×A23×A3 两条 P0（R1、R2），A12 放大的数据丢失路径（R3）。
**部分修复/残留**：A1、A5、A6、A10、A16、A17、A18、A23、A25、A28（W2–W9）。
**测试未修**：D1（abort 半）、D4 的 I7/I9/I10/I13/I14/I16 残留（T1–T4）。

---

## 三、🔴 P0 级回归（本轮修复引入，必须回滚式返工）

### R1 🔴 `sidecar` 崩溃后该 notebook **永久无法 run**（恢复路径被打断）

**位置**：`src/kernel/registry.ts:166-172`（`getOrCreate`）、`:334-352`（`shutdown`）、`src/kernel/sidecar-transport.ts:269-271`

**问题描述**：`getOrCreate` 在"存在 session 但 transport 已死"时调用 `await this.shutdown(...)`；而 A30 的修复让 `shutdown` 在 `shutdownKernel` 失败时**抛 `IpynbError('kernel_died')` 并保留 session**。死 transport 上的 `#request` 必然立即 reject，于是：

```
sidecar 崩溃 → session 带着死 transport 留在 #sessions
  → 下一次 notebook_run / notebook_kernel start/restart
  → getOrCreate:166 alive=false → :171 await shutdown() → 抛 kernel_died
  → session 仍被保留 → 下次再抛 …… 直到 MCP 进程重启
```

**详细分析**：
- 修复前该分支是 `this.#removeSession(existing)`（`git show e3dfe96^:src/kernel/registry.ts` 可证），随后 `#startNew → #transportFor` 会**发现死 transport 并重建 sidecar**（`registry.ts:228-241` 的清理逻辑就是为此写的）——即 SPEC §5.3「sidecar 退出 → 下一次 `notebook_run` 走 replay」原本是通的，现在被打断。
- `[实验]` 子代理用伪 transport（`shutdownKernel` 拒绝）复现：第一次 `getOrCreate` 成功，`alive=false` 后再调用 → `THREW code=kernel_died "failed to shut down kernel kernel-1"`，**永远无法恢复**。
- **为什么没有测试发现**：`tests/integration/run.test.ts:373-396` 的 describe 标题写着 `sidecar death fails in-flight work; next run replays`，但正文只到 `transport.kill()` + 断言 `kernel_died`，**从未跑第二次 run**（T1）。绿灯掩盖。

**修复建议**：把"清理死会话"与"关闭活 kernel"分开：
```ts
if (existing !== undefined) {
  if (!existing.transport.alive) {
    this.#removeSession(existing);          // 死 transport：直接摘除，交给 #transportFor 重建
  } else {
    await this.shutdown(input.notebookPath);
  }
}
```
并为 `restart()`/`fresh` 路径复用同一判定；同时给 `shutdown` 的失败保留语义加一个 `dead` 标记，让 `findByNotebook`/`requireSession` 把死 session 视同不存在。

**设计文档对齐**：违反 SPEC §5.3（sidecar 生命周期）与 §10.2 **I7 后半句**（"next run replays"）；也违反 AGENTS §6 红线"不得留下孤儿 kernel / 进程不整洁"的对称要求（现在是"留下不可恢复的死会话"）。

---

### R2 🔴 空闲回收的未处理拒绝会把整个 MCP 服务 `exit(2)`

**位置**：`src/kernel/registry.ts:88-90`（`void this.#reclaimIdle()`）、`:453-468`（`#reclaimIdle` 内 **无 try/catch** 的 `await this.shutdown(...)`）、`src/bin.ts:104-116`（`unhandledRejection → fatal → shutdownAll + process.exit(2)`）

**问题描述**：三条改动叠加成一条自杀链：A3 的回收（`await this.shutdown`）+ A30 的 throwing `shutdown` + A23 的 fatal 钩子。`#reclaimIdle` 是被 `void` 掉的定时器回调，其 rejection **没有任何 handler**。

**详细分析**：
- 触发前提与 R1 相同（sidecar 崩溃留下死 session）且**极易达成**：默认 `kernel_idle_seconds=3600` → 约 1 小时后服务自行退出；把 idle 调小则更快。
- `[实验]` 子代理以 `idleSeconds=1` + `shutdownKernel` 恒拒绝运行 7 秒，实测输出：
  ```
  warn: kernel shutdown failed for kernel-1; keeping the session for retry: ...
  UNHANDLED_REJECTION: IpynbError: failed to shut down kernel kernel-1
  ```
  配上 `bin.ts:116` 即 `exit(2)` —— **服务在客户端连接中途消失**。
- 同一条链还有一个更隐蔽的入口：`sidecar-transport.ts:82-91` 的 exit/error 处理只 `#failAllPending`，**不通知 registry**，所以死 session 一定会产生。
- 这也是我在集成测试里**两次都观察到的**那条 `Unhandled Rejection: IpynbError: sidecar exited (code=1, signal=null)`（`sidecar-transport.ts:293`）——同一个机制在测试进程里的表现。

**修复建议**：
1. `#reclaimIdle` 内逐 session `try { await this.shutdown(...) } catch (cause) { this.#logger?.warn(...) }`——回收是维护性副作用，不该有否决权；
2. `process.on('unhandledRejection')` 改为**记 error 日志后继续**（或仅在确实持有 sidecar 且确认无法恢复时才退出），把"未处理拒绝"从服务中断降级为可诊断事件；
3. `sidecar-transport` 的 `exit` 回调应通知 registry 清理该死 session（与 R1 的修法合流）。

**设计文档对齐**：SPEC §5.1（启动期失败退出码 2 的语义是**启动期**，不是运行期自杀）；R19/§6「不得留下孤儿」的意图是**清理**，不是**退出**。

---

### R3 🔴 kernel 自发死亡时，**已完成 cell 的输出完全不写回**（数据丢失）

**位置**：`src/run.ts:332-348`（catch 分支：还原快照后 `if (isAborted(req.abort)) break; throw cause;`）、`src/kernel/registry.ts:415`（`#handleKernelDied` 只清 session，不 abort 在途 run）、`src/mcp/tools/kernel.ts:55-56`（唯一设置 `abortReason='kernel_died'` 的地方是**显式** restart/shutdown）

**问题描述**：OOM/被外部 kill 等在途 cell 抛 `kernel_died` 时，`req.abort` 未被置位 → `isAborted()` 为 false → 直接 `throw`，**已完成的 cell 一个都不写回**，终态也没有 `write_back` 字段。

**详细分析**：
- SPEC §4.8 规则 3 的触发条件穷举里**明确包含"sidecar 的 kernel_died 事件"**，要求"已完成 cell 照常写回并报告 `write_back`"。
- `[读码]` 我全文 grep 确认：`abortController.abort()` 只出现在 `mcp/tools/kernel.ts:55-56`（restart/shutdown 工具）与 `run-status.ts:54-55`（`notebook_run_cancel`）；`registry.#handleKernelDied` 不碰任何 run。
- **A12 的修复让这条路径从"等满 timeout"变成常态**：集成测试自己证明了快失败（`✓ [A12] reports kernel_died within the iopub poll interval, not the full timeout 7041ms`），也就是说"kernel 死了"现在是常见事件，而它的写回语义是错的。
- 影响面同时覆盖**同步与后台** run（同步 run 更是完全没有 abort 通道，W2）。
- 上一轮 A1 我点名的第三种触发路径（"kernel 被 restart"）因此在同步 run 上仍未闭环。

**修复建议**：把"kernel 终结"的收口下沉到 registry——`#handleKernelDied`、`shutdown`、`restart`、`getOrCreate(fresh)` 都应通知 run 层（后台 run 走 `handle.abortReason='kernel_died'` + `abortController.abort()`；同步 run 需要一条 run 级 AbortController 或让 `run.ts` 的 catch 分支也调用 `writeBackCompleted`），使 `run.ts:439-448` 的写回分支对两条路径一致生效。

**设计文档对齐**：SPEC §4.8 规则 3/5；AGENTS §7 陷阱 4。

---

## 四、🔴/🟠 声明为 ✅ 但代码里不存在（虚报）

| 编号 | 严重度 | 位置 | 声明 | 实际 |
|---|---|---|---|---|
| **V1** | 🔴 | `src/kernel/sidecar-transport.ts:56-92,268-287` | A20「stdio 三条流挂 `error` 监听 + 写前 `destroyed` 检查」 | 构造期只有 `stdout.on('data')`、`stderr.on('data')`、`child.on('exit')`、`child.on('error')`；全仓 grep `stdin.on(` / `stdout.on('error'` / `stderr.on('error'` / `destroyed` / `writableEnded` **零命中**；`:280` 的 `stdin.write` 无回调 `[读码 + 子代理实验]` |
| **V2** | 🟠 | `sidecar-transport.ts:274-277` | A22「传输层超时后回收 sidecar 进程树」 | 超时只 `#pending.delete` + `reject(kernel_died)`；全仓 `kill()/#killTree()` 只有 `:148`（shutdownAll）与 `:212`（framing error）两个调用点，且 `kill()` 在 `:153` 因 `#exited` 早退 `[读码]` |
| **V3** | 🟠 | `src/run.ts:530-540` | A31「run 主写回传 abort signal」 | 主写回参数对象里**没有** `signal` 字段；`git show f00d765 -- src/run.ts` 对该文件只有一个 hunk（给 `:589-591` 加注释）。`WriteOptions.signal` 确实存在且 `mcp/tools/edit.ts:80` 传了 → 即只有 run 这一处漏 `[读码]` |
| **V4** | 🟡 | `sidecar-transport.ts:82-91` | A23「sidecar 异常退出也回收进程树」 | 钩子本身已加（`bin.ts:101-116` ✅），但"异常退出回收进程树"不存在：exit 处理器只 `#failAllPending` `[读码]` |

**V1 的机制后果**（子代理实验）：对不读 stdin 的子进程 `stdin.write(8MiB)` 后 `SIGKILL`，**无监听时**该错误升级为 `uncaughtException: EOF` → 被 A23 钩子接住 → `exit(2)`。也就是说 A23 把 A20 的缺陷从"静默崩溃"升级成"**会话中途服务退出**"，与声明里的"返回 `kernel_died` 继续服务"完全相反。

**V3 的后果**：违反 SPEC §4.1.10 / §4.6.2 / R18（写入应响应取消信号）。"完成 cell 的写回故意不传 signal"作为设计是可辩护的（§4.8 规则 3 优先），但那属于应登记 DEVIATIONS 的取舍，**不能拿它掩盖主写回这处真的漏了**。

**流程建议**：`REVIEW-FIX-STATUS.md` 的 ✅ 不应作为验收依据。本轮已证实同表内至少 3 行虚报、1 行半虚报。建议整改方在标记 ✅ 时附**可复现的验证命令/断言位置**，并在下一轮由人类抽查。

---

## 五、🔴 既有缺陷未修（本应在本轮修掉）

### W1 🔴 `notebook_locked` 实际不可达 —— I15 稳定失败

**位置**：`src/fs/notebook-file.ts:18-31`（`readNotebookFile`）、`:91-101`（写前复检读）

**问题描述**：这两处只映射 `ENOENT` → `file_not_found`，其它 errno 一律 `throw cause`；Windows 上"文件被独占打开"时**第一个操作就会失败**，于是模型看到的是 `internal` 而不是 `notebook_locked`。

**详细分析（我自己的实验）**：我用与 I15 相同的 `CreateFileW(path, GENERIC_READ, dwShareMode=0, ...)` 持有文件后逐操作探测 `[实验]`：

```
readFile (初始读)      FAIL code=EBUSY errno=-4082
copyFile (备份)        FAIL code=EBUSY      ← 这一条有 isLockError 映射 ✅
open wx (临时文件)      OK
rename over target     FAIL code=EPERM      ← 这一条有映射 ✅
writeFile (直接写)      FAIL code=EBUSY
```

即：备份与 rename 的锁映射都写好了，**但读路径先失败**，永远走不到它们。实测门禁也印证：连跑两次集成都是 `expected 'internal' to be 'notebook_locked'`，1.5 秒内稳定复现 `[实跑]`。

**修复建议**（约 6 行）：在 `readNotebookFile` 与 `writeNotebookFileUnlocked` 的复检读里复用已有的 `isLockError`（`src/fs/atomic.ts:170-178`）：

```ts
} catch (cause) {
  if (errnoCode(cause) === 'ENOENT') throw new IpynbError('file_not_found', ...);
  if (isLockError(cause)) throw new IpynbError('notebook_locked', `notebook file is locked by another process: ${absolutePath}`, { path: absolutePath });
  throw cause;
}
```

顺带：`notebook_read` 读到被独占的文件同样会落进 `internal`，同一处修改一并覆盖。

**设计文档对齐**：SPEC §10.2 **I15**（"被独占打开的文件上写入 → 抛 `notebook_locked`，非 `internal`"）、SPEC §7 错误码定义、**AGENTS §7 陷阱 7**（"覆盖被占用文件会 EBUSY/EPERM（抛 `notebook_locked`，不要落进 `internal`）"——项目自己的规则写得很清楚）。

### W2 🟠 门禁声明不实（见 §一）

`REVIEW-FIX-STATUS.md` 第八节"集成 35/35"、`COMPATIBILITY.md` 的"26/26"都不成立。真实值：**单测 185/185 ✅、集成 34/35 ❌ + 1 未处理拒绝**。这直接影响"是否可发布"的判断，必须更正。

---

## 六、🟠 部分修复与残留

| 编号 | 严重度 | 位置 | 问题 | 修复方向 |
|---|---|---|---|---|
| **W3** | 🟠 | `run.ts:584-596` | 超时/取消的**写回失败会顶掉主错误码**：`writeNotebookFile` 在复检不匹配时抛 `file_changed`、锁文件时抛 `notebook_locked`，于是 `run.ts:429` 的 `exec_timeout`（或 `:443` 的 `cancelled`）永远抛不出去，模型看到的是 `file_changed` | `writeBackCompleted` 包 try/catch，把失败并入主错误 `detail.write_back = {performed:false}`；这与 D4/A30"不掩盖 timeout 主结果"的整改意图一致 |
| **W4** | 🟠 | `src/mcp/render/read.ts:90,101` | **A5 的 read 侧预算坐标系错误**：`maxImages: budgeted`（=剩余预算 `min(imageBudget, maxImagesPerCall)`）配 `indexStart: imageCursor`（=**绝对**游标），而 `applyImagePolicy` 用 `imageIndex >= maxImages` 比较两者。例：`max_images=20`，cell1 出 9 张（游标 9、剩余 11），cell2 出 5 张 → 只物化 2 张（应 5 张）并**误报 `image_limit`**；run 侧（`run.ts:356-359`）是绝对量配绝对量，写法正确 | `read.ts` 改为 `maxImages: input.maxImagesPerCall`（与 run 对齐），或 `indexStart: 0` 后自行加偏移；补一条真正驱动 `renderReadResult` 的跨 cell 用例（现有 `outputs.test.ts:335-357` 自己模拟循环，不驱动真实调用点） |
| **W5** | 🟠 | `registry.ts:170-172,354-362`；`run.ts:288` | **A6 的 run 锁挂在 session 对象上**：`notebook_kernel restart` 或 replay 的 `fresh` 换掉 session 后新 session `runActive=false`，第二个 run 直接进入；旧 run 既不终结也不写回。根因是 `acquireRun` 在 `getOrCreate` **之后**才拿锁 | 锁改为 registry 内以**规范化 notebook 路径**为键的独立表（与 session 生命周期解耦），并提到 `getOrCreate` 之前 |
| **W6** | 🟠 | `src/config.ts:140,168-177,299-303` | **A16 只修了 env，CLI 同型漏洞仍在**：`--exec-timeout-seconds=` / `--opt ""` 产出空串 → 校验循环 `continue` → `Number('')`=0。子代理实测 `--exec-timeout-seconds=` → `execTimeoutSeconds: 0` 且 `errors: []`（每个 cell 立即超时）、`--kernel-idle-seconds=` → `0`、`--python ""` → `python: ''` | 在 `parseCliArgs` 后把空串按"未设置"处理，或把 `:301` 的 `value === ''` 改为报错；补 `--exec-timeout-seconds=` 用例 |
| **W7** | 🟡 | `src/fs/notebook-file.ts:69` | **A17 的清理判断恒假**：`writeLocks.get(key) === next.catch(() => undefined)` 每次 `.catch()` 都返回**新** promise，比较永远为 false → 删除分支是死代码，`writeLocks` 每个路径永久留一个已 settle 的 promise（我亲验该表达式为 false）`[读码+实验]` | `const pending = next.catch(() => undefined); writeLocks.set(key, pending); … if (writeLocks.get(key) === pending) writeLocks.delete(key)`；键改用 `normalizeForCompare`（Windows 大小写） |
| **W8** | 🟡 | `registry.ts:142-145`、`atomic.ts:57-62`、`mcp/tools/run.ts:74-80` | A18 的 status 失败分支**谎报 `alive:false`**（与"确认死亡"不可区分）且 N 个会话串行最坏 N×15s；A25 新增 `catch { return; }` **空 catch（正是 R7 要拦的形状）**；A28 的 abort 监听仍无 `{once:true}`/移除 | 失败时保留 `base.alive` + 加 `kernel_status_unavailable` warning；多会话 `Promise.all`；空 catch 补 `warn`；abort 监听加 `{once:true}` |
| **W9** | 🟡 | `run.ts:531-537` | 主写回未传 `onCleanupError` → A13/A25/A29 的 warn 落到 `atomic.ts` 默认 sink（直接 `process.stderr.write`），**绕过 `src/log.ts` 与 `--log-level`** | 补 `onCleanupError: (m) => deps.logger?.warn(m)`（`:584-592` 那条已传） |
| **W10** | 🟡 | `src/core/edit.ts` 选择器解析 | A10 只拦了 `'1-2-3'`；`-1` 仍被静默解析为 `0-1`（同类残留） | 选择器首字符为 `-` 时报 `invalid_targets` |

---

## 七、🟡 测试维度

**做对的**（子代理逐条验证并做了对照实验）：D3（工具层 CAS/`dry_run` 三条判定真断言）、D5（五处弱断言全部改实）、D6（`JUPYTER_PATH` 保存恢复 + I11 自包含可单独跑）、D7（4 项边界值齐备且断言到位）、D2（判别力经"真 sidecar vs 朴素 AST 对照"实测成立）、D1 的 timeout 半（I5/I18/I18b 对 A1 回归**回退即变红**）。

**仍然存在的问题**：

| 编号 | 位置 | 问题 |
|---|---|---|
| **T1** | `tests/integration/run.test.ts:373-396` | **I7 名不副实**：describe 承诺 `next run replays`，正文从不跑第二次 run、全仓无 `mode_used==='replay'` 断言 → 这正是 R1 无测试发现的直接原因 |
| **T2** | `run.test.ts:517-538` | **I10 无判别力**：第二个 run 必然落在第一个 run 唯一的 `time.sleep(3)` cell 内，仅 per-exec `busy` 也会抛 `kernel_busy` → **把 `registry.acquireRun` 整个删掉该用例仍绿**，A6 实际无守卫 |
| **T3** | `tests/integration/server.test.ts:109-111,157,290,317-321` | 夹具仍硬编码 `outputs: []` → I16 的"未执行 cell 未被动过"在空值上天然成立、**对 A1 类缺陷免疫**；I13 的 reject 分支 `expect(String(failure)).toBeTruthy()` **恒真**；I16 `:290` 把 D4 要求排除的 `completed` 又放回 |
| **T4** | `tests/unit/markdown.test.ts:162`、`edit-tool.test.ts:135`、`kernel.test.ts:141`、`run.test.ts:329-341` | U4 的"校验先于写入"在**真写路径上无守卫**（一处无写入者、一处是 `dry_run:true`）；`toContain(['error','timeout'])` 双向通过；I18b 单 cell 无法验证标题里的 "only" |
| **T5** | `tests/unit/analyze-op.test.ts:77-140` + `.github/workflows/ci.yml:9-32` | **U20 在"单测"里建 venv + 起真 kernel + 跑 cell，违反 AGENTS §9**；且 `PYTHON_AVAILABLE` 只探测解释器、不探测 ipykernel，而 CI 的 unit job 不装 ipykernel → 一旦 CI 真跑，用例 4 会**失败而非跳过**；同时 integration job **不跑** `pnpm test`，所以 D2 的护栏目前在任何 job 里都不成立 |
| **T6** | 全仓测试名 | 编号体系漂移：新增用例用 `[D7]`/`[A11]`/`[A12]`/`[I18]`/`[I-env]` 等**非 SPEC §10.2 词汇**（SPEC 只到 I17），既未补入 SPEC 也未登记 DEVIATIONS。带编号用例占比 **100/220 = 45.5%**（上轮 78/174 = 44.8%，基本未改善）；只算 `it` 标题则仅 3/220 |

---

## 八、🟡 文档视检（本轮新增的检查维度）

| 文档 | 结论 | 证据 |
|---|---|---|
| `docs/DEVIATIONS.md`（D-001~D-017） | **主体质量高**：17 条都能落到具体代码，无"为登记而登记"，D-017 自标"部分实现"是本轮最诚实的一条。但有 4 处不实/过时 | 见下 Doc1–Doc4 |
| `docs/REVIEW-FIX-STATUS.md` | ⚠️ **自相矛盾 + 3 处虚报**：§一/§八称批次 5b 完成（D-007~D-011），但 §三 表格 B2/B3/B5/B6 仍标 ⬜；A20/A22/A31 虚报（V1–V3）；§六 E2 的"豁免面集中声明在 `src/kernel/interpreter.ts`"不存在（Doc3） | `[读码]` |
| `docs/COMPATIBILITY.md` | ❌ **计数过期**：`:18` 仍写 `148/148 ✅ \| 26/26 ✅`（应 185 / 34–35）；这也是全仓唯一一处"实测记录"，过期后即误导 | `[读码]` |
| `CHANGELOG.md` | ❌ **完全未更新**：`:22` 仍写"Deviations 见 D-001 ~ D-006"（落后 11 条），无审查整改、后台阈值、并发守卫、图片上限的任何记录 | `[读码]` |
| `README.md` | ⚠️ 部分一致：E3 图片上限（`:71`）与"一个 notebook 同时只允许一个 run"两条与实现一致；但 `:51` 的 `--background-threshold-seconds` 说明**未反映 ×10**，也没有 E1 行为变化条目；「已知限制」漏了"协议错误会重启 sidecar（连带杀 kernel）"这一更严重后果 | `[读码]` |
| `docs/E2E-CHECKLIST.md` | ✅ 非空且诚实（明确"由 boss 执行留档"），但**"证据"列 9 行全空** → SPEC §10.4 DoD 最后一项仍未达成 | `[读码]` |
| `docs/OPEN_QUESTIONS.md` | ✅ 与 SPEC §12 逐行字符级比对 **0 处差异** | `[读码]` |
| `docs/archive/README.md` | ✅ 诚实说明"原始 v1/v2 不在本仓库，无法归档实体" | `[读码]` |

**具体文档缺陷**：

- **Doc1 🟡** `COMPATIBILITY.md:18` 计数过期（148/26 → 185/34-35）。
- **Doc2 🟡** **D-015 的"影响面"栏与实际判定式差一个数量级**：代码是 `timeoutSeconds × targetCount > threshold × 10`（`mcp/tools/run.ts:82-90`）→ 默认 `300 × 1 = 300 > 300` 为假（同步），`300 × 2 = 600 > 300` 为真（后台）。**即只有单 cell 走同步**；而 D-015 写的是"默认单 cell（300）**与 2–10 cell（600–3000）改走同步**；11+ cell 仍转后台"——后者需要 ×100 才成立。`[实跑]` 我用 PowerShell 核算了 1/2/3/10/11 cell 的全部取值。回归用例 `[D-015]` 只断言了单 cell 情形，所以不会变红。**同时**：`README.md:51` 未反映 ×10。建议二选一——把常量改成与文档一致（×100，使"≤10 cell 同步"成立），或把文档改准并说明这是 stop-gap。
- **Doc3 🟠** **D-016 的"豁免面集中声明在 `src/kernel/interpreter.ts`"不成立**：对该文件 grep `R6|fence|豁免|exempt|outside|PathFence` **零命中**（文件头 `:1-7` 只描述候选链）。同一句不实声明出现在**三处**：`DEVIATIONS.md` D-016、`REVIEW-FIX-STATUS.md` §六、提交 `f03a5b3` 的 message。且豁免措辞与实现相反：D-016 说"R6 约束**用户文件**（notebook/artifact/备份）"，但 **artifact 默认就写在 root 之外**（SPEC §5.9 规定默认根为 OS 缓存目录，`config.ts:212-226`，启动即 `mkdirSync(config.ts:418)`，写入 `fs/artifact.ts:105`，全程不过围栏）。在 R6"不碰 root 之外"这一**安全承诺**语境下，这是最不该出错的一条。
- **Doc4 🟡** D-004 已过时（描述旧判定式且未交叉引用 D-015）→ 读者会看到两个互相冲突的"现行公式"。
- **Doc5 🟡 漏登记 4 条本轮实际偏离**：① `docs/archive/` 无 v1/v2 实体；② A6 的 run 级锁比 SPEC §5.3 字面**更强**（实质加严）；③ A9 `clear_outputs` 拒绝非 code cell 与 A11 的错误码分工（SPEC §4.5/§4.7 未定义）；④ README/config 的后台阈值语义漂移。
- **Doc6 🟡** 协议字段名偏离未登记：`analyze` 的失败索引在 SPEC §5.8 表格里是 `failed_cell_indexes`，实现（含 sidecar `python/ipynb_sidecar.py:338` 与 TS `src/kernel/transport.ts:48`）统一改成了 `failedCellIndexes`。D2 借此修掉一个真 bug（字段名不一致导致失败索引一直丢失）**是好事**，但按 D15/AGENTS §5 的 snake_case 约定以及 SPEC 字面，这属于偏离，应登记或改回。

---

## 九、🟡 仓库卫生（发布前必须清）

| 编号 | 路径 | 问题 | 动作 |
|---|---|---|---|
| **H1** | `patch-tmp.py`（23 行，仓库根） | 一次性 Python 补丁脚本（用正则改 `src/kernel/registry.ts`，即 A30 的修复），随被它修改的提交 `f00d765` 一起入库；补丁结果已在代码里，脚本 100% 冗余。**它同时是行尾符污染的来源**：Python 文本模式写文件在 Windows 上把 `\n` 变成 `\r\n` | `git rm` 删除；后续改用编辑工具并复查 diff |
| **H2** | `.workbuddy/memory/{MEMORY.md,2026-10-02.md}` | 编码 agent 的**工作记忆**被提交：泄露本机绝对路径 `E:/Work/ipynb-mcp/ipynb-mcp`、`E:/tool/anaconda/ana/envs/yolo/python.exe`（含 conda 环境名）；内容已过期（写着"148/26"） | `git rm -r --cached .workbuddy` + `.gitignore` 加 `.workbuddy/` |
| **H3** | 全仓 | **行尾符混乱**（我实测）：`git ls-files --eol` → **53 个文件 CRLF、28 个 LF、5 个文件内部混合**（`src/core/parse.ts`、`tests/unit/{config,edit,fence,markdown}.test.ts`），**无 `.gitattributes`**。后果：`git diff` 把整文件报成重写——`src/core/markdown.ts` 显示 252 增 / 241 删，但 `--ignore-all-space` 后**真实变更只有 20 增 / 9 删**；`protocol.ts` 94/85 → 14/5。**这直接损害审查与 `git blame` 的可信度** | 加 `.gitattributes`（`* text=auto eol=lf`）后 `git add --renormalize .` 单独提交一次 |
| **H4** | `.gitignore` | 缺 `.workbuddy/`、`patch-tmp*`、`*.tgz`（README 让人类跑 `npm pack`，会在根目录产出 `ipynb-mcp-0.1.0.tgz`）、`artifacts/` | 补 4 条 |
| **H5** | `docs/E2E-CHECKLIST.md:9,15` | 第二处本机路径泄露（`node E:/Work/ipynb-mcp/ipynb-mcp/lib/bin.js …`、`cd E:/Work/...&& pnpm build && npm pack`） | 改占位符 `<repo>/lib/bin.js` |
| **H6** | 全仓 | ✅ **无凭据/密钥**（扫 `password\|api_key\|secret\|private key\|npm_\|ghp_` 仅命中 `progressToken` 与测试字符串）；`tests/.venv-test` **从未被提交**（`git log --all -- tests/.venv-test` 为空） | — |

---

## 十、发布链与 CI（C 类复核结论）

- ✅ **C1–C6 真修且可验证**：`prepack`/`prepublishOnly`/`files` 齐备，**tarball 实测 132 项含 `lib/bin.js`（shebang ✓）与 `python/ipynb_sidecar.py`**；`typecheck` 字面正确；C6 七小项全部落实（`-h`、POSIX `/` 拒绝、探测 5s、平台感知比较、表格分隔行、sidecar except 记日志、清理诊断走 logger）。
- ✅ **B1/B2/B4/B6 真修**：`src/mcp/**` 零 `node:fs`/`node:child_process`（递归 grep 验证）；解释器解析收敛到 `resolveForNotebook`；`readNotebookMetadata` 消除重复；D-007~D-011 登记到位。
- ⚠️ **B3/B5 部分**：`AGENTS.md` §4 的目录树**未同步**（仍列已不存在的 `model`/`lock`/`progress.ts`，缺 `src/run.ts`、`hash.ts`、`fs/markdown-targets.ts`、`fs/notebook-file.ts`、`mcp/context.ts`、`mcp/tools/result.ts`）；`run-store` 的反向 `import type` 未消除（已登记，评审本就认可）。
- 🟠 **CI 从未运行**：`git remote` 为空。因此 `ci.yml` 的 12 个矩阵组合（3 OS × 2 node + 2 OS × 2 py）从未被真实执行，其中已知两处会在首次运行时出问题：unit job 不装 ipykernel 而 `analyze-op.test.ts` 的 U20 要真 kernel（T5）；integration job 不跑 `pnpm test`（D2 护栏落空）。
- ⚠️ AGENTS §3 要求"集成测试在本地无 Python 时允许跳过，但**必须在 CI 上跑**"——目前 CI 未跑，这条不满足。

---

## 十一、总体评估

### 评级：**C（需返工）** —— 与上一轮同级，但性质完全不同

**上一轮的问题是"没修、没测"；这一轮是"核心数据安全确实修好了，但 kernel 生命周期引入了 3 个 P0 回归，并有 4 处声明与代码不符"。**

**值得肯定的部分（进步是真实的）**
1. **A1 数据安全主路径真的修好了**，而且用预置 outputs 的集成用例（I5/I18）做到"回退即变红"——这是上一轮最严重的问题，本轮闭环。
2. **A2 环境透传、A8/A9/A11/A13/A14/A15/A21/A24/A26/A27/A29、B1/B2/B4/B6、C1–C6 全部真修**，多数带回归用例；tarball 实测通过。
3. **测试质量实质提升**：D3/D5/D6/D7 全部真修；D2 的分析器单测经"真 sidecar vs 朴素 AST"对照实验证明有判别力。
4. **文档纪律明显改善**：`SPEC.md`/`AGENTS.md` 一字未改（正确做法），17 条 DEVIATIONS 无一条敷衍，D-017 主动自标"部分实现"。
5. **修复过程中自查出 2 个真实缺陷**（`kernelspec_mismatch` 漏发、失败 run 的 `executed` 为空），并在提交信息里如实记录了一次"补丁因缩进变化静默未生效"——这种诚实应当鼓励。

**必须返工的部分**
1. **3 个 P0 回归**（R1 死 transport 永久卡死、R2 回收路径 exit(2)、R3 kernel 死亡不写回已完成 cell）——全部集中在 `registry.ts` 的 session/transport 生命周期与 `run.ts` 的终结写回，属于"上一轮修复互相叠加产生的次生灾害"。
2. **1 个稳定失败的集成用例 + 不实的门禁声明**（W1/W2）——`notebook_locked` 映射缺失，且"35/35"从未成立。
3. **3 处 ✅ 虚报**（V1–V3）——比缺陷本身更危险，因为它破坏的是"声明可信度"。
4. **卫生与文档收口**（H1–H5、Doc1–Doc6）——半小时到一小时的机械工作，但不做会让开源仓的第一印象很差。

### TOP 3（按优先级）

| # | 问题 | 为什么最优先 |
|---|---|---|
| 1 | **R1**：sidecar 崩溃后该 notebook 永久无法 run | 唯一一个**永久性**故障（只能重启进程），且打断了 SPEC §5.3 明确承诺的恢复路径；而 I7 的用例名恰恰承诺了这条却没测 |
| 2 | **R2 + V1**：两条可达的 `exit(2)` 路径（回收未处理拒绝；stdio 无 error 监听） | 服务在客户端连接中途消失，用户侧表现为"agent 突然连不上"；A23 的钩子把原本可恢复的错误升级为致命 |
| 3 | **R3 + W3**：kernel 死亡/超时时已完成 cell 不写回、且写回失败会顶掉主错误码 | 直接违反第一卖点"不会静默改坏"的对称承诺（**不会静默丢失已完成的工作**）；A12 的修复让这条路径成为常态 |

**紧随其后**：W1（`notebook_locked`，一个 6 行修复就能让集成回到全绿）、W4（read 图片预算）、T1/T2（让 I7/I10 真正有判别力）、H1–H3（卫生）。

### 建议返工顺序

1. **R1 → R2**（同一处 `registry.getOrCreate`/`#reclaimIdle`/`shutdown` 的语义重构：区分"传输已死"与"显式关闭失败"；回收循环 try/catch；exit 处理通知 registry）；
2. **R3 + W3**（kernel 终结统一 abort 收口 + 写回失败不掩盖主错误码）——与 R1 的 session 清理是同一片代码，一起改；
3. **W1**（`isLockError` 映射到读路径，集成回绿）+ 更新 `COMPATIBILITY.md`/`REVIEW-FIX-STATUS.md` 的真实计数；
4. **V1/V2/V3/V4**：补齐 A20/A22/A23/A31 的真实实现，或把它们改回 ⬜ 并在 `REVIEW-FIX-STATUS.md` 注明"未实现"；
5. **W4/W5/W6/W7/W8/W9**（局部修正）+ **T1/T2/T3 的测试补强**（尤其 I7 的"下一次 run 走 replay"、I10 让第二个 run 落在 cell 间隙、`server.test.ts` 换带 seed 的夹具）；
6. **文档与卫生收口**：Doc1–Doc6、H1–H5、`.gitattributes` 归一化；
7. **CI 首次真跑**（加 remote 后）：修 T5 的 unit/integration job 分工，确认 12 个矩阵组合真的绿；
8. **最后才是 E1–E9 手工端到端**（`docs/E2E-CHECKLIST.md` 证据列仍全空，DoD 未达成）。

### 与上一轮相比的偏离清单变化

- **新增登记**：D-007~D-017（11 条，质量合格）。
- **仍未登记**：Doc5 的 4 条 + Doc6 的协议字段名。
- **SPEC v3.1 建议修订**（D-015 判定式量纲、R6 豁免措辞与 artifact 默认根、§5.8 上限公式/分帧、D-004 交叉引用）——应在下一轮一并处理，否则实现与文档会继续互相漂移。

---

## 附录 A：本轮实际执行的验证命令（可复现）

```powershell
# 门禁
cd E:\Work\ipynb-mcp\ipynb-mcp
pnpm typecheck ; pnpm lint ; pnpm test        # 0 错 / 0 警 / 185 passed
pnpm test:integration                          # 34 passed, 1 failed + 1 unhandled rejection（跑两次同结果）
npx vitest run --config vitest.integration.config.ts tests/integration/locked-file.test.ts  # 稳定复现 internal vs notebook_locked

# 锁语义实验（与 I15 相同的 dwShareMode=0 独占句柄）
node $env:TEMP\lock-probe.mjs   # readFile=EBUSY / copyFile=EBUSY / open-wx=OK / rename=EPERM

# 变更与真实改动的区分
git diff --stat 3a9c6d3 HEAD
git diff --numstat --ignore-all-space 3a9c6d3 HEAD -- src/core/markdown.ts src/kernel/protocol.ts src/run.ts
git ls-files --eol | Select-String 'w/mixed'    # 5 个文件内部混合行尾符
git ls-files | Select-String 'workbuddy|patch-tmp'
git remote -v                                    # 空 → CI 从未运行
npm pack --dry-run                               # 132 项，含 lib/bin.js + python/ipynb_sidecar.py
```

## 附录 B：本报告的验证分工与局限

- **主审亲验**：全部门禁实跑；I15 失败复现与根因实验；R1/R2/R3 的代码与调用链；V1/V2/V3/V4 的"声明 vs 代码"核对；H1–H5 与行尾符实测；Doc1–Doc6；`git remote`；tarball。
- **子代理验证**（各带独立实验，结论我抽查过关键处）：A1–A7（含两条 P0 实验：`getOrCreate` 永久失败、`UNHANDLED_REJECTION`）、A8–A31（含 A16 CLI 空值实验、A20 的 EOF→uncaughtException 实验）、D1–D9（含"真 sidecar vs 朴素 AST"对照实验）、B/C/E 与文档卫生（含 tarball 与逐行 diff）。
- **局限**：① 未做 macOS/Linux 实跑（无环境），跨平台结论依赖 CI，而 CI 从未运行；② 未做真实 MCP 客户端端到端（E1–E9 仍空）；③ 子代理是"读码 + 只读实验"，不是"改一行再跑测试"的变异测试，因此"某断言无判别力"的结论基于代码路径分析（T2 已由子代理用"删除 acquireRun 仍绿"的推理给出，未实际改动代码验证）；④ 我未逐行复核 4 个子代理的每一条证据，但对**最严重的 9 条结论**（R1/R2/R3、V1–V4、W1/W2）做了独立确认。
