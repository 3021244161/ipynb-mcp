# ipynb-mcp 代码审查与诊断报告

**审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp`（v0.1.0，31 个源文件 + 1 个 Python sidecar + 19 个测试文件）
**权威规格**：仓库根 `SPEC.md`（v3.0）+ `AGENTS.md`
**审查方式**：全文静态阅读（我自己读了 core/*、fs/*、kernel/*、mcp/*、run.ts、python sidecar 全部核心路径）+ 三路并行专家审查（测试质量 / 健壮性与安全 / 依赖配置与结构）

> ## ⚠️ 审查限制（影响结论确定性）
> 本会话 `pwsh` 工具完全不可用（每次调用返回 `[exit code: 3221225794]` = 0xC0000142 DLL 初始化失败），因此**未能实际执行** `pnpm typecheck / lint / test / build`，也未能运行 `git` 命令。
> 报告中"实现者自述 148/148 unit + 26/26 integration 通过"来自 `docs/COMPATIBILITY.md:18`，**我无法验证**。所有结论均基于源码与配置的直接阅读，行号可核对。
> 唯一需要可执行命令复验的项：`git ls-files tests/.venv-test`（该 Python venv 是否曾进入版本控制）。
>
> **交叉核对说明**：三路专家审查中的一条结论（"仓库无 `docs/` 目录，`DEVIATIONS.md` 缺失"）经我直接读取文件确认**为误报**——`docs/DEVIATIONS.md`、`docs/OPEN_QUESTIONS.md`、`docs/COMPATIBILITY.md`、`docs/E2E-CHECKLIST.md` 均存在（审查者疑似看错了上层目录 `E:\Work\ipynb-mcp\` 而非项目根 `E:\Work\ipynb-mcp\ipynb-mcp\`）。该条已剔除；报告中所有关于 `docs/` 的结论以我的直接读取为准。其余专家结论均逐条核对过行号。

---

# 一、逐条问题

## A 类：正确性与数据安全

### 【A1】`clear_outputs_before` 预清空全部目标 cell，超时/取消时销毁未执行 cell 的既有输出

**严重程度**：🔴 阻塞
**所在位置**：`src/run.ts:303-310`（预清空）、`src/run.ts:410-430`（超时/取消分支）、`src/run.ts:553-571`（`writeBackCompleted`）

**问题描述**：`notebook_run` 在执行循环**之前**把所有目标 cell 的 `outputs`/`execution_count` 清空，而这些清空结果会随"已完成 cell 的写回"一起落盘，导致**从未执行过的 cell 丢失原有输出**。

**详细分析**：

```ts
// src/run.ts:303-310
if (req.clearOutputsBefore) {
  for (const index of targets) {        // ← targets 是全部目标，不是"即将执行的那一个"
    const cell = notebook.cells[index]!;
    cell.outputs = [];
    cell.execution_count = null;
  }
}
```

触发链路（默认配置即可复现，`clear_outputs_before` 默认 `true`）：

1. `cell_selector='0-5'`，其中 cell 3 是耗时 cell；
2. 预清空把 cell 0..5 的 outputs 全部置空；
3. cell 3 超时（或客户端取消 / kernel 被 restart）→ `run.ts:413` 调用 `writeBackCompleted(...)`；
4. `writeBackCompleted` 把**整个内存模型**写回磁盘 → **cell 4、5 的既有输出被永久清空**，而它们从未执行。

这直接违反两条 SPEC 规则：
- §4.7 规则 3：「**未执行 cell 的 `execution_count` 与 `outputs` 一律不变**」；
- §4.8 规则 2：「在途 cell 的部分输出永不写回：该 cell 的 `outputs` 与 `execution_count` **保持执行前的值**」。

讽刺的是，这两个 bug 恰好打击本产品的头号卖点——"长任务超时/中断"正是最容易触发它的场景，而用户最不能接受的正是"我跑了半天的 notebook 输出没了"。备份（`create_backup` 默认 true）提供了恢复途径，但这属于事后补救。

**修复建议**：把清空动作移入执行循环，且只在**该 cell 即将执行前**清空；同时把已清空但未执行的 cell 在写回前还原。

```ts
// 删除 src/run.ts:303-310 的预清空整块，改为在执行循环内：
for (const index of targets) {
  if (isAborted(req.abort)) break;
  const cell = notebook.cells[index]!;
  const savedOutputs = cell.outputs;            // 快照
  const savedCount = cell.execution_count;
  if (req.clearOutputsBefore) {
    cell.outputs = [];
    cell.execution_count = null;
  }
  try {
    result = await deps.registry.execCell(...);
  } catch (cause) {
    cell.outputs = savedOutputs;                 // 中断 → 还原
    cell.execution_count = savedCount;
    if (isAborted(req.abort)) break;
    throw cause;
  }
  if (result.result.status === 'timeout') {
    cell.outputs = savedOutputs;                 // 超时 → 还原
    cell.execution_count = savedCount;
    sawTimeout = true;
    break;
  }
  ...
}
```

**设计文档对齐**：违反 SPEC §4.7 规则 3、§4.8 规则 2。实现者显然知道这两条规则（`run.ts:388-404` 的注释逐条引用），但只在"执行完成后是否赋值"上遵守，漏掉了"提前清空"这一半。

---

### 【A2】sidecar 与 kernel 以"只有 2 个变量"的环境启动，用户代码看到的不是用户环境

**严重程度**：🔴 阻塞
**所在位置**：`src/kernel/registry.ts:184-200`（未传 `env`）、`src/kernel/sidecar-transport.ts:66`（`env: { ...options.env, ... }`）

**问题描述**：SPEC §5.8 明文规定子进程环境为 `{ ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }`，但调用链上**没有任何一处传入 `env`**，于是 sidecar（及其派生的 kernel）只拿到 `PYTHONUNBUFFERED` 与 `PYTHONIOENCODING` 两个变量——**没有 PATH、没有 HOME、没有 SystemRoot、没有 conda 变量**。

**详细分析**：

```ts
// registry.ts:184-200 —— 没有 env 字段
const transport = this.#transportFactory({
  interpreterPath, onLog, spawnImpl: ..., sidecarPath: ..., platform: ...,
});
// sidecar-transport.ts:66 —— options.env === undefined 时 `{...undefined}` = {}
env: { ...options.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
```

`bin.ts` 构造 `KernelRegistry` 时也只传 `{ idleSeconds, logger }`（`bin.ts:62`）。Node 的 `spawn` 语义是：**一旦提供 `env`，就整体替换而不再继承 `process.env`**。

后果（用户可见，且在简单用例下不可见）：
- notebook 里 `!pip install ...`、`!git ...` 等 shell magic 失败（PATH 缺失）；
- `subprocess.run([...])` / `os.system` 失败；
- `os.environ['HOME']` / `['USERPROFILE']` / `['CUDA_VISIBLE_DEVICES']` 等读取抛 `KeyError` 或返回 `None`；
- conda 环境变量（`CONDA_PREFIX` 等）缺失，部分库的运行时探测失效；
- Windows 上缺 `SystemRoot` 会让部分 DLL/网络 API（Winsock）行为异常。

**为什么自测发现不了**：现有集成测试的 cell 只做 `x = 1` / `print(...)` / `time.sleep` 这类不依赖环境的操作。这是一个"单机自测必然绿灯、真实用户必然踩到"的缺陷。

**修复建议**：

```ts
// registry.ts：把 env 一路透传
const transport = this.#transportFactory({
  interpreterPath, onLog, spawnImpl: this.#spawnOptionsExtras.spawnImpl,
  sidecarPath: this.#spawnOptionsExtras.sidecarPath,
  platform: this.#platform,
  env: process.env,                    // ← 新增（SPEC §5.8 明文要求）
});
```
并补一条集成用例：cell 内容 `import os; print(os.environ.get('PATH') is not None)`，断言输出 `True`。

**设计文档对齐**：违反 SPEC §5.8「启动：`spawn(interpreterPath, ['-u', sidecarPath], { ..., env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } })`」——SPEC 写对了，实现漏传。

---

### 【A3】空闲回收会杀死正在执行 cell 的 kernel

**严重程度**：🔴 阻塞
**所在位置**：`src/kernel/registry.ts:357-366`（`#reclaimIdle` 不检查 `busy`）、`src/kernel/registry.ts:130,219`（`lastUsedAt` 只在 exec **结束后**更新）

**问题描述**：回收定时器不检查 `session.busy`，而 `lastUsedAt` 在 cell 执行期间不会刷新，因此当一次执行跨越"上次活动时间 + idle 阈值"时，定时器会在 cell **执行途中**关闭 kernel。

**详细分析**：

```ts
// registry.ts:357-366
async #reclaimIdle(): Promise<void> {
  const now = this.#now().getTime();
  for (const session of Array.from(this.#sessions.values())) {
    const idleMs = now - session.lastUsedAt.getTime();
    if (idleMs >= this.#idleSeconds * 1000) {     // ← 没有 && !session.busy
      await this.shutdown(session.notebookPath);
    }
  }
}
```

定时器间隔为 `max(5, min(60, idle/2))` 秒（`registry.ts:84`）——默认 `idle=3600` 时为 60 秒一次。`lastUsedAt` 仅在 `getOrCreate`（:130）与 `execCell` **返回后**（:219）更新。于是：

- 上次执行在 T 结束 → 若下一次执行在 T+3590s 开始、且该 cell 运行 ≥10 秒 → 定时器在 T+3600s 触发，`idleMs = 3600 ≥ 3600` → **在 cell 执行途中 `shutdown`**；
- 该 cell 随即以 `kernel_died` 失败，kernel 状态全部丢失。

触发窗口是每个 60 秒周期；任何运行 ≥60 秒的 cell 都有机会撞上。默认配置下这是常态而非边缘情况，且恰好打击"长任务"这一核心场景。

**修复建议**：

```ts
// registry.ts:359-364
for (const session of Array.from(this.#sessions.values())) {
  if (session.busy) continue;                    // ← 在途执行绝不回收
  const idleMs = now - session.lastUsedAt.getTime();
  ...
}
```
并在 `execCell` 开头也刷新 `session.lastUsedAt = this.#now()`（进入即算活跃），使判定窗口更宽。

补一条集成用例：`idle=2s`，执行一个 10 秒的 cell，断言执行成功且 kernel 未被回收。

**设计文档对齐**：SPEC §5.3「空闲超时 | 定时器真实关闭」的语义是"**空闲**时回收"；实现在"忙"时也回收，属语义违背。SPEC 未显式写出 `busy` 检查，是实现漏洞（也是 SPEC 可补强处）。

---

### 【A4】`mode='replay'` 复用存活 kernel，而非"新建 kernel"

**严重程度**：🟠 严重
**所在位置**：`src/run.ts:280-285`（无条件 `getOrCreate`）、`src/kernel/registry.ts:121-168`（`getOrCreate` 无"强制新建"语义）

**问题描述**：SPEC §4.7 的 `cell_selector × mode` 矩阵规定 `replay` = 「**新建 kernel**，静默执行 `0..f-1` 后执行 S」，但实现对所有模式都调用 `getOrCreate`，一旦存在同复用键的存活 kernel 就直接复用，于是 replay 变成"在脏 kernel 上重放前缀"。

**详细分析**：replay 的全部意义是"重建一个干净的状态再执行目标 cell"。复用存活 kernel 意味着此前所有变量仍然存在——例如用户之前跑过 `df = pd.read_csv(...)`，replay 后 `df` 仍在，目标 cell 即使不依赖前缀也能跑通；反过来，若前缀本次执行失败，脏状态会掩盖问题。结果与真正的 replay 不同，而返回值仍报告 `mode_used: 'replay'`，**模型据此得出的"状态已重建"结论是错的**。

**修复建议**：给 `getOrCreate` 增加 `fresh?: boolean`，为 `true` 时先 `shutdown` 再新建；`run.ts` 在 `modeUsed === 'replay'` 时传 `fresh: true`：

```ts
// run.ts，mode 矩阵判定之后
const session = await deps.registry.getOrCreate({
  notebookPath: req.path, interpreterPath: resolution.interpreterPath,
  kernelSpecName: resolution.kernelSpecName, language: resolution.language,
  fresh: modeUsed === 'replay',           // ← 新增
});
```
补集成用例：先跑一次留下变量，再用 `mode='replay'` 跑一个引用该变量的 cell，断言 `NameError`（证明状态确实被重建）。

**设计文档对齐**：违反 SPEC §4.7 矩阵两行（`cells='all'` 的 replay 列与"具体集合 S"的 replay 列均写「新建 kernel」）。

---

### 【A5】`image_index` 按 cell 重置，跨 cell 的图片块索引冲突

**严重程度**：🟠 严重
**所在位置**：`src/mcp/render/read.ts:109-141`、`src/run.ts:348-377`、`src/fs/artifact.ts:70-118`

**问题描述**：SPEC §4.3 规定 `image_index` 是"**该块在本次结果图片块数组中的 0-based 序号**"（即全调用唯一），但 `applyImagePolicy` 每次调用都把内部计数器从 0 开始，而 read 与 run 都是**按 cell 循环调用**它，于是每个 cell 的图片都从 0 编号。

**详细分析**：

```ts
// artifact.ts:70
let imageIndex = 0;                       // ← 每次 applyImagePolicy 调用都归零
for (const image of extractedImages) { ... item.image_index = imageIndex; imageIndex += 1; }

// render/read.ts:109（在 for (const index of selectedIndexes) 循环体内）
const policyResult = await applyImagePolicy(mapped.items, mapped.extractedImages, ...);
// run.ts:348（在 for (const index of targets) 循环体内）
const policyResult = await applyImagePolicy(mapped.items, mapped.extractedImages, ...);
```

