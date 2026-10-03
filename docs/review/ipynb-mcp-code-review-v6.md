# ipynb-mcp 代码审查报告（第六轮 / v6）

> **审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp` @ HEAD `c43c0af`（v5 整改后，5 个提交 / 19 文件 / +995 −100；工作树干净）
> **上轮基线**：`479d787`（v5 报告已归档为 `docs/review/ipynb-mcp-code-review-v5.md`）
> **权威**：`SPEC.md` + `AGENTS.md`（本轮未改 SPEC ✓，AGENTS §9 新增"守卫必须自证可失败"规则；新增偏离 **D-037**）
> **方法**：主审亲跑门禁 + **用抓到 GATE-1 的同一复现复验** + 三条 scope 语义对抗测试 + GATE-2/GATE-3 与 `nbformat.validate` 逐条对照 + 两路独立复核（FID 深度核实 / 新问题猎取）
> **日期**：2026-10-03

---

## 一、门禁实测（主审亲跑）

| 门禁 | 实测 | 备注 |
|---|---|---|
| `pnpm typecheck` | exit 0 | ✅ |
| `pnpm lint` | 0 警（59 文件 99 规则）+ `format check: ok` + `structural indent check: ok` | ✅ |
| `pnpm test` | **232 passed + 1 skipped（233）** | ✅（上轮 227） |
| `pnpm test:integration` | **44 passed / 44**，6 文件，213.7 s，`VITEST_EXIT=0` | ✅ |
| **`pnpm smoke`** | **18/18 checks passed** | ✅ 11→18，断言强度显著提升（见下） |
| `pnpm build` | exit 0 | ✅ |

**smoke 的 18 项里有 5 项是上轮缺失的关键能力**：`notebook_edit`（此前**从未被 smoke 调用过**，所以"编辑被闸门挡住"这类故障它看不见）、`timeout_seconds=2` 的超时用例（断言 `exec_timeout` + **响应及时**（实测 10182 ms）+ 该 cell 保持运行前状态）、**内容级** round-trip（原先只数条数）、`kernel shutdown` 后无残留、以及原有的 `nbformat.validate`。

---

## 二、v5 问题闭环核查

### 2.1 ✅ 真修复（主审亲验）

| v5 项 | 证据 |
|---|---|
| **GATE-1**（🔴 闸门审整份文档 → 整本永久只读） | **用同一复现复跑**（含第三方 `display_data` 缺 `metadata` 的文件）：`notebook_edit` 改**无关** cell → `isError=false applied=1`，并返回 `warnings=[{code:'notebook_preexisting_content', message:'… (output_metadata_missing at cell 1); it was left untouched and the requested change was applied'}]` ✓；盘上历史输出**原样保留** ✓。另测 scope 语义四条全部符合 D-037 的设计：改无关 cell ✅+警告 / 改**那个有问题**的 cell ⛔`selfcheck_failed`（它的瑕疵会被带下去）/ 改合法 cell ✅+警告 / 对问题 cell 做 `clear_outputs`（**消除**问题）✅ 且不惩罚。`notebook_run` 路径同样放行（`status=ok`、`write_back.performed=true`）。README:78 措辞同步收窄为"for the cells the write touches" ✓ |
| **GATE-2**（闸门比 nbformat 严） | 与官方校验器**逐条对照**：`minor=6` + `update_display_data` → nbformat 判 **VALID**，闸门两次编辑均成功且**无警告** ✓；`minor=5` + 同一形状 → nbformat 判 INVALID，闸门"无关 cell 给警告、该 cell 自身拒绝（`unknown_output_type`）" ✓ |
| **GATE-3**（比 nbformat 松） | `execute_result.execution_count="3"` → nbformat 判 INVALID（`'3' is not of type 'integer'`），闸门拒绝并给出精确规则 `execute_result_execution_count_not_an_integer` ✓ |
| **FRAME-1**（🔴 守卫恒真） | 用例已改为包装 **`Buffer.prototype.indexOf`**（子 Buffer 可继承 ✓，`try/finally` 还原），并加 `expect(calls).toBeGreaterThan(0)`；CHANGELOG/状态表**如实记录了旧版为何恒真**（"计数器一次都没被调用…二次实现 36 s 也能全绿"），并给出变异证据（`expected 35988 to be less than 5000`）✓ |
| **TIMEOUT-2**（README 与实测不符） | README 已订正为：关闭 kernel 是**异步**的（响应先返回，进程可能要到被打断的 cell 自然结束才消失）、超时响应是 `timeout_seconds` + **约 10 s**（实测 2 s 预算 → 10.2 s）；D-033 补记"关闭与返回解耦" ✓ |
| **SMOKE-1** | smoke 11 → **18**（见 §一），我亲跑 18/18 ✓ |
| **TEST-1**（`fixtures-valid` 的 "every fixture" 名不副实） | 文件改为如实分层：代表性字面量 + 一条**只保证 kernelspec 有 `display_name`** 的静态扫描，并写明"半吊子提取器只会制造同一种虚假信心" ✓ 诚实 |
| **MISC-2 / MISC-3** | `cell_selector` 上限的编号注释改正；`#normCache` 的失效改为按**规范化值**匹配（此前按字面拼写，留陈旧映射）✓ |
| **FRAME-3**（分帧抛错后卡死，来自上一路复核的 🟢） | 已修：状态复位、`pendingBytes` 不再说谎、对象可复用 ✓ |
| **架构/流程** | 新增 **D-037**（收窄 D-032）条条对应真实代码；**AGENTS §9 新增规则**："新增/修改任何守卫型断言时，必须能指出在什么变异下它会红" ✓ 这是本轮最有价值的产出 |

### 2.2 ❌ 未修（且**本轮状态表未列**，见 §三 DOC-DROP）

