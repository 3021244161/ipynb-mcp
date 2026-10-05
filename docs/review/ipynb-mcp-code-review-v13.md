# ipynb-mcp 代码审查报告（第十三轮 / v13，发布前）

> **审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp` @ HEAD `a1d6831`（v12 之后 **5 个提交**，共 103 提交；工作树**干净**）
> **本轮来源**：`docs/review/ipynb-mcp-changejob-real-usage-trial.md` —— 用 5 个真实 notebook（含 37.5 MiB 的 xgboost 调参本）打真客户端的实测
> **方法**：主审亲跑全部门禁 + **发布件检查** + `lib/` 重建比对 + **4 组自建探针**（37–204 MiB 体积矩阵 / cp1252 编码正反对照 / 超时分类与耗时区分实验 / 跨平台断言核对）+ 两路独立复核
> **日期**：2026-10-05

---

## 一、门禁与发布件实测（主审亲跑，无并行负载）

| 门禁 | 实测 | 说明 |
|---|---|---|
| `pnpm typecheck` | exit **0** | ✅ |
| `pnpm lint` | **0 警 0 错** + `format check: ok` + `indent ok (28 samples)` + `documentation self-test: ok (**17** mutations, 0 skipped, control clean)` + `documentation check: ok` | ✅ 上轮那两个未跟踪脚本的 tab 问题**已在提交前修好**（现在它们被 `check-format` 正常管辖） |
| `pnpm test` | **597 passed / 30 文件** | ↑ 596→597 |
| `pnpm test:integration` | **74 passed / 12 文件**，316.8 s，`VITEST_EXIT=0` | ↑ 73/11→74/12（新增 `v12-timeout-status.test.ts`） |
| `pnpm smoke` | **26/26** | ✅ |
| `pnpm check:package` | **ok（140 文件，22 变异）** | ✅ |
| **`pnpm check:release`** | **12/12**（`npm pack` → 装进空目录 → 真 stdio 驱动装好的二进制） | ✅ 但**不在 CI、也不在 `prepublishOnly`**（见 V13-1） |
| `lib/` 与 `src/` 同步 | `tsc --outDir` 重建后 **68 文件逐字节相同、0 处不一致** | ✅ 发出去的就是当前代码 |
| `docs/DEVIATIONS.md` | **62 条编号全唯一**、最大 D-062、`digest` 与头部声明一致 | ✅ |
| oxlint 自报文件数 | **78**（状态表写 "71 → 78"，**现在是对的**） | ✅ 上轮 V12-5① 关闭 |

---

## 二、本轮整改验证（逐条一手证据）

### 2.1 🔴 38 MB notebook 让 server OOM 硬崩 → ✅ **真修，且我把它推得更远**

我把体积矩阵拉成 4 档（默认堆，`PeakWorkingSet64` 采样；每档都跑 read×2 / 无关 cell 编辑 / 跑一个小 cell）：

| notebook | read summary | read full | edit 无关 cell | run 小 cell | 峰值工作集 | 崩溃 |
|---|---|---|---|---|---|---|
| 33.9 MiB | 2.7 s | 6.4 s | 14.9 s | 63 s | **573 MiB** | 无 |
| 67.8 MiB | 5.2 s | 23.7 s | 24.2 s | 92 s | 1381 MiB | 无 |
| 101.8 MiB | 10.1 s | 32.3 s | 22.2 s | 89 s | 1501 MiB | 无 |
| **203.5 MiB** | 11.2 s | 37.0 s | 85.6 s | **216 s** | **2676 MiB** | **无** |

- 他们的诊断成立且我复核了根因：`readString` 逐字符 `result += char` → cons-string 链；改为"一次 `indexOf` 找下一个 `"`/`\`、整段 `slice`"。
- 他们的余量声明也成立：同一 34 MiB 文件在 **`--max-old-space-size=768`** 下跑完 ✓；我进一步在 **204 MiB + `--max-old-space-size=1024`** 下也跑完 ✓（峰值 WS 2069 MiB，说明堆占用远低于工作集）。
- **守卫是"能看见它守的缺陷"的那种**：`[V13-1]` 用**分配探针**而不是值断言，并在注释里写明"值断言看不见这个缺陷"（链会摊平成正确字符串）；CHANGELOG 记录变异验证：把逐字符版本写回 → 只有这一条红并打印 `retained 61.4 MiB`，其余 9 条绿。这正是前几轮我反复要求、也反复缺失的东西。

### 2.2 🔴/🟠 超时终态码随平台变化 → ✅ 真修（两种平台差异的修法都验了）

- **Windows 实测**：`cell_selector='0'` 对 `time.sleep(45)`、`timeout_seconds=5` → `code=exec_timeout`、`detail.executed[0].status="timeout"`、message `cell execution timed out after 5s (interrupt did not land)`；**超时后再跑另一个 cell 正常**（`mode_used=replay`，符合 SPEC §4.7 规则 6"超时即标记内核死亡"）。
- **耗时也干净**（我做了区分实验，排除"等 cell 结束"的猜测）：
  ```
  同一 timeout=5s：cell 睡 8s  → 墙钟 11.3 s
                  cell 睡 45s → 墙钟 14.3 s     ← 不随 cell 剩余时长增长，约 = 5s 超时 + 5s 宽限 + 开销
  ```
- **两个测试提交是正当纠正，不是放宽断言**：旧断言让 cell 打印 `after` 再断言输出里没有它——这 pin 的是**平台细节**（Linux 上中断落地，cell 可能在 5 秒宽限内跑完，`after` 会被收集）。新断言 pin 的是规则：`status === "timeout"` + "没有成功输出"，两边都成立；若把 sidecar 的 `timed_out` 判定撤掉，Linux 会回到 `error` → 依然可红。

