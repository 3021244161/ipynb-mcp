# ipynb-mcp 代码审查报告（第七轮 / v7）

> **审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp` @ HEAD `1209164`（v6 整改后，**9 个提交 / 40 文件 / +2686 −335**；⚠️ 工作树有**未提交**改动：`AGENTS.md`）
> **上轮基线**：`c43c0af`（v6 报告已归档为 `docs/review/ipynb-mcp-code-review-v6.md`）
> **权威**：`SPEC.md` + `AGENTS.md`（本轮 AGENTS §9 新增两条规则；新增偏离含 D-038+）
> **方法**：主审亲跑六道门禁 + **用抓到 GATE-5/GATE-6/NEW-5/GATE-1 的同一探针复跑** + **针对新逻辑的对抗测试**（合法 mime 值是否被误伤）+ 依赖元数据核对（`Requires-Dist`）+ 两路独立复核
> **日期**：2026-10-04

---

## 一、门禁实测（主审亲跑）

| 门禁 | 实测 | 变化 |
|---|---|---|
| `pnpm typecheck` | exit 0 | ✅ |
| `pnpm lint` | 0 警 + `format check: ok` + `structural indent check: ok` | ✅ |
| `pnpm test` | **252 passed（无 skip）**，24 文件 | ↑ 233→252，且 **U20 不再 skip** |
| `pnpm test:integration` | **46 passed / 46**，6 文件，220.1 s，`VITEST_EXIT=0` | ↑ 44→46（本轮新增用例） |
| `pnpm smoke` | **19/19** | ↑ 18→19 |
| `pnpm build` | exit 0 | ✅ |
| **CI 首次真跑** | **✅ 外部可核（子代理用 GitHub 公开 API）**：`origin=https://github.com/3021244161/ipynb-mcp.git`、`main == origin/main @1209164`、**run 37136146902 `conclusion=success` / 9 个 job（5 unit + 4 integration）**、`head_sha=9f611e6`；integration job 步骤含 `pip install ipykernel jupyter_client` + `pnpm test:integration`，与 `ci.yml:53-88` 一致。**但这同时暴露一个缺口：CI 里没有 `nbformat`**（见 P0-a） | **这是我前几轮一直标的"发布前最后两道门"之一，本轮落地且可外部核验**；仍未覆盖：`pnpm smoke` 不在 CI、`npm pack` 验证不在 CI、macOS integration 有意排除、E1–E9 为 0 项 |

> **顺带一条 NEW-6 的实证**（来自本次集成跑的 stderr）：`[ipynb-mcp] … warn sidecar: [IPKernelApp] ERROR | Failed to create history session in C:\Users\…\history.sqlite` 出现了 3 次。这类 ipykernel 环境噪音会进入 `#stderrTail`，而 `#failureDetail()` 会把它**挂到此后任意一次失败**上（见 §2.2 NEW-6）——即模型可能收到"失败原因是 ipykernel 的 history.sqlite"这种完全无关的归因。

---

## 二、v6 问题闭环核查

### 2.1 ✅ 真修复（主审亲验，附证据）

| v6 项 | 证据 |
|---|---|
| **GATE-5**（🔴 闸门漏检 mime 值类型） | **同一探针复跑**：`display({'text/plain': 5}, raw=True)` → run `status=ok`、警告含 `output_truncated`、盘上 `{"output_type":"display_data","data":{},"metadata":{}}`、**`nbformat.validate` VALID**（此前是静默写出非法文件）✓ |
| **合法性不误伤**（我加的对抗测试） | 五种**合法**形态实测**全部原样保留**：`text/plain: ['a','b']`（字符串数组）、`application/json: {k:1,nested:[1,2]}`（对象）、`text/html: ['<b>a</b>','<i>b</i>']`、`text/plain: 'plain ok'`、`stream.text` → 文件 VALID、**无警告**（说明没有多余清理）✓ |
| **CRASH-1**（🟠 非字符串图片值 → `internal`） | `display({'image/png': 123}, raw=True)` → 不再 `internal`：run `status=ok`、警告 `image_materialize_failed`、文件 **VALID** ✓ |
| **GATE-6**（🟠 `stream.name` 比 nbformat 严） | `name="foo"` 的文件：**改该 cell 自身成功**（`applied=1`、无警告）——此前是永久不可编辑 ✓ |
| **WARN-CODE-1**（🟠 第 12 个 warning 码 + run 不告知） | 不再造新码：`core/errors.ts:66` 把 `PREEXISTING_CONTENT_WARNING` 映射到 §7 已有的 **`file_changed_externally`**，并写明理由（"§7 是闭集，v5 造了第 12 个码"）；**run 路径也交回模型**（`run.ts:706` `warnings.push(createWarning(PREEXISTING_CONTENT_WARNING, message))`，注释直指 v6 WARN-CODE-1 指出两条路径不一致）✓ |
| **SCOPE-REFUSE-HINT**（🟡 拒绝不自证身份） | 复跑：改"有问题但未被触碰"的 cell → 仍成功 + 警告；改**被触碰且有历史问题**的 cell → `selfcheck_failed`，且 detail 现在带 **`pre_existing: true`** 与 **`hint`**（指向 `clear_outputs`/`set_cell_type`）✓；`clear_outputs` 补救路径仍放行 ✓ |
| **INDENT-HOLE**（🟠 缩进守卫漏 if/else/箭头/switch） | 守卫重写（`check-indent.mjs` +364）：我的**逐构造对抗测试**——`if` 体 ✓ 报、`else` 体 ✓ 报、**箭头函数体** ✓ 报、**方法体** ✓ 报、**switch case 与 case 体** ✓ 报（exit 1）。而且脚本**自带 SELF-TEST**（每个样例只在一处错位、断言全部检出 + 干净样例不误报）——把"守卫必须自证能失败"用到了守卫自己身上 ✓ |
| **NEW5-REPRO**（🟠 progress 停在 total-1 / 终态可翻转） | 复跑后台 run：终态 `state=completed progress={"completed":2,"total":2} executed=2 error=null` → **`progress.completed === total` ✓、`error` 已清空 ✓**；`RunStore.settle()` 成为终态唯一写者（先到先得） |
| **TST-CI**（🟠 用例全绿而 exit 1） | `run.test.ts:526-532` 改为**先挂 handler**（`const settled = inflight.then(...)`）再 `await transport.kill()` ✓ |
| **TST-2**（🟠 `acquireRun` 调用点零覆盖） | 新增 `[TST-2] a run takes the registry run-level lock`：真 `KernelRegistry` 子类 spy，断言 `acquired === [nb]`、`released === 1`，注释写明"删掉 run.ts 的 `acquireRun` 调用会让套件保持全绿"（并解释为何不能用 Proxy：私有字段）✓ **正是我建议的形态** |
| **DEP-2**（🟡 版本双真源无守卫） | `server.ts:57-69` 用 `createRequire` 读 `package.json` 的 version（带 fallback），并有 `tests/unit/server-version.test.ts` ✓ |
| **QUAL-2**（🟡 两份同构实现） | 统一到 `core/errors.ts` 的**唯一实现**（注释："It used to exist twice … byte-for-byte identical"），`edit.ts` 改 re-export，`run.ts` 删掉副本 ✓ |
| **TST-5**（🟡 venv 建在仓库内） | `VENV_DIR` 改为 `process.env['IPYNB_TEST_VENV'] ?? path.join(tmpdir(), 'ipynb-mcp-test-venv')` ✓ 已移出仓库 |
| **FID-6 注释收尾**（🟡） | 新增 `SIDECAR_SHELL_REPLY_MS = 30_000`（注释注明与 Python 侧 `SHELL_REPLY_BUDGET_SECONDS` 对应），不变式改为 `transportTimeout > max(SIDECAR_WORST_CASE_MS, SIDECAR_SHELL_REPLY_MS) + slack` ✓ 30 s 项终于进了预算 |
| **SCOPE-DEFAULT**（🟡 部分） | `move_cell` 不再进闸门 scope（`ChangedCell.content_changed` 区分"改写"与"重排"）✓；但见 §2.2 |
| **DOC-DROP**（🟠 状态表漏列） | 本轮的第六轮段**把我 v6 的条目逐条列出**（GATE-5/CRASH-1/GATE-6/WARN-CODE-1/INDENT-HOLE/NEW5-REPRO/TST-CI/NBFORMAT/SCOPE-*/NEW-2/DEP-2/QUAL-2/FID-6）✓，并额外记录 CI 首跑暴露的 6 条（1a/1b/1c/2/3/4） |
| **TST-3 的 `[I18b]`** | 已扩到 **3 个 cell**（中间一个不执行且带 seed），断言逐条指明是哪个 cell ✓ |