| v5 项 | 主审复核证据 |
|---|---|
| **INDENT-HOLE**（🟠，我 v5 的 TOP-3 #3） | `scripts/check-indent.mjs:130` **仍是 `node.statement`**（TS 的 `IfStatement` 只有 `thenStatement`）→ 实测"`if` 体整段浅一级"依旧 `structural indent check: ok`、**exit 0**；该脚本本轮**不在 diff 里**（未被修改）。子代理的**逐构造隔离矩阵**给出了完整覆盖表：✅ try/catch/finally 体、while/do/for/for-in/for-of 体、function/method 体、顶层语句；❌ **if 体、else 体、箭头函数体、函数表达式体、switch、类属性初始化器**。**顺带更正 v5 记录的"该守卫 4/4 命中（含 if 体）"**——那次多半是外层 try/for 代为命中，属假阳性；脚本是 `.mjs`、不进 `tsconfig`，所以这个属性名笔误永远不会被类型检查抓到 |
| **NEW5-REPRO**（🟠，已复现的 §4.8 契约违反） | `src/mcp/tools/run.ts:232` 仍是无条件 `handle.state = 'completed'`（没有 `if (handle.state === 'running')` 收口）；`:210` 的 `progress` 仍不在 `finally` 里收口。**子代理真 kernel 复测**：后台 run 终态 `state=completed` 但 `progress={completed:0,total:1}`、`executed=1`——机制是进度事件在**每个 cell 执行前**发出（`src/run.ts:401`），所以 `completed` **永远追不上** `total`；取消竞争跑了一轮 16 次轮询没翻转，但 `src/run.ts:550` 到 `tools/run.ts:232` 之间确实没有二次 abort/状态检查（写回被跳过时中间夹着整个 stale 分析 RPC） |
| **TST-CI**（🟠，用例全绿但 exit 1） | `tests/integration/run.test.ts:458` 仍是先 `await transport.kill()` 后挂 `expect(inflight).rejects…`；该文件本轮未改。**子代理复测 6 次（`-t "I7"` ×5 + 整文件 ×1）全部 exit 0 / 无 Errors**，但 worktree 里一次"全 6 文件"跑出现过 1 次 unhandled error 且 vitest 归因到该用例 → **间歇性**，机制仍在（我的整文件/全量跑也一直 exit 0） |
| **NBFORMAT-GATE-SILENT**（🟠） | `run.test.ts:863/:891` 仍是 `if (NBFORMAT_AVAILABLE) { … }`——nbformat 不可用时 `[FID-1]/[FID-3]` 的校验断言**静默消失**，无 skip 记号 |
| **NEW-2 分工漂移**（🟠） | `src/server.ts` 本轮未改：`mode` 仍是 schema enum → 值级违规仍返回协议错误 -32602（与 D-024/状态表口径相反），`include_source`/`include_outputs`/`action` 仍缺 enum |
| **NEW-6**（🟠） | `src/kernel/sidecar-transport.ts` 的 `#failureDetail()` 仍把"最近 20 行 stderr"挂到任意失败上。**子代理补充**：本轮只修了"sidecar 活着时自报错误"这一支；**超时路径**（`sidecar-transport.ts:354-362`）仍无条件附 stderr 尾巴，且该路径**零测试覆盖** |
| **TST-2 / TST-3 / TST-4 / TST-5**（🟠/🟡） | `acquireRun` 调用点仍零覆盖；`[I18b]` 仍单 cell、工具层 `markdown_invalid` 真写守卫仍缺；DEVIATIONS 仍无"测试编号体系"条目；U20 的 venv 仍建在仓库内 `tests/.venv-test` 且不清理，单测 config 仍缺 `fileParallelism:false` |
| **DEP-2 / QUAL-2**（🟡，且旧 ✅ 未撤） | `src/server.ts:48` 仍硬编码 `version:'0.1.0'`（全仓无代码读 `package.json`）；`edit.ts:26 isAbortCause` 与 `run.ts:797 isAbortError` 仍是**两份逐字同构** |
| **FID-6 收尾**（🟡） | `src/kernel/sidecar-transport.ts:175/180` 仍写着旧公式 `timeoutMs + INTERRUPT_GRACE + SHELL_REPLY_BUDGET` 与 `INVARIANT`，与已收缩的常量（`:46`）自相矛盾；`python/ipynb_sidecar.py:325` 成功路径的 `+30 s` 仍未并入任何常量；**D-033 仍写"超时在 timeoutMs + 约 5 s 内返回"**（README 已改为 +about 10 s ✅），而实测 2 s 预算端到端 **12402 ms = +10.4 s** |

---

## 三、本轮新发现

【GATE-5】
严重程度：🔴 阻塞
所在位置：`src/core/parse.ts:356-369`（`dataProblem` 只查 `data`/`metadata` "是不是对象"）· `src/core/outputs.ts:126-160`（转换器原样搬运 `data`）· `src/run.ts:522`
问题描述：闸门**不校验 mime 值的类型**，于是 kernel 自己送来的非字符串 mime 值被原样写回，落盘一个 `nbformat.validate` 拒绝的文件，而工具报 `write_back.performed: true` 且**无任何 warning**。
详细分析（**主审用真 kernel 独立复现**）：触发条件是**普通用户 cell 的内容**，不需要任何工具异常：
```
cell: from IPython.display import display / display({'text/plain': 5}, raw=True)
run: isError=false status=ok write_back={"performed":true,"backup_path":"…bak"} warnings=[]
盘上: [{"output_type":"display_data","data":{"text/plain":5},"metadata":{}}]
nbformat.validate → INVALID: 5 is not valid under any of the given schemas
```
这正是 **FID-1 那一类"静默改坏"**（而且是产品第一承诺），只是入口从"字段名"换成了"值的类型"。v5 的 GATE-3 曾判断"当前写路径产不出这些形状，危害只是承诺超出能力"——**本轮实测推翻了该前提**。同一根因还有第二个方向：对**已存在**的该形状，`notebook_edit`/`notebook_read` 既不拒也不警告（`warnings: []`），模型被明确告知"文件是干净的"。子代理的 80 样本对照另列出同族漏检：`data` 值为数字/混合数组、`stream.text` 元素非字符串、`error.traceback` 元素非字符串、负数 `execution_count`（schema `minimum: 0`）。
修复建议（十几行纯逻辑）：
```ts
// dataProblem 内，替换 "data 是不是对象" 之后的那一条
for (const [mime, value] of Object.entries(data)) {
  if (/^application\/(.*\+)?json$/.test(mime)) continue;            // nbformat 允许任意类型
  if (typeof value === 'string') continue;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) continue;
  return { ...where, rule: 'output_data_value_not_a_string', mime };
}
// 同批：stream.text 的元素、error.traceback 的元素也必须是 string（现在只查 Array.isArray）
```
设计文档对齐：D-032/D-037「只判本地 schema 能判定的形状」+ SPEC §6 R2 / AGENTS §1「不会静默改坏」；`README.md:78`（本轮刚写的"Every write is validated before it lands…"）被本实测**直接违反**。

