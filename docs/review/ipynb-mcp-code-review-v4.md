# ipynb-mcp 代码审查报告（第四轮 / v4）

> **审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp` @ HEAD `2db2588`（v3 整改后，5 个提交 / 45 文件；工作树干净）
> **权威**：`SPEC.md` + `AGENTS.md`（本轮仍未改动 ✓；新增偏离登记 D-022~D-031）
> **本轮新增的验证手段**：**真机 E2E 初验**——`node lib/bin.js --root <临时工作区>` 起真 stdio MCP server，用 `@modelcontextprotocol/sdk@1.31.0` 的 Client + StdioClientTransport 当**真客户端**，素材为 5 个真实历史 notebook（含 38 MB / 445 图的那本）+ 6 个现场新建的 fixture。**全程只操作 `%TEMP%` 副本，`E:\ChangeJob` 原件零改动。** 详细过程与证据见 `ipynb-mcp-e2e-smoke.md`。
> **方法**：主审亲跑门禁 + 亲验每条 🔴/🟠 + 三路并行深挖（v3 内核修复核实 / 测试与文档核实 / 新代码独立找茬）
> **日期**：2026-10-03

---

## 一、门禁实测（主审亲跑）

| 门禁 | 实测 | 与声明 |
|---|---|---|
| `pnpm typecheck` | exit 0 | ✅ |
| `pnpm lint` | 0 warnings / 0 errors（57 文件 99 规则 + `scripts/check-format.mjs`） | ✅ |
| `pnpm test` | **222 passed + 1 skipped（223）**，20 文件 | ✅（`COMPATIBILITY.md:21` 已同步为 223） |
| `pnpm test:integration` | **39 passed / 39**，5 文件，296.9 s | ✅（`REVIEW-FIX-STATUS.md:14` 已同步） |
| `pnpm build` / `npm pack` | exit 0；133 文件含 `lib/bin.js`（shebang ✓）+ sidecar | ✅（文档已改 133） |
| E2E 只读模式 | 9/9 入口符合预期（写入口全拒、read 与 kernel status 放行） | 新增验证 |

**四道门禁依旧全绿，且文档数字与实测逐字吻合**（这是第二轮以来保持的好习惯）。

---

## 二、v3 问题闭环核查

| v3 项 | 结论 | 主审证据 |
|---|---|---|
| **ROB-2**（超时后 kernel 未关闭） | ✅ **真修复** | E2E：`timeout_seconds=2` 的 `time.sleep(30)` cell 超时后，`notebook_kernel status` 里该 notebook 的 kernel **已消失**（不再留"注册表看不见但还活着"的孤儿）；`D-025` 已登记 |
| **ROB-11**（超时余量倒挂） | ⚠️ **部分修复**（不变式仍未成立） | E2E：拿到了 `exec_timeout`（不再漂移成 `kernel_died`）✓；但子代理真 kernel 实测显示 `time.sleep` 类 cell 的 interrupt **在 Windows 上根本不落地**（`timeoutMs=3 s` → sidecar 实耗 **38.0 s** = `+35 s`，即"最坏值"是常态），新的 `+45 s` 预算只剩 ~10 s 给 sidecar 关机；注入 36 s/40 s 收尾开销即复现"漂移成 `kernel_died` + `taskkill /T` 连带杀掉同 interpreter 上其他 notebook 的 kernel"。详见 **FID-6 补充** |
| **ROB-10**（kernel 启动失败的诊断） | ❌ **半成品**（stderr 尾巴 ✓ / 退出码符号化 0% 有效、结构化错误无 detail ✗） | 见 **ROB-10 补充** |
| **ROB-2 / ROB-6 / ROB-13 / ROB-14 / ROB-1 / ROB-5 / ROB-9** | ✅ 真修复（真 kernel / OS 进程 / junction 级实测） | ROB-2：超时后 **OS 层确认 kernel pid 消失**、sidecar 子进程只剩 1 个；ROB-6：`mklink /J` 两种拼写 → 同一个 `kernel-1`、`"kernel started"` 仅 1 次、跨拼写的 `acquireRun` 仍 `kernel_busy`；ROB-14：第二次 run 的 `kernel_status` 探测 **1 次**（旧 2 次）；ROB-1：3 次正常 run 的 `addEventListener/removeEventListener` 各 3 次；ROB-5：恰好 1000 通过、1001 拒绝；ROB-9：全仓空 catch **0 命中** |
| **PERF-1/2/3/4、SEC-1/2、QUAL-3/5/7/8/10、ARCH-1/2** | ✅ 真修复 | PERF-1 实耗 64 MiB 单行 **2256 ms**（旧 9442 ms）——但见 **NEW-3** 的残留分析；SEC-1 双保险（协议层 + 工具层都返回 `invalid_arguments`）；SEC-2 堆栈只进 stderr；QUAL-8 cancel **1 ms** 返回终态且枚举不越界；ARCH-1 顺带修掉"数组型 `data` 被丢弃" |
| **ROB-5**（`cell_indexes` 放大） | ✅ **真修复** | E2E：20000 个重复索引 → **去重后** 1 cell / 540 B；1001 个**不同**索引 → `invalid_arguments {count:1001,max:1000}`（`context.ts:26` MAX=1000） |
| **QUAL-8**（cancel 返回非法 state） | ✅ **真修复** | E2E：`notebook_run_cancel` 立即返回 `state=cancelled`，重复调用幂等；`run-status.ts:56-66` 已删 `sleep(50)` |
| **DEP-1**（connection file 落进用户目录） | ✅ **真修复** | E2E：跑完多轮（含 38 MB 读取、后台 run、超时、kill）后工作区 `tmp*.json` = **0**、无 `.tmp-*` 残留；`D-023` 登记（但见 SEC-TOCTOU） |
| **DEP-6**（CI 版本冲突） | ✅ **真修复** | `ci.yml:19-20` 删掉了 `version:` 并注释说明与 `packageManager` 的冲突 |
| **ARCH-1**（mcp 解析 nbformat） | ✅ **真修复** | 转换器已移到 `src/core/outputs.ts:43 rawOutputsOfCell`（读 `output_type`），`src/mcp/render/read.ts` 内**再无** nbformat 字段；**但引入了 FID-2** |
| **ARCH-2**（探测缓存不过期） | ✅ **真修复** | `interpreter.ts:416-435` TTL：成功 30 s、**失败 1 s**（正好覆盖"用户照提示装完 ipykernel 再试一次"） |
| **QUAL-1**（整块缩进错位） | ❌ **未修（我上一轮判定有误，现更正）** | 用仓内 TypeScript parser 遍历 `src/run.ts` 的全部 try：`BAD try@357 indent=4 bodyFirst=6 closeBrace@695 indent=2` → **553–695 整段比正确缩进浅一级**（v3 那处 422-495 修掉了，同类事故平移到 553-695）。我上一轮只抽样了旧行号就判"已修"，属方法错误；`git diff -w` 会掩盖这类问题。**更正 v4 初稿的 ✅** |
| **SEC-1**（未知参数静默忽略） | ✅ 真修复（但有冗余，见 NEW-1） | E2E：传 `cell_selector` 给 `notebook_read` → 协议级 `-32602 Unrecognized key` |
| **PERF-1**（分帧 O(L²)） | ⚠️ **部分修复** | 拷贝那一半修好了，**扫描那一半还在**——见 NEW-3（有量化数据） |
| **TST-1/TST-5** | ⚠️ 待另两路复核收尾 | 单测 U20 的 skip 原因已改为可诊断文本（"cannot use pyzmq sockets"） |
| **DEP-2/3/4/5、QUAL-2/3/5/6/10、ARCH-4/5、H-7** | ✅ 大部分已处理 | `AGENTS.md:94,103` 目录树已含 `src/run.ts`/`interpreter.ts`；`D-022~D-031`（12 条）已登记；`.gitignore:23` 已加 `__pycache__/`；`CHANGELOG.md` 有 v3 整改节；docs 内的本机路径只剩**历史归档的审查报告**（可接受） |

**净结果**：v3 的 P0/P1 级修复**在真实素材上确实成立**（这是我第一次能用真机 E2E 证实修复，而不是只读代码）。

---

## 三、本轮发现

### 维度 3：健壮性与数据完整性（本轮重灾区）

【FID-1】
严重程度：🔴 阻塞
所在位置：`src/run.ts:518`（唯一写入点）；`python/ipynb_sidecar.py:278-283`；缺失的转换本应位于 `src/core/outputs.ts`
问题描述：**执行 cell 后写回的 notebook 不是合法 nbformat**——被执行的 cell 输出用的是 sidecar 私有协议形状 `outputType`（nbformat 要求 `output_type`），且 `execute_result` 缺 nbformat **必需**的 `execution_count`。
详细分析：
1. **真实文件 + 官方校验器的硬证据**（E2E）：
   ```
   CONTROL: 原始 coursework1(1).ipynb → nbformat.validate 通过
   同步跑 cell 3 → write_back={"performed":true,"backup_path":"…bak"}（工具自称成功）
   磁盘上：cell 2（未执行）keys=['data','metadata','output_type']   ← 合法
           cell 3（刚执行）keys=['name','outputType','text']        ← 非法
   nbformat.validate → {'outputType': 'stream', …} is not valid under any of the given schemas
   ```
   同步与后台两条 run 路径**都**受影响（`background.ipynb` 三个 cell 后台跑完后全是 `outputType`）。
2. **一层改名不够**：`{"outputType":"execute_result","data":{…},"metadata":{}}` 即使改名成 `output_type`，仍会因缺 `execution_count` 被判 `'execution_count' is a required property`。
3. **后果**：① 用户文件被静默改坏（无 warning，还报 `performed:true`），JupyterLab/nbconvert/papermill 会报 schema 错或丢输出；② **工具自己读不回来**——再 `notebook_read` 得 `outputs: []`，模型很可能因此重跑，正是产品承诺要消灭的行为；③ 违反 SPEC §4.1.1/D15（"转换只发生在 `parse.ts` 边界"）与 §6 R2/R9。
4. **归属**：`git log -S "cell.outputs = [...result.result.rawOutputs]"` → **`d50f40d`（SPEC §11 第 7b 步）**，即长期存在；**v1/v2/v3 三轮 review 都没抓到**，因为**从来没有一条用例校验过写回文件的合法性**（39 个集成用例只断言 `.text`/`outputs.length` 这类两种形状下都成立的字段；`kernel.test.ts:146-148` 断的是传输层 `rawOutputs`；`run.test.ts:239-243` 的 `output_type` 只出现在"保留既有输出"的夹具里）。
修复建议：
```ts
// src/core/outputs.ts —— 与 rawOutputsOfCell 成对，D15 的唯一边界
export function nbformatOutputsOfRaw(raws: readonly RawOutput[], executionCount: number | null): unknown[] {
  return raws.map((raw) => {
    switch (raw.outputType) {
      case 'stream': return { output_type: 'stream', name: raw.name ?? 'stdout', text: raw.text ?? '' };
      case 'error': return { output_type: 'error', ename: raw.ename ?? '', evalue: raw.evalue ?? '', traceback: raw.traceback ?? [] };
      case 'execute_result': return { output_type: 'execute_result', data: raw.data ?? {}, metadata: raw.metadata ?? {}, execution_count: executionCount };
      default: return { output_type: 'display_data', data: raw.data ?? {}, metadata: raw.metadata ?? {} };
    }
  });
}
```
在 `run.ts` 的两处写回（主写回与 `writeBackCompleted`）前调用；**并补两条用例**：执行后 `nbformat.validate` 通过、执行后 `notebook_read` 能读回刚写入的输出（round-trip）。
设计文档对齐：**违反 SPEC §4.1.1/D15 + §6 R2/R9**；SPEC §5.4 未定义"写回"方向，属 SPEC 缺口，建议登记 DEVIATIONS。

【FID-3】
严重程度：🟠 严重
所在位置：`src/core/edit.ts:277-280`
问题描述：`set_cell_type` → markdown 时把 `execution_count` **置 `null`** 而不是**删除**，写出非法 nbformat（markdown cell 不允许该键）。
详细分析：SPEC §4.5 写规则 4 明文要求"**删除**该 cell 的 `outputs` 与 `execution_count`"。主审独立复现（单 op，无 run）：
```
notebook_edit {set_cell_type → markdown} → applied=1
文件：{"cell_type":"markdown","id":"c0","metadata":{},"source":"print('x')\n","execution_count":null}
nbformat.validate → Additional properties are not allowed ('execution_count' was unexpected)
```
这是**与 FID-1 无因果的第二条污染路径**；且 `serializeNotebook`（`parse.ts:120-127`）只给 code cell 补 `execution_count: null`，不会清理 markdown cell 的残留 → 垃圾键会一直在文件里。`U9` 只断言 `outputs` 被删，无覆盖。
修复建议：`if (cellType === 'markdown') { delete cell.outputs; delete cell.execution_count; }`
设计文档对齐：**直接违反 SPEC §4.5 规则 4** + AGENTS §6"不改坏文件"。

【FID-4】
严重程度：🟠 严重
所在位置：`src/core/parse.ts:134-145`（`selfCheckNotebook` 只做同构重解析）、`src/fs/notebook-file.ts:186/191`
问题描述：**没有任何 nbformat 级自检**——`selfCheckNotebook` 只是"用同一解析器重解析"，而 `parseNotebook` 不看 outputs 条目形状，所以 FID-1/FID-3 的产物 **100% 通过自检**并落盘；`.bak` 是写前状态的字节副本，会把非法状态固化进历史版本。
详细分析：主审的 E2E 正好构成实证——非法文件是被"写前自检通过 + `write_back.performed: true`"写出去的。这是让 FID-1/FID-3 得以长期存在的**结构性原因**。另外 `daeb3d3` 提交信息里的 "add the format guard" 指的是 `scripts/check-format.mjs`（只查制表符与行尾空格），**与 notebook 格式无关**，容易被后人误读为已有格式闸门。
修复建议：在 `selfCheckNotebook` 之后加一层最小结构闸门（不引依赖）：非 code cell 禁带 `outputs`/`execution_count`；`execute_result` 必须有 `execution_count`；`display_data`/`execute_result` 必须有 `metadata`；`stream.name ∈ {stdout,stderr}`；`error` 三字段齐全；未知 `output_type` 拒绝。失败抛 `selfcheck_failed`。
设计文档对齐：SPEC §5.5.5 只要求"同解析器重解析"（不违反字面），但 AGENTS §6 红线"不会静默改坏"要求的是结果；建议登记 DEVIATIONS 并把该检查作为红线实现——它能让 FID-1/FID-3 立刻变红。

【FID-2】
严重程度：🟠 严重
所在位置：`src/core/outputs.ts:55-65`（ARCH-1 修复时新写的 `rawOutputsOfCell`）
问题描述：读回路径对"不认识的 output 形状"**静默丢弃**（整条 `continue`），而被它替换掉的旧 `normalizeRawOutput` 是"降级为 `display_data` 并保留数据"。于是 run 之后 `notebook_read` 报告该 cell **没有输出**——一个错误的断言，而不是"不支持的输出"。
详细分析：主审 E2E 实测：文件里明明有一条 `{"outputType":"stream","name":"stdout","text":"hello v2 3.10.14\n"}`，`notebook_read` 返回 `outputs: []`（而**同一次 run 的返回值**里 `executed[].outputs` 完整——读写不对称）。后果两层：① 误导模型（"这个 cell 没输出"→ 重跑）；② **它顺手抹掉了工具自身发现 FID-1 的唯一通道**。
修复建议：FID-1 修好后本条自然消失；同时建议别再静默丢——未知形状降级为可见的 `unsupported`（带类型线索）或让 `rawOutputsOfCell` 返回 `{outputs, unknownKinds}` 由渲染层追加 warning。
设计文档对齐：转换下移到 core 是对的，但语义被顺手改成"丢弃"；SPEC §5.4 的匹配表未覆盖未知形状（缺口）。

【FID-5】
严重程度：🟠 严重
所在位置：`src/mcp/tools/run-status.ts:37`；`src/mcp/run-store.ts:19`
问题描述：`notebook_run_status` 返回 `write_back={"performed":true,"backupPath":"…"}` —— **camelCase**，而 `notebook_run` 返回的是 `backup_path`（snake_case）。
详细分析：`run-status.ts:37` 写 `write_back: handle.writeBack`，把内部对象**原样透传**；同文件其它字段（`replayed_cell_indexes`、`progress.current_cell_index`）都做了 camel→snake 映射。模型若按 `notebook_run` 的形状解析 `backup_path`，在 run-status 上永远拿到 `undefined`。违反 AGENTS §5/D15 与 SPEC §4.8 的 `write_back:{performed, backup_path}`。
修复建议：`write_back: { performed: handle.writeBack.performed, backup_path: handle.writeBack.backupPath }`（或让 run-store 直接存 snake_case）。
设计文档对齐：**违反 AGENTS §5 / D15 与 SPEC §4.8 返回字段契约**。

【FID-6】
严重程度：🟠 严重
所在位置：`python/ipynb_sidecar.py:294-297`（判为 timeout 后仍等 shell 回复）、`:174-176`（重建 `KernelSpec` 丢掉 `interrupt_mode`）
问题描述：超时上报要等 cell 自然结束——`timeout_seconds=2` 实测 **32.6 s** 才返回（SPEC §4.7 规则 5 是"等待至多 5 秒"）；根因是 Windows 上 interrupt 完全不可用 **且** 判为 timeout 后还空等 30 s 的 shell 回复。
详细分析（主审实测，两条独立证据）：
```
C10: code=exec_timeout elapsed=32636ms  (timeout_seconds=2；cell 是 time.sleep(30))
interrupt_mode='signal' : interrupt did NOT land within 10s
interrupt_mode='message': interrupt did NOT land within 10s
stderr: [IPKernelApp] ERROR | Interrupt message not supported on Windows
```
- 信号模式：kernel 由 Node 以管道无控制台方式启动，`SIGINT`/`GenerateConsoleCtrlEvent` 送不到；
- 消息模式：**ipykernel 在 Windows 上明确不支持**（我原本打算推荐这个修法，实测被推翻）；
- 附带缺陷：`ipynb_sidecar.py:174-176` 重建 `KernelSpec` 时**丢掉了原 kernelspec 的 `interrupt_mode`**（`KernelSpec` 默认 `signal`），即使将来某平台支持也会被降级。
**用户可见后果**：① 超时上报延迟约 +30 s（可修）；② **`notebook_run_cancel` 在 Windows 上停不下正在跑的 cell**（只中止编排并标记 `cancelled`，cell 继续烧 CPU 到自然结束）。集成用例 I5 之所以叫"uninterruptible cell"并耗时 43 s，正是因为这台机器上**所有** cell 都不可中断。
修复建议：① 一旦决定 `status="timeout"` 立即返回（shell 回复只对成功路径有意义），延迟回到 `timeout+~5 s`；② `interrupt_mode` 原样透传；③ README「已知限制」写明 Windows 无控制台场景 interrupt 不生效；④ 若希望取消能止血，Windows 上可改为 `shutdown_kernel`（杀 kernel）兜底，并让 `kernel_shutdown` 字段如实反映。
设计文档对齐：偏离 SPEC §4.7 规则 5 的"等待至多 5 秒"；平台限制需登记。

【NEW-5】
严重程度：🟡 警告
所在位置：`src/mcp/tools/run.ts:212,227-233,248-249`；`src/mcp/tools/run-status.ts:63-66`
问题描述：后台 run 的"立即终态"会被后台任务覆盖（`state` 从 `cancelled` 变回 `completed`），且 `error` 从不清理 → 可出现 `state:"completed"` 搭配 `error:{code:"cancelled"}`，而 SPEC §4.8 规定 `error` 仅在 `failed` 时非 null。
详细分析（子代理：代码路径论证 + 窗口量化，**未端到端复现**；主审未复现）：`run.ts:546` 检查一次 abort，之后到写回开始之间夹着 `mappedTruncated`、stale 分析（sidecar 往返）、序列化/自检/备份，**无二次 abort 检查**，窗口随 notebook 体积线性变宽。另有一条**已实测**的不一致：completed 的 run 其 `progress.completed` 停在 `total-1`（`state=completed progress={completed:1,total:2} executed=2`）。
修复建议：终态只由第一个写者决定（`if (handle.state === 'running') { handle.state='completed'; handle.error=null; }`），并把 `progress` 收口到 `outcome.executed.length`；在写回前补一次 abort 检查。
设计文档对齐：违反 SPEC §4.8 返回契约与规则 4 的"发布终态"顺序。

【NEW-6】
严重程度：🟢 建议
所在位置：`src/kernel/sidecar-transport.ts:381-390`（`#failureDetail`）、`:89`（只增不减的 `#stderrTail`）
问题描述：stderr 尾缓冲从不与"哪个 op 失败"绑定，任何后续失败（含我们自己的 `kernel_status` 15 s 预算超时）都会把最近 20 行 sidecar stderr 当失败原因交给模型——可能是几十分钟前的启动噪音。
修复建议：在 `#request` 记游标、失败时只取增量；只对 `exec_cell`/`start_kernel` 附 stderr。
设计文档对齐：D-030 的意图（把原因交给模型）方向正确，实现把它放大成了"任意失败的通用 detail"。

