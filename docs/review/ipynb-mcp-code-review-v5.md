# ipynb-mcp 代码审查报告（第五轮 / v5）

> **审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp` @ HEAD `479d787`（`2db2588..HEAD` 的 6 个提交；工作树干净）
> **权威**：`SPEC.md` + `AGENTS.md`（本轮未改动；新增偏离登记 D-032~D-036 已核对）
> **方法**：主审亲跑门禁 + 黑箱真 stdio MCP 会话（`lib/bin.js` + 真实 SDK 客户端 + 真 ipykernel）+ 把仓库自己的新测试当**被测对象**做变异实测 + 用 `nbformat 5.9.2` 与 `nbformat.validator` 当外部权威
> **约束遵守**：全程只写 `%TEMP%`（`C:\Users\Administrator\AppData\Local\Temp\rev5\*`），主仓只读；未运行完整 `pnpm test` / `pnpm test:integration`；唯一的主仓写操作是**临时禁用 lib 闸门做变异实验后立即按字节还原**（`git status` 已确认为空）
> **日期**：2026-10-03

---

## 一、门禁实测（主审亲跑）

| 门禁 | 实测 | 与声明 |
|---|---|---|
| `pnpm typecheck` | exit 0 | ✅ |
| `pnpm lint` | 0 warnings / 0 errors（59 文件 99 规则 + `format check: ok` + `structural indent check: ok`） | ✅ |
| `pnpm smoke`（`scripts/e2e-smoke.mjs --python <anaconda>`） | **11/11 passed** | ✅ |
| `npx vitest run tests/unit/protocol.test.ts` | 10 passed / 172 ms | ✅ |
| 黑箱真 MCP 会话（自写，见 §四） | 23/30（7 条 FAIL 中 5 条是我自己的 op 字段写错，2 条是真发现） | 新增验证 |

---

## 二、总体结论（先给结论）

**前三轮的核心不变量这轮真的成立了**：写回的文件是合法 nbformat（Python 官方校验器实测通过）、分帧器真的线性（64 MiB 单行 **39 ms**，旧实现 1880 ms）、超时真的提前返回（`timeout_seconds=5` 的 `time.sleep` 单元格 **15.3 s** 返回，旧实现 35 s）。**逐条核实，v4 的 FID-1/FID-3/FID-4/FID-5 都是真修复，有变异实验为证。**

本轮的新问题集中在一处：**新的写前闸门"审查范围"过宽，把用户文件里"本来就存在的不合规"当成"我们即将写出的不合规"**，于是整本 notebook 变成只读——一条错误输出就能让**任何**编辑/运行永久失败（GATE-1，🔴）。

以及一条测试可信度问题：本轮新增的**唯一的性能守卫用例在变异下依然全绿**（FRAME-1，🔴，判据来自把原实现直接换成二次实现后用例仍通过）。

---

## 三、本轮发现

### 写前闸门（任务 1、2）

【GATE-1】
严重程度：🔴
位置：`src/core/parse.ts:171-217`（扫描范围 = `doc.cells` 全量）· `src/fs/notebook-file.ts:186`（写前调用）· `src/core/parse.ts:263-276`（`display_data` 强制 `metadata`）
问题描述：闸门校验的是**整份文档**而不是"本次写入的内容"，因此文件里**任何**一处它不认可的历史输出都会让**所有**写入（`notebook_edit` 的每条 op、`notebook_run` 的写回）永久失败于 `selfcheck_failed`——即使用户编的是另一个完全无关的 cell。
详细分析：
1. 触发链：`writeNotebookFile` → `serializeNotebook(notebook)`（序列化整份文档）→ `selfCheckNotebook` → `findStructuralProblem(doc)` 从 `cell 0` 扫到最后。命中即 `throw selfcheck_failed`，**文件不写、模型无路可走**。
2. 实测：一个含 `{"output_type":"display_data","data":{"text/plain":"no metadata"}}`（来自第三方工具/旧版本）的 notebook，编辑 **cell 0**（错误在 cell 1）：
   ```
   FAIL  edit of an unrelated cell (cell 0) is NOT blocked by a quirk in cell 1
         — selfcheck_failed {"problem":{"cell_index":1,"output_index":0,
                            "output_type":"display_data","rule":"output_metadata_missing"}}
   PASS  the file was left byte-identical when the edit failed
   ```
   同一次会话里 `notebook_run` 也失败：`run(cell 2) -> selfcheck_failed`。
3. **变异反证**（证明这就是闸门造成的，且仓内用例不会发现）：临时把 `lib/fs/notebook-file.js` 的 `selfCheckNotebook(serialized, options.hasher);` 注释掉：
   ```
   PASS  edit of an unrelated cell (cell 0) is NOT blocked by a quirk in cell 1 — ok
   INFO  run(cell 2) -> ok
   ```
   随后已按字节还原。
4. 与 §6 R2/AGENTS"不会静默改坏"的关系：**拒绝写入并不违反"不改坏"，但它把"改不了"变成了新的用户态故障**，而且错误码 `selfcheck_failed` 的字面含义（"我们自检失败"）会把责任指向调用方无法修复的地方。
5. 覆盖面：闸门只管写；`notebook_read` 不受影响（仍能读），所以用户看到的是"读得到、改不动"。
修复建议（任一即可，推荐 ①＋③）：
```ts
// ① 只对"本次写入动过的 cell"执行结构规则，其余 cell 只做"我们没让它变坏"的对照
//    run: 传入 executedCellsSet；edit: 传入 changedCells 的索引集合
selfCheckNotebook(serialized, hasher, { strictCellIndexes: touchedIndexes });