【CRASH-1】
严重程度：🟠 严重
所在位置：`src/core/outputs.ts:249`（`data[imageMediaType] ?? ''` 不做类型窄化）→ `:255/:264` → `:357`（`base64.replace`）
问题描述：非字符串的图片 mime 值让 `notebook_run` 以 `internal` + `TypeError` 中止整次运行。
详细分析（**主审独立复现**）：
```
cell: display({'image/png': 123}, raw=True)
run: isError=true code=internal detail={"error":"TypeError: base64.replace is not a function"}
（后续 cell 未执行、无 write_back）
```
`?? ''` 只挡 `null/undefined`；`approximateBase64Bytes(123)` 因 `base64.length === undefined` 直接返回 0 从而绕过大小检查，随后 `decodeBase64` 抛错并被兜底成 `internal`。`internal` 不在 SPEC §4.8 给 `notebook_run` 列的码里，且这条路径由**用户 cell 内容**触发；读方向有 `dataValueToString` 兜底（`outputs.ts:77-86`），执行方向没有。与 GATE-5 同根因（"值类型未窄化"）。
修复建议：`const raw = data[imageMediaType]; const base64 = typeof raw === 'string' ? raw : '';` → 非字符串走既有的 `image_materialize_failed` 分支。
设计文档对齐：SPEC §4.4 的 `image_materialize_failed` 才是该路径的既定出口；§7 的 `internal` 是"其他未归类故障"，不该由 notebook 内容触发。

【GATE-6】
严重程度：🟠 严重
所在位置：`src/core/parse.ts:312-315`（`stream_name_invalid`）
问题描述：闸门要求 `stream.name ∈ {stdout, stderr}`，而 nbformat 4.5 schema 里它只是 `{"type":"string"}`（无 enum）→ **闸门拒了权威接受的文件**。
详细分析（**主审独立复现**）：这是"拒绝写入"方向的误判，后果与 GATE-1 同类但缩到单个 cell：该 cell **永久不可编辑**（只剩破坏性的 `clear_outputs` 能逃）。
```
文件含 {"output_type":"stream","name":"foo","text":"x\n"}
nbformat.validate → VALID
改无关 cell → 成功 + warning；改该 cell 自身 → selfcheck_failed rule=stream_name_invalid
```
D-037 明写「判据以 nbformat 的 validator 语义为准，含它的放宽规则」，而这条规则既不在 schema 也不是 validator 行为，是本仓自加的启发式。子代理隔离矩阵另测 `name=""`、`name="STDOUT"` 同样被拒而 nbformat 均判 VALID。
修复建议：`if (typeof record['name'] !== 'string') { … 'stream_name_not_a_string' }`；stdout/stderr 的归一化已在 `nbformatOutputsOfRaw`（`outputs.ts:135`）里做过，闸门不需要再管。
设计文档对齐：D-037 + AGENTS §9 新条款「本来就存在的问题应当是 warning，不是失败」。

【WARN-CODE-1】
严重程度：🟠 严重
所在位置：`src/mcp/tools/edit.ts:140-147`；`src/core/errors.ts:38-53`；`SPEC.md:856`、`SPEC.md:1118`；`tests/unit/errors.test.ts:12`
问题描述：新引入的模型可见 warning 码 `notebook_preexisting_content` 是 **SPEC §7 闭集之外的第 12 个码**，未登记为偏离；且 `notebook_run` **从不**把它交给模型。
详细分析（**主审亲验 + 子代理补充**）：
1. 闭集核对：`WARNING_CODES` 只有 11 个；`SPEC.md:856` 标题即「错误码总表（**完整枚举，禁止新增**）」，`:1118` 写明「35 个：24 error + 11 warning」；仓内 `errors.test.ts:12` 还 `expect(WARNING_CODES).toHaveLength(11)` 把这个数字钉死了 → **新增第 12 个码按 AGENTS §11.4 需要先问人类**。
2. 绕过机制（更正我初稿的措辞）：**不是** `as WarningCode` 断言——该处的 `payload` 是 `Record<string, unknown>`（收尾才 `as JsonValue`），`WarningCode` 联合类型在此**根本不参与检查**，所以 `tsc` 静默通过；全仓唯一不走 `createWarning()` 的 warning 构造点就是这一处。
3. 送达不一致（**主审实测**）：同一份带历史问题的文件，`notebook_edit` 在 `warnings[]` 返回该码；`notebook_run` 只写 stderr（`src/run.ts:664/871` 的 `onStructuralWarning: (message) => deps.logger?.warn(message)`）→ 我的 run 实测 `warnings=[]`。而 `README.md:78`、D-037 ③、CHANGELOG 三处都写"以 warning 告知调用方"——**对 run 路径不成立**。
4. 后果：按 §7 白名单解析返回值的客户端会**丢弃**本轮为模型新增的**唯一**信号。
5. 附带 🟢：该文案含 "the requested change was applied"，但它在 `createBackup`/rename **之前**就写进 stderr；写失败（如 `notebook_locked`）时会留下一条断言成功的日志。
修复建议：① 二选一并留档——正式登记为第 12 个 warning（`WARNING_CODES` + SPEC v3.1 清单 + `errors.test.ts` 的 35/11 数字 + DEVIATIONS，按 AGENTS §11.4 先问人类），或复用 §7 已有码；② `notebook_run` 把同一条消息并入 `warnings[]`；③ 文案改为只描述文件内容，不断言请求结果（"the file already contained nbformat content this tool would not write (rule at cell N); it was preserved"）。
设计文档对齐：违反 AGENTS §5（code 只能取自 §7 的 35 个）+ §11.4；D-037 只写了"以 warning 形式告知"，未写"新增码"。