而 `imageBlocks` 数组是跨 cell 累积的（`run.ts:375`、`render/read.ts:138`）。于是两个 cell 各出一张图时，两个 item 都标 `image_index: 0`，模型无法判断哪张对应哪个块；文档却明确告诉模型可以用它做对应。`image_index` 是 §4.3 里唯一用于"文本项 ↔ 图片块"关联的字段，索引错了等于该字段失效。

**修复建议**：把起始偏移作为参数传入，或由调用方在返回后重新编号：

```ts
// artifact.ts
export interface ImagePolicyDecision { readonly returnImages: boolean; readonly maxImages: number; readonly indexStart?: number }
// 内部：let imageIndex = decision.indexStart ?? 0;

// render/read.ts / run.ts 调用处
let imageCursor = 0;
...
const policyResult = await applyImagePolicy(mapped.items, mapped.extractedImages,
  { returnImages, maxImages: budgeted, indexStart: imageCursor }, {...});
imageCursor += policyResult.materialized.length;
```

补单测：两个 cell 各出一张图，断言两个 `image_index` 分别为 0 和 1，且与返回的图片块顺序一致。

**设计文档对齐**：违反 SPEC §4.3 的 `image_index` 定义（第 12 条 bullet 与 §4.4 的"顺序与出现顺序一致"）。现有单测 `tests/unit/outputs.test.ts:265` 只断言单 cell 场景的 `toBe(0)`，无法发现。

---

### 【A6】I10 的并发语义未实现：`kernel_busy` 只覆盖单次 exec，同一 kernel 上两个 run 可以交错

**严重程度**：🟠 严重
**所在位置**：`src/kernel/registry.ts:206-231`（`busy` 的作用域）

**问题描述**：SPEC §10.2 的 I10 要求「同一 kernel 并发两次 `notebook_run` → 第二次抛 `kernel_busy`」，但 `busy` 只在单次 `transport.execCell` 期间置位，两次 run 的**多个 cell 之间**可以自由交错。

**详细分析**：`session.busy = true` 在 `execCell` 进入时置位、`finally` 中清除（`:216,229`）。设想 run A 正在跑 cell 0..9、run B 同时到达：只要 B 的第一次 `execCell` 落在 A 的两 cell 之间（这在耗时 cell 之间是常见窗口），B 就会通过 `busy` 检查并开始执行，此后 A、B 在同一条 ZMQ 通道上交替发送 `execute_request`，`execution_count` 与输出归属混乱（sidecar 靠 `parent_header.msg_id` 归属，不会串消息，但**用户可见的执行顺序与计数完全不可预测**）。

现有 I10 用例（`tests/integration/kernel.test.ts:169-187`）直接调用 `registry.execCell` 两次来制造冲突，因此**只能测到"两次 exec 同时"这一狭窄情形**，测不到"两个 run 交错"这一真实场景。

**修复建议**：把串行化提升到"每次 run"的粒度——在 `KernelRegistry` 上加一个 per-notebook 的 run 锁（或在 `run-store` 层对同一 notebook 的 run 排队/拒绝）：

```ts
// registry.ts：新增 per-session run 级标记
acquireRun(notebookPath: string): () => void {
  const session = this.#requireSession(notebookPath, 'kernel_not_available');
  if (session.runActive) throw new IpynbError('kernel_busy', `a run is already in flight on ${session.kernelId}`, { kernel_id: session.kernelId });
  session.runActive = true;
  return () => { session.runActive = false; };
}
// run.ts 全程持有该锁（try/finally 释放）
```
并把 I10 改写为"并发两个 `notebook_run`"（经工具层），而不是直接调 `execCell`。

**设计文档对齐**：符合 SPEC §5.3 的字面表述（"同一 kernel 上存在在途 `exec_cell` 时"），但**不满足 SPEC §10.2 I10 的验收语义**——属于 SPEC 措辞与验收用例之间的不一致，两者需统一（建议以 I10 为准）。

---

### 【A7】`getOrCreate` 未合并并发启动（注释与实现不符），冷启动并发会产生孤儿 kernel

**严重程度**：🟠 严重
**所在位置**：`src/kernel/registry.ts:117-135`（注释声称共享 promise，实际无 in-flight map）

**问题描述**：函数注释写「Concurrent starts for the same key share the promise」，但实现中没有任何 in-flight 记录——两个并发调用会各自 `startKernel`，第二个 `this.#sessions.set(key, session)` 覆盖第一个，**第一个 kernel 变成无人持有的孤儿进程**，违反 SPEC §5.3「同一键只允许一个 kernel 存活」与 R19。

**详细分析**：

```ts
// registry.ts:117-135
/**
 * Return a live kernel for the notebook, starting one when the reuse key
 * has no live session. Concurrent starts for the same key share the promise.  ← 不成立
 */
async getOrCreate(input): Promise<KernelSessionInfo> {
  const key = this.#reuseKey(...);
  const existing = this.#sessions.get(key);
  if (existing !== undefined && existing.transport.alive) { ... }
  ...
  const result = await transport.startKernel(...);   // ← await 期间第二个调用也会走到这里
  this.#sessions.set(key, session);                  // ← 覆盖第一个
```

触发条件：冷 notebook 上两个并发工具调用（MCP 客户端可并发发请求，且 `notebook_run` 与 `notebook_kernel start` 是两个独立入口）。

**修复建议**：加 in-flight promise map，兑现注释里的承诺：

```ts
readonly #starting = new Map<string, Promise<KernelSessionInfo>>();
async getOrCreate(input): Promise<KernelSessionInfo> {
  const key = this.#reuseKey(...);
  const live = this.#sessions.get(key);
  if (live?.transport.alive) { live.lastUsedAt = this.#now(); return this.#toInfo(live); }
  const inflight = this.#starting.get(key);
  if (inflight !== undefined) return inflight;
  const promise = this.#startNew(key, input).finally(() => this.#starting.delete(key));
  this.#starting.set(key, promise);
  return promise;
}
```

**设计文档对齐**：违反 SPEC §5.3「同一键**只允许一个** kernel 存活」；注释本身也与实现不符（AGENTS.md §5 要求注释只写"为什么"，此处写了一个不成立的断言）。

---

### 【A8】`index_shifted` 警告漏报：只扫描"最后一次结构性 op 之后"

**严重程度**：🟡 警告
**所在位置**：`src/core/edit.ts:142,226,234,310-321`

**问题描述**：`lastStructureChangeOpIndex` 会被后续的结构性 op **覆盖**，导致"结构性 op → 用 index 的 op → 又一个结构性 op"这种序列完全不产生警告。

**详细分析**：SPEC §4.1.9 要求「若同一请求中**既存在**会改变 cell 数量的 op，**又存在**使用 `cell_index` 的后续 op，则必须追加 `index_shifted`」。实现：

```ts
lastStructureChangeOpIndex = opIndex;      // :226 / :234，被覆盖
...
for (let i = lastStructureChangeOpIndex + 1; i < ops.length; i += 1) { if (raw['cell_index'] !== undefined) { warn; break; } }
```
序列 `[insert_cell, replace_lines(cell_index=3), insert_cell]` 中，第二个 `insert_cell` 把 `lastStructureChangeOpIndex` 推到末尾 → 扫描区间为空 → **不报警**，而 op1 的 `cell_index` 恰恰受 op0 影响。这正是该警告要防的场景。

**修复建议**：记录**第一个**结构性 op 的下标（或任何结构性 op 之前的最小值），并扫描其后的所有 op：

```ts
if (lastStructureChangeOpIndex === -1) lastStructureChangeOpIndex = opIndex;  // 只记第一个
```

**设计文档对齐**：违反 SPEC §4.1.9。

---

### 【A9】`clear_outputs` 可作用于 markdown cell，给 markdown cell 写入 `outputs`

**严重程度**：🟡 警告
**所在位置**：`src/core/edit.ts:276-287`（无 cell_type 检查）、SPEC §5.5.6

**问题描述**：`clear_outputs` 只要求定位到 cell，不校验类型，对 markdown cell 执行会写入 `cell.outputs = []`，产生违反 nbformat 的 markdown cell。

**详细分析**：SPEC §5.5.6 明确「markdown/raw cell **无** `outputs` / `execution_count`」。而 `clear_outputs` 的实现是 `cell.outputs = []`（`:284`）。用户若让模型"清空第 3 个 cell 的输出"而第 3 个是 markdown，就会污染文件（JupyterLab 打开可能告警）。

**修复建议**：在 `clear_outputs` 分支加类型校验，非 code cell 抛 `invalid_targets`（与 run 的选择器语义一致）或静默 no-op 并追加 warning。建议前者更明确：

```ts
case 'clear_outputs': {
  const cell = locate(notebook, raw, opIndex);
  if (cell.cell_type !== 'code') {
    throw new IpynbError('invalid_targets', `clear_outputs requires a code cell (cell ${notebook.cells.indexOf(cell)} is ${cell.cell_type})`, { failed_op_index: opIndex });
  }
  ...
}
```

**设计文档对齐**：违反 SPEC §5.5.6；SPEC §4.5 的 `clear_outputs` 行未写明 cell 类型约束（SPEC 可补强）。

---

### 【A10】`parseCellSelector` 对 `1-2-3` 静默截断

**严重程度**：🟡 警告
**所在位置**：`src/run.ts:117-133`

**问题描述**：`piece.split('-')` 后用 `const [rawStart, rawEnd] = ...` 解构，第三段被静默丢弃，`'1-2-3'` 被解析为 `1-2`。

**详细分析**：`/^[0-9,-]+$/` 允许任意多个 `-`。`'1-2-3'.split('-')` → `['1','2','3']` → 解构取前两个 → 区间 1..2。用户/模型写错选择器时不会得到 `invalid_targets`，而是**执行了错误的 cell 集合**——对"执行代码"这一副作用而言，静默接受错误输入比报错更危险。

**修复建议**：

```ts
const parts = piece.split('-');
if (parts.length !== 2) throw new IpynbError('invalid_targets', `invalid range in cell_selector: ${piece}`, { cell_selector: selector });
const [rawStart, rawEnd] = parts;
```

**设计文档对齐**：SPEC §4.7 的解析规则要求非法选择器 `invalid_targets`；本实现把非法输入当合法处理，属实现缺陷。

---

### 【A11】越界选择器报 `invalid_targets` 而非 `range_out_of_bounds`

**严重程度**：🟡 警告
**所在位置**：`src/run.ts:208-217`

**问题描述**：`'99'`（超出 cell 数）走的是 `run.ts:211-215` 的 `cell === undefined || cell_type !== 'code'` 分支 → `invalid_targets`，而 SPEC 把"索引越界"归给 `range_out_of_bounds`。

**详细分析**：SPEC §4.7：「解析失败**或索引越界** → `invalid_targets` / `range_out_of_bounds`」——SPEC 本身把两个码并列而没写明分界。实现的选择是"选择器语法错 → invalid_targets；目标不存在/非 code → invalid_targets"，于是 `range_out_of_bounds` 在本路径上实际不可达（仅 `selected.length === 0` 的一个分支用它，而该分支在具体选择器下不可达）。

**修复建议**：把"索引超出 code cell 总数"与"指向非 code cell"分开：

```ts
for (const index of selected) {
  const cell = notebook.cells[index];
  if (cell === undefined) throw new IpynbError('range_out_of_bounds', `cell_selector index ${index} is beyond the last cell (${notebook.cells.length - 1})`, { cell_selector: req.cellSelector, cell_index: index });
  if (cell.cell_type !== 'code') throw new IpynbError('invalid_targets', `cell_selector points at a ${cell.cell_type} cell: ${index}`, { cell_selector: req.cellSelector, cell_index: index });
}
```

**设计文档对齐**：SPEC §4.7 措辞歧义（两个码并列），实现与 §7 错误码表的分工不一致。建议 SPEC 明确分界，实现按上表对齐。

---

### 【A12】kernel 中途死亡要等到超时才被发现（最长挂满 `timeout_seconds`）

**严重程度**：🟡 警告
**所在位置**：`python/ipynb_sidecar.py:179-207`

**问题描述**：执行循环只在**到达 deadline 之后**才检查 `entry.km.is_alive()`；如果 kernel 在 cell 执行途中死亡，客户端会一直等 iopub 消息，直到 `timeoutMs` 到期才报错。

**详细分析**：`get_iopub_msg` 对已死 kernel 不会抛错，只会 `Empty`（超时）。`is_alive()` 的检查位于 `if interrupt_deadline is None and now >= deadline:` 分支内（`:189-192`），即仅在超时时刻。因此用户 OOM 掉 kernel 后，等待时间 = `timeout_seconds`（默认 300 秒），最终拿到的是"interrupt 未生效"的语义（`exec_timeout`），而真实原因是 kernel 已死。SPEC §5.8 期望的是 `kernel_died`。

**修复建议**：在 `Empty` 分支按固定间隔（如每 1 秒）轮询 `km.is_alive()`：

```python
if isinstance(exc, Empty) if False else False:
    ...
except Empty:
    now = time.monotonic()
    if not entry.km.is_alive():
        send_kernel_died(kernel_id)
        raise KernelDiedError("kernel died during execution")
    if interrupt_deadline is None and now >= deadline: ...
```
（把 `is_alive()` 检查提到 `Empty` 分支最前面，代价是一次廉价的进程状态查询。）

**设计文档对齐**：SPEC §5.8「`timeoutMs` 到期：Node 先发 `interrupt`，等待 5 秒；仍未 idle → 返回 `status:'timeout'`」——实现符合该条，但 §7 错误码表期望 kernel 异常退出映射 `kernel_died`，实现无法在合理时间内识别。

