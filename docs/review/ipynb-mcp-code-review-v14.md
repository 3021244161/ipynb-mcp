# ipynb-mcp 代码审查报告（第十四轮 / v14，上线前健壮性）

> **审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp` @ HEAD `1b7681d`（v13 之后 **5 个提交**，共 108 提交；工作树**干净**）
> **上轮基线**：`a1d6831`（v13 报告：`docs/review/ipynb-mcp-code-review-v13.md`，3 🔴 / 4 🟡 / 1 🟢）
> **方法**：主审亲跑全部门禁 + **复用 v13 的三组探针**（8 案例帧悬崖 / 转义密集计时矩阵 / 后台 `os._exit(7)` 分类）+ 新增 1 组（截断交付形状与盘上保真）；两路独立复核并行（仍在运行，落地后并入）
> **日期**：2026-10-05

---

## 一、门禁与发布件实测（主审亲跑，无并行负载）

| 门禁 | 实测 | 变化 |
|---|---|---|
| `pnpm typecheck` | exit **0** | ✅ |
| `pnpm lint` | **1 warning / 0 errors**（`unicorn/no-useless-length-check` 命中本轮新增的非真空断言 `v12-timeout-status.test.ts:77`；oxlint 对 warning 仍退出 0）+ `format ok` + `indent ok (28 samples)` + `documentation self-test: ok (**17** mutations, 0 skipped, control clean)` + `documentation check: ok`；**命令已变为 `oxlint src tests scripts`**（94 文件） | ✅ v13 V13-2 关闭（作用域已含 `scripts`）；⚠️ **"0 警"一词不再成立**（本报告初稿误写为 0 警，据复核证据更正） |
| `pnpm test` | **600 passed / 31 文件** | ↑ 597/30 → +`json-reader-scaling.test.ts` |
| `pnpm test:integration` | **78 passed / 13 文件**，353 s，`VITEST_EXIT=0` | ↑ 74/12 → +`v13-response-budget.test.ts`、`[V13-8]` 用例 |
| `pnpm smoke` | **26/26** | ✅ |
| `pnpm check:package` | **ok（144 文件，22 变异）** | ↑ 140→144 |
| `docs/DEVIATIONS.md` | **65 条编号全唯一**、最大 D-065、digest 校验通过 | ↑ 62→65（新增 D-063/064/065） |

---

## 二、v13 的三条 🔴 闭环核查（逐条一手实测）

### 2.1 🔴 V13-7（O(n²) 读取）→ ✅ **真修，性能恢复线性且比"旧版"快约 12×**

`2ccb6ef` 把 `readString` 从"两次 `indexOf` 各扫到文本结尾"改成**单次前向 token 扫描**（`STRING_TOKEN = /[^"\\]+|["\\]/g` + `matchAll`）。我用**同一份** v13 探针（转义密集 source，每 20 字符一个 `\n`）复测：

| 样本 | v13（两遍 indexOf） | v14（单遍） | 倍数 |
|---|---|---|---|
| 0.5 MiB | 413 ms | **33 ms** | 12.5× |
| 1.0 MiB | 1611 ms | **68 ms** | 23.7× |
| 2.0 MiB | 6362 ms | **136 ms** | 46.8× |

**增长形状**：0.5→1→2 MiB 耗时 33→68→136 ms，**严格线性**（翻倍即翻倍）✓；v13 是翻倍即四倍。子代理另测 6.3 MiB 合法 notebook 从 **56.5 s** 回落（CHANGELOG 记 1 MiB/17 ms、2 MiB/34 ms，与我的量级一致）。D-063 登记齐全 ✓；新增 `tests/unit/json-reader-scaling.test.ts`（117 行）作为守卫 ✓。

### 2.2 🔴 V13-1（响应超 10 MiB 打死客户端）→ ✅ **真修，8 个案例全部存活**

`e519a0e` 新增 `src/core/response-budget.ts`（默认 **8 MiB**，刻意低于 10 MiB 悬崖；`--max-response-bytes` / `IPYNB_MAX_RESPONSE_BYTES` 可调）。我用**真 SDK 客户端**复跑 v13 的 8 个案例：

| 案例（v13 全部 `-32000 Connection closed`） | v14 实测 |
|---|---|
| `text/plain` 9.0 / 9.5 / 9.9 / 10.2 / 11 MiB | ✓ 响应封顶 **8.00 MiB**，各 1 条 `output_truncated` |
| `text/html` 11 MiB | ✓ 8.00 MiB + 1 条警告 |
| `application/json` 11 MiB | ✓ 0.00 MiB（整项丢弃）+ 1 条可操作警告（"ask for fewer cells"） |
| `image/png`（base64 11 MiB） | ✓ **0 个 image 块**（走 SPEC §4.3 降级，不返回块） |
| 60 × 300 KiB（累计 17.6 MiB） | ✓ 8.0 MiB + 警告 |
| `stream` 11 MiB（对照） | ✓ 0.02 MiB（`inline_text_chars` 截断 + 警告） |

**交付语义与盘上保真**（新增探针，逐项核实）：
- 被截断的 `text` 项**在带内打了标记**：`text` 结尾是 `…[truncated to fit the response budget]`（我实测 8 387 535 字符的文本以此为尾）✓，并有调用级 `output_truncated` 警告 ✓ —— **模型能识别**，README 的"shortened and **marked**"准确 ✓。
- **盘上原文一字未改**：11 MiB 的 notebook 读完后文件仍是 11.0 MiB、内容完好 ✓（截断只发生在**响应**里）。
- D-065 登记齐全（含"图片装不下就不返回块"）✓；README 有一整条已知限制说明"单帧 10 MiB 会断连、服务端默认 8 MiB 预算"✓。

### 2.3 🔴 V13-8（崩溃被报成"客户端取消"）→ ✅ **真修**

`f991120` 改为记录**实际先触发的那个原因**（`firstAbort.reason ??= …`，内核死亡与客户端取消各注册监听），`RunRequest.abort.reason` 变 getter。我用**同一份** v13 探针复测：

```
后台 run + cell 内 os._exit(7) →
  v13: state=cancelled  error.code=cancelled  "run aborted (cancelled)"
  v14: state=failed     error.code=kernel_died "run aborted (kernel_died)"     ✓
