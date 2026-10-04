# ipynb-mcp 代码审查报告（第十一轮 / v11）

> **审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp` @ HEAD `8384931`（v10 整改后，**5 个提交**；工作树**干净**）
> **上轮基线**：`08f4211`（v10 报告：`docs/review/ipynb-mcp-code-review-v10.md`）
> **方法**：主审亲跑全部门禁（含集成套件）+ **重建 5 组探针**（危险键矩阵 / 18 种数字字面量的盘上字节 / 嵌套 marker / 图片数组 read-vs-run / 取消出口 / 警告上限）+ 两路独立复核
> **日期**：2026-10-04

---

## 一、门禁实测（主审亲跑）

| 门禁 | 实测 | 变化 |
|---|---|---|
| `pnpm typecheck` | exit 0 | ✅ |
| `pnpm lint` | 0 警 + `format ok` + `indent ok (28 samples)` + `documentation check: ok` | ✅ |
| `pnpm test` | **552 passed（30 文件）** | ↑ 432→552 |
| `pnpm test:integration` | **58 passed / 58**，8 文件，264 s，`VITEST_EXIT=0` | ↑ 50/7→58/8 |
| `pnpm smoke` | **26/26** | ✅ |
| `pnpm check:package` | **ok（140 文件，22 变异）** | ✅ |
| 工作树 | **干净** | ✅ |
| 文档数字 | `REVIEW-FIX-STATUS.md` / `COMPATIBILITY.md` 写的 **552 / 30 文件**、**58 / 8 文件**、**26/26**、**140 文件 + 22 变异** 与我的实测**逐项一致** | ✅ |
| `DEVIATIONS.md` | 64 行、**54 个编号全部唯一**、最大 **D-054** | ✅ |

---

## 二、v10 问题闭环核查（**逐条亲验**）

| v10 项 | 结论 | 主审证据 |
|---|---|---|
| **V10-6**（🔴 `__proto__` 键被静默删除 + 原型污染可伪造 marker） | ✅ **真修复** | **5 个危险键矩阵**（`__proto__` / `constructor` / `prototype` / `hasOwnProperty` / `toString`）：① read **原样返回**（`{"__proto__":{"injected":true},"safe":1}`）；② **编辑无关 cell 后盘上键数 2→2 不变**（此前 2→0）；③ **marker 伪造失效**——notebook 里直接写 `{"__ipynb_exact_number__":"42","other":1}` → 服务端**原样当对象返回**，不再变成数字 42 |
| **V10-3**（🔴 编辑无关 cell 会静默改写别处的高精度小数） | ✅ **真修复** | **18 种字面量的盘上字节矩阵**：`0.1` / `1e400` / `1.0000000000000001` / `0.1234567890123456789012345` / `18446744073709551616` / `9007199254740993` / `-0` / `1e-400` / 30 位整数 / `-2.5e-10` / `100.0` / `1E+2` / `1.0e2` / `0.30000000000000004` / `1e2` / `0.10` / `1.5e3` / `123.456` —— **全部逐字节保留** ✓（此前小数会被规范化） |
| **V10-1**（🟠 嵌套精确数字泄露内部 marker 且无警告） | ✅ **真修复** | 三种嵌套形状（`{"n":2**64}` / `[2**64]` / `{"a":{"b":[2**53+1,1]}}`）：**响应里不再出现 `__ipynb_exact_number__`**，item 级与调用级 `warnings` 各 1 条 ✓ |
| **V10-7**（🟠 取消 / `kernel_died` 出口丢 warnings、后台 status 永不带） | ⚠️ **代码侧真修，但"事实到达客户端的时机"没修 → 常见流程下等于没修**（见 V11-3） | ① **代码侧**：真 kernel 取消（cell0 丢值完成后 cancel）→ 终态最终确实给出 `executed=0:ok`、`write_back=true`、`warnings=["… (cell 0: text/plain)"]` ✓；后台 `kernel_died` 与同步 `kernel_died` 两条路径子代理也实测 warnings 非空 ✓。② **但**：取消**立即**发布终态（§4.8 规则 1），而 `executed`/`warnings`/`write_back` 要等后台任务收尾才写回 handle → 客户端在 **10–28 秒**里看到的是一个"什么都没跑、没写回、没丢值"的**空壳终态**（我实测 `+1ms` 时 `executed=[]`/`write_back=false`/`warnings=[]`，子代理 9 个快照横跨 28 s 全空）。详见 V11-3 |
| **V10-4**（🟠 hint 声称"文件会变合法"而 nbformat 判它不合法） | ✅ **真修复** | hint 现为：**"…clear_outputs does not change the count itself, but this tool stops checking a cell that has no outputs, so the edit is accepted; the count stays in the file and nbformat.validate still rejects it"** —— 与我建议的措辞一致 ✓；实测 `clear_outputs` → `applied=1`、盘上计数仍 `-1`、`nbformat=INVALID`、**之后编辑被放行** ✓ |
| **V9-1 残留**（图片数组形式 read/run 不一致；数字数组被伪造成图片） | ✅ **真修复** | 五种形状在 **read 与 run 两条真链路完全一致**：`['<b64前半>','<b64后半>']` → `bytes=70` + 块 + artifact（两侧同）；`['data:image/png;base64,…']` → 同上；**`[1,2,3]` → 两侧都是 `bytes=0` + 无块 + `image_materialize_failed`（不再伪造 2 字节"图片"）**；`[]` 与 `['abc',5]` 两侧同降级 ✓ |
| **V10-9①**（警告 message 无上界） | ✅ **真修复** | 真 kernel 丢 **300 个 mime** → message **312 字符**（此前 9897）；实现为 `named.slice(0, LIMIT)` + **`, … and N more`** ✓；多 cell 多 mime 的 message 仍**指名 cell 与 mime** ✓ |
| **V10-9② / V10-8** | ✅ 真修（子代理实测） | `analyze-op` 的判据改成 **`existsSync(VENV_PY) && canRunSidecar(...)`**（"之前存在且能用"）✓；`check-docs` 的变异源改为**从 live 文本推导**，三组变异（SPEC §12 与 `OPEN_QUESTIONS.md` 同步改措辞、`Q3`→`Q4`、表格改散文）下 `check` 与 `--selftest` **都 exit 0**，无法施加时**跳过并提示** ✓ |
| **V10-5**（🟡 装配点无行为判据 / 幽灵符号 / 恒真断言 / check-docs 两缺口） | ⚠️ **部分：④ 真修，① 半修，②③ 未修** | ④ `check-docs` 的"末行 + 计数"缺口真修（删末行 / 追加 D-055 / 删中间行三种变异都 exit 1）✓；① 装配规则已下沉 core（`assembleCallWarnings`）且**有真输入单测**，但**把 `pushCallWarnings` 函数体整个短路 → 552 条单测仍全绿**（子代理 M1 复现；另有 M3 删 `failedRunError` 的 `...assembled`、M4 **删后台 `handle.warnings` 写回** 也都全绿），唯一能红的是**源码文本断言**；② `src/run.ts:370/:590` 的幽灵符号 `callWarnings` **仍在**；③ `tests/unit/json-exact.test.ts:96` 的恒真断言 **一字未改** |

**判断**：v10 的**两条 🔴 与所有 🟠（含取消出口、图片数组、hint、消息上限）逐条真修**，且都不是"绕过检测"式的修法——`defineProperty`、marker 改不可伪造、`losesPrecision` 判据扩展、递归投影、四出口共用装配、图片窄化统一（`imageValueText`），都是**根因层**的修法。子代理用 **10 组源码变异**独立验证：V10-6/V10-3/V10-1/V9-1 残留/V10-9①/V10-4 六条的守卫**都能真红**（分别 11/12/11/4/1/1 条失败）。**但 V10-5 的 ②③ 未修却被状态表宣称已修**（见 V11-4）。

---

## 三、本轮新发现

【V11-1】
严重程度：🟠 严重（**对模型陈述假事实，且由最普通的 Python 输出触发**）
所在位置：`src/core/json-exact.ts` 的 `losesPrecision`（判据按"写法和 `String(Number(literal))` 是否相同"）· 文案在 `src/core/outputs.ts` 的 `jsonValueOf`
问题描述：**完全精确、只是写法不同的数字，被报成"was not representable exactly"**。
详细分析（**主审实测**，read 路径）：
```
字面量        服务值     警告  警告原文
100.0        100       有    json value 100.0 was not representable exactly; the exact digits are in this warning
                            and in the file, but a JSON client reads it as 100