【SCOPE-REFUSE-HINT】
严重程度：🟡 警告
所在位置：`src/core/parse.ts:166-188`（拒绝时 detail 只有 `{problem:{…rule}}`）；`src/core/edit.ts:253-271`（`move_cell` 也进 scope）
问题描述：两个相关的可用性缺陷——① 被触碰 cell 的拒绝**无法回答"这是本次引入的还是本来就有的"**（而 AGENTS §9 本轮刚写下这条规则），也不给补救指引；② **纯重排**（`move_cell`，内容零改动）也被判为"我们在写这个 cell"而拒绝。
详细分析（**主审实测 + 子代理矩阵**）：同一处历史不合规，"没触碰该 cell"时是 warning、"触碰了"时是 `selfcheck_failed`，模型看不出两者是同一件事，也不知道唯一出路（`clear_outputs` / `set_cell_type`，**主审实测可用**）就在手边；`selfcheck_failed` 读起来像"我们写坏了"，语义误导。子代理另测 `move_cell from 1 to 0`（内容零改动）→ `selfcheck_failed`、字节未变，用户为了让 notebook 可读必须先破坏自己的输出。
修复建议：① 写前对原 doc 做一次 scoped 对照，命中则 detail 附 `pre_existing: true` 与 `hint: "this cell already violated <rule>; clear_outputs or set_cell_type removes it"`；② 按 op 类型计算 scope——只有"本 op 真正改写该 cell 的 source/outputs/execution_count"的 op 才进集合（`move_cell`、纯 `delete_cell` 请求 → 空集，只发 warning）；D-037 ② 的措辞「被触碰的 cell」建议改为「被改写的 cell」。
设计文档对齐：AGENTS §9 新条款；D-037 ②。

【SCOPE-OK】（阴性结论，本轮最高优先核实项）
严重程度：—（**未发现问题**，记录验证方法以备后续复用）
位置：`src/core/parse.ts:244-253`、`src/core/edit.ts:354-360`、`src/mcp/tools/edit.ts:101`、`src/run.ts:524/663/870`
验证结论：**索引位移与"越界引入非法结构"两件事都没有问题**。子代理用真 stdio 黑箱做了 12 条矩阵：`insert_cell@0` 后写位移到 index 2 的坏 cell → 拒且 detail `cell_index=2`、整次写入原子（insert 也未落盘）；`insert@末尾`、`delete_cell@0` 后的同类场景同样正确；写**新插入**的 cell → 放行且 warning 指向位移后的 cell；`changed_cells=[1,0]` 符合 SPEC §4.5 规则 9"写回后最终坐标"；`clear_outputs`/`delete_cell`/`set_cell_type→markdown` 命中坏 cell → 放行（写入本身移除了问题）；`dry_run` → 放行且字节未变；被拒 3 次 `bytesUnchanged=true, newFiles=[]`，成功写入恰好 1 个 `.bak`。"本次写入引入非法结构但不在 `touchedCellIndexes`"**构造不出来**（所有会改 cell 的 op 都进集合；run 的每个写回 cell 都 `executedCellsSet.add`，且超时/中断路径都做 `cell.outputs = savedOutputs` 回滚）。**唯一可复现的静默写坏是 GATE-5，而那个 cell 在 scope 内——问题在规则太浅，不在范围。**

【FRAME-4】（阴性结论：v5 的 FRAME-1 修复**有效**）
`tests/unit/protocol.test.ts:89-147` 包装的是 `Buffer.prototype.indexOf`（非自有属性）+ `try/finally` 还原 + `expect(calls).toBeGreaterThan(0)`。子代理两个变异分别命中两条不同断言：① 行为等价的"每次 push 全量 concat"二次实现 → **墙钟断言**变红（`expected 25073 to be less than 5000`，其余 10 例全绿）；② v3 形状（chunk 列表 + 每次 rescan，正是 v5 让它静默全绿的那种）→ **`expected 0 to be greater than 0`**（"探针没跑过"这条新断言把它变红）✓。FRAME-3 的两个抛错点也验证过状态复位（`pendingBytesAfter=0` 且可复用）。



【DEV-CLAIM-FALSE】
严重程度：🟠 严重
所在位置：`docs/REVIEW-FIX-STATUS.md:41`（TIMEOUT-2 行）与提交 `fdd060a` 的说明；对照 `docs/DEVIATIONS.md` 的 D-033
问题描述：状态表称"D-033 **补记**'关闭与返回解耦'"，但该提交**没有改动 D-033 一行**，而 D-033 至今仍写着错误的数字"超时在 `timeoutMs` + **约 5 s** 内返回"。
详细分析（**主审逐字核实**）：
```
git show fdd060a -- docs/DEVIATIONS.md  → 只改了 D-032（加"范围由 D-037 收窄"）、D-036（编号引用）+ 新增 D-037；
                                           D-033 未被触碰（3 insertions / 2 deletions 全在这三行上）
D-033 全文 638 字 → 含"约 5 s"、"5 s 内"；不含"关闭与返回"、"解耦"、"异步"、"10 s"、"10.2"
实测（主审 + 子代理一致）：timeout_seconds=2 的 time.sleep(30) cell 端到端 12.4 s（= +10.4 s）
```
即本轮**唯一一处"声称做了但没做"**——README 的两句确实改了（实测吻合），但"D-033 补记"是空的，且 D-033 的数字与 README 的"about 10 s"**互相矛盾**。这属 v2/v4 那类虚报的同一形态；本轮其余条目都诚实，唯此一处。
修复建议：把 D-033 的"影响"列改成实测口径（`timeoutMs` + 中断宽限 5 s + 关闭/写回开销 ≈10 s（2 s 预算实测 12.4 s）；关闭是**异步**的，响应先返回、进程可能活到被打断的 cell 自然结束），或把状态表该行的"D-033 补记"删掉。
设计文档对齐：违反 AGENTS §8"不许宣称完成"；`docs/DEVIATIONS.md` 是本项目的偏离权威，留下错误数字会误导后续预算配置。