---

### 【A13】`rename` 成功后 `fsyncDir` 失败 → 报告"写入失败"，但文件其实已改

**严重程度**：🟡 警告
**所在位置**：`src/fs/atomic.ts:83-86`、`src/mcp/tools/edit.ts:81-86`

**问题描述**：目录 fsync 在 rename 之后执行且不在 try/catch 内，失败会把整次原子写标记为失败；调用方（工具层）随后把该错误映射为 `internal`，而磁盘上已是新内容。

**详细分析**：调用方拿到的是"编辑失败"，实际文件已更新且 `content_hash` 已变。若模型据此重试同一次编辑，锚校验会命中 `cas_mismatch`（因为它手上的 hash 是旧的），产生难以解释的连环错误。POSIX 上目录 fsync 极少失败，但一旦发生（NFS、只读挂载点、容器特殊文件系统）就会产生这种"假失败"。

**修复建议**：把目录 fsync 降级为可观测的警告而非致命错误（数据已经 `fsync` 且 rename 完成，目录项丢失只影响崩溃恢复）：

```ts
if (platform !== 'win32') {
  try { await deps.fsyncDir(dir); }
  catch (cause) { options.onCleanupError?.(`[ipynb-mcp] warn directory fsync failed for ${dir}: ${String(cause)}`); }
}
```

**设计文档对齐**：SPEC §9 要求 POSIX 上「rename 后 fsync 目录」；未规定失败语义。实现选择了"失败即整体失败"，与"文件已落盘"的事实冲突，建议按上面降级。

---

### 【A14】artifact 路径未绝对化，可能返回相对路径

**严重程度**：🟡 警告
**所在位置**：`src/fs/artifact.ts:92-94`、`src/config.ts:318`

**问题描述**：`--artifact-dir ./artifacts` 时 `config.artifactDir` 保持相对形式，`artifact_path` 逐字透传为相对路径，违反 SPEC §4.1.3「返回值中一律为绝对路径」。

**详细分析**：`defaultArtifactDir()` 生成的是绝对路径，但用户显式传入的值不经过 `path.resolve`。模型拿到相对路径后无法在别的 cwd 下打开，且与 `path`（绝对）风格不一致。

**修复建议**：`src/config.ts` 解析后统一 `artifactDir: path.resolve(String(resolved['artifact-dir']))`；同类问题也适用于 `root`（见【A15】）。

**设计文档对齐**：违反 SPEC §4.1.3。

---

### 【A15】相对 `--root` 会让围栏拒绝一切请求（fail-closed）

**严重程度**：🟠 严重
**所在位置**：`src/fs/fence.ts:37-38,42-45,82-88`

**问题描述**：`PathFence` 用**未解析**的 `root` 计算 `rootNorm`，而 `resolve()` 用 `path.resolve` 产出绝对路径；当 `--root .` / `IPYNB_ROOT=.` 时，`'.'` 与绝对路径永不匹配，**每一次工具调用都抛 `path_outside_root`**。

**详细分析**：

```ts
// fence.ts:37 —— 未 resolve
this.#rootNorm = normalizeForCompare(toPosix(root), platform);   // '.'
// fence.ts:43-44 —— resolve 后是绝对路径
const absolute = path.isAbsolute(input) ? input : path.join(this.#root, input);
return toPosix(path.resolve(absolute));                          // 'E:/work/notebooks/a.ipynb'
// fence.ts:83 → #isInsideNorm('e:/work/...', '.') → false → path_outside_root
```
启动校验（`config.ts:360-404`）用 `realpathSync(root)` 而不是 `config.root`，因此 `--root .` 能通过启动检查，问题被推迟到第一次工具调用才暴露——用户看到的是"插件不可用"而非"参数写错"。安全性无碍（fail-closed），但可用性受损。

**修复建议**：构造函数第一行归一化：

```ts
constructor(root: string, ...) {
  const absoluteRoot = path.resolve(root);
  this.#root = absoluteRoot;
  this.#rootNorm = normalizeForCompare(toPosix(absoluteRoot), platform);
  this.#rootRealNorm = this.#realpathOrSelf(absoluteRoot);
}
```
并补单测：`--root .` 下 `assertInside('a.ipynb')` 返回绝对路径而非抛错。

**设计文档对齐**：SPEC §5.1 未要求 `--root` 必须绝对；D17 的意图是"默认为 cwd 且围栏生效"，实现未覆盖相对值。

---

### 【A16】空环境变量绕过范围校验（`IPYNB_*=""`）

**严重程度**：🟡 警告
**所在位置**：`src/config.ts:284-302`

**问题描述**：校验循环对空字符串 `continue`，随后 `Number('')` 得到 `0`（或 `String('')` 得到 `''`），产生越界配置。

**详细分析**：
- `IPYNB_KERNEL_IDLE_SECONDS=""` → 跳过校验 → `Number('')` = `0` → 回收间隔 `max(5, min(60, 0))` = 5 秒 → **每次 5 秒空闲就杀 kernel**；
- `IPYNB_EXEC_TIMEOUT_SECONDS=""` → `0` → sidecar `timeoutMs=0` → 每个 cell 立即超时；
- `IPYNB_PYTHON=""` → `config.python = ''`（非 `null`）→ 被当作"显式指定"→ `existsSync('')` 为 false → **所有 run 抛 `interpreter_not_found`**。

Shell 里 `VAR=` 或 `.env` 文件里的空值是常见写法，因此这不是理论问题。

**修复建议**：把空串视为"未设置"（与 dsh 的 `resolveDshHome` 对 `DSH_HOME` 的处理一致），并在解析后做一次显式范围复检：

```ts
// 解析入口
const envRaw = spec.env !== undefined ? env[spec.env] : undefined;
const envValue = envRaw !== undefined && envRaw.trim() !== '' ? envRaw : undefined;   // 空串 = 未设置
...
// 校验循环：把 `if (value === '') continue` 改为不跳过（因为上面已过滤），或在校验后断言范围
```

**设计文档对齐**：SPEC §5.1「所有数值型参数在启动时校验；非法值 → 进程退出码 2」；空值走了"未设置"通道从而未被校验，属实现漏洞。

---

### 【A17】同一 notebook 的并发 `edit` 无互斥，复检与 rename 之间存在丢改动窗口

**严重程度**：🟡 警告
**所在位置**：`src/fs/notebook-file.ts:61-114`

**问题描述**：`writeNotebookFile` 的 hash 复检（`:61-79`）与 `atomicWriteFile` 的 rename（`:110`）之间存在窗口，两个并发 edit 可以先后通过复检，后者覆盖前者，**前一次编辑静默丢失**。

**详细分析**：SPEC §4.1.7 要求的"读取→写入窗口内复检"已正确实现，但复检与落地不是原子的。同一进程内的并发（两个 MCP 工具调用）是最现实的触发场景，而进程内互斥是廉价且完全的。

**修复建议**：在 `fs/notebook-file.ts` 增加按绝对路径的进程内异步互斥（简单 promise 链或 `Map<string, Promise<void>>`），把"复检 + 序列化 + 备份 + rename"整体串行化：

```ts
const writeLocks = new Map<string, Promise<unknown>>();
async function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeLocks.set(key, next.catch(() => undefined));
  return next as Promise<T>;
}
```

**设计文档对齐**：SPEC 未要求进程内互斥（只要求 hash 复检）；属健壮性补强，建议补入 SPEC §5.9。

---

### 【A18】`notebook_kernel` 的 `alive` 只反映 sidecar 存活，`kernel_status` 链路从未被调用

**严重程度**：🟡 警告
**所在位置**：`src/kernel/registry.ts:375`（`alive: session.transport.alive`）、`src/kernel/transport.ts` 的 `kernelStatus`（无调用者）

**问题描述**：`KernelSessionInfo.alive` 取的是 **transport（sidecar）** 的存活状态，而不是 kernel 进程的存活状态；传输层虽有 `kernelStatus()`，但全仓无调用者。

**详细分析**：SPEC §4.9 要求返回每个 kernel 的 `alive`。当前实现下，kernel 进程已死但 sidecar 尚在（例如用户 `kill` 了 kernel、或 kernel OOM）时，`notebook_kernel status` 仍报 `alive: true`，直到 sidecar 的 `kernel_died` 事件到达（而该事件只在 exec 路径上触发，见【A12】）。模型的典型判断"kernel 还活着吗？我可以 resume 吗？"会得到错误答案。

**修复建议**：`notebook_kernel action='status'` 时对每个会话调用 `transport.kernelStatus(kernelId)` 并以其结果填充 `alive` / `execution_count` / `pid`（该 op 已存在于 sidecar 与协议中，只是没人调用）；或至少在 `run` 的 mode 判定前用 `kernelStatus` 复核一次。

**设计文档对齐**：SPEC §4.9「`status`：返回全部 kernel 会话」+ §5.8 的 `kernel_status` op 语义；实现在字段填充上偏离了该 op 的用途。

---

### 【A19】`read_only_mode` 错误绕过 `isError` 结构化映射

**严重程度**：🟠 严重
**所在位置**：`src/server.ts:179-183`（`assertWritableAllowed`）与 `src/server.ts:82-86,103-106,127-130,141-159,170-173`

**问题描述**：`assertWritableAllowed` 在 `runTool` **之外**抛出 `IpynbError`，被 MCP SDK 转成协议级错误（纯文本），SPEC §4.6.3 要求的 `isError: true` + `{"code","message","detail"}` 结构化工具结果丢失。

**详细分析**：

```ts
// server.ts:29-34：wrap 只负责把 outcome 转成 CallToolResult
const wrap = (action) => async (rawArgs, extra) => { const outcome = await action(rawArgs, extra); return toCallToolResult(outcome); };
// server.ts:103-106：抛错发生在 action 内部、runTool 之外
wrap((args, extra) => { assertWritableAllowed(ctx, 'notebook_edit', true); return handleNotebookEdit(...); })
```
`handleNotebookEdit` 内部的 `runTool` 只能捕获它自己 action 里的异常。只读模式下调用 `notebook_edit`，模型收到的是 SDK 的通用错误，**拿不到 `read_only_mode` 这个 code**，无法据此调整策略（例如改用只读工具）。同理，SDK 的 zod 类型校验失败也只给 `Input validation error: ...`（实现者已在 D-006 记录了这一半，但没覆盖只读门禁这一半）。

**修复建议**：把只读门禁移入各 handler 的 `runTool` 内（或在 `wrap` 里也套一层 `runTool` 语义）：

```ts
const wrap = (action) => async (rawArgs, extra) => toCallToolResult(await runTool(() => action(rawArgs, extra)));
```
（`runTool` 已是幂等的 `catch → toolFailure`，嵌套调用安全。）

**设计文档对齐**：违反 SPEC §4.6.3「`IpynbError` → `isError: true`，内容为单文本块 `{"code":…,"message":…,"detail":…}`」。

---

### 【A20】`sidecar-transport` 未监听 stdio 的 `'error'` 事件，EPIPE 可让整个服务崩溃

**严重程度**：🟠 严重
**所在位置**：`src/kernel/sidecar-transport.ts:61-92`（只挂了 stdout/stderr 的 `data`）、`:263-269`（写 stdin 的 try/catch）

**问题描述**：`child.stdin` 没有任何 `'error'` 监听；sidecar 死亡后向其写入会触发**异步** `EPIPE`/`ERR_STREAM_DESTROYED` 事件，`try/catch` 捕不到，Node 默认将其升级为未捕获异常，**整个 MCP server 退出**。

**详细分析**：`#request` 先检查 `this.#exited`（`:253`）再写（`:264`）。若 sidecar 在检查与写入之间退出（或 `kill()` 之后仍有一个在途 write 排队），写入失败以 `'error'` 事件异步派发。SPEC §10.2 的 I7 正是"kill sidecar"场景，B 类路径（如 `kernel_died` 事件与后续清理）与它会撞在一起。测试里 `transport.kill()` 之后没有继续写入，所以绿灯掩盖了该路径。

**修复建议**：

```ts
for (const [name, stream] of [['stdin', this.#child.stdin], ['stdout', this.#child.stdout], ['stderr', this.#child.stderr]] as const) {
  stream.on('error', (cause) => { this.#log?.('warn', `sidecar ${name} stream error: ${String(cause)}`); });
}
// 写入前额外判断
if (this.#child.stdin.destroyed || this.#child.stdin.writableEnded) {
  return Promise.reject(new IpynbError('kernel_died', 'sidecar stdin is closed'));
}
```
并补一条集成用例：kill sidecar 后立刻再发一次请求，断言进程存活且返回 `kernel_died`。

**设计文档对齐**：SPEC R19 要求"不留孤儿、稳定退出"，§10.2 I7 要求 sidecar 死亡以 `kernel_died` 失败；崩溃服务比返回错误严重得多。

---

### 【A21】64 MiB 上限作用在"累积缓冲区"而非"单行"，可误杀健康 sidecar

**严重程度**：🟡 警告
**所在位置**：`src/kernel/protocol.ts:45-51`

**问题描述**：`push()` 在**切行之前**检查 `this.#buffer.length > MAX_LINE_BYTES`，因此一个 chunk 里含多条完整小行、总量超过 64 MiB 时也会抛 `ProtocolFramingError`；而 `#handleStdout` 会把它升级为 `#failAllPending('kernel_died')` + `kill()`（`sidecar-transport.ts:192-200`）→ **健康的 sidecar 连同其全部 kernel 被杀**。

