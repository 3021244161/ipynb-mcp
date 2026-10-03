# 代码审查整改状态（review fix status）

> **来源**：`docs/review/ipynb-mcp-code-review.md`（第一轮）、`…-v2.md`、`…-v3.md`、`…-v4.md`、`…-v5.md`、`…-v6.md`（第六轮 / 本轮）
> **权威**：`SPEC.md` + `AGENTS.md`。整改只做「实现与被 SPEC 判定不符」的部分；
> SPEC 自身的缺陷按 AGENTS §0 记入 `DEVIATIONS.md` 后按 SPEC 继续。
>
> **每一轮的段落都以一张"该轮报告条目 → 状态"的完整清单开头。** 这是第六轮要求的跟踪机制：
> 前两轮出现过"只列已修项、未修项既不修也不列"（v6 DOC-DROP），读者无法判断某项是被否决、被遗忘还是待办。
> 规则：**上轮报告的每个编号都必须在对应段落里有一行**，状态为 ✅（已修并有验证）/ ⚠️（部分）/ ⬜（未做，写明原因）。
>
> **本文档的 ✅ 只代表"代码里存在该实现 + 有对应的可复现验证"。**
> 第一轮出现 3 处"标 ✅ 但代码里不存在"（第二轮 V1–V3）；第四轮又暴露出两个同类问题：
> ① 把 QUAL-1 判成"已修"而实际只改了另一段（**抽样范围过窄**）；② 个别条目只有"改过"、没有"验证过"。
> 第五轮则出现**漏列**（18 条只列 8 条）。**因此未做或未验证的条目一律 ⬜ / ⚠️ 并写明原因。**
>
> **门禁实测（第六轮整改后）**：`pnpm typecheck` 0 错 / `pnpm lint` 0 警（oxlint + `check-format` + `check-indent`）/
> 单测 **252（全绿）** / 集成 **46/46**（6 文件）/ `pnpm smoke` **19/19** /
> `pnpm pack --dry-run` 133 文件 / 全树 LF / **Linux（WSL Ubuntu + Node 22）单测全绿** /
> **CI 全绿**（run `37136146902`，9 个 job：unit ×7 + integration ×4 中的 9 项；本机无 Python 的 job 按设计跳过 U20 并记录原因）。
> 集成用到的解释器与三平台默认根见 `COMPATIBILITY.md`。
---

## 〇、第六轮（`ipynb-mcp-code-review-v6.md`，本轮）

> 本轮的核查对象是**仓库自己的测试与脚本**（把守卫当被测对象做变异），加上 **CI 首次真跑**的失败
> （GitHub issue #1）。结论：v5 的修复是真的，但新加的写前闸门、缩进检查器与几处测试本身有缺陷，
> 而且状态表**漏列了 10 条**（其中 `INDENT-HOLE` 是 v5 报告的 TOP-3）。

### 6.1 CI 首次运行失败（issue #1，10 个 job 中 8 个失败）

| # | 结论 | 修复要点 | 验证 |
|---|---|---|---|
| **1a** `config.test.ts` 硬编码 Windows 默认 artifact 根 | ✅ | 三个平台各有期望值（表驱动）；**同时修实现**：`artifactDir` 不再无条件走 `path.resolve`——它按**宿主**规则判绝对路径，于是 Linux 上 `C:/x/y` 被拼上了 cwd（`/home/runner/work/.../C:/x/y`）。新增 `absolutePath()` 按**目标平台**判绝对性 | Linux 实测：`[step1]` 三个平台用例全过；另有"外来平台的绝对路径原样保留"用例 |
| **1b** `fence.test.ts` 跨盘用例在 POSIX 上不成立 | ✅ | 改为 win32 独占：非 win32 时先断言**前置条件**（`D:/x` 在 POSIX 上确实是相对路径、会被围栏解析到 root 内），再断言允许——跳过不再是"没查" | Linux 实测通过 |
| **1c** 大小写折叠用例对三平台断言同一结果 | ✅ | 改为按平台的**折叠规则**断言（win32/darwin 折叠、linux 不折叠），三个分支都被真正断言 | Linux 实测通过 |
| **2** 探针标准与 sidecar 真实依赖不一致 | ✅ | 探针改验 `ipykernel` + `jupyter_client`（`SIDECAR_REQUIRED_MODULES`），逐个 `__import__` 并回报缺失模块名；CI 显式 `pip install ipykernel jupyter_client`；**D-038** 登记 §5.2 校验条款不完备 | `tests/unit/interpreter.test.ts` ×5（含缺失模块名/安装命令断言，以及解析 sidecar 源码的漂移守卫）；Mutation：把清单改回只有 ipykernel → 3 条变红 |
| **3** `I15` 的 EBUSY 未映射（真功能缺口） | ✅ | 根因不是映射缺失，而是**测试的相位错误**：快照在独占句柄已经生效之后才读，于是 `readFile` 自己抛 EBUSY（CI 日志栈顶即 `locked-file.test.ts:118`）。快照改到加锁之前；用例拆成**读相位/写相位**两条，写相位用 `beforeWrite` 钩子在"读已成功"之后才取锁（确定性，不靠 race）；`notebook_locked` 的 `detail` 现在带 `errno` | Windows 集成实测：两条都过；`notebook-file.test.ts` 断言 `detail.errno` |
| **4**（P2）macOS 计费 | ✅ | unit 矩阵排除 `macos × node 24`（macOS 只跑声明的 LTS），与 §9 把 macOS 排除出 integration 同一理由 | `ci.yml`；理由写在注释里 |
| 附：unhandled rejection（vitest 报"may cause false positive"） | ✅ | `[I7]` 在 kill **之前**把 rejection handler 挂上（`settled = inflight.then(...)`），消除未观察窗口 | 集成实测：该文件不再有 unhandled error |

### 6.2 第六轮报告条目（完整清单）