【SCOPE-DEFAULT】
严重程度：🟡 警告
所在位置：`src/core/parse.ts` 的 `SelfCheckScope.touchedCellIndexes`（缺省 = 全文档）
问题描述：缺省值仍是"校验整份文档"这一**危险语义**，而它在生产代码里**没有任何调用方**使用（三个写点都显式传集合，只有测试直连 `writeNotebookFile` 时会走缺省）。
详细分析（子代理核实）：GATE-1 的事故根源就是"整份文档"这个语义；虽然现在生产路径都显式传 scope，但缺省值把地雷留在了签名里——将来任何新调用方少传一个字段，就会悄悄退回"整份只读"的行为，而且**没有任何测试会因此变红**（因为没有调用方使用缺省）。
修复建议：把缺省改成必填，或改名为 `wholeDocumentWhenCreating`（自解释且难误用）；若确实需要缺省（创建新文档），在类型上用一个独立的 `ScopeForNewDocument` 常量显式表达。
设计文档对齐：D-037 ② 的意图；AGENTS §9 新条款的精神（拒绝必须能自证身份）。

【SCOPE-SUCCESS-INVALID】
严重程度：🟡 警告
所在位置：`README.md:78`（已收窄措辞）与 `src/core/parse.ts` 的 scope 语义
问题描述：GATE-1 的取舍带来一个**必须写明的后果**——对带历史问题的文件，`notebook_edit` 可以**返回成功**（`applied:1`）而落盘后的文件仍被 `nbformat.validate` 判为非法（因为历史内容被有意保留）。
详细分析（子代理实测）：`nbformat.validate(quirky.ipynb after edit) = INVALID`，而工具返回成功 + warning。这是**正确的设计取舍**（我们只为自己的输出负责、不擅自修改用户历史内容），但 README 只说了"for the cells the write touches / preserved and reported as a warning"，没有直说"因此文件可能仍不满足 nbformat"。
修复建议：在 README 的该条与 CHANGELOG 各加一句："If the file already contained content we would not write, the write succeeds and that content is preserved — the file may still fail `nbformat.validate` until you fix or clear it."
设计文档对齐：D-037 ③；AGENTS §2（README 必须如实反映行为）。


【DOC-DROP】
严重程度：🟠 严重
所在位置：`docs/REVIEW-FIX-STATUS.md:22-53`（第五轮段）、`:101-153`（第三轮段）
问题描述：v5 报告共列 **18 条**（GATE-1/2/3、FRAME-1、INDENT-HOLE、NEW5-REPRO、TST-CI、NBFORMAT-GATE-SILENT、NEW-2、NEW-6、DEP-2、QUAL-2、TST-2/3/4/5、FID-6 收尾、DOC-FALSE 余项），本轮状态表**只列了 8 条已修项**，其余 **10 条既未修、也未在表中以 ⬜ 出现**（含我 TOP-3 的第 3 条 **INDENT-HOLE**）。第三轮段那 4 行被 v4 证伪的 ✅（`:107` DEP-2、`:110` TST-2/3/4、`:92` QUAL-2、`:111` H-7）也**仍未逐行订正**。
详细分析：这与"虚报"不同——状态表没有把未做的说成已做；问题是**漏列**，其后果与虚报接近：读者（与下一轮评审）无法从状态表判断某项是被否决、被遗忘还是待办，只能回读原报告逐条比对。这已是**连续第二轮**出现（上一轮漏 NEW-6 与 TST-CI）。本轮新增的 AGENTS §9 规则（"守卫必须自证可失败"）是很好的机制，但缺少对等的**跟踪机制**。
修复建议：① 在每轮段开头放一张"本轮报告条目 → 状态"的**完整清单**（✅/⚠️/⬜ + 一句理由），未做的即使不修也必须出现；② 给历史段的可疑行加"现状"列或在行尾标注"见 §〇 已撤"；③ 把"状态表条目数 == 上轮报告条目数"做成可核对的自检（例如脚本比较两份文件的编号集合）。
设计文档对齐：违反 AGENTS §8"每一步的完成 = …，不许宣称完成"的精神（此处是反向的：未完成也未记录）。

**其余 🟡/🟢（沿用 v5 结论，未变）**：`run.test.ts` 的 `NBFORMAT_AVAILABLE` 静默跳过（并入 TST-CI 一项处理）；`tests/unit/cell-selector.test.ts` 仍没有 `MAX_SELECTOR_LENGTH` 的用例；`unsupportedKind` 仍只写不读；`check-format.mjs`/`check-indent.mjs` 都是 `.mjs` 且不在 `tsc` 覆盖内（正是 `node.statement` 这类错误能存活的原因）；`SUPPORTED_NBFORMAT_MINOR` 是死导出；`parse.ts:214-220` 的注释称"未知 cell_type 也被放宽"，实际 `parseNotebook:72-78` 先以 `parse_failed` 拒绝（D-037 ④ 已记录该边界，仅需改注释）；`registry.ts:711-716` 的 `normalized === sessionNormalized` 一支在 symlink/短路径下几乎不命中（真正生效的是新增的 `spelling === session.notebookPath`，无害，建议合并注释）。

---

## 四、七个审查维度逐条覆盖