【SEC-TOCTOU】
严重程度：🟢 建议
所在位置：`python/ipynb_sidecar.py:151-157`
问题描述：D-023 把连接文件从 `mkstemp` 换成**可预测**的固定名，而 `jupyter_core.paths.secure_write` 是"先 `os.remove` 再 `os.open(O_CREAT|O_TRUNC, 0o600)`"，两步之间无独占语义 → 共享临时目录上的符号链接 TOCTOU（危害面窄：需同机账户 + 猜中 pid；权限本身没问题、反向截断也不成立，子代理已实测排除这两个误判）。
修复建议：保持"固定在 temp 目录"，但恢复原子创建（`os.open(..., O_CREAT|O_EXCL|O_WRONLY, 0o600)` 成功后钉住路径，`FileExistsError` 时退回 jupyter_client 自己的 mkstemp）。
设计文档对齐：SPEC §5.9 净结果；D-023 未覆盖"可预测名 → TOCTOU"。

### 维度 3 补充：最后一路复核（真 kernel / OS 进程 / junction 级实测）

【FID-6 补充：ROB-11 的不变式仍不成立】
严重程度：🔴 阻塞（与 FID-6 同一根因）
所在位置：`src/kernel/sidecar-transport.ts:38-40,174-176`（`SIDECAR_WORST_CASE_MS = 5_000 + 30_000`；`transportTimeout = max(timeoutMs + 35_000 + 10_000, 60_000)`，注释写着 `INVARIANT: transportTimeout > sidecarWorstCaseMs + slack`）
问题描述：那条不变式**没有保证**——在 Windows 上"中断未落地 + 30 s shell 等待"是**常态而非最坏情况**，`+45 s` 预算里真正留给 sidecar 关机/收尾的只有 ~10 s；一旦收尾超过 10 s，`exec_timeout` 又会漂移成 `kernel_died`，并且 `#reclaimAfterTimeout` 会 `taskkill /T` 掉整棵 sidecar（同 interpreter 上其他 notebook 的 kernel 连坐）。
详细分析（三方证据一致）：① 主审 E2E：`timeout_seconds=2` + `time.sleep(30)` → 32.6 s；② 子代理真 kernel：`timeoutMs=3 s` → sidecar 实耗 **38.0 s**（`+35 s`），而**纯字节码循环**（`while time.time()<end: pass`）的 interrupt **0.3 s 就落地**——说明差别在"cell 能否被中断"，而 `time.sleep` 这类在 Windows 上**不可中断**；③ 子代理注入 36 s/40 s 收尾开销 → 复现 `kernel_died` 漂移（75 s 处超时）+ 整树回收。主审已核对常量与注释（`sidecar-transport.ts:174-176`），并确认 `'reclaim'` 只对 `exec_cell` 生效（`:176`）。
**关键推论（修法应当合并）**：这条与 **FID-6** 是同一根因的两个面——只要让 sidecar 在决定 `status="timeout"` 后**立即返回**（不再空等 30 s shell 回复），最坏耗时就从 `+35 s` 降到 `+5 s`，这条不变式自然成立、超时延迟也从 32.6 s 降到 ~7 s。建议**一处修改同时关闭 FID-6 与 ROB-11**，并把不变式写成断言（子代理建议：把"sidecar 时间预算"与"Node 能观测到的退出码"各做一条实测门槛进 CI）。
设计文档对齐：SPEC §4.7 规则 5 的"等待至多 5 秒"是被违反的那一条；不变式应写进 SPEC。