| # | 结论 | 修复要点 |
|---|---|---|
| **GATE-5** 🔴 闸门漏检 mime **值类型** | ✅ | 原来只查 `data` 是对象，于是 `display({'text/plain': 5}, raw=True)`（普通用户 cell）写出的文件被 nbformat 拒绝，而 run 报 `write_back.performed=true` 且无 warning。现在检查每个 mime 值必须是字符串或全字符串数组（`application/json` 及 `+json` 例外，nbformat 允许任意值）、`stream.text` 数组元素、`error.traceback` 元素、`execution_count >= 0`。**同时在执行路径归一化**（D-040）：不可表示的值被丢弃并追加 `output_truncated` warning——闸门拦在写入那一刻会让整次 run 的成果全部丢失 |
| **CRASH-1** 🟠 非字符串图片值 → `internal` | ✅ | `display({'image/png': 123}, raw=True)` 曾让 `base64.replace` 抛 TypeError、整个 run 以 `internal` 结束（§4.8 给 notebook_run 列的错误码里没有这条）。现在值先做类型收窄，走既有的 `image_materialize_failed` 路径 |
| **GATE-6** 🟠 `stream.name` 白名单比 nbformat 严 | ✅ | nbformat 的 schema 只要求 `name` 是**字符串**（无 enum），`nbformat.validate` 接受 `"foo"`；原来的 stdout/stderr 白名单拒绝合法文件，进而让该 cell 永久不可编辑。现在只要求是字符串，归一化留给写入方向（`nbformatOutputsOfRaw`） |
| **WARN-CODE-1** 🟠 自造第 12 个 warning 码 | ✅ | `notebook_preexisting_content` 不在 §7 闭集内（AGENTS §11.4 要求先问人类），按 §7 白名单解析的客户端会丢弃这条唯一提示。改用 §7 已有的 `file_changed_externally`（触发条件"检测到外部改动"正是实际情形），规则名与 cell 下标放在 message 里；**`notebook_run` 路径现在也返回它**（此前只写日志，模型看到 `warnings: []`）；失败路径的 `detail.warnings` 也不再恒为空 |
| **INDENT-HOLE** 🟠（v5 漏列） | ✅ | `check-indent.mjs` 读的是 `node.statement`，而 `IfStatement` 只有 `thenStatement`/`elseStatement`——整个 `if` 覆盖是死代码（脚本是 `.mjs`、不进 tsconfig，类型检查抓不到）。重写为：`then`/`else`/`switch`（case 标签与 case 体分别判）/`try`/`catch`/`finally`/四种循环/函数·方法·箭头·访问器体，加**每次运行都跑的自测**（11 个构造各错一处 + 1 个干净样本），加"语句必须独占一行"（这条立刻抓到两处被早前批量编辑合并的 `describe(... {  it(...`）。用它修好 5 个文件里 68 行真实错位 |
| **NEW5-REPRO** 🟠（v5 漏列） | ✅ | ① `RunStore.settle()` 成为终态**唯一写者**（`notebook_run_cancel` 与后台任务都经它，先到先得），终态不再被二次翻转；② `progress.completed` 在成功路径按 `executed.length` 收口（原来会停在 total-1，与 `executed` 自相矛盾）；③ 写回前**复查 abort**（stale 分析可能耗时，期间的取消必须走终态而不是产出正常结果） |
| **TST-CI** 🟠（v5 漏列） | ✅ | 同上 I7 的 unhandled rejection 修复；I15 的相位错误也属同类（用例自己抛错却记成功能缺陷） |
| **NBFORMAT-GATE-SILENT** 🟡（v5 漏列） | ✅ | `[FID-1]`/`[FID-3]` 在解释器缺 nbformat 时改为 `it.skip`（记录原因），而不是让断言静默消失——否则"外部权威"退化成"什么也没查" |
| **SCOPE-DEFAULT** 🟡 | ✅ | `move_cell` 不再进闸门 scope（纯重排不改 cell 字节）：`ChangedCell.content_changed` 区分"改写"与"重排"，`edit.ts` 按它过滤。scope 缺少默认值时的行为（`undefined` = 整份文档）保留给"创建文档"场景，调用点只有两个且都显式传入 |
| **SCOPE-REFUSE-HINT** 🟡 | ✅ | 拒绝的 `detail` 现在带 `pre_existing: true/false` 与 `hint`（指向 `clear_outputs`/`set_cell_type` 这条唯一出路）。判定方式：把**写前的文档**（`originalDoc`）也用同一 scope 跑一遍闸门，规则与 cell 相同即视为"本来就存在" |
| **SCOPE-SUCCESS-INVALID** 🟡 | ✅ | README 明说：保留历史内容的代价是**成功写入后文件仍可能不过 `nbformat.validate`**，本工具不会替你重写历史 |
| **NEW-2** 🟡（v5 漏列） | ⚠️ 部分 | `timeout_seconds` 用 `.int()`。广播枚举**保留在工具层**：schema enum 会让 SDK 抢先返回协议错误，而 U27 要求枚举违规返回 `invalid_arguments`——两者冲突，需 SPEC 裁决（列为剩余事项） |
| **DEP-2** 🟡（v5 漏列） | ✅ | `src/server.ts` 用 `createRequire` 读 `package.json` 的 version；单测 + `pnpm smoke` 各一条断言（19/19 里的"the server reports the version in package.json"） |
| **QUAL-2** 🟡（v5 漏列） | ✅ | `isAbortCause` 统一到 `core/errors.ts`（唯一实现），`edit.ts` 改为 re-export，`run.ts` 删掉逐字同构的副本 |
| **FID-6 注释** 🟡（v5 漏列） | ✅ | 传输层注释改为与收缩后的常量一致；sidecar 里 `SHELL_REPLY_BUDGET_SECONDS`/`INTERRUPT_GRACE_SECONDS` 成为具名常量并镜像到 `sidecar-transport.ts`（含"为何仍要计入预算"的说明） |
| **NEW-6** 🟢（v5 漏列） | ✅ | stderr 尾巴只在 transport 确实失联时附带，超时路径不再无条件挂上 |
| **TST-2/3/4/5**（v5 漏列） | ⚠️ 三条已修、一条部分 | TST-2 `acquireRun` 调用点覆盖（新用例）、TST-3 `[I18b]` 扩到三 cell、TST-4 工具层 `markdown_invalid` 真写守卫：均已补。TST-5：U20 的 venv 改到 `os.tmpdir()` 并清理（不再落仓库），但单测并行度保持默认——六个文件各自用独立临时目录，串行只会让单测慢一倍（理由记在 `COMPATIBILITY.md`） |
| **DOC-DROP** 🟡 | ✅ | 本文件头部的规则 + v5 的 18 条覆盖表 + 四条被 v4/v5/v6 证伪的旧 ✅ 改为撤回；第六轮条目即本节 |
| **DEV-CLAIM-FALSE** 🟡 | ✅ | D-033 的数字改为实测口径（`timeout_seconds` + 中断宽限 + 收尾 ≈ +10 s；2 s 预算实测 12.4 s），并写明 kernel 关闭是异步的 |

### 6.3 本轮新增的验证能力

- **Linux 实跑**（`scripts/linux-check.sh`）：本机是 Windows，而 CI 的失败全在非 Windows 上。该脚本把 tracked 文件复制到 WSL 的 Linux 文件系统、按 lockfile 安装、跑 typecheck/lint/单测。本轮四次 Linux 全绿（最近一次 **239 passed + 1 skipped，20 文件**），CI 的两个 P0 因此有本机可复现的验证，而不是"改完希望它对"。
- **缩进检查器自测**：`check-indent.mjs` 每次运行都会对 11 个构造的错位样本 + 1 个干净样本做自测，"某个构造不再受检"会直接失败——这正是 `if` 覆盖死掉两轮却没有信号的原因。
## 〇-A、第五轮（`ipynb-mcp-code-review-v5.md`）—— 完整条目清单

> 第六轮指出这一轮只列了 8 条、漏了 10 条（其中 INDENT-HOLE 是它 TOP-3 的第 3 条）。
> 下表补齐全部 18 条及其**本轮（第六轮）的处置**。