### 2.3 🟠 sidecar 的 `UnicodeEncodeError` 让进程（连同所有 kernel）死掉 → ✅ 真修（**正反对照**）

这是本轮我评价最高的一条修复，因为它与 OOM **同族**（进程死 → 客户端只看到 `-32000 Connection closed`、该 server 名下所有 notebook 的 kernel 一起死），而触发条件更廉价（一个中文 traceback + cp1252 控制台）。

```
【反向对照】PYTHONIOENCODING=cp1252 直跑 Python 写中文 → exit=1  UnicodeEncodeError: 'charmap' codec can't encode…
            PYTHONIOENCODING=utf-8                     → exit=0  输出正常
【正向实测】同一 cp1252 环境下经 MCP server 跑 cell：
            cell0 print("中文输出 → 箭头 ★") → status=ok    输出完整："中文输出 → 箭头 ★\nascii ok\n"
            cell1 raise ValueError("中文错误信息 → 失败") → status=error  error_value="中文错误信息 → 失败"
            server 全程存活、stderr 干净
```
防御是**两层**（`main` 里对三个流 `reconfigure(encoding="utf-8", errors="replace")` + `send()` 里 `ensure_ascii=True` 的退路），注释与代码一致 ✓。

### 2.4 "文档化而非修复"两条的诚实性 → ✅ 成立

- **D-062（`mode='auto'` 会重跑目标之前的 cell）**：理由链完整且我认同——SPEC §4.7 规则 1（静默 replay）是红线级条款、SPEC §7 的 warning 码表**封闭**、复用既有码会让模型读到假语义、工具 `description` 被用例断言与 SPEC §4.2 **逐字相同**（改它就是改对外文案）。README 写了规避路径（先 `kernel(action='start')` 再 `mode='resume'`），代价在响应里可见（`mode_used` + `replayed_cell_indexes`）。
- **`notebook_kernel(action='list')` 不存在**：不是缺陷 ✓ —— 拒绝未知参数正是 SPEC §7 / AGENTS §5 要求的行为（`invalid_arguments`）。
- **README 的体积限制** ✅ 已登记且量化（37.5 MiB → 约 0.9 GiB 峰值；旧版 2.2 GiB 并硬崩）。

---

## 三、本轮发现

> 编号按发现顺序；严重度见各行。本轮共 **3 条 🔴**（V13-1 / V13-7 / V13-8）、4 条 🟡、1 条 🟢。


【V13-1】
严重程度：🔴 阻塞
所在位置：`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js:2-14`（`STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024`，`ReadBuffer` 超限即抛错）· `src/mcp/render/read.ts:168-176`（只有 `kind === 'stream'` 判 `truncated`）· `src/core/outputs.ts:728-747`（截断只作用于 stream）· `SPEC.md:660`（截断表第 1 行只列 `outputType === 'stream'`）
问题描述：**任何单次响应（一行 NDJSON 帧）超过 10 MiB，MCP 客户端就会杀掉连接**——客户端看到 `McpError -32000: Connection closed`，之后所有调用 `Not connected`；而服务端**没有任何总响应预算**，`text`/`html`/`json` 输出项完全不受 `inline_text_chars` 约束。
详细分析（**主审用真 SDK 客户端 + 真 stdio 实测**，8 个案例）：
```
text/plain  9.0 MiB  → ✓ 响应 9.00 MiB，254 ms，warnings=0
text/plain  9.5 MiB  → ✓ 9.50 MiB
text/plain  9.9 MiB  → ✓ 9.90 MiB
text/plain 10.2 MiB  → ✗ McpError -32000 Connection closed     ← 悬崖正好落在 SDK 的 10 MiB
text/html   11 MiB   → ✗ Connection closed
application/json 11 MiB → ✗ Connection closed
image/png（base64 约 11 MiB）→ ✗ Connection closed              ← 图片也中招（--max-image-bytes 默认 20 MiB 远高于安全线）
60 × 300 KiB（共 17.6 MiB，单项都很小）→ ✗ Connection closed     ← 限制在【整帧】，不是单项
stream 11 MiB        → ✓ 被 inline_text_chars 截断成 0.02 MiB + 1 条警告   ← 唯一有上界的那一类
```
三个后果，按严重度：
1. **这正是本轮声称修好的场景**（37.5 MiB 的 xgboost 本、SHAP/dataframe 输出）：服务端 OOM 被修好了，但同一个文件在读/跑时**换成客户端整条会话死掉**，模型拿到的是同一个不可操作的 `-32000 Connection closed`。子代理另测：`run` 一个产出 12 MiB 结果的 cell 时，**服务端已经成功写回文件**（`execution_count=1`、`nbformat` VALID），而模型永远看不到——比 OOM 更隐蔽。
2. **9.9 MiB 时是"静默通过"**：`warnings: []`、零截断、零提示，用户与模型都不知道再大一点就会死。没有一个"接近上限"的信号。
3. **10 MiB 是 SDK 的默认值，不是协议的**：客户端可以调 `maxBufferSize`，但服务端**不能假设**任何给定客户端调过（Claude Code / dsh / Cursor 各用各的默认）。所以边界必须由**服务端**保证。
修复建议（按性价比）：
1. **加"整帧预算"**：序列化前后按字节累计，超过 `--max-response-bytes`（默认建议 8 MiB，留 20% 余量）时，把**非 stream 项**也纳入截断：置 `truncated: true` + `truncated_at_chars`，并发既有的 `output_truncated` 警告（SPEC §5.4"禁止静默截断"要求的正是这个标志位）。图片同理：超过安全线的图**不返回块**（`artifact_path` 已有，SPEC §4.3 的降级路径现成）。
2. **注意这是对 SPEC 的偏离**：§5.4/§7 的截断表只规定 stream 阈值，对"响应总大小"**没有条款**——按 AGENTS §0 必须先登记 `DEVIATIONS.md`（现象：传输层有 10 MiB 硬限而 SPEC 无预算条款；最小解法：总预算 + 非 stream 截断 + 标志位）。
3. **README 写明边界**（10 MiB 帧上限、建议用 `cell_indexes` 分批读），并把"单次响应可能被截断"写进 `notebook_read` 的已知限制。
4. **补一条能失败的用例**：真 SDK 客户端 + 一个 11 MiB 输出的 notebook，断言"要么响应 < 8 MiB 且带 `output_truncated`，要么明确失败"——**这条用例是本次唯一能抓住该缺陷的形式**（见附录：我自己的体积矩阵为什么漏掉它）。
设计文档对齐：SPEC §5.4（禁止静默截断 → 本条现在是"静默**不**截断"更糟）、§4.3（图片降级路径）、§6 R2；与 v12 V12-3/V12-5 同族（"守卫的作用域 ≠ 责任的作用域"）。