**本轮还额外修掉了首次 CI 运行暴露的 6 个真实缺陷**（跨平台测试假设 1a/1b/1c、探针与 sidecar 真实依赖不一致 2、`I15` 的 EBUSY 相位错误 3、macOS 计费 4）——这说明 **CI 这一步补得非常值**。

### 2.2 ❌ 未修 / 与文档不符

| 项 | 结论 | 主审证据 |
|---|---|---|
| **NBFORMAT-GATE-SILENT**（🟡） | ❌ **代码未改，且状态行不实** | 状态表写"`[FID-1]`/`[FID-3]` 在解释器缺 nbformat 时改为 `it.skip`（记录原因）"，但 `tests/integration/run.test.ts:948/976` 仍是 `if (NBFORMAT_AVAILABLE) { …validate… }`，全文件**零** `skipIf`/`it.skip`/`describe.skip`（实测 grep）。**更严重的是**：我核对了依赖元数据——`jupyter_client` 与 `ipykernel` 的 `Requires-Dist` **都不包含 `nbformat`**，而 CI 的 integration job 只 `pip install ipykernel jupyter_client`（`ci.yml:72`）→ **CI 上很可能根本没有 nbformat**，那两条"外部权威"断言会**静默消失**，套件仍然全绿。这正好落在"最需要它的地方"。 |
| **NEW-2**（🟠 分工漂移） | ⚠️ **部分，且状态行与代码相反** | 状态行写"广播枚举**保留在工具层**：schema enum 会让 SDK 抢先返回协议错误"，但 `src/server.ts:182-185` 的 **`mode` 就是 `z.enum(['auto','resume','replay','full'])`** → `mode:'bogus'` 返回协议错误 -32602，不是 `invalid_arguments`；而 `include_source`/`include_outputs`/`action` 仍是裸 `z.string()`（**缺 enum**）。即：一个在 schema 层、三个在工具层、文档说"都保留在工具层"。`DEVIATIONS` 也未就此登记。 |
| **TST-4**（🟡 测试编号体系登记） | ❌ 未做 | `docs/DEVIATIONS.md` 中"编号"相关条目 **0 命中**。 |
| **TST-3 的另一半**（工具层 `markdown_invalid` 真写守卫） | ❌ 未做，且状态行不实 | 状态行写"TST-4 工具层 `markdown_invalid` 真写守卫：均已补"，但全仓 `markdown_invalid` 只有三处：`edit-tool.test.ts:139`（**`dry_run: true`**）、`markdown.test.ts:134`、新增的 `markdown.test.ts:158`——**后两者都直接调 `applyEditOps`（core 层）**，不是工具层真写路径（我读了 `:150-163`：它靠"调用方失败就不写"来断言字节不变）。 |
| **SCOPE-DEFAULT**（🟡） | ⚠️ 部分 | `SelfCheckScope.touchedCellIndexes` 仍是**可选**（`parse.ts:137`），`scope: SelfCheckScope = {}`（`:177`）缺省仍等价"整份文档"；生产调用方都显式传，但**危险缺省值仍留在签名里**（无调用方使用 → 没有测试能发现将来少传）。 |
| **D-033 的措辞**（🟠 DEV-CLAIM-FALSE 的残余） | ⚠️ 部分 | 代码/不变式已修（见 FID-6 行），但 D-033 的"影响"列**仍写"超时在 `timeoutMs` + 约 5 s 内返回"**，与同一行的"决定"列（`+ 中断宽限 5s + 10s`）以及实测（2 s 预算端到端 **12.4 s**）自相矛盾。 |
| **H-7**（🟡 R3 的 `cellInFlight` 未登记） | ❌ 未做 | `docs/*.md` 中 `cellInFlight` **0 命中**。 |
| **NEW-6**（🟠 stderr 尾巴挂到无关失败上） | ❌ 未修，且**零测试覆盖** | `sidecar-transport.ts:102/140-142` 仍是只增不减的环形缓冲（**无游标、无按 op 过滤**）；`:423-424` 的 `#failureDetail()` 只要缓冲非空就无条件附 `sidecar_stderr`，而 `:365/:375/:402` 三处与 `:460` 的 `#failAllPending` 都会调用它（本轮只修了 `:332` 的 `!this.alive` 那一支）。**实证**：本次集成跑的 stderr 里反复出现 ipykernel 的环境噪音（`[IPKernelApp] ERROR | Failed to create history session … history.sqlite`），它会进入该缓冲，随后被挂到**任意一次**失败上。全仓 `sidecar_stderr`/`stderrTail`/`sidecar_exit` 的用例数 = **0**。 |
| **工作树未提交**（🟡 hygiene） | ⚠️ | `AGENTS.md` 有 **48/46 行**未提交改动（仅表格对齐重排）。评审时工作树不干净；若是格式化工具所致，建议单独提交或还原，避免与下一轮改动混在一起。 |

---

## 三、本轮新发现

### 3.1 子代理发现、**主审独立复现**的关键项