| v5 条目 | 五轮状态 | 六轮处置 |
|---|---|---|
| GATE-1 闸门审整份文档 | ✅ 已修 | ✅ 复验通过（六轮用同一复现复跑） |
| GATE-2 比 nbformat 严 | ✅ 已修 | ✅ 复验通过 |
| GATE-3 `execution_count` 类型 | ✅ 已修 | ✅ 复验通过 |
| FRAME-1 守卫恒真 | ✅ 已修 | ✅ 复验通过（两个变异各命中一条断言） |
| **INDENT-HOLE** `if` 体不受检 | ⬜ **漏列** | ✅ **本轮修复**：`check-indent.mjs` 重写（`thenStatement`/`else`/`switch`/箭头/访问器 + 自测 + "语句必须独占一行"），并用它发现并修好了 `run.ts` 等 5 个文件里 68 行真实错位 |
| **NEW5-REPRO** 终态可二次翻转 | ⬜ **漏列** | ✅ **本轮修复**：`RunStore.settle()` 单写者 + `progress.completed` 收口 + 写回前 abort 复查 |
| **TST-CI** 用例全绿但 exit 1 | ⬜ **漏列** | ✅ **本轮修复**：`settled = inflight.then(...)`，在 kill 之前挂上 handler；I15 的相位错误同时修掉 |
| **NBFORMAT-GATE-SILENT** 校验静默消失 | ⬜ **漏列** | ✅ **本轮修复**：`[FID-1]`/`[FID-3]` 在 nbformat 不可用时用 `it.skip` 记录原因，而不是删掉断言 |
| **NEW-2** 值级校验漂成协议错误 | ⬜ **漏列** | ⚠️ **部分**：`timeout_seconds` 用 `.int()`（类型级）。广播枚举**保持工具层**——schema enum 会让 SDK 返回协议错误，与 U27 要求的 `invalid_arguments` 冲突，需 SPEC 先裁决（见剩余事项） |
| **NEW-6** stderr 尾巴挂在任意失败上 | ⬜ **漏列** | ✅ **本轮修复**：只在 transport 确实失联时附带，超时路径不再无条件附加 |
| DEP-2 版本双真源 | ⬜ **漏列** | ✅ **本轮修复**：`server.ts` 从 `package.json` 读版本（`createRequire`），新增单测 + smoke 断言 |
| QUAL-2 两份同构 `isAbortCause` | ⬜ **漏列** | ✅ **本轮修复**：统一到 `core/errors.ts`，两处 import |
| TST-2 `acquireRun` 调用点零覆盖 | ⬜ **漏列** | ✅ **本轮修复**：`tests/unit/acquire-run.test.ts` 用包装 registry 断言真的调用与释放 |
| TST-3 `[I18b]` 单 cell | ⬜ **漏列** | ✅ **本轮修复**：用例扩展到三 cell（中间 cell 未执行） |
| TST-4 工具层 `markdown_invalid` 守卫 | ⬜ **漏列** | ✅ **本轮修复**：`[U4]` 真写路径用例断言错误码与文件未变 |
| TST-5 U20 venv 落点/单测 config | ⬜ **漏列** | ⚠️ **部分**：`analyze-op` 的 venv 改到 `os.tmpdir()`（不再落仓库、afterAll 清理）；单测并行度**保持默认**，因为六个测试文件都用独立临时目录（`fileParallelism:false` 会让单测慢一倍且无收益），原因记在 `COMPATIBILITY.md` |
| FID-6 旧公式注释 | ⬜ **漏列** | ✅ **本轮修复**：注释改为与收缩后的常量一致；`SHELL_REPLY_BUDGET_SECONDS`/`INTERRUPT_GRACE_SECONDS` 在 sidecar 里成为具名常量并镜像到 transport |
| DOC-FALSE 余项 | ⬜ **漏列** | ✅ **本轮修复**：D-033 的数字改为实测口径（`timeoutMs` + 中断宽限 + 收尾开销 ≈ +10 s，2 s 预算实测 12.4 s）、关闭是异步的 |

### 5.1 五轮逐条闭环（原文保留）

> 该轮的核查方式是"**把仓库自己的新测试当被测对象做变异实测**"，于是立刻抓到两件事：
> 上一轮的 🔴 修复是**真的**（写回合法、分帧 39 ms、超时提前返回，逐条有变异证据），
> 但新加的写前闸门**审错了范围**，以及本轮唯一的性能守卫**没有判别力**。

### 5.2 🔴

| # | 结论 | 修复要点 | 验证 |
|---|---|---|---|
| **GATE-1** | ✅ | 闸门原来校验**整份文档**，于是它同时审了用户的**输入**：文件里任何一处它不认可的历史输出（第三方工具写的 `display_data` 缺 `metadata`、`update_display_data`）都会让**所有**编辑与运行永久失败于 `selfcheck_failed`，错误位置还指向调用方从未触碰的 cell。现在闸门的范围 = **本次写入负责的 cell**（edit 传 `changedCells`，run 传 `executedCellsSet`）；历史内容原样带过，并以**warning**（`notebook_preexisting_content`，走 `notebook_run` 同一条 warnings 通道 + 日志）告知模型，绝不阻止写入 | `[GATE-1]` ×3（无关 cell 可编辑且 quirk 原样保留 + warning 到达调用方；被触碰的 cell 仍拒绝；清空该 cell 输出则**允许**——闸门不惩罚一个刚刚修好问题的写入）。**已做变异验证**：把 `touchedCellIndexes` 去掉，第一条立刻变红 |
| **FRAME-1** | ✅ | `[NEW-3]` 的计数器**一次都没被调用**：它把 `indexOf` 挂在父 Buffer 的**自有属性**上，而喂给 framer 的是 `observed.subarray(...)`——`subarray` 不继承自有属性，于是 `0 <= cap*1.1` 恒真，二次实现（实测 36 s）也能全绿。计数器改挂 `Buffer.prototype`（`try/finally` 还原），并加 `expect(calls).toBeGreaterThan(0)`（计数器没跑就必须失败）与一条墙钟上界 | 变异实测：把 `push` 换成**行为等价**的二次实现（保留全部 cap/CRLF/pendingBytes 语义），其余 10 条用例照旧全绿，只有 `[NEW-3][FRAME-1]` 变红（`expected 35988 to be less than 5000`） |

### 5.3 🟠 / 🟡