// ② 或者在 writeNotebookFile 里做"前后对照"：把写前解析出的 doc 也跑一遍
//    findStructuralProblem，只拒绝"写后才出现"的问题：
const before = findStructuralProblem(originalDoc);
const after = findStructuralProblem(nextDoc);
if (after !== null && JSON.stringify(after) !== JSON.stringify(before)) throw ...

// ③ 预检并告知：写入前若发现文件本身已不合规，返回 warning
//    （既有 warning 通道）而不是把用户永久锁在只读状态。
```
设计文档对齐：D-032 的**意图**（对结果负责）正确，但实现把"结果"扩大成"整份输入"；建议把 D-032 的措辞改成"不得写出**本次写入新引入**的不合规"。

【GATE-2】
严重程度：🟠
位置：`src/core/parse.ts:256-261`（`default: unknown_output_type`）· 对照 `nbformat/validator.py` 的 `_relax_additional_properties` / `_allow_undefined`
问题描述：闸门把 nbformat 4.5 schema 的 `output_type` 四值白名单当成永久真理，而 **nbformat 自己会为"来自未来的 notebook"放宽该约束**，于是 `nbformat.validate` 认为合法的文件被我们拒绝。
详细分析（外部权威实测）：
```
minor6_update_display_data
   nbformat.validator: VALID
   product WRITE GATE: REJECT selfcheck_failed {"problem":{"cell_index":0,"output_index":0,
        "output_type":"update_display_data","rule":"unknown_output_type"}}   <<< FALSE POSITIVE