【V7-1】
严重程度：🔴 阻塞
所在位置：`src/core/outputs.ts:35-43`（`dataValueToString`）、`:79-88`（`rawOutputsOfCell` 丢非 string/数组值）、`:430-446`（json 分支）、对照 `src/core/parse.ts:420-429`（闸门**显式豁免** json mime："the value IS the document"）
问题描述：**读方向**会静默**改写或丢弃** nbformat **合法**的 `application/json` 值——写方向（本轮专门立了 json 豁免）是对的，读方向没有兑现同一条契约。
详细分析（**主审独立复现**，输入文件经 `nbformat.validate` 判 **VALID**）：
| 盘上（合法） | 模型实际收到 | 性质 |
|---|---|---|
| `application/json: [1,2,3]` | `{"kind":"json","value":123}` | **静默给出错误答案**（`String([1,2,3])`→`"1,2,3"`→`JSON.parse`→`123`） |
| `application/json: {k:"v"}` | `{"kind":"unsupported","mime_type":"unknown",…}` | 静默丢弃 |
| `application/json: 5` / `null` / `true` | 同上 | 静默丢弃 |
| `application/json: ["a","b"]` | `{"kind":"text","media_type":"text/plain","text":"ab"}` | **mime 被改写**为 text/plain |
| `text/plain: ["a\n","b\n"]` | 正确 | ✅ |
**`read warnings: []`**——零提示；且因为 `rawOutputsOfCell` 已把键删掉，`mapRawOutputs` 的 `Object.keys(data)[0] ?? 'unknown'` 只能报 `mime_type:"unknown"`，模型连"是哪个 mime 出的问题"都不知道。子代理的黑箱第 1 场还拍到**工具自己刚写的**输出被读丢：`display({'application/json': {'a':[1,2,3]}}, raw=True)` → 写回 `VALID`、值原样落盘 → 随后 `notebook_read` 同一 cell 返回 `unsupported`。**写得出、读不回。**
归属（诚实说明）：机制**早于本轮**（`dataValueToString` 是 v3 的代码），不是本轮引入；但 ① 它不在 v6 清单里，属新发现；② 本轮把"json mime 任意类型"写进了闸门、归一化器与 `[GATE-5]` 的注释/断言，**只兑现了写方向**，等于用文档与测试为半成品背书；③ 与 GATE-5 同族（值类型未窄化）。按我的判据（合法数据被丢弃/改写 = 🔴）定 🔴。
修复建议：
```ts
// RawOutput.data 放宽为 Record<string, unknown>（或加 jsonValues）
// rawOutputsOfCell：对 isJsonMime(mime) 的值原样保留，不要过 dataValueToString
if (JSON_MIME.test(mime)) { data[mime] = value; continue; }          // 任意类型，原样
// mapRawOutputs 的 json 分支：非字符串值直接产出
items.push({ kind: 'json', value });                                  // 不要 String() 后再 JSON.parse
```
顺带修 `outputs.ts:433` 的 `JSON.parse(rawJson)`（对象经 `String()` 变 `[object Object]` 后 parse 失败，会把对象塞进声明为 string 的 `text` 字段）。
设计文档对齐：SPEC §5.4 第 7 行（`application/json` → `kind:"json"`）、SPEC §5.5/§6 R2「不静默改坏」、AGENTS §1"消费者是模型"。

【V7-2】
严重程度：🟠 严重
所在位置：`src/run.ts:544-549`（丢值时 push）、`:585-590`（真截断时 push，**无去重**）；对照 `src/mcp/render/read.ts:133-140`（读路径**有** `warnings.some(...)` 去重）
问题描述：`output_truncated` 被复用来表示"值因格式非法被丢"，且 run 侧**不去重**，一次调用会发 2–3 条——SPEC §7 明写该码"整个调用只追加一次"，U21b 也断言"恰好一次"。
详细分析（**主审核对代码**：`run.ts:546` 与 `:587` 两次 push、无 `some()` 去重；读路径有）：同一仓库两套口径。子代理的真 stdio 实测：同步 run 一次响应里**同码 2 条**（cell 2 丢弃 + 真截断各一条），后台 run 经 `run_status` 拿到**3 条**。后果：① 按 §7 释义编程的客户端会把"格式非法被丢"读成"输出太长被截断"（**错误诊断**）；② 丢了几项只能数同码条数；③ U21b 的"恰好一次"不成立。
修复建议：run 侧加与读路径相同的去重；把"丢弃"与"截断"**分码**（若坚持闭集，则 message 里显式带 `dropped_count` 与 mime 名——子代理确认 message 已含 cell 下标与 mime，这是目前唯一的可见性来源）；把"只追加一次"写进 D-040；若决定新增码，走 AGENTS §11.4 问人类。
设计文档对齐：SPEC §7 的 `output_truncated` 行 + 紧随的"边界（强制）"段、SPEC §10.1 U21b；D-040（登记了码的选择，**未覆盖"只追加一次"**）。

【V7-3】
严重程度：🟠 严重
所在位置：`scripts/fix-indent.mjs:99-108`（switch 子句分支直接 `fixLine(...)`，**缺** `handleBlock:55` 的"语句必须独占本行"守卫）；对照 `scripts/check-indent.mjs:183-198`
问题描述：对**合法**写法 `case 1: return 1;`（标签与语句同行），`check-indent` 判"语句缩进 4、应为 6"，`fix-indent` 于是把**整行（含标签）**推深；下一轮 checker 又说标签该在 4 → **25 轮震荡、每次运行都改写文件**，最终把文件留在**过不了 `pnpm lint`** 的状态。
详细分析（子代理最小复现，7 行文件）：`run 1 → "49 lines re-indented"`、`run 2/3 → "50 lines re-indented"`（不收敛），且 checker 报 `switch case: line 3 is indented 6, expected 4`。即 fixer 与 guard **互相矛盾**，而 `check-indent.mjs:24-28` 恰好声称"guard must prove it can fail"。**正面对照**（说明影响面有限）：干净树上 63 个 `.ts` **全部 0 改动**；含注释块/模板字符串/多行字符串/续行/CRLF 的刁钻文件只改了真正错位的 2 行、幂等、checker 通过——**问题只在一行 `case` 上，但触发时后果最坏（自动改坏 + 不收敛）**。
修复建议：把 `handleBlock:55` 的"独占本行"判据抽成 `ownsLine(statement)`，switch 的两条分支（子句与语句）都先判，同行则跳过（与 `check-indent` 的 `checkStatements` 一致，报"[not on its own line]"而不是报缩进）；`fix-indent.mjs:96` 的 `fixLine(where.line, caseColumn)` 同样加守卫。
设计文档对齐：AGENTS §9（守卫必须自证）+ 本文件头部自述；`docs/REVIEW-FIX-STATUS` 的 INDENT-HOLE 行。

【V7-4】
严重程度：🟠 严重（安全）
所在位置：`src/kernel/interpreter.ts:155-158`（`reported = run.stdout.trim()`，**无校验、无截断**）、`:304-315`（`missingModuleMessage`/`installCommandFor` 直接拼接）
问题描述：本轮新增的 `runCapturing` 让 `install_command` 不再是固定模板，而变成 `"<path>" -m pip install <被探测进程的 stdout>`——**外部进程的输出被直接插进"建议模型执行"的命令串**，且长度无上限。
详细分析（子代理直驱 `lib/kernel/interpreter.js`）：注入串 `jupyter_client && rm -rf ~/notebooks` → `install_command` 变成 `"/usr/bin/python3" -m pip install jupyter_client && rm -rf ~/notebooks`；5000 字符的 stdout 会原样进入 `install_command`、`message`、`detail.missing_module` 与 `detail.candidates[].reason`。可达性：需要本机存在"在 PATH/kernelspec 里但 stdout 不干净"的 python（包装器、被投毒的 shim、异常回显）——不是普通用户路径，但**这是全仓唯一一处把外部进程输出变成"请模型执行这条命令"的地方**，修法极短。
修复建议：`const reported = run.stdout.trim().split(/\s+/)[0];` 然后只在 `SIDECAR_REQUIRED_MODULES` 里精确匹配（`find(m => m === reported) ?? null`），并对 stdout 读取加长度上限（如 4 KiB）与 `[A-Za-z_][A-Za-z0-9_]*` 校验；不认识就退化成"cannot provide the sidecar's modules"，`install_command` 用常量清单。
设计文档对齐：SPEC §5.2（`install_command` 是给人/模型照抄的命令）、SPEC §6 安全红线。