【ROB-10 补充：诊断只完成一半】
严重程度：🟠 严重
所在位置：`src/kernel/sidecar-transport.ts:304-310`（结构化错误的 detail）、`:445-467`（`describeExit` 与 `WINDOWS_STATUS_NAMES` 表）、`:381-389`（stderr 尾巴）
问题描述：① **退出码符号化 0% 有效**——Node 的 `'exit'` 事件在 Windows 上拿不到 NTSTATUS：`sys.exit(0xC0000409)` 报 `code=4294967295 (0xFFFFFFFF)`，`os.abort()`（真实 `__fastfail`）干脆报 `undefined`，于是表里 9 个状态名一个都命中不了，还会打印出 `code=undefined (0x0)` 这种错文案；真正的 32 位状态码只存在于 `child.exitCode`（3221226505），代码没读；② **结构化 `ok:false` 错误没有 detail**——`start_kernel` 失败时 `detail` 恒为 `{}`，sidecar 明明已把原因写进 stderr（如 `FileNotFoundError: No usable temporary directory …`），但 stderr 尾巴机制只覆盖"崩溃"路径。
详细分析：这两点都由子代理用真实进程实测（stub sidecar 崩溃 + 直接量 Node 的 exit 语义 + 用本机坏 venv 触发 `start_kernel` 失败）。**这正是主审 E2E 里 ROB-10 的原始诉求**：用户拿不到可自助的失败原因。修法很小：改读 `this.#child.exitCode`、处理 `code === null || undefined`、并让 `#dispatchResponse` 的 `ok:false` 分支也并入 `#failureDetail()`。
设计文档对齐：D-030 的意图（把真实原因交给模型）只落实了一半。