**1. 架构与模块对齐** —— 未发现明显问题（本轮改动加强了它）
- 写前闸门位于 `core/parse.ts`（纯逻辑），唯一写入路径 `fs/notebook-file.ts` 接线，`mcp/tools/*` 只传 scope（`changedCells` / `executedCellsSet`）——**没有跨层泄漏**；`src/mcp/*` 仍未直接碰 `node:fs`，`core/*` 仍未 import `node:*`。
- 新增 scope 的语义（`touchedCellIndexes` / `onStructuralWarning`）是**接口级**设计，且由 D-037 登记，符合"偏离要当场记录"。
- 一处口径不齐（非架构问题）：`run` 与 `edit` 对同一警告的送达方式不同（见 WARN-CODE-1.3）。

**2. 代码质量与可维护性** —— 2 项（QUAL-2 两份同构实现、FID-6 陈旧注释与常量自相矛盾）；其余良好
- 正面：`selfCheckNotebook` 的注释把"为什么 scope 是 load-bearing"写清了（含 GATE-1 的事故复盘），`structuralWarning` 文案明确告诉模型"内容未被触碰 + 改动已应用"——是**面向模型**的好文案。
- 负面：`edit.ts:142-147` 的类型逃逸（WARN-CODE-1）；`sidecar-transport.ts:175/180` 旧公式注释。

**3. 健壮性与错误处理** —— 2 项（NEW5-REPRO 终态二次翻转、SCOPE-EDIT-HINT 缺补救指引）；闸门本身的错误处理已对齐 nbformat
- 正面：闸门与官方校验器在 `minor=0/4/5/6`、四种 output 形状、字符串 `execution_count` 上**判决一致**（主审逐条对照）；被拒绝时盘上文件**字节未变**（原子性，v5 已有变异证据，本轮复验从略）。
- 负面：`run` 终态仍可被后台任务二次翻转（`state=completed` 搭配 `error={code:'cancelled'}`），`progress.completed` 仍可能停在 `total-1`。

**4. 性能与资源效率** —— 未发现明显问题
- NDJSON 分帧**真线性**（上轮实测 64 MiB 单行 53 ms 且与 chunk 尺寸无关；本轮用例恢复判别力后由变异守住）；`#normCache` 记记忆化并**按规范化值失效**（MISC-3）→ 热路径不再有同步 `realpathSync`；`run-store` 保留策略、`#runAborts`/`#starting` 的 finally 清理均在。
- 唯一遗留是 v5 的 🟢（`#toInfo`/`Buffer` retention 类微优化），无功能影响。

**5. 安全性** —— 未发现明显问题
- 连接文件仍是 `mkstemp`（原子创建、0600、名不可预测）并在三个出口清理；参数上限齐备（`MAX_INDEX_ARRAY_LENGTH=1000`、`MAX_SELECTOR_LENGTH=4096`、ops 1..32）；`src/**` 无 `console.*`；stderr 日志不含 cell 源码/输出（SPEC §5.10）；`notebook_preexisting_content` 的文案只含规则名与 cell 下标，**不泄漏内容** ✓。
- 无新增 `spawn`/`exec` 调用点，artifact/备份名仍由整数索引 + 哈希构成。

**6. 测试覆盖与自测质量** —— 4 项（TST-CI、NBFORMAT-GATE-SILENT、TST-2/3/4/5）
- 正面（本轮最大进步）：`pnpm smoke` 11→18 且补上了 edit 路径与超时；`[GATE-1]`/`[NEW-3][FRAME-1]` 都做了**变异自证**；AGENTS §9 把它写成规则。
- 负面：TST-CI（用例全绿而进程 exit 1，且 CI 会红）、NBFORMAT-GATE-SILENT（断言静默消失）、`acquireRun` 调用点零覆盖、`[I18b]` 单 cell、工具层 `markdown_invalid` 无真写守卫、U20 的 venv 建在仓库内不清理。

**7. 依赖与配置** —— 1 项（DEP-2 版本双真源，🟡）
- 运行期依赖仍只有 SDK（零新增依赖 ✓，`check-indent.mjs`/`e2e-smoke.mjs`/`nbformat-validator.ts` 都只用既有工具链）；`prepack` 已是 `tsc -p tsconfig.json`；pack 133 文件；`.gitignore` 覆盖 `ipynb-mcp-*.json`/`__pycache__`/`commit-msg*`；无循环依赖。
- 负面：`server.ts:48` 版本号硬编码且**无任何守卫**（连用例都没有），旧 ✅ 声明仍在。

---

## 五、总体评估

### 1. 整体质量评级：**C（需返工）**

**本轮的进步是实打实的**：v5 的**两条 🔴 全部真修**（GATE-1 的 scope 收窄 + FRAME-1 的守卫恢复判别力），GATE-2/GATE-3 与官方 `nbformat.validate` 逐条对齐（我做了 3 组对照实验），TIMEOUT-2/README 口径订正，smoke 扩到 18 项并补上此前从未覆盖的 edit 路径，`fixtures-valid` 的虚假覆盖改为如实分层，`#normCache` 按规范化值失效，**并把"守卫必须自证可失败"写成了 AGENTS §9 的规则**——这条流程改进比任何单个修复都重要。

**为什么仍是 C（且这次有硬理由）**：v5 报告 18 条里**只处理了 8 条**，其余 10 条**既未修也未在状态表出现**（含我 TOP-3 的第 3 条 **INDENT-HOLE**）；更关键的是，子代理与主审**各自独立复现**了一条**新的 🔴 GATE-5**——闸门只查 `data` 是不是对象、不查 **mime 值的类型**，于是一个**普通用户 cell**（`display({'text/plain': 5}, raw=True)`）就能让 `notebook_run` 在 `write_back.performed:true`、**无 warning** 的情况下写出 `nbformat.validate` 拒绝的文件。这与 FID-1 同属"静默改坏"，也正是本轮 README 刚写下的"Every write is validated before it lands"所否定的情形；此外还有 `stream.name` 比权威更严（GATE-6，合法文件的单 cell 永久不可编辑）、非字符串图片 mime 触发 `internal` 中止整次 run（CRASH-1）、以及未登记的第 12 个 warning 码（WARN-CODE-1）。**没有任何一项是"声称已修但没做"的虚报**——性质是漏列、漏检与未做，比 v2/v4 的虚报轻，但对"不会静默改坏"这条第一承诺而言同样阻塞。