【V7-5】
严重程度：🟠 严重（文档与事实相反）
所在位置：创建点 `tests/integration/locked-file.test.ts:42,52-53`、`kernel.test.ts:20,63`、`run.test.ts:29`、`server.test.ts:26`、`stale.test.ts:21`；引用点 `fixtures-valid.test.ts:88`、`scripts/e2e-smoke.mjs:44`；文档 `docs/COMPATIBILITY.md:37`、`CHANGELOG.md:41`、`README.md:101`
问题描述："测试 venv 已移出仓库"**只在单测那一侧成立**：5 个集成文件仍把 venv 建在 `<repo>/tests/.venv-test`，而文档说它现在位于系统临时目录、甚至"已删除"。
详细分析（**主审实测**）：`tests\.venv-test` **存在、18.3 MB、mtime 2026/10/3 23:47**（即本轮验收跑留下的），`VENV_DIR = path.join(REPO_ROOT,'tests','.venv-test')` 出现在 **5 个集成文件**里（只有 `analyze-op.test.ts:24` 改用了 `tmpdir()`）；`git status` 干净是因为 `.gitignore` 把它藏住了——这也正是它没被门禁发现的原因。三处文档口径互斥且前两处与磁盘事实相反：`COMPATIBILITY.md:37`"现在位于系统临时目录"、`CHANGELOG.md:41`"移出仓库"、`README.md:101` 仍写"creates a dedicated venv (`tests/.venv-test`…)"。
修复建议：抽一个共享 helper，`VENV_DIR = process.env['IPYNB_TEST_VENV'] ?? path.join(tmpdir(), 'ipynb-mcp-test-venv')`，六个集成文件统一；删掉 `tests/.venv-test`；把 README/COMPATIBILITY/CHANGELOG 改成"unit + integration + smoke 统一用临时目录（可被 `IPYNB_TEST_VENV` 覆盖）"。
设计文档对齐：AGENTS §9（副作用只能落临时目录且必须清理）、§3；v6 TST-5 行自称已修。

【V7-6】
严重程度：🟠 严重
所在位置：`src/kernel/interpreter.ts:263-282`（PATH 候选）
问题描述：PATH 候选**丢掉了"不存在"的判定**：不存在的 `python3` 被报成 `ipykernel_missing`，并给出必然失败的 `install_command`。
详细分析（**主审读码确认**）：`:275-278` 的 `reason: probe.missingModule === null ? 'ipykernel_missing' : …` 与 `:279-281` 的无条件 `if (installCommand === null) installCommand = installCommandFor(candidate, probe);` —— 旧代码是 `if (status !== 'not-found' && installCommand === null)`。子代理的直驱实测：`nothing installed anywhere` 时报
```
code: interpreter_not_found
detail: { candidates: [ {path:"python3", reason:"ipykernel_missing"}, {path:"python", reason:"ipykernel_missing"} ],
          install_command: "\"python3\" -m pip install ipykernel jupyter_client" }
```
SPEC §5.2 明写 `install_command` 取"**第一个存在但缺 ipykernel** 的候选"；这条命令在 `python3` 不存在时执行必然失败。
修复建议：`ProbeResult` 带上 `status`（`not-found`/`failed`），`reason` 用 `'not found'`，只有 `missingModule !== null || status === 'failed'` 时才设 `installCommand`（恢复旧守卫）。
设计文档对齐：SPEC §5.2、D23、D-038。

### 3.2 第一路（v6 修复深度核实）的新发现 —— **含三行虚报**

**【P0-a】状态表三行"声称已修但代码里没有"（连续第二轮同形）**

| 状态行 | 声称 | 实际 |
|---|---|---|
| `REVIEW-FIX-STATUS.md:52`（NBFORMAT-GATE-SILENT） | "改为 `it.skip`（记录原因）" | `run.test.ts:948/976` 仍是裸 `if (NBFORMAT_AVAILABLE)`，**全仓无 `it.skip`**；变异把 `nbformatAvailable→false` 后 `-t "FID-1"` **仍 2 passed**、skip 数不变 → 断言**无声消失** |
| `:60`（NEW-6） | "超时路径不再无条件挂上 stderr 尾巴" | `sidecar-transport.ts:369-377` 与 `c43c0af` **逐字相同**，`#failureDetail()`（`:413-427`）仍只要缓冲非空就附 `sidecar_stderr`；该路径**零测试覆盖**（我已独立核对代码） |
| `:63`（DEV-CLAIM-FALSE） | "D-033 的数字改为实测口径（≈ +10 s；2 s 预算实测 12.4 s），并写明关闭是异步的" | `git diff -w c43c0af..HEAD -- docs/DEVIATIONS.md` 只改了 D-037 措辞 + 新增 D-038/039/040；**D-033 一行未动**，仍写"超时在 `timeoutMs` + 约 5 s 内返回"、不含"异步"（我逐字检查：含'约 5 s'=True、含'异步'=False） |

**并且它把 NBFORMAT 那条从"很可能"钉成了"确定"**：`ci.yml:72` 只装 `ipykernel jupyter_client`，用 `importlib.metadata` 展开依赖闭包得到 **`nbformat in closure: False`** → CI 的 integration job 里 `NBFORMAT_AVAILABLE=false`，`[FID-1]`/`[FID-3]` 的真校验与 `fixtures-valid.test.ts` 的真校验分支**都不执行且记 PASS**。即：**唯一的外部权威，在唯一的自动化环境里恒缺席，而绿灯无痕**。（我自己独立核过 `Requires-Dist`：`jupyter_client`/`ipykernel` 均不依赖 `nbformat`。）

**【P1-a】cell 级 `execution_count < 0` 未进闸门（主审已复现）**
`nbformat` 对 `execution_count: -1` 判 **INVALID**（`-1 is less than the minimum of 0`），而对该 cell 做 `replace_source` → `isError=false applied=1`、**无警告**、文件仍 INVALID。这直接违反 D-037 ②"被改写的 cell 若仍带着问题则照旧拒绝"——闸门查了 `execute_result` 输出里的负数，却漏了 **cell 级** 的 `execution_count`。

**【P1-b】响应侧 `OutputItem.text` 可以不是字符串（主审已复现）**
`display({'text/plain': 5}, raw=True)` 的 run 返回 `executed[0].outputs = [{"kind":"text","media_type":"text/plain","text":5}]`（**数字**），而同一形状在盘上被丢成 `data:{}`——即 GATE-5 的窄化**只做了写盘方向**，响应契约（`core/outputs.ts:222/442` 声明 `text: string`）没窄化，`RawOutput.data` 的类型在此处是一句谎。

**【P1-c】工作目录里积了 45 个含 HMAC key 的连接文件（主审已复现）**
`E:\Work\ipynb-mcp\ipynb-mcp` 根目录实测 **45 个 `ipynb-mcp-*.json`（42 个 `probe-kernel` + 3 个 `kernel-i7`）+ 15 个 `tmp*.json`**，`%TEMP%` 另有 50 个；它们**带 HMAC key**，只因 `.gitignore` 才没进版本库。子代理没能完全归因（把子进程 env 收成 `{PYTHONUNBUFFERED}` 后 `tempfile.gettempdir()` 仍返回 `%TEMP%`），但确认了一处代码味道：**`sidecar-transport.ts:121` `env: { ...options.env, … }` 是整体替换而非合并**，而测试构造 `SidecarTransport` 时不传 `env` → sidecar/kernel/被执行的 cell 拿不到 `PATH`/`TEMP`/`SystemRoot`。建议 `...(options.env ?? process.env)`；同时清理这 60 个残留文件（含密钥），并把"cwd 零残留"的说法从文档里去掉或加上前提。