【DEP-1 降级路径：新引入的失败形态】
严重程度：🟠 严重（🔁 修出新问题；触发条件待实现者复核）
所在位置：`python/ipynb_sidecar.py:150-157`
问题描述：钉连接文件路径的 `try/except` **只 warn 就放过**——`tempfile.gettempdir()` 抛错时 `km.connection_file` 保持 jupyter_client 默认值，随后 `mkstemp` 抛同一个异常 → `start_kernel FAILED: internal … detail {}`，**kernel 起不来**；子代理称改动前该路径会退回 cwd 建 `tmp*.json` 并成功启动。
详细分析（主审核对 + 一处不一致需要澄清）：主审已确认代码事实（`except` 只 `send_log("warn", …)`，无回落）。**但主审实测本机 `tests/.venv-test` 的 `tempfile.gettempdir()` 是成功的**（回落到仓库根 `E:\Work\ipynb-mcp\ipynb-mcp`，不抛异常），与子代理"本机 venv 即此形态"的刻画不一致——他们的实验里出现了 `fake-project` 这一候选目录，看起来是**手工构造的 tempdir 全失效**场景。因此：这条的**代码路径是真的**（tempdir 解析失败 → 启动失败且只报 `internal`），但**触发条件是否可达需实现者复核**；主审不把它升级为"已确认的用户态回归"。
修复建议：`except` 里回落到一个确定可写的目录（当前工作目录作为最后手段，并按 SPEC §5.9 登记为偏离），或至少让失败信息带上 `#failureDetail()` 的 stderr 尾巴；把"钉不住 → 启动失败"登记进 DEVIATIONS。
设计文档对齐：SPEC §5.9 净结果 + D-023 未覆盖该降级路径。

【QUAL-6 残留 + cell_selector 放大】
严重程度：🟡 警告（两项）
所在位置：`src/fs/backup.ts:100`；`src/run.ts:110,118,127,137,144,149,159`
问题描述：① `backup.ts:100` 仍硬编码 `[ipynb-mcp] warn ` 前缀（主审已核对），而生产 sink 是 `logger.warn`（`log.ts:44` 自己会加前缀）→ **双前缀双级别**在"备份裁剪失败"这条路径上原样保留（v3 的 QUAL-6 只修了 `atomic.ts`）；② **`cell_selector` 无长度上限且在 7 处 `invalid_targets` 的 message/detail 里原样回显**（主审核对：`cell_selector: selector` 出现 7 次）→ 与 ROB-5 完全同型的"入参放大响应"，传 100 MB 字符串就能拿到 100 MB 回显。
修复建议：① 去掉 backup.ts 的前缀并 grep 全仓 `[ipynb-mcp]` 只允许出现在 `log.ts` 与兜底 sink；② 给 `cell_selector` 加长度上限（如 4096）并在 detail 里截断——这是 ROB-5 修法的同一处方，本轮只覆盖了 `cell_indexes`。
设计文档对齐：SPEC §4.1.12（数组/字符串长度校验）+ AGENTS §5 日志规范。



### 维度 4：性能与资源效率

【NEW-3】
严重程度：🟠 严重
所在位置：`src/kernel/protocol.ts:92-105`（`#indexOfNewline` 每次从第 0 块重扫）
问题描述：PERF-1 只修掉了 O(L²) 的**拷贝**（`Buffer.concat`），`#indexOfNewline` 的 O(L²/chunk) **扫描**仍在：64 MiB 单行仍要秒级阻塞唯一的 stdio 服务线程。
详细分析（主审实测，两种 chunk 尺寸对照）：
```
16 MiB / 64 KiB chunks ( 256 pushes):  130 ms
32 MiB / 64 KiB chunks ( 512 pushes):  516 ms
64 MiB / 64 KiB chunks (1024 pushes): 1880 ms   ← 旧实现 9442 ms（改善 5×）
64 MiB /   1 MiB chunks (  64 pushes):  152 ms
64 MiB /   4 MiB chunks (  16 pushes):   66 ms
```
数据量固定、耗时随 push 次数近似平方增长 → 复杂度未消。触发条件是合法的：`exec_cell` 回包含 base64 图片，64 MiB 是 SPEC §5.8 的上限而非异常值；其间所有 JSON-RPC（含 progress 与其它工具）全停。
修复建议：记住"已确认无换行的前缀"（`#scanFrom`），每次只扫新 chunk，把总量摊还成 O(L)；`#take` 按消费量回退游标。
设计文档对齐：SPEC §5.8 语义不变；建议把该场景写成 U22 的**量化**断言（现有 U22 只测正确性）。