**详细分析**：SPEC §5.8 的规则是"**单行**超过 64 MiB"。触发需要单个 chunk > 64 MiB（管道单次读取通常 ≤ 64 KiB，故概率低），但这是明确的语义错误，且现有 U22 用例（`tests/unit/protocol.test.ts:60-64`）构造的是"一条无换行的 64 MiB+ 缓冲"，恰好绕过该分支、只覆盖了正确的那一半。

**修复建议**：把上限判定移入切行循环，只对未终结的残行生效：

```ts
while (newlineIndex >= 0) {
  const line = this.#buffer.subarray(0, newlineIndex);
  if (line.length > MAX_LINE_BYTES) throw new ProtocolFramingError(`sidecar line exceeds ${MAX_LINE_BYTES} bytes`);
  ...
}
// 循环结束后只检查残行
if (this.#buffer.length > MAX_LINE_BYTES) throw new ProtocolFramingError('sidecar line exceeds the cap (protocol error)');
```
并补用例：`push(由多条小行拼成、总量 > 64 MiB 的单个 chunk)` 不得抛错。

**设计文档对齐**：偏离 SPEC §5.8 的"单行"语义。另见【E3】：单行上限与 §4.4 的图片体积上限本身也互相矛盾。

---

### 【A22】传输层超时被报成 `kernel_died`，但 sidecar 仍存活、底层 op 仍在跑 → 孤儿 kernel 与执行重叠

**严重程度**：🟠 严重
**所在位置**：`src/kernel/sidecar-transport.ts:252-271`（超时统一 reject 为 `kernel_died`）、`:110-119`（各 op 的墙钟超时）

**问题描述**：任何 op 超过固定墙钟时限即 `reject(kernel_died)`，但 sidecar 并没有退出，Python 侧的那次操作仍在执行；迟到的响应会被当作"未知 id"丢弃（`:220-223`）。

**详细分析**：三条后果：
- `start_kernel` 超时（120s）后 sidecar 线程仍可能完成启动并把 kernel 记进 `KERNELS`，而 Node 侧 `getOrCreate` 已抛错、registry 无该 session → **孤儿 kernel**：`notebook_kernel status` 看不到、`shutdown` 关不掉，白占内存/显存直到进程退出（违反 R19）；
- `exec_cell` 超时（`timeoutMs + 30s`）后 registry 的 `finally` 会释放 `busy`（`registry.ts:228-230`），而那次执行还在跑 → 下一次 `notebook_run` 会在同一 kernel 上发起第二个 `exec_cell`，两个执行争抢 iopub，`_drain_iopub`（`ipynb_sidecar.py:373-378`）可能丢掉先到者的输出；
- `analyze` 超时（60s）会把"分析慢"报成 `kernel_died`，虽然 `run.ts:462-465` 会降级为 regex，但错误语义已歪曲（§7 定义 `kernel_died` = sidecar 或 kernel **异常退出**）。

**修复建议**：超时后把该 kernel 视为不可信并关闭，同时保留可诊断的 detail：

```ts
const timer = setTimeout(() => {
  this.#pending.delete(request.id);
  const error = new IpynbError('kernel_died', `sidecar request timed out after ${timeoutMs}ms (op=${op})`,
    { op, timeout_ms: timeoutMs, sidecar_alive: this.alive });
  reject(error);
}, timeoutMs);
// registry.execCell 的 catch 中：超时（或任何传输层失败）后 await this.shutdown(notebookPath)
```

**设计文档对齐**：偏离 SPEC §5.8（超时规则只定义在**执行**语义上）与 R19。

---

### 【A23】异常退出路径缺兜底：无 `uncaughtException`/`unhandledRejection` 钩子，sidecar 崩溃后不杀进程树，致命路径不 `shutdownAll`

**严重程度**：🟠 严重
**所在位置**：`src/kernel/sidecar-transport.ts:82-91`、`src/bin.ts:89-94,109-112`

**问题描述**：三条兜底同时缺失，留下"零孤儿"承诺的缺口。

**详细分析**：
- sidecar **异常**退出时（崩溃/被外部 kill），`#exited = true` 使 `kill()` 提前返回（`:151`），因此不会执行 `taskkill /T` 或 `kill(-pid)`——其子 kernel 可能存活。POSIX 下 sidecar 是 `detached` 进程组长，被 SIGKILL 后子 kernel 会被 init 收养；
- 全仓**没有** `process.on('uncaughtException'|'unhandledRejection')`；结合【A20】（stdio 无 `'error'` 监听），一次未捕获异常就会让进程静默消失并留下 sidecar（POSIX 下 detached 进程不随父进程退出）；
- `main().catch` → `process.exit(2)`（`:109-112`）不经过 `registry.shutdownAll()`。当前该路径只可能在 sidecar 创建前触发，风险低，但它是最后一道缺口。

**修复建议**：

```ts
// bin.ts，registry.start() 之后注册
const fatal = (reason: string, cause: unknown): void => {
  logger.error(`fatal: ${reason}: ${String(cause)}`);
  void registry.shutdownAll().catch(() => undefined).finally(() => process.exit(2));
};
process.on('uncaughtException', (cause) => fatal('uncaughtException', cause));
process.on('unhandledRejection', (cause) => fatal('unhandledRejection', cause));
// sidecar-transport.ts：异常退出也回收进程树
this.#child.on('exit', (code, signal) => { ...; void this.kill(); });
```

**设计文档对齐**：偏离 R19 与 SPEC §5.3「插件/进程退出必须 shutdown_all」的强度。

---

### 【A24】6 处 catch 只写注释不记 warn（R7 违规）

**严重程度**：🟡 警告
**所在位置**：`sidecar-transport.ts:143-145`、`run-status.ts:56-60`、`mcp/tools/run.ts:76-79`、`mcp/tools/kernel.ts:65-67`、`server.ts:53-55`，另有两处软违规 `fs/fence.ts:93,110`、`interpreter.ts:334-337`、`config.ts:388-390`、`bin.ts:41-45`

**问题描述**：R7 规定「任何 `catch` 必须转成结构化错误码向上抛，**或记 `warn` 并说明理由**；空 `catch` 一律禁止」。这些位置全部选择"沉默 + 注释解释"。

**详细分析**：`.oxlintrc.json` 虽开了 `no-empty: error`，但 lint 的 `no-empty` **忽略只含注释的块**，因此这些写法能通过 lint——这正是 R7 想拦的形状。后果是可观测性缺失：
- `shutdown_all` 失败时无法判断 kernel 是否真被回收；
- abort 时 `interrupt` 失败意味着**用户的长任务可能仍在运行**，而日志中毫无痕迹（与 §4.6.2 的可观测性要求冲突）；
- progress 通知失败会让客户端进度条永久卡住而无从排查。

**修复建议**：统一改为经 logger 记 warn（各文件都已有可用的 logger）：

```ts
} catch (cause) {
  this.#log?.('warn', `sidecar shutdown_all failed (kill path still guarantees no orphans): ${String(cause)}`);
}
```

**设计文档对齐**：违反 SPEC R7（明文"空 catch 一律禁止"）。

---

### 【A25】`.tmp-*` 残留无清理：硬杀/`process.exit` 期间留下的临时文件永久堆积

**严重程度**：🟡 警告
**所在位置**：`src/fs/atomic.ts:52,77-82`、`src/bin.ts:92-93`

**问题描述**：进程在 `open→write→sync` 与 `rename` 之间被硬杀（SIGKILL/结束进程/断电）时，`.<name>.tmp-<uuid>` 留在用户仓库；服务下次启动也不打扫历史残留。

**详细分析**：I14 只覆盖"客户端 abort"这一可协作路径（`throwIfAborted` + catch 清理）。`bin.ts:92` 在 `shutdownAll()` 完成后**立即** `process.exit(0)`，若此刻有调用正处于写窗口，其临时文件不会被删除。残留文件位于用户仓库、以 `.` 开头带 uuid，用户既看不到也删不干净——违反 §5.9「禁止在用户仓库内创建除备份与 artifact 之外的任何文件」的**净结果**（尽管创建本身是合规中间态）。

**修复建议**：登记在途临时文件并在退出时清理，或首次写某 notebook 时顺带清理同目录下匹配 `^\.<basename>\.tmp-<uuid>$` 且 mtime 超过 1 小时的残留。

**设计文档对齐**：SPEC §4.6.2 只要求"未 rename 则删临时文件"，未覆盖硬杀；建议补入 §5.9。

---

### 【A26】artifact 非原子写：半截文件会被 `EEXIST` 永久复用

**严重程度**：🟡 警告
**所在位置**：`src/fs/artifact.ts:95-110`

**问题描述**：`writeFile(..., { flag: 'wx' })` 直接落盘；进程在写入中途死亡会留下截断的 PNG，而下次同内容物化命中 `EEXIST` 后**当作成功复用**（`:109-110` 没有任何内容/长度校验）。

**详细分析**：§5.9 的幂等契约是"同一内容命中同一文件，不覆盖不追加"，靠文件名里的 `sha256[:8]` 保证。但"半个文件"会被永久当真，而 `artifact_path` 是回传给模型/用户的交付物——静默损坏比写失败更糟。

**修复建议**：临时文件 + rename（与 notebook 写入一致），或至少在 `EEXIST` 分支做长度校验：

```ts
const st = await stat(artifactPath);
if (st.size !== image.bytes.byteLength) { warnings.push(createWarning('image_materialize_failed', `artifact size mismatch at ${artifactPath}`)); }
```

**设计文档对齐**：SPEC §5.9 未定义损坏文件的复用行为；建议补一句"复用前校验长度，不匹配则重写"。

---

### 【A27】`rename` 覆盖会替换权限位（`0600` → `0644`）

**严重程度**：🟡 警告
**所在位置**：`src/fs/atomic.ts:56`

**问题描述**：临时文件以 `0o666 & ~umask` 创建，`rename` 换 inode 后原 notebook 的权限被**替换**为临时文件的权限。

**详细分析**：POSIX 下 `rename` 不继承目标权限。用户把含私有数据的 notebook 设为 `0600` 后，经本工具一次编辑即变成 `0644`，同机其它用户可读——这是**静默的权限放宽**。Windows 走 ACL 继承，无此问题。

**修复建议**：

```ts
let mode = 0o666;
try { mode = (await stat(absolutePath)).mode & 0o777; } catch { /* 新文件用默认 */ }
const handle = await deps.open(tmpPath, 'wx', mode);
```

**设计文档对齐**：SPEC §9 只讲 `MoveFileExW` 与目录 fsync，未涉及权限保持；属安全加固缺口。

---

### 【A28】监听器/线程/内存保留（四处）

**严重程度**：🟢 建议
**所在位置**：`sidecar-transport.ts:179-186`、`mcp/tools/run.ts:75`、`python/ipynb_sidecar.py:415,433`、`mcp/run-store.ts:29-30,89-105`

**问题描述**：① `#waitExit` 超时胜出时 `once('exit')` 监听器仍留在 child 上；② `run.ts:75` 的 abort 监听器从不 `removeEventListener`；③ sidecar 为每个请求 `workers.append(worker)` 且**永不清理**（长会话下线程对象无界累积）；④ run 表对**运行中**的 run 无上限，每个已完成 run 保留完整 outputs（含 base64 图片块）10 分钟。

**修复建议**：③ 是唯一真正的线性泄漏，建议 `workers = [w for w in workers if w.is_alive()]` 或改用固定线程池；①② 用 `{ once: true }` 与显式移除；④ 符合 §4.8，建议在 README 声明内存占用特征。

**设计文档对齐**：④ 符合 SPEC §4.8；①②③ 规格未涉及。

---

### 【A29】备份的两个窗口问题：裁剪失败阻塞编辑、同秒命名竞态

**严重程度**：🟡 警告
**所在位置**：`src/fs/backup.ts:37,44-53,63`、`src/fs/notebook-file.ts:88-107`

**问题描述**：(a) 滚动清理中任一次 `unlink`/`readdir` 失败都会抛出，导致**备份已建好但写入被放弃**，最终以 `internal` 返回；(b) 同秒命名基于 `readdir` 快照计算，并发调用可能算出同一个 `-<n>` 名字，`copyFile` 后者覆盖前者。

**详细分析**：(a) 备份保留是**维护性副作用**，不应具备否决权——磁盘上一份无关旧备份被别的进程占用（Windows 常见）就会让本次编辑彻底失败，且错误是 `internal`（用户无法理解）。(b) 备份是"不会静默改坏"的最后兜底，跨进程（用户同时用 Jupyter 保存）仍可能覆盖一份备份。

**修复建议**：

```ts
// (a) 清理阶段尽力而为 + warn
for (const victim of excess) { try { await deps.unlink(...); } catch (cause) { deps.onRetentionError?.(`failed to prune ${victim}: ${String(cause)}`); } }
// (b) 独占拷贝
await copyFile(src, dest, fs.constants.COPYFILE_EXCL);   // EEXIST → n += 1 重算名字后重试
```

**设计文档对齐**：符合 §5.9 的字面要求，但未定义清理失败与命名冲突的语义；建议补入。

---

### 【A30】`shutdown` 先摘除 session 再 `await`：失败后 kernel 在进程内"隐形存活"

**严重程度**：🟡 警告
**所在位置**：`src/kernel/registry.ts:244-256`

**问题描述**：`#removeSession(session)` 在 `await session.transport.shutdownKernel(...)` **之前**执行，失败只记 warn；此后该 kernel 既不在 `#sessions` 也不在 `#kernels`，但仍然活着。

**详细分析**：后果是"隐形但占资源"：`notebook_kernel status` 不列出它、`notebook_kernel shutdown` 关不掉它（`:244` 找不到 session 直接 return），只有进程退出时的 `shutdown_all` 能回收。`sidecar-transport.ts:126` 的 30 秒超时也会走到这条路径（见【A22】）。