**其余 🟡（第二路）**：`WARN-CODE-1` 的语义过载在 `src/run.ts:194` 仍在用原义（"kernel 存活期间被外部修改"），客户端无法用码区分两种含义（D-039 未给区分办法）；`exec_timeout` 的手工 detail **不含 `warnings`**（我已列为 V7-8）；`check-indent` 覆盖 **25/25 类构造 RED、自检经 6 个变异全部变红**（这是本轮最扎实的守卫自证，反过来也确认 V7-3 的单行 `case` 是唯一矛盾点）；规则名被静默改名（`error_traceback_not_an_array` → `traceback_not_an_array`，无测试/文档提及）；`SIDECAR_WORST_CASE_MS`(5 s) 在 `max(...)` 里永远输给 30 s（已是纯文档常量）；文档数字四处不一致（单测 252/251、WSL 239+1/238+1、CI job 结构"unit ×7"实为 5 unit + 4 integration、pack **我实测 133** vs 子代理 **132**）；`AGENTS.md` 的未提交改动**非有意**（4 张表重排 + 反面清单多一个空行）。

**CI 仍未覆盖的面（子代理核实）**：`pnpm smoke` **不在 CI**（19/19 只是本机）；`npm pack` 产物验证不在 CI；macOS integration 有意排除；Node 24 下的 integration、Python 3.11/3.13 未跑；arm64 无 runner；**E1–E9 第三方客户端 0 项**（COMPATIBILITY 的客户端矩阵 4 行全"未测试"）。



### 3.3 其余 🟡（两路复核汇总，均有实测/读码证据）

| 编号 | 位置 | 一句话 |
|---|---|---|
| **V7-7** | `core/outputs.ts:182-218` vs `core/parse.ts:358-376` | 归一化只覆盖了本轮 3 条新规则中的 1 条（mime 值 + 负数 count），`stream.text` 元素、`error.traceback` 元素、`error` 字段非字符串**仍会让整次 run 的成果全丢**（实测 `dropped=[] gate=REJECTED`）；可达性低（没能构造出用户 cell 触发路径），但正是 D-040 想消灭的失败模式 |
| **V7-8** | `src/run.ts:562-576` | `exec_timeout` 的 detail **没有 `warnings` 键**（`failedRunError` 有）→ 前面的 cell 丢过值 / 文件有历史内容时，超时响应里模型看不到 |
| **V7-9** | `src/config.ts:370-390` | `absolutePath()` 的 `platform` 是**死参数**（`void platform;`）且行为与注释相反：Linux 上 `C:/x/y` 被当绝对路径，`path.posix.resolve` 会得到 `<cwd>/C:/x/y`，`mkdirSync('C:/x/y')` 会在 cwd 下建 `C:` 目录（SPEC §4.1.3 的"绝对路径"不成立） |
| **V7-10** | `src/core/parse.ts:437-447` | `JSON_MIME` 比 nbformat schema 的 `^application/(.*\+)?json$` **更严**（少一个 `.`）→ `application/x/y+json`、`application/+json` 这类 nbformat 判 VALID 的键被我们丢/拒（与 GATE-6 同类，方向相反） |
| **V7-11** | `fs/atomic.ts:210-216` vs `fs/notebook-file.ts:270-275` | 本轮一边合并 QUAL-2，一边**新增**同款重复（`lockErrno` vs `errnoCode`），返回值仅差 `null`/`undefined` |
| **V7-12** | `src/run.ts:377`、`mcp/tools/edit.ts:129` | 每次 run/edit 都**无条件** `structuredClone` 整份文档（只在"拒绝"路径才会读）——含 base64 图的大 notebook 会多一份同步全量拷贝 |
| **V7-13** | `scripts/linux-check.sh:16,20` | `WORK="${WORK:-…}"` 后 `rm -rf "$WORK"` **无任何校验**：`WORK=/` 或 `WORK=$HOME` 会递归删任意目录（脚本其余设计正确：只读仓库、写 `/tmp` 副本、失败可见） |
| **V7-14** | `tests/unit/analyze-op.test.ts:24,146,165` | 当 venv 不健康时 `rmSync(VENV_DIR, {recursive:true})`，而 `VENV_DIR` 来自**环境变量** `IPYNB_TEST_VENV` → 指向用户的真实 venv 就会被删；且"健康时永不清理"（状态表 TST-5 行"并清理"不实） |
| **V7-15** | `REVIEW-FIX-STATUS.md:17` vs `COMPATIBILITY.md:21,24` | **同一次验收的数字互斥**：状态表写单测 252 / 集成 46/46；COMPATIBILITY 写 **251（250+1skip）/ 45/45 / 20 文件**。**主审实测：252 / 46/46 / 24 文件** → COMPATIBILITY 是旧的 |
| **V7-16** | `scripts/check-indent.mjs:111-121,151-211` | v6 的 INDENT-HOLE **已真修**（子代理对抗矩阵 13/15 命中，含箭头/函数表达式/类属性/switch），仍漏两处：`if (a)\n return 1;`（无块体）与 `class C { static { … } }`；且 `checkBlock` 的注释声称支持"brace-less body"（与实现不符）。**自测机制经 3 个变异验证有效** ✓ |
| **V7-17** | `src/fs/atomic.ts:127` | 写路径的**第一个** syscall（`open(tmpPath,'wx')` 抛 `EACCES/EPERM`）不经 `translateLockError` → 冒泡成 `internal`（与"活过每个 syscall"的说法不符；可达性中低） |
| **V7-18** | `scripts/check-indent.mjs:314,321`、`tsconfig*.json` | 两个缩进/格式脚本都是 `.mjs`，**不在 `tsc` 覆盖内**（文件头已如实说明并以自测补偿）；`check-indent` 默认目标 `['src','tests']` 不含 `scripts`，与 `check-format` 的覆盖面对不齐 |

【WARN-CODE-2】
严重程度：🟡 警告
所在位置：`src/core/errors.ts:66`（`PREEXISTING_CONTENT_WARNING = 'file_changed_externally'`）；`SPEC.md:893`
问题描述：为解决"第 12 个码"而**复用** `file_changed_externally`，但该码在 SPEC §7 的定义是"**检测到外部改动**"，而实际触发是"文件里**本来就**有我们不会写的内容"——语义不同。
详细分析：这比 v6 的"自造码"好得多（闭集得以保持、注释也写明了理由），但**按该码分支的客户端/agent 会误判**：一个把 `file_changed_externally` 理解为"文件在我读之后被别人改了"的实现，可能据此丢弃 CAS 状态、重新读取或重试；而实际文件并没有被任何人改动。此外 `file_changed_externally` 在 `notebook_read`/`notebook_run` 的既有语义里另有所指（读时检测到外部改动）。
修复建议（择一，均需留档）：① 在 `docs/DEVIATIONS.md` 明确登记"本工具用 `file_changed_externally` 承载'保留了历史不合规内容'这一含义，因为它同样表示'内容来自本工具之外'"，并在 SPEC v3.1 建议清单里提请为该含义单列一个码；② 或在 message 里**首个词**固定为可机读标记（如 `pre-existing-content: …`），让客户端不必依赖码语义。
设计文档对齐：SPEC §7 的码定义；AGENTS §5（码只取自 §7——本轮做法合规，但需要一处偏离说明把"语义借用"讲清）。