```
`nbformat_minor >= 6`（或任何高于本地 `nbformat_minor` 的文件）时，`validator.py` 会 `_relax_additional_properties` 并 `_allow_undefined`（把 `unrecognized_output` / `unrecognized_cell` 加进 oneOf），**未知输出类型与未知 cell 类型都是合法的**。我们的闸门不看 `nbformat_minor`，一律按 4.5 白名单拒绝 → 与 GATE-1 叠加后，这类文件同样永久不可写。
附带：同一份实测还发现 `nbformat_minor: 4` 的合法旧文件若带 `id` 会被 nbformat 拒（与闸门无关，仅记录，说明"旧 minor + 新字段"本身就不合法）。
修复建议：`findStructuralProblem(doc)` 先读 `doc.nbformat_minor`；`>= 6`（或 `>= 本地 4.5`）时对未知 `output_type` / 未知 `cell_type` 不判错（与 nbformat 的放宽规则对齐），其余字段级规则保留。
设计文档对齐：D-032 声称"最小的 nbformat 结构规则"，实际比 nbformat 更严；建议在 D-032 里写明"以本地 nbformat 的 validator 语义为准，含它的放宽规则"。

【GATE-3】
严重程度：🟡
位置：`src/core/parse.ts:248-254`（只查 `'execution_count' in record`）· 对照 `nbformat.v4.5.schema.json` 的 `execute_result.required`
问题描述：闸门比 nbformat 宽松的字段没有被覆盖，其中 `execute_result.execution_count` 的类型/取值不校验，`count_no_outputs` / `outputs_missing` / `cell_metadata_missing` 等**真正非法的**文档一律放行（实测：`parse OK / ACCEPT`）。
详细分析：
```
case                        nbformat  parse       WRITE GATE   detail
outputs_missing             INVALID   OK          ACCEPT
cell_metadata_missing       INVALID   OK          ACCEPT
root_metadata_missing       INVALID   OK          ACCEPT
count_no_outputs            INVALID   OK          ACCEPT
```
这说明闸门是"最小集"而不是"合法性判定"，与它在 README（`README.md:79`）中的对外表述"checked against the nbformat structural rules … instead of producing a file Jupyter would refuse"存在落差：**它会拒绝合法文件，也会放行非法文件**。当前写路径不会产出后三类形状，所以危害是"承诺超出能力"而非"已造成损坏"。
修复建议：要么收紧（补 `code_cell` 必备 `metadata`/`source`/`outputs`/`execution_count`，`execute_result.execution_count` 必须是 integer|null），要么把 README 的措辞改成"只覆盖本实现可能写坏的那几条规则"。
设计文档对齐：SPEC §5.5.5（只要求重解析）＋ D-032；建议把闸门的**能力边界**写进 README 与 D-032。

【GATE-4】（阴性结论，明确写出来）
严重程度：—
位置：`tests/unit/edit-tool.test.ts`（FID-4 用例）、`tests/integration/run.test.ts`
问题描述：**该方面未发现问题**——闸门的"可绕过性"实测为空。
证据：黑箱逐 op 实测（真实会话，8 条 op 全部打到写路径）：
```
PASS  op replace_source -> applied, file VALID
PASS  op insert_cell    -> applied, file VALID
PASS  op move_cell      -> applied, file VALID
PASS  op set_cell_type  -> applied, file VALID
PASS  op clear_outputs  -> applied, file VALID
PASS  op delete_cell    -> applied, file VALID
```
（另两条 `replace_lines`/`insert_lines` 的 FAIL 是我自己的 fixture 少给了 `expected_text`/`expected_before`，属我方错误，不是产品缺陷。）全仓写入点只有 `src/mcp/tools/edit.ts:90` 与 `src/run.ts:646,854` 三处，全部经过 `writeNotebookFile` → 闸门；伪造"编辑后非法"（`display_id` 更新产生 `update_display_data`）时**闸门确实拦住**：把 lib 的闸门去掉后该写入立刻变成 `ok` 并落盘非法输出（变异反证）。`dry_run` 不写文件、不经闸门，符合预期。
设计文档对齐：无冲突。

### 分帧器（任务 3）

【FRAME-1】
严重程度：🔴（测试可信度）
位置：`tests/unit/protocol.test.ts:89-116`（`[NEW-3]`）
问题描述：这条"断言算法"的性能守卫**在变异下依然全绿**——它的计数器一次都没有被调用，因此它守不住它声称要守的东西。
详细分析：
1. 根因：`observed` 上的 `indexOf` 是**自有属性**，而喂给 framer 的是 `observed.subarray(...)`；`subarray` 返回的新 Buffer **不继承**父 Buffer 的自有属性：
   ```
   own-property indexOf on the parent  -> calls = 1
   same call through observed.subarray  -> calls = 1 (unchanged means the patch is NOT inherited)
   hasOwnProperty(indexOf) on subarray  = false
   ```
   而 `protocol.ts` 里所有扫描都发生在 `push()` 收到的那个（子）buffer 上 → `inspected` 恒为 0 → `expect(inspected).toBeLessThanOrEqual(cap * 1.1)` 恒真。
2. 变异实测（把 v3 形状的二次实现原样抄进同一用例，输出完全正确所以别的用例也不会红）：
   ```
   ✓ [NEW-3] one 64 MiB line in small chunks costs linear time, not quadratic  (1 test) 44668ms
   QUADRATIC FRAMER: inspected counter = 0; assertion would be inspected <= 73819750.4
   Test Files 1 passed (1)   Tests 1 passed (1)
   ```
   （另一次把规模缩到 1/8，同样 `1 passed`，737 ms。）
3. 后果：commit `db57d5f` 的"the new `[NEW-3]` case asserts the ALGORITHM rather than the wall clock … so a quadratic scan cannot pass on a fast machine"这句**声明不成立**。将来任何一次"顺手改回拼字符串"都不会被这条用例拦住（我的对照实测：同一个二次实现在真机上 64 MiB 要 **44.7 s**，而现在的实现是 **39 ms**）。
修复建议：把计数器挂到真正被调用的那一层，二选一：
```ts
// A. 统计 Buffer.prototype.indexOf 的调用（全局，注意只在本用例内 try/finally 还原）
const original = Buffer.prototype.indexOf;
Buffer.prototype.indexOf = function (value, from) {
  if (this.buffer === observed.buffer) inspected += this.length - (from ?? 0);
  return original.call(this, value, from);
};
try { /* pushes */ } finally { Buffer.prototype.indexOf = original; }