**修复建议**：失败时保留 session 以便重试，并把失败如实返回：

```ts
try { await session.transport.shutdownKernel(session.kernelId); }
catch (cause) {
  this.#logger?.warn(`kernel shutdown failed for ${session.kernelId}; keeping the session for retry: ${String(cause)}`);
  throw new IpynbError('kernel_died', `failed to shut down kernel ${session.kernelId}`, { kernel_id: session.kernelId });
}
this.#removeSession(session);
```

**设计文档对齐**：偏离 SPEC §5.3「`shutdown`/`restart` 立即关闭」的强度（当前只保证"尽力"）。

---

### 【A31】写回与读取未传 abort signal（R18）

**严重程度**：🟡 警告
**所在位置**：`src/run.ts:513,563`（两次 `writeNotebookFile` 调用）、`src/fs/notebook-file.ts:18-31`（`readNotebookFile`）

**问题描述**：`writeNotebookFile` 声明并支持 `signal`（`edit.ts:78` 就传了），但 `run.ts` 的两处写回都没传；`readNotebookFile` 也不接受 signal。SPEC §4.6.2 要求 abort signal 被传递到**所有**异步 I/O。

**详细分析**：run 写回是本产品中最长的一次 I/O（序列化 + 备份拷贝 + fsync，大 notebook 可达数百毫秒到数秒）。此期间客户端取消不会中断写入，也不会有"已 rename 则返回已完成结果"的语义判断——与 `edit` 路径的行为不一致。

**修复建议**：`run.ts` 三处 `writeNotebookFile` 调用补 `signal: req.abort?.signal`；`writeBackCompleted` 同样透传（注意 abort 时若已进入 rename 阶段，按 §4.6.2 应返回已完成的结果而非报错）。

**设计文档对齐**：违反 SPEC §4.6.2 / R18。

---

## B 类：架构与模块边界

### 【B1】`src/mcp/*` 直接 import `node:fs` / `node:child_process`，违反模块铁律

**严重程度**：🟠 严重
**所在位置**：`src/mcp/tools/kernel.ts:5-8`、`src/mcp/tools/edit.ts:4-5`

**问题描述**：AGENTS.md §4 与 SPEC §3.2 的边界表明确写「`src/mcp/*`：**禁止**直接碰 `node:fs`」（AGENTS 还标注"违反即回退"），实际两处工具越层做文件 I/O 与进程调用。

**详细分析**：
- `kernel.ts:5` `execFile`（node:child_process）、`:6` `existsSync`、`:7` `readFile`、`:8` `homedir`；并在 `:75-79` 自行提取 kernelspec 名、在 `:85-120` 自行装配 `resolveInterpreter` 的依赖（30 行重复代码，与 `run.ts:596-629` 几乎逐字相同，且**缺少 run.ts 那份 `cache` 适配器**——导致 `notebook_kernel start` 每次都重新做一次 15 秒超时的 `python -c "import ipykernel"` 探测，而 `notebook_run` 走缓存：同一环境解析在两条入口上行为不一致）。
- `edit.ts:4-5` 的 `existsSync`/`node:path` 用于 markdown 检查器的相对路径判定。SPEC §5.7 要求"唯一允许的外设是注入的 `existsSync`"，注入点选在工具层，于是工具层获得了 fs 能力。

**修复建议**：
1. 把 kernelspec 名提取 + `resolveInterpreter` 依赖装配下沉为 `src/kernel/interpreter.ts` 的单一入口 `resolveForNotebook(notebookAbsPath, config, platform)`（内部自带缓存），`run.ts` 与 `mcp/tools/kernel.ts` 都调它；
2. 把 markdown 相对路径判定下沉为 `src/fs/markdown-targets.ts` 导出的 `markdownExists(notebookAbsPath, relPath): boolean`，`edit.ts` 只调用纯函数。

**设计文档对齐**：违反 SPEC §3.2 边界表（`src/mcp/*` 行）与 AGENTS.md §4（"违反即回退"）。

---

### 【B2】SPEC §8 指定的 3 个文件缺失且未登记到 `DEVIATIONS.md`

**严重程度**：🟠 严重
**所在位置**：`src/core/model.ts`、`src/fs/lock.ts`、`src/mcp/progress.ts`（均不存在）

**问题描述**：SPEC §8 的包结构逐文件列出了这三个文件，实现分别把它们并入了 `core/parse.ts`（类型）、`fs/atomic.ts` + `fs/notebook-file.ts`（占用处理）、`server.ts:36-59`（progress），且 `docs/DEVIATIONS.md` 只记了 D-001..D-006，**没有这三条**——而 AGENTS.md §0 明确规定"偏离必须当场登记"。

**详细分析**：三处偏离本身在工程上可辩护（见 B3 的合理性评价），问题在于**流程失效**：`DEVIATIONS.md` 是本次交付里唯一能追溯"实现与规格何处不同"的载体，漏记意味着下一次评审（或下一个 agent）无法区分"有意偏离"与"忘了做"。

**修复建议**：补三条 DEVIATIONS 记录，或按 SPEC 落文件。推荐前者（成本更低、行为零变更），格式照现有表格：

```markdown
| D-007 | <日期> | §8 | progress 通知实现于 src/server.ts 而非 src/mcp/progress.ts | 仅 24 行且与 server 组装强耦合，拆文件只增间接层 | 目录清单与 §8 不一致，行为不变 | 已实现（src/server.ts:36-59） |
| D-008 | <日期> | §8 | 无 src/core/model.ts，模型类型定义在 core/parse.ts | 类型与解析器同源，拆开需额外 re-export 且无行为收益 | 同上 | 已实现（src/core/parse.ts:8-40） |
| D-009 | <日期> | §8 | 无 src/fs/lock.ts，占用错误翻译在 fs/atomic.ts + fs/notebook-file.ts | isLockError 与两处调用点同层，独立文件无内聚收益 | 同上 | 已实现（src/fs/atomic.ts:107-115） |
```

**设计文档对齐**：违反 SPEC §8 与 AGENTS.md §0（偏离登记流程）。

---

### 【B3】`src/run.ts`（629 行）是 SPEC 与 AGENTS 都未定义的隐式新增层

**严重程度**：🟡 警告
**所在位置**：`src/run.ts:1-629`

**问题描述**：执行编排放在仓库根的 `run.ts`，而 SPEC §8 的树只承认 `src/{bin,server,config,log}.ts` 四个根级文件；SPEC §11 step 9 把"6 个工具 + render + run-store + progress + abort"划给 `src/mcp/*`。

**详细分析**：`run.ts:6-20` 同时 import `node:child_process`、`node:fs`、`node:fs/promises`、`node:os` 与 core/fs/kernel/config/log，是全仓唯一的跨层组合点（这本身是必要的——执行编排就要组合这些层），但它使"谁拥有执行语义"变得含糊，也直接导致了 `mcp/run-store.ts:5` 反向依赖根层类型（`import type { ExecutedCell, RunOutcome } from '../run.js'`，轻度的方向倒置）。

**修复建议**：二选一——(a) 迁为 `src/mcp/run.ts`，把 `ExecutedCell`/`RunOutcome`/`RunImageBlock`/`RunProgressEvent`（`:22-93`）移入 `src/core/model.ts`，`run-store.ts` 与 `run.ts` 同向依赖；(b) 保留位置并在 DEVIATIONS 登记，同时更新 AGENTS.md §4 的目录树。

**设计文档对齐**：偏离 SPEC §8、§11 step 9 与 AGENTS.md §4（未登记）。

---

### 【B4】kernelspec 名提取在三处重复实现

**严重程度**：🟡 警告
**所在位置**：`src/run.ts:172-183`、`src/mcp/tools/kernel.ts:74-84`、`src/mcp/render/read.ts:40-54`

**问题描述**：`metadata.kernelspec.name` / `metadata.language_info.name` / `.version` 的防御式提取被复制三份（第三份在 render 里还多取了 `version`），后续任何字段语义变化都可能只改一处。

**修复建议**：抽到 `src/core/model.ts`（或 `core/parse.ts`）作为纯函数 `readNotebookMetadata(doc): { kernelName, languageName, languageVersion, languageInfoName }`，三处调用。

**设计文档对齐**：SPEC 未禁止重复；属 DRY 与维护性问题（AGENTS.md §5 未覆盖）。

---

### 【B5】`src/mcp/run-store.ts` 反向依赖根层 `src/run.ts` 的类型 —— 轻度分层倒置

**严重程度**：🟢 建议
**所在位置**：`src/mcp/run-store.ts:5`

**问题描述**：mcp 层从根级执行文件取类型，与 SPEC §3.1 分层图（mcp 在 kernel/fs/core 之上）方向不一致。因是 `import type`，运行时零开销、无环。

**修复建议**：随【B3】一并处理（类型下沉到 `core/model.ts`）。

**设计文档对齐**：轻度偏离 SPEC §3.1。

---

### 【B6】`src/hash.ts`、`src/mcp/context.ts`、`src/mcp/tools/result.ts`、`src/fs/notebook-file.ts` —— 合理新增

**严重程度**：✅ 该子项未发现问题（仅建议登记）

**分析**：`hash.ts:4-6` 是 core 哈希能力的 Node 适配器（使 `src/core/**` 完全不 import `node:*`，是 R11 成立的关键）；`context.ts:1-133` 是 ToolContext 束 + 值级校验助手（`requireOpsArray` 正确实现 1..32 → `invalid_arguments`，符合 §4.1.12）；`result.ts:24-39` 是 D24"单文本块 + 可选图片块 + `IpynbError`→`isError`"的唯一出口（**确实没有 `structuredContent`、没有 `outputSchema`** ✅ D24 合规）；`notebook-file.ts` 承担 D12 的原子写编排。四者职责单一、无泄漏。

**建议**：在 AGENTS.md §4 的目录树里登记它们，避免下次评审重复判定。

---

## C 类：发布链与仓库卫生

### 【C1】发布链断裂：`lib/` 被 gitignore 且没有任何产包构建钩子

**严重程度**：🔴 阻塞（发布维度）
**所在位置**：`.gitignore:3`、`package.json:20-26`、`.github/workflows/ci.yml:9-29,55`

**问题描述**：SPEC §8 发布规则 1 与 R15 要求"发布包必须是可直接运行的构建产物"，但 `lib/` 不入库、`package.json` 正确地没有 `prepare`/`postinstall`，于是**没有任何环节保证 npm tarball 里含 `lib/`**。

**详细分析**：`lib/` 当前存在（31 个 `.js`，含 `lib/bin.js`）；CI 的 `pnpm build` 只出现在 integration job（`ci.yml:55`），unit job 不构建；三条现实路径都可能产出坏包：① 双清检出后 `npm publish`；② CI 全绿但产物从未被验证；③ 维护者按 README 手工 `pnpm build` 而遗漏。对一个以 `npx -y ipynb-mcp` 为唯一入口的开源项目，发布一个空包等于项目不可用。

**修复建议**：

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "prepack": "pnpm build",
  "prepublishOnly": "pnpm typecheck && pnpm lint && pnpm test"
}
```
（R15 只禁**安装期**脚本 `prepare`/`postinstall`；`prepack`/`prepublishOnly` 仅在 `npm pack`/`publish` 触发，不违反 R15。）并在 CI 的 unit job 增 `- run: pnpm build`。另建议补 `"exports": { ".": "./lib/server.js" }` 以便程序化引用。

**设计文档对齐**：违反 SPEC §8 发布规则 1（R15 的落地要求）与 AGENTS.md §8 step 10。

---

### 【C2】`lib/bin.js` 无 shebang

**严重程度**：🟡 警告
**所在位置**：`src/bin.ts:1`（源）→ `lib/bin.js:1-4`（产物）

**问题描述**：`bin.ipynb-mcp` 指向 `./lib/bin.js`，但该文件首行是注释，没有 `#!/usr/bin/env node`。

**详细分析**：实测 `^#!` 在 `lib/**/*.js` 与 `src/**` 均零命中（`src/bin.ts` 也没有，故 `tsc` 不会产出）。POSIX 上 npm/pnpm 会为 `bin` 生成带 shebang 的 shim，所以 `npx ipynb-mcp` 大概率仍可用；但直接执行 `./lib/bin.js` 或某些严格环境会失败，与"产物可直接运行"的意图相悖。

**修复建议**：在 `src/bin.ts` **首行之前**加 `#!/usr/bin/env node`，重新 `pnpm build`。

**设计文档对齐**：符合 SPEC §8 意图但产物不满足；属实现缺陷。

---

### 【C3】`scripts.typecheck` 与文档字面命令不一致（语义等价）

**严重程度**：🟢 建议
**所在位置**：`package.json:22`、`tsconfig.test.json:4-7`

**问题描述**：SPEC §10.4 与 AGENTS.md §3 写的命令是 `tsc --noEmit`，实现是 `tsc -p tsconfig.test.json`。

**详细分析**：两者语义等价且**覆盖面更广**（`tsconfig.test.json` 额外包含 `tests/`、`vitest.config.ts`、`vitest.integration.config.ts`，并继承 `strict` + `noUncheckedIndexedAccess`）。风险仅在于验收脚本按字面 grep 会失配。次要噪声：`tsconfig.test.json:5` 的 `rootDir: "."` 在 `noEmit` 下无意义。

**修复建议**：`"typecheck": "tsc --noEmit -p tsconfig.test.json"`；删掉 `rootDir`。

**设计文档对齐**：功能符合，字面命令偏离。

---

### 【C4】`docs/` 内容卫生：`OPEN_QUESTIONS.md` 非原样抄录、`docs/archive/` 无实体、`DEVIATIONS.md` 漏记（见 B2）