1e2          100       有    同上（1e2）
1.5e3        1500      有    同上（1.5e3）
0.10         0.1       有    同上（0.10）
-0           0         有    同上（-0）
1.5e-07      1.5e-7    有    同上（1.5e-07）
2.5e-05      0.000025  有    同上（2.5e-05）
1e+100       1e+100    无    ← 写法能往返，所以不报
0.1          0.1       无
1e400        null      有    ← 真损失，警告正确
```
**触发面是日常输出，不是奇技淫巧**：Python 自己的 `json.dumps` 就是这样写的——实测 `json.dumps({'small':1.5e-07,'tiny':2.5e-05,'big':1e+100,'val':100.0,'third':1/3})` → `{"small": 1.5e-07, "tiny": 2.5e-05, "big": 1e+100, "val": 100.0, ...}`，其中 **3 个值全部被误报**（`1.5e-07` / `2.5e-05` / `100.0` 在 IEEE-754 里都是精确可表示的，服务值也与文件**数值完全相同**）。任何含小数的 DataFrame/`float` 结果的 notebook 都会中招。
影响：① 模型被告知"这个值不精确"，而它其实精确——错误信息会被模型转述给用户；② **稀释真警报**：真正需要警告的（`2**64`、`1e400` 这类）淹没在一堆假警报里；③ 与 v9 已登记的 D-048 承诺（"精确数字写在警告里"）语义冲突——警告的存在意义是"值不精确"，而现在的判据是"写法不同"。
修复建议（判据按**值**而不是**写法**）：
```ts
// 只在"这个数的值确实无法用 double 表示"时警告
export function losesPrecision(literal: string): boolean {
  const n = Number(literal);
  if (!Number.isFinite(n)) return true;                 // 1e400 等
  if (n === 0) return /^-/.test(literal.trim());        // -0：JSON 文本可载 -0，但本工具的响应通道会丢掉符号
  // 用十进制精确比较：把字面量规范化后与 double 的最短往返表示比"值"
  const canonical = canonicalSpelling(literal);         // 去 +、去指数前导零、去尾随 .0/多余 0
  return canonical !== String(n);
}
```
其中 `canonicalSpelling` 只需处理**无信息损失的写法差异**：指数前导零（`e-07`→`e-7`）、`+` 号、尾随 `.0`、`0.10`→`0.1`。`-0` 建议单独给一条**文案正确**的警告（"negative zero's sign is not carried by this tool's JSON response"），而不是复用"不可精确表示"。另建议把"精确值"与"写法"两个概念在 D-048 里分开写清。
设计文档对齐：SPEC §5.4 第 7 行、§6 R2、D-048（语义借用扩到数值域的登记需要按本条收敛判据）。

**其它证据（子代理，真 kernel）**：`display({'application/json': v}, raw=True)` 里 `v = 100.0 / 2.0 / 1e-05 / -0.0` **各产生一条**假警告（"json value **2.0** was not representable exactly; … reads it as 2"）；`read(full)` 侧同形。**更值得注意的是守卫本身**：`tests/unit/json-number-forms.test.ts:350` 的期望值由 `inexactLiteralsIn()` 推导，而它内部调用**被测的** `losesPrecision` —— 也就是说**这条新用例无法证伪它要守的判据**（族 2"守卫不能失败"的新形态：期望自我循环）。修复时必须把期望改成**独立断言**（至少：`100.0`、`2.0`、`1e-05`、`1e2` 的 `warnings` 必须为空）。

**其它**：本轮我没有发现任何**静默改写用户数据**（族 6）的**可达**新形态——18 种数字形态的盘上字节、5 个危险键的盘上键数、图片五形状的两路径一致性，三张矩阵全绿。（V11-8① 的控制字符那一格是"把非法文件顺手改合法"的静默改写，但需要文件本身已是非法 JSON。）

【V11-2】
严重程度：🟠 严重（**一条可被一行代码证伪的假前提，撑着 marker 的全部身份保证**）
所在位置：`src/core/json-exact.ts:39-44` 与 `:63-68` 的注释（"Extensibility **IS** preserved by `structuredClone`, so the marker survives the clone"）· 相关实现：`:70-83`（`isExactNumber` = 形状 + **不可扩展**）、`:86-88`（`exactNumber` 用 `Object.freeze`）；同一条错误前提也写进了 **D-050**
问题描述：`isExactNumber` 的判据包含"**不可扩展**"，而 `structuredClone` **不保留**不可扩展性——所以注释是**反的**：克隆**一定**让 marker 失效，之后序列化会把 marker **对象**写进用户文件。
详细分析（**主审亲跑 `lib/core/json-exact.js`**）：
```
原始 marker: isExactNumber=true   extensible=false  frozen=true
克隆之后:   isExactNumber=false  extensible=true   frozen=false
克隆体序列化 = {"v":{"__ipynb_exact_number__":"18446744073709551616"}}   ← marker 对象进了文件
原 marker 序列化 = {"v":18446744073709551616}                            ← 正确