// B. 更稳的版本：直接断言 push 的可见 I/O 复杂度——每次 push 传入的 chunk
//    只应被扫描一次，用计数器统计 push 中 subarray/indexOf 的字节数，
//    并另加一条 wall-clock 上界（例如 64 MiB/16 KiB chunk < 3 s）作为兜底。
```
设计文档对齐：AGENTS §9"不许 mock 掉被测逻辑本身"与 §12"不要为了让测试变绿而放宽断言"的同型问题——这次是"断言看着很硬、实际无判别力"。

【FRAME-2】（阴性结论）
严重程度：—
位置：`src/kernel/protocol.ts:78-126`
问题描述：**该方面（线性与边界）未发现问题**，实测数据如下。
详细分析／证据（`%TEMP%\rev5\framer_probe.mjs`、`framer_perf2.mjs`）：
```
PASS  split line + multiple newlines in one chunk
PASS  CRLF stripped                      ["ab"] ["x","y"]
PASS  empty chunk returns [] / does not disturb pending bytes
PASS  many small lines in one chunk (1.5 MiB > cap) accepted — 200000 lines
PASS  a line of exactly MAX_LINE_BYTES (unterminated across pushes) is accepted
PASS  MAX+1 unterminated rejected with ProtocolFramingError
PASS  over-long COMPLETE line rejected before materialising it — 4.5 ms
INFO  64 MiB single line in 64 KiB chunks: 39 ms，1 MiB chunks: 34 ms，4 MiB chunks: 35 ms
INFO  16 MiB/64 KiB = 24 ms ; 64 MiB/64 KiB = 44 ms ; ratio = 1.85（线性≈4，旧实现 16 MiB 130 ms→64 MiB 1880 ms，ratio 14.5）
INFO  64 MiB of 38-byte lines in 64 KiB chunks: 394 ms, 1767100 lines
INFO  400k alternating partial/full pushes: 140 ms
```
u22 相关边界（恰好上限接受、上限+1 拒绝、多行大块、CRLF、空 chunk、一行跨 chunk 且含多个换行）**全部通过**。`pendingBytes` 与内部 staging 长度一致。

【FRAME-3】
严重程度：🟢
位置：`src/kernel/protocol.ts:78-126`（`push` 抛错时局部 `lines` 被丢弃、`#staging`/`#stagingLength` 不更新）
问题描述：抛 `ProtocolFramingError` 时，(a) 同一 chunk 里**已经解析成功的完整行**被一起丢掉，(b) 帧化器被永久卡死（后续任何 `push` 都会再次抛错），(c) `pendingBytes` 与真实缓冲不一致。
详细分析：生产路径下 `#handleStdout` 收到该异常会立刻 `failAllPending` 并 `kill()`，所以**现网无用户可见后果**；但类本身不再可复用，且丢掉的那一行可能正是"超长响应之前的合法响应"。
证据：
```
threw: ProtocolFramingError
=> valid line A inside the same chunk was DROPPED (never returned to the caller)
tail case threw: ProtocolFramingError | pendingBytes now = 9 (staging still holds the rejected bytes)
```
修复建议：抛错前把 `lines` 交付出去（或改成"返回 `{lines, error}`"），并在抛错时清空 `#staging`/`#stagingLength`，让对象回到干净初态。
设计文档对齐：SPEC §5.8 只规定"超长行是协议错误"，未规定状态复原；建议在注释里写明"抛错后本对象不可再用"（现状是隐式约定）。

### 超时与 sidecar（任务 4）

【TIMEOUT-1】（阴性结论）
严重程度：—
位置：`python/ipynb_sidecar.py:218-220,309-324`（`_drain_iopub`/`_drain_shell`/立即返回）
问题描述：**"已发出的 `execute_reply` 与 iopub 残留会不会污染下一次 `exec_cell`"——实测没有污染**；`_drain_*` + `own(msg)` 机制**足够**。
详细分析／证据：黑箱实测（`%TEMP%\rev5\ops.mjs`）——cell 0 超时（`exec_timeout`），紧接着 cell 1 在**同一 notebook**上运行：
```
INFO  timeout run -> exec_timeout; second run -> completed
INFO  stored execution_counts = [{"id":"s0","ec":null,"outs":[]},{"id":"s1","ec":1,"outs":["execute_result"]}]
PASS  the second run after a timeout stores a sane execution_count — ec=1
PASS  the timed-out cell kept its pre-run state (null, no outputs)
```
第二次运行只拿到自己的输出（无 `starting`/残留流），`execution_count` 从 1 重新计数（新 kernel），超时 cell 在文件里保持 `outputs: [] / execution_count: null`（符合 §4.7 规则 5"半截输出永不写回"）。`own(msg)` 的 `parent_header.msg_id` 过滤确实把上一个 cell 迟到的 iopub 全部丢弃，`_drain_shell` 把迟到的 `execute_reply` 吃掉。**结论：超时后复用 kernel 不会串输出。**
设计文档对齐：SPEC §4.7 规则 5/6；D-033。