**严重程度**：🟡 警告
**所在位置**：`docs/OPEN_QUESTIONS.md:5-13`、`docs/archive/README.md:7`

**问题描述**：SPEC §12 要求把该节「**原样抄录**」进 `docs/OPEN_QUESTIONS.md`，实际内容一致但格式被改写（内联反引号被去掉、引号被替换）；`docs/archive/` 只有 7 行索引，自陈"原始 v1/v2 文档不在本仓库"，而 SPEC 文首声明两者"移入 `docs/archive/`"。

**修复建议**：`OPEN_QUESTIONS.md` 直接粘贴 SPEC §12 表格原文；把 v1/v2 文档实体放入 `docs/archive/`，或在 DEVIATIONS 记一条"原文不可得，以索引代替"。

**设计文档对齐**：违反 SPEC §12 的"原样抄录"要求与文首的归档声明。

---

### 【C5】`zod` 依赖：**必要**，不是多余依赖（澄清项，无需整改）

**严重程度**：✅ 未发现问题

**分析**（三层实体证据，SDK 1.31.0）：
1. SDK **自身直接 import zod**：`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:9` → `import { ZodOptional } from 'zod'`；`.../zod-compat.js:5-6` → `import * as z3rt from 'zod/v3'`。模块载入期求值 —— 没有 zod 则 `McpServer` 无法加载。
2. zod 是 SDK 声明的**非可选 peer**（`.../package.json:119,124,126-133`，`peerDependenciesMeta.zod.optional = false`）。
3. `registerTool` 的 `inputSchema` 类型只接受 zod（`.../mcp.d.ts:150-153`、`zod-compat.d.ts:3`），实现侧明确抛 "inputSchema must be a Zod schema or raw shape"。

→ `docs/DEVIATIONS.md` 的 D-005 记录**成立**。建议在该行补一句"选 zod 3.x 的理由"与"已向人类报备"（AGENTS.md §5 要求新增依赖先问人类，仓库内无该流程的留痕）。

**设计文档对齐**：D-005 已记录；SPEC §8"运行时依赖只有 SDK"的字面表述应修正为"除 SDK 的必需 peer 外无额外依赖"。

---

### 【C6】CLI 与围栏的若干小缺陷（合并条目）

**严重程度**：🟡 警告（各条独立影响都很小，合并以便修复）
**所在位置与内容**：

| # | 位置 | 问题 |
|---|---|---|
| C6a | `src/config.ts:118` | `-h` 不被接受：解析器要求参数以 `--` 开头，而 `USAGE`（`:107`）与 `config.ts:127` 都宣传 `-h, --help`；`ipynb-mcp -h` 会得到 "unexpected argument" + 退出码 2 |
| C6b | `src/config.ts:340-345` | POSIX 下文件系统根未被拒绝：`isFilesystemRoot` 判 `normalizedPath === ''`，而 `/` 归一化后仍是 `/`；Windows 分支 `^[a-z]:$` 正确。`--root /` 会绕过 D17 的拒绝并在 Linux/macOS 上把整个文件系统纳入围栏 |
| C6c | `src/kernel/interpreter.ts:88,176` | ipykernel 探测超时写死 15 秒，SPEC §5.2 规定 5 秒 |
| C6d | `src/kernel/interpreter.ts:223` | `maybeVenvMismatch` 无条件 `toLowerCase()` 比较两侧路径，在大小写敏感的 Linux 上会把不同路径判为相同，漏报 `kernelspec_mismatch`；应使用 `normalizeForCompare(..., platform)` |
| C6e | `src/core/markdown.ts:143-160` | 表格判定为"连续含 `|` 的行"，正文中含两个竖线的句子会被当作表格并可能产生 `table-column-mismatch` 误报（warning 级，不阻塞写入） |
| C6f | `python/ipynb_sidecar.py:428-433` | 每个请求创建线程并 `workers.append`，list 永不清理 → 长会话下线程对象累积（内存泄漏）；`KernelEntry.shutdown`（`:49-57`）有两处 `except: pass`（SPEC R7 的等价禁止项） |
| C6g | `src/fs/atomic.ts:102` | 临时文件清理失败时直接写 `process.stderr`，绕过 `src/log.ts`（不违反 R14，但绕过日志级别与格式统一） |

**修复建议**：逐条按上表最小改动；C6a/C6b 建议补单测（`-h` 退出码 0、`--root /` 退出码 2）。

**设计文档对齐**：C6b 违反 SPEC D17；C6c 违反 SPEC §5.2；C6f 违反 SPEC R7 的精神与 Python 侧约定；其余为 SPEC 未覆盖的健壮性缺口。

---

## D 类：测试质量

> 规模核对：`tests/unit` **15** 个 `.test.ts`（不是 14）+ `tests/integration` 5 个；共 **174** 个 `it`（unit 148 / integration 26）——与 `docs/COMPATIBILITY.md:18` 记录的 148/148、26/26 计数吻合。

### 【D1】夹具无法表达失败模式：`codeCell()` 恒产出 `outputs: []`，使【A1】在绿灯下存活

**严重程度**：🟠 严重
**所在位置**：`tests/integration/run.test.ts:95-97`，影响 I1（`:132-152`）、I2（`:154-171`）、I3（`:173-201`）、I5（`:217-244`）

**问题描述**：所有集成夹具的 code cell 都由同一 helper 生成，它固定写入 `outputs: []` 与 `execution_count: null`，于是"未执行 cell 的输出保持不变"这类断言**在空值上天然成立**，无法区分"被保留"与"被清空"。

**详细分析**：

```ts
// tests/integration/run.test.ts:95-97
function codeCell(source: string, id: string): Record<string, unknown> {
  return { cell_type: 'code', id, metadata: {}, source, outputs: [], execution_count: null };
}
```
- I5（超时）断言 `cells[1].outputs === []`（`:239`）——这正是【A1】造成的**错误结果**，测试却把它当作正确；
- I1 断言 `cells[2].outputs === []`（`:148`）——同样无法发现"未被执行的 cell 在预清空阶段被抹掉"；
- I2/I3 对前缀 cell 的断言（`:194-195`）同理。

**结论**：「26/26 integration 通过」与【A1】的存在并不矛盾——问题不是断言太弱（断言写了），而是**夹具不具备触发条件**。

**修复建议**：让 helper 支持预置输出，并新增针对性用例（对应 §4.7 规则 3 / §4.8 规则 2，建议编号 I18）：

```ts
function codeCell(source: string, id: string, seed?: { outputs?: unknown[]; execution_count?: number | null }) {
  return { cell_type: 'code', id, metadata: {}, source,
           outputs: seed?.outputs ?? [], execution_count: seed?.execution_count ?? null };
}
it('a timeout never wipes outputs of cells that did not run', async () => {
  const nb = await writeNb('i18.ipynb', [
    codeCell('import time\nwhile True: time.sleep(0.1)', 'c0'),
    codeCell('z = 3', 'c1', { outputs: [{ output_type: 'stream', name: 'stdout', text: 'PRESERVED\n' }], execution_count: 7 }),
  ]);
  await expect(runNotebook(request(nb, { cellSelector: 'all', timeoutSeconds: 4 }), deps()))
    .rejects.toMatchObject({ code: 'exec_timeout' });
  const cells = await readCells(nb);
  expect(cells[1]!['outputs']).toEqual([{ output_type: 'stream', name: 'stdout', text: 'PRESERVED\n' }]);
  expect(cells[1]!['execution_count']).toBe(7);
});
```

**设计文档对齐**：SPEC §10.2 的用例清单缺少"预置输出 + 超时/取消"的组合，属**用例设计盲区**；建议补入 §10.2。

---

### 【D2】`stale` 分析器的真实实现零单测覆盖：U18/U19b 的防回归价值被架空

**严重程度**：🟠 严重
**所在位置**：`tests/unit/stale.test.ts:17-38`（`run()` helper 手工构造 `defs`/`uses` 后直接调用 `analyzeStale`）

**问题描述**：单测只测了"判定逻辑"（`src/core/stale.ts:38-94`），而**产生 defs/uses 的 symtable 分析器**（`python/ipynb_sidecar.py:312-352`）在单测层完全没有覆盖。

**详细分析**：U18 的设计意图是"**只有正确的实现才能通过**"（SPEC 原话：正则实现无法通过），U19b 的意图是"朴素 AST 遍历会误报"。但两个用例都是**手工喂入**已算好的 `defs`/`uses`：

```ts
// tests/unit/stale.test.ts:44-49 —— defs/uses 是人写的，不是分析器算的
const stale = run([
  { defs: ['a', 'b'], uses: ['f'], meta: { cell_index: 0, has_nonempty_outputs: false } },
  { defs: [], uses: ['a'], meta: { cell_index: 1 } },
], [0]);
```
后果：把 sidecar 的 `symtable` 换回朴素 AST 遍历（或换成正则），**148 个单测仍然全绿**。真正的兜底只剩 `tests/integration/stale.test.ts:93/115`，而 integration 不在 `pnpm test` 的默认范围、且 CI 在 macOS 上不跑 integration——即"SPEC 点名的两个关键用例"在最常用的开发回路里是失效的。

**修复建议**：把 `analyze` op 通过可注入的假 transport 接进单测（`SidecarTransport` 的 `spawnImpl` 已可注入，或直接对 `op_analyze` 的 Python 实现做一次真实调用），断言"源码 → defs/uses"这一步：

```ts
it('[U18] symtable maps tuple unpacking to module-level defs', async () => {
  const analysis = await transport.analyze(['a, b = f()', 'print(a)']);
  expect(analysis.defs[0]).toEqual(expect.arrayContaining(['a', 'b']));
  expect(analysis.uses[1]).toEqual(['a']);
});
```

**设计文档对齐**：SPEC §10.1 的 U18/U19b 意图未被满足（用例存在于错误的层次）；建议在 §10.2 增补一条"analyze op 的端到端输入输出"用例。

---

### 【D3】编辑工具"失败绝不落盘"与 `dry_run` 在工具层完全没有用例

**严重程度**：🟠 严重
**所在位置**：`tests/unit/edit.test.ts:78`、`tests/unit/markdown.test.ts:162`、`tests/unit/edit.test.ts:231-249`（U8）、`tests/unit/tools-shape.test.ts:105-111`

**问题描述**：CAS 失败"文件字节未变"的断言是**同义反复**——它调用的是纯函数 `applyEditOps`（core 层没有任何 I/O），随后回读的是**测试自己写的文件**；工具层（`src/mcp/tools/edit.ts`）的失败路径从未被任何用例走到。U8（`dry_run`）的三个判定全部没有断言。

**详细分析**：
- `edit.test.ts:78` / `markdown.test.ts:162`：`applyEditOps` 抛错 → 文件当然没变（因为没有任何东西写过它）。若实现把 CAS 校验挪到写之后（先写再校验），这两个用例**照样通过**。产品第一卖点"不会静默改坏"因此没有守卫。
- U8：`:231-249` 的用例根本没有传 `dry_run`，还用 stub 的 `checkMarkdown` 顶替真检查器；唯一真正带 `dry_run` 的是 `tools-shape.test.ts:105-111`，而它只断言 `applied === 1`。SPEC 对 `dry_run` 有三条明确判定（文件字节不变、`backup_path === null`、`markdown_issues` 仍被计算），**全部无断言**；全仓 `backup_path` 零命中。

**修复建议**：把 U2/U4/U8/U9 提升到**工具层**（经 `handleNotebookEdit` + 真实临时文件），并补全 `dry_run` 的三条断言：

```ts
const before = await readFile(nb);
const out = await handleNotebookEdit(ctx, { path: nb, ops: [...], dry_run: true });
const payload = JSON.parse(text(out));
expect(payload.backup_path).toBeNull();
expect(payload.content_hash_after).toBe(payload.content_hash_before);
expect(payload.markdown_issues.length).toBeGreaterThan(0);   // 仍被计算
expect(await readFile(nb)).toEqual(before);
```

**设计文档对齐**：SPEC §10.1 的 U2/U4/U8 判定条件未被真正验证。

---

### 【D4】用例缺失与名不副实（8 处）

**严重程度**：🟠 严重
**所在位置**：见下表

**问题描述**：3 项完全缺失，8 项虽有同名用例但**断言的不是它名字承诺的东西**（"绿灯通胀"）。

**详细分析**：

| 项 | SPEC 要求 | 实际 | 性质 |
|---|---|---|---|
| **U13** | `cell_selector='5-3'` → `invalid_targets` | 全仓 0 命中（`invalid_targets` / `parseCellSelector` 无任何断言） | **缺失** |
| **U20** | 非 Python kernel → `method==="skipped"`、`stale_cells` 空 | 全仓 0 命中 `'skipped'` | **缺失** |
| **U12** | `expected_content_hash` 过期 → `file_changed` + `detail.expected/actual` | 仅 `parse.test.ts:251` 覆盖写窗口复检；工具层三处乐观锁与 `detail` 字段均未断言 | **部分** |
| **I3** | 前缀字节不变 | `run.test.ts:183` 读了 `before`，却在 `:199` 用 `void before;` **丢弃**——字节级断言实际不存在 | **失效** |
| **I7** | 下次 run 走 replay | `run.test.ts:259-282` 只验证"在途失败为 kernel_died"，无"下一次 replay"断言 | **部分** |
| **I9** | restart 后**无任何 cell 被执行** | `kernel.test.ts:155-167` 的用例**自己执行了一个 cell**（`:160` 的 `registry.execCell`）来验证新 kernel 可用——名字承诺的"runs no cells"完全没测，反而与 A14 的判定相反 | **名不副实** |
| **I10** | 并发两个 `notebook_run` → `kernel_busy` | `kernel.test.ts:169-187` 直接调 `registry.execCell`，测不到 run 级交错（见【A6】） | **失真** |
| **I12** | stdout 逐行可解析 | `server.test.ts:303-306` 有 dead variable，**stderr 未断言** | **部分** |
| **I13** | 取消在途同步 run | `server.test.ts:147` 的失败分支恒真 | **失效** |
| **I14** | 取消**在途** edit | `server.test.ts:163-164` 实际是 pre-aborted（不是 in-flight），且绕过了 MCP client | **失真** |
| **I16** | run 终结为 `failed/kernel_died` | `server.test.ts:250` 允许终态为 `completed`；`:265-267` 用区间计数代替集合断言 | **弱化** |
| **I17** | 候选链降级 | `run.test.ts:340-346` 把"能否 import ipykernel"的探针直接 mock 成字符串比较，`.venv` 解释器还是空文件（`:325`）→ **把被测逻辑本身 mock 掉了** | **失真** |