```
集成套件里新增了 `[V13-8] a kernel that dies on its own is failed/kernel_died, not cancelled`（我这次 78/13 的运行里通过 ✓），`docs/DEVIATIONS.md` 的 D-064 登记齐全 ✓。

### 2.4 四条 🟡 的闭环

| v13 项 | 状态 | 证据 |
|---|---|---|
| **V13-2** 门禁作用域（`scripts/` 在 oxlint 之外） | ⚠️ **一半** | `lint` 已扩为 `oxlint src tests scripts` 且是**真清理**（`.oxlintrc.json` 无 ignore/overrides；`npx oxlint scripts` = 0 warnings / 0 errors，13 文件）；**但 `check-indent` 未扩到 `.mjs`**（`check-indent.mjs:575` 仍是 `/\.(ts|mts)$/`），`scripts/` 15 个文件仍只受 check-format 约束，也没登记豁免理由 |
| **V13-4** `check:release` 不在 CI | ✅ **真修**（本报告初稿误写为"未见改动"，据复核证据更正） | `package.json:30` 的 `prepublishOnly` 已追加 `&& npm run build && npm run check:release`；`.github/workflows/ci.yml:115-126` 在 integration job 末步加了 `if: matrix.os == 'ubuntu-latest' && matrix.python == '3.12'` → `pnpm check:release`（我亲验两处都在） |
| **V13-6** 超时文案 / 死守卫 | ⚠️ **部分：文案与两条守卫 ✅，第三条 ❌** | ① 文案已改为 `cell execution timed out after ${n}s`（无平台断言，`src/run.ts:671`）✓；② `kernel.test.ts` 拆成"显式 interrupt 落地 → `error`+`KeyboardInterrupt`（真跑 8.17 s 可达）"与"超时 → `timeout` 且关内核"✓，`v9-regressions.test.ts:295` 也收紧为只接受 `exec_timeout`（不再容忍 `internal`）✓；③ **`SIG_IGN` 确定性用例未补** → 复核方变异 `M5`（sidecar `timed_out = False`）在 Windows **仍然全绿**：这条守卫**在本机仍不可失败** |
| **V13-5** 文档数字 | ✅ 完成（一处越界） | `COMPATIBILITY.md:27` 已更新、`REVIEW-FIX-STATUS.md:45` 补了第十三轮段落、`measure-real-notebook.mjs` 头注释已改、D-060 内容已订正；**但 `:73` 把第十二轮的"不随轮次改动"快照覆盖成了本轮数字**（见 V14-8） |
| **V13-3** trial 脚本护栏 | ⚠️ **部分** | ✅ 头部横幅、`FORBIDDEN_ROOTS` 解析 + 大小写折叠拒绝（`trial-changejob.mjs:53-61`）、`--python` 默认改为可移植值、`console.*` 全清；❌ `measure-*.mjs` 的 `sampleErrors` **只 push 不打印、不导致非零退出**（失败仍显示 `ratio=0.0` 为成功），且 `trial-scenarios.mjs:5` 的注释声称"`--root` 必须与它一致"——**该护栏不存在**（见 V14-6） |

---

## 三、本轮发现

【V14-1】
严重程度：🟡 警告
所在位置：`docs/DEVIATIONS.md` 的 **D-065**（措辞）· `SPEC.md:675`（`text` 项的字段表）· `src/core/response-budget.ts`
问题描述：D-065 写"超限时先按最大的文本字段优先截断（**置 `truncated` 语义** + `…[truncated to fit the response budget]`）"，但**实现只在文本里加了带内后缀 + 调用级警告**，item 上**没有** `truncated` 字段——因为 SPEC:675 的 `text` 项 schema 是 `{media_type, text}`，**根本没有这个字段**。
详细分析（**主审实测**，`notebook_read(include_outputs='full')` 一个 11 MiB 的 `text/plain`）：
```
item 的键 = kind, media_type, text          ← 无 truncated / truncated_at_chars
text 长度 = 8 387 535，结尾 = "…[truncated to fit the response budget]"
调用级 warnings = [{code: output_truncated, message: "1 text value(s) were truncated because the response exceeded the 8 MiB response budget"}]
```
也就是说：**行为是对的、标记也在**（模型能从带内后缀与警告看出被截断），但**登记册的措辞描述了一个并不存在的字段**。而 SPEC §5.4 立的原则是"任何截断都必须**置标志位**"、§7 把 `output_truncated` 定义为"某项 `truncated === true`"——在这条路径上，**触发警告的不是标志位而是字节预算**，等于该错误码多了一种与 §7 定义不同的含义（与 v10 的 `output_truncated` "第三义"同族，见 D-052）。
修复建议：① 把 D-065 的措辞改成事实——"**在文本内追加 `…[truncated to fit the response budget]` 标记 + 汇总为 `output_truncated` 警告**（`text`/`json` 项在 SPEC §4.3 的 schema 里没有 `truncated` 字段，结构化标志需要改 SPEC，属 D22 兼容承诺范围，需人类批准）"；② 若希望模型可**结构化**判定，最省的做法是在 `notebook_read` 的**调用级** `warnings` 里带上"哪些 `cell_index`/output 被截断"（不改 item schema、不动 §7 的码表）。
设计文档对齐：SPEC §4.3（item 字段表）、§5.4（禁止静默截断）、§7（`output_truncated` 的定义）、AGENTS §0/§11（偏离登记与"改 schema 需人类批准"）。

【V14-2】
严重程度：🟡 警告
所在位置：`src/core/response-budget.ts:97`（`enforceResponseBudget`）· 丢弃路径的警告文案
问题描述：丢弃整项输出时的警告是 **"…ask for fewer cells"**，但**当体积来自单个 cell 的单个输出时，这条建议不可执行**——模型无法通过"少要几个 cell"来绕开它（那个大输出就在它要的那一个 cell 里）。
详细分析（**主审实测**）：`application/json` 11 MiB 的单 cell notebook → 响应 0.00 MiB、`items` 为空、警告为 `1 output item(s) were dropped because the response exceeded the 8 MiB response budget; ask for fewer cells`。模型拿到的"下一步建议"在**最常见的单 cell 情形**下无效；它能做的其实是"用 `include_outputs='summary'` 看预览"或"知道原文仍在文件里，用 `notebook_edit`/外部工具处理"。对比：截断路径的警告只陈述事实（没有给不可执行的建议），两条路径的措辞质量不一致。
修复建议：把建议改成对两种情形都成立的说法，例如"…dropped (the notebook keeps the full value on disk); use `include_outputs='summary'` for a preview, or `cell_indexes` to read the notebook in parts"。
设计文档对齐：SPEC §5.4（截断必须可解释）；本项目"给模型的文案必须可执行"的既往结论（v4 FID-5、v11 V11-4）。

【V14-3】
严重程度：🟢 建议（知情项）
所在位置：`README.md:81`（预算已知限制）· `src/core/response-budget.ts`（默认 8 MiB）
问题描述：预算默认 8 MiB 是**刻意**低于 10 MiB 悬崖（留 20% 余量，README 已写明、`--max-response-bytes` 可调），但它的副作用是：**8–10 MiB 之间、客户端本来能完整收下的响应，现在也会被截断**（我实测 9.0 / 9.5 / 9.9 MiB 的 `text/plain` 都变成 8.00 MiB + 警告）。这是可接受的工程取舍，但属"用户可感知的行为变化"。
详细分析：v13 之前这些响应是**完整交付**的；现在会带警告地被截断。对"想要完整大输出"的用户，唯一出路是调大 `--max-response-bytes`（但那会逼近断连悬崖）或按 cell 分批读。README 目前写了 8 MiB 这个数，但没写"因此 8–10 MiB 的内容会被截断"这一后果。
修复建议：README 那条已知限制补一句——"Responses between the budget and the client's 10 MiB limit are truncated rather than sent whole; raise `--max-response-bytes` only if your client's buffer is larger."；并考虑在 `COMPATIBILITY.md` 记录"实测过的客户端上限"（Claude Code / dsh 各一行）。
设计文档对齐：SPEC §5.5.7（对外承诺的措辞）、README 已知限制。

【V14-4】
严重程度：🟡 警告（**临时产物第七次入库，且所有门禁都看不见**）
所在位置：仓库根 `tmp-result-backup.ts`（169 行，7843 B；`git log --diff-filter=A` 确认由本轮的 **`e519a0e`** 随 `git add -A` 误入库）
问题描述：它是 `src/mcp/tools/result.ts` 的**过期副本**（`'../../core/errors.js'` 在根目录不成立），而 `tsconfig.test.json` 只 include `src`+`tests`、vitest 只收 `tests/unit`、`oxlint` 只扫 `src tests scripts` → **类型检查、lint、测试三套门禁全部看不见它**（我亲验它已跟踪、且 `git ls-files` 里还有它）。
详细分析：它不会被编译进 `lib/`（`files` 只发 `lib`+`python/*.py`），所以**不进 npm 包**；但会随源码分发，读者会把它当成现行实现——这正是"同一类事故的第 7 次"（`.gitignore` 已为 `patch-*`/`probe-*`/`mutate-*`/根目录 `*.txt` 写过 6 段，现有 `tmp*.json` 只挡 json）。
修复建议：`git rm --cached tmp-result-backup.ts` 并删文件；`.gitignore` 补 `/tmp-*`（覆盖 `.ts`）；更根本的一条——**给"仓库根目录只允许白名单文件"加一条机械门禁**（例如 `check-package.mjs` 或新脚本断言根目录文件集），否则第 8 次还会来。
设计文档对齐：AGENTS §4（仓库结构）；本项目"护栏要能失败、且要在正确的路径上"的既往结论（v12 V12-4、v13 V13-2）。

【V14-5】
严重程度：🟡 警告（**新加的超时守卫在本机不可失败**——v13 V13-6 只修了一半）
所在位置：`tests/integration/v12-timeout-status.test.ts`（第 76-79 行只加了"非真空"断言）· `python/ipynb_sidecar.py` 的 `timed_out` 判定
问题描述：复核方变异 **`M5`（把 sidecar 的 `timed_out = False`，即撤销 v12 的超时判定）→ 该文件在 Windows 上仍然全绿**。原因与 v13 相同：Windows 走 **grace 早退分支**（`status="timeout"; break`），末段 `if timed_out:` 的判定**不可达**。我在 v13 报告里点名要补的 `SIG_IGN` 确定性用例**没有落地**。
详细分析：这条修复本身是真的（他们用 `signal.signal(SIGINT, SIG_IGN)` + `sleep` 构造了平台无关的"落地分支"，出货 PASS / 撤销修复 FAIL），但**仓库里的守卫仍是死守卫**——也就是说"下一轮谁把这段逻辑改坏，CI 不会红"。这与本项目反复付代价的族（守卫不能失败）完全同族，而且**这是本轮唯一"声称修好但按我自己的尺子仍不可变异"的项**。
修复建议：把 `SIG_IGN` 构造加进 `v12-timeout-status.test.ts`（只断言 `status === 'timeout'`，两平台都确定），并保留现有 Windows 分支的非真空断言。
设计文档对齐：AGENTS §9（守卫必须能失败）、SPEC §4.7 规则 5/6。

【V14-6】
严重程度：🟡 警告（两处"守卫/护栏是摆设"）
所在位置：`scripts/measure-real-notebook.mjs:21/41/46`（`sampleErrors` 只 push 不消费）· `scripts/trial-scenarios.mjs:5-7`（注释声称的护栏不存在）· `scripts/check-indent.mjs:575/582`
问题描述：三处小而同类的问题：① `measure-*.mjs` 把 PowerShell 采样失败收进 `sampleErrors` 后**既不打印也不导致非零退出** → 探针失败时报告照旧打 `ratio=0.0` 并显示为"成功测量"（v13 V13-3② 未兑现）；② `trial-scenarios.mjs` 的新注释写"the harness refuses to run unless `--root` matches it"，但 `trial-changejob.mjs` 的守卫**只针对 `E:\ChangeJob`**，并不校验 `--root` 与 TRIAL_DIR 一致——**注释描述的护栏不存在**；③ `check-indent` 的收集器仍是 `/\.(ts|mts)$/`，`scripts/` 15 个文件仍只受 `check-format`（tab/尾随空白）约束。
详细分析：① 是"测量工具在失败时报告看似正常的数字"，比不测更危险（会让人相信一个假的 0.0）；② 是"文档描述的护栏不存在"——本项目已多次登记这一类（v11 V11-4、v12 V12-2）；③ 是 v13 V13-2 的第 2 条，既未做也未登记豁免理由。
修复建议：① `sampleErrors` 非空时打印并 `process.exitCode = 1`；② 要么实现注释里那条例（校验 `--root` 与 `TRIAL_DIR` 的关系），要么把注释改成事实；③ 把 `check-indent` 的收集器扩到 `.mjs`（或明确写下"`scripts/` 只受 check-format 约束"的理由）。
设计文档对齐：AGENTS §5（注释只写事实）、§9（守卫必须能失败）。

【V14-7】
严重程度：🟡 警告（**D-064 的验证列不完整，效果③零覆盖**）
所在位置：`docs/DEVIATIONS.md` 的 D-064 验证列 · `tests/integration/server.test.ts:368` · `src/mcp/tools/run.ts:277` 与 `src/mcp/tools/run-status.ts`（`handleRunCancel` 自己 `settle('cancelled')`）
问题描述：复核方实测：**`M3`（只撤调用方的 `?? 'cancelled'` 默认值）→ 6/6 绿；`M4`（只把 getter 改回冻结属性）→ 也 6/6 绿；只有 `M3+M4` 同时撤才红**。即这条用例只能抓"两半都撤"，无法分辨哪一半在起作用。D-064 的验证列只记了 M3 那一半。
详细分析：原因是 **client cancel 的终态由 `handleRunCancel` 自己 `settle('cancelled')` 写定**，所以 getter 的差异观察不到——D-064 效果③"**写回期间才到达的取消不会把内核死亡改写成取消**"这条**零覆盖**（而那正是 getter 存在的理由）。
修复建议：补一条能分辨的用例——后台 run 中先让内核死亡、**在 write_back 期间再发 `notebook_run_cancel`**，断言终态仍是 `failed`/`kernel_died`；并在 D-064 的验证列补上"M4 单独撤销也绿、M3+M4 才红"这一事实。
设计文档对齐：AGENTS §9；SPEC §4.8 规则 1。

【V14-8】
严重程度：🟡 警告（登记/状态文档的按轮可核对性被破坏）
所在位置：`docs/REVIEW-FIX-STATUS.md:73`（第十二轮段落的门禁快照被改写成 600/31 与 77/13）
问题描述：该文档自己的规则是"**上面这段门禁数字是第六轮当时的快照，不随轮次改动**"、每轮段落记录**当轮**实测；把 v12 段落的 596·30 / 73·11 覆盖成本轮数字后，**v12 段无法再反映 v12 当时的状态**。
详细分析：与 v13 V13-5 同族（数字纪律），但方向相反——不是滞后而是**追溯覆盖**。数字的按轮留痕是本项目唯一能"事后核对每轮说法"的机制，覆盖它等于把审计线索擦掉。
修复建议：`:73` 改回 596·30 / 73·11；本轮数字写在第十三/十四轮段落里。
设计文档对齐：`REVIEW-FIX-STATUS.md` 头部自定规则。

【V14-9】
严重程度：🟢 建议（新计时用例的阈值压在噪声带上）
所在位置：`tests/unit/json-reader-scaling.test.ts:63`（ratio 阈值 3）
问题描述：复核方用同夹具量 25 轮：1 MiB 11.3–20.7 ms（中位 14.4）、2 MiB 29.6–40.0（中位 34.9），**ratio 中位 2.15、最大 3.22**；阈值 3 → **25 轮里 5 次越界**；而二次特征（旧实现）的实测 ratio 是 **3.91**。即"线性 2.15"与"二次 3.91"之间只剩 40% 余量，阈值落在噪声里——这是本机 CI 最可能的**假红**来源（绝对上界 3000 ms 那一半余量 85×，0 次越界）。
修复建议：阈值抬到 4（仍能抓住 3.9–4.0 的二次特征），或改成"取 3 次最小值再比"，把主判别力放在绝对上界与分配探针上。
设计文档对齐：AGENTS §9（守卫要能失败，也要**不因无关原因**失败——v10 V10-8 的同一族）。

### 复核补充：**本轮新写的响应预算自己引入了 3 条 🔴**（第二路复核发现，我逐条一手复现）

> 这一组推翻了我初稿的结论。三条都是 `src/core/response-budget.ts`（`e519a0e` 新写的模块）自己的问题，其中第一条**比它要修的缺陷更严重**。

【V14-11】（= 复核方 F1）
严重程度：🔴 阻塞（**截断循环不收敛 → 整个 MCP server 永久挂死**）
所在位置：`src/core/response-budget.ts:118-134`（截断循环，关键在 `keep = Math.max(200, length - overshoot - 512)` 与随后的 `slice(0, keep) + "…[truncated to fit the response budget]"`）· `:190-215`（`findLargestTextField`）
问题描述：当"最大的可截断文本字段"长度 `L < 237` 时，`keep` 退化为 `200 ≥ L`，于是改写后的串 = **原值 + 37 字符标记**——每轮把该串**加长**，`size` 只增不减，`for (;;)` 永不退出。它是**同步**循环，事件循环被完全占住：该调用不返回，**之后任何调用也不返回**。
详细分析（**主审实测**）：一个 8 MiB 源码的 cell + 一个小输出，`notebook_read(include_source='full', include_outputs='full')`（真 SDK 客户端，30 s 超时）：
```
✗ read full   （8 MiB source + 小输出）: 30011 ms  McpError -32001: Request timed out   ← 挂死
✓ read preview（同一文件）:                76 ms  正常返回 + 1 条警告                  ← 对照
```
触发面很宽，且**正是本轮的旗舰场景**：载荷主体落在预算**看不见**的字段上（`cells[].source` 不在 `TEXT_FIELDS=['text','value','html']` 里、`source_preview` 是字符串数组而丢弃阶段只挑"对象数组"）时必然满足——"源码撑大载荷、输出很小"的 notebook（v13 那个 37.5 MiB 试用本就是这个形状）读一次就挂死；`--max-response-bytes 65536`（config 允许的最小值）或图片把文本预算压到 64 KiB 地板时同样触发。复核方另有三个独立构造（200×45 KiB 源码的 `full`/`preview` 都 30 s 无响应、纯函数直驱 15 s 被 kill）。
修复建议：① 循环加"**本轮必须取得净进展**"判定——`keep >= length` 时**不要**改写该字段，直接进入丢弃阶段；② 两个 `for(;;)` 都加迭代上界并把超限转成显式错误；③ 把 `source`/`source_preview` 纳入可截断字段（或"不可截断就丢 cell 并逐项标位"）；④ 用例：**9 MiB 源码 + 一个小输出的 read 必须在有界时间内返回**（现有预算用例的夹具全是"主体就在一个大 text 字段里"，恰好绕开本形态）。
设计文档对齐：SPEC §0 工程硬约束 1（≤60 s 可用）、§6 R2；与 v12 V12-3/V12-5 同族（守卫的作用域 ≠ 责任的作用域）。

【V14-12】（= 复核方 F2）
严重程度：🔴 阻塞（**预算只挂在成功分支，错误响应完全绕过 → 超时/取消/内核死亡时仍然断连**）
所在位置：`src/mcp/tools/result.ts:57-61`（错误分支裸 `JSON.stringify({code, message, detail})`，**不经过** `enforceResponseBudget`）· `src/run.ts:671-685`/`:1042-1049`（`detail.executed` 含每个已完成 cell 的 outputs）
问题描述：`detail.executed` 是 `ExecutedCell[]`，含 outputs；而 `inline_text_chars` 只削 `stream`（SPEC §5.4 表第 1 行），所以 `text/plain`/`html`/`json` 大输出**原样**进入错误响应 → 错误响应没有上界 → 帧超 10 MiB → 客户端断连。
详细分析（**主审实测**，正确构造：cell0 `display({'text/plain': 'A'*12MiB}, raw=True)` 执行成功，cell1 `sleep(60)`，`timeout_seconds=3`，`cell_selector='all'`）：
```
✗ run → 14350 ms  McpError -32000: Connection closed        （复核方另测到裸帧 12,583,629 B）
```
**后果正是 D-065 想消灭的形态、而且更糟**：文件已成功写回，模型既不知道超时、也不知道哪些 cell 跑完了，之后整条会话 `Not connected`。cancel（`abortedRunError`）与 `kernel_died` 走同一个 detail 结构，同样无上界。
（附：我自己第一次构造错了——只跑那个 sleep 的 cell，于是 `detail.executed` 里没有大输出、响应正常 0.00 MiB。**这条纠正记在这里**：验证 F2 必须让产出大输出的 cell **真的执行**。）
修复建议：把 `enforceResponseBudget` 应用到错误体（对 `detail` 递归，`detail.executed` 是最大的面），或在 `runTool` 的失败出口统一施加；用例：**大输出 + 超时**（现在这条路径零覆盖）。
设计文档对齐：D-065 声称"预算在唯一出口统一传入"——实际只在成功出口；SPEC §4.7 规则 5、§4.8 规则 3/5（失败终态必须报告已完成 cell 与 `write_back`，现在在传输层丢掉了）。

【V14-13】（= 复核方 F3）
严重程度：🔴 阻塞（**字节估算方向说反，低估 2–6 倍 → 帧仍超 10 MiB**）
所在位置：`src/core/response-budget.ts:56-85`（`estimatedJsonBytes` 的字符串分支 `return value.length + 2`，按 **UTF-16 单元**计且**忽略 JSON 转义**）· `:47-55`（注释声称"非 ASCII 在这里比线上更贵、是刻意保守"——**方向相反**）
问题描述：`JSON.stringify` 会把 `"`→`\"`、`\`→`\\`、控制字符→`\u00XX`，而载荷作为字符串嵌进 JSON-RPC 帧时**再转义一次**（反斜杠/引号在线上一字符占 4 字节；CJK 3 字节/单元；控制字符 6 字节/单元）。估算按 UTF-16 长度，于是非 ASCII 与转义富集的内容被严重低估。
详细分析（**主审实测** + 复核方 8 例矩阵）：
```
✗ 3 MiB 反斜杠   → McpError -32000: Connection closed     ← 我实测；帧约 12 MiB
✓ 3 MiB ASCII    → 响应 3.00 MiB，正常                     ← 对照（同尺寸 ASCII 没问题）
复核方另测：3 MiB 引号/1.25 MiB \" / 2 MiB U+0001 / 4 MiB 中文 / 3 MiB emoji / 5 MiB latin-1
            帧 10.5–14 MiB，全部 degraded:false、warnings:[]，SDK 客户端断连
```
触发面：**中文 notebook、打印 JSON/正则/Windows 路径**的用户几乎必然命中；而现有夹具只有 `'x'.repeat(...)`（`tests/integration/v13-response-budget.test.ts:31,68`），对坏代码也全绿。
修复建议：按 `Buffer.byteLength(JSON.stringify(payload), 'utf8')` 估算（或每串按"UTF-8 字节 × 2（帧内二次转义上界）"并留余量），把注释改成事实；补中文/反斜杠/控制字符三种夹具。
设计文档对齐：D-065 的承诺①"消费者拿得到响应、会话不断"对这三类内容不成立。

**同一模块的其余发现（🟡，编号沿用复核方）**
- **F4 🟡｜丢弃阶段会删掉整个 cell**：`findDroppableArray` 按"最长的对象数组"选目标，cell 多时 `cells` 最长 → 直接 `pop()` 掉 cell。实测 11 MiB `application/json` 的 read 返回 **`cells: []` 而 `cell_count: 1`**，警告却说 "1 output item(s) were dropped"。应只在 `outputs`/`executed[].outputs` 上丢弃并逐 cell 标位。
- **F5 🟡｜同一次调用出现两条 `output_truncated`**（SPEC §7 明确"整个调用只追加一次"，U21b 就是断言恰好一次），且 `truncated_at_chars: 9000000` 与实际交付长度 8 387 383 不符——字段在说谎。
- **F6 🟡｜被预算挡下的图片**已经**物化**（`artifact_path` 非空且文件已落盘），违反 SPEC §4.4「不返回图片块就不写 artifact」与 AGENTS §6 红线 3；且用 `image_materialize_failed`（§7 定义=写入或解码失败）报告"预算装不下"，语义不符。对照：`--max-images-per-call` 超限那条路径**不物化**。
- **F7 🟡｜`structuredClone(payload)` 是整载荷深拷贝**（21 MB 载荷 heap +39.9 MiB），与注释"only the containers this function actually rewrites are cloned"不符；且 `json-exact.ts:69-85` 自己的不变量说"克隆会作废 `ExactNumber` 标记"，新代码把它放进了**所有工具共用的出口**（今天载荷已被投影成普通数字，故无客户端可见后果，但不变量破了口）。
- **F8 🟡｜文案里的 MiB 用 floor**：`--max-response-bytes 65536` 时输出"exceeded the **0 MiB** response budget"（模型可见的假数字，V11-12① 家族）。
- **F9 🟡｜本轮"补的非真空断言"本身是真空的**：`v12-timeout-status.test.ts:76-79` 的 `outputs.length === 0 || outputs.every(...)` 在空数组上恒真 → Windows 分支等于没断言，与注释和 CHANGELOG 的声明相反；`oxlint` 恰好点名这一条（1 warning）。这与 V14-5 是**同一条守卫的两个问题**。
- **F10–F12 🟢**：`tmp-result-backup.ts`（= 我的 V14-4，复核方补充"与 `src/mcp/tools/result.ts` **字节完全相同**"）· `src/config.ts:363` 缩进（= V14-10①）· `prepublishOnly` 现在隐式依赖 ipykernel + registry（`check:release` 内部 `npm install <tarball>`，无 Python 或离线机器上 `npm publish` 会直接失败；README/CHANGELOG 未提这个前提）。

**复核方确认无问题的面（我采信并记录）**：停止原因分类 **8/8 与 SPEC §4.8/§7 一致**（含 sidecar 被杀、外部 taskkill 内核——他们用 cmdline 精确 PID，未误杀并发会话）；单遍 JSON 读取 **446 例三方对拍 0 分歧**、线性缩放、我们写出的字节被两个权威解析 0 失败；预算**按调用重置**、并发不串味；盘上原文 12/12 sha256+mtime 未变；`--max-images-per-call` 交互正确（超限不物化）；`src/core/*` 无 I/O/时钟/随机、`src/mcp/*` 无 `node:fs`、无新增依赖、`lib/` 同步、8 条门禁在 CI 一一对应；黑箱会话（read/edit CAS 三态/rich run/后台 run→cancel/kernel shutdown）与 `nbformat.validate` 全 VALID、无残留进程。

**V14-6 的 minor 部分与 V14-9 已被上述 F9/F10 覆盖；V14-5 与 F9 合并为同一条守卫的两个问题**。
【V14-10】
严重程度：🟢 建议（小账两条）
① `src/config.ts:363` 的 `maxResponseBytes` 缩进 2 格（上下文是 6 格）——`check-format` 只查 tab/尾随空白、`check-indent` 豁免对象字面量成员、`tsc` 不管缩进，所以门禁确实抓不到（顺手修即可）。
② 复核方为闭环 V13-8 的另外两种触发（sidecar 被杀、外部 taskkill 内核）准备了脚本（`%TEMP%\v13rev\v13-8-stop-reason-probe.mjs` 的 `sidecar_killed`/`kernel_taskkilled`），但为避免杀掉共享 sidecar 名下**其他 notebook 的 kernel**（我这边有并发会话）而**主动停手**——这是正确的判断，我记为"待无并发时补跑"，不列为缺陷。

---

## 四、七个审查维度逐条覆盖

**1. 架构与模块对齐** —— 该维度未发现明显问题
三处修复都落在正确的层：`src/core/json-exact.ts`（纯 core，无 I/O）、`src/run.ts`（停止原因由"触发器"决定，`RunRequest.abort.reason` 改为 getter 而非可变属性）、`src/core/response-budget.ts`（**新增的纯逻辑模块**，只做字节预算，不碰 I/O）。`src/mcp/*` 未新增 `node:fs`；`python/ipynb_sidecar.py` 未接触文件路径（R13 保持）。D-063/064/065 三条偏离登记齐全，`DEVIATIONS.md` 65 条编号唯一 + digest 校验通过 ✓。

**2. 代码质量与可维护性** —— 1 项（V14-1）
`response-budget.ts` 的注释把"为什么是 8 MiB 而不是 10 MiB"、"为什么先截最大的字段"写清了（因果而非叙述）✓；`readString` 的单遍实现用一个正则常量表达意图，比两次 `indexOf` 更直白 ✓。唯一是 D-065 的措辞描述了一个不存在的字段（V14-1）。

**3. 健壮性与错误处理** —— 2 项（V14-2、V14-3）
三条 🔴 全部真修且我逐条实测（线性读取、8 案例全部存活、`os._exit(7)` 正确分类为 `failed`/`kernel_died`）；预算在"图片装不下"时走 SPEC §4.3 的降级而不返回块 ✓；被截断的内容**在盘上完好** ✓。剩余是 V14-2 的"建议不可执行"与 V14-3 的"8–10 MiB 区间被截断"这两个体验/文档问题。

**4. 性能与资源效率** —— 该维度未发现明显问题
读取恢复线性（0.5/1/2 MiB → 33/68/136 ms）；预算在**发送前**按字节估算并只做必要修改（最大的字段优先），实测 8 个案例的响应生成都在 ~300 ms 量级（v13 那些案例是直接断连）；`check:package` 从 140 → 144 文件（新增模块），发布件体积影响可忽略。

**5. 安全性** —— 该维度未发现明显问题
预算只改**响应**、不动文件（我逐案例核对了盘上字节）✓；新模块是纯函数（无 I/O/时钟/随机）✓；图片降级不写入额外 artifact ✓；未新增依赖 ✓；无凭据/路径泄漏 ✓。

**6. 测试覆盖与自测质量** —— 该维度未发现明显问题（两路复核的变异结论待并入）
新增三条守卫且**都有可失败的形式**：`json-reader-scaling.test.ts`（规模/分配）、`v13-response-budget.test.ts`（164 行，含真 SDK 客户端路径）、`[V13-8]` 的分类用例（我这次集成运行里通过）。单测 +3（597→600）、集成 +4（74→78）、文件数 +1/+1。门禁作用域扩到 `scripts/` 后**没有靠忽略名单过关**（0 警是真清理）✓。

**7. 依赖与配置** —— 该维度未发现明显问题
运行期依赖仍只有 `@modelcontextprotocol/sdk` ✓；新增 CLI/环境变量 `--max-response-bytes` / `IPYNB_MAX_RESPONSE_BYTES` 是**可选带默认值**（符合 D22 的 1.x 兼容承诺）；CHANGELOG 明确记"无工具名/参数名变更、返回字段只增不减" ✓；`prepack: tsc` 保证发布前重建 `lib/` ✓。

---

## 五、总体评估

### 1. 整体质量评级：**C（需返工）**

> 按第 10 轮事前写死的尺子：A 要求"无未闭合 🔴/🟠 **且** 文档与实测一致 **且** 上轮全部条目 ✅ 且各有一手证据"。

**为什么是 C**：第二路复核在本轮**新写的响应预算**（`src/core/response-budget.ts`）里找到 **3 条 🔴，我逐条一手复现**：

- **V14-11（F1）**：截断循环在"最大可截断文本 < 237 字符"时**不收敛** → 同步 `for(;;)` 占满事件循环 → **整个 server 永久挂死**（我实测：读一个 8 MiB 源码的 notebook，`include_source='full'` 30 s 无响应，同文件 `preview` 76 ms 正常）。**比它要修的断连更严重**，而触发形状正是本轮旗舰场景（源码撑大载荷 + 小输出）。
- **V14-12（F2）**：预算**只挂在成功分支**，错误响应裸 `JSON.stringify` → `detail.executed` 里的大输出无上界 → 我实测"cell0 跑出 12 MiB 输出 + cell1 超时"→ **`-32000 Connection closed`**（文件已写回、模型既不知超时也不知哪些 cell 完成）。超时/取消/内核死亡三条失败路径全部受影响。
- **V14-13（F3）**：字节估算按 **UTF-16 单元**且忽略 JSON 转义（注释还声称"刻意保守"，方向说反）→ 低估 2–6 倍 → 我实测 **3 MiB 反斜杠即 `Connection closed`**（3 MiB ASCII 对照正常）；复核方 8 例矩阵（中文/emoji/latin-1/控制字符/引号）全部绕过预算。**中文 notebook 用户几乎必然命中**。

**同时必须肯定的**：v13 的三条 🔴 是**真修且守得住**（O(n²)→线性、10 MiB 悬崖→8 MiB 预算 + 8 案例存活、停止原因→8/8 与 SPEC 一致），单遍 JSON 读取 446 例三方对拍 0 分歧。**但预算这个新模块自己成了本轮最大的风险源**——这正是本项目连续四轮的模式：修一处、把风险搬到新代码。

**为什么"这个 C"的性质是新的**：v10 是静默写坏数据、v12 是静默改写字节、v13 是修好的地方旁边漏一格；**v14 是"新加的护栏本身会挂死进程"**——从"某个功能不对"升级为"整个 server 对所有后续请求无响应"。上线前必须修。
### 2. TOP 3 必须优先修复的问题

| # | 事项 | 为什么排这里 | 修复量 |
|---|---|---|---|
| 1 | **V14-11（F1，🔴）**：截断循环加"无净进展即退出"判定 + 迭代上界；把 `source`/`source_preview` 纳入可截断字段（或明确丢 cell）；用例"9 MiB 源码 + 小输出的 read 必须有界返回" | **永久挂死**：被修的缺陷最多杀一次连接，新缺陷让整个 server 对所有后续请求无响应；读一个真实形状的 notebook 即触发 | 小（循环内 3 行 + 上界 + 1 用例） |
| 2 | **V14-12（F2，🔴）**：把 `enforceResponseBudget` 移到成功/失败**共同出口**（对 `detail` 递归）；用例"大输出 + 超时" | 超时/取消/内核死亡是最常见的失败形态，现在模型拿到的是断连、而且**文件已经写回**——比成功路径更危险 | 小（挪一处 + 1 用例） |
| 3 | **V14-13（F3，🔴）**：估算改用 `Buffer.byteLength(JSON.stringify(payload), 'utf8')`（或 UTF-8 字节 × 2 上界），注释改成事实；补中文/反斜杠/控制字符夹具 | 中文与转义富集内容是**本项目的典型用户内容**，现在照样打死客户端（V13-1 因此只修了一半） | 小（1 个函数 + 3 夹具） |
紧随其后：**V14-1**（D-065 措辞改成事实）→ **V14-2**（丢弃路径的建议改成可执行）→ **V14-9**（计时用例阈值 3→4 或取 3 次最小值，消除最可能的假红源）→ **V14-8**（`REVIEW-FIX-STATUS.md:73` 改回 v12 快照）→ **V14-3/V14-10**（README 补"8–10 MiB 区间会被截断"、`config.ts:363` 缩进、`--max-response-bytes` 的后果说明）。

### 3. 与原始设计文档的偏离清单

| 偏离 | 性质 | 状态 |
|---|---|---|
| JSON 字符串读取改为**单次前向 token 扫描** | 已登记 **D-063** | ✅ 我复测线性（33/68/136 ms @0.5/1/2 MiB）；语义对拍由子代理复核 |
| 停止原因按**实际先触发的触发器**分类（`abort.reason` 变 getter） | 已登记 **D-064** | ✅ 我实测 `os._exit(7)` → `failed`/`kernel_died`；集成用例通过 |
| **整帧响应预算**（`--max-response-bytes`，默认 8 MiB）：超限时截断文本字段 / 丢弃整项 / 不返回图片块 | 已登记 **D-065** | ⚠️ 行为与保真都对（8 案例存活、盘上未改）；**但 D-065 的"置 `truncated` 语义"描述了 SPEC:675 里不存在的字段**（V14-1） |
| `output_truncated` 增加"因整帧预算被截断/丢弃"的含义 | D-052 的第三义之上再叠一层 | 🟡 建议在 D-065 里把这一点写明（§7 的原始定义是"某项 `truncated === true`"） |
| Windows 上 interrupt 不落地（超时靠宽限判定） | 既有 **D-025** | ✅ 超时分类跨平台一致（v13 已验） |

### 4. 后续开发建议

- **上线判断**：**修掉 V14-1 + V14-2（两处文案/文档）之后即可发 `0.1.0`**；再顺手把 `check:release` 接进 CI（V13-4）。三条 🔴 的修复我都用同一批探针复验过，集成套件 78/13 全绿，发布件 144 文件通过。
- **最该守住的回归面**（本轮改了**解析器**与**响应投影**，这是最容易伤到既有语义的两处）：`json-exact` 与 `JSON.parse`/Python `json` 的对照矩阵、`nbformat.validate`（写回文件）、图片四形状 × read/run、`warnings` 各出口、`__proto__` 五键盘上保真——两路复核正在跑这一组，落地后我把结论并进本节。
- **上线前的最后一道非代码门**：**E1–E9（仍 0/9）**。v13 的两条最重 🔴（10 MiB 断连、O(n²) 卡顿）都只有"真客户端 + 真 notebook"能暴露；现在预算把断连挡住了，但"模型拿到的是被截断的内容"这件事**只有在真客户端里才看得见观感**（例如 8 MiB 的文本块在 Claude Desktop 里会不会把上下文打满）。
- **建议加进 `AGENTS.md §9` 的两条**（本轮与前几轮反复付代价）：① **门禁不得与重负载探针并行跑**（会造出假红并污染读数）；② **凡"消费者会怎么收到"的问题，必须用真消费者（真 SDK/真客户端）测**——我自己的体积矩阵用裸 JSON-RPC，结构上看不见 10 MiB 帧上限。

---

## 附录：验证分工、我自己的判断纠正、局限

**主审亲验**
- 门禁全家桶（typecheck / lint 含三自测 / unit 600·31 / **integration 78·13** / smoke 26/26 / check:package **144**+22）；`DEVIATIONS.md` 65 条唯一 + digest。
- **复用 v13 探针三组**：① 帧悬崖 8 案例（真 SDK 客户端）；② 转义密集计时矩阵（0.5/1/2 MiB）；③ 后台 run + `os._exit(7)` 分类。
- **新增 1 组**：被截断/被丢弃的交付形状与盘上保真（item 键集、带内标记、`text` 长度、警告原文、文件字节未变）。
- **命令级核对**：`oxlint src tests scripts` 现在是 lint 的一部分且 0 警（对照 v13 的 `npx oxlint scripts` → 8 errors）。

**我的判断纠正（记录在案）**
- v13 我在第一稿里把 `v12-timeout-status.test.ts` 判为"可失败"；复核方用变异证明它在 Windows 上是**死守卫**（grace 早退分支绕过新代码块）。本轮 `21e364b` 的标题正是"make the dead guards live"——**这条纠正已被实现方采纳**，具体效果由本轮子代理的变异结果确认后并入 §四.6。

**局限**
- 我未在 Linux/macOS 实跑；未跑真实第三方客户端（E1–E9 仍 0/9）。
- 帧悬崖的边界我只测了 v13 那 8 个点（未逐 0.1 MiB 扫），预算的**多输出累计**行为只测了 60×300 KiB 一例，更细的矩阵由子代理补。
- V14-3 的"8–10 MiB 区间被截断"是实测事实（9.0/9.5/9.9 MiB 都变 8.00 MiB），但"用户会因此不满"是我的推断，未做用户验证。