真实文档路径（parse → structuredClone → stringify）：
  未克隆 = {"application/json":18446744073709551616}                       ✓
  克隆后 = {"application/json":{"__ipynb_exact_number__":"184467437…"}}    ✗ 大整数变成对象
  两者相同 = false
```
**今天不可达**：序列化路径从不使用克隆（`structuredClone` 只用于 `originalDoc` / `preRunDoc` 快照：`src/mcp/tools/edit.ts:128`、`src/run.ts:412`），所以线上没有这条链路。但这是一个**一次重构就能触发的静默改写**（"给文档做快照/撤销/CAS 比较后再写"是天经地义的下一步），而注释**主动告诉读者它安全**。
修复建议：① 把 `:63-68` 改成真话——"marker 只保证**不被文件伪造**（文件里解出来的对象必然可扩展）；**任何克隆都会让它失效**，因此序列化路径必须使用**未经克隆**的原始文档"；② 钉一条回归断言把这条假设**变成测量**：`expect(isExactNumber(structuredClone(exactNumber('2')))).toBe(false)`（注释里写明"这是已知限制，不是不变量"）；③ 若确实需要跨克隆的 marker，用 **boxed String**（`structuredClone(new String(literal))` 保形，且 JSON 永远造不出该形状）——子代理已验证该方案可行；④ 同步订正 D-050 的叙述。
设计文档对齐：SPEC §6 R2（不静默改坏）、D-050、AGENTS §9（把假设变成断言）。

【V11-3】
严重程度：🟠 严重（**取消后的"空壳终态"：V10-7 的修复在最常见流程下等于没修**）
所在位置：`src/mcp/tools/run-status.ts:76`（取消**立刻** `settle('cancelled')`，SPEC §4.8 规则 1 要求）· 对照 `src/mcp/tools/run.ts:241-288`（`executed`/`warnings`/`write_back` 只在后台任务的 catch 里写回 handle）· `python/ipynb_sidecar.py`（Windows 上 interrupt 无效，README/D-025 已声明）
问题描述：取消瞬间起，客户端拿到的第一份（也是它自然会当成最终的）终止载荷是"**什么都没执行、什么都没写回、什么都没丢**"；而事实要等在途 cell 结束、后台任务收尾之后才补上。窗口长度 = **在途 cell 的剩余时长**（Windows 上 interrupt 无效，25 s 的 cell 就要等 25 s）。
详细分析（**主审与自己 + 子代理两方实测**）：
```
主审（v11 探针）：+1 ms 时 state=cancelled executed=[] write_back=false warnings=[]
                  （我最初以为这是"取消落在 cell0 完成之前"的自洽形状——它确实自洽，
                    但同一个形状在 cell0【已经完成】之后依然持续到后台任务收尾）
子代理（9 个快照横跨 28 s，cell0 已丢值完成、cell1 sleep(25)）：
  + 0.0s  state=cancelled executed=0 warn=0 wb=false  file=unchanged
  +24.1s  state=cancelled executed=0 warn=0 wb=false  file=unchanged
  +28.1s  state=cancelled executed=2 warn=2 wb=true   file=REWRITTEN   ← 事实与文件同时后到
  final warnings: "dropped 1 mime value(s) nbformat cannot store (cell 0: text/plain)"