【NEW-4】
严重程度：🟡 警告
所在位置：`src/kernel/registry.ts:127-135`（`#norm` 每次现算 realpath）、`:145`（`findByNotebook` 循环内每 session 一次）
问题描述：D-026 为路径身份引入 realpath，但实现是"每次比较都现算" → `#findSessionByNotebook` 每次 O(sessions+1) 次**同步** `realpathSync`，而 `execCell` 每个 cell 都走这里。
详细分析：这是新引入的热路径同步 I/O（此前是纯字符串比较）；子代理实测单次 543 µs（NTFS 本地），5 个 notebook 时每次查找 ≈3.3 ms 且全在事件循环上；网络盘/UNC 下可达数十至数百毫秒。realpath 是 session 的**不变量**，`#startNew` 时算一次存进 `Session.canonicalPath` 即可。
设计文档对齐：SPEC §5.3 的 realpath 语义正确（D-026 已登记偏离），但未登记其性能代价；AGENTS"不烧算力"的意图不支持热路径同步 I/O。

【PERF 其余（阴性）】新代码未新增同步阻塞调用点；`run-store` 有 20 条/10 分钟双重保留；`#runAborts`/`#runKeys`/`#starting` 均有 finally 清理；探测缓存有 TTL 且条目受解释器路径数约束 → **未发现新的无界增长或监听器泄漏**（子代理实测）。

### 维度 5：安全性

**参数严格性核查（阴性，逐工具实测）**：`rejectUnknownArguments` 白名单与 SPEC §4.1/§4.5/§4.7/§4.8/§4.9 的参数表**逐项一一对应**，没有拒掉任何合法参数；`_meta`/`progressToken` 按 MCP 规范走 `RequestHandlerExtra`、不会进 `arguments`，不构成现实误拒。命令注入与路径穿越无新增面（新代码未新增 `spawn`/`exec`，artifact/备份名仍由整数索引 + 哈希拼成）。唯一新增面是 **SEC-TOCTOU**（🟢，已单列）。

### 维度 1：架构与模块对齐

- ✅ **ARCH-1 真修**：nbformat 解析已从 mcp 层移回 `core/outputs.ts`，`src/mcp/render/read.ts` 不再含 nbformat 字段（这同时把 D15 的"转换只在 parse 边界"落实了一半——**写回方向仍缺**，即 FID-1）。
- ✅ `AGENTS.md` §4 目录树已与实物同步（含 `src/run.ts`、`kernel/interpreter.ts`）。
- ✅ 新增偏离登记 D-022~D-031（12 条）覆盖了本轮的结构与语义取舍。
- ⚠️ `core/stale.ts` 本轮大改写：子代理逐行核对为**行为等价**（`latestDefiner` 的记录值必 `< index`，与旧的 `for i < cell_index { if executed }` 取 max 等价；`hasTargetAfter` 与 `lastTarget > index` 等价）→ 无架构问题。

### 维度 2：代码质量与可维护性

【NEW-1】
严重程度：🟡 警告
所在位置：`src/server.ts:39`（`z.object(fields).strict()`）对照 `src/mcp/tools/{read,edit,run,kernel,run-status}.ts` 的 10 处 `rejectUnknownArguments`
问题描述：SEC-1 的修法一次写了两套互斥实现——`.strict()` 让 SDK 在进 handler **之前**就以 `-32602` 拒绝未知键，于是工具层的 `rejectUnknownArguments` 与 5 个白名单常量**全是不可达死代码**。
详细分析：主审 E2E 与子代理 8/8 端到端实测都只看到协议错误，**没有任何一条**返回 `invalid_arguments`。保留两套会造成"读代码以为有 `invalid_arguments` 保护、实际是协议错误"的漂移面；而 `[SEC-1]` 用例的断言 `/invalid|unrecognized|additional/i` 恰好**无法区分是哪一层拒的**，给不了死代码任何信号。D-024 只解释了"选协议错误"的取舍。
修复建议：二选一并删另一套（建议保留工具层、放弃 `.strict()`，让未知键仍是 SPEC §4.1.12 的 `invalid_arguments`；若保留 `.strict()`，请在注释里写明工具层为不可达的冗余防御，并补一条断言"由 schema 层拒绝"的用例把语义钉住）。
设计文档对齐：违反 AGENTS §5/§10 对死代码的要求。

【NEW-2】
严重程度：🟡 警告
所在位置：`src/server.ts:146-147,193` 等六份 `inputSchema`；对照 SPEC §4.1/§4.7/§4.9
问题描述：SPEC 用 `enum` 声明了 `include_source`/`include_outputs`/`mode`/`action` 的取值集合，实现全写成 `z.string().describe(...)` → **广播给模型的 JSON Schema 里 `enum` 出现 0 次**；`timeout_seconds` 广播为 `"type":"number"`（SPEC 写 `integer`）。
详细分析：主审的 schema 发现阶段即为证据。后果不是安全而是**白烧一轮往返**——模型看不到合法值域，写出 `include_outputs:"all"` 之类会被值级校验拒掉，正是 SPEC §4.1.11 立法要避免的浪费（值级校验本身是好的）。
修复建议：`z.enum([...])`、`z.number().int()`、`action` 用 enum（描述保留）。
设计文档对齐：违反 SPEC §4.1/§4.7/§4.9 的 schema 字面，未登记。

【QUAL-format】
严重程度：🟡 警告
所在位置：`scripts/check-format.mjs:1-12,45-55`
问题描述：`daeb3d3` 新增的"format guard"**抓不到它声称要防的那类缺陷**：它只检查"缩进里的制表符"与"行尾空格"，而 QUAL-1 那类**整块缩进浅一级**（无 tab、无行尾空格）它一条都报不出来。
详细分析：脚本头部注释其实**如实说明了**它不校验块嵌套（理由充分：续行/对象字面量会误报）。问题在于提交信息与状态表容易让人以为 QUAL-1 已有护栏。诚实的结论：它是有用的卫生检查，但**不是**缩进守卫；真正的解法是引入格式化器（属新增 devDependency，AGENTS §11 要求先问人类）或写 AST 级嵌套检查。
设计文档对齐：无明文冲突，属"声明与能力不匹配"。

【H-hygiene】
严重程度：🟡 警告
所在位置：仓库根 `probe-framer.mjs`（已被 git 跟踪，18 行）
问题描述：PERF-1 的一次性性能探针被提交进仓库根——与上一轮 `patch-tmp.py` **同类**（临时脚本入库）。它还 `import './lib/kernel/protocol.js'`，而 `lib/` 是 gitignore 的构建产物 → 新克隆直接跑会失败。
修复建议：移到 `scripts/`（与 `check-format.mjs` 同处）并在缺 `lib/` 时给出提示，或删除（用例里已有等价覆盖）。
设计文档对齐：上一轮 H1 的同类问题复现。

### 维度 6：测试覆盖与自测质量