【TIMEOUT-2】（阴性结论 + 文档精确性）
严重程度：🟢
位置：`README.md:76-77` · `src/kernel/sidecar-transport.ts:45-46,181`
问题描述：**常量同步这一点未发现问题**（`SIDECAR_INTERRUPT_GRACE_MS = 5_000` 与 `ipynb_sidecar.py:266` 的 `now + 5.0` 一致；实测 `timeout_seconds=5` 的 sleep cell **15.3 s**、`=3` 约 13.3 s、`=2` 约 11.3 s，都落在预算 `timeoutMs+5000+10000` 内 → 稳定报 `exec_timeout`，没有漂移成 `kernel_died`），**但 README 的两句表述与实测不符**：
详细分析／证据：
```
sleep-cell : exec_timeout in 15298 ms (timeout_seconds=5)
busy-cell  : completed    in  6872 ms   ← 纯字节码循环，interrupt 落地
alloc-cell : completed    in  7005 ms
```
- `README.md:76`「A timed-out cell **also ends its kernel** … the next run rebuilds through `replay`」：实测**部分成立**——kernel 确实被关闭（`kernel status` 在超时后立即返回 `kernels: []`、OS 层无残留 pid），但另一个后台线程里的 `shutdown_kernel(now=False)` 会在**cell 自然结束**时才真正完成（日志：`03:27:01.307 kernel shutdown: kernel-1` 发生在 session 已被摘除之后），因此**从超时返回到 kernel 真正消失之间有秒级到分钟级的不确定窗口**：这期间下一次 run 会新建 kernel 并 `replay`（我实测 `MARKER=41` 在 15 s 后仍"存在"是因为 replay 重跑了 cell 0 的 `time.sleep(15)`，而不是同一个 kernel）。建议把"D-025 关闭 kernel"写成"**异步关闭；真正回收 CPU 可能要等该 cell 自然结束**"。
- `README.md:77`「timeout response is still prompt (`timeout_seconds` plus a few seconds)」：实测是 `timeout_seconds + 10.3 s`（sleep cell）。对 2 s 的预算，用户拿到答案要 11.3 s。建议改成"`timeout_seconds` 加约 5 s 中断宽限，再加重建/收尾开销，实测约 +10 s"。
修复建议：改 README 两句；顺带在 D-033 里补一句"关闭与返回解耦，回收是异步的"。
设计文档对齐：D-025 / D-033 的**意图**都对，文档精度需要与实现对齐（AGENTS §8"不许宣称完成"的同型要求）。

### 测试基建（任务 5）

【TEST-1】
严重程度：🟠
位置：`tests/integration/fixtures-valid.test.ts:26-59`（`FIXTURES` 只有 2 本）
问题描述："**every** notebook fixture the integration suite writes"这句话是**硬编码清单**，而集成套件实际有 6 个文件（含 `run.test.ts` 的 `[I18b]`/`[ROB-8]` 等自有 fixture）。
详细分析：`fixtures-valid.test.ts` 只覆盖两本手写 notebook；同目录 `run.test.ts`、`server.test.ts`、`stale.test.ts`、`kernel.test.ts` 里的 fixture 若漂移回不合规形状，只有"`kernelspec` 必须带 `display_name`"这一条静态检查能兜（`fixtures-valid.test.ts:118-153`，用正则扫 `tests/**/*.ts`）。静态检查本身有效（它是真扫文件的），但它只查一个字段，注释里"every .ipynb literal"的说法比实际能力大。
修复建议：把该用例改成"从 `tests/integration/*.ts` 里提取所有 `nbformat: 4` 字面量"（或用 `[FID-4]` 那种"每个 fixture 都过一次 `validateNotebook`"的循环），或者把断言名从 `every notebook fixture` 改成 `these two representative fixtures`。
设计文档对齐：AGENTS §9（新增行为必须有用例）＋ §12（不许放宽断言）。

【TEST-2】（正面记录，应记功）
严重程度：—
位置：`tests/integration/nbformat-validator.ts`（全文 43 行）
问题描述：**"是不是假校验"——实测是真校验**，有判别力。
证据（`%TEMP%\rev5\validator_probe.mjs`，直接调用仓库的 `validateNotebook`）：
```
bad_root_extra         ok=false  NotebookValidationError ...
bad_protocol_shape     ok=false  NotebookValidationError ...   ← 就是 FID-1 的形状，能被抓到
bad_output_extra       ok=false
bad_missing_outputs    ok=false
bad_not_json           ok=false  (parse_json)
good                   ok=true   nbformat.validate passed
nbformatAvailable: true
```
唯一的语义细节：它用 `nbformat.read(as_version=4)` 后再 `validate(nb)`，所以校验的是**升级后的对象**（`nbformat_minor<5` 的文件会被补 id 后校验）；对"写出方向"的守护是等价的（我们写出的都是 4.5），但注释里"checks the file's OWN nbformat major.minor"不完全准确。
设计文档对齐：v4 TST-A 建议 ①，已落实。