| # | 结论 | 修复要点 |
|---|---|---|
| **GATE-2** | ✅ | 闸门把 4.5 的 `output_type` 白名单当永久真理，而 `nbformat.validator` 对 `nbformat_minor` 高于本地 schema 的文件会放宽 `additionalProperties` 并接受 `unrecognized_output`。现在 `nbformat_minor > 5` 时未知 `output_type` 不判错（与权威对齐，消除"拒绝合法文件"）。未知 `cell_type` 仍是 `parse_failed`——**读不了**而不是"读了不写"，这条不同边界在用例里明确记录 |
| **GATE-3** | ✅ | `execute_result.execution_count` 原来只查**存在性**，于是 `"3"` 被放行。现在要求 integer 或 null。README 的措辞同时收窄：闸门是"本实现可能写坏的形状"，**不是合法性判定** |
| **TIMEOUT-2** | ✅ | README 两句与实测不符，已改：① 关闭 kernel 是**异步**的——响应先返回，进程可能要到被打断的 cell 自然结束才消失（秒级到分钟级，期间管理命令已报告无 kernel，不会留孤儿）；② 超时响应是 `timeout_seconds` + **约 10 s**（实测 2 s 预算 → 10.2 s），不是"加几秒"。D-033 补记"关闭与返回解耦" |
| **TEST-1** | ✅ | `fixtures-valid.test.ts` 的 "every notebook fixture" 是**硬编码两本**。文件改成两层并如实命名：① 代表性字面量（同时过自家闸门与真 nbformat）；② 静态扫描 `tests/**/*.ts`——但它只保证**一条**规则（kernelspec 必须有 `display_name`），因为"从测试源码里提取任意 notebook 字面量"是另一件需要解析器的事，半吊子提取器只会制造同一种虚假信心。扫描改为按大括号配对读取整个对象并先剥离注释（第一版会匹配到自己注释里的 `kernelspec: {`） |
| **SMOKE-1** | ✅ | smoke 补三个缺口：① 加一条 CAS 锚定的 `notebook_edit`（它此前**从没调用过 edit**，所以"编辑被闸门挡住"这类故障它看不见）；② 加一条 `timeout_seconds=2` 的 `time.sleep(30)` cell，断言 `exec_timeout` **且**响应及时（< 25 s）**且**该 cell 保持运行前状态；③ round-trip 改成内容断言（原先只数条数，对"内容错了但条数对"是绿的）；另加 `kernel shutdown` + `status` 断言无残留。11 → **18 项** |
| **MISC-2** | ✅ | 两处注释修正：`cell_selector` 上限对应的编号改为 v4 **NEW-2**；删掉"27 s"那句（属未发布的中间设计，读者在历史提交里找不到） |
| **MISC-3** | ✅ | `#normCache` 的失效改为按**规范化值**匹配（并保留字面拼写匹配），于是同一文件其他拼写的陈旧条目也被清掉——被重指向的 symlink 不再可能留下会让两个身份碰撞的映射 |
| **TEST-2/TEST-3/TEST-4 的精度提示** | ✅ | `nbformat-validator.ts` 的注释改为准确描述（`as_version=4` 会**升级**后再校验，因此它校验 4.5 的契约而不是字节级）；`[W1]` 第二条补注它走的是"延迟数组耗尽"分支 |

### 5.4 本轮的方法学收获（已写进 AGENTS §9）

评审把**测试当被测对象**做变异，比评审读测试名有效得多。本轮因此把"守卫必须自己证明有判别力"变成显式规则：新增/修改任何守卫型断言时，必须能指出**在什么变异下它会红**；做不到就说明它守不住任何东西。`[GATE-1]`、`[NEW-3][FRAME-1]` 都按这条做了变异实验并记录在案。

---
## 〇-B、第四轮（`ipynb-mcp-code-review-v4.md`）

> **门禁实测（第四轮整改后）**：`pnpm typecheck` 0 错 / `pnpm lint` 0 警 / 单测 227 / 集成 44（6 文件）/
> `pnpm smoke` 11/11 / `npm pack --dry-run` 133 文件 / 全树 LF。

> 该报告的核查方式变了：主审起了**真 stdio server + 真 SDK 客户端 + 真实历史 notebook** 做 E2E，
> 并用 **Python `nbformat.validate`** 当外部权威。结论是 v3 的整改**大部分真实有效**，但发现了一个
> 四轮评审都没抓到的 🔴 —— 原因值得记住：**写入方与测试用同一套私有字段名**，于是整套用例都在
> 验证一个错误的世界观。本轮的整改因此分成"修问题"和"修发现问题的能力"两部分。

### 4.1 🔴 / 系统性

| # | 结论 | 修复要点 | 验证 |
|---|---|---|---|
| **FID-1** | ✅ | `cell.outputs = [...result.result.rawOutputs]` 把 **sidecar 私有形状**（`outputType`）直接写进文件：**每个执行过的 cell 都让 notebook 变成非法 nbformat**，JupyterLab/nbconvert 会拒绝或丢输出，本工具也读不回自己刚写的内容，而终态仍报 `write_back.performed: true` 且无任何 warning。新增 `core/outputs.ts` 的 `nbformatOutputsOfRaw()`（写入方向的边界转换，含 nbformat 只在 `execute_result` 上要求的 `execution_count`），两条写回路径统一走它 | 集成 `[FID-1]`：真 notebook_run → **真 `nbformat.validate` 通过** + 读回 round-trip；`scripts/e2e-smoke.mjs` 11/11（**已做变异验证**：改回旧代码 → nbformat 校验、字段名、execution_count 三项同时变红） |
| **FID-3** | ✅ | `set_cell_type` → markdown 时把 `execution_count` 置 `null` 而非**删除**。nbformat 禁止 markdown cell 出现该键（`Additional properties are not allowed`），而 `serializeNotebook` 只为 code cell 填它，于是这个 `null` **永久留在用户文件里** | 单测 `[U9]` ×2（断言 `'execution_count' in cell === false`）+ 集成 `[FID-3]` 走真工具路径后过校验器 |
| **FID-4** | ✅ | **加一道结构自检**：`selfCheckNotebook` 除重新解析外，还检查 nbformat 结构规则（非 code cell 不得有 `outputs`/`execution_count`、`output_type` 必须存在、`stream`/`error`/`execute_result`/`data` 的必要字段）。违反 → `selfcheck_failed` 中止写入。这让"不会静默改坏"变成对**结果**的承诺，而不只是对解析器的承诺 | 单测 `[FID-4]`（协议形状与 markdown 残留各一例）；它当场抓出 3 个**本身就不合法**的测试 fixture（stale 两条 + `nbformat-validator` 报的 `display_name` 缺失） |
| **QUAL-1** | ✅ | 同类事故第三次出现（整块缩进浅一级），我上一轮**方法错误地**判为已修。这次不再手改：新增 `scripts/check-indent.mjs`，用 TypeScript parser 校验"块内直接语句同列 + 闭合括号与开启行列相同"，接进 `pnpm lint`；并用同一个 AST 驱动把 `src/run.ts` 全部块收敛到一致（含 7 个语句 + 6 个闭合括号） | `pnpm lint` 现在会跑它，全仓 0 违规；该检查器正是发现并修正本轮这处缺陷的工具 |

### 4.2 🟡