【V13-7】
严重程度：🔴 阻塞（**本轮修复引入的 O(n²) 性能回归**：转义密集的字符串把读取从毫秒级拖到分钟级）
所在位置：`src/core/json-exact.ts:541`（`readString` 里 `const quote = this.text.indexOf('"', this.index);`）
问题描述：`indexOf('"', …)` **没有按"下一个 `\`"截断**——每次处理一个转义序列时，都要把"从当前位置到字符串结尾"整段重扫一遍找引号。于是转义越密，扫描越多次，整体退化成 O(n²)。
详细分析（**主审实测**，合法 nbformat、单个 source 字符串每 20 字符一个 `\n`）：
```
source 0.5 MiB →   413 ms
source 1.0 MiB →  1611 ms    (×3.9)
source 2.0 MiB →  6362 ms    (×3.9)   ← 教科书式二次增长（翻倍 → 四倍）
```
子代理在更大样本上量到同样的形状：**6.3 MiB 的合法 notebook，`notebook_read` 从旧版 335 ms 变成 56.5 s（169×）**，期间 MCP server 单线程**完全无响应**；引擎级 8.2 MiB 单串 1/2/4/8 MiB = 782 / 3127 / 12410 / 49789 ms。
触发面不是奇技淫巧：**任何含大量换行的 cell 源码**（`\n` 在 JSON 里就是转义）与 JSON 密集的输出都会中招——一个 6 MB 的 notebook 就能让工具看起来"卡死"。旧实现（逐字符）在内存上更差，但时间是线性的。
修复建议（一行级）：把两个分隔符的搜索**限制在当前段内**——例如先找最近的 `\`，再把引号搜索限制在 `[index, backslash)`：
```ts
const backslash = this.text.indexOf('\\', this.index);
const quote = this.text.indexOf('"', this.index);
if (backslash >= 0 && (quote < 0 || backslash < quote)) {
  result = this.appendChecked(result, this.text.slice(this.index, backslash), backslash + 1);
  // …escape 处理…
} else {
  if (quote < 0) throw new SyntaxError('Unterminated string in JSON');
  return this.appendChecked(result, this.text.slice(this.index, quote), quote + 1);
}
```
（或一次正则扫描 `/["\\]/g` + `lastIndex`。）**必须补一条用例**：转义密集的 2 MiB 字符串，断言读取时间有上界（现有 `[V13-1]` 的载荷**无转义**，且它的时间断言在本机对旧代码也不触发——判别力全部来自分配探针，抓不到本条）。
设计文档对齐：SPEC §5.5.4/§5.5.7（序列化契约与保真度）；AGENTS §9（"守卫必须能失败"——本条目前**零覆盖**）。

【V13-8】
严重程度：🔴 阻塞（**后台 run 的异常内核/sidecar 死亡被报成"客户端取消"**）
所在位置：`src/mcp/tools/run.ts:199`（后台 run 恒定传 `reason: handle.abortReason ?? 'cancelled'`）→ `src/run.ts:357`（`?? 'kernel_died'` 的诚实兜底对后台不可达）→ `src/run.ts:889`（`reason === 'kernel_died' ? … : 'cancelled'`）；`handle.abortReason` 只有 `src/mcp/tools/kernel.ts:59`（显式 shutdown/restart）会设置
问题描述：内核**异常**死亡（cell 内 `os._exit()`、sidecar 进程被杀）时，**同步**路径正确报 `kernel_died`，**后台**路径却报 `cancelled`——而**没有任何人取消过这次运行**。SPEC §4.8 规则 1 要求这种情况是 `failed` + `kernel_died`。
详细分析（**主审实测**，后台 run + cell 内 `os._exit(7)`）：
```
run: kind=background run_id=run-1
终态(+9.0s): state=cancelled  error.code=cancelled  error.message="run aborted (cancelled)"  executed=[]
              ↑ 真相是"内核意外死亡"（server 日志会写 kernel died unexpectedly）
```
子代理另用两种构造复现同一现象（`Stop-Process` 掉 `ipynb_sidecar.py`；cell 内 `os._exit(7)` 连跑两次），并给出了上面的根因链；同步路径在同一构造下给 `kernel_died` ✓，所以这是**后台专属**的分类错误。
影响：客户端无法区分"我自己取消的"与"它崩了"——前者可安全重试/放弃，后者意味着状态可能已丢失、需要重建（`replay`）。把崩溃说成取消，会让模型做出错误的下一步。
修复建议：**按事实分类，而不是按 abort reason**——在 `src/run.ts:889` 用 `isKernelGone(cause)`（该文件已有类似判定，见 `kernel_died` 的既有分支）或让 transport/registry 在检测到进程消失时把 reason 定为 `'kernel_died'`；`src/mcp/tools/run.ts:199` 的默认值应从 `'cancelled'` 改成"未指定"，让 `src/run.ts:357` 的兜底真正生效。补用例：后台 run + cell 内 `os._exit(7)` → 断言 `state==='failed'` 且 `error.code==='kernel_died'`（现有 `server.test.ts:332-333` 只覆盖显式 restart，这条路径**零覆盖**）。
设计文档对齐：SPEC §4.8 规则 1、§7 错误码表；AGENTS §9（错误分类必须能被用例守住）。

*不**截断"更糟）、§4.3（图片降级路径）、§6 R2；与 v12 V12-3/V12-5 同族（"守卫的作用域 ≠ 责任的作用域"）。

【V13-2】
严重程度：🟡 警告
所在位置：`package.json` 的 `lint`（`oxlint src tests`）· `scripts/check-indent.mjs`（收集器只收 `.ts`/`.mts`）· 全体 `scripts/*.mjs`
问题描述：`scripts/` 目录**基本在 lint 门禁之外**：`oxlint` 只跑 `src tests`（我实测 `npx oxlint scripts` → **8 errors / 4 warnings**，13 个文件）；`check-indent` 只收 `.ts/.mts`；只有 `check-format` 覆盖它（所以上一轮那两个 tab 才会被抓到）。
详细分析：门禁的作用域与责任的作用域不一致——`scripts/` 是有真实职责的代码（`check-docs.mjs` 自己就是诚实度门禁的实现，`release-check.mjs` 是发布件门禁），却享受比 `src/` 宽松得多的静态检查。这与 v12 V12-5（check-docs 的两个洞）、v11 的"门禁被自身满足"是同一族。
修复建议：把 `lint` 扩成 `oxlint src tests scripts`（先清掉那 8 个 error），并把 `check-indent` 的收集器扩到 `.mjs`（或明确写下"scripts/ 只受 check-format 约束"的理由）。
设计文档对齐：AGENTS §4（模块铁律）+ §5（编码规范）——两者都未声明 `scripts/` 豁免。

【V13-3】
严重程度：🟡 警告
所在位置：`scripts/trial-changejob.mjs:5,7-10` · `scripts/trial-scenarios.mjs:95`（`E:\ChangeJob\天竺街py（30+20）\20py.ipynb`）· `scripts/measure-run-memory.mjs:26-41`、`measure-real-notebook.mjs:19-42`（`spawnSync('powershell', …)` 失败被 `catch {}` 吞掉）
问题描述：试用脚本硬编码本机绝对路径，且 `--root` 是唯一护栏——`--root E:\ChangeJob --scenario suite` 会**直接在真实 notebook 上插 cell、把正文 markdown 改成未闭合围栏并留 `.bak`**，脚本没有任何警告横幅；在非 Windows 上 `E:\...` 被当相对路径 → `P()` 全部失效，`contract` 情景里"root 外必须被拒"的检查会**假绿**（它期望的正是 `path_outside_root`）。
详细分析：不影响发布件（`scripts/` 不在 `files` 里、未挂 CI、我核对过无凭据），但它是"会改用户真实文件的工具"，且静默吞掉 `spawnSync` 失败会输出 `ratio=0.0` 这种看似正常的数字。
修复建议：① 脚本头部加横幅警告（"writes into --root; point it at a COPY"），并在 `--root` 等于 `E:\ChangeJob` 这类已知原件目录时**拒绝运行**；② `measure-*.mjs` 的 PowerShell 采样失败改成显式报错（而不是 `catch {}` 吞掉）；③ 非 Windows 用 `path.join`/`os.homedir()` 派生路径。
设计文档对齐：AGENTS §9（守卫必须能失败）+ 本项目的"失败要可见"原则。

【V13-4】
严重程度：🟡 警告
所在位置：`.github/workflows/ci.yml`（有 typecheck/lint/build/test/check:package/smoke/test:integration，**无 `check:release`**）· `package.json` 的 `prepublishOnly`（typecheck + lint + test + check:package）
问题描述：唯一"把包装进空目录、用真 stdio 驱动装好的二进制"的门禁（`check:release`，我实测 **12/12 通过**）**不在 CI、也不在 `prepublishOnly`**。
详细分析：**我上一稿说"prepublishOnly 不含 build 会发出旧代码"这一半要修正**——`prepack: tsc -p tsconfig.json` **存在**，打包时会重新构建 ✓。剩下的缺口只有：`check:release` 没有进入任何自动化路径，而 `check:package` 只验 tarball 的**形状**（140 文件 + 22 变异），不验"装出来能不能跑"。既然本轮目标是"过 CI + 发布"，这道门禁应当随手接上。
修复建议：CI 加一个 job（或在 unit job 收尾）跑 `pnpm build && pnpm check:release`；`prepublishOnly` 追加 `&& npm run check:release`。
设计文档对齐：AGENTS §8 第 10 步（打包与发布）、SPEC §8。

【V13-5】
严重程度：🟢 建议（两条小账）
① `docs/REVIEW-FIX-STATUS.md:37` 的门禁数字滞后："单测 **596** / 集成 **73·11**"，我实测 **597 · 30 文件** / **74 · 12 文件**（新增 `v12-timeout-status.test.ts` 使集成多一个文件）。与 v12 V12-5① 同族，但这次是"比树上少 1"的正常滞后，不是虚报。
② `scripts/measure-real-notebook.mjs:3` 的头注释写 `node scripts/measure-run-memory.mjs --file …`（指错了脚本名）。
修复建议：更新那一行数字；改掉头注释里的脚本名。

【V13-6】
严重程度：🟡 警告（**待澄清的分歧**：cancel 的终态语义 + 一条因此失去判别力的用例）
所在位置：`python/ipynb_sidecar.py` 的 `timed_out` 判定（"已送出 interrupt"）· `src/run.ts:632` 的文案 `cell execution timed out after Ns (interrupt did not land)` · `tests/integration/kernel.test.ts:180-186` · `tests/integration/v12-timeout-status.test.ts` 的逐输出断言
问题描述：子代理黑箱实测"后台 run + `notebook_run_cancel` → 终态 `executed=[{cell_index:0,status:'timeout'}]`"；**我用同样的链路（15 秒 cell、300 秒超时、`--background-threshold-seconds 1`）实测得到 `executed=["0:error"]`、`error.code=cancelled`、`facts_pending` 在 +16 s 归零**——即 cancel 与 timeout 在**我的环境里是可区分的**。我们两边给出的结论不同，需要实现方给出复现步骤来定谁对。
但**可确认的部分**有三点：
1. **文案是有条件的断言**：`(interrupt did not land)` 在我的机器上为真（`duration_ms=10015` ≈ 5 s 超时 + 5 s 宽限），但在 interrupt 真能落地的平台/调用路径上是假事实；把它写在无条件的位置上，与 V11-12①（"文案必须描述实际交付的载荷"）同族。
2. **`kernel.test.ts:180-186` 的 `KeyboardInterrupt` 断言已经不可达**：只有 `status === 'error'` 才走到它，而超时路径现在恒为 `timeout` ⇒ 删掉 sidecar 的 interrupt 逻辑该用例照样绿（可变异的用例）。
3. **`v12-timeout-status.test.ts` 的逐输出断言在 Windows 上真空转**：`rawOutputs` 为 `[]` 时 `for (const output of outputs) expect(…)` 一次都不执行——它接受两种平台形态的写法是对的，但**"在 Windows 上什么也没断言"**这件事应当写明，否则会给人"两条路径都被覆盖"的错觉。
修复建议：① 让终态**携带原因**（例如 `executed[].status` 之外补 `interrupt_landed: boolean`，或让 cancel 与 timeout 在 `error.code` 上始终可分——后者我的实测已成立，需按子代理的复现步骤核对）；② 把 `(interrupt did not land)` 改成随事实变化的两句文案；③ `kernel.test.ts` 那条改成"非超时触发的 interrupt → `error` + KeyboardInterrupt"（子代理已用探针证明这条路径存在且可断言），超时触发的那条留给 `v12-timeout-status.test.ts`；④ 在那里补一句注释说明 Windows 分支的断言是空的，并加一条**不真空**的断言（例如 `outputs.length === 0 || outputs.every(o => o.outputType === 'error')`）。
设计文档对齐：SPEC §4.8（cancel 与 timeout 的语义必须可区分）、§4.7 规则 6、§7 错误码表；AGENTS §9（守卫必须能失败）。

---

## 四、七个审查维度逐条覆盖

**1. 架构与模块对齐** —— 2 项（V13-1 的契约缺口、V13-2 的门禁作用域）
修复本身都落在正确的位置（core 的解析器、sidecar 的收尾判定、`tests/unit` 的守卫）；D-059/D-062 登记齐全，`DEVIATIONS.md` 62 条编号唯一 + digest 校验通过 ✓。**但**本轮暴露一个**契约层缺口**：传输层（SDK 的 `ReadBuffer`）有 10 MiB 硬限，而 SPEC 只规定 `stream` 的截断阈值、**对响应总大小没有条款**——这正是"模块间通信方式是否符合约定"这一维度的问题（V13-1），修法按 AGENTS §0 必须先登记偏离。另外 `scripts/` 与 `src/`+`tests/` 享受不同的门禁强度（V13-2），属"职责边界与门禁边界不一致"。

**2. 代码质量与可维护性** —— 2 项（V13-2、V13-5）
`readString` / `appendChecked` 的拆分干净，注释写的是**因果**（16 倍堆占用、cons-string 链、为什么值断言看不见）——本轮质量最高的部分；`appendChecked` 把控制字符规则**恰好**放在"原始字符"路径上也是对的（`\u0000` 是合法写法）。`V13-2`（`scripts/` 有 8 个 oxlint error 从未被检查）与 `V13-5`（指错脚本名的头注释）是维护性上的两处小账。

**3. 健壮性与错误处理** —— 3 项（V13-1、V13-3、V13-6）
崩溃类缺陷本轮被消灭了两个（服务端 OOM、sidecar 编码致死，我都验了正反面），超时分类跨平台一致，grace 有界（不随 cell 剩余时长增长）。**剩下的三处**：① 响应超 10 MiB 时**客户端**整条会话死掉且无错误码（V13-1，🔴）；② trial 脚本会就地改写真实 notebook、非 Windows 上 `contract` 检查假绿（V13-3）；③ cancel 的终态语义与一条失去判别力的用例（V13-6）。

**4. 性能与资源效率** —— 1 项（V13-2 的体积/耗时曲线）
本轮服务端数据都在 §2.1：read 2.7→11.2 s、edit 14.9→85.6 s、run 63→216 s（33.9→203.5 MiB），峰值工作集 573→2676 MiB；**没有 O(n²)**（随体积近似线性），但常数很大且无上限。V13-1 从**另一端**给出了同一个结论：响应侧也没有预算，10 MiB 是硬墙而不是可调参数。

**5. 安全性** —— 该维度未发现明显问题
新脚本无凭据（只有路径）✓；sidecar 仍不接触文件路径（R13）✓；`errors="replace"` 只影响**无法编码的字符**（JSON 信封是 ASCII，协议帧仍可解析）✓；fence 行为未变（trial 报告实测拒绝了 root 外的中文路径）✓；未新增依赖 ✓。唯一沾边的是 V13-3：一个会改真实用户文件的 dev 脚本没有护栏（不是产品代码，但属"误用即损坏"）。

**6. 测试覆盖与自测质量** —— 2 项（V13-6、以及 V13-1 暴露的覆盖盲区）
好的部分：`[V13-1]` 是"分配探针 + 已证实的变异判别力"（逐字符版本写回 → 只有它红）；`v12-timeout-status.test.ts` 在**判定发生的那一层**（真 sidecar + 真 kernel）断言 `status === "timeout"`；两个测试提交经我逐行核对是**纠正错误断言**而非放宽。
不足的两处：① `kernel.test.ts:180-186` 的 `KeyboardInterrupt` 断言在新语义下**不可达**（删掉 sidecar 的 interrupt 逻辑该用例照样绿），且 `v12-timeout-status.test.ts` 的逐输出断言在 Windows 上是**空转**（V13-6）；② **最大的一处**——所有体积/大输出用例都停在"服务端视角"，**没有一条用真客户端验证过"消费者能不能收下"**，这正是 V13-1 能溜过整轮 CI 与两路复核的原因（我自己的体积矩阵也用裸 JSON-RPC，结构上看不见）。

**7. 依赖与配置** —— 该维度未发现明显问题
`package.json` 本轮**未改**（无新依赖、`files`/`bin` 不变）✓；`prepack: tsc -p tsconfig.json` 存在，打包时会重建 `lib/` ✓（所以"忘记 build"不成立）；`lib/` 与重建产物逐字节一致 ✓；无循环依赖 ✓。唯一是 V13-4：`check:release` 没接进 CI/`prepublishOnly`。

---

## 五、总体评估

### 1. 整体质量评级：**C（需返工）**

> **本条在我初稿里是 B，第二路复核落地后按第 10 轮事前写死的尺子下调为 C**——尺子写明"存在 🔴，或 ≥2 条 🟠，或存在虚报/静默改写 → C"，而 **V13-1 是我亲手复现的 🔴**。

**为什么是 C**：
- **3 条 🔴**：
  - **V13-7（本轮修复引入的回归）**：`readString` 的 `indexOf('"')` 未按 `\` 截断 → **O(n²)**。我实测转义密集的 source：0.5/1/2 MiB → 413/1611/6362 ms（翻倍即四倍）；子代理在 6.3 MiB 合法 notebook 上量到 **56.5 s**（旧版 335 ms）。凡是"大字符串 + 大量 `\n`"（日志式输出、长源码）都会让工具看起来卡死，**且零覆盖**。
  - **V13-1（客户端 10 MiB 悬崖）**：响应超 10 MiB 时 MCP 客户端整条会话死掉（`-32000 Connection closed`），`text`/`html`/`json` 项与整帧总大小都没有上界；我用真 SDK 实测 9.9 MiB 静默通过、10.2 MiB 起必死、大图片与"60×300 KiB 累计 17.6 MiB"同样必死；`run` 一个 12 MiB 结果的 cell 时**文件已写回成功**而模型永远看不到。
  - **V13-8（崩溃被说成取消）**：后台 run 的内核**异常**死亡（cell 内 `os._exit(7)`、sidecar 被杀）报 `state=cancelled`+`error.code=cancelled`，而 SPEC §4.8 规则 1 要求 `failed`+`kernel_died`；同步路径正确 → 客户端无法区分"我取消的"与"它崩了"。我实测复现，子代理三种构造复现。
- **≥2 条 🟡**：V13-2（`scripts/` 8 个 error 在 lint 门禁之外）、V13-3（trial 脚本会就地改写真实 notebook）、V13-4（`check:release` 不在任何自动化路径）、V13-6（cancel 语义分歧 + **超时守卫在 Windows 上零判别力** + 三条空转/过期的断言与文案）。

**为什么"这个 C"的性质和 v10/v12 不同**：v10 是"新引入的静默写坏数据"、v12 是"新引入的静默改写字节"；本轮**两个 P0 级修复都是真的**（OOM 从 33.9→203.5 MiB 四档全通过、768/1024 MB 堆上限下也通过；sidecar 编码致死正反对照都验过），三条 🔴 里两条是**修复的副作用**（O(n²)、客户端悬崖）——即"把风险从服务端搬到了别处"。

**为什么不是 B**：三条 🔴 各自都有"用户以为能用、实际不能用"的形态（卡死 56 s / 会话断掉 / 崩溃被误报），且全部**零覆盖**。

### 2. TOP 3 必须优先修复的问题

| # | 事项 | 为什么排这里 | 修复量 |
|---|---|---|---|
| 1 | **V13-7（🔴）**：把 `readString` 的两处搜索都限制在"下一个 `\`"之前（一行级），并补一条**转义密集 2 MiB** 的耗时/分配用例 | **本轮引入的回归**、触发面最广（日志式输出/长源码都中招）、后果是"工具像卡死"（单线程无响应），修法最小 | 极小（1–3 行 + 1 用例） |
| 2 | **V13-1（🔴）**：加**整帧响应预算**（`--max-response-bytes` 默认 ~8 MiB）；把 `truncated`/`truncated_at_chars` + `output_truncated` 扩到非 stream 项（大图不返回块、走现成 artifact 降级）；按 AGENTS §0 登记 SPEC 偏离；README 写明 10 MiB 边界；补一条**真 SDK 客户端 + 11 MiB 输出**的用例 | 打中的正是本轮要修的场景；9.9 MiB 时静默通过、`run` 的那一半还会"文件已写回但模型看不到" | 中（预算 + 扩面 + 登记 + 1 用例） |
| 3 | **V13-8（🔴）**：按**事实**而非 abort reason 分类（`isKernelGone(cause)`，或让 transport/registry 在进程消失时置 `'kernel_died'`；`src/mcp/tools/run.ts:199` 的默认值别再用 `'cancelled'`）；补后台 `os._exit(7)` 用例 | 崩溃被说成取消会让模型做错下一步（取消可放弃、崩溃要重建状态）；现有用例只覆盖显式 restart，这条路径零覆盖 | 小（分类 + 1 用例） |

紧随其后：**V13-6**（`(interrupt did not land)` 改成不含平台断言的措辞；删掉 `v9-regressions.test.ts:290` 对 `internal` 的容忍；把子代理已验证的 `SIG_IGN` 用例（出货 PASS / 撤销修复 FAIL）加进 `v12-timeout-status.test.ts`；`kernel.test.ts:180-186` 改成"非超时触发的 interrupt"并给"只准 error"循环补非真空断言）→ **V13-2 + V13-4**（lint 扩到 `scripts`；CI 接上 `check:release`）→ **V13-5**（`COMPATIBILITY.md:27` 的 596/73·11、`REVIEW-FIX-STATUS.md` 缺本轮段落、D-060 验证列过期、`measure-real-notebook.mjs` 头注释）→ **V13-3**（trial 脚本护栏）。

### 3. 与原始设计文档的偏离清单

| 偏离 | 性质 | 状态 |
|---|---|---|
| 自研解析器读取字符串改为"整段切片 + 仅在转义处逐字符" | 已登记 **D-059** | ✅ 语义与 `JSON.parse`/Python `json` 的 87 条矩阵全绿（子代理另用 4000 份随机文档往返逐字节等价验证），我复核了 4 档体积 |
| `mode='auto'` + 无活 kernel 时的 replay 会执行目标之前的 cell | 已登记 **D-062**（不改行为 + README 规避路径） | ✅ 理由成立（SPEC §4.7 规则 1 红线、§7 码表封闭、description 逐字断言） |
| Windows 上 interrupt 不落地（超时靠宽限判定） | 既有 **D-025** | ⚠️ 分类现在跨平台一致；但 `(interrupt did not land)` 被写成了**无条件文案**，在 interrupt 落地的平台是假事实（V13-6） |
| 超时后内核按 §4.7 规则 6 关闭 | SPEC 内 | ✅ 实测超时后的下一次 run 走 `replay`，与规则一致 |
| **响应总大小没有上界**（传输层 10 MiB 硬限 vs SPEC 只规定 stream 截断） | **未登记** | 🔴 V13-1：按 AGENTS §0 先登记再改（现象：SDK `ReadBuffer` 10 MiB + 一行 NDJSON = 单响应上限；最小解法：整帧预算 + 非 stream 截断 + 标志位） |
| 大 notebook 的成本上界（V13-2/V13-5） | 未登记 | 🟡 建议加守卫或按 D-054/D-062 的方式登记为"已知行为 + README 数字表" |

### 4. 后续开发建议

- **发布判断**：**修掉三条 🔴（V13-7 / V13-1 / V13-8）之后再发 `0.1.0`**。其余门禁与发布件都是绿的（typecheck / lint / 597·30 / 74·12 / smoke 26/26 / check:package 140+22 / **check:release 12/12** / `lib/` 与重建产物逐字节一致），CI 覆盖的门禁我全部本地复跑通过；但"读一个转义密集的大 notebook 会卡几十秒"（V13-7）、"读/跑大输出会打死客户端"（V13-1）、"崩溃被报成取消"（V13-8）这三条都会让用户以为工具坏了。
- **最该补的四条用例**（每一条都对应一个已确认的零覆盖缺陷，且都已给出可复现构造）：
  1. **转义密集的 2 MiB 字符串**：断言读取耗时/分配有上界（V13-7；现有 `[V13-1]` 的载荷无转义、时间断言在本机对旧代码也不触发）。
  2. **真 SDK 客户端 + 11 MiB 输出**：断言"要么响应 < 8 MiB 且带 `output_truncated`，要么明确失败"（V13-1）。
  3. **后台 run + cell 内 `os._exit(7)`**：断言 `state==='failed'` 且 `error.code==='kernel_died'`（V13-8）。
  4. **`SIG_IGN` 让 interrupt 落地的那条超时路径**：断言 `status==='timeout'`——复核方已验证"出货 PASS / 撤销修复 FAIL"，而现有的 `status==='timeout'` 断言在本机（grace 早退分支）**删掉修复也全绿**（V13-6）。
- **最该补的文档**：README 已知限制里写"单次响应上限（客户端默认 10 MiB）+ 建议用 `cell_indexes` 分批读"；把 §2.1 的体积/耗时表补进去；`COMPATIBILITY.md:27` 的数字（仍停在第十二轮 596/73·11）；`REVIEW-FIX-STATUS.md` **补本轮段落**（它自己的开篇规则要求"上轮报告每个编号都要有一行"，而本轮的 `docs/review/ipynb-mcp-changejob-real-usage-trial.md` 已入库却没被跟踪）。
- **E1–E9 真实第三方客户端矩阵**：仍然 **0/9**。本轮三条 🔴 里最重的两条（10 MiB 帧上限、O(n²) 卡顿）**都只能由"真客户端 + 真 notebook"暴露**——`check:release`/`smoke` 虽然用了真 SDK，但用的是小 notebook 与无转义载荷。把 trial 脚本接到 E1–E9（Claude Desktop / Cursor / Cline 各跑一次并记录进 `COMPATIBILITY.md`）是发布前唯一剩下的非代码门，而它的价值刚刚被证明。
- **`README` 的 `process.env` 安全声明**（v8 起挂着，🟢，可顺手）。

---

## 附录：方法、我自己的三次假信号、局限

**验证分工**
- **主审亲验**：全部门禁（typecheck / lint 含三个自测 / unit 597·30 / integration 74·12 / smoke 26/26 / check:package 140+22 / **check:release 12/12**）；`lib/` 重建比对（68/68）；**6 组自建探针**——① 体积矩阵（33.9/67.8/101.8/203.5 MiB × read/edit/run + `PeakWorkingSet64` 采样 + 768/1024 MB 堆上限）；② cp1252 编码**正反对照**；③ 超时分类与**耗时区分实验**（8 s vs 45 s cell）；④ 跨平台断言核对；⑤ **真 SDK 客户端的帧上限复现**（8 个案例：text 9.0/9.5/9.9/10.2/11、html、json、11 MiB 图片、60×300 KiB、stream 对照）；⑥ cancel 终态快照序列（15 s cell，逐 2 s 采样到 `facts_pending` 归零）。另有 README/CHANGELOG/D-062/DEVIATIONS 数字与 digest 核对、oxlint 自报文件数、`npx oxlint scripts`、`prepack` 存在性、trial 脚本的凭据/发布件/CI 归属核对。
- **两路独立复核（均已并入）**：① 五个新提交的逐条实测——**解析层前后对照**（30.5 MiB 无转义：旧版保留 732 MiB/2082 ms → 新版 0.0 MiB/423 ms；37.5 MiB 转义密集：旧版 OOM exit 134 → 新版 324 MiB/644 ms）、服务器级峰值（read 1413→147 MiB、edit 1797→554 MiB）、`mode='auto'`/`resume`/`kernel list` 的复现、门禁与文档核对；**变异矩阵**（`[V13-1]` 只对逐字符读法红 / `M-D2` 让 error-only 循环红 / cp1252 崩溃双向复现 / **`M-B`、`M-C` 在本机全绿**）；② **v13 diff 的新问题猎取——它先发现了 10 MiB 客户端悬崖（V13-1）**，并在后续报告里给出了 O(n²)（V13-7）与后台 `cancelled`（V13-8）的构造与证据。
- **我对三条 🔴 的独立复现**：V13-1 用真 SDK 客户端做了 8 个案例（含图片与"累计超限"两种它没测的形状）；V13-7 自己造了转义密集的三档样本（413/1611/6362 ms，×3.9/翻倍）；V13-8 用后台 run + `os._exit(7)` 得到 `state=cancelled`/`error.code=cancelled`。三处结论与复核方一致。

**我自己的三次假信号 / 一次方法失误 / 一次判断纠正（记录在案）**
1. **方法失误（最重要）**：我的体积矩阵用**裸 JSON-RPC 读取器**，绕过了 SDK 的 `ReadBuffer`——所以我把 200 MB 的 read/edit/run 都测成"✓ 通过"，却**结构上看不见**客户端侧 10 MiB 的帧上限（V13-1）。这是"断言落在错误的一层"的典型（违反本项目自己的四层阶梯）。**教训**：凡"消费者会怎么收到"的问题，必须用**真消费者**测。
2. **判断纠正**：我在第一稿里把 `v12-timeout-status.test.ts` 判为"在判定发生的那一层断言、可失败"。复核方的变异证据（`M-B` 删掉修复、`M-C` 反转修复，在本机**都全绿**）说明：Windows 走 grace 早退分支，新代码块**不可达**，那条 `status==='timeout'` 断言在本机是**死守卫**。**该判断已纠正**（V13-6），并采纳他们用 `SIG_IGN` 构造的确定性用例（出货 PASS / `M-B` FAIL）。
3. 我最初测到"`timeout_seconds=5` 花了 47.9 s"并已写好机制解释——**代码注释直接否证了它**，干净复测是 11.3 s / 14.3 s。真因是我并行跑 204 MB 探针造成的争用。**已撤回**。
4. 我第一次整跑集成看到 `stale.test.ts` **整文件 FAIL**——同源争用；单独复跑 4/4、无负载整套 74/74 exit 0。**已撤回**。
   （3、4 的共同教训：**重负载探针不能与门禁并行跑**，建议写进 `AGENTS.md §9`。）

**一处与复核方未收敛的分歧**：cancel 的终态语义（V13-6）——子代理实测 `status: "timeout"`，我在同样链路上实测 `status: "error"` + `error.code=cancelled`（`facts_pending` 在 +16 s 归零）。我**没有**把它的结论当既成事实写进报告，而是列为待澄清项并给出双方证据；这一条需要实现方给复现步骤来定。

**局限**
- 我未在 Linux/macOS 上实跑（超时分类的 Linux 分支依据代码与 CI 记录）；未跑真实第三方客户端（E1–E9 仍 0/9）。
- V13-1 的边界我只测到 10.2 MiB 死/9.9 MiB 活（悬崖位置与 SDK 常量 `10 * 1024 * 1024` 一致，但未逐 0.1 MiB 扫）；"客户端可调 `maxBufferSize`"只从 SDK 代码读出，未在第三方客户端上验证。
- V13-2 的"再大一倍会重演崩溃"是外推（我实测 203.5 MiB 不崩，且 1024 MB 堆上限下也不崩）；用来证明"崩溃形态未变"的反例是人为的 2 MiB 堆。

**局限**
- 我未在 Linux/macOS 上实跑（超时分类的 Linux 分支依据的是代码与 CI 记录）；未跑真实第三方客户端（E1–E9 仍 0/9）。
- V13-2 的"再大一倍会重演崩溃"是**外推**（我实测到 203.5 MiB 不崩，且 1 GB 堆上限下也不崩）；我用来证明"崩溃形态未变"的反例是人为的 2 MiB 堆，不是自然到达的边界。
- 体积矩阵用的是合成 notebook（大 source + 9 MiB text + 7 MiB base64 + 20 万浮点 json），与他们的 xgboost 真实文件构成不同，故绝对值不可直接对比（他们的 37.5 MiB → 0.9 GiB，我的 33.9 MiB → 0.57 GiB）。