```
对照：`exec_timeout`（同步出口）与 `kernel_died`（`notebook_kernel shutdown`）**都在响应里立刻带 warnings**（主审与子代理各自实测）——所以缺口只在"客户端主动 cancel + 轮询 status"这一条路径上。
影响：SPEC §4.8 规则 1（立即终止态）与规则 3（报告做了什么）在此冲突，而**文件确实在这之后被改写**——模型有充分理由认为"结果被丢了"，进而重跑，恰好是规则 3 想避免的行为。**这也意味着我 §二 给 V10-7 打的"代码侧真修"需要限定**：装配对了，**送达时机**没解决。
修复建议（三选一，都建议补用例）：① `run_cancel` 不直接 `settle`，改为置 `abortReason` 等后台收尾（牺牲"立即终止态"）；② 保留立即终止态但在载荷里加 **`facts_pending: true`**，客户端据此继续轮询（注意 D22 兼容承诺：新增字段需登记）；③ 在 cancel 时把**已完成的** `executed`/`warnings` 同步快照进 handle（`progress.completed` 已有这个信息）。**用例**：cancel 后**立刻**读一次 status，就断言"要么 warnings 非空且指名 cell，要么 `facts_pending: true`"。
设计文档对齐：SPEC §4.8 规则 1 与规则 3、§4.6.3（status 形状）、D-052 ③（"四出口共用装配函数"——装配对了、时机没解决）。

【V11-4】
严重程度：🟡 警告（**虚报族复发：状态表宣称两项已修，实际都未修**）
所在位置：`docs/REVIEW-FIX-STATUS.md:52`
问题描述：该行写"`callWarnings` 幽灵符号的注释已订正为 `pushCallWarnings`；恒真断言（`Number(literal) !== NaN`）随 v9 的用例重写而删除"——**两句都不成立**：`src/run.ts:370` 与 `:590` 的幽灵符号仍在（全仓不存在 `callWarnings`），`tests/unit/json-exact.test.ts:96` 的恒真断言**一字未改**（本轮 diff 只重写了紧随其后的那个 `it(...)`）。
详细分析：这正是本项目第八轮起立下的规矩（"**每条 ✅ 必须携带可 grep 的产物**"）被违反——这一行的两个"已修"都没有可 grep 的产物。它也是族 4（虚报）在 v8 之后**第一次复发**；前几轮之所以干净，靠的就是那条规矩。
修复建议：① 订正该行为 ⚠️ 或补上真实修复；② 在 `check-docs.mjs` 里加一条**廉价的机械检查**：状态表里的 ✅ 行若出现"已订正/已删除/已改名"这类断言，必须同时出现一个反引号包裹的**存在的符号或文件:行**（可用 `git grep` 验证）——把"可 grep 产物"从纪律变成门禁。
设计文档对齐：`docs/REVIEW-FIX-STATUS.md` 头部自定的规则、AGENTS §2。

【V11-5】
严重程度：🟠 严重（**默认 read 出口静默舍入，且全响应零警告**）
所在位置：`src/mcp/render/read.ts:132-151`（警告提升被 `input.includeOutputs === 'full'` 关掉）· `:195`（`preview: truncatePreview(JSON.stringify(item.value))`）
问题描述：`mapRawOutputs` 已经把"不可精确表示"的 json 数值投影成舍入数**并**生成了警告，但 **summary 模式只把投影值拿去做 preview，逐项警告被丢弃、也不提升到调用级 `warnings[]`**。而 summary 正是 SPEC 的**默认**出口、也是 token 最省的推荐用法。
详细分析（**主审实测，同一文件四种出口**）：
```
include_outputs 未指定  warnings=0   [{"kind":"json","preview":"{\"big\":9007199254740992,\"huge\":null,\"eq\":100}"}]
include_outputs=summary warnings=0   同上（9007199254740993 → …992；1e400 → null）
include_outputs=full    warnings=3   同一批值，但带 3 条 "json value 9007199254740993 was not representable exactly…"
include_outputs=none    warnings=0   []（这一档是"用户主动不看"，合理）
```
模型在默认路径上看到 `9007199254740992`（文件里是 `…993`）、看到 `null`（文件里是 `1e400`），**没有任何提示**——直接踩 SPEC §5.4「禁止静默截断」与 D-048/D-052 的不变式②。这也是我 v10 报告"局限②：未穷举 `outputs_summary` 等出口"所对应的那一格。
修复建议：**把 `read.ts:138-142` 那段警告提升移出 `full` 分支**（summary 也执行 `collectOutputWarnings` 并去重进 `warnings[]`）；**不要**给 `outputs_summary` 元素加字段——SPEC §4.3 固定了它的形状（D22 兼容承诺），而 `warnings[]` 本来就是载荷里的公共字段。修完补一条用例：summary 模式下读同一文件，断言 `warnings` 非空且含精确数字。
设计文档对齐：SPEC §4.3（载荷里的 `warnings`）、§5.4、D-048/D-052。

【V11-6】
严重程度：🟡 警告（**内部 marker 从 `execution_count` 漏进模型可见响应；带 outputs 时还会误拒 nbformat 判 VALID 的文件**）
所在位置：`src/mcp/render/read.ts:68`（`cell.execution_count ?? null` 原样透传）· `src/core/parse.ts:412-421`（规则判据 `Number.isInteger(count)`，detail 里回填 `execution_count`）· `:225-231`（hint）
问题描述：`jsonValueOf` 的递归投影只覆盖 `application/json` 的**值**，`execution_count` 这类**文档字段**没有任何投影。
详细分析（**主审实测**）：
```
文件 "execution_count": 9007199254740993（Python 侧合法整数；nbformat.validate = VALID）
read  → "execution_count": {"__ipynb_exact_number__": "9007199254740993"}     ← marker 漏进模型可见响应
edit  → 我这一格未被拒（该 cell outputs 为空，按 D-049 规则不触发）
        子代理在"cell 带 outputs"的情形实测被拒：selfcheck_failed rule=execution_count_negative，
        hint 断言 "this cell already violated … before the change"——而 nbformat 判 VALID（不实）