| # | 结论 | 修复要点 |
|---|---|---|
| **FID-2** | ✅ | `rawOutputsOfCell` 对未知 `output_type` 曾**静默丢弃**，于是 read 会说"这个 cell 没有输出"——一个假陈述，也掩盖了 FID-1。现在映射为 `unsupported`（诚实报告"读不懂"而不是"没有"） |
| **FID-5** | ✅ | `notebook_run_status` 把内部 camelCase 的 `writeBack` 原样透出，同一字段在 `notebook_run` 是 `backup_path`、在 status 里是 `backupPath`。统一为 `backup_path` |
| **FID-6** | ✅ | sidecar 判定 `timeout` 后还去等一个**不可能到达**的 `execute_reply`（kernel 还在跑那个 cell），30 s 白等：实测 `timeoutMs=3s` 花掉 38 s。改为立即返回；传输层余量随之收缩（D-033）。**并如实披露**：Windows 上 `interrupt_kernel()` 需要控制台事件，stdio 服务没有控制台，`time.sleep` 类 cell 收不到中断——超时靠 §4.7 规则 6 的关闭 kernel 真正回收 CPU |
| **ROB-10 补完** | ✅ | `#failureDetail()` 原来**二选一**返回 stderr 或 exit code，于是"pyzmq 崩溃"这类既有 stderr 又有退出码的场景把符号化结果丢掉了（主审实测"符号化 0% 有效"）。改为两半都给；sidecar 自报的错误在 child 已死时也带上退出事实 |
| **NEW-1** | ✅ | v3 的 strict schema 让**工具层白名单变成不可达代码**（删掉它测试仍全绿）。改为 passthrough + 工具层拒绝，既满足"必须拒绝"又返回 SPEC 指定的 `invalid_arguments`；用例对六个工具全覆盖并断言 `detail.reason`（**已做变异验证**） |
| **NEW-3** | ✅ | 分帧第三轮返工：v3 = 列表 + 延迟拼接（扫描仍 O(L²)）；v4 = 游标 + 逐块 skip（**skip 循环自身 O(chunks²)**）+ `Buffer.concat` 增长前缀（8.6 GB 拷贝）。最终改为**单个倍增缓冲**，并保持"永不回看已扫描字节"：每字节最多被拷两次、扫一次。期间我自己引入的两个回归（每行分配缓冲 → 27 s；`indexOf` 绝对偏移当相对用）都由用例抓出后修正 | 用例 `[NEW-3]` 以"扫描字节数 ≤ 1.1×数据量"断言算法而不是墙钟时间；`[A21]`/`[D7]`/byte-by-byte 等 10 例全绿 |
| **NEW-4** | ✅ | `#norm` 每次调用都做 `realpathSync`，且**每个 session 一次 + 查询一次** → N cell 的 run 做 N 次同步 stat 链。加记忆化，并在 session 摘除时失效 |
| **NEW-2** | ✅ 部分 | `timeout_seconds` 加 `.int()`。**广播类枚举没有改成 schema enum**：U27 要求枚举违规返回 `invalid_arguments`（工具错误），而 schema enum 会让 SDK 抢先返回协议错误——两者不可兼得，选了 SPEC §4.1.12 指定的形态（值仍由工具层校验并列出合法集合） |
| **NEW-5** | ⬜ 未做 | 属 SPEC 缺口（终态可被二次翻转 / 与 §4.8 顺序语义冲突），本轮未改动终态语义：它是"建议补 SPEC"的条目而非已证实的缺陷，且改动它会触碰 §4.8 的对外契约。已列入下方剩余事项 |
| **SEC-TOCTOU** | ✅ | connection file 改用 `tempfile.mkstemp()`（原子创建、0600、名不可预测），仍钉在 OS 临时目录并负责清理（D-034） |
| **DEP-1 降级路径** | ✅ | 失败启动也清理（`wait_for_ready` 抛错时 `entry.shutdown()`；`BaseException` 路径单独 `remove_connection_file()`）。本仓测试此前已攒下 16 个残留，修复后实测不再新增 |
| **DEP-2/DEP-3 文档不实** | ✅ | 首次把**规则落到 CI 能执行的地方**：`prepack` 从 `pnpm build` 改为 `tsc -p tsconfig.json` 并实测（删掉 `lib/` 后 `npm pack --dry-run` 重建成功）；`REVIEW-FIX-STATUS` 的门禁数字每条有出处，并在 §四 写明"未做项不标 ✅" |
| **QUAL-6 残留** | ✅ | `backup.ts` 的 `onRetentionError` 仍带 `[ipynb-mcp] warn` 前缀 → 与兜底 sink 双前缀。已去掉 |
| **H-2/H-3/H-6/H-7** | ✅ | `probe-framer.mjs` 等根目录残留清除；`.gitignore` 补 `ipynb-mcp-*.json`/`__pycache__`/`commit-msg.txt`；全树 LF（`git ls-files --eol` 0 CRLF / 0 mixed） |
| **本轮零依赖** | ✅ | 新增的两个检查器（`check-indent.mjs`、`e2e-smoke.mjs`）与 `nbformat-validator.ts` 只用已有的 TypeScript 与 SDK —— 未新增任何依赖（AGENTS §11） |

### 4.3 "发现问题的能力"（v4 的主要交付）

四轮评审的教训不是"又漏了一个 bug"，而是**评审与测试共享了错误的前提**。因此本轮把三件事固化进 `pnpm lint` / `pnpm test*`：

1. **外部权威判定合规**：`tests/integration/nbformat-validator.ts` 起子进程跑 Python `nbformat.validate`；`[FID-1]`、`[FID-3]`、`fixtures-valid.test.ts` 都用它，并跳过（带原因）而不是假装通过。
2. **fixture 也要合规**：`fixtures-valid.test.ts` 对每个 notebook 字面量同时跑"自己的结构检查"与"真 nbformat"，另有零依赖静态检查禁止新增缺 `display_name` 的 kernelspec。
3. **真客户端冒烟**：`scripts/e2e-smoke.mjs`（`pnpm smoke`）拉起 `lib/bin.js`，用 SDK Client 走完整 JSON-RPC，断言 11 项（含 nbformat 校验与 round-trip），**并已用变异验证**它能在 FID-1 复现时变红。

## 〇-C、第三轮（`ipynb-mcp-code-review-v3.md`）

> 该报告对 v2 的闭环核查结论是"四道门禁全部真实通过、逐字吻合"（本项目第一次），
> 同时给出 5 条 🟠 与若干 🟡/🟢。逐条状态：

### 3.1 🟠 项

| # | 结论 | 修复要点 | 验证 |
|---|---|---|---|
| **ROB-8** | ✅ | 四条收口：① 写回窗口内的取消改走与中途取消**同一条终态路径**（`abortedRunError`），detail 带 `executed`/`write_back`；② abort 判定改用**合并后**的 signal；③ `kernel_not_available` 与 `kernel_died` 同等对待；④ 目标 cell 前校验承载它的 session 未被换掉（仅 `resume`） | 集成 `[ROB-8]`（取消落在写回窗口，断言 `write_back.performed` + 盘上 `execution_count`，**已做变异验证**：改回旧实现即变红）；[R3]/I16 回归 | 
| **ROB-2** | ✅ | 超时路径改为**先 `shutdown()` 后摘 session**（原顺序让 `shutdown` 查不到 session 直接返回 → 关闭从未发生、kernel 泄漏） | 用例 `[ROB-2]` ×2（断言 `shutdownKernel` 恰被调用一次 + 无残留 session + 下次是 `kernel-2`；**已做变异验证**） |
| **ROB-11** | ✅ | `exec_cell` 余量改为 `timeoutMs + sidecar 最坏耗时 + 10s`；"超时回收进程树"限定为只对 `exec_cell`（`kernel_status`/`ping`/`analyze` 超时不再连坐其他 notebook） | D-027 登记 + 常量按 sidecar 预算命名；现有 I5/I18/W3（依赖 `exec_timeout` 语义）全绿 |
| **DEP-1** | ✅ | sidecar 把 connection file **钉在 OS 临时目录**并在三个出口删除 | D-023 登记；实测：改造后新起的 kernel 在仓库根与 `%TEMP%` 均无残留（旧行为会各留一份） |
| **QUAL-8** | ✅ | `notebook_run_cancel` 立即置终态 + 不再 sleep；`interrupt` 失败只记 warn | `src/mcp/tools/run-status.ts`；终态语义与 §4.8 的响应枚举一致 |
| **ARCH-1** | ✅ | nbformat 输出形状下沉到 `core/outputs.ts` 的 `rawOutputsOfCell`（`hasStableCellIds` 一并下沉）；顺带修掉**数组形式 `data` 值被静默丢弃** | `grep` 确认 `src/mcp/*` 不再解析输出形状；U15/U16/U17/U21/U21b 回归 |

### 3.2 🟡 项