**需要明确肯定的部分**：v5 的两条 🔴 确实真修（GATE-1 的 scope 收窄经 12 条矩阵验证**没有留下范围漏洞**，FRAME-1 的守卫经两个变异证明**真能失败**），GATE-2/GATE-3 与官方校验器判决一致，smoke 扩到 18 项并补上 edit 与超时路径，"守卫必须自证可失败"已写进 AGENTS §9——**方向完全正确，剩下的问题集中在"闸门这把尺子还太短"**（GATE-5/GATE-6/CRASH-1 同属"值类型未窄化/规则自加"）。

### 2. TOP 3 必须优先修复

| # | 事项 | 为什么 | 修复量 |
|---|---|---|---|
| 1 | **GATE-5（🔴）**：`dataProblem` 补 **mime 值类型**校验（string 或全 string 数组；`application/*json` 例外），同批补 `stream.text`/`error.traceback` 的**元素类型** | 一个**普通用户 cell**（`display({'text/plain': 5}, raw=True)`）就能让工具在 `write_back.performed:true`、**无 warning** 的情况下写出 `nbformat` 拒绝的文件——这是产品第一承诺，也是 FID-1 的同类；本轮 README 刚写的"每次写入都先校验"被它直接推翻 | 小（十几行纯逻辑） |
| 2 | **补齐 v5 的 10 条遗留**，先做三条已复现的：**INDENT-HOLE**（`thenStatement` + 补 else/箭头/switch + 纳入类型检查或自测）、**NEW5-REPRO**（终态与 progress 收口 + 写回前 abort 检查）、**TST-CI**（先挂 handler 再 kill，两行） | 前两条分别是"守卫不管用"与"对外契约违反"，第三条决定 CI 绿是否可信；都是我 v5 已给出具体修法的**小改动** | 小 |
| 3 | **GATE-6 + WARN-CODE-1 + SCOPE-REFUSE-HINT 合并处理**：`stream.name` 对齐 schema（否则合法文件的单 cell 永久不可编辑）、给新 warning 码一个合法身份并让 `notebook_run` 也交回模型、拒绝时自证"本来就存在"并给补救指引、把 `move_cell` 移出 scope | 这三条合起来才兑现 D-037 与 AGENTS §9 本轮刚写下的规则——否则"拒绝"仍然落在**用户**身上而不是我们的输出上，而模型在 run 路径上还看不到任何提示 | 小-中 |

紧随其后：**CRASH-1**（非字符串图片 mime → `internal`，改成类型窄化即可）、**DOC-DROP**（状态表按编号给完整清单 + 订正第三轮段 4 行）、**NBFORMAT-GATE-SILENT**、**NEW-2 分工漂移**、**NEW-6**、**DEP-2/QUAL-2**、**TST-2/3/4/5**、**FID-6 旧公式注释**。

### 3. 与原始设计文档的偏离清单

| 偏离 | 性质 | 状态 |
|---|---|---|
| 写前闸门审整份文档 | 行为偏离（红线意图是"不静默改坏"，不是拒绝服务） | ✅ 已修（D-037 收窄 D-032） |
| **闸门不校验 mime 值的类型 → 静默写出非法文件** | **与"不会静默改坏"红线直接冲突（且本轮 README 的承诺被它否定）** | 🔴 GATE-5，待修 |
| `stream.name` 自加 `{stdout,stderr}` 枚举 | 比 nbformat 严（schema 只说 string）→ 合法文件单 cell 永久不可编辑 | 🟠 GATE-6，待修 |
| 非字符串 mime 值 → `internal`/TypeError | 错误码误用（既定出口应是 `image_materialize_failed`） | 🟠 CRASH-1，待修 |
| 闸门比 nbformat 严 / 松 | 与官方语义不一致 | ✅ 已修（`minor>5` 放宽；`execution_count` 要求 integer 或 null） |
| **新增模型可见 warning 码未登记** | **契约偏离（AGENTS §5：code 只能取自 SPEC §7）** | 🟠 WARN-CODE-1，待登记 |
| **D-033 的数字与 README 矛盾（且被声称"已补记"）** | 文档不实（同一形态的虚报） | 🟠 DEV-CLAIM-FALSE，待订正 |
| `SelfCheckScope` 缺省 = 整份文档（无生产调用方） | 危险缺省值残留（GATE-1 的地雷留在签名里） | 🟡 SCOPE-DEFAULT |
| 对带历史问题的文件，成功写入后文件**仍可能不满足 nbformat** | 设计取舍正确但未写明后果 | 🟡 SCOPE-SUCCESS-INVALID |
| 值级校验从 `invalid_arguments` 漂到协议错误（`mode`/`timeout_seconds`） | 契约漂移（与 D-024 及状态表自述相反） | ❌ NEW-2 未处理 |
| 终态可被二次翻转 / `progress.completed` 语义 | §4.8 契约违反 + SPEC 缺口 | ❌ 已复现，仍未修 |
| README 的"几秒/关闭即完成" | 与实测不符 | ✅ 已订正（TIMEOUT-2）；`sidecar-transport.ts:175/180` 的旧公式注释仍待清 |
| Windows 上 interrupt 不可用 | 平台事实 | ✅ README 已写明 |

### 4. 后续开发建议