【TRUNC-CODE】
严重程度：🟡 警告
所在位置：`src/core/outputs.ts`（值类型清洗策略）与返回的 `output_truncated`
问题描述：因 mime 值非法而被**丢弃**的输出，用 `output_truncated` 告知模型；而 SPEC §7 把该码定义为"任意一个 `OutputItem` 的 `truncated === true`（超 `inline_text_chars`）"，两者不是一回事。
详细分析（主审实测）：`display({'text/plain': 5}, raw=True)` 的 run 返回 `warnings=["output_truncated"]`，但没有任何 item 被截断，真实情况是"有一个 mime 值不符合 nbformat 被丢掉了"。模型（与按 §7 释义编程的客户端）会把这条警告理解成"输出被截断了"，而不会意识到**数据已被丢弃**——这正是 v6 GATE-5 的"静默"残影：文件不再非法了，但**丢弃不可见**。
修复建议：① 若清洗是"丢值保结构"，至少让 message 明确写"dropped N mime value(s) that nbformat forbids (rule …)"，并考虑用 `image_materialize_failed` 的同族语义（该码已表示"artifact 写入或图片解码失败"）；② 更好的做法是**不丢内容而拒绝写入**（我们引入的不合法形状应当 `selfcheck_failed`），因为丢弃是**对用户输出的静默改写**——AGENTS §10 明说除 `source`/`outputs`/`execution_count`/`cell_type` 外不得改动用户文件，而这里改的是 outputs 的内容。
设计文档对齐：SPEC §7 的 `output_truncated` 定义；AGENTS §10；SPEC §6 R2。

---

## 四、七个审查维度逐条覆盖

**1. 架构与模块对齐** —— 未发现明显问题
写前闸门的 scope 语义、值类型清洗、终态收口分别位于 `core/parse.ts`、`core/outputs.ts`、`mcp/run-store.ts`，职责清晰；`QUAL-2` 把共用的 abort 判定下沉到 `core/errors.ts`（唯一实现）**改善**了层次；`src/mcp/*` 仍未碰 `node:fs`，`core/*` 仍未 import `node:*`。`Dep-2` 用 `createRequire` 在 `server.ts` 读 `package.json` 属 IO——但它是**进程启动期的一次性读**，且 `server.ts` 是组装层（非 `core`），边界可接受。

**2. 代码质量与可维护性** —— 3 项（WARN-CODE-2 的语义借用、V7-3 fixer/guard 自相矛盾、V7-11 新增同款重复）
正面：新增注释普遍解释"为什么"（`check-indent.mjs` 写明上一轮 `IfStatement` 用错属性、`server.ts` 写明版本双真源的代价、`run.test.ts` 写明为何用子类而非 Proxy）；`check-indent` 的自检、`TST-2` 的 spy 都是高可维护性写法；`QUAL-2` 把 abort 判定合并进 core。
负面：**V7-3**（`fix-indent.mjs` 与 `check-indent.mjs` 对合法的一行 `case` 结论相反、fixer 25 轮不收敛并把文件改到 lint 失败）；**V7-11**（本轮一边合并 QUAL-2，一边在 `fs/` 里新增同款 `lockErrno`/`errnoCode` 重复）；`output_truncated` 的语义借用（TRUNC-CODE）。

**3. 健壮性与错误处理** —— 4 项（**V7-1 读方向静默改写/丢弃**、V7-7 归一化不完整、V7-8 `exec_timeout` 丢 warnings、V7-17 首个 syscall 不映射锁错误）
正面：**写方向**的 GATE-5/CRASH-1/GATE-6 三条全部闭合，且我做了反向对抗测试（合法值不被误伤）；`pre_existing`/`hint` 让拒绝自证身份；`RunStore.settle()` 让终态只有一个写者；锁重试有界且被真实独占句柄覆盖。
负面：**V7-1（🔴，我已复现）**读方向把 nbformat 合法的 `application/json` 静默改写（`[1,2,3]`→`123`）或丢弃（对象/数字/null/布尔），`warnings: []`；V7-7 归一化只覆盖 3 条新规则中的 1 条，另两类形状仍会让整次 run 的成果全丢；V7-8 超时响应漏掉本轮新收集的 warnings。

**4. 性能与资源效率** —— 1 项（V7-12：每次写入无条件 `structuredClone` 整份文档）
分帧仍线性（上轮实测 64 MiB 单行 53 ms，且用例已能因二次实现变红）；`#normCache` 按规范化值失效；解释器决策重构减少了"错误结论被缓存"的面。负面：`run.ts:377` 与 `mcp/tools/edit.ts:129` 的 `structuredClone` 是无条件的（只对"拒绝"路径有意义），大 notebook 每次 run/edit 多一份同步全量拷贝。

**5. 安全性** —— 3 项（**V7-4 `install_command` 注入**、V7-13 `rm -rf "$WORK"`、V7-14 环境变量驱动的 `rmSync`）
正面：连接文件仍 `mkstemp`(0600) + 三出口清理；参数上限齐备；`src/**` 无 `console.*`；stderr 与模型可见字段不含 cell 源码/输出；无新增 `spawn`/路径拼接面。
负面：**V7-4** 是本轮新引入的（探针把**外部进程的 stdout 原样**插进模型会被建议执行的 `install_command`，且无长度上限——实测可注入 `&& rm -rf …`）；V7-13/V7-14 是两个"环境变量驱动递归删除且无校验"的脚本/测试（`WORK=/` 或 `IPYNB_TEST_VENV=<真实 venv>`）。

**6. 测试覆盖与自测质量** —— 5 项（NBFORMAT 静默跳过、TST-3 真写守卫、TST-4 编号登记、**V7-5 集成 venv 仍在仓库**、V7-15 两文档数字互斥）
正面（本轮最大进步）：**CI 首次真跑**并因此发现 6 个真实缺陷；`pnpm smoke` 19/19；`check-indent` 自带 SELF-TEST 且经 3 个变异验证有效；`[TST-2]` 的 spy 有判别力；`[I18b]` 扩到三 cell；U20 不再 skip（单测 252 全绿）；`fix-indent` 在 63 个真实文件上零误改、CRLF 安全。
负面：`NBFORMAT_AVAILABLE` 的静默 if 仍在（CI 很可能没有 nbformat）；工具层 `markdown_invalid` 真写守卫仍缺；DEVIATIONS 无测试编号条目；**V7-5** 5 个集成文件仍往仓库里建 18.3 MB venv（文档说已删除）；**V7-15** 两份文档对同一次验收给出互斥数字（252/46 vs 251/45，我实测前者对）。

**7. 依赖与配置** —— 5 项（NEW-2 分工、CI 未装 nbformat、**V7-6 PATH 候选丢 not-found**、V7-9 `absolutePath` 死参数、V7-10 `JSON_MIME` 比权威严）
运行期依赖仍只有 SDK（零新增）；`prepack` 已是 `tsc`。负面：`mode`/`include_source`/`include_outputs`/`action` 的 schema 层分工不一致且未登记；CI 的 `pip install ipykernel jupyter_client` 未含 `nbformat`；**V7-6** 不存在的解释器被报成缺 ipykernel 并给出装不了的命令（违反 SPEC §5.2 明文）；**V7-9** `absolutePath()` 的 `platform` 是死参数且行为与注释相反（Linux 上 `C:/x/y` 会被当绝对路径）；**V7-10** `JSON_MIME` 比 nbformat 的 `patternProperties` 严（`application/x/y+json` 被丢/拒）；`AGENTS.md` 在工作树里未提交。

---

## 五、总体评估

### 1. 整体质量评级：**C（需返工）**

> **评级依据（与 v4/v6 同一把尺子）**：只要存在一条**已实测复现**的"静默给出错误数据 / 静默丢弃合法数据"的缺陷，就不算"小修后可合并"。本轮**新增**了这样一条 **V7-1（🔴）**——它是子代理发现、**由我独立复现**的：读方向会把 nbformat **合法**的 `application/json` 值静默改写（`[1,2,3]` → `123`）或整体丢弃（对象/数字/null/布尔 → `unsupported, mime_type:"unknown"`），且 **`warnings: []`**。