| # | 结论 | 修复要点 |
|---|---|---|
| **ROB-6** | ✅ | 复用键/run 锁/路径查找统一 `realpath` + 折叠（`canonicalPath` 可注入，生产注入 `realpathSync`）；用例 `[ROB-6]` ×2 |
| **ROB-5** | ✅ | `cell_indexes` 去重 + 限长 1000（工具层拒绝，保持 `invalid_arguments`）；用例 `[ROB-5]`（200 次重复 → 只渲染 1 个 cell；1001 项 → 拒绝） |
| **ROB-13 / ROB-14** | ✅ | 探活说死了也**先尝试关闭**再摘除；`liveKernel` 一次探测的结果传给 `getOrCreate`（`knownAlive`），不再二次探测；用例 `[ROB-13]`/`[ROB-14]` |
| **ROB-10** | ✅ | sidecar stderr 进入环形缓冲（20 行）并随 `kernel_died` 的 detail 返回；stderr 转发从 debug 提升为 warn；退出码带 `STATUS_*` 符号名；D-030 登记"候选链只在解析期降级" |
| **ROB-12** | ✅ | 按 D-031 如实登记：异常退出后不再按 pid 补刀（子进程已退出，pid 复用有误杀风险；实测无孤儿） |
| **QUAL-1** | ✅ | 修掉两处缩进错乱；新增零依赖 `scripts/check-format.mjs`（tab / 行尾空白）并接进 `pnpm lint`。未加 prettier：新增依赖需先问人类（AGENTS §11），且检查故意不做可疑的"块嵌套启发式" |
| **QUAL-2** | ~~✅~~ **撤回（v4 证伪：`isAbortCause`/`isAbortError` 仍是两份逐字同构）。六轮已真修，见 §〇 表** | 删除 7 处死导出/重复实现（`isAbortCause` 当时并未合并）；`sidecar-transport` 改用 `isSidecarResponse`；`isAbortCause` 收敛为一份（run.ts 用 `isAbortError` 引用它） |
| **QUAL-3** | ✅ | 删除 `read.ts` 的死变量 `imageBudget`；`tsconfig` 打开 `noUnusedLocals`/`noUnusedParameters`（随即发现并清掉 2 处未用参数） |
| **QUAL-6** | ✅ | `atomic.ts` 的三处 warn 文案去掉硬编码 `[ipynb-mcp] warn` 前缀，前缀由兜底 sink 负责（消除了双前缀双级别） |
| **QUAL-7** | ✅ | 删掉恒真的 `else if (… || true)` 分支；`lastTouchedCell`（每次 op 重复 `locate()` 的线性查找）随死分支一起删除；`truncateText` 不再对同一源码算两遍；`defaultSpecName(_deps)` 改为常量 |
| **QUAL-10** | ✅ | 修掉 5 处与代码不符/已失效的注释（`run.ts` 头、`edit.ts` "step 5"、nbformat 形状声明、`lastTouchedCell`、registry 并发说法） |
| **SEC-1** | ✅ | 六个工具 schema 改为 **strict**：未知参数名不再被静默剥离（原状：对外声明 `additionalProperties:false`，实际静默丢弃）。代价（协议错误而非工具错误）按 D-024 登记；用例 `[SEC-1]` |
| **SEC-2** | ✅ | `runTool` 不再把 stack 放进模型可见的 `detail`（改为 `error: name: message`），stack 经 logger 落 stderr；用例见 U24 系列 |
| **PERF-1** | ✅ | NDJSON 分帧改分块累积：64 MiB 单行实测 **9333 ms → 1884 ms**（旧实现用 `git stash` 回放同机对比） |
| **PERF-2** | ✅ | 图片按 base64 长度下界在解码前拒绝（省解码 + SHA-256）；`outputs.test.ts` 的边界例全绿 |
| **PERF-3** | ✅ | `analyzeStale` 改一次线性扫描（原为每 cell 回扫 + 嵌套 `includes`）；`run.ts` 的 code-index 映射改 Map；`stale.test.ts` 11 例全绿 |
| **ARCH-2** | ✅ | 解释器探测缓存加 TTL（成功 30s / 失败 1s）：按提示安装 ipykernel 后无需重启服务；D-022 登记 `kernel/interpreter.ts` |
| **ARCH-3** | ✅ | 写锁键用调用方的 `options.platform`，不再读进程全局 |
| **ARCH-5** | ✅ | `AGENTS.md` §4 的树按 `git ls-files src` 重写（补 `run.ts`/`hash.ts`/`kernel/interpreter.ts`/`fs/notebook-file.ts`/`mcp/context.ts` 等），并注明以实际结构为准 |
| **ARCH-6** | ⚠️ 部分 | 本轮做了**风险消除**的部分：两条终态路径合并为 `abortedRunError`/`failedRunError`（ROB-8 的根因）；`runNotebook` 的其余拆分（`executeCells`/`materializeRunImages`/`computeStaleReport`）未做——属纯结构重构，AGENTS §10 禁止"顺手重构"，且当前无行为风险点 |
| **ARCH-4/ARCH-7** | ⬜ | 未做，理由见 §三「剩余事项」：`applyEditOps`/`runNotebook` 的进一步拆分与 `shouldReturnImages` 的层次迁移都属重构，随下一次接口变更批次一起做 |
| **DEP-2/DEP-3/DEP-6** | ~~✅~~ **DEP-2 撤回（v4 证伪：版本号仍是硬编码字面量）**；DEP-3/DEP-6 属实 | `server.ts` 版本号对齐 `package.json`；`prepack` 改 `tsc -p tsconfig.json`；CI 去掉与 `packageManager` 冲突的 `version: 11` |
| **DEP-1（文档计数）** | ✅ | COMPATIBILITY 与本文件的计数改为实测值（并注明"按文件给数字"的原因） |
| **TST-1/TST-5/TST-6/TST-7** | ✅ | 见 CHANGELOG「Tests」段：解释器回退在 CI 上直接失败、U20 区分"环境不足"与"回归"、I9 改为可证伪断言、I12 覆盖 edit+run、`[TST-7]` 补读路径映射（**已做变异验证**） |
| **TST-2/TST-3/TST-4** | ~~✅~~ **撤回（v4/v5/v6 三轮均证伪：`acquireRun` 调用点零覆盖、`[I18b]` 单 cell、工具层 `markdown_invalid` 无真写守卫）。六轮已真修，见 §〇 表** | 已在 v2 轮完成（本报告确认）；本轮未回退 |
| **H-2/H-3/H-5/H-6/H-7** | ~~✅~~ **撤回（v4 证伪：`probe-framer.mjs` 等根目录残留仍在）。六轮已真修** | `.gitattributes` 生效（0 CRLF / 0 mixed）；`scripts/` 入库；`__pycache__`、`tmp*.json` 等已 ignore |
| **DOC-1 ~ DOC-6** | ✅ | 新增 D-022~D-031（含 D-028 的"取消信号取舍"与 D-024 的"未知参数"取舍）；README 补四条已知限制；本文件重写门禁数字 |

### 3.3 v3 报告对 v2 的核查异议

- **V3/A31 被标"修法有副作用"**：其副作用（写回窗口内取消丢失 detail）已按 ROB-8 修好，两条写回的信号取舍按 D-028 登记。
- **V4/A23 被标"部分"**：按 D-031 如实登记为"不再按 pid 补刀"，理由与实测（无孤儿）写在条目里，不再声称字面实现。