```
影响：① 模型看到一个文件里不存在、且任何文档都没定义的结构；② 合法文件被拒编辑且提示不实；③ 与 D-052 ②"绝不让内部 marker 出现在模型可见的响应里"直接矛盾。
可达性（如实）：正常 Jupyter 写出的计数是普通整数，需 `2**53+1` / `3.0` / `1e2` 这类手写或第三方工具写出的拼写才会触发——**触发面窄**。
修复建议：一处即可——在 `parse.ts` 建 cell 视图时把 `execution_count` 归一成 `number | null`（marker → `Number(literal)`；非数字保留原值以便规则报错），或在 read 与 `detail.problem` 两个出口做同样投影；顺带把规则拆出 `execution_count_not_an_integer`，让 hint 不再说谎。
设计文档对齐：D-052 ②、D-048、硬规则④"判据必须与外部权威一致"。

【V11-7】
严重程度：🟡 警告（**`D-053` 的 message 上界只数"条目"、不限"单条长度"，一个 mime 名即可击穿**）
所在位置：`src/core/outputs.ts:342`（`DROPPED_MIME_DETAIL_LIMIT`）· `:382-388`（`slice(0, 8)` + `… and N more`）
问题描述：整改把明细截到 8 个 `(cell, mime)` 对，但每个 mime **名字**仍原样拼接，而 mime 名完全由用户 cell 决定。
详细分析（**主审实测，真 kernel**）：
```
mime 名长  200 → message 270 字符
mime 名长 2000 → message 2070 字符          ← 线性：message ≈ 名字长度 + 70
子代理用 20000 字符的名字实测 → message 20,176 字符（只有 1 个条目）
对照：300 个不同 mime → 418 字符（8 条明细 + … and 292 more）✓ 条目维度确实收口了
```
即"用用户代码给响应定尺寸"这条路径只关了一半；`exec_timeout` 的 `detail.warnings` 会原样携带这 20 KB。
修复建议：渲染时截断**每个名字**（如 `mime.length > 64 ? mime.slice(0,64)+'…' : mime`），或明细只给 `cell N` + 种类计数；补一条用例：单个超长 mime 名 → `message.length < 400`。
设计文档对齐：D-053（不变式应是"**message 有上界**"而非"条目有上界"）、SPEC §4.1.12。

【V11-8】
严重程度：🟡 警告（**自研 parser 的三格语言边界：该严的松了、该深的浅了、序列化还会产非法 JSON**）
所在位置：`src/core/json-exact.ts:269-284`（`readString` 接受未转义控制字符）· `:174-193`（递归下降、无深度上限）· `:426` / `:457-459`（`map` + `join` 跳洞）· 对照 `src/core/parse.ts:53-56`
问题描述与证据（**子代理实测，主审引用**）：
```
① 控制字符（该严的松了）："tab<TAB>here" / "a<NUL>b"
     JSON.parse 拒绝（Bad control character）· Python json.loads 拒绝 · 我们接受
     随后一次 edit 把它转义成 \t / \u0000 → 【静默改写用户字节】且让非法文件变合法、无警告
② 深嵌套（该深的浅了）：depth 12000 → 我们 RangeError；JSON.parse 正常
     真 stdio：read → parse_failed "notebook file is not valid JSON"（对合法 JSON 是假话）
③ 稀疏数组（序列化会产非法 JSON）：[1,,3] → 我们 "[1,,3]"，JSON.stringify "[1,null,3]"；new Array(3) → "[,,]"
     当前不可达（readArray 永远 push），但这是 v10 硬规则⑤点名的格子