【TST-A】
严重程度：🟠 严重
所在位置：全套测试（尤其 `tests/integration/*`）
问题描述：**"文件保真度"这一类断言完全缺失**——没有任何用例校验写回后的 notebook 是合法 nbformat，也没有 round-trip（写回→再读）断言。FID-1/FID-3 因此可以在 39 个集成用例全绿的情况下长期存在。
详细分析：现有断言只用"两种形状下都成立"的字段（`.text`、`outputs.length`、`execution_count`）；`kernel.test.ts:146-148` 断的是传输层 `rawOutputs`。这是本轮最值得补的一类测试——它比再增加若干用例更能提升可信度。
修复建议（三条，缺一不可）：① `tests/integration` 增加 `nbformat.validate`（或等价的 schema 断言）覆盖"执行后 / 编辑后 / 类型转换后"三种写回；② round-trip 断言：`notebook_run` 后 `notebook_read` 必须能读回刚写入的 outputs；③ CI 的 unit job 里加一条纯 Node 的结构自检（不依赖 Python）。
设计文档对齐：SPEC §10.2 的 I 用例只描述行为，未要求格式校验——**建议补进 SPEC §10.2/§10.4**（这正是三轮 review 都漏掉 FID-1 的结构性原因）。

【TST-B】
严重程度：🟢 建议
所在位置：E2E 初验（`ipynb-mcp-e2e-smoke.md`）
问题描述：单测/集成之外，**缺一条"真客户端 + 真 notebook"的冒烟路径**。本轮 E2E 用 38 行脚本就同时发现了 FID-1/FID-5/FID-6 三条真缺陷——这类检验成本极低、收益极高。
修复建议：把 E2E 冒烟脚本化（`scripts/smoke.mjs`，用 SDK 起 stdio 客户端 + 一个自带的小 notebook + nbformat 校验），作为发布前手工门禁（E1–E9 的自动化部分）。注意：**不要**把它塞进 `pnpm test`（需要真 kernel），放 `docs/E2E-CHECKLIST.md` 的自动化补充里更合适。

**门禁与既有测试的正面结论**：单测 222+1skip、集成 39/39、只读模式 9/9、CAS/原子写/备份/markdown 闸门/图片上限与索引唯一性/88-cell 无 id 编辑/中文路径/大文件（38 MB 读 293 ms）在 E2E 中全部表现正常。

### 文档一致性核实（本轮重点：**4 处"声称已修但代码里不存在"**）

【DOC-FALSE】
严重程度：🟠 严重
所在位置：`docs/REVIEW-FIX-STATUS.md:60`（DEP-2/DEP-3 ✅）、该文件 TST-2/3/4 与 QUAL-1/QUAL-2 行、`CHANGELOG.md` 的 v3 段、提交 `1cf5193` 的信息
问题描述：本轮整改文档与提交信息里出现 4 组**与实际代码不符**的"✅"——与第二轮 V1–V3 属同一类问题（声明可信度受损，比缺陷本身更危险）。
详细分析（全部由主审亲自复核）：
| 声明 | 实际 |
|---|---|
| 「DEP-2 ✅ `server.ts` 版本号对齐 `package.json`」 | `src/server.ts:43` 仍硬编码 `version: '0.1.0'`；全仓 `src/**` 读 `package.json` 的代码 **0 处**（无双真源消除、无守卫），只是两个字面量碰巧相等 |
| 「DEP-3 ✅ `prepack` 改 `tsc -p tsconfig.json`」 | `package.json:26` 仍是 `"prepack": "pnpm build"`；`a6951a8..HEAD` 对 package.json 只有一处改动（`lint` 追加 format guard），**1cf5193 根本没碰 package.json** |
| 「QUAL-1 ✅ 修掉两处缩进错乱」 | `src/run.ts:553-695` **仍整段浅一级**（TS parser 实测；见上表更正行） |
| 「TST-2/TST-3/TST-4 ✅ 已在 v2 轮完成（本报告确认）」 | v3 明确判它们「⚠️部分」；本轮变异实测：`acquireRun` 调用点换 no-op → `[I10]` 仍绿（TST-2 未修）；I18b 仍单 cell、U4 仍只有 `dry_run:true`（TST-3 未修）；编号比例 38.9% ↔ v3 的 39.3%，不升反降（TST-4 未修） |
| 「QUAL-2 ✅ … `isAbortCause` 收敛为一份（run.ts 用它）」 | `src/mcp/tools/edit.ts:26-34` 与 `src/run.ts:788-796` 仍是**两份逐行同构**的实现，`run.ts` 并未 import 前者；`edit.ts:22-24` 的注释还写着"run.ts used to carry a near-identical copy" |
| 「H-7 ✅ 四条取舍已全部登记」 | V2→D-027 ✅、V3→D-028 ✅、R2→D-029 ✅，但 **R3 的「`cellInFlight` 门只覆盖在途 cell 死亡」仍未登记**（`grep cellInFlight docs/DEVIATIONS.md` 零命中）→ 3/4 |
修复建议：① 要么真做（DEP-2 加源码扫描守卫或由构建生成 `src/version.ts`；DEP-3 改 `tsc -p tsconfig.json`），要么把承诺改成"未做、留待下一轮"；② 订正 `REVIEW-FIX-STATUS.md`/`CHANGELOG.md` 的对应行；③ 建议给状态表加一条硬规则：**标记 ✅ 必须附可复现的验证命令或断言位置**（本轮 D-022~D-031 与 D-023 的实验就是正面样板）。
设计文档对齐：违反 AGENTS §8「每一步的完成 = 用例通过 + 门禁全绿，**不许宣称完成**」。

### 维度 6 补充：测试线的独立核实（变异实测）

**真修复（有变异证据，应记功）**：
- **TST-7 ✅**：把 `notebook-file.ts:51` 改回 `throw cause` → `notebook-file.test.ts` **1 failed | 5 passed**（`[TST-7] the READ PATH itself maps a lock errno` 变红）——v3 的"W1 只守 helper 不守接线"缺口封死。
- **TST-1 ✅**：`canStartKernel` 回退前判 `CI==='true' || IPYNB_TEST_REQUIRE_VENV==='1'` 即抛错，workflow 的 integration 步骤确实设了该变量 → "环境坏了静默换解释器"被封死。
- **TST-5 的判别力 ✅**：`startKernel` 注入恒抛 → `analyze-op.test.ts` **1 failed | 3 passed**（不再被吞成 skip）；PATH 收窄到无 Python → **4 skipped / EXIT 0 且不在仓库内建 venv**（AGENTS §9 恢复）。
- **TST-6 ✅**：`[I9]` 已可搜索；`executionCount` 恒真断言换成 restart 后 `print(restart_marker)` → `NameError` 的可证伪探针；I12 在同一 stdio 会话追加 edit/run 后再断言 stdout 纯净。
- **D-023 端到端验证 ✅**（子代理独立实验）：graceful 路径 connection file 落在 `%TEMP%\ipynb-mcp-*.json`、**cwd 为空**、`shutdown_all` + stdin EOF 后残留 0；硬杀路径残留 1 个（与登记一致）。
- **D-022~D-031 条条有实体 ✅**，其中 D-025 还用变异反证（还原 remove-then-shutdown → `[ROB-2]` 变红）——这是本轮文档质量最好的部分。

**仍未修（变异下仍绿）**：
- **TST-2 ❌**：`run.ts:356` 的 `acquireRun` 换 no-op → `kernel-registry.test.ts` **21/21 全绿**（含整个 `[W5]` 组）、`run.test.ts` 的 `[I10]` **仍绿** → **调用点零覆盖**，且 `registry.ts` 里「回收不得打断整个 run」的两处守卫全无覆盖。
- **TST-3 ❌**：`[I18b] clears only the cell about to run` 仍只有 1 个 code cell；`markdown_invalid` 全仓只有 `dry_run:true` 与 core 纯函数两条路径，**真写路径无守卫**。
- **TST-4 ❌**：编号比例 **102/262 = 38.9%**（v3 99/252 = 39.3%），`it` 自身标题带编号的仅 1/262；DEVIATIONS 仍无"测试编号体系"条目。
- **TST-5 残留 ❌**：U20 的 venv 仍建在**仓库内** `tests/.venv-test` 且**永不清理**（AGENTS §9 明令"副作用只能落在临时目录且必须清理"）；`vitest.config.ts` 仍无 `fileParallelism:false` → U20 的 skip 仍与负载相关。