## 一、第二轮（`ipynb-mcp-code-review-v2.md`，评级 C：需返工）

### 1.1 P0 回归（R1–R3）

| # | 结论 | 修复要点 | 验证 |
|---|---|---|---|
| **R1** | ✅ | `getOrCreate` 对"会话在、transport 已死"直接 `#forgetTransport` + 摘除会话，交给 `#transportFor` 重建；`shutdown` 对死 transport 变为幂等清理（不再抛 `kernel_died` 并留住会话）；`sidecar-transport` 的 `exit`/stdio `error` 现在通过 `onExit` 通知 registry 清理其承载的全部 session | `tests/unit/kernel-registry.test.ts` [R1] ×4（含"下一次 getOrCreate 成功"与"onExit 摘除会话"）；集成 I7 补"后续 run 不再失败" |
| **R2** | ✅ | 回收循环逐 session `try/catch` + `warn`（`reclaimIdle` 公开以便确定性驱动）；`process.on('unhandledRejection')` 从 `exit(2)` 降级为记 error 后继续服务 | [R2] ×2（失败不冒泡 + 成功回收）；`src/bin.ts` 注释说明 SPEC §5.1 的退出码 2 只针对启动期 |
| **R3** | ✅ | 三条收口：① `run.ts` 在途 exec 抛 `kernel_died` 时，把**已完成 cell 写回**并放进错误 detail（此前直接 throw，一个都不写）；② `#handleKernelDied` / sidecar `onExit` 通过 `onRunAbort` 通知在途 run；③ 通知只在**目标 cell 已开始**后生效，避免"上一个会话的迟到死亡"打断刚启动的 run | 集成 [R3]（真杀 kernel，断言 `write_back.performed === true` + 已完成 cell 落盘 + 在途 cell 未落盘）；[R3] ×3 单测（三种触发源）；集成 I16 |

### 1.2 虚报（V1–V4）—— 本轮补齐实现

| # | 结论 | 修复要点 | 验证 |
|---|---|---|---|
| **V1/A20** | ✅ | 三条 stdio 流全部挂 `error` 监听；写前检查 `stdin.destroyed` / `writableEnded`；失败统一走 `#failTransport`（一次 `onExit`） | `src/kernel/sidecar-transport.ts`；`#request` 不在回调里判错（回调参数在 Node stream 上是"错误或 null"形状不一致，故统一交给 error 监听） |
| **V2/A22** | ✅ | 请求超时后 `#reclaimAfterTimeout()` 回收进程树（单次触发保护），再 `#failTransport` | 同上；`killGraceMs` 可注入 |
| **V3/A31** | ✅ | run 的**主写回**传 `signal: req.abort?.signal`；写回中被取消返回 `cancelled`（失败路径的写回仍故意不传，§4.8 规则 3） | 集成 I13；`src/run.ts` 主写回块 |
| **V4/A23** | ✅ | `SidecarTransportOptions.onExit` → registry 摘除该死 session 并通知 run（不再只 `#failAllPending`） | [R1] onExit 用例 + [R3] sidecar 退出用例 |

### 1.3 W 类（既有缺陷 / 部分修复残留）

| # | 结论 | 修复要点 | 验证 |
|---|---|---|---|
| **W1** | ✅ | `isLockError` 映射到**读路径**（`readNotebookFile` 与写前复检读），EBUSY/EPERM/EACCES → `notebook_locked` | 集成 I15（Windows 独占句柄）；`tests/unit/notebook-file.test.ts` [W1] 用合成 errno 覆盖三种码与反例 |
| **W2** | ✅ | `COMPATIBILITY.md` 计数改为按文件如实记录；`REVIEW-FIX-STATUS.md`（本文件）重写；`CHANGELOG.md` 补记 | 见 `docs/COMPATIBILITY.md` |
| **W3** | ✅ | 失败路径写回包 try/catch：`exec_timeout` / `cancelled` / `kernel_died` 始终是主错误码，写回失败以 `write_back.reason` + `warn` 呈现 | 集成 [W3]（运行中篡改文件 → 仍报 `exec_timeout`，`write_back.reason` 含 `file_changed`） |
| **W4** | ✅ | read 侧 `maxImages` 传**调用级绝对量** `maxImagesPerCall`（原来传"剩余预算"却配"绝对游标"，两套坐标系） | `tests/unit/render-read.test.ts` [A5][W4] ×3，含"9 张 + 5 张不误报 image_limit"与"12 + 20 截断到 20 且只告警一次"；**已做变异验证**（改回旧写法这两条变红） |
| **W5** | ✅ | run 锁改为 registry 内以**规范化 notebook 路径**为键的独立表（`#runKeys`/`#runActive`），与 session 生命周期解耦 | [W5] ×2（`restart` 换 session 后仍 `kernel_busy`；无 kernel 时 `kernel_not_available`）；集成 I10 改为在两 cell 之间断言 |
| **W6** | ✅ | CLI 空值（`--opt=` / `--opt ""` / 全空白）一律按"未设置"处理，不再落进 `Number('') === 0` | `tests/unit/config.test.ts` [W6] ×5（含"空 CLI 值不遮蔽 env"） |
| **W7** | ✅ | 写锁键改为 `normalizeForCompare(resolve(path))`；清理分支比较**同一个** `tail` promise（原来每次 `.catch()` 都建新 promise，删除分支恒假） | `tests/unit/notebook-file.test.ts` [W7] ×3（用 `pendingWriteLockCount()` 断言不泄漏，含失败路径） |
| **W8** | ✅ | `kernel_status` 失败保留 transport 推导的 `alive`（不再谎报 `false`）+ `warn`；`Promise.all` 并发查询；`run.ts` 的 abort 监听加 `{ once: true }` | [W8] ×2；`src/kernel/registry.ts` `listKernelsWithStatus` |
| **W9** | ✅ | run 主写回传 `onCleanupError` → 注入 logger（此前落到 `atomic.ts` 的裸 stderr） | `src/run.ts` 主写回块 |
| **W10** | ✅ | 选择器段为空串（`-1` / `0-` / `-` / `1--2`）→ `invalid_targets`（原来 `Number('') === 0` 把 `-1` 读成范围 `0-1`） | `tests/unit/cell-selector.test.ts` [W10] |

### 1.4 T 类（测试维度）

