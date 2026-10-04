# ipynb-mcp 代码审查报告（第十轮 / v10）

> **审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp` @ HEAD `08f4211`（v9 整改后，**7 个提交**；工作树**干净**）
> **上轮基线**：`c78e36f`（v9 报告：`docs/review/ipynb-mcp-code-review-v9.md`）
> **方法**：主审亲跑全部门禁（含新挂进 lint 的文档检查器）+ **自建 5 组探针**（图片形状矩阵 17 例 / json 数值边界 11 例 + 写回 4 例 / base64·data-URL 边界 8 例 / 嵌套精确数 / 超时与 hint 会话）+ 两路独立复核
> **日期**：2026-10-04

---

## 一、门禁实测（主审亲跑）

| 门禁 | 实测 | 变化 |
|---|---|---|
| `pnpm typecheck` | exit 0 | ✅ |
| `pnpm lint` | 0 警 + `format check: ok` + `structural indent check: ok (28 self-test samples)` + **`documentation check: ok (1 authority document(s), SPEC §12 verbatim)`** | ✅ 新增两个自检面 |
| `pnpm test` | **432 passed（28 文件）** | ↑ 381→432 |
| `pnpm test:integration` | **50 passed / 50**，7 文件，239 s，`VITEST_EXIT=0` | ↑ 46/6→50/7 |
| `pnpm smoke` | **26/26**（含客户端层图片块断言） | ↑ 19→26 |
| `pnpm check:package` / `npm pack` | **140 文件、无 `.pyc`、含 `lib/bin.js`** | ✅ |
| `node scripts/check-docs.mjs --selftest` | **7 个变异全部检出，control clean** | ✅ 新 |
| 工作树 | **干净** | ✅ |
| **CI 覆盖面** | unit job：typecheck → lint → test → build；integration job：typecheck → build → **`check-connection-sweep.py`** → **`check:package`** → **`smoke`** → test → test:integration；`pip install ipykernel jupyter_client nbformat` + `IPYNB_REQUIRE_NBFORMAT=1` | ✅ **我前几轮标的"smoke 不在 CI"已关闭** |
| **发布闸门** | `prepublishOnly` = `typecheck && lint && test && check:package` | ✅ 新 |

---

## 二、v9 问题闭环核查（**逐条亲验：11 条真修、2 条部分**）

| v9 项 | 结论 | 主审证据 |
|---|---|---|
| **V9-1**（🔴 data-URL 图片让 read/run 双双 `-32602`） | ✅ **真修复（两条路径）** | **17 形状矩阵无一失败**：合法 base64 / data-URL（合法载荷、**空载荷**、**标签不符** `image/jpeg` 挂 png 键、字符串数组）/ 无 padding / 载荷含换行 / `data:;base64,` / 前缀后空隙 → 该成功的成功（`bytes=70`、artifact、块通过 `atob`），该降级的降级（`bytes=0` + `image_materialize_failed`，**不再静默**）：空串 / 纯空白 / 非 base64 / 数字 / `null` / 对象 / 大写 `DATA:` / `data:` 带参数 / payload 含逗号。**run 路径**：真 kernel `display({'image/png': 'data:…'})` → `kind=completed`、`write_back=true`、`blocks=[text,image]`、块合法 ✓。**放大器已消失**（集成新增 `[V9-1] the failed-run amplifier is gone: the file it wrote is readable again` ✓） |
| **V9-2**（🟠 只测投影不测内容块） | ✅ **真补** | smoke 26 项含 `every returned image block carries SDK-valid base64`、`the run image block decodes to the PNG that was displayed`、`the artifact behind the returned block is the same PNG`；新增 `tests/unit/image-blocks.test.ts`；集成 `[V9-1]` 用例 |
| **V9-3**（🟠 不合法块不该让整个调用失败） | ✅ **真修** | **D-047**："内容块的 `data` 一律由**已解码的字节**重新编码产生，不再回读文档原值；`result.ts` 组装前做 base64 合法性检查，不合法的块**丢弃并追加 `image_materialize_failed`**，绝不把畸形值交给 SDK"——与我的建议一致；15 种畸形形状实测**无一让调用失败** ✓ |
| **V9-5**（🔴 大整数 JSON 被静默改写） | ⚠️ **部分**（整数修好，小数与嵌套没修 → V10-3 / V10-1） | **整数、盘上逐字节保真** ✓（`2**64`/`2**53+1`/`10**30` 四个边界实测 `disk-exact=true`、`rounded=false`；顶层读出带含精确数字的警告）；**但**：① **小数**在盘上被静默改写（V10-3，🔴）；② **嵌套**的标记对象直接漏给模型且无警告（V10-1） |
| **V9-6**（🟠 `DEVIATIONS.md` 被拼接损坏） | ✅ **真修 + 有守卫** | 55 行、`D-001` **仅 1 次**、49 个编号**全部唯一**；新增 `scripts/check-docs.mjs`（挂进 `pnpm lint`，含 `--selftest`：**7 个变异全部检出**）；新增 **D-047/D-048/D-049** |
| **V9-7**（🟠 超时丢 warnings + 丢 cell 身份） | ✅ **真修** | 真 kernel 实测 `exec_timeout` 的 `detail` 键含 `warnings`，内容 `dropped 1 mime value(s) nbformat cannot store (cell 0: text/plain)`——**同时带 cell 与 mime** ✓ |
| **V9-8**（🟠 hint 与行为不符 + 另一条规则推荐无效 op） | ⚠️ **部分**（行为修好，hint 文案仍过头 → V10-4） | 负计数 cell：`clear_outputs` → `applied=1`，**之后的 `replace_source` 也被允许**（v8 那种"照提示做完又被拒"消失）✓；带 outputs 的负计数**仍被拒** ✓；markdown cell 的 hint 改为**先给可用操作** ✓（实测 markdown 上 `clear_outputs` = `invalid_ops`，hint 已如实说明）。**但** hint 的结论句"**so the file becomes valid**"不属实：`clear_outputs` 后盘上 `execution_count` 仍 -1、`nbformat.validate` 仍 **INVALID**（V10-4） |
| **V8-8**（`linux-check.sh` 的 `..` 绕过） | ✅ **真修** | 现在 `readlink -m` 归一化（`-f` 回退 + `IPYNB_SELFTEST_MUTATE=no-readlink-flag` 让回退可测），并额外拒绝含 `..` 的 `HOME` ✓ |
| **V8-11**（权威问错解释器） | ✅ **真修** | `run.test.ts` 改用 `authorityInterpreter()`（`:923/:961/:972/:994`）✓ |
| **V8-12**（共享 venv 的删除时机） | ✅ **真修** | `vitest.config.ts:15 fileParallelism: false`；`analyze-op` 不再无条件 `afterAll` 删除 ✓ |
| **V8-4 / V8-17**（不能失败的守卫） | ✅ **已处理** | `check-indent` 自测样例 25→**28**；`check-docs` 带 7 变异自测；`check-connection-sweep.py` 与 `check:package` 都进了 CI |
| 根目录一次性脚本 | ✅ **已清** | `git ls-files` 中 `mutate-*`/`probe-*`/`patch-*` **全部为空** |
| 文档数字 | ✅ **准确** | `REVIEW-FIX-STATUS.md` / `COMPATIBILITY.md` 写的 **432 / 28 文件**、集成 **50 / 7 文件**、smoke **26/26**、`check:package` **140 文件**与我的实测**逐项一致**（旧快照也已标注为"第六轮当时的快照"） |

---

## 三、本轮新发现

【V10-1】
严重程度：🟠 严重（**按"静默给模型错数据"的判据接近 🔴**；触发窄、盘上无损、精确数字仍随值返回）
所在位置：`src/core/outputs.ts:483-497`（`jsonValueOf` **只处理顶层值**）· 相关：`src/core/json-exact.ts:26-41`（`ExactNumber` 标记）、`:311/:346`（读写两侧的递归处理）
问题描述：**嵌套在数组/对象里的大整数会把内部标记对象直接交给模型，且没有任何警告。**
详细分析（**主审实测**，同一份文件两种形状对照）：
```
顶层  application/json: 9007199254740993
  item = {"kind":"json","value":9007199254740992,
          "warnings":[{"code":"output_truncated","message":"json value 9007199254740993 is outside the
                      range this tool can represent exactly; the exact digits are in this warning …"}]}   ✓ 已定义（D-048）

嵌套  application/json: {"n":9007199254740993,"list":[18446744073709551616],"ok":1}
  item = {"kind":"json","value":{"n":{"__ipynb_exact_number__":"9007199254740993"},
                                 "list":[{"__ipynb_exact_number__":"18446744073709551616"}],"ok":1},
          "warnings":[]}                                                                                  ✗ 无警告
  call-level warnings = []                                                                                ✗ 无警告
```
机制：`jsonValueOf` 只在 `isExactNumber(value)` 为真（**顶层**）时转成"舍入数 + 警告"；否则 `value as JsonValue` **原样透传**，容器里的 `ExactNumber` 标记就漏了出去。写回侧 `stringifyJsonExact` 是递归的，所以**盘上无损**（实测 `disk has 18446744073709551616 = true`、`rounded = false`）——问题只在**模型可见的那一份**。
影响：① 模型会认为该输出里有名为 `__ipynb_exact_number__` 的**对象**（凭空多出的结构），而文件里是数字；② 这个标记名在任何文档里**都没有定义**（我 grep 了 `SPEC.md`/`README.md`/`AGENTS.md`/`docs/**`：0 命中，**连 D-048 也没提**），所以模型无法判断它是内部表示；③ D-048 自述的不变式②"模型能拿到精确数字**并知道它不精确**"对嵌套情形**不成立**。
修复建议（约十来行）：把 `jsonValueOf` 改成**递归**——遇到 `ExactNumber` 就地替换为 `Number(literal)` 并收集一条警告（同一字面量去重），返回 `{ value, warnings }`；`collectOutputWarnings` 已有的"按 message 去重 + 升格"逻辑无需改。补两条用例：`{"n":2**53+1}` 与 `[2**64]`，断言"响应里没有 `__ipynb_exact_number__` 字样"+"警告数 ≥1"+"message 含精确数字"。若决定保留标记形状，则必须**写进 D-048 与 README 的已知行为**并给出字段名。
设计文档对齐：SPEC §5.4 第 7 行、§6 R2「不静默改坏」、D-048（其不变式②）。

【V10-2】
严重程度：🟢 建议（同一族，触发面更小）
所在位置：`src/core/json-exact.ts` 的 `losesPrecision` / `parseJsonExact` 与图片侧的 `stripDataUrlPrefix`（对照）
问题描述：三处**宽容度不一致**，都可被"用户粘贴的东西"碰到，但都只降级、不失败：
- `DATA:image/png;base64,…`（**大写**前缀）→ 不剥前缀 → 0 字节图片 + `image_materialize_failed`（`data:` 小写则正常）；
- `data:image/png;charset=utf-8;base64,…`（带参数）→ 同上；
- `1e400`（超出 double 的字面量）→ 顶层读成 `null` + 警告（不精确，但**不是** `Infinity`，语义上"变成 null"比"变成极大值"更意外）。
修复建议：前缀匹配改大小写不敏感并容忍 `;` 参数；`1e400` 走与整数相同的"原文保真 + 警告"通道（或明确在警告里说"该值超出 double，已按 null 呈现"）。都是几行，且各自补一条用例。
设计文档对齐：SPEC §4.4、§5.4。

【V10-3】
严重程度：🔴 阻塞（**编辑一个无关 cell，会把别处的高精度小数在盘上静默改写**）
所在位置：`src/core/json-exact.ts:55-63`（`losesPrecision` 只判"看起来是整数的字面量"）· `:274`（`return losesPrecision(literal) ? exactNumber(literal) : Number(literal)`）· 由写入侧的全量重序列化触发
问题描述：文件里 `application/json` 的**小数**字面量在一次**与本 cell 无关的编辑**之后被静默改写，`warnings: []`。
详细分析（**主审实测**：cell 0 的 outputs 放高精度小数，编辑 cell 1 的源码）：
```
0.1234567890123456789012345   --edit cell 1-->   0.12345678901234568     warns=[]
1.0000000000000001            --edit cell 1-->   1                       warns=[]
3.141592653589793238462643383279 --edit cell 1--> 3.141592653589793      warns=[]
对照组：9007199254740993（整数）/ 0.1 / 1e400 → 盘上保持原文 ✓  ← 只保护了整数形态
```
机制：`losesPrecision` 只对**整数字面量**返回真，其余字面量走 `Number(literal)`；而任何写入都会**重序列化整份文档**，于是所有 >17 位有效数字的小数在盘上被规范化成 double 的最短表示。**这是 v9 V9-5 修法的盲区（同一族又只修了一半：整数修了、小数没修）**，而且后果比原来那一半更重——它改的是**本次编辑没有触碰的 cell 的内容**。
影响：违反 SPEC §6 红线"不改动用户文件里的任何东西，除：被执行/编辑 cell 的 source/outputs/execution_count/cell_type"（这里改的是**另一个 cell** 的 outputs 值）与第一条卖点"不会静默改坏"；`display({'application/json': {'pi': 3.141592653589793238462643383279}}, raw=True)` 这样的普通用户代码就能造出这个形状。
修复建议：把"原文保真"的判据从"整数"扩到"**任何 `String(Number(literal)) !== literal` 的字面量**"（含小数、指数、超范围值），即：
```ts
export function losesPrecision(literal: string): boolean {
  const asNumber = Number(literal);
  return !Number.isFinite(asNumber) || String(asNumber) !== literal;
}
```
（注意 `0.1` 的 `String(Number('0.1')) === '0.1'` → 不触发 ✓；`1e400` → `Infinity` → 触发 ✓）。同时补两条用例：编辑无关 cell 后断言"盘上仍是原字面量"，以及 `1.0000000000000001` 的 read→edit 往返。**先补用例（会红）再改**。
设计文档对齐：SPEC §6 R2 与红线列表、D-048（其不变式①"盘上的值逐字节保留"对小数**不成立**）。

【V10-4】
严重程度：🟠 严重（hint 承诺"文件会变合法"，而 nbformat 判它不合法）
所在位置：`src/core/parse.ts:288-302`（`escapeHatchFor` 的 `execution_count_negative` 文案）· 对照 `tests/unit/edit-tool.test.ts:519`（用 `findStructuralProblem()` 当"合法"判据）
问题描述：hint 全文写"…once the outputs are gone the count is no longer checked, **so the file becomes valid**"，而实测 `clear_outputs` 之后盘上 `execution_count` **仍是 -1**、`nbformat.validate` **仍然 INVALID**（`-1 is less than the minimum of 0`）。
详细分析（**主审实测**）：
```
hint = "this cell already violated execution_count_negative before the change; clear_outputs does not
        change the count itself, but once the outputs are gone the count is no longer checked,
        so the file becomes valid; set_cell_type to markdown removes the count entirely"
clear_outputs -> applied=1 | 盘上 execution_count=-1 outputs=0 | nbformat = INVALID
```
前半句（"does not change the count itself"）是诚实的 ✓，错在结论：它把**本工具闸门的判据**说成了**文件合法性**。SPEC 的判准是 nbformat，而 README 早已如实写"编辑成功不保证文件合法"——两者矛盾。测试之所以绿，是因为用例用 `findStructuralProblem()` 自证（工具自检 ≠ nbformat），这与 V7-8/V8-14 同一族。
修复建议：把结论句改成"本工具的检查不再拦它；`execution_count` 仍在文件里，`nbformat.validate` 仍会拒绝它，直到计数被清掉（`set_cell_type` 到 markdown 会移除计数）"；并把该用例的判据换成真 `nbformat.validate`（集成层已有权威，单测可用既有的 validator 抽象）。另外：`selfcheck_failed` 首次拒绝路径（调用方未传 `originalDoc`）目前**不带 hint**，建议一律带上按规则生成的 hint；`expect(hint).toContain('clear_outputs')` 会被否定句命中，也该换成行为断言。
设计文档对齐：SPEC §4.1.11（失败一次可重试）、§4.5 规则 5、README 的"编辑成功 ≠ 文件合法"、D-049。

【V10-5】
严重程度：🟡 警告（验证能力的残留，来自子代理变异）
所在位置：`src/run.ts:47-61`（`pushCallWarnings` 是 run 警告的**唯一装配点**）· `:376/:594` 与 `tests/unit/run-reporting.test.ts:287` 注释里把它叫作**不存在的符号** `callWarnings` · `tests/unit/json-exact.test.ts:94`（`Number(literal) !== NaN` 恒真）· `scripts/check-docs.mjs` 的 gap 规则
问题描述：① **把 `pushCallWarnings` 整个短路，432 条单测全绿**——run 的警告装配在单元层**没有任何行为级判据**，唯一能抓它的是集成 `v9-regressions.test.ts [V9-7]`；② 注释引用了不存在的符号名（三处）；③ 一条恒真断言；④ `check-docs` 删掉**最后一行**（D-049）不报错、追加 `D-050` 也不报错（gap 规则只查"编号跳跃"）；⑤ `tests/unit/edit-tool.test.ts` 仍用 `expect(hint).toContain(...)` 钉文案（否定句也会命中）。
详细分析：这正是"守卫必须自证能失败"尚未覆盖到的最后几处——现象本身都不影响用户，但**下一轮若有人删掉装配点，只有集成会红**（而集成本地可能不跑）。
修复建议：把 `run.ts` 的出口警告装配抽成 core 的纯函数（输入 executed + dropped + truncated，输出 warnings），用真输入直接断言；三处 `callWarnings` 改名；删/改恒真断言；`check-docs` 补"末行缺失 + 最大编号 vs 期望下一条"；hint 类断言改成"按 hint 操作后文件/状态确实改变"。
设计文档对齐：AGENTS §9（守卫必须自证能失败）。

---



【V10-6】
严重程度：🔴 阻塞（**本轮新引入的回归：`__proto__` 键被静默删除，且对象能被写成裸数字**）
所在位置：`src/core/json-exact.ts:142`（`result[key] = this.readValue()`）· `:31-37`（`isExactNumber` 沿原型链判定）· 受害路径 `src/core/parse.ts:47-53`（读入）与 `:133-135`（序列化）、`src/kernel/protocol.ts:184-190`
问题描述：`parseJsonExact` 用普通对象承接键值，`result['__proto__'] = v` 触发的是 **`Object.prototype` 的 `__proto__` setter**（而不是定义自有属性）→ ① **该键消失**（模型看不到）；② **对象原型被文件里的值污染**；③ 写入时 `Object.entries` 只看自有属性 → **该键从用户文件里被删除**；④ 被污染的原型能让 `isExactNumber` 命中，于是**一个对象被写成裸数字**。
详细分析（**主审实测，真 stdio + SDK**）：
```
文件：cell0.metadata = {"__proto__":{"polluted":1},"keep":"me"}
      cell0.outputs json = {"__proto__":{"injected":true},"safe":1}
before: 文件里 "__proto__" x2
read  : isError=false warnings=[]   模型看到的 json 值 = {"safe":1}        ← 键消失
edit  : 编辑【无关的 cell 1】→ applied=1 warnings=[]                        ← 什么也没告诉模型
after : 文件里 "__proto__" x0        keep:"me" 仍在、文件仍通过 nbformat    ← 键被删除且无人报警
```
marker 伪造（**主审实测**）：
```
文件: {"application/json": {"__proto__": {"__ipynb_exact_number__": "42"}, "a": 1}}
read: {"kind":"json","value":42,"warnings":[{"code":"output_truncated",
       "message":"json value 42 is outside the range this tool can represent exactly; …"}]}
```
即：文件里明明是**对象**，模型收到**数字 42** + 一条完全虚构的"精度警告"；写回时该对象会被替换成 `42`（仍是合法 JSON，自检与 `nbformat.validate` 都不会报警）。
**这是本轮新引入的回归**：上一版实现用 `JSON.parse`，它把 `__proto__` 当作普通自有属性（正确）；换成 `parseJsonExact` 后丢了这一语义。整份 notebook 都走这个解析器，所以 `metadata`、cell `metadata`、`outputs` 里任何位置的 `__proto__` 都会中招。
影响：直接违反 SPEC §6 R2「不静默改坏」与 AGENTS §10「不要改动用户文件里的任何东西」；证伪 D-044「**所有** json mime 的值在读方向**原样保留**」与 D-048「原文保真」；也是最坏的一类——**在盘上删用户数据**。
修复建议（两条都要）：
```ts
// ① 定义自有属性，而不是走 setter
Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
// ② marker 不可伪造：改成 class ExactNumber + instanceof（或 Symbol 键）
class ExactNumber { constructor(readonly literal: string) {} }
export const isExactNumber = (v: unknown): v is ExactNumber => v instanceof ExactNumber;
```
③ 补用例：`__proto__` 出现在 **metadata / cell metadata / json 输出 / 数组元素** 四处，断言"read 原样 + 写回字节不变 + `nbformat.validate` 通过"；再加一条"对象不被写成数字"。**先补用例（会红）再改**。
设计文档对齐：SPEC §6 R2 与红线、AGENTS §10、D-044、D-048。

【V10-7】
严重程度：🟠 严重（**中止类出口丢掉全部已收集 warnings**，而文件已经被改写）
所在位置：`src/run.ts:47-61`（`pushCallWarnings` 唯一装配点）· `:558-566`（注释声称"timeout **and abort** exits … throw with the warnings gathered SO FAR"）· `:918-947`（`failedRunError` 内部**新建** `const warnings: Warning[] = []`）· `src/mcp/tools/run.ts:241-279`（catch 只提取 `executed`/`write_back`）· `src/mcp/tools/run-status.ts:46-47`
问题描述：超时出口本轮修好了 ✓，但 **`cancelled` / `kernel_died` 出口从没把已收集的 warnings 传进去**；后台运行更彻底——即使 detail 里有 warnings，`executeBackgroundRun` 也不写回 `handle.warnings`，于是 `notebook_run_status` **永远**看不到丢弃提示。
详细分析（子代理真 kernel 实测）：
```
cell0 display({'text/plain':5}) 完成（值被丢弃）→ cell1 sleep(20) → 10s 时 cancel
terminal status: {"state":"cancelled","write_back":{"performed":true,…},"warnings":[]}
同一形状在成功/超时出口: "dropped 1 mime value(s) nbformat cannot store (cell 0: text/plain)"
```
即：**文件已被改写、值已被丢弃，模型却被告知什么都没丢**（SPEC §4.8 规则 3 要求"报告它做了什么"）。注释与代码相反。
修复建议：① 给 `failedRunError` 加 `collectedWarnings` 形参，由 `abortedRunError` 传入（与超时出口共用 `pushCallWarnings`）；② `executeBackgroundRun` 的 catch 补 `handle.warnings = detail.warnings`；③ 用例：取消一个"先丢过值"的后台 run，断言 status 的 warnings 非空且指名 cell；④ 订正 `:558-566` 注释。
设计文档对齐：SPEC §4.8 规则 3、§4.7 规则 5、D-042。

【V10-8】
严重程度：🟡 警告（守卫会因**无关原因**变红）
所在位置：`scripts/check-docs.mjs:161-210`（自测的变异**基于 live 文档文本**构造）· `:181`（硬编码 `' | 已实现'`）· `:202-203`（硬编码 `'| 保持 20 |'`、`/^\| Q3 \|/m`）· `package.json:23`（`lint` 跑 `--selftest`）
问题描述：自测的"变异"依赖 live 文档里现存的字面量；一旦这些字面量因**合法修订**而改变，变异退化成空操作 → 自测报 `expected …, got []` → **exit 1 → `pnpm lint` 变红**，而**文档恰恰是改对了**。
详细分析（子代理副本变异实测）：把 SPEC §12 与 `OPEN_QUESTIONS.md` **同步**改成"维持 20"（逐字一致、verbatim 成立）→ `check` exit 0 ✓ 但 `--selftest` **exit 1**；把 `Q3` 两处同步改成 `Q4` → 同样 exit 1。另外 `editLine` 的 prefix 版本会直接 `throw`（未捕获）。
修复建议：变异源改为**从 live 文本推导**，或把"变异无法施加"降级为**跳过并显著提示**而不是失败；`throw` 改成 `problems.push`。顺带把 `COMPATIBILITY.md` 纳入检查范围（现在 `AUTHORITY_DOCS` 只有 DEVIATIONS）。
设计文档对齐：AGENTS §9（守卫必须能失败）——反向也成立：**守卫不得因无关原因失败**。

【V10-9】
严重程度：🟡 警告（两处收尾）
① **警告 message 无上界**：`src/core/outputs.ts:325-338` 对每个唯一 `(cell, mime)` 渲染一段文本 → 200 项 = **6597 字符**；真 kernel 用 `for i in range(300): dropped['application/x-bogus-%d' % i] = 5` → 调用级 message = **9897 字符**（mime 名完全由用户 cell 控制），并原样进入响应与 `exec_timeout` 的 `detail.warnings`。建议取前 N 项 + `… and K more`，或只给计数。
② **`tests/unit/analyze-op.test.ts:122-151` 的 `afterAll` 与 `prepareVenv` 的已登记行为矛盾**：当共享 venv 存在且带 marker 但不可用时，helper **会删它**（这正是 V8-12 的整改目标）；若随后 `python -m venv` 失败（Debian 缺 `python3-venv` 的经典情形），`TEST_VENV_PY` 不存在 → `afterAll` 红，而报错文案说"test files must not delete an environment they did not create"——**它正是本套件创建的**。建议断言 helper 的所有权决策（返回值 `created|reused|removed`），或把前置条件收窄为"之前存在**且能用**"。
🟢 另两条：`linux-check.sh:241-247` 的 `rm -rf` 用的是**第二次归一化**的字符串（未再走守卫；不是现实攻击面，但守卫注释承诺"每个删除目标都经过全部检查"）；`README.md:113` 说 venv 由"Integration tests"创建，本轮起**单测也会建/用它**，措辞应改成"unit 与 integration 共用同一个临时 venv"。

【V9-1 残留（子代理独立实测）】图片值的**数组形式**在 read 与 run 两条路径上判定不一致：`['data:image/png;base64,…']` 与 `['<前半>','<后半>']` 在 read 正常出块（`bytes=70` + artifact），在 run 却是 `bytes=0` + `image_materialize_failed`（`"image value is not a string"`）；而 `[1,2,3]` 在 read 会被 `String(entry)` join 成 `"123"` 当成 base64，**伪造成一张 2 字节"图片"并写 artifact**（无警告）。根因：`rawOutputsOfCell`（read）对非 json mime 做 join，而 run 的 rawOutputs 直接来自 sidecar、走 `imageValue` 的 `typeof === 'string'`。两种形式都是 nbformat 合法的"字符串或字符串数组"。修法：两条路径共用同一个窄化（数组→仅当元素全为字符串时 join）。

---

## 四、七个审查维度逐条覆盖

**1. 架构与模块对齐** —— 未发现明显问题
新增的 `src/core/json-exact.ts` 与 `src/core/base64.ts` 都是**纯 core**（无 `node:*` I/O、无时钟/随机）；内容块组装仍在 `mcp/tools/result.ts`，值投影仍在 `core/outputs.ts`；D-047 把"协议错误 vs 产品错误"的边界写进了偏离登记册——这正是我 v9 建议的那条边界。`V10-1`/`V10-3` 都属"同一族只修了一半"（顶层 vs 嵌套、整数 vs 小数），是实现深度问题而非层次问题。

**2. 代码质量与可维护性** —— 未发现明显问题
`check-docs.mjs` 把"文档也能被机器验"变成门禁（且自带 7 个变异的自测）；`check-indent` 自测样例 25→28；`linux-check.sh` 的 `IPYNB_SELFTEST_MUTATE` 让"回退分支"也可被测试——这三处都是"把守卫本身做成可证伪"的正确做法。注释质量高（D-047/D-048/D-049 都把"为什么"与"放弃了什么"写清了）。

**3. 健壮性与错误处理** —— 1 项（V10-1）
图片侧 15 种畸形形状**全部降级、零协议错误** ✓；超时/失败出口带上已收集的 warnings 并指名 cell ✓；hint 按规则生成且都指向可用操作 ✓；盘上写回逐字节保真 ✓。唯一残留是嵌套精确数无警告（V10-1）。

**4. 性能与资源效率** —— 未发现明显问题
`json-exact` 的解析/序列化是单遍扫描；`mapRawOutputs` 未新增二次遍历（**修 V10-1 时要注意别把整份文档走成两次深拷贝**）；分帧仍线性且有用例守着；连接文件清扫只在启动跑。

**5. 安全性** —— 未发现明显问题
`linux-check.sh` 现归一化后再判（`..`/`HOME` 都堵住）；产物 140 项无 `.pyc`；`check-package` 与 `check-connection-sweep.py` 都进了 CI；连接文件不再落工作目录（本轮实测仓库根 0）。**仍建议**在 README 点一句"sidecar/kernel 继承完整 `process.env`"（v8 起未做，非阻塞）。

**6. 测试覆盖与自测质量** —— 未发现明显问题（本轮最大进步）
单测 **432**（+51）、集成 **50**（+4，含 `[V9-1]` 放大器回归）、smoke **26**（+7，且断言到**客户端真正读到的块**）；`check-docs --selftest` 7 变异、`check-connection-sweep.py`、`check-package`、`check-indent` 自测都进 CI；`prepublishOnly` 成为发布闸门。**"守卫必须自证能失败"这条在五个脚本上都有了实现**——这是八轮以来验证能力最扎实的一次。
唯一缺口仍是 V10-1 的嵌套情形没有用例（这也是它能活下来的原因）。

**7. 依赖与配置** —— 未发现明显问题
运行期依赖仍只有 SDK（零新增）；`files` 排除 `__pycache__`；CI 9 job 结构未变但覆盖面扩大；`IPYNB_REQUIRE_NBFORMAT=1` 保持；工作树干净。

---

## 五、总体评估

### 1. 整体质量评级：**C（需返工）**

> **本条在我初稿里是 B；两路复核（其中一路独立复现）落地后我下调为 C**——因为本轮新发现的两条缺陷都是"静默给错数据"这一类，其中一条**改的是盘上、而且是本次编辑没触碰的 cell 的内容**。

**为什么是 C**：存在 **3 条已复现的静默缺陷**，其中一条是**本轮新引入的回归**、一条**在盘上删用户数据**：
- **V10-6（🔴，本轮新引入）**：`parseJsonExact` 用 `result[key] = …` 承接键值 → `__proto__` 触发原型 setter → **该键从响应和用户文件里消失**（实测 `x2 → x0`，编辑的是**无关 cell**、`warnings: []`、文件仍合法所以无人报警）；被污染的原型还能伪造内部 marker，**把一个对象写成裸数字**（实测：盘上对象 → 模型收到 `42` + 一条虚构的精度警告）。上一版的 `JSON.parse` 在这一格**是正确的**。
- **V10-3（🔴）**：编辑无关 cell 会把别处 `application/json` 的高精度**小数**在盘上静默改写（`0.1234567890123456789012345` → `0.12345678901234568`、`1.0000000000000001` → `1`、π 的 30 位 → 16 位），`warnings: []`。
- **V10-1（🟠，双方独立复现）**：嵌套精确数字把未登记的标记对象交给模型且无警告（`itemWarn=0 / callWarn=0`）。

另有 **V10-7（🟠）** 中止类出口（`cancelled`/`kernel_died`）与后台 status **丢掉全部已收集 warnings**（文件已改写、值已丢弃，模型被告知什么都没丢；注释还声称带了）、**V10-4（🟠）** hint 声称"文件会变合法"而 nbformat 判它不合法。

**为什么不是 B**：v9 的 11 条确实真修、门禁全绿（432 / 50 / 26 / 140）、CI 与 `prepublishOnly` 闸门补齐、文档数字首次与实测逐项一致——但**"不会静默改坏"是这个产品的第一条卖点**，而本轮出现了 3 处静默改写，其中 `__proto__` 那条是**新引入的回归**且直接**删除用户文件里的数据**。

**为什么不是 D**：三处修法都很小（`defineProperty` 一行 + marker 改 `instanceof`；`losesPrecision` 一个判据；`jsonValueOf` 一处递归），不需要架构返工。

**这一轮最值得记下的**：`json-exact.ts` 与图片层的**目的**都是"不再静默改坏"，结果它们自己成了四个静默改写点（整数之外的小数、顶层之外的嵌套、`__proto__` 这一格、数组形式的判据分叉）——原因不是能力，而是**判据只覆盖了写这段代码时想到的那一种形态**。**"全部合法类型矩阵"如果只覆盖被改的那一层，就等于没有矩阵。**

### 2. TOP 3

| # | 事项 | 为什么 | 修复量 |
|---|---|---|---|
| 1 | **V10-6（🔴，回归）**：`readObject` 改 `Object.defineProperty`（或 `Object.create(null)`）；marker 改 `class ExactNumber` + `instanceof`；补"`__proto__` 在 metadata / cell metadata / json 输出 / 数组元素"四条用例（read 原样 + 写回字节不变 + nbformat 通过） | **本系列最严重的一条**：编辑一个无关 cell 就**删掉用户文件里的键**，且因为文件仍合法而无人报警；还能把一个**对象**变成**裸数字**（配一条虚构的精度警告）。上一版是正确的——这是本轮新引入的 | 小（2 行 + marker 类型 + 4 用例） |
| 2 | **V10-3（🔴）**：`losesPrecision` 判据扩到 `!Number.isFinite(n) \|\| String(n) !== literal`；补"编辑无关 cell 后盘上仍是原字面量"与 `1.0000000000000001` 往返用例 | **盘上**静默改写、改的是**没被要求改的 cell**；一个普通 `display({'application/json': {'pi': 3.14159…279}}, raw=True)` 就能触发 | 小（1 个判据 + 2 用例） |
| 3 | **V10-1（🟠）**：`jsonValueOf` 递归（嵌套标记 → 舍入数 + 逐路径警告）；补 `{'n':2**64}`、`[2**64]`、`{'a':{'b':[2**64]}}` 三条用例，断言响应里**不出现** `__ipynb_exact_number__` | 模型看到凭空多出的对象结构且无警告；D-048 的不变式②在嵌套下不成立 | 小（~10 行 + 3 用例） |

紧随其后：**V10-7**（`failedRunError` 接 `collectedWarnings` + 后台 status 写回 `handle.warnings` + 一条取消用例 + 订正注释）→ **V10-4**（hint 结论句改成真话 + 判据换成真 nbformat + 首次拒绝也带 hint）→ **V9-1 残留**（read/run 共用图片窄化，并修掉 `[1,2,3]` 被伪造成 2 字节图）→ **V10-8**（`check-docs` 的变异源改为从 live 文本推导，别让合法修订打红 lint）→ **V10-9**（警告 message 上限 + `analyze-op` 的 afterAll 判据）→ **V10-5 / V10-2** 与两条 🟢（`linux-check` 二次归一化、README venv 措辞）。

**给下一轮的硬规则（第 4、5 条）**：④ **判据必须与外部权威一致**（V10-4 的测试绿而文件不合法就是这个后果）；⑤ **解析/序列化层必须连同"语言语义边界"一起测**——`__proto__`、`constructor`、`prototype`、稀疏数组、重复键、`-0`、非 BMP 键，这些是"自己写 parser"的必测格（本轮 `JSON.parse` → 自研 parser 时恰好丢了第一格）。

### 3. 与原始设计文档的偏离清单

| 偏离 | 性质 | 状态 |
|---|---|---|
| 内容块 `data` 由已解码字节重新编码 + 组装前合法性过滤 | 已登记 **D-047**（协议错误 vs 产品错误） | ✅ 本轮新增，与建议一致 |
| json 数值原文保真；精确数字随 `output_truncated` 警告交付 | 已登记 **D-048**（语义借用扩到数值域） | ⚠️ **两条不变式各有缺口**：①"盘上逐字节保留"对**小数**不成立（V10-3）、②"模型知道它不精确"对**嵌套**不成立（V10-1）——都要补记或修 |
| `execution_count >= 0` 规则作用域第三次收窄（判 cell 状态而非请求历史） | 已登记 **D-049** | ✅ 行为与实测吻合；**但 hint 的结论句超出实际**（V10-4：文件仍不合法） |
| 复用 `output_truncated` 承载"丢弃/截断/数值不精确"三义 | D-042/D-048 | 🟡 建议 SPEC v3.1 新增专用码（如 `output_value_inexact`），D-048 自己也写了"改一处即可" |
| 解析/序列化层的语言语义边界（`__proto__` 等） | **未登记**；`JSON.parse` 原本正确，自研 parser 丢了这一格 | 🔴 V10-6（建议修完补一条 D-05x 说明 marker 与键语义的约定） |
| sidecar 启动时清扫非自己创建的连接文件 | 已登记 **D-046** | ⚠️ 同一行两列自相矛盾（"偏离内容"仍写 `os.kill(pid,0)`，影响面列已标 Windows 用 `OpenProcess`），状态表自己列为"待订正"仍未改 |

### 4. 后续开发建议

- **发布判断**：**修掉 V10-6 + V10-3 + V10-1 + V10-7 + V10-4**（都小、都集中），代码侧就可以发 `0.1.0`。CI 已经会在缺 `nbformat` 时失败、会跑 smoke、`prepublishOnly` 也会拦一道——**发布闸门是齐的**。
- **数字域与解析域的"形态矩阵"必须穷举**（本轮最该固化的规矩）：
  - **数值**：整数 / 小数 / 指数 / 超范围 × 顶层 / 嵌套 / 数组 / 深嵌套；
  - **解析语义边界**：`__proto__` / `constructor` / `prototype` / 稀疏数组 / 重复键 / `-0` / 非 BMP 键 / 控制字符转义 —— **这是"自己写 parser"的必测格**，本轮 `JSON.parse` → 自研 parser 时恰好丢了第一格，代价是"静默删用户数据"。
  - 每格都要有用例，且能用变异证伪。
- **最后一道非代码的门**：**E1–E9 真实第三方客户端**（用 Claude Desktop / Cursor / Cline 各跑一次并记录进 `COMPATIBILITY.md`）。你这几天用其他 agent 试用就是在做这件事，只是还没形成可核验的矩阵。
- **给下一轮的规矩（前三条已验证有效，建议固化；后两条是这两轮新加的）**：① 断言打到**消费者真正读到的那一层**；② 每条守卫必须能用变异证伪（反向也成立：**守卫不得因无关原因失败**）；③ 文档数字只写**当轮亲跑**的值；④ **判据必须与外部权威一致**（V10-4 的测试绿而文件不合法就是后果）；⑤ **自己写 parser / 自己写序列化器时，语言语义边界与数值形态都要有矩阵**（V10-6/V10-3 都是"以为已经覆盖了"的格子）。
- **低优先**：README 补一句 `process.env` 继承的安全声明；`output_truncated` 的三义拆分（SPEC v3.1）。

---

## 附录：验证分工与局限

- **主审亲验（一手证据）**：全部门禁（typecheck/lint 含 check-docs 自测/unit **432·28**/integration **50·7**/smoke **26/26**/check:package **140**/`check-docs --selftest` 7 变异）；**自建 5 组探针**——① 图片 read 形状矩阵 17 例（含 6 种 data-URL 变体、空串、空白、非 base64、非字符串值）；② json 数值矩阵 11 例 + run 写回保真 4 例（`2**64`/`2**53+1`/`10**30`/`0.1+0.2`，逐字节比对盘上原文）；③ base64/data-URL 边界 8 例（URL-safe、无 padding、含换行、`DATA:`、带参数、无 mime、payload 含逗号、前缀后空隙）；④ 嵌套精确数（per-output 与调用级 warnings、顶层/嵌套对照、run 写回）；⑤ 会话级——超时 detail 的 warnings、`clear_outputs` 后的可编辑性、markdown hint、GATE-1 作用域三态。另有：DEVIATIONS 完整性（55 行/49 编号全唯一/新增 D-047~049 与代码一致性）、`package.json` 脚本与 CI 步骤逐项核对、pack 清单。
- **子代理复核（一路已完成并入，一路仍在跑）**：
  - **① v9 修复的深度核实（已完成）**：独立 worktree（真实目录、非 junction）；自己跑门禁全绿（**432/28、smoke 26/26、check:package 140 文件 + 22 变异、集成 50/7、lint 71 文件/99 规则 + 28 indent 样本 + 7 docs 变异**）；**read 16 形状 + run 11 形状穷举，`-32602` = 0、字节不符 = 0**，且块 `data` 与物化字节**逐字节相等**；V9-6 用脚本导出的 `inspectDocument` 做 6 类变异（复制整表/重复行/删中间编号/破坏列数/重复表头/改表头）**全部捕获**，并指出"删最后一行不报、追加 D-050 不报"两个缺口；V9-7 真 kernel 三 cell 丢弃实测 `detail.warnings` 同时含 **cell 与 mime**（`cell 0: text/plain, cell 1: text/html, cell 2: …`）；V9-2 变异（块载荷改回文档原值）→ **单测 5 条变红**；V8-8 WSL `--selftest` **26 例 0 失败**、`--guard /tmp/../etc` **exit 2**、变异 `prefix-only` → **4 条红**；`check-indent` 两条变异都能红；**仓库卫生**（`mutate-*`/`probe-*`/`patch-*` 已清、`.gitignore` 已补）；并独立复现了 **V10-1**（`itemWarn=0 / callWarn=0`）与 **V10-3**（浮点改写）、发现 **V10-5**（`pushCallWarnings` 短路后 432 单测全绿、`callWarnings` 幽灵符号、恒真断言、`check-docs` 两个缺口）。
  - **② v10 diff 的新问题猎取（已完成并入）**：真 stdio + SDK + 真 ipykernel 全链路；**read 23 形状 × run 20 形状，无一次调用失败、盘上从未被改写、每个块都过 `atob` 且解码结果 == artifact 字节**（V9-1 真修）；**`base64.ts` 17843 条语料与 `atob` 逐条对照，0 例误判**（`isBase64Shaped=true` 而 `atob` 拒绝：0；双方接受时字节不等：0）；`check-connection-sweep.py` 在 Windows 真探针下 **PASS**（15 归属 + 11 行为 + 2 探针，全数字后缀不再被当 pid，跑完无 `__pycache__`）；WSL `linux-check.sh --selftest` **26/26**、含**符号链接逃逸**在内全部 refuse；`lib/` 与干净构建**逐字节一致**（34 文件）；独立黑箱会话 `nbformat.validate` OK、工作目录连接文件 0、无残留 python 进程；并发现 **V10-6（🔴 `__proto__` 回归）**、**V10-7（🟠 中止出口丢 warnings）**、V10-8/V10-9 与 V9-1 的数组形式残留。
- **两路复核与我的独立一致性**：**V10-1** 由两路 + 我各复现一次（我的证据是文件级对照，两路分别用隔离 worktree 与真 kernel）；**V10-3** 与 **V10-6** 我均用真 stdio 亲验（浮点：编辑无关 cell 的盘上前后台账；`__proto__`：`x2 → x0` + marker 伪造），与子代理结论**完全一致**，无分歧。
- **局限**：① 未做 macOS/arm64 与真实第三方客户端（E1–E9 仍 0/9，但 CI 已覆盖 ubuntu 的 unit+integration）；② V10-1 我只在 read/run 与"对象/数组"两种容器上实测，未穷举更深嵌套与 `outputs_summary` 等出口；③ **V10-6 我只实测了 edit 这条写入路径**（run 写回是否同样删键、以及 `parse.ts` 之外的 `protocol.ts` 解析面未逐格验证）；④ V10-3 我只实测 `notebook_edit`（run 是否也规范整份文档的小数未逐格验证）；⑤ 未在干净机器上 `npm i` 后实跑（只核了 pack 清单）。