【TEST-3】（正面记录）
严重程度：—
位置：`tests/unit/atomic.test.ts:173-232`（两条 `[W1]`）
问题描述：**新增用例有判别力**，实测：真代码 + 注入 no-op sleep → `attempts=9`、`notebook_locked`；真代码 + 真实时钟 → `attempts=9, elapsed=827 ms`（与 750 ms 窗口一致）。把 retry 去掉（`renameWithLockRetry` 首次失败即抛）会让第一条（`attempts === 4`）立刻变红 → 该用例守得住 D-035。
细节提示：第二条的 `attempts === 9` 走的是"延迟数组耗尽"分支（注入 sleep 不推进 `Date.now()`），而生产走的是"deadline 到"分支——两者都得到 9，所以断言仍真实，但注释里的"the full delay schedule plus the failing attempt"只描述了前者。
设计文档对齐：D-035；SPEC §4.6/D12。

【TEST-4】（正面记录）
严重程度：—
位置：`scripts/check-indent.mjs`（新增 154 行）
问题描述：**该守卫管用**，用 AST 判定，实测 4/4 命中我构造的"整块浅一级"（含 try 体、箭头函数内的 try、if 体、class 方法体、for-of 体），干净样本不误报。
设计文档对齐：v4 QUAL-1 的方法学要求（"格式类问题必须用解析器扫"）。

【SMOKE-1】
严重程度：🟡
位置：`scripts/e2e-smoke.mjs`（全文）· `README.md:79`（把它当"re-checks a real run with Python's own nbformat.validate"的对外证据）
问题描述：smoke 脚本本身**没有把产品 bug 当预期**（它 11/11 全绿且我独立复跑一致），但它的覆盖留下三个缺口，容易被当成"E2E 已验证"。
详细分析（实测 + 逐行核对）：
1. **不测 edit**：全程 `notebook_read` → `notebook_run` → 读回，`notebook_edit` 一次都没调用（GATE-1 这类"编辑被闸门挡住"的故障它看不见）。
2. **不测超时/kernel 关闭/无残留**：没有 `timeout_seconds` 用例，结束时只 `client.close()`；我自己的黑箱会话补了这段并确认无残留（见 §四）。
3. **round-trip 断言偏弱**：`outputs.length >= 2`（计数）而不是"写进去的文本能读回来"；`notebook_read can read back the outputs it wrote — outputs=2` 对"内容错了但条数对"是绿的。
修复建议：加一条 edit op（含 `expected_text`）+ 一条 `timeout_seconds=2` 的 `time.sleep` cell 断言 `exec_timeout`，round-trip 改成 `expect(JSON.stringify(cellOutputs)).toContain('hello')`。
设计文档对齐：v4 TST-B 的建议已落实一半。

### 其它新引入问题（任务 6）

【MISC-1】（阴性结论，逐项）
严重程度：—
位置：`src/fs/atomic.ts:32-34,61-95,210-229`、`src/mcp/tools/run.ts:19-35,70-76`、`python/ipynb_sidecar.py:158-163`
问题描述：**以下方面实测/核对未发现问题**：
- **日志泄漏 cell 内容（SPEC §5.10）**：`src/**` 的 `console.*` 命中数 **0**；两次黑箱会话把 `notebook_run` 的 stderr 全量抓下来搜 `hello world` / `starting` / `AFTER` / cell 源码，命中 **0**。
- **重试窗口与文档一致**：`renameWithLockRetry` 的延迟序列 10/20/40/80/120/160/160/160 ms，实测生产路径 `elapsed=827 ms, notebook_locked`，与 README「about 0.75 s」和 D-035 一致；`stat`/`readdir` 失败只 warn 不阻断写入（R7 满足）。
- **`cell_selector` 上限（+20 行）**：`MAX_SELECTOR_LENGTH=4096` 在解析前生效，拒绝文案不回显值（`length`/`max` 进 detail），与 SPEC §4.1.12 的意图一致；`cell_indexes` 侧 `MAX_INDEX_ARRAY_LENGTH=1000` 仍在。
- **无孤儿**：一次完整会话（run → status → shutdown → close）后 `%TEMP%` 新增连接文件 **0**、新增 `python.exe` **0**；新建的连接文件是 D-034 的 `mkstemp` 命名（`ipynb-mcp-kernel-1-<pid>-<rand>.json`），不是可预测名。
- **`#norm` 记忆化（db57d5f 顺带）**：单条目缓存 + 会话移除时失效，行为与 D-026 一致；只是"用每个拼写字符串做 key"意味着不同拼写仍会各解析一次，且 `#removeSession` 里的二次 `normalizeForCompare` 是冗余的（无害）。

