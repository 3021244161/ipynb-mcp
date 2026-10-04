# ipynb-mcp 代码审查报告（第九轮 / v9）

> **审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp` @ HEAD `c78e36f`（v8 整改后，**8 个提交 / 37 文件 / +1605 −371**；工作树**干净**）
> **上轮基线**：`0af7f20`（v8 报告已归档为 `docs/review/ipynb-mcp-code-review-v8.md`）
> **方法**：主审亲跑六道门禁 + **v8 的原探针复跑**（json 全类型、补救操作、data-URL）+ **裸 JSON-RPC 逐形状定位**（绕开 SDK 校验看服务端到底发了什么）+ 两路复核
> **日期**：2026-10-04

---

## 一、门禁实测（主审亲跑）

| 门禁 | 实测 | 变化 |
|---|---|---|
| `pnpm typecheck` | exit 0 | ✅ |
| `pnpm lint` | 0 警 + `format check: ok` + `structural indent check: ok` | ✅ |
| `pnpm test` | **381 passed（25 文件）** | ↑ 287→381（+94） |
| `pnpm test:integration` | **46 passed / 46**，213.5 s，`VITEST_EXIT=0` | ✅ |
| `pnpm smoke` | **19/19** | ✅ |
| `pnpm build` / `npm pack` | exit 0；**132 文件、无 `.pyc`** | ✅ 修好 V8-9 |
| 工作树 | **干净** | ✅ |

---

## 二、v8 问题闭环核查

### 2.1 ✅ 真修复（主审亲验）

| v8 项 | 结论 | 主审证据 |
|---|---|---|
| **V8-1**（`+json` 一族写得进读不回） | ✅ **真修复** | 我的 json 全类型探针：`application/x+json:{a:1}`→`kind=json value={"a":1}`、`x/y+json:[1,2,3]`→原样、`+json:42`→`42`、`vendor+json:{k:"v"}`→原样；对照 `application/json` 同样正确 ✓ |
| **V8-2**（json **字符串**值被改写） | ✅ **真修复** | `application/json:"123"` → `{"kind":"json","value":"123"}`（**字符串保留**，此前是数字 `123`）；`"hello"` → `value:"hello"`（此前被降级成 `text/plain`）✓ |
| **V8-14**（补救操作自己也被拒） | ✅ **真修复** | 同一四步会话：改负计数 cell → `selfcheck_failed`（hint 已改为"clear_outputs resets it"）；**照提示做 `clear_outputs` → `applied=1`** ✓（此前同样被拒）；`set_cell_type` 与无关 cell 编辑均正常 |
| **V8-9**（产物带 `.pyc`） | ✅ **真修复** | `npm pack --dry-run` → **132 项、`.pyc` = none**；新增 `scripts/check-package.mjs`（+107）守产物内容 |
| **V8-5**（`usableInterpreter` 零调用） | ✅ **真修复** | 全仓 `usableInterpreter`/`prepareVenv` 命中 **15 处**（此前 1 处=定义）；`test-venv.ts` +124 |
| **V8-7**（sidecar 边界扩张未登记） | ✅ **已登记** | 新增 **D-046**："sidecar 启动时清扫**不是自己创建**的连接文件：仅限本工具前缀 + 解释器临时目录 + 能证明属主进程已消失（文件名带 pid）" ✓ 与代码一致 |
| **V8-6**（清扫用年龄判活） | ✅ **已修** | 同 D-046；新增 `scripts/check-connection-sweep.py`（+70）作守卫 |
| **V8-10**（一条 message 承载两个事实） | ✅ **已修** | `src/run.ts:558-562`：改为单一的 `outputTruncatedWarning`，注释写明"can carry BOTH facts (dropped values and truncated outputs). Pushing per cell let the first fact silence…" ✓ |
| **V8-13**（根目录探针脚本） | ✅ **已清** | `git ls-files | grep '^(patch-|probe-)'` → **空**（`patch-nbformat.mjs`、`probe-v7-1.mjs`、`probe-v74.mjs` 全部删除）✓ |
| **V8-15**（README 与代码相反） | ✅ **已修** | `README.md:101` 现为 "Integration tests create a dedicated venv **in the system temp directory** (never in the repository; …)" ✓ |

### 2.2 ❌ 未修 / ⚠️ 部分

| v8 项 | 结论 | 主审证据 |
|---|---|---|
| **V8-8**（`linux-check.sh` 的 `WORK` 守卫可被 `..` 绕过） | ❌ **未修** | `scripts/linux-check.sh:24-30` 仍是**未归一化**的 `case "$WORK" in /tmp/*|/var/tmp/*|"$HOME"/tmp/*)`，后面只额外拒绝**精确等于** `/tmp`、`/var/tmp`、`/` 三个值 → `WORK="/tmp/../etc"` 依旧通过，`rm -rf` 由内核沿 `..` 解析。注释里"the worst a mistyped variable can do is fail"对 `..` 不成立 |
| **V8-11**（权威问错解释器） | ❌ **未修** | `tests/integration/run.test.ts:910` 仍是 `nbformatSkipReason(VENV_PY)`，而同一文件的 `sidecarInterpreter`（`:43/:78`）可能已回退到 `BASE_PYTHON`。当前不易触发（venv 用 `--system-site-packages` 从 base 建，CI 的 base 装了 nbformat），但"预置 venv 缺 nbformat"时仍会把环境问题报成产品失败 |
| **V8-12**（共享 venv 的删除时机） | ❌ **未修** | `vitest.config.ts` 仍**没有** `fileParallelism`（integration config 有 `false`）→ `pnpm test` 与 `pnpm test:integration` 并行时仍有"单测 `afterAll` 删掉集成正在用的 venv"的窗口 |
| **V8-16**（同文件内被证伪的旧 ✅） | ⚠️ **待确认** | 我抽查到的 v5 段行（`:176/:177/:178`）现为"⬜ **漏列** | ✅ **本轮修复**"，是有意的历史标注 ✓；v8 点名的那两行（NEW-6「本轮修复」、NBFORMAT「用 `it.skip`」）我未逐字复核，见子代理结论 |
| **V8-4**（守卫不能失败） | ⚠️ **部分**（子代理变异实测） | 删掉 `src/run.ts:613-616` 的 `output_truncated` 调用点 → **135 条全绿**；删掉 `src/run.ts:594` 超时 detail 的 `warnings:` → **全绿**。只有"删 core 里的 `Set` 去重"这类**换了含义**的变异才会红 |
| **V8-5**（`usableInterpreter` 零调用） | ⚠️ **部分** | 五个集成文件已统一到 `prepareVenv()` ✓（15 处引用）；但 `usableInterpreter` **仍零调用**（全仓 2 处 = 定义 + 注释），**第六份复制仍在** `tests/unit/analyze-op.test.ts:19-214` |
| **V8-6**（清扫判活） | ⚠️ **部分 + 🔁 新误删** | pid 判活已实现、`check-connection-sweep.py` 在 WSL 真能失败 ✓；但 **mkstemp 后缀恰为全数字时被当作 pid** → 实测删掉活属主的文件；Windows 上 `os.kill(pid,0)` 是 TerminateProcess（代码直接返回 None）→ 全部退化为 **7 天**（实测 6 个属主已死的文件要等 7 天，旧规则 1 小时）；检查器**未接入任何门禁** |
| **V8-8**（`..` 绕过） | ❌ **未修且状态行不实** | `scripts/linux-check.sh` 本轮**未被改动**（`git diff` 为空）；WSL 实测 `/tmp/../etc`、`/var/tmp/../etc` 都被 ACCEPT；而 `REVIEW-FIX-STATUS.md:46` 称已 `readlink -m` 且"WSL 实测全拒" |
| **V8-9**（产物带 `.pyc`） | ✅ **真修（两点残留）** | 132 项、无 `.pyc`；`check-package.mjs` 对 `python/__pycache__`、`files` 回退、删 sidecar 三种变异都能红 ✓；但 `REQUIRED` 的 `lib/*` 行**不可失败**（删 `lib/bin.js` 仍 GREEN，prepack 会重建）；且**两个新守卫互斥**——跑 `check-connection-sweep.py` 会生成 `.pyc` 让 `check:package` 失败 |
| **V8-10**（一条 message 两个事实） | ⚠️ **部分 + 🔁 回归** | 合并计数做到了 ✓；但**超时路径重新丢掉"值被丢弃"的提示**（真 kernel 实测 `exec_timeout` 的 `detail.warnings = []`，v7 这里有一条）；message **丢失 cell 身份**（与 D-042 影响面不符）；`run.ts:605-612` 的注释描述的 `some()` 去重**已不存在** |
| **V8-11**（权威问错解释器） | ❌ **未修** | `run.test.ts:910/948/959/981` 仍是 `nbformatSkipReason(VENV_PY)`，而 run 用 `sidecarInterpreter`（`:43`，`:70-78` 回退 `BASE_PYTHON`） |
| **V8-12**（共享 venv 的删除时机） | ❌ **未修 + 注释反向不实** | 实测把带 marker 的健康 venv 复制后跑单文件 `analyze-op.test.ts` → **venv 被删除**（`afterAll(removeOwnedVenv)` 删的正是与集成共用的 marker venv）；`vitest.config.ts` 仍无 `fileParallelism`；`:204-211` 新注释称"deliberately KEPT … the code never did"——**与代码相反** |
| **V8-14**（补救操作） | ⚠️ **部分**（症状修好，文案与另一条规则仍错） | `clear_outputs` 现在 `applied=1` ✓；但 hint 声称"clear_outputs resets the cell execution count"，实测**计数仍 -1、文件仍 INVALID**；`non_code_cell_has_execution_count` 仍推荐 `clear_outputs` → 实测 `invalid_ops`（详见 V9-8） |
| **V8-15**（README 与代码相反） | ✅ README 真修 / ⚠️ 注释修反 | `README.md:101` 已改为"系统临时目录 + `IPYNB_TEST_VENV` 覆盖" ✓；`analyze-op` 的新注释反向不实（见 V8-12） |
| **V8-16**（同文件内被证伪的旧 ✅） | ✅ **真修** | `REVIEW-FIX-STATUS.md` 的 NEW-6 与 NBFORMAT-GATE-SILENT 两行都已改删除线 + "已撤回（见第七轮段）" |
| **V8-17**（check-indent 守卫不可证伪） | ❌ **未修**（已如实登记） | `check-indent.mjs:195` 改成 `if (true)` 仍 exit 0，自测矩阵也没有对应样例 |

---

## 三、本轮新发现

【V9-1】
严重程度：🔴 阻塞（**由本轮 V8-3 的修法新引入**）
所在位置：`src/mcp/render/read.ts:126-128` 与 `src/run.ts:517-520`（内容块构建）· 对照 `src/core/outputs.ts:478` 的 `stripDataUrlPrefix`（本轮新增，只作用于**物化/解码**路径）
问题描述：**含 data-URL 图片的 notebook 现在连读都读不出来**——`notebook_read` 与 `notebook_run` 都以 `-32602 Invalid tools/call result` 失败。
详细分析（**主审用裸 JSON-RPC 逐形状定位**，绕开客户端校验以确认是服务端行为）：
```
8 种形状逐条实测（真 stdio，notebook_read）：
  image-b64       -> ok blocks=[text,image]      ← 正常
  image-dataurl   -> ERROR -32602: Invalid tools/call result …
  （text / json-object / json-string / plusjson / image-nonstring / stream 均 ok）
notebook_run（display({'image/png': 'data:image/png;base64,…'}, raw=True)）-> ERROR -32602
```
服务端校验细节：某个 `type:'image'` 内容块的 `data` **不是合法 base64**（`{"data":"Invalid Base64 string"}`）。SDK 的判据是 `z.string().refine(v => atob(v))`。
根因（两条路径不一致）：本轮给**解码/物化**加了 `stripDataUrlPrefix`（所以 data-URL 现在能解码、进入 `materialized`），但**内容块构建**仍从文档取**原始值**：
```ts
// src/mcp/render/read.ts:126-128（src/run.ts:517-520 同形）
const base64 = rawOutput?.data?.[image.media_type];
if (typeof base64 === 'string') imageBlocks.push({ data: base64, media_type: image.media_type });
```
**放大器（子代理发现、主审复现）**：失败的那次 run **仍然把 data-URL 写回了文件**（盘上 `execution_count=1` + 该输出），此后**该 notebook 的 read 与 run 都永久 `-32602`**——即"工具写出了自己再也读不回的文件"。（文件本身仍是合法 nbformat，所以别的工具不受影响。）
**完整失败集合**（子代理 17 例 read + 16 例 run 矩阵）：`data:<anything>;base64,<应用层可解码载荷>`，含 ① 合法载荷 ② **空载荷** `data:image/png;base64,` ③ **标签不符**（`data:image/jpeg;…` 挂在 `image/png` 键）④ **字符串数组形式** `["data:image/png;base64,…"]`（read 侧 join 后仍是 data-URL）。其余形状（非字符串/空白/非 base64/含换行/超大）最坏只是**降级**，不会失败。
修复建议（两条一起做）：
```ts
// ① 内容块优先用"已经解码好的字节"，不要再回读文档原值
imageBlocks.push({ data: materialized.base64, media_type: image.media_type });
// ② 若必须回读，就走同一个 helper，并做一次 base64 合法性校验
import { stripDataUrlPrefix } from '../../core/outputs.js';
const raw = rawOutput?.data?.[image.media_type];
const base64 = typeof raw === 'string' ? stripDataUrlPrefix(raw, image.media_type) : null;
if (base64 !== null && base64 !== '' && /^[A-Za-z0-9+/=\s]+$/.test(base64)) imageBlocks.push({ data: base64, media_type: image.media_type });
```
③ **补一条能对当前 HEAD 变红的断言**（本轮最该补的，子代理已实测"当前 HEAD 红、最小修复后绿"）：smoke 的 `call()` 目前**只收集 `type==='text'` 的块**，且它的 3 个 cell 从不产生图片 → 图片块对它完全不可见。应加：
```js
check('an image output does not fail the whole tools/call', error === null);
check('every returned image block carries SDK-valid base64', blocks.length > 0 && badBase64 === null);
```
设计文档对齐：SPEC §4.4（物化与返回图片块是同一件事）、§4.8（错误码契约）、§6 R2；AGENTS §9。

【V9-5】
严重程度：🔴 阻塞（**大整数 JSON 被静默改写**，与 V8-2 同类、发生在 number 域）
所在位置：`src/core/outputs.ts` 的 json 值投影（`RawOutput.data` 放宽为 `unknown` 后按 JSON 语义传递）· 侧车/写回路径的数值序列化
问题描述：`application/json` 里的**超出 IEEE-754 安全范围的大整数**在读出时被四舍五入，**run 路径还会把四舍五入后的值写回盘**，全程零 warning。
详细分析（**主审实测 read 半**，子代理实测 run 半）：
```
文件文本精确写 application/json: 18446744073709551616
  read -> served = 18446744073709552000   rounds=true   warnings=[]
  run  -> 响应被四舍五入，且【盘上被写回成 18446744073709552000】（原值永久丢失，零 warning）
```
这正是 V8-2（json 字符串被 parse 成别的类型）的**同类**，只是发生在 number 域；而本轮刚写进 AGENTS §9 的"全部合法类型矩阵"（19 mime × 5 类型 = 95）**自身没有覆盖 number 精度**。
影响：用户的 `application/json` 输出（大整数 ID、哈希前缀数字、天文/加密场景）会被静默改写，且 run 路径造成**磁盘上的永久数据丢失**。
修复建议：json 值在传输/写回时保持**原文精度**——最简做法是在 `rawOutputsOfCell` 侧保留**原始文本片段**（`RawOutput.data` 对该键存字符串原文），投影与写回都直接用它；若走数值通道，须用 BigInt 安全的解析/序列化（`JSON.parse` 的 reviver + `JSON.stringify` 的 replacer，或 `json-bigint` 式策略），并在超范围时**给 warning**（宁可提示"该值超出精确表示范围"，也不要静默改）。补一条用例：`2**64`、`2**53+1`、`-2**63` 三种边界，断言 read 与盘上均与原文逐字节一致。
设计文档对齐：SPEC §5.4 第 7 行、§6 R2「不静默改坏」、§4.8（写回规则）；AGENTS §9（本轮新加的"全部合法类型矩阵"必须把 number 域纳入）。

【V9-6】
严重程度：🟠 严重（本仓的**权威文档被拼接损坏**）
所在位置：`docs/DEVIATIONS.md`（提交 `ba7b3cf`）；症状：`:50` 的 D-044 行在 `` `^application/(.*\+)?json `` 处断掉，紧跟 `# DEVIATIONS …` 表头，之后是 **D-001…D-043 的第二份**，`:99` 才是 D-044 的尾巴
问题描述：整份文档（表头 + 全表）被嵌进了 D-044 那一行内部，文件从 54 行变成 **104 行**。
详细分析（**主审实测**）：`D-001` 出现 **2 次**（`Select-String '^| D-001 '` 命中 2），D-044 被劈成两段（第一段是旧内容）。后果：每条偏离出现两次；读者/下一轮评审无法判断哪份是最新；而这是"每次偏离当场写"的**唯一**登记册。lint 不查 markdown，所以门禁全绿。
修复建议：把文件恢复成单份（保留后一份完整表 + D-044 的正确版本），并在 `pnpm lint` 或新的 `check-package` 类脚本里加一条"markdown 表头/编号唯一性"自检（例如断言 `^# DEVIATIONS` 恰好 1 次、每个 `D-0NN` 编号恰好 1 行）。
设计文档对齐：AGENTS §2（`docs/DEVIATIONS.md` 的用途）、§8。

【V9-2】
严重程度：🟠 严重（验证能力的缺口，与 V9-1 同源）
所在位置：`tests/unit/outputs.test.ts:616-624`（只测投影）· `scripts/e2e-smoke.mjs:71-85`（3 个 cell 从不产生图片）与 `:100-104`（`call()` 只收集 `type==='text'` 的块）· `tests/unit/render-read.test.ts:146-158`（只数块的数量）
问题描述：本轮为 V8-3 新增的用例**只断言模型可见的 OutputItem**（`bytes>0`、`__decodeFailed===false`），**全仓没有任何用例校验过内容块的 `data`**（`grep imageBlocks` 只有计数断言）——于是"解码层修好、块层没修"这一半成品被测试与门禁同时放行。
详细分析：这已是**第三次**同型（v5 FRAME-1 计数器恒 0 → v8 run-reporting 把生产逻辑抄进测试 → 本轮只测投影不测块）。共同点：**新守卫测的是我改的那一层，而不是用户拿到的那一层**。
修复建议：见 V9-1 ③（smoke 两条断言，子代理已实测当前 HEAD 红、最小修复后绿）；另加一条单元级断言：直接喂含 data-URL 的 rawOutput，断言产出的块 `data` 通过 `atob` 且等于解码结果。
设计文档对齐：AGENTS §9。

【V9-3】
严重程度：🟡 警告
所在位置：`src/mcp/tools/result.ts:35-38`（内容块组装）
问题描述：一旦内容块不合法，**整次调用以 `-32602` 失败**，而不是降级为"这张图我给不了 + 一条警告"。
详细分析：图片渲染层的一个字段错误会吞掉**整个工具的返回值**（连文本与其它图片一起没了）。SDK 的行为（校验失败即抛协议错误）我们改不了，但可以选择**在组装前自己校验一次**，把不合法的情况降级为产品级警告。
修复建议：在 `result.ts` 组装前加"块合法性"过滤（`data` 非空且匹配 base64 字符集），不合法的块丢弃并附 `image_materialize_failed`；这样将来再出现畸形图片值，用户得到的是产品级降级而不是工具整体不可用。
设计文档对齐：SPEC §4.4、§7（错误码闭集）、D24。

【V9-7】
严重程度：🟠 严重（V8-10 的**回归**：超时路径重新丢掉"值被丢弃"的提示）
所在位置：`src/run.ts:581-595`（超时 throw）· `:613`（warning 在循环之后才生成）· `docs/DEVIATIONS.md` D-042 的状态列
问题描述：把"丢弃"提示改成**循环后统一生成**之后，`exec_timeout` 的 `detail.warnings` 又变成了空——v7 曾经修好的那一格回归了。
详细分析（子代理真 kernel 实测）：cell0 `display({'text/plain':5}, raw=True)` + cell1 `sleep(30)`、`timeout_seconds=3` → `exec_timeout` 的 `detail.warnings = []`（v7 这里有一条 `output_truncated`）。另外：合并后的 message **丢失了 cell 身份**（`droppedMimes` 是扁平 `string[]`），与 D-042 影响面写的"message 指名 cell 与 mime"不符；`src/run.ts:605-612` 的注释仍在描述一条**已不存在**的 `some()` 去重。
修复建议：在生成 warning 时保留 `(cellIndex, mime)` 对；超时/失败出口复用同一个装配函数（保证两条路径都带上已收集的 warnings）；订正 D-042 的状态列与过期注释。
设计文档对齐：SPEC §4.8、§7 边界段、D-042。

【V9-8】
严重程度：🟠 严重（V8-14 的**残留**：提示文案仍与行为不符，且另一条规则仍推荐无效操作）
所在位置：`src/core/parse.ts:269`（注释）、`:275-276`（`escapeHatchFor` 的同一句 hint）· `src/core/edit.ts:321-325`
问题描述：`clear_outputs` 现在**能成功**（主诉已解决 ✓），但 hint 声称"clear_outputs resets the cell execution count"，实测**计数仍是 -1**、`nbformat.validate` 仍 FAILED；并且 `non_code_cell_has_execution_count` 也走同一句 hint → 对 markdown cell 推荐 `clear_outputs`，实测返回 **`invalid_ops`（requires a code cell）**，只有 `set_cell_type` 可行。
详细分析：`parse.ts:269` 的注释（"clear_outputs now resets the count as well, so both entries below are true"）与同轮 `edit.ts:321-325`（"只清 outputs、不动 execution_count"）**自相矛盾**；新用例 `edit-tool.test.ts` 只覆盖 code cell 那一半，且 `expect(hint).toContain('clear_outputs')` 反而**把错误文案钉住**。
修复建议：① 要么真的让 `clear_outputs` 重置计数（更符合"清输出即作废计数"的直觉），要么把 hint 改成"clear_outputs 之后用 set_cell_type 或手工改 execution_count"；② hint 必须**按规则**生成（非 code cell 的规则只能推荐 `set_cell_type`）；③ 用例改成"按 hint 的建议操作后，文件必须转为 VALID"（而不是断言 hint 里出现某个词）。
设计文档对齐：SPEC §4.1.11（失败一次可重试）、§4.5、D-037 ②。

**其余 🟡（子代理实测，均为"v8 已点名、本轮未修或修了一半"）**：
- **V8-4 仍是部分**：删掉 `src/run.ts:613-616` 的 `output_truncated` 调用点（我 v8 报告 M1 的字面含义）→ **135 条全绿**；删掉 `src/run.ts:594` 超时 detail 的 `warnings:` → **全绿**。`run-reporting.test.ts:202-227` 自己 `new IpynbError(...)` 再走 `toCallToolResult`，只证明了"投影层会透传 detail"。
- **V8-5 仍是部分**：五个集成文件确实统一到 `prepareVenv()` ✓，但 `usableInterpreter` **仍零调用**（全仓 2 处 = 定义 + 注释），且**第六份复制仍在** `tests/unit/analyze-op.test.ts:19-214`。
- **V8-6 部分 + 新误删**：pid 判活已实现 ✓，检查器在 WSL 真能失败 ✓；但 **mkstemp 随机后缀恰为全数字时会被当成 pid**（概率 ≈3.5e-5/文件），实测 `ipynb-mcp-k-<活pid>-12345678.json` → **删掉了活属主的文件**；另外 **Windows 上 `os.kill(pid,0)` 是 TerminateProcess，代码直接返回 None** → 全部落进"7 天"分支（实测 %TEMP% 10 个文件、6 个属主已死，旧规则 1 小时就清），且该检查器**未接入任何门禁**、"shutdown 后再扫"未做。
- **V8-9 两点残留**：`REQUIRED` 里的 `lib/*` **不可失败**（删掉 `lib/bin.js` 仍 GREEN，因为 prepack 会重建）；两个新守卫**互斥**——跑 `scripts/check-connection-sweep.py` 会生成 `python/__pycache__/*.pyc`，从而让 `check-package.mjs` 失败（建议给 sweep 脚本设 `sys.dont_write_bytecode = True`）。
- **V8-12 仍未修 + 注释反向不实**：实测把带 marker 的健康 venv 复制后跑单文件 `analyze-op.test.ts` → **venv 被删除**（`afterAll(removeOwnedVenv)` 删的是与集成共用名字的 marker venv）；`vitest.config.ts` 仍无 `fileParallelism`；`:204-211` 的新注释称"deliberately KEPT … the code never did"——**与代码相反**。
- **V8-17 仍未修**：`check-indent.mjs:195` 的 `ownsLine` 守卫改成 `if (true)` 仍 exit 0（自测矩阵也没有对应样例）；已在 §8.3 如实登记。
- **V8-8 未修且状态行不实**：`scripts/linux-check.sh` 本轮**未被改动**（`git diff 669bbea~1 c78e36f -- scripts/linux-check.sh` 为空），仍是未归一化的前缀匹配；WSL 实测 `/tmp/../etc`、`/var/tmp/../etc` 都被 ACCEPT。而 `REVIEW-FIX-STATUS.md:46` 却写"先拒绝含 `..`，再 `readlink -m` 归一化 … WSL 实测全拒"。
- **卫生（第五次同类）**：本轮**又提交了一个草稿脚本**到仓库根——`mutate-pkg.mjs`（`git ls-files` 可见），`.gitignore` 只补了 `/patch-*.mjs`、`/probe-*.mjs`，未覆盖 `/mutate-*`；`atomic.ts:209-217` 的重复 doc 注释与 `notebook-file.ts` 尾部空行仍在。
- **`imageDecodeProblem` 的空值分支不可达**：空串/纯空白都会被判"解码成功"→ 返回 0 字节图片块 + 0 字节 artifact + **无 warning**（V8-3 想区分的"空 vs 坏"在"空"这一格失效）。


---

## 四、七个审查维度逐条覆盖

**1. 架构与模块对齐** —— 1 项（V9-1 的"两条路径不一致"）
`stripDataUrlPrefix` 落在 `core/outputs.ts`（正确），但**内容块构建在 `mcp/render/` 与 `run.ts`**，后者从文档原值取 base64——这正是"同一个语义有两处实现"的老问题（v4 FID-1、v7 WARN-CODE-1、v8 V8-1 同型）。其余：模块边界未破、`core/*` 未 import `node:*`、可变状态仍在 registry/run-store。

**2. 代码质量与可维护性** —— 1 项（V9-1 的双实现）
正面：本轮注释质量高（`stripDataUrlPrefix` / `imageDecodeProblem` / `outputTruncatedWarning` 都把"为什么"写清了）；`prepareVenv` 真正下沉（15 处引用）；新增两个守卫脚本（`check-package.mjs`、`check-connection-sweep.py`）。
负面：图片 base64 的取值散在两处且判据不同。

**3. 健壮性与错误处理** —— 3 项（V9-1、V9-3、V9-4）
正面：json 读方向现在对**所有合法类型**成立（我实测 7 种）；补救提示与行为一致（V8-14）；清扫有 pid 判据与守卫脚本；D-046 登记了边界扩张。
负面：**图片块的畸形值会把整次调用打成协议错误**（V9-1），且这一点没有降级路径（V9-3）。

**4. 性能与资源效率** —— 未发现明显问题
分帧仍线性且有用例守着；`#normCache` 记忆化；清扫只在启动跑；`+183` 的 `outputs.ts` 改动是纯投影/解码逻辑，未引入新的同步 I/O 或拷贝（`structuredClone` 仍是 v7 那条未改的 🟡）。

**5. 安全性** —— 1 项（V9-4 的 `..` 绕过）
`install_command` 注入已关闭 ✓、连接文件不再落工作目录 ✓（本轮实测仓库根 0）、CI 强制权威 ✓、产物不再带 `.pyc` ✓、新增 `check-package.mjs` 守产物。遗留：`linux-check.sh` 的 `WORK` 守卫仍可被 `..` 绕过。

**6. 测试覆盖与自测质量** —— 2 项（V9-2、V9-4 的 venv 并行）
正面：单测 **287→381**（+94），新增 `check-package.mjs`/`check-connection-sweep.py` 两个守卫脚本；V8-10 的"一条 message 两个事实"有注释与实现对应。
负面：**新增的 data-URL 用例只测投影不测内容块** → 门禁全绿而 blocker 存活（第三次同型）；`vitest.config.ts` 仍缺 `fileParallelism`。

**7. 依赖与配置** —— 未发现明显问题
运行期依赖仍只有 SDK（零新增）；`prepack` = `tsc`；`files` 现在排除了 `__pycache__`（132 项）；CI 矩阵与 `IPYNB_REQUIRE_NBFORMAT` 保持；工作树干净。

---

## 五、总体评估

### 1. 整体质量评级：**C（需返工）**

**本轮把 v8 的绝大部分条目真修了**（V8-1/V8-2/V8-7/V8-9/V8-13/V8-15/V8-16 我都亲验或复核通过，其余为部分/未修，见 §2.2），其中 json 读方向现在对**全部合法类型**成立、补救提示与行为一致、产物不再带 `.pyc`、sidecar 边界扩张有 D-046 登记——这些都是实打实的进步。

**但同一批改动引入了一条更严重的 🔴**：为了修 V8-3（data-URL 图片"看得见但读不出"），只改了**解码/物化**那一层，没改**内容块**那一层 → 现在含 data-URL 图片的 notebook **连 `notebook_read` 都失败**（`-32602` 协议错误，`notebook_run` 同），而失败形态从"产品级降级"变成了"整个工具不可用"；更糟的是**那次失败的 run 仍把 data-URL 写回了文件**，此后该 notebook 永久读不回（主审实测）。此外本轮的"全部合法类型矩阵"漏了 **number 域**：超出 IEEE-754 安全范围的大整数 JSON 被**静默四舍五入**，run 路径还把四舍五入后的值写回盘（**V9-5，第二条 🔴**）。

**为什么仍是 C 而不是 D**：修法很小（两处块构建改用已解码的字节，或在取出时走同一个 `stripDataUrlPrefix`），且需要在 `result.ts` 加一道合法性过滤把未来的畸形值降级为警告；不需要架构返工。

**这一轮的教训（第三、四次同型，值得写进方法论）**：**"修了一半"这件事在连续四轮里以不同面貌出现**——字段名（v4）→ 值类型（v6）→ 读方向（v7）→ 解码层 vs 块层（v9）。每次的共同点都是"**新守卫只覆盖被改的那一层**"。所以除了 AGENTS §9 已有的两条（守卫必须能失败、拒绝必须自证身份），建议再加一条：**任何"数据形状"类修复，必须断言到"用户真正拿到的那一层"（内容块 / 文件字节 / 协议帧），而不只是内部投影对象。**

### 2. TOP 3 必须优先修复

| # | 事项 | 为什么 | 修复量 |
|---|---|---|---|
| 1 | **V9-1（🔴）**：`read.ts:126-128` 与 `run.ts:517-520` 改用**已解码的字节**（或走同一个 `stripDataUrlPrefix` + base64 合法性校验）；在 `result.ts` 组装前加"块合法性"过滤，不合法就降级为 `image_materialize_failed`；**并补 V9-2 的 smoke 两条断言**（子代理已证明当前 HEAD 红、最小修复后绿） | ① 含 data-URL 图片的 notebook（含空载荷、标签不符、字符串数组三种变体）现在**读写都失败**；② **失败的 run 还会把 data-URL 写回文件**，此后该 notebook 永久读不回；③ 失败是**协议级 `-32602`**，绕过 §7/§4.8 的错误码契约 | 小（两处 + 一道过滤 + 两条断言） |
| 2 | **V9-5（🔴）**：json 值保持**原文精度**（最简：`rawOutputsOfCell` 对该键保留原文文本，投影与写回都用它），或在超范围时给 warning | **静默改写用户数据**，且 run 路径造成**磁盘上的永久丢失**（`2**64` → `…52000`）；这正是本项目第一条卖点"不会静默改坏"要消灭的故障；本轮新写的"全部合法类型矩阵"恰好没覆盖 number 域 | 中（涉及投影与写回两处 + 边界用例） |
| 3 | **V9-6（🟠）**：把 `docs/DEVIATIONS.md` 恢复成单份（编号唯一、D-044 合并），并加一条"编号/表头唯一性"自检 | 这是本仓"每次偏离当场写"的**唯一登记册**，现在每条出现两次、D-044 被劈成两段——下一轮评审与实现者都无法判断哪份可信；lint 不查 markdown 所以门禁不会发现 | 小（重写文件 + 一条自检） |

紧随其后：**V9-7**（超时路径带回已收集的 warnings、message 保留 cell 身份、订正 D-042 状态列与过期注释）→ **V9-8**（hint 按规则生成 + 用例改成"按建议操作后文件必须转 VALID"）→ **V9-2**（内容块级断言）→ **V8-8**（`readlink -m` 归一化后再判，并撤回状态表那行的"已修"）→ **V8-12**（单测不删共享 venv / `fileParallelism: false`，并修正反向注释）→ **V8-4**（把两条假守卫换成真行为断言）→ **V8-6**（pid 解析加"后缀非全数字"判据；Windows 的 7 天退化要给替代判据；检查器入门禁）→ **V8-9 两点残留**（`lib/*` 行的不可失败、两个守卫互斥 → sweep 脚本设 `sys.dont_write_bytecode = True`）→ **V8-11 / V8-5**（问对解释器；删掉死导出与第六份复制）→ **`mutate-pkg.mjs`** 与 `.gitignore` → V8-17 的可证伪化。

### 3. 与原始设计文档的偏离清单

| 偏离 | 性质 | 状态 |
|---|---|---|
| json 读方向对全部合法类型原样保留 | 兑现 SPEC §5.4 第 7 行 / D-044 | ✅ 本轮真兑现（我实测 7 种） |
| 内容块的 `data` 取文档原值（未剥 data-URL 前缀）→ 协议错误 | **违反 SPEC §4.4/§4.8 与 §7 的错误码契约** | 🔴 V9-1 |
| **`application/json` 的大整数被四舍五入**（read 静默改写；run 写回盘） | **违反 SPEC §5.4 第 7 行与 §6 R2「不静默改坏」** | 🔴 V9-5 |
| `exec_timeout` 的 detail 又丢掉了已收集的 warnings | 与 D-042 登记的影响面不符（且是 v7 已修项的回归） | 🟠 V9-7 |
| `docs/DEVIATIONS.md` 自身被拼接损坏（每条出现两次） | 登记册是"偏离当场写"的权威载体 | 🟠 V9-6 |
| 图片块不合法时整次调用失败，而非降级为 warning | 与 §4.4 的"物化失败 → `image_materialize_failed`"不一致 | 🟡 V9-3 |
| sidecar 启动时清扫非自己创建的连接文件 | 已登记 **D-046**（前缀 + 临时目录 + pid 判活） | ✅ 留档 |
| `linux-check.sh` 的 `WORK` 守卫未归一化 | 与 V7-13 的修复意图不符 | 🟡 V9-4 |
| `exec_timeout` 的 detail 带 warnings、`output_truncated` 一条承载两个事实 | 已登记/已实现 | ✅ |

### 4. 后续开发建议

- **把"断言到用户拿到的那一层"写进 AGENTS §9**（与"守卫必须能失败""拒绝必须自证身份"并列）。这一轮 blocker 的根因不是能力问题，而是**测试层次选错**：断言停在 `OutputItem`，而用户拿到的是 `content[]`。
- **给图片渲染加一道"块合法性"闸门**（V9-3）：任何未来出现的畸形图片值都应降级为产品级警告，而不是把整次调用打成协议错误——这是"协议错误 vs 产品错误"的边界，值得在 SPEC v3.1 里写明。
- **发布前仍缺**（第八轮起未变）：① **E1–E9 真实第三方客户端**（0/9）；② **`pnpm smoke` 纳入 CI**（19/19 目前只是本机）。**注意 V9-1 恰好说明第三方客户端测试的必要性**：这种"服务端自认为正常、客户端收到协议错误"的故障，只有真客户端路径能可靠暴露。
- **文档收尾**（低优先）：V8-16 那两行的逐字复核（子代理结论）、`SCOPE-DEFAULT` 的缺省仍为"整份文档"。

---

## 附录：验证分工与局限

- **主审亲验（一手证据）**：六道门禁实跑（typecheck/lint/**381**/integration **46/46**/smoke 19/19/build/pack **132 无 .pyc**）；**json 全类型探针**（4 种 `+json` + 对象 + `"123"` + `"hello"` 全部原样）；**补救操作四步会话**（`clear_outputs` 现已成功）；**裸 JSON-RPC 8 形状定位**（绕开 SDK 客户端校验，确认 `-32602` 是服务端行为，缩小到 data-URL 图片一格）；`notebook_run` 的 data-URL 复现；`npm pack` 清单核对；`usableInterpreter`/`prepareVenv` 调用点计数（15）；D-046 与代码一致性；README:101；`linux-check.sh` 守卫逐行；`vitest.config.ts`/`run.test.ts:910` 的未修项。
- **子代理复核（一路，**已完整并入**）**：围绕 V9-1 的**邻域排查**（read 17 例 + run 16 例矩阵 → 失败集合 = `data:<any>;base64,<可解码载荷>`，含空载荷/标签不符/字符串数组三种变体）、"为什么 CI/smoke 没拦住"（smoke 从不产生图片输出且 `call()` 只收 text 块；`outputs.test.ts:616` 只测投影；全仓无用例校验块的 `data`）、v8 其余条目的**变异核实**（删 `run.ts:613-616`/`:594` 仍全绿；`JSON_MIME`/`jsonValueOf` 变异能红）、**大整数精度**（run 侧写回四舍五入值）、`DEVIATIONS.md` 拼接损坏、`check-package.mjs` 与 `check-connection-sweep.py` 的可失败性、独立黑箱会话（read→edit→run→后台 run→status→shutdown，无孤儿 kernel、无连接文件新增、`nbformat.validate` 通过）。
- **主审独立复现的关键项**：**V9-1**（裸 JSON-RPC 8 形状定位：只有 data-URL 图片失败；`notebook_run` 同样失败）、**V9-1 放大器**（失败的 run 把 data-URL 写回盘 → 再读该文件仍 `-32602`）、**V9-5**（盘上 `18446744073709551616` → 服务 `…52000`，`warnings: []`）、**V9-6**（104 行、`D-001` 出现 2 次）、V8-1/V8-2（json 全类型 7 例原样）、V8-14（`clear_outputs` 现已成功）、V8-9（pack 132 项无 `.pyc`）、V8-5（`prepareVenv` 15 处引用）、D-046、README:101、`linux-check.sh` 守卫逐行、`vitest.config.ts`/`run.test.ts:910` 的未修项、`mutate-pkg.mjs` 已被跟踪。
- **局限**：① 未做 macOS/arm64 与真实第三方客户端（E1–E9 仍 0/9）；② V9-1 我实测的是 `notebook_read`/`notebook_run` 两条路径与 8 种形状，其它工具（`notebook_run_status` 等）是否也会带图片块未逐一验证；③ 我未在干净机器上 `npm i` 后实跑（只核了 pack 清单）。