**修复建议**：逐项按"实际"列修正断言；U13/U20 可直接补（纯函数/纯逻辑，无需 kernel）；I9 应改为断言"restart 后 `execution_count` 未变、无新输出"，而不是执行一个 cell 来"证明可用"。

**设计文档对齐**：U13/U20/U12 属**未完成验收**；I3/I7/I9/I12/I13/I14/I16/I17 属**验收失真**（用例存在但不验证 SPEC 的判定）。

---

### 【D5】自证式断言与弱断言

**严重程度**：🟡 警告
**所在位置**：`tests/unit/protocol.test.ts:62`、`tests/unit/atomic.test.ts:125-136`、`tests/unit/outputs.test.ts:176-178`、`tests/unit/log.test.ts:31-38`、`tests/unit/tools-shape.test.ts:117`

**问题描述**：
- `protocol.test.ts:62` 用**实现里的常量** `MAX_LINE_BYTES` 去断言上限——把上限改成 1 MiB 或 1 GiB，测试照样绿；
- `atomic.test.ts:125-136` 用例名说"wx flag"，实际只测并发写；
- `outputs.test.ts:176-178` 用**字面前缀**（`'iVBORw0KGgo'`）检查 base64 泄漏，而 AGENTS.md §6 要求的是"可解码且解码后为 PNG/JPEG 魔数"——换个编码/前缀即漏检；
- `log.test.ts:31-38` 名为"never writes to stdout"，但对 stdout **零断言**，且 `src/log.ts:52` 的 `defaultSink` 全程未被任何测试执行（这正是【A20】同类风险：日志实现本身没有守卫）；
- `tools-shape.test.ts:117` 的 `kind === 'background' || code !== undefined` 是恒真式。

**修复建议**：把常量断言换成**独立字面量**（`64 * 1024 * 1024`）；base64 检查改为解码 + 魔数判定；补充对 `defaultSink` 的 stderr/stdout 定向断言。

**设计文档对齐**：SPEC §10.1 的判定意图被弱化。

---

### 【D6】状态污染与可重复性问题

**严重程度**：🟡 警告
**所在位置**：`tests/integration/run.test.ts:56`、`tests/integration/server.test.ts:45`、`tests/integration/kernel.test.ts:76,200`

**问题描述**：
- 两个文件修改 `process.env.JUPYTER_PATH` 且**不恢复**，污染同进程内其它用例（vitest 默认同文件共享进程，跨文件视配置）；
- `kernel.test.ts:76` 的 `sidecarPids` 只在文件内首次创建时填充——**单独运行 `-t '[I11]'` 时孤儿检查退化为空循环**（假绿）；
- `kernel.test.ts:200` 的 `shutdownAll` 使 `[I11]` 依赖同文件前面的用例，用例不再独立。

**修复建议**：`beforeEach/afterEach` 保存并恢复 env；把 PID 采集放进 `beforeEach`；`[I11]` 自己创建并清理它要检查的进程。

**设计文档对齐**：AGENTS.md §9 要求"测试独立、可重复"；当前不满足"可单独运行"。

---

### 【D7】边界值缺口

**严重程度**：🟡 警告
**所在位置**：见下表

| 边界 | SPEC | 现状 |
|---|---|---|
| `ops` 恰好 32 个 | §4.5「1..32」 | 只测 33 被拒（`tools-shape.test.ts:186`），**无 32 的正例** |
| `ops` 恰好 1 个 | 同上 | 覆盖 ✓ |
| `timeout_seconds` = 1 与 86400 | §4.5 范围 1..86400 | 仅在 `config.test.ts:117-118` 测**拒绝**，工具层正例缺失 |
| `max_images_per_call` 恰好等于上限 | §4.4 | 只有 30 > 20 的用例（`outputs.test.ts:159/172`）；**恰好 20 时应无 `image_limit` 且全部物化**，无用例 |
| NDJSON 恰好 64 MiB | §5.8 | 只有"超过"用例，且用实现常量自证（【D5】） |
| `insert_lines` 的 `at_line=1` / `line_count+1` / 空 cell | §4.5 | 覆盖 ✓（`edit.test.ts:140/152/164`） |
| `nbformat_minor=4` 无 cell id | §4.5/D8 | 覆盖 ✓（`edit.test.ts:295/437/473`） |

**修复建议**：按上表补 4 条边界正例——它们都是"恰好不越界"的情形，是 off-by-one 最常藏身处。

**设计文档对齐**：SPEC §10.1 未显式列出这些边界，属用例设计可补强项。

---

### 【D8】E1–E9 手工验收全部未执行（DoD 未达成）

**严重程度**：🟡 警告
**所在位置**：`docs/E2E-CHECKLIST.md:19-29`

**问题描述**：E1–E9 的"证据"列**九行全空**，而 SPEC §7.3/§10.4 的 DoD 要求"§10.3 全部有截图或日志存档"。

**详细分析**：这不是实现缺陷——checklist 明确写着"由人（boss）执行并留档"，实现者如实标注了状态（值得肯定）。但必须明确：**当前 DoD 未达成**，`pnpm test` 全绿不等于验收完成。尤其 E7/E8/E9（三个真实客户端的接入）是"即插即用"这一核心卖点的唯一证据，而 `docs/COMPATIBILITY.md:5-10` 四个客户端全部标注"未测试"。

**修复建议**：按 E1→E9 顺序执行并留档；建议至少先做 E1（干净机器 ≤60 秒）与 E2（图片进入对话），因为它们同时验证【A2】（环境）与图片链路。

**设计文档对齐**：SPEC §10.3/§10.4 未完成。

---

### 【D9】值得肯定的测试实践（避免只报忧）

**严重程度**：✅ 未发现问题

- **测试编号体系**：`describe('[step4][U2] …')` 的写法让"按 SPEC 编号检索覆盖率"成为可能（174 个 `it` 中 78 个名称直接含编号，其余由 describe 继承；`vitest` 的完整用例名包含 describe，故按编号检索仍可定位）。瑕疵是格式不统一：`kernel.test.ts:85/133/149/155/169` 用 `(I9)` 而非 `[I9]`。
- **单测/集成分离干净**：`vitest.config.ts:5` 只 include `tests/unit`，`vitest.integration.config.ts:5` 只 include `tests/integration`，`pnpm test` 不带 `--config` 因而不触碰 Python，满足"无 Python 也能全绿"（AGENTS.md §3）。
- **真实进程路径有真测**：`[I7]` 真的 `transport.kill()`（`run.test.ts:278`）、`[I11]` 断言无孤儿进程、`[I12]` 用真实 stdio 子进程验证 stdout 纯净——这些用例的形态是对的（问题只在断言细节，见【D4】）。
- **I5 的手法有效**：用 `signal.signal(signal.SIGINT, signal.SIG_IGN)` 构造**不可中断**的 cell 来逼出 `timeout` 分支（`run.test.ts:221`），这比 `while True` 更精确。
- **无 `it.skip`/`only`/`todo`**；仅 2 处运行时 `context.skip`（symlink 用例、非 Windows 的 locked-file 用例），属合理平台分支。
- **临时目录隔离**：各测试文件独立 `mkdtemp` 且前缀不同，未发现共享目录导致的相互污染（仅 `outputs.test.ts:14-22` 泄漏父目录，属轻微）。
- **无机器绝对路径硬编码**：5 个集成文件都从 `import.meta.url`/仓库根推导路径，别人机器可跑。

---

## E 类：设计文档（SPEC）自身的缺陷 —— 实现正确但设计有问题

> 以下三条**不是实现缺陷**：代码忠实执行了 SPEC 的字面要求，但该要求本身会导致不良行为。修 SPEC 而非修代码。

### 【E1】后台执行触发条件使"同步路径"在默认配置下不可达

**严重程度**：🟠 严重（产品行为）
**所在位置**：`src/mcp/tools/run.ts:82`，对应 SPEC D14

**问题描述**：`goesBackground = timeoutSeconds * targetCount > backgroundThresholdSeconds`，默认 `300 × 1 = 300 > 30` → **每一次 `notebook_run` 都返回后台句柄**，模型必须再调 `notebook_run_status` 轮询。

**详细分析**：SPEC D14 的字面表述是「`timeout_seconds × 目标 cell 数 > background_threshold_seconds` → 后台」。用"超时上限"作为"预计耗时"的估计是数量级错误：超时是**上界**，而判定需要的是**期望值**。后果：① §4.7 的同步路径实际上成了死代码；② E1"从零到跑通第一个 cell ≤ 60 秒"变成两次往返；③ 每次简单执行都多一轮 token 与一次工具调用——与 §0 的"不烧 token / 不麻烦"直接冲突。

**修复建议**：把判定改为"显式请求 + 保守估计"，例如：

```ts
const goesBackground = args['run_in_background'] === true            // 显式
  || (targetCount > 1 && timeoutSeconds * targetCount > ctx.config.backgroundThresholdSeconds * 10);
```
或引入一个独立的 `expected_seconds` 参数由模型声明。无论哪种，**默认配置下单个 cell 必须走同步路径**。

**设计文档对齐**：实现符合 SPEC D14 字面；SPEC D14 需修订（建议在 v3.1 里改写判定式并补一条验收用例：默认参数下 `notebook_run` 返回 `kind:"completed"`）。

---

### 【E2】R6 与解释器解析相互矛盾：定位 kernel.json / PATH python 必须读取 root 之外

**严重程度**：🟠 严重（规格内部冲突）
**所在位置**：`src/kernel/interpreter.ts:260-340` 与 SPEC R6

**问题描述**：R6 规定「禁止读写 `root` 之外的文件」，而 §5.2 的解释器解析**必须**读取 root 之外的路径：`~/.local/share/jupyter/kernels/*/kernel.json`、`/usr/share/jupyter/kernels/...`、`$JUPYTER_PATH`、`%APPDATA%\jupyter\kernels`，还要执行 PATH 上的 `python`。

**详细分析**：实现选择了"照 §5.2 做"（`existsSync` + `readFile` 直接读，不经 `PathFence`），这在功能上正确且必要，但**在字面上违反 R6**。这不是小事：R6 与"沙箱式围栏"是用户安全承诺的一部分，规格自相矛盾会让后续维护者不知道该以哪条为准，也可能在未来的安全加固中被错误地"修正"。

**修复建议**：在 SPEC 里明确豁免面（推荐措辞）：「R6 的围栏适用于**用户 notebook 与 artifact/备份**的读写；**解释器与 kernelspec 的只读探测**（§5.2）不受围栏约束，且不得写入这些路径」。实现侧建议把这类探测集中到 `src/kernel/interpreter.ts` 并在文件头注明该豁免，避免审计时误判。

**设计文档对齐**：SPEC R6 与 §5.2 冲突；需修订 SPEC。

---

### 【E3】单行 64 MiB 上限与"每次调用 20 × 20 MiB 图片"的上限自相矛盾

**严重程度**：🟡 警告（规格内部冲突）
**所在位置**：`src/kernel/protocol.ts:30,47-51` vs SPEC §4.4 的 `max_images_per_call`/`max_image_bytes`

**问题描述**：`exec_cell` 的整个响应是**一行 NDJSON**，其中包含所有输出的 base64。SPEC 允许单次调用物化 20 张、每张最大 20 MiB 的图片（≈ 400 MiB 原始 → base64 后 ≈ 533 MiB），远超 64 MiB 的单行上限 → **合法内容会触发协议错误并杀死 sidecar**（`sidecar-transport.ts:193-197` 会 `kill()` 整个 sidecar，连带杀死所有 kernel）。

**详细分析**：一个 cell 打印三张 20 MiB 的图就会越线。此时用户的 kernel 被强杀、本次运行以 `kernel_died` 失败，且失败原因（协议帧过大）对用户完全不可解释。

**修复建议**（择一）：
- (a) 提高上限并把"图片体积预算"纳入判定：`MAX_LINE_BYTES = max(64 MiB, max_images_per_call × max_image_bytes × 1.4 + 8 MiB)`；
- (b) 更稳：把图片改为**分帧传输**（大 payload 拆多行，行首带 `chunkIndex`/`total`），或让 sidecar 在 `exec_cell` 响应里只回图片的占位与字节长度，由 Node 通过单独的 `fetch_output` op 按需拉取；
- (c) 最小改动：把"单次执行的图片总体积"限制为 `min(max_images_per_call × max_image_bytes, 48 MiB)` 并在超限时降级为 artifact-only（追加 warning）。

**设计文档对齐**：SPEC §5.8 的 64 MiB 与 §4.4 的图片上限需一起修订。

---

# 二、总体评估

## 1. 整体质量评级：**C（需返工）**