【MISC-2】
严重程度：🟢
位置：`src/mcp/tools/run.ts:69`（注释写 "review v4 NEW-3"）· `src/kernel/protocol.ts:63-69`（"a 64 MiB payload of small lines … took 27 s" 的描述）
问题描述：两处注释与事实不符：① `cell_selector` 长度上限对应的是 v4 的 **NEW-2**（v4 报告里 NEW-3 是分帧的 O(L²) 残留，已在本轮被 `db57d5f` 修掉）；② "复用缓冲前每次分配"的 27 s 叙述属于**未发布的中间设计**，读者无法在任何历史提交里找到它。
修复建议：改注释指向正确的编号；把 27 s 那句改成"早期草稿实测"，或直接删除（AGENTS §5：注释只写"为什么"）。
设计文档对齐：AGENTS §2/§5 文档一致性。

【MISC-3】
严重程度：🟢
位置：`src/kernel/registry.ts:134-150,704-716`（`#normCache`）
问题描述：记忆化以"原始拼写"为 key，`#removeSession` 只删掉能匹配该 session `notebookPath` 的条目；同一文件的其他拼写会留下**陈旧映射**（`realpath` 结果在符号链接/文件被替换后会变）。
详细分析：D-026 的语义是"所有拼写共享一个 kernel"，陈旧映射在该语义下**目前无害**（最坏是多一次 `realpathSync`），但如果文件在会话之间被替换成指向别处的链接，陈旧的 `normalized` 可能让两个不同身份碰撞/漏配。无实测复现（需要 symlink 重建时序），记录为待观察。
修复建议：把缓存值改成 `{ source: notebookPath, normalized }`，`#removeSession` 直接按 `session.notebookPath` 删除即可；或干脆缓存 `canonicalPath` 的结果而不是最终字符串。
设计文档对齐：D-026 的意图不变，属实现细节。

---

## 四、黑箱独立验证（任务 7）

**设置**：`%TEMP%\rev5\blackbox.mjs`：`spawn(node, [E:\Work\ipynb-mcp\ipynb-mcp\lib\bin.js, --root <临时工作区>, --python E:\tool\anaconda\ana\python.exe, --log-level debug])`，用仓库 `node_modules` 里 `@modelcontextprotocol/sdk@1.31.0` 的 `Client` + `StdioClientTransport`（绝对 `file://` 导入）当真客户端。3 本现场生成的 notebook（含 markdown/raw cell、`execute_result`、`stream`）+ 1 本"带历史不合规输出"的 notebook + 1 本超时 notebook。

**结果（23/30；7 条 FAIL 中 5 条是我自己的 op 字段写错，已在 §三 GATE-4 说明）**：
```
PASS  six tools are advertised
INFO  notebook_read advertised additionalProperties = true      ← 见下"预期 X 实际 Y"
INFO  notebook_run.mode schema = {"type":"string","enum":["auto","resume","replay","full"],...}
INFO  notebook_run.timeout_seconds schema = {"type":"integer",...}
PASS  unknown argument rejected by the TOOL layer as invalid_arguments
PASS  dry_run edit ... / PASS  a CAS-anchored edit applies
PASS  file after EDIT passes nbformat.validate — VALID 5
PASS  notebook_run completes / write_back.performed is true
PASS  file after RUN passes nbformat.validate — VALID 5
PASS  stream output is nbformat-shaped — [{"output_type":"stream","name":"stdout","text":"hello\n"}]
PASS  execute_result carries execution_count — [{"output_type":"execute_result","data":{...},"metadata":{},"execution_count":2}]
PASS  markdown/raw cells kept no outputs/execution_count
PASS  round trip: read returns the text that was written
PASS  kernel status reports a live kernel after the run — pid 20372
PASS  a timed-out cell reports exec_timeout
PASS  kernel status call succeeds after a timeout
PASS  a cell runs normally AFTER a timeout on the same notebook
PASS  notebook C passes nbformat.validate after the timeout run
PASS  kernel shutdown succeeds / no kernel is reported for A after shutdown
PASS  no connection files left in %TEMP% by this session (159 → 159)
PASS  no kernel process survived the session — []
PASS  stderr carries no cell source/output content — []
```
**"我预期 X，实际 Y"清单（三条，全部已并入上文编号）**：
1. 预期：闸门只影响我们改动的 cell → 实际：文件里任何一处的历史不合规都会让**所有**编辑失败（GATE-1）。
2. 预期：`server.ts:37-41` 注释称"advertised schema still says `additionalProperties: false`" → 实际：客户端 `tools/list` 看到的是 **`additionalProperties: true`**（zod `.passthrough()` 推导即如此）。行为上没问题（未知键仍被工具层以 `invalid_arguments` 拒绝），但**注释与注释所辩护的那句话都错了**，而这句注释正是 v4 NEW-1 的取舍依据。
3. 预期（README）：超时响应"`timeout_seconds` 加几秒" → 实际：`timeout_seconds + 10.3 s`（TIMEOUT-2）。