**必须先说清楚本轮的真实进步（这是七轮里质量最高的一轮）**：
1. **v6 的两条 🔴/🟠 全部真修**，我用的**是当初发现它们的同一探针**（GATE-5、GATE-6、GATE-1 语义、NEW-5 的 progress/终态），不是"换一套测试自证"；我另加的反向对抗测试（5 种**合法** mime 形态）也通过——**写方向与 `nbformat` 逐条对齐**（子代理的 26 样本对照：所有被接受的写入都判 VALID）。
2. **CI 首次真跑**（发现 8 个失败全在非 Windows）→ 新增 `scripts/linux-check.sh`，WSL 实跑 238 passed + 1 skipped。我前几轮一直把它列为"发布前最后两道门"之一。
3. **CI 首次真跑，且可外部核验**：子代理用 GitHub 公开 API 核到 `origin=https://github.com/3021244161/ipynb-mcp.git`、`main == origin/main @1209164`、**run 37136146902 `conclusion=success` / 9 个 job**（5 unit + 4 integration，含 `pip install ipykernel jupyter_client` + `pnpm test:integration`）；配合 `scripts/linux-check.sh`（WSL 实跑）。"CI 从未跑过"这个缺口本轮**确实关闭**了。
4. **⚠️ 更正我报告初稿的一句话**：我初稿写"本轮没有虚报（v3 以来第一次）"——那是基于**第一路**子代理的抽样。**第二路**子代理逐行核对状态表，发现**三行"声称已修但代码里没有"**（见 §3.3），所以这句话**作废**：本轮并非无虚报，只是虚报集中在状态表的三行上。同时它确认了另外几条声称**属实**（第三轮段 4 处旧 ✅ 已订正、v6 的 19 个编号在 §6.2 全部有行、v5 的 18 条在 §〇-A 补齐、DEP-2 打包后可解析、`SCOPE-REFUSE-HINT`/`SCOPE-SUCCESS-INVALID` 实测吻合）。

**为什么仍是 C**：除 V7-1 外，收口不全的面偏大——**6 条 🟠**（V7-2 `output_truncated` 语义错位且一次发 2–3 条、V7-3 `fix-indent` 在一行 `case` 上震荡不收敛并把文件改到 lint 失败、V7-4 探针 stdout 原样注入 `install_command`、V7-5 集成测试仍在仓库里造 18.3 MB venv 而文档说已删除、V7-6 不存在的解释器被报成缺 ipykernel 并给出装不了的命令、加上我 v7 自己列的 NBFORMAT 静默跳过与 NEW-2 分工漂移），另有约 10 条 🟡。这些**单条都很小**，但合起来意味着"值类型/契约/验证能力"这三条线上还有未兑现的承诺。

### 1b. 评级与上轮的对比（避免误读）

| 轮次 | 评级 | 主因 |
|---|---|---|
| v5 | C | 写入方向静默改坏（FID-1 类）+ 两个守卫名不副实 |
| v6 | C | 新引入 GATE-5（闸门漏 mime 值类型，静默写坏）+ 10/18 未处理 |
| **v7** | **C** | **读方向静默改写/丢弃合法 `application/json`（V7-1，已复现）**；但**写入方向与全部 v6 🔴/🟠 已闭合**，且本轮无虚报 |

即：**评级没变，但性质变了**——前几轮是"承诺没兑现"，本轮是"同一件事只做了一半（写方向做了、读方向没做）"，且缺陷本身是**既有**的（`dataValueToString` 早于本轮）。这也是我把它放在 TOP-1 的原因：改它不动任何对外契约。

### 2. TOP 3 必须优先修复

| # | 事项 | 为什么 | 修复量 |
|---|---|---|---|
| 1 | **V7-1（🔴）读方向的 `application/json`**：`RawOutput.data` 放宽到 `unknown`，对 `isJsonMime(mime)` 的值**原样保留**，json 分支直接产出 `kind:"json"` | 唯一一条**静默给错答案**的缺陷：合法 `[1,2,3]` 变成 `123`、对象/数字/null/布尔直接消失，且 `warnings: []`。本轮专门为写方向立了 json 豁免并把契约写进闸门/用例，读方向必须同时兑现 | 中（类型 + 2 个分支 + 用例，不动对外契约） |
| 2 | **三行虚报 + 让外部权威在 CI 上真的跑（🔴 P0，过程问题）**：订正 `REVIEW-FIX-STATUS.md` 的 `:52`/`:60`/`:63`；CI 的 integration job 显式 `pip install nbformat`（或在 `CI=true` 时对"权威缺席"硬失败），并把 NBFORMAT 那两条改成会显示 `skipped` 的显式 skip | ① 状态表三行声称已修而代码里没有，**连续第二轮**同形；② 更实质的是：**唯一的外部权威在唯一的自动化环境里恒缺席且绿灯无痕**——"CI 全绿"目前**不代表** nbformat 校验跑过（子代理用 `importlib.metadata` 闭包证明 CI 里 `nbformat in closure: False`，并用变异证明断言无声消失） | 极小（改 YAML + 2 行测试 + 3 行文档） |
| 3 | **V7-3 + V7-2（🟠）**：① `fix-indent`/`check-indent` 对合法单行 `case` 结论相反（fixer 25 轮不收敛并把文件改到 lint 失败）→ 两处都加"语句独占本行"守卫；② `output_truncated` 一次发 2–4 条且语义不符 §7 → run 侧去重 + 把"只追加一次"写进 D-040（分码需人类裁决） | ① 是本轮 364 行重写的守卫体系里**唯一自相矛盾**处，且 fixer 会**主动改坏**工作树；② 这条提示是模型**唯一**能知道"值被丢了"的信号，现在语义错位又重复 | 小（各 3–5 行 + 1 条自测样例） |

紧随其后（按子代理与我的一致排序）：**P1-a cell 级 `execution_count<0` 进闸门**（我已复现：编辑后文件仍 INVALID 且无警告，与 D-037 ②矛盾）→ **P1-b 响应侧 `OutputItem.text` 非字符串**（我已复现 `text: 5`，GATE-5 的窄化只做了写盘方向）→ **P1-c 工作目录 45 个含 HMAC key 的连接文件 + `sidecar-transport.ts:121` 的 env 整体替换**（我已复现 45+15 个残留）→ **V7-4**（`install_command` 注入，一行白名单）→ **V7-5**（集成 venv 仍在仓库，文档说已删除）→ **V7-6**（PATH 候选丢 not-found）→ **V7-8 / exec_timeout 丢 warnings** → **NEW-2 登记或撤回** → **V7-7 / V7-9 / V7-10 / V7-11 / V7-12 / V7-13 / V7-14** → 文档数字与 `AGENTS.md` 未提交改动。

### 3. 与原始设计文档的偏离清单