- **把"跟踪"补成与"守卫自证"对等的机制**：本轮把"守卫必须能失败"写进了 AGENTS §9，效果立竿见影；同样需要一条"**上轮报告的每个编号都必须在本轮状态表里有一行**（✅/⚠️/⬜ + 理由）"的规则，并可用脚本核对编号集合——否则每轮都会静默丢条目。
- **闸门相关的两个加固**：① 拒绝路径给出补救指引（SCOPE-EDIT-HINT）；② 把 `check-indent.mjs` 纳入类型检查或给它一个自测 fixture（它现在正是"守卫有洞且编译器看不见"的样本）。
- **测试缺口优先级**：TST-CI（CI 可信度）> NBFORMAT-GATE-SILENT（断言静默消失）> `acquireRun` 调用点 > `[I18b]`/`markdown_invalid` 真写守卫 > U20 的 venv 落点。
- **仍缺（发布前最后两道门，属 boss/环境）**：E1–E9 真实第三方客户端（`docs/E2E-CHECKLIST.md` 证据列仍空）；CI 首次真跑（仓库无 `git remote`；本轮 smoke 扩到 18 项后更值得在 CI 上跑）。
- **建议给 `notebook_preexisting_content` 补一条集成用例**（模型侧可见性）：带历史问题的文件走 `notebook_edit` **与** `notebook_run` 两条路径，都断言 `warnings[]` 里有该码——这既是 WARN-CODE-1 的回归守卫，也能钉住两条路径的口径一致。

---

## 附录：验证分工与局限

- **主审亲验（一手证据）**：四道门禁 + `pnpm smoke` 18/18 实跑；**GATE-1 用同一复现复跑**并加测 scope 语义四条（无关 cell / 问题 cell 自身 / 合法 cell / `clear_outputs` 补救）；**GATE-2/GATE-3 与 `nbformat.validate` 三组对照实验**（`minor=6`、`minor=5`、字符串 `execution_count`）；`notebook_run` 路径的 scope 与警告送达实测；INDENT-HOLE 的对抗测试（`if` 体浅一级 → 仍 exit 0）；NEW-5/TST-CI/NBFORMAT-GATE-SILENT/NEW-2/DEP-2/QUAL-2 的未修核实；WARN-CODE-1 的类型逃逸与闭集核对；状态表逐段核对（含第三轮段 4 行未订正）。
- **子代理复核（两路，已全部并入）**：① **v5 修复的深度核实**——GATE-1 的 scope 在 `insert_cell`/`delete_cell`/`move_cell` 索引位移下的 12 条矩阵、被拒写入的原子性、FRAME-1 的两个变异、"本次写入引入非法结构却不在 scope"的构造尝试（**构造不出**）；② **新问题猎取**——6 个真 stdio 黑箱会话、**80 个结构样本与 `nbformat 5.9.2` 双模式逐条对照**（列出 22 处不一致，其中 18 处是"闸门收/nbformat 拒"，含 GATE-5 的同族：mime 值类型、`stream.text`/`error.traceback` 元素类型、负数 `execution_count`）、`check-indent.mjs` 的逐构造隔离矩阵、以及一条独立黑箱会话的残留检查（`%TEMP%` 连接文件 27→27、无新增 python 进程、stderr 无 cell 内容）。
- **主审独立复现的关键项**：GATE-5（`display({'text/plain': 5}, raw=True)` → 静默非法写入）、CRASH-1（`display({'image/png': 123}, raw=True)` → `internal`/TypeError）、GATE-6（`stream.name="foo"` → nbformat VALID 但该 cell 不可编辑）、GATE-1 的 scope 四条语义、GATE-2/GATE-3 的三组 nbformat 对照。
- **⚠️ 运维事故与恢复（必须记录在案）**：本轮复核期间，一个子代理在 `%TEMP%` 用 `git worktree` + `node_modules` **junction** 做变异测试，收尾执行 `git worktree remove --force` 时**穿透 junction 清空了主仓 `E:\Work\ipynb-mcp\ipynb-mcp\node_modules`**（约 20:30–20:31）。处置与复核（**主审逐项亲验**）：该子代理用本地 store 离线重装（`pnpm install --frozen-lockfile --offline`，146 包全部 reused），依赖版本与原一致（`@modelcontextprotocol/sdk 1.31.0` / `zod 3.25.76` / `typescript 5.9.3` / `vitest 3.2.7` / `oxlint 1.86.0`）；`git status --porcelain` 空、`pnpm-lock.yaml` **未变**、`git worktree list` 仅剩主仓。**事故后主审把门禁全部重跑**：`typecheck` 0 / `lint` 0（format+indent ok）/ 单测 **232 passed + 1 skipped** / `build` 0 / **`pnpm smoke` 18/18** 全部通过。我自己的实测证据**不受影响**——GATE-5/CRASH-1/GATE-6 三个探针的时间戳为 **20:23**（事故前）、scope 语义测试为 20:14。**教训**：变异测试的 worktree **不要**把 `node_modules` 做成指向主仓的 junction（应改在 worktree 内独立安装，或先 `rmdir` 掉 junction 再移除工作树），否则任何递归删除都会穿透到主仓。
- **局限**：① 未做 macOS/Linux 实跑；② E1–E9 与 CI 首次真跑仍未验（属 boss/环境）；③ 我的编号（v6）与仓库状态表的"第 N 轮"编号体系不同（他们把"回应 v5 的整改"记为第五轮），比对时以报告文件名与编号（GATE-5/FRAME-1/…）为准；④ 80 样本对照由子代理完成，我抽查了其中 4 条（GATE-5/GATE-6/CRASH-1/`execution_count` 字符串）；⑤ **本报告已更正自己两处**：v5 记录里"`check-indent.mjs` 4/4 命中含 if 体"是假阳性（实为外层构造代为命中），以及 WARN-CODE-1 的绕过机制不是 `as WarningCode` 断言、而是该处 payload 为 `Record<string, unknown>` 导致 `WarningCode` 根本不参与检查（子代理加强证据：把码改成 `notebook_totally_made_up_code` 后 `tsc` **仍 exit 0**，同码经 `createWarning` 则报 TS2345）；⑥ 子代理未跑完整 `pnpm test`/`test:integration`（受我约束），`smoke` 18/18 与 `fixtures-valid` 静态扫描未做变异。