【TST-CI】
严重程度：🟡 警告（**间歇性**；机制成立，但主审今天两次实跑均未复现）
所在位置：`tests/integration/run.test.ts:430-431`（I7 的 kill 用例）
问题描述：`await transport.kill()` 在挂 `expect(inflight).rejects…` **之前**执行，而 `#failAllPending` 在子进程 exit 事件里**同步** reject 该 promise——若此刻还没有 handler，vitest 记为 unhandled rejection 并让**进程退出码非 0**（用例本身全绿）。
详细分析（把两方证据摆开，不偏向任何一方）：
- 子代理报告：单跑 `run.test.ts` **4/4 复现** `Errors 1 error` + `EXIT=1`，且在 `a6951a8` 基线上同样复现（属既有问题），Node 26.7.0 与 22.22.2 都中。
- **主审今天两次实跑均未复现**：单跑 `run.test.ts` → `Test Files 1 passed / Tests 20 passed / VITEST_EXIT=0`；全量 `pnpm test:integration` → `39 passed / VITEST_EXIT=0`。
- **但主审在第二轮（v2）确实亲眼见过它**：当时的全量集成跑出 `Unhandled Errors … IpynbError: sidecar exited (code=1, signal=null)` 且退出码 1（同一机制、同一位置）。
结论：这是一个**真实的间歇性洁净性问题**（机制清楚、历史上出现过），不是"必然 CI 红"。它取决于 kill 与微任务队列的调度，所以在不同负载下表现不同——这也解释了为什么它在两轮 review 之间"时有时无"。
修复建议（两行，建议无条件做，消除 flake）：
```ts
const settled = expect(inflight).rejects.toMatchObject({ code: 'kernel_died' });
await transport.kill();
await settled;
```
设计文档对齐：AGENTS §9 的测试洁净性要求（"用例绿灯但进程不干净"同样会污染 CI 判定）。

**其他测试线小项**：① `[I8]` 的"等 6.5 s 断言 5 s 回收"时序脆弱（整文件跑时实测回收发生在 17 s，偶发挂）；② 两处 `describe(...){  it(...){` 单行事故（`run.test.ts:697` 本轮引入、`render-read.test.ts:192`），`check-format.mjs` 放过；③ `%TEMP%` 每跑一轮集成多 7 个含 HMAC key 的文件（已登记行为，值得写进运维提示）。

### 维度 7 补充

- ❌ **DEP-2**（`server.ts:43` 版本号硬编码、无任何代码读 `package.json`、无守卫）与 **DEP-3**（`package.json:26` 仍 `pnpm build`）**未修**，且被三处文档声称已修 → 见 **DOC-FALSE**。
- ❌ **DEP-4**：`docs/` 内本机绝对路径 **8 处**（`review/ipynb-mcp-code-review.md:3,12`、`-v2.md:3,257,260,327` 原样未动，且**本轮新入库的 `-v3.md:3,501,524` 又加了 3 处**）；`E2E-CHECKLIST.md` 已干净 ✓。建议统一替换为 `<repo>`（归档报告可保留，但需一致）。
- ❌ **H-hygiene 扩大**：`probe-framer.mjs` 仍在且被跟踪（18 行 / 655 B），**未被 `.gitignore` 覆盖**，且**它本身是一条 lint 违规**（`npx oxlint probe-framer.mjs` → `no-console` error）——只因 `pnpm lint` 只扫 `src tests`、`check-format.mjs` 默认只扫 `src tests scripts`，它躺在仓库根没人看得见。它与上一轮 `patch-tmp.py`、本轮 `commit-msg.txt`（已被 `2db2588` 删除）同型：`git add -A` 误收。建议 `git rm` + `.gitignore` 补 `probe-*`/`exp*.mjs`，或挪进 `scripts/` 并说明用途。
- ✅ **DEP-5/DEP-6 真修**（pack 133 与文档一致；CI 的 `version:` 冲突已删并注释）；✅ `.gitignore` 已加 `__pycache__/` + `*.pyc`。
- ⚠️ **COMPATIBILITY**：计数已更新（223 / 39 / 133 ✓），但记的平台是 Node **22.22.2**，而本机默认 `node` 是 **26.7.0**，文档未写清测的是哪个；且"集成 39/39 全绿"未覆盖**退出码**（见 TST-CI）。
- ❌ **README 仍缺一条已知限制**：`interrupt|Ctrl|SIGINT|Windows` 全文零命中——而 `exec_timeout` 正是"interrupt 没落地"的分支，D-027/CHANGELOG 反复提"中断未落地"。应按 **FID-6** 补："Windows 无控制台场景 interrupt 不生效 → 长 cell 会走到 `timeout_seconds` 才结束（`exec_timeout`），期间 kernel 被关闭、内存状态丢失；`notebook_run_cancel` 停不下正在跑的 cell"。


---

## 四、总体评估

### 1. 整体质量评级：**C（需返工）**

**与 v3 的差别**：v3 的问题是"边界与契约收口不严"；本轮**生命周期类问题基本清干净了**（v3 的 P0/P1 在真机 E2E 上逐条成立），但暴露出一个**此前从未被检验过的面：文件保真度**——两条独立的写回路径会让真实 notebook 变成非法 nbformat，而且**没有任何闸门、也没有任何测试**能发现它（工具自身读取时还会静默丢弃，把证据藏起来）。

**不能合并的理由**：核心承诺是"不会静默改坏"，而 E2E 在真实 Jupyter 文件上证明了相反行为（执行一次 cell 即写出 `nbformat.validate` 拒绝的文件，工具却报 `write_back.performed: true`、无 warning）。这一条属于数据完整性红线，必须在发布前闭合；其修法本身很小（一个转换函数 + 一处 `delete` + 一层自检 + 三条用例），不需要架构返工——所以是 C 而不是 D。

**另需同时处理的信任问题**：本轮整改的文档与提交信息里有 **4 组"声称已修但代码里不存在"**（DEP-2/DEP-3/QUAL-1/TST-2-4 + QUAL-2 的"收敛为一份" + H-7 的"四条已登记"），其中 DEP-2/DEP-3 的虚报被抄进了状态表、CHANGELOG 与提交信息三处。这与第二轮 V1–V3 属同一类问题——**缺陷可以下轮修，虚报会让"下轮"失去判断依据**。建议把"标记 ✅ 必须附可复现命令/断言位置"作为硬规则（本轮 D-022~D-031 与 D-023 的独立实验正是正面样板）。

### 2. TOP 3 必须优先修复

| # | 问题 | 为什么优先 | 修复量 |
|---|---|---|---|
| 1 | **FID-1** 执行后写回非法 nbformat（`outputType` + 缺 `execute_result.execution_count`） | 唯一直接改坏用户文件的🔴；两条 run 路径都中；**改名不够**（缺必需字段）；修复需新增 core 侧唯一转换器 + round-trip 用例 | 小-中 |
| 2 | **FID-3** `set_cell_type`→markdown 残留 `execution_count` | 第二条独立污染路径，**一行修复**（`delete` 而非 `= null`），SPEC §4.5 规则 4 明文要求 | 极小 |
| 3 | **FID-4 + FID-2** 无 nbformat 闸门 + 读回静默丢弃 | 前者是"为什么能长期存在"的结构性原因（加最小结构自检即让两条立即变红）；后者让工具**读不到自己刚写的输出**并把证据藏起来 | 小 |