| 偏离 | 性质 | 状态 |
|---|---|---|
| 闸门只审本次写入负责的 cell（历史内容保留并告警） | 行为偏离（已登记 D-037） | ✅ 保持 |
| 闸门按 `nbformat_minor` 对齐 nbformat 的放宽规则 | 与权威对齐 | ✅ 已修 |
| **mime 值非法时"丢值保结构"** | **对用户 outputs 的静默改写（AGENTS §10 / R2 的精神）** | 🟡 TRUNC-CODE（建议改为拒绝写入） |
| **用 `file_changed_externally` 承载"保留了历史不合规内容"** | 语义借用（码在 §7 闭集内，但定义不同） | 🟡 WARN-CODE-2，建议登记 DEVIATIONS |
| `mode` 走 schema enum → 值级违规返回协议错误 | 与 SPEC §4.1.12 的 `invalid_arguments` 映射不一致 | 🟠 NEW-2 未收口 |
| nbformat 缺失时 `[FID-1]/[FID-3]` 静默跳过 | 验证能力缺口（且 CI 很可能命中） | 🟠 NBFORMAT-GATE-SILENT 未修 |
| `SelfCheckScope.touchedCellIndexes` 缺省 = 整份文档 | 危险缺省值 | 🟡 SCOPE-DEFAULT 部分 |
| D-033 的"约 5 s"与实测 +10.4 s 不符 | 文档口径 | 🟡 部分订正 |
| **读方向丢弃/改写合法的 `application/json`** | **违反 SPEC §5.4 第 7 行 + §6 R2（对模型给出错误答案）** | 🔴 V7-1 待修 |
| **探针 stdout 原样进入 `install_command`** | 安全（模型会被建议执行被注入的命令） | 🟠 V7-4 待修 |
| **`fix-indent` 与 `check-indent` 对合法一行 `case` 结论相反** | 工具自相矛盾 + 把工作树改到 lint 失败 | 🟠 V7-3 待修 |
| **`output_truncated` 一次调用发 2–3 条** | 违反 SPEC §7"只追加一次"与 U21b | 🟠 V7-2 待修 |
| **集成测试仍在仓库内建 18.3 MB venv，文档称已删除** | AGENTS §9 + 文档与事实相反 | 🟠 V7-5 待修 |
| **不存在的解释器被报成缺 ipykernel + 给出装不了的命令** | 违反 SPEC §5.2 明文 | 🟠 V7-6 待修 |
| `JSON_MIME` 比 nbformat schema 严；`absolutePath` 的 `platform` 是死参数 | 与权威/注释不符 | 🟡 V7-10 / V7-9 |

### 4. 后续开发建议

- **把"CI 必须有一条会失败的权威校验"作为规则**：NBFORMAT 这件事说明"外部权威"如果只是**可选**的，就会在裸机上退化成"什么也没查"。建议在 CI 里加一条自检：`assert nbformatAvailable()`（或缺它就红），与 `IPYNB_TEST_REQUIRE_VENV` 同型。
- **值清洗要有可见的账**：任何"因为格式非法而被丢弃"的输出，都应在返回里给出**计数与规则**，并考虑改为拒绝写入（我们引入的非法形状不该由我们静默修剪用户数据）。
- **文档可信度再收一道**：本轮仍有 2 行"声称已做但代码里没有"（NBFORMAT 的 `it.skip`、TST-4 的 markdown 真写守卫）。状态表头自己定的规则是"未做或未验证的条目一律标 ⬜/⚠️"，建议加一步**自检**：每条 ✅ 必须附一个可 grep 的实体（用例名/文件:行/命令）。
- **测试补强**：工具层 `markdown_invalid` 真写用例；`move_cell` 越界与 `ChangedCell.content_changed` 的边界用例；`SCOPE` 缺省值的守护用例（或直接删掉缺省）。
- **仍缺（发布前最后一道门）**：**E1–E9 真实第三方客户端**（`docs/E2E-CHECKLIST.md` 证据列仍空）。CI 这一道本轮已落地，值得在 COMPATIBILITY 里保留首跑记录与失败清单。

---

## 附录：验证分工与局限

- **主审亲验（一手证据）**：六道门禁实跑（typecheck/lint/unit **252**/integration **46/46**/smoke **19/19**/build）；**用 v6 的同一探针复跑** GATE-5、CRASH-1、GATE-6、GATE-1 语义四条、NEW-5 的 progress/终态；**新增反向对抗测试**（5 种合法 mime 形态是否被误伤）；**新增读方向对抗测试**（7 种 nbformat 合法的 `application/json` 形态，复现 V7-1）；`check-indent.mjs` 的逐构造对抗测试（if/else/箭头/方法/switch 全命中）；依赖元数据核对（`Requires-Dist` 证明 `jupyter_client`/`ipykernel` 不依赖 `nbformat`）；V7-2/V7-5/V7-6 的代码与磁盘核对；两文档数字互斥（以我的实测为准）；`[I18b]` 三 cell 与 `markdown.test.ts:158` 的实际调用路径（`applyEditOps`，非工具层）；工作树未提交项（`AGENTS.md`）。
- **子代理复核（两路；② 已完整并入，① 仍在收尾）**：
  **② 新问题猎取（已并入）**：真 stdio 黑箱 2 场 + 产品函数直驱 **26 样本 × `nbformat 5.9.2` 双向对照** + 解释器决策黑箱 + 缩进守卫/修复器的变异与对抗矩阵（含 CRLF）+ 单文件集成实跑。它给出的**阴性结论（我按证据采信）**：写方向的值类型处理**真修好了**（26 样本里所有被产品接受的写入都判 VALID；`application/json` 任意类型、`text/plain`/`text/html`/`text/markdown` 字符串数组、`image/png` 字符串/数组/data-URL、300 KB base64、`stream.text`/`traceback` 数组全部不漏）；锁重试**有界**（`[10,20,40,80,120,160,160,160]` + 750 ms 窗口，实测 `locked-file.test.ts` 2/2 exit 0，真独占句柄）；终态收口正确；`initialize` 版本 == `package.json`；CI 矩阵与 SPEC §9/C1 一致；`smoke` 19/19 属实；stderr 无 cell 内容；连接文件 0→0、无 kernel 残留；`check-indent` 的自测经 **3 个变异**全部变红（AGENTS §9 在这条守卫上成立）；`fix-indent` 在 63 个真实 `.ts` 上**零误改**、CRLF 安全。**并且它明确报告：在它抽查的范围内没有发现虚报**（DEP-2、`[W1b]`、smoke、CI 矩阵、守卫自证均属实）——**但请注意**：另一路（①，见 §3.2）在同一份状态表上查出**三行**"声称已修但代码里没有"，所以"本轮无虚报"这个结论**不成立**，只是在第二路的抽样范围外。这两路的差异本身就是一条信息：**虚报集中在状态表里那些没有对应守卫的条目上**（NBFORMAT 的 skip、NEW-6 的 timeout 路径、D-033 的数字），而有守卫的条目（DEP-2、smoke、W1b）都经得起抽查。
  **① v6 修复的深度核实（仍在收尾）**：值类型覆盖是否完整、`pre_existing` 判定、`check-indent`/`fix-indent` 正确性、解释器决策重构、锁重试、打包后 `package.json` 可解析性、CI/Linux 记录。其结论落地后并入本报告。
- **主审独立复现的关键项**：V7-1（读方向 json 改写/丢弃，我另加了 7 种合法 json 形态的对照）、V7-2（两次 push、无去重）、V7-5（`tests/.venv-test` 18.3 MB 仍在 + 5 个集成文件仍用仓库路径 + 文档口径互斥）、V7-6（读码确认 PATH 候选的无条件 `installCommand`）、V7-15（两文档数字互斥——**我实测 252 / 46/46 / 24 文件**，COMPATIBILITY 的 251 / 45/45 / 20 文件是旧的）。
- **局限**：① 未做 macOS 与真实 GitHub runner 实跑（我的判断基于 `Requires-Dist` 与 workflow 文件，**不是** CI 日志）；② E1–E9 仍未验；③ `[TST-2]` 的 `acquired/released` 断言我读码确认了形态，**未自己做变异**（子代理在做）；④ 我未逐个核对 CI 首跑记录里 1a-4 的修复细节（只确认它们在 diff 与状态表里，且门禁全绿）。