**为什么不是 B（小修后合并）**：存在 4 项发布前必须闭环的缺陷——【A1】默认配置下的用户数据丢失、【A2】kernel 环境被剥离（自测不可见）、【A3】空闲回收杀死在途 kernel、【C1】发布链可产出空包——以及 12 项 🟠 级问题（含【A6】并发语义、【A7】孤儿 kernel、【B1】模块铁律违反、【B2】偏离未登记、【D1】测试夹具失效）。这些不是格式问题，而是"会伤害用户 / 会阻断发布"的问题。

**为什么不是 D（需重构）**：架构是对的。`core` 完全纯净（零 `node:*`、零 I/O、零时钟/随机数，R11 ✅）、模块边界在 core/fs/kernel 三层上清晰、全仓无运行时循环依赖、35 个错误码与 SPEC §7 完全一致且无自造码、CAS 双锚与原子写 + 备份 + 自校验的落地质量很高（`edit.ts` 的 op 矩阵与 `notebook-file.ts` 的写前复检尤其扎实）、D24"单文本块 + 不用 structuredContent"严格遵守、`symtable` 分析（SPEC §5.6 的 A4/B1/C3c 三项修正）实现正确且有回归用例。**不需要重构，需要的是修 4 个洞 + 补测试 + 关发布链。**

一句话：**骨架是 B/A 级的，地板上有 4 个洞。**

## 2. TOP 3 必须优先修复的问题（按影响排序）

1. **【A1】`clear_outputs_before` 销毁未执行 cell 的既有输出**（🔴）
   默认配置 + 超时/取消即触发，直接抹掉用户 notebook 里的历史输出，且正好发生在产品主打的"长任务"场景。修复是 15 行（把清空移入循环 + 中断时还原），并必须补一条"预置输出 + 超时"的用例（【D1】给了代码）。
2. **【A2】sidecar/kernel 环境被剥离到只剩 2 个变量**（🔴）
   一行改动（`registry.ts` 透传 `env: process.env`），但影响面最广：所有依赖 PATH/HOME/conda 变量的 notebook 行为都与 Jupyter 不一致，而现有测试**结构上无法发现**它。
3. **【A3】空闲回收杀死正在执行 cell 的 kernel**（🔴）
   默认 1 小时阈值 + 60 秒轮询下，任何运行跨过阈值边界的 cell 都会被中途杀掉。修复是 2 行（`if (session.busy) continue;`），并且它与【A2】一样属于"用户会把它当成产品不可靠"的那类缺陷。

> 紧随其后、发布前也必须闭环的是 **【C1】发布链**（🔴 发布维度）：`npx -y ipynb-mcp` 是这个项目唯一的入口，发一个不含 `lib/` 的包等于项目不存在。

## 3. 与原始设计文档的偏离清单

### 3.1 明确违反 SPEC（需修代码）

| # | SPEC 位置 | 偏离 | 严重度 |
|---|---|---|---|
| A1 | §4.7 规则 3、§4.8 规则 2 | 预清空目标 cell 并在中断时写回 | 🔴 |
| A2 | §5.8 启动环境 `{...process.env}` | 未传 `env`，kernel 只拿到 2 个变量 | 🔴 |
| A3 | §5.3「空闲超时」语义 | 忙时也回收 | 🔴 |
| A4 | §4.7 `cells × mode` 矩阵（replay 两行） | replay 复用存活 kernel | 🟠 |
| A5 | §4.3 `image_index` 定义 | 按 cell 重置，跨 cell 冲突 | 🟠 |
| A6 | §10.2 I10 | busy 只覆盖单次 exec，两个 run 可交错 | 🟠 |
| A7 | §5.3「同一键只允许一个 kernel」 | 并发启动产生孤儿 kernel；注释与实现不符 | 🟠 |
| A11 | §4.7 / §7 分工 | 越界选择器报 `invalid_targets` | 🟡 |
| A14 | §4.1.3 绝对路径 | `artifact_path` 可为相对 | 🟡 |
| A18 | §4.9 `alive` 语义 | 报的是 sidecar 存活，`kernel_status` op 无调用者 | 🟡 |
| A19 | §4.6.3 错误映射 | `read_only_mode` 绕过 `isError` 结构化输出 | 🟠 |
| B1 | §3.2 边界表 / AGENTS §4 | `src/mcp/*` 直接 import `node:fs`/`child_process` | 🟠 |
| B2 | §8 文件清单 + AGENTS §0 | `model.ts`/`lock.ts`/`progress.ts` 缺失且未登记 | 🟠 |
| C1 | §8 发布规则 1（R15） | 无产包构建钩子，可发布空包 | 🔴 |
| C4 | §12「原样抄录」 | `OPEN_QUESTIONS.md` 被改写格式；`docs/archive/` 无实体 | 🟡 |
| C6b | D17 | POSIX 下 `--root /` 未被拒绝 | 🟡 |
| C6c | §5.2 | ipykernel 探测 15s（规定 5s） | 🟡 |
| A13 | §9（未规定失败语义） | rename 后 fsyncDir 失败被当作整体失败 | 🟡 |
| A9 | §5.5.6 | `clear_outputs` 可给 markdown cell 写入 `outputs` | 🟡 |
| A8 | §4.1.9 | `index_shifted` 漏报 | 🟡 |
| A10 | §4.7 解析规则 | `'1-2-3'` 静默截断 | 🟡 |
| A17 | §5.9（未要求互斥） | 并发编辑丢改动窗口 | 🟡 |
| C2 | §8 产物可运行 | `lib/bin.js` 无 shebang | 🟡 |
| A15 | §5.1/D17 | 相对 `--root` 使围栏全量误拒 | 🟠 |
| A16 | §5.1 启动校验 | 空环境变量绕过范围校验 | 🟡 |
| A21 | §5.8「单行」64 MiB | 上限作用于累积缓冲区，可误杀健康 sidecar | 🟡 |
| A22 | §5.8 超时语义、R19 | 传输层超时一律报 `kernel_died`，sidecar 仍活、可能留孤儿 kernel | 🟠 |
| A23 | §5.3 退出清理、R19 | 无 `uncaughtException`/`unhandledRejection` 钩子；sidecar 崩溃不杀进程树；致命路径不 `shutdownAll` | 🟠 |
| A24 | R7 | 6 处 catch 只写注释不记 warn（+4 处软违规） | 🟡 |
| A25 | §5.9 净结果 | `.tmp-*` 硬杀残留无清理 | 🟡 |
| A26 | §5.9 幂等 | artifact 半截文件被 `EEXIST` 永久复用 | 🟡 |
| A27 | §9（未涉及） | `rename` 替换权限位（`0600`→`0644`） | 🟡 |
| A29 | §5.9（未定义） | 备份裁剪失败阻塞编辑；同秒命名竞态覆盖 | 🟡 |
| A30 | §5.3「立即关闭」 | `shutdown` 先摘 session 再 await，失败后 kernel 隐形存活 | 🟡 |
| A31 | §4.6.2 / R18 | run 写回与 `readNotebookFile` 未传 abort signal | 🟡 |
| D1 | §10.2 用例设计 | 夹具 `outputs: []` 使"未执行 cell 保持不变"成为空断言 | 🟠 |

### 3.2 未登记的形式偏离（补 `DEVIATIONS.md` 即可，不必改代码）

`core/model.ts`、`fs/lock.ts`、`mcp/progress.ts`（【B2】）、根级 `run.ts`（【B3】）、`src/hash.ts`/`mcp/context.ts`/`mcp/tools/result.ts`/`fs/notebook-file.ts`（【B6】，属合理新增但应登记）。

### 3.3 SPEC 自身需修订（不是实现的问题）

【E1】D14 的后台判定式导致同步路径不可达；【E2】R6 与 §5.2 的解释器探测冲突；【E3】64 MiB 单行上限与 §4.4 图片上限冲突；另建议补强：`clear_outputs` 的 cell 类型约束（A9）、`cells` 解析的两种错误码分界（A11）、POSIX 文件系统根判定（C6b 的测试断言）。

## 4. 后续开发建议

**修完上述后建议按此顺序推进**：

1. **P0：只改测试、不改实现就能堵住的三个盲区**（成本最低、收益最高——它们是"下次同样的 bug 还能溜进来"的入口）：
   - 【D2】给 `analyze` op 补单测（把 symtable 换掉后必须有用例变红）；
   - 【D3】把 U2/U4/U8/U9 提升到工具层（真实临时文件），补齐 `dry_run` 的三条断言与 `backup_path`；
   - 【D1】夹具支持预置输出 + 新增 I18"超时不得清空未执行 cell 的输出"。
2. **P1：补齐缺失/失真的验收用例**：U13、U20、U12（含 `detail.expected/actual`）、多 cell 图片索引、I3（去掉 `void before;`）、I7（补"下一次 replay"）、I9（改为断言 restart 后无 cell 执行）、I10（改走工具层两个并发 `notebook_run`）、I12（补 stderr 断言）、I13/I14（真在途而非 pre-aborted）、I16（终态集合断言而非区间计数）、I17（不要 mock 掉探针本身）。
3. **需要补测的模块**（按风险排序）：
   - `src/run.ts` 的中断/超时写回路径（当前只有 I5 覆盖一半，且被【D1】的夹具削弱）；
   - `src/kernel/registry.ts` 的并发与生命周期（并发 `getOrCreate`、run 级互斥、busy 与 idle 回收的交互）——建议用已存在的可注入时钟 `RegistryOptions.now` 做确定性推进（当前 idle 用例靠 1.5s/6.5s 的真实 `setTimeout` 硬等，既慢又不稳）；
   - `src/mcp/tools/kernel.ts`（`status`/`restart` 在无 kernel 时的分支、run 终结联动）；
   - `src/fs/notebook-file.ts` 的并发写（互斥实现后补两个并发 edit 的用例）。
3. **需要补文档**：`README.md` 的"已知限制"应补两条——(a) 单次执行的图片总体积受 64 MiB 单行上限约束（【E3】）；(b) 同一 notebook 的并发执行当前不受 run 级互斥保护（【A6】修好后删除）。
4. **建议增加监控/可观测性**：`notebook_locked` 与 `kernel_died` 的发生次数应记入 stderr 的 info/warn 日志并带上 kernelId 与 op（当前 `kernel_died` 只在 transport 里记一条 warn，缺少"哪次请求、哪个 op"的上下文，排障困难）。
5. **流程建议**：本次交付暴露的最大流程问题是"**绿灯 ≠ 覆盖**"（【D1】）与"**偏离不登记**"（【B2】）。建议在 AGENTS.md 里补一条硬规则：*新增/修改夹具 helper 时，必须能表达该用例要区分的两种结果*；以及把 DEVIATIONS 的登记纳入每一步的 DoD 勾选项。

---

## 附：七个审查维度的覆盖小结

| 维度 | 结论 | 对应条目 |
|---|---|---|
| 1. 架构与模块对齐 | **有问题**：core/fs/kernel 三层干净无环，但 `mcp/*` 越界、3 个 SPEC 文件缺失未登记、`run.ts` 未定义 | B1–B6、A15 |
| 2. 代码质量与可维护性 | **基本良好**：命名一致、函数职责单一、注释质量高（唯一"说谎的注释"在 registry）；主要问题是 3 处重复实现与 `run.ts` 的归属 | B3、B4、A7 的注释 |
| 3. 健壮性与错误处理 | **有问题**：33 处 catch 全部核对，6 处 R7 违规（仅注释不记日志）；stdio 无 `'error'` 监听可致服务崩溃；备份裁剪失败阻塞编辑；空环境变量绕过校验 | A16、A20、A13、C6f、C6g |
| 4. 性能与资源效率 | **基本良好**：无 O(n²) 热点（`stale.analyzeStale` 的嵌套 `includes` 在 notebook 规模下可忽略）、无 N+1、无阻塞主线程；两处小问题：sidecar 线程表不清理、`kernel.ts` 每次 start 重跑 15s 探测（因缺少缓存适配器） | C6f、B1、A12 |
| 5. 安全性 | **良好**：路径围栏方向正确（realpath + 大小写折叠 + 中间符号链接爬升 + 读写两侧同入口）、无 shell/eval/字符串拼命令、无硬编码凭据、日志不落 cell 内容、base64 不入文本、`--allow-outside-root` 确认为服务级。缺陷是围栏自身的两个边界（相对 root、POSIX 根）与 TOCTOU | A15、C6b、A17 |
| 6. 测试覆盖与自测质量 | **有问题**：编号体系、单测/集成分离、真实进程路径的真测都做得好；但**夹具无法表达失败模式**（【D1】）、**关键模块零单测覆盖**（【D2】symtable 分析器）、**第一卖点无守卫**（【D3】CAS 失败的同义反复 + `dry_run` 无断言）、8 处用例缺失或名不副实（【D4】）、多处自证式/恒真断言（【D5】）、用例不可单独运行（【D6】）、边界正例缺失（【D7】）、E1–E9 全未执行（【D8】） | D1–D9 |
| 7. 依赖与配置 | **良好**：15 个配置项与默认值 100% 对齐（含 3600/300/30）、优先级与退出码正确、无 `prepare`/`postinstall`、`core` 无 node 依赖、`.gitignore` 覆盖到位、CI 矩阵与 SPEC §9 逐格一致；唯一 🔴 是发布链缺 `prepack` | C1–C6、A14、A16 |

**未发现明显问题的子领域**：错误码集合（35 个与 SPEC §7 完全一致、无自造码）、敏感信息与凭据、stdout 纯净性（仅 `--help` 一处，且发生在 server 连接之前）、`core` 的纯度与无环性、D24 响应形状、配置默认值、CI 矩阵、`.gitignore`、原子写与 CAS 的核心逻辑。