**残留检查**：会话结束后工作区只有 `*.ipynb` 与 `*.ipynb.bak`（备份是设计行为）；`%TEMP%` 无新增连接文件；`python.exe` 无新增进程；`%TEMP%` 里那 29 个历史连接文件的时间戳跨全天（3:53–11:32），是历次硬杀/脏退出的累积（D-023 已登记），我这次会话**没有**新增。

---

## 五、最值得优先修的三条

| # | 问题 | 为什么优先 | 修复量 |
|---|---|---|---|
| 1 | **GATE-1**（闸门审整份文档 → 一处历史不合规让整本 notebook 永久只读） | 唯一会"让用户完全无法工作"的新缺陷；与产品承诺"安全地编辑本地 notebook"直接冲突；触发条件是真实文件的常态（第三方工具写的 `display_data` 缺 `metadata`、`update_display_data`） | 小（把校验范围收窄到本次写入的 cell，或改做写前/写后对照） |
| 2 | **FRAME-1**（`[NEW-3]` 计数器恒为 0 → 性能守卫无判别力） | 它是本轮唯一的 O(L²) 回归守卫，且 commit 与 README 都以它为证；真回到二次实现时 64 MiB 要 44.7 s，而测试会全绿 | 极小（改挂 `Buffer.prototype.indexOf` 或改用可见 I/O 计数） |
| 3 | **GATE-2 / GATE-3**（闸门比 nbformat 严的地方误伤 `nbformat_minor>=6`，比 nbformat 松的地方放行真非法文档） | 同一个闸门的两个方向都有问题：一边误伤合法文件（与 GATE-1 叠加成永久只读），一边让 README 的"validated before it lands"承诺超出实际能力 | 小（按 `nbformat_minor` 对齐 nbformat 的放宽规则；或把承诺改小） |

紧随其后：**TIMEOUT-2**（README 两句与实测不符：kernel 关闭是异步的、超时返回是 +10 s 而非"几秒"）、**TEST-1**（"every fixture"名不副实）、**SMOKE-1**（smoke 不覆盖 edit/超时/无残留）、**MISC-2**（注释里的错误编号）、**MISC-3**（`#normCache` 陈旧条目）。

## 六、一句话总评

**这一轮把"不会静默改坏"真正做实了（写回文件经 Python 官方校验器实测合法、分帧真的线性、超时真的提前返回，v4 的 🔴/🟠 逐条有变异证据），但新加的写前闸门把"严格"用错了地方——它审的是整份用户文件而不是本次写入，于是把"不合规的历史内容"升级成"整本 notebook 永久只读"；同时本轮唯一的性能守卫用例实际没有判别力，建议连同闸门范围一起收窄后再谈验收。**

---

## 附录：本轮验证手段与局限

- **亲跑**：`pnpm typecheck`、`pnpm lint`、`pnpm smoke`、`npx vitest run tests/unit/protocol.test.ts`；4 个黑箱真会话（happy path / 历史不合规文件 / 超时与规则 6 / 残留与孤儿）。
- **外部权威**：`nbformat 5.9.2`（`validate` 与 `nbformat.validator.validate(version=4, version_minor=N)`）判定每个构造样本；`gate_probe.mjs` 把闸门判决与 nbformat 判决逐行对照（20 个边界样本，含多行 `stream.text` 数组、`execute_result.execution_count=null`、`error.traceback=[]`、`raw` cell、`nbformat_minor 0/4`、额外字段、缺失 `outputs`/`metadata`、2 MiB base64 图）。
- **变异反证**：临时禁用 `lib/fs/notebook-file.js` 的闸门调用（已按字节还原，`git status` 空）；把 v3 的二次分帧实现抄进 `[NEW-3]` 用例；用真代码 + 注入/no-op sleep 复跑 `[W1]`；`scripts/check-indent.mjs` 对 6 个构造文件。
- **局限**：① 只跑 Windows（Node 26.7.0 / Python 3.10.14 anaconda），未验 Linux/macOS；② 未运行完整 `pnpm test` / `pnpm test:integration`（主控在跑），因此"本轮未发现"只覆盖我实测到的面；③ GATE-1 的"历史不合规文件"是我构造的（`display_data` 缺 `metadata`、`nbformat_minor>=6` 的未知输出类型），真实语料里最常见的同类形状还需在更大样本上量化；④ 规则 6 的"异步关闭窗口"只做到日志级证据（shutdown 日志早于 kernel 真正消失），未逐毫秒刻画上界。