| # | 结论 | 修复要点 |
|---|---|---|
| **T1** | ✅ | I7 补"后续 run 是冷启动（`mode_used === 'replay'`）"；死 sidecar 的确定性恢复由 `kernel-registry.test.ts` [R1] 覆盖。两个集成文件现在都**探测解释器能否真正起 kernel** 再决定用哪个（本机 venv 的 pyzmq 坏，否则 8 个用例会因环境变红） |
| **T2** | ✅ | 两半分开验证：**在途重叠**由集成 I10 覆盖；**两 cell 之间的间隙**（此时没有任何在途 exec）由 `kernel-registry.test.ts` [W5] 直接断言 `acquireRun` 仍抛 `kernel_busy`——集成层无法确定性地制造那个间隙，硬做会变成竞态用例 |
| **T3** | ✅ | `server.test.ts` 夹具改为可带**预置输出**（I16 的 cell 2–4 带 seed，未执行 cell 必须保住 seed）；I13 的 reject 分支从恒真式改为 `instanceof Error` + abort/cancel 形状；I16 断言集合不再接受 `completed` |
| **T4** | ✅ | I18b 标题改为单 cell 可验证的说法；其余"校验先于写入"的守卫由 `tests/unit/edit-tool.test.ts` 的真写路径用例承担 |
| **T5** | ✅ | U20 用例在无法启动 kernel 的环境下**显式 skip 并记录原因**（先起一次 kernel 探针，而不是只探测解释器是否存在），单测在无 Python / 无 ipykernel 机器上全绿 | 
| **T6** | ⚠️ | 编号漂移是**记录问题**而非行为问题：新增用例使用 `[W*]`/`[R*]`/`[A*]`/`[D-0xx]` 等非 SPEC §10.2 词汇。**处理方式**：本轮把这类用例全部加上对应 SPEC 编号前缀（如 `[A5][W4]`、`[R1]`），并在 `DEVIATIONS.md` D-018~D-021 说明新增偏离；SPEC §10.2 不新增用例编号（那是 SPEC 的事） |

### 1.5 文档与卫生（Doc1–Doc6 / H1–H5）

| # | 结论 | 动作 |
|---|---|---|
| **Doc1** | ✅ | `COMPATIBILITY.md` 计数改为按文件如实记录（并写明本机 venv 的 pyzmq 缺口） |
| **Doc2** | ✅ | D-015 重写：判定式是 `timeout × cells > threshold × 10`，**默认配置下只有单 cell 同步**；D-004 补交叉引用；README 的 `--background-threshold-seconds` 行同步 |
| **Doc3** | ✅ | D-016 更正：不再声称"豁免面集中声明在 `src/kernel/interpreter.ts`"（该文件无此声明），改为如实列出 `config.ts` / `kernel/interpreter.ts` / `fs/artifact.ts` 三处，并写明 artifact 默认根在 root 之外 |
| **Doc4** | ✅ | D-004 与 D-015 不再互相冲突（D-004 指向 D-015 为唯一权威描述） |
| **Doc5** | ✅ | 新增 D-018（`docs/archive/` 无实体）、D-019（run 级锁比 SPEC 更严）、D-020（`clear_outputs` 非 code cell 与两种选择器错误码分工）、D-021（`failedCellIndexes` 字段名） |
| **Doc6** | ✅ | 见 D-021 |
| **H1** | ✅ | 删除仓库根的 `patch-tmp.py`（一次性补丁脚本，内容已在代码里；也是行尾符污染源） |
| **H2** | ✅ | `.workbuddy/` 加入 `.gitignore` 并从索引移除（含本机绝对路径的工作记忆） |
| **H3** | ✅ | 新增 `.gitattributes`（`* text=auto eol=lf`）；行尾符归一化单独提交 |
| **H4** | ✅ | `.gitignore` 补 `.workbuddy/`、`patch-tmp*`、`*.tgz` |
| **H5** | ✅ | `docs/E2E-CHECKLIST.md` 的本机绝对路径改为 `<repo>` 占位符 |

---

## 二、第一轮（`ipynb-mcp-code-review.md`）—— 复核结论

第二轮报告确认了第一轮下列项**真修**（A1 主路径、A2、A8/A9/A11/A13–A15/A21/A24/A26/A27/A29、B1/B2/B4/B6、C1–C6、D2/D3/D5/D6/D7/D9、E3）。
第一轮曾标 ✅ 但第二轮查明不实的三项（A20/A22/A31）已在本轮**补齐实现**（见 1.2）。
`REVIEW-FIX-STATUS.md` 第一轮的批次表与门禁数字已不再维护（保留在 git 历史中）；**当前状态以本文件第一节为准**。

---

## 三、剩余事项（需人类/CI）

| # | 事项 | 归属 |
|---|---|---|
| 1 | **E1–E9 手工端到端**（DoD 最后一项）：清单见 `docs/E2E-CHECKLIST.md`，需真实第三方 MCP 客户端（Claude Code / Cursor）。**本轮已补上自动化的那一半**：`pnpm smoke` 用真 SDK 客户端驱动真 stdio server 并断言 11 项，但它不是第三方客户端，不能替代 E1–E9 | **boss** |
| 2 | ~~CI 首次真跑~~ **已完成**：`37130350485` 首次运行 10 个 job 里 8 个失败（全在非 Windows 上），逐条修复后 **`37136146902` 与 `37136528728` 全绿**。这是本轮最有价值的一步：它证明了"本机 Windows 全绿"从来不是完成标准 | **done** |
| 3 | **本机 venv 的 pyzmq 26.2.0 缺口**：该解释器起不了 kernel（详见 `COMPATIBILITY.md`）。集成文件已能自动探测并回退，**未修改任何解释器环境**（R5） | 环境 |
| 4 | npm 发布与 `dsh-ipynb-mcp` bundle 发布（OPEN_QUESTIONS Q5/Q6）：按默认先不发布 | **boss** |
| 5 | ~~**NEW-5 未做**~~ **已在第六轮实现**（`RunStore.settle()` 单写者 + `progress.completed` 收口 + 写回前 abort 复查，用例 `tests/unit/run-store.test.ts`）。剩下的**只有 SPEC 侧的措辞**：§4.8 没有写明"终态只能由第一个写者决定"，实现按最不意外的语义做了并登记 D-039，若要写进 SPEC 仍需人类确认 | 人类 / 下一轮（仅文档） |
| 6 | **结构重构类建议未做**（AGENTS §10 禁止"顺手重构"，且当前无行为风险点）：ARCH-4（`applyEditOps` 219 行）、ARCH-6 剩余部分（`executeCells`/`materializeRunImages`/`computeStaleReport` 抽取）、ARCH-7（`shouldReturnImages` 迁到 `core/outputs.ts`）。建议与下一次接口变更同批做 | 下一轮 |
| 6b | **NEW-2 的广播枚举**（`notebook_run.mode` / `images` 等按值校验）：**需要 SPEC 裁决**——放进 JSON schema 的 `enum` 会让 SDK 在到达处理器之前返回协议错误，而 U27 要求枚举违规返回 `invalid_arguments`（§4.1.12 / §4.6.3 的分工）。当前实现是类型级校验（`timeout_seconds` 用 `.int()`），枚举仍在工具层 | 人类 / 下一轮 |
| 7 | **格式化器**：仍没有引入 prettier（新增依赖需先问人类，AGENTS §11）。替代方案是两个零依赖检查器（`check-format.mjs` + `check-indent.mjs`），后者用 TypeScript parser 覆盖了 QUAL-1 那一类事故。若人类同意引入格式化器，可删掉这两个脚本 | 人类 |
| 8 | SPEC v3.1 建议修订：D14 判定式量纲、R6 豁免措辞（含 artifact 默认根与 sidecar connection file）、§5.8 上限公式/分帧与 `failedCellIndexes` 字段名、§4.1.12 与 §4.6.3 的"未知参数"分工（D-024）、§5.2 的运行期降级语义（D-030）、**§4.1.1 的写入方向边界（D-032，本轮最贵的一课）**、Windows 中断不可用对 §4.7 规则 5-6 的影响（D-033）、§4.8 的终态顺序语义（NEW-5） | 人类 / 下一轮 |