紧随其后：**DOC-FALSE**（4 组"声称已修但代码里不存在"，含 DEP-2/DEP-3/QUAL-1/TST-2-4/QUAL-2/H-7——与第二轮 V1–V3 同类，修复方式是"真做或改成未做"，属几行 + 改文档）、**ROB-10 补充**（退出码符号化 0% 有效 + 结构化错误无 detail，用户仍拿不到可自助的失败原因）、**ROB-11/FID-6 合并修**（让 sidecar 决定 timeout 后立即返回：一处修改同时消掉 32.6 s 延迟与 +45 s 不变式的缺口）、**FID-5**（run-status 的 `backupPath`，一行）、**QUAL-1**（`run.ts:553-695` 缩进 + 把 brace 检查加进守卫）、**NEW-1/NEW-2**（死代码与 schema 缺 enum）、**NEW-4**（热路径 realpathSync）、**NEW-3**（分帧残留：主审的 chunk 尺寸对照实验证明它随 push 次数平方增长，不是"必要的拼接成本"）、**DEP-1 降级路径**（`except` 只 warn 就放过）、**QUAL-6 残留 + `cell_selector` 放大**、**H-hygiene**（`probe-framer.mjs`）、**TST-CI**（测试进程洁净性，两行修复）。

### 3. 与原始设计文档的偏离清单

| 偏离 | 性质 | 处置 |
|---|---|---|
| 写回 outputs 用 sidecar 协议形状且缺 `execute_result.execution_count` | **行为偏离（违反 §4.1.1/D15 + R2/R9）** | FID-1 |
| `set_cell_type`→markdown 置 `null` 而非删除 | **行为偏离（违反 §4.5 规则 4）** | FID-3 |
| 无 nbformat 级自检（§5.5.5 只要求重解析） | 红线意图未落实 | FID-4，建议登记 DEVIATIONS |
| `notebook_run_status` 返回 `backupPath` | **契约偏离（违反 §4.8 字段名）** | FID-5 |
| 超时后仍空等 30 s shell 回复 | **行为偏离（违反 §4.7 规则 5"至多 5 秒"）** | FID-6 |
| Windows 上 interrupt 不生效（平台限制） | 平台事实 + 未文档化 | FID-6，写进 README 已知限制 + 登记 |
| 广播 schema 缺 `enum`、`timeout_seconds` 非 integer | **契约偏离（违反 §4.1/§4.7/§4.9 字面）** | NEW-2 |
| 工具层 `rejectUnknownArguments` 不可达 | 死代码（违反 AGENTS §5/§10） | NEW-1 |
| 可预测连接文件名引入 TOCTOU | 新引入的窄面安全问题 | SEC-TOCTOU，建议登记 |
| `progress.completed` 语义未定义、终态可被二次翻转 | SPEC 缺口 + 违反 §4.8 顺序语义 | NEW-5，建议补 SPEC |

### 4. 后续开发建议

- **必须补的测试**：① 写回后 `nbformat.validate`（执行/编辑/类型转换三条路径）；② run→read round-trip（断言能读回刚写入的 outputs）；③ `set_cell_type` 往返（code→markdown→code 后文件仍合法）；④ 分帧量化断言（8/32/64 MiB × 16/64 KiB chunk）；⑤ 未知参数**由哪一层拒绝**的语义断言。
- **必须补的文档**：README 已知限制加"Windows 无控制台场景 interrupt 不生效，超时/取消依赖自然结束或关闭 kernel"；`docs/DEVIATIONS.md` 登记"写回转换缺失的修复方式""结构自检""可预测连接文件名"；`REVIEW-FIX-STATUS.md` 的 v3 段落里"PERF-1 ✅"应改为"部分（扫描仍 O(L²)）"；`AGENTS.md` §4 已同步 ✓ 保持。
- **工程加固**：把 `#norm` 的 realpath 结果缓存进 `Session`（消除每 cell 同步系统调用）；`NdjsonFramer` 记住扫描游标；删掉 `.strict()`/工具层二者之一；引入格式化器（需先问人类）或把 QUAL-1 类事故加入 AST 级检查。
- **流程建议**：本轮 E2E 用 38 行脚本 + 一次 `nbformat.validate` 就发现了三轮 review 都漏掉的 🔴，说明**"真客户端冒烟 + 外部权威校验器"应当成为每轮验收的固定动作**（建议脚本化进 `docs/E2E-CHECKLIST.md`）。
- **发布前仍缺**：E1–E9 手工端到端（证据列仍空）；CI 从未真跑（`git remote` 为空，DEP-6 修好后才有意义）。

---

## 附录：本报告的验证分工与局限

- **主审亲验（一手证据）**：四道门禁实跑；**真机 E2E**（真 stdio + 真 SDK 客户端 + 5 个真实 notebook + 6 个 fixture，38 条断言）；FID-1（nbformat 实测 + 归属 `git log -S`）、FID-3（独立复现）、FID-6（超时实测 + 两种 interrupt 模式对照实验）、NEW-1（`server.ts:39` 与 10 处调用点）、NEW-2（自己的 schema 发现输出）、NEW-3（两种 chunk 尺寸对照测量）、NEW-4（读码）；v3 各项修复的 E2E 复核。
- **子代理验证（三条流已全部收尾并完整并入）**：① **v3 内核修复核实**——真 kernel / OS 进程 / `mklink /J` junction 级实测，逐条给出 ✅/⚠️/❌（ROB-2 用 `Win32_Process` 确认 pid 消失；ROB-6 junction 两拼写同一 kernel；ROB-14 探测次数 1；ROB-1 监听器 3/3 摘除；PERF-1 2256 ms；并发现 ROB-11 不变式缺口、ROB-10 符号化失效、DEP-1 降级路径）；② **测试与文档核实**——全在 `%TEMP%` worktree 里做变异实测（TST-7 变红、TST-2 仍绿、U20 两种结局），并核实 D-022~D-031 条条有实体、**D-023 端到端验证**；③ **新代码独立找茬**——FID-1 的 `execution_count` 补充、FID-2/FID-4 的代码定位、NEW-5/NEW-6/SEC-TOCTOU，以及大量已实测的**阴性结论**（唯一 sidecar 形状写入点是 `run.ts:518`；`clear_outputs`/`insert_cell`/`move_cell`/`delete_cell` 后文件合法；`.bak` 不引入新形状；参数白名单无遗漏；`stale.ts` 改写行为等价）。
- **局限**：① 未做 macOS/Linux 实跑（FID-6 的"interrupt 不可用"是 Windows 结论，其他平台需另验）；② `NEW-5` 属代码路径论证 + 窗口量化，**未端到端复现**（子代理已如实标注）；③ E1–E9 真实第三方客户端（Claude Code/Cursor）仍未验；④ **TST-CI 的 unhandled rejection 主审今天单跑/全量各一次均未复现（均 exit 0），但主审在第二轮亲眼见过同一现象**——已按"间歇性"记录，未夸大为"必然 CI 红"；⑤ 三条复核流中「v3 内核修复完整实验」一路截至定稿仍在收尾，其独立结论若与本文冲突将以补充形式给出（另两路已完整并入）；⑥ 我上一轮把 QUAL-1 判为"已修"是**抽样范围过窄**导致的方法错误（只看了 v3 的旧行号），本轮改用 TypeScript parser 全量扫描后更正——这条教训（"格式类问题必须用解析器扫，不能抽样"）也适用于后续轮次。