```
修复建议：① `readString` 对 `charCode < 0x20` 抛 `SyntaxError`（与 `JSON.parse` 一致），并把 NUL/TAB/CR/LF/0x1F 加进拒绝样本；② 给 Reader 加显式深度上限（如 512）并抛可区分的 `SyntaxError('JSON nesting too deep')`，`parse.ts` 依此给出准确文案；③ 序列化改成按下标循环（洞 → `null`）。
设计文档对齐：`json-exact.ts:126-135` 自己写的原则（"接受比格式更多 = 会写出权威拒绝的字节"）、SPEC §7 `parse_failed`、硬规则⑤。

【V11-9】
严重程度：🟡 警告（**测试套件会写进并删除用户的 venv —— "外来 venv 不删"的承诺不成立**）
所在位置：`tests/integration/test-venv.ts:109-118`（外来且不可用 → 文案说 "leaving it alone"）· `:131-136`（**仍对同一目录** `python -m venv --system-site-packages` 并打 marker）· `:146`（不可用则 `rmSync`）· 用例 `tests/unit/test-venv-ownership.test.ts`（用 `IMPOSSIBLE` 模块，**永远走不到 build 分支**）
问题描述：`TEST_VENV_DIR` 是固定路径。当 `IPYNB_TEST_VENV` 指向**用户自己的**环境（v7-14 记录的复用方式）且该环境缺依赖时，帮助器先说"不动它"，随后**写进用户环境**并盖上"本套件创建"的 marker；下次该目录不可用时，marker 让删除分支成立 → **用户的 venv 连内容一起被删**。
详细分析（子代理**直驱真 helper** 两步实测）：call 1 打印 "leaving it alone and using the base interpreter"，但实际 `chosen = 外来 venv 的 python`、且 `.ipynb-mcp-test-venv` marker 已种入外来目录；call 2 该目录仍不可用 → **整个用户 venv 被 `rmSync` 删掉，用户文件（sentinel）一并消失**。
修复建议：`resolveVenv` 在"目录存在且无 marker"时必须**完全不写该目录**（不 build、不打 marker）——直接返回 BASE_PYTHON（与文案一致），或把新 venv 建到 `mkdtemp` 的独立路径并把"用了哪条路径"作为返回值。用例：外来目录 + base 可用 → 断言目录**字节级未变**、无 marker、返回 base；再加一条"外来目录绝不被 rmSync"。
设计文档对齐：AGENTS §9（承诺必须与行为一致）、V7-14/V8-12 的整改目标、README 对 `IPYNB_TEST_VENV` 的说明。

【V11-10】
严重程度：🟡 警告（**图片降级警告不指名 cell；read 不去重、run 去重，两边都不可归因**）
所在位置：`src/core/outputs.ts` 的 `image_materialize_failed` 文案（"failed to decode image at output N"，N 是**输出**下标）· `assembleCallWarnings` 的按 message 去重 · `src/mcp/render/read.ts` 的逐 cell push（无去重）
详细分析（子代理实测，三个 cell 各自坏图）：
```
READ : 3 条一模一样的 "failed to decode image at output 0; …"      ← 无法知道是哪个 cell
RUN  : 去重成 1 条                                                  ← 丢掉的恰恰是"哪几个 cell"
对照 dropped-mime 文案："dropped 1 mime value(s) nbformat cannot store (cell 0: text/plain)"  ← 合格
```
修复建议：文案改成 `failed to decode image at cell <i> (output <j>, <mime>); artifact_path and image_index stay null`，让去重不再损失归因；补一条"3 个 cell 坏图"的用例断言消息可区分。
设计文档对齐：SPEC §4.4、§7；v9-7 立下的判据（"message 同时带 cell 与 mime"）。

【V11-11】
严重程度：🟡 警告（`check-docs` 还剩两格，V10-8 只修了一半）
所在位置：`scripts/check-docs.mjs:52-62`（`declareCount` 只扫前 12 行且格式严格）· `:108-114`（"末行 = 声明计数"是唯一交叉校验）· `:310-318`（跳过与 `minimumApplied`）
详细分析（子代理在文档副本上做 8 类变异 + 6 类合法修订）：
```
6 类破坏性变异全部 check=1 / selftest=1 ✓（含删末行、追加新编号、破坏 §12 逐字副本）
❗ 同时删末行 + 把 entries: 54 改成 53 → check=0 且 selftest=0（计数是自证的）
❗ 把 entries: 54 改成 entries: 54 rows（纯格式漂移）→ check=0 但 selftest=1 → pnpm lint 红（合法文档却红）
```
第二格与 V10-8"守卫不得因无关原因失败"同族，只是触发条件从"字面量不存在"变成"规则被文档形状关掉"。
修复建议：① 增加**不可自证**的锚（如 `DEVIATIONS.md` 记 `high_water: NN` 只增不减，或 CI 对比 `git show HEAD~1` 的计数）；② `declareCount` 读不到时，把依赖它的变异标为 **skipped 并大声提示**（而不是报"expected …, got []"），并纳入 `minimumApplied` 判定。
设计文档对齐：AGENTS §9、V10-8 的整改目标。

【V11-12】
严重程度：🟢 建议（两小项）
① **`1e400` 交付 `null`，文案却说客户端会读到 `Infinity`**（`src/core/outputs.ts:604-605/617-626`）：实测 `item.value = null`、message 写 "a JSON client reads it as Infinity"。投影是对的（JSON 不能携带 Infinity），但**文案必须描述实际交付的载荷**——改成"超出 double 范围；已按 `null` 交付，精确数字见本警告"（这正是 v10-2 建议的"明确说按 null 呈现"，本轮只改了一半）。
② **全字符串数组 `['a','b']` 仍被 join 成 1 字节"图片"并写 artifact**：两条路径一致、无警告；字面量 `"ab"` 恰好落在合法 base64 字母表里，**无法从值本身分辨**——建议**不要**加魔数检查（会误伤 Jupyter 的分行 base64），而是在 D-054 里把这一格写成已知行为。

---

## 四、七个审查维度逐条覆盖

**1. 架构与模块对齐** —— 未发现明显问题
`json-exact.ts` 仍是纯 core（无 I/O、无时钟）；图片窄化现在**两条路径共用一处**（v10 F5 的根因消除）；`run.ts` 的警告装配仍只有一处（`pushCallWarnings`），且取消/超时/kernel_died 三个出口都从 `error.detail` 回收 `executed`/`warnings`/`write_back`（`src/mcp/tools/run.ts:241-288`）——这正是 SPEC §4.8 规则 3 要的形状。

**2. 代码质量与可维护性** —— 未发现明显问题
`losesPrecision` 的注释与 D-048 把"为什么用警告、而不是新增错误码"讲清了；`outputTruncatedWarning` 的 `… and N more` 有常量与实现对应；危险键的修复用了 `defineProperty` 并保留可读性。**唯一**是 V11-1 的判据（写法 vs 值）表述不清。

**3. 健壮性与错误处理** —— 1 项（V11-1）
危险键 5/5 存活、marker 不可伪造、取消出口带 warnings、图片形状不再伪造、消息有上限 ✓。V11-1 不损坏数据，但它是对模型的**错误陈述**。

**4. 性能与资源效率** —— 未发现明显问题
`json-exact` 仍是单遍解析；警告消息现在有界（300 项 → 312 字符）；图片窄化统一后没有新增遍历。

**5. 安全性** —— 未发现明显问题
原型污染面已关闭（这是本轮最重要的安全修复）；`__proto__`/`constructor`/`prototype`/`hasOwnProperty`/`toString` 五键实测均不再改写文件；产物 140 项无 `.pyc`；连接文件不落工作目录。

**6. 测试覆盖与自测质量** —— 未发现明显问题（内部一致性问题见子代理）
单测 **552**（+120，30 文件）、集成 **58**（+8，8 文件）、smoke **26/26**；`check-docs --selftest`、`check-package`（22 变异）、`check-indent`（28 样例）三个自测矩阵保持。**缺口**：V11-1 说明"数字形态矩阵"仍缺**写法维度**（`100.0` / `1e2` / `e-07` 这类合法写法没有用例断言"不得警告"）。

**7. 依赖与配置** —— 未发现明显问题
运行期依赖仍只有 SDK；CI/`prepublishOnly` 闸门不变；文档数字与实测逐项一致。

---

## 五、总体评估

### 1. 整体质量评级：**C（需返工）**

> **本条在我初稿里是 B；两路复核落地后按我第 10 轮事前写死的评级尺子下调为 C** —— 尺子写明"**存在 🔴，或 ≥2 条 🟠，或存在虚报/静默改写 → C**"，而本轮**同时触发后两条**。

**为什么是 C**：**四条 🟠**——**V11-5**（默认 read 出口静默舍入且零警告）、**V11-3**（取消后的空壳终态使 V10-7 在常见流程下等于没修）、**V11-1**（普通 Python 浮点被误报"不可精确表示"，且守卫自我循环无法证伪）、**V11-2**（一条被一行代码证伪的假前提撑着 marker 的身份）；外加 **V11-4 虚报复发**（`REVIEW-FIX-STATUS.md:52` 宣称两项已修而实际都未修）。

**为什么"这个 C"比 v10 的 C 轻**：v10 是"新引入的、可达的静默写坏用户数据"，本轮**没有可达的静默改写**（族 6 三张矩阵全绿）；四条 🟠 里两条是"**对模型说了不准确的话**"（V11-1/V11-5）、一条是"**事实到达的时机**"（V11-3）、一条是"**承重注释是假的**"（V11-2）。修复量合计约"一处判据 + 一句文案 + 一段警告提升移出分支 + 一个 status 字段 + 一句注释 + 一条断言 + 一行状态表"。

**为什么不是 B**：四条 🟠 都直接决定"模型读到的是不是真话"——这正是十二轮里反复付出代价的那一类（v11 报告开头 §0 的故事线第四拍就是"误判无人能当场证伪"）；且虚报族复发，说明**门禁还没覆盖"我们对自己说的话"**。

**为什么不是 D**：全部修法都是局部的，不涉及架构返工。

**为什么不是 D**：所有修法都是局部的，不涉及架构返工。

### 2. TOP 3

| # | 事项 | 为什么 | 修复量 |
|---|---|---|---|
| 1 | **V11-5（🟠）**：把 `read.ts:138-142` 的警告提升**移出 `full` 分支**（summary 也执行 `collectOutputWarnings` 并入 `warnings[]`）；补一条"summary 下读同一文件必须带警告"的用例 | **默认出口**把 `9007199254740993` 显示成 `…992`、把 `1e400` 显示成 `null` 且零警告——踩 SPEC §5.4「禁止静默截断」，而且这是大多数 agent 实际走的那条路 | 小（移动一段代码 + 1 条用例） |
| 2 | **V11-3（🟠）**：cancel 时的空壳终态——加 `facts_pending: true`（或 cancel 时同步已完成 cell 的 `executed`/`warnings`）；补"cancel 后立刻读 status"的用例 | 文件**确实**在那之后被改写、值被丢，而客户端在 10–28 秒里被告知"什么都没发生"——**V10-7 的修复在这条路径上等于没修**（装配对了、送达时机没解决） | 小-中（handle/status 一侧，不动 run 主循环） |
| 3 | **V11-1（🟠）**：判据拆成"值是否变化"（十进制归一化比较、整数用 BigInt）与"拼写是否变化"，只对前者发警告；`-0` 单独文案；**并把 `json-number-forms.test.ts:350` 的期望改成独立断言** | 普通 Python 浮点（`2.0`/`100.0`/`1e-05`）必带假警告 → 模型会学会忽略 `output_truncated`，**v9/v10 两轮建立的"不精确必须告知"随之失效**；而现有守卫的期望由被测判据自己推导，无法证伪 | 小（判据 + 文案 + 用例期望） |

紧随其后：**V11-2**（订正 `json-exact.ts:63-68` 与 D-050 的假前提 + 钉一条"克隆即失效"的断言；若要跨克隆 marker 则换 `WeakSet`/boxed String）→ **V11-4**（订正状态表那行 + 把"可 grep 产物"做成门禁；顺带修幽灵符号与恒真断言）→ **V11-7**（message 上限按**字符**截断每个 mime 名）→ **V11-9**（外来 venv **绝不** build/打 marker，并补"外来目录字节级不变"的用例）→ **V11-6**（`execution_count` 做数值投影 + 规则名/hint 拆开）→ **V11-8**（三格语言边界：控制字符拒绝、嵌套深度上限、稀疏数组序列化）→ **V11-10**（图片降级警告带 cell）→ **V11-11**（`check-docs` 的不可自证锚 + 格式漂移时跳过而非报红）→ **V11-12**（`1e400` 文案与 D-054 的已知行为）。

### 3. 与原始设计文档的偏离清单

| 偏离 | 性质 | 状态 |
|---|---|---|
| json 值"原文保真"：盘上逐字节保留 ✓，精确数字随警告交付 | 已登记 **D-048** | ⚠️ 判据把"写法"当"精度"（V11-1），需按本条收敛 |
| 内容块 `data` 由已解码字节重新编码 + 组装前合法性过滤 | 已登记 **D-047** | ✅ 本轮图片五形状两路径一致性实测通过 |
| `execution_count >= 0` 规则作用域（判 cell 状态）与 hint 文案 | 已登记 **D-049** | ✅ hint 现在与行为一致（实测） |
| sidecar 清扫、协议错误 vs 产品错误、语义借用等 | D-046 / D-047 / D-041-042 | ✅ 保持 |
| **新增**：`__proto__` 等语言语义键的解析约定（DefineOwnProperty 语义 + marker 用"形状 + 不可扩展"判定） | 已登记 **D-050 / D-051 / D-052 / D-053 / D-054**（子代理核对：与代码**逐条一致**） | ⚠️ D-050 与 `json-exact.ts:63-68` **共享同一条被证伪的前提**（"`structuredClone` 保留不可扩展性"）→ V11-2，需一并订正 |
| **新增**：marker 的**跨克隆**行为（克隆即失效；序列化路径不得使用克隆） | **未登记** | 🟡 建议写进 D-050 + 配一条回归断言 |
| 取消后"终态先于 detail"的窗口（实测 10–28 s） | **未登记**（D-052 ③ 声称四出口"共用装配"，但那说的是装配、不是送达时机） | 🟠 V11-3：建议加 `facts_pending` 字段并写进 §4.6.3 |
| **默认 read 出口（summary）不提升警告** | 与 SPEC §4.3/§5.4 与 D-048/D-052 不变式②冲突 | 🟠 V11-5 |
| **marker 从 `execution_count` 漏进响应** | 与 D-052 ②"绝不让内部 marker 出现在模型可见响应里"冲突 | 🟡 V11-6 |
| **测试帮助器会写进/删除用户的 venv** | 与 V7-14/V8-12 的整改目标、以及它自己打印的 "leaving it alone" 相反 | 🟡 V11-9 |
| `REVIEW-FIX-STATUS.md:52` 宣称两项已修而实际未修 | 违反状态表自己定的规矩 | 🟡 V11-4（虚报族复发） |
| `check-docs` 的"末行 = 声明计数"是自证锚；文档格式漂移会让 lint 红 | 与 V10-8"守卫不得因无关原因失败"同族 | 🟡 V11-11 |

### 4. 后续开发建议

- **发布判断**：修掉 **V11-5 + V11-3 + V11-1 + V11-2 + V11-4**（合计约"移动一段代码 + 一个 status 字段 + 一个判据 + 一句注释 + 一条断言 + 一行状态表"）即可发 `0.1.0`。发布闸门（CI 9 job + `IPYNB_REQUIRE_NBFORMAT` + `prepublishOnly`）齐备，**没有未闭合的 🔴**。
- **唯一剩下的非代码门**：**E1–E9 真实第三方客户端矩阵（0/9）**。这一轮之后代码侧的边际收益已经很低——剩余风险几乎都在"真客户端怎么用"上。
- **给下一轮的三条新规矩**：
  - **第 6 条｜矩阵要包含"写法"维度**：判据是"**值不变但写法变**的输入，只允许产生'无警告'或'关于写法且事实正确的警告'"。（V11-1）
  - **第 7 条｜注释里的"不变量"必须配一条断言，否则降级为"已知限制"**：凡写着"X 会保留 Y"的承重注释（别的代码依赖它），必须有一条测量它的用例。（V11-2）
  - **第 8 条｜终态与事实必须同时到达**：任何"立即发布终态、事实随后补齐"的设计，都必须有一个显式字段告诉客户端"仍在收尾"；否则客户端会把空壳当答案（V11-3），而这类缺陷**在单元测试里看不见**（它只存在于"两次查询之间的时间"里）。
- **把"可 grep 产物"从纪律变成门禁**：`check-docs.mjs` 已能查编号唯一性、末行计数与逐字副本，再加一条机械规则——"状态表里 ✅ 行的断言必须包含一个**存在**的符号或 `文件:行`"——虚报族就无法复发（V11-4）。
- **低优先**：`README` 的 `process.env` 安全声明（v8 起未做）。

---

## 附录：验证分工与局限

- **主审亲验（一手证据）**：全部门禁（typecheck / lint 含三个自测 / unit **552·30** / integration **58·8** / smoke **26/26** / check:package **140 + 22 变异**）；**重建 5 组探针**——① 危险键矩阵（5 键 × read + 编辑无关 cell 的盘上键数）；② 数字字面量矩阵（18 种 × 编辑无关 cell 的盘上字节 + 读值 + 警告）；③ 嵌套 marker（3 形状 × item/call warnings）；④ 图片数组（5 形状 × read/run 两路径）；⑤ 取消出口（真 kernel，取消前确保 cell0 完成）与警告上限（300 个 mime → 312 字符，含 `… and N more`）；另有 marker 伪造、Python `json.dumps` 写法对照、hint 真话核对、文档数字与 DEVIATIONS 唯一性核对。
- **子代理复核（两路）**：
  - **① v10 整改验收（已完成并入）**：独立 `git worktree`（**非 junction**）+ **10 组源码变异** + 5 组真 stdio 探针；门禁亲跑全绿（含 `documentation self-test: ok (10 mutations, 0 skipped)`）；**六条真实缺陷（V10-6 / V10-3 / V10-1 / V10-7 / V10-4 / V9-1 残留）全部独立复现为真修复**，且守卫**都能真红**（变异分别造成 11 / 12 / 11 / 4 / 1 / 1 条用例失败）；`check-docs` 的三类缺口变异都能红、且**不再因合法修订变红**（SPEC §12 与 `OPEN_QUESTIONS.md` 同步改措辞、`Q3`→`Q4` 都 exit 0）；`DEVIATIONS.md` 54 行 / 54 编号唯一 / D-001…D-054 连续，新增 D-050…D-054 与代码逐条一致。**同时发现**：`json-exact.ts` 的 `structuredClone` 假前提（V11-2）、取消窗口（V11-3）、幽灵符号与恒真断言未修而状态表宣称已修（V11-4）、以及**三处装配 wiring 的变异全部存活**（含"后台 `handle.warnings` 写回"这一处**完全没有测试**）。
  - **② v11 diff 新问题猎取（已完成并入）**：14 组探针（**87 例语言边界矩阵** × 纯函数与真 stdio 两条路径、**10 形状 × read/run 两路径**图片矩阵、5 条出口的真 kernel warnings、`check-docs` 8 类变异 + 6 类合法修订、venv 所有权两步实测、**取消窗口 9 个快照**、黑箱会话 + 资源增量、深度阈值、非有限值、`tsc --outDir` 重建比对）。**确认 v10 六条主缺陷真修**（含超出要求的 `__proto__`/数字矩阵），**并发现**：取消后的空壳终态（V11-3，它把 V10-7 的修复在常见流程下抵消）、summary 出口静默舍入（V11-5）、message 上限按条目而非字符（V11-7）、parser 三格语言边界（V11-8）、venv 所有权会被自己污染（V11-9）、图片警告不指名 cell（V11-10）、`check-docs` 两格未收口（V11-11）。它还独立核实：`lib/` 与重建产物**逐字节一致**（34 文件）、`src/core/*` 无 I/O/时钟/随机、客户端 close 后 **server 与 sidecar 1 秒内退出**、连接文件与 python 进程**零残留**、CAS 旧 hash 被正确拒绝、非有限值不炸协议。
- **环境诚信（子代理自述，我记录在案）**：其探针曾用 `CommandLine -like '*ipynb_sidecar.py*'` **全局**匹配并 `taskkill /T /F` 了 3 个 pid（约 21:40）；事后核对那 3 个 pid 均为 svchost 或已消失。**对本报告无影响**：我的集成套件（`58/58 exit 0`）在该时刻之前已成功结束，本轮我未再启动内核侧长任务。
- **主审与子代理的交叉一致性**：V11-1 / V11-2 / V11-3 / V11-5 / V11-7 五条双方各自独立复现，结论一致（V11-7 我用 200/2000 字符的 mime 名做线性外推，与其 20,000 字符的单点一致）；V11-6 我实测到"marker 漏进响应"，其"误拒"一半需要 cell 带 outputs（我这一格未触发，属条件差异，已在条目里写明）。
- **局限**：① 未做 macOS/arm64 与真实第三方客户端（E1–E9 仍 0/9）；② V11-1 我实测了 read 路径的 8 种写法与 `json.dumps` 对照，未穷举 run 路径的全部写法组合（子代理补了真 kernel 的 4 种）；③ 取消出口的 `kernel_died` 分支我未单独构造（子代理覆盖：后台 `kernel shutdown` 与同步 `os._exit(9)` 两条路径的 warnings 都实测非空）；④ 我未复跑 WSL 的 `linux-check --selftest`（子代理记录为 26/26）。
