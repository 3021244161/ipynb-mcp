# 代码审查整改状态（review fix status）

> **来源**：`docs/review/ipynb-mcp-code-review.md`（第一轮）、`…-v2.md`、`…-v3.md`、`…-v4.md`、`…-v5.md`、`…-v6.md`、`…-v7.md`、`…-v8.md`、`…-v9.md`、`…-v10.md`、`…-v11.md`、`…-v12.md`（第十二轮 / 本轮）
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
> 单测 **381（全绿，25 文件）** / 集成 **46/46**（6 文件）/ `pnpm smoke` **19/19** / `pnpm check:package` **ok（132 文件，无 .pyc）** /
> `pnpm pack --dry-run` 133 文件 / 全树 LF / **Linux（WSL Ubuntu + Node 22）单测全绿** /
> **CI 全绿并且外部权威真的跑了**：run `37143775026`，9 个 job 全部通过；integration job 的步骤含
> `pip install ipykernel jupyter_client nbformat`，日志里 `[FID-1]`/`[FID-3]`/`[FID-1 fixtures]` **三条均为 ✓ 而非 skip** ——
> 这正是 P0-a 要的结果：在唯一会自动运行的环境里，产物合法性**确实被外部权威检查过**（此前 `nbformat` 不在依赖闭包里，三条断言被 `if` 静默跳过而套件仍全绿）。
> 集成用到的解释器与三平台默认根见 `COMPATIBILITY.md`。
>
> **上面这段门禁数字是第六轮当时的快照**（不随轮次改动）。**当前数字见第十五轮段的开篇**。
---

## 〇、第十五轮（`ipynb-mcp-code-review-v15.md`，上线前）

> 本轮只剩**一条**阻塞项，而且它是上一轮修复的**另一半**：v14 做到了"预算必须终止 / 覆盖失败路径 /
> 按字节计量"，而"覆盖"只延伸到**失败路径**，没延伸到**载荷的形状**——`include_source='full'` 时占大头的
> `source` 字段既不是 `TEXT_FIELDS` 也不是对象数组，预算**完全没有杠杆**，5 MiB 源码即断连。
>
> **门禁实测（第十五轮整改后，亲跑，无并行负载）**：`pnpm typecheck` exit 0 ｜ `pnpm lint` **0 警 0 错**
> + `format check: ok` + `structural indent check: ok (28 samples)` +
> `documentation self-test: ok (17 mutation(s), 0 skipped, control clean)` + `documentation check: ok` ｜
> 单测 **609 passed / 32 文件** ｜ 集成 **90 passed / 13 文件** ｜ `pnpm smoke` **26/26** ｜
> `pnpm check:package` **ok（144 文件，23 变异）** ｜ `pnpm check:release` **12/12** ｜
> `python scripts/check-connection-sweep.py` **PASS** ｜ `pnpm build` exit 0。

### 15.1 本轮条目

| 条目 | 状态 | 处置与证据 |
|---|---|---|
| **V15-1** 🔴 预算对 `source` 无杠杆 → 5 MiB 源码断连 | ✅ | ① 缩短的对象从"字段名清单"改成"**任何 >64 KiB 的字符串 + 任何字符串数组**"；② `include_source='full'` 不再重复投递源码（预览为空、`source_line_count` 仍报行数，**无信息丢失**）；③ 加**最后手段**：全部字段用尽仍超预算时返回明确的小响应（`response_budget_exceeded` + 原因 + 出路），让"绝不越线"成为**无条件保证**。见 D-065（订正）、**D-068**、**D-069** |
| 复验尺寸对照（评审的同一构造） | ✅ | 3 MiB → 5.13 MiB ✓；**5 MiB → 5.13 MiB ✓（修前断连）**；7 MiB → **6.18 MiB + 警告**（缩短而非拒绝）；9/11 MiB → 5.60/5.02 MiB + 警告 |
| 修复过程中自查出的一处新不收敛 | ✅ | 数组分支的 `slice(0,1) + 标记` 把 5 字符变成 40 字符，载荷越改越大——被 `MAX_DEGRADATION_PASSES` 以"10000 passes 仍超预算"抓住。**根因**：缩短只做**预检查**、不**测量结果**。现在统一规则：算出替换值 → 量它 → 不更小就**原样撤回**并跳过该字段（标量、字符串数组、整体丢弃三处都适用） |
| **V15-2** 🟡 降级警告不指明字段 | ✅ | 按字段名汇总（去重、名字截 64 字符、最多 8 个——警告不能成为新的体积杠杆）；丢弃路径的建议上轮已改成对"单个 cell 的单个大输出"也成立 |
| **V15-3** 🟢 夹具形状单一 | ✅ | 形状矩阵**写进测试文件**并补齐 7 格（含新增的**大图片**）；`check-indent` 扩到 `.mjs` 上轮已完成 |
| F4–F8 的复核 | ✅ | 评审只用探针确认了"cell 不再被删"；本轮补上断言：`cells.length === cell_count`（v15 V15-2 的要求）在丢弃阶段用例里 |

### 15.2 新增规则（`AGENTS.md §9`）

**守卫的夹具必须覆盖载荷的「形状」，不只是尺寸。** 连续三轮栽在同一件事上（v13 全是 ASCII 大文本 → v14 的估算缺陷全绿 → v15 的 source 缺陷全绿），所以写成硬规则并附矩阵与判据："**把被测实现换成一个天真的坏版本，这个夹具会让它红吗？**"同一条也覆盖**输入类型**：`source` 在 read 载荷里既可能是字符串（拼接后）也可能是数组（Jupyter 存盘形状），只按一种写断言会在另一种上得到假绿或假红——V15-1 的用例第一版就摔在这条上。

### 15.4 亲自试用（本轮交付前实测）

交付前用三个**真客户端**脚本手工跑过（不是单测，是"我作为使用者操作它"）：

| 脚本 | 内容 | 结果 |
|---|---|---|
| `scripts/trial-v15.mjs` | 真 SDK 客户端 + 真 stdio server，走完六个工具：三种 read 模式、CAS 负例（文件逐字节未变）、`dry_run`、锚定编辑、真 kernel 跑两格并写回、`stale_analysis`、**五种载荷形状**、围栏拒绝、kernel 生命周期、**按 pid 断言内核进程已消失** | **24/24** |
| `scripts/trial-real-notebook.mjs` | 对**原始的 37.5 MiB xgboost notebook**（三轮前杀死 server、两轮前杀死客户端的那个文件）做默认读 / 全输出读 / 全源码读，并断言后续调用仍成功、盘上字节未变 | **5/5**（默认读 2.7 s / 0.15 MiB；全输出读 2.7 s / 0.21 MiB 含 20 张图；全源码读 0.2 s / 0.08 MiB） |
| `scripts/trial-real-run.mjs` | 在同一个真 notebook 上**插入探针 cell → 用真 kernel 执行 → 断言输出 `probe 499500` → 断言写回落盘 → 删除探针 → 关闭内核** | **10/10**（`mode_used=replay`，39 329 899 → 39 330 525 字节后回收） |

**试用暴露的、并已修正的自身错误**（都是一手证据，不是推测）：编辑 op 的字段名是 `new_text`，而 `insert_cell` 用 `source` 且**禁止**锚、`delete_cell` **要求**锚——我按印象写了两版脚本都拿到 `invalid_ops`，**服务端是对的**，是脚本猜错了 API。`notebook_read` 也不返回 `stale_analysis`（那是 `notebook_run` 的字段），第一版把断言写在了错的工具上。

**试用同时确认了本轮修复在真实数据上的效果**：5 MiB 源码从"断连"变成完整投递；37.5 MiB 真 notebook 的三种读全部可交付且会话存活；写回与内核回收干净。

### 15.3 未做与残留

- **E1–E9 真实第三方客户端矩阵**：仍 **0/9**。评审连续两轮指出，v13–v15 的三条 🔴 都是"换一个夹具形状"才发现的，而真客户端 + 真 notebook 正是补这一维的手段。
- **F6**（预算挡下的图片已物化）仍登记为 D-066，未实现。
- **macOS / arm64**：仍未在 macOS 复跑（SPEC §9 的既定分层）。

## 〇-0、第十四轮（`ipynb-mcp-code-review-v14.md`）

> 本轮与前十轮的性质不同：**三条 🔴 全部出在上一轮新写的 `src/core/response-budget.ts` 里**。上一轮修好了
> 客户端断连，而那道新护栏自己会**让整个 server 对所有后续请求无响应**——从"某个功能不对"升级为"进程级
> 失效"。这与本项目连续四轮的模式一致：修一处、把风险搬到新代码。
>
> **门禁实测（第十四轮整改后，亲跑，无并行负载）**：`pnpm typecheck` exit 0 ｜ `pnpm lint` **0 警 0 错**
> （`oxlint src tests scripts`，**93 个文件**）+ `format check: ok` + `structural indent check: ok (28 samples)`
> （收集器现已含 `.mjs`）+ `documentation self-test: ok (17 mutation(s), 0 skipped, control clean)` +
> `documentation check: ok` ｜ 单测 **607 passed / 32 文件** ｜ 集成 **85 passed / 13 文件** ｜
> `pnpm smoke` **26/26** ｜ `pnpm check:package` **ok（144 文件，23 变异）** ｜ `pnpm check:release` **12/12** ｜
> `python scripts/check-connection-sweep.py` **PASS** ｜ `pnpm build` exit 0。

### 14.1 本轮条目

| 条目 | 状态 | 处置与证据 |
|---|---|---|
| **V14-11** 🔴 截断循环不收敛 → **整个 server 永久挂死** | ✅ | 每轮必须**证明净进展**：目标长度钳在严格小于当前长度，改写后按字节重测，没变小就撤回并跳过该字段；两个循环加 `MAX_DEGRADATION_PASSES` 上界（超限抛错，而不是静默自旋）；最大字段按**字节**选。用例 `tests/unit/response-budget.test.ts` 三条（终止性、值绝不被改大、载荷只减不增）。**变异验证**：还原 `Math.max` 写法并去掉进度判定 → 3 条红（有上界兜底所以表现为报错而非挂死；**无兜底即评审实测的 30 s 无响应**） |
| **V14-12** 🔴 错误响应绕过预算 | ✅ | `toCallToolResult` 的**两个出口**都过预算。用例 `[V14-12]`：cell0 产出 12 MiB 输出**并真的执行**、cell1 超时 → 响应 < 10 MiB、仍可读出 `exec_timeout` 与 `detail.executed`、会话存活。**变异验证**：错误分支还原为裸 `JSON.stringify` → 该用例红，报出评审那条 `MCP error -32000: Connection closed` |
| **V14-13** 🔴 估算按 UTF-16 且忽略转义，低估 2–6 倍 | ✅ | `escapedByteLength` 逐字符按转义后 UTF-8 计（引号/反斜杠→4、控制字符→12、BMP 外按代理对）。用例：与 `Buffer.byteLength` 实测**逐类对照**且断言**永不低于**；集成 5 类转义密集载荷（反斜杠/引号/中文/控制字符/Windows 路径）。**变异验证**：还原为 `value.length + 2` → 集成 5 条全红（`-32000` + `Not connected`），单元 1 条红。**夹具从 `'x'.repeat(...)` 换成真实内容类型是关键**——旧夹具对着坏代码也全绿 |
| **F4** 🟡 丢弃阶段删掉整个 cell | ✅ | 只在 `outputs` 上丢弃。用例断言 20 个 cell 全部保留、`cell_count` 一致、且确实发生了丢弃 |
| **F5** 🟡 一次调用两条 `output_truncated` | ✅ | 两个阶段合并成一条消息（§7 的 one-per-call 规则） |
| **F8** 🟡 文案里的 "0 MiB" | ✅ | 按量级输出 `KiB`/`MiB`。用例断言 message 不含 `0 MiB` 且含 `KiB` |
| **V14-5 / F9** 🟡 "非真空"断言其实真空 | ✅ | 改为 `filter(...)` 后 `toEqual([])`——对**响应**的断言而非重言式；`oxlint` 的 `unicorn/no-useless-length-check` 消失（lint 回到 0 警） |
| **V14-4** 🟡 `tmp-result-backup.ts` 第七次入库 | ✅ | 删除文件；新增**仓库根白名单门禁**（`check-package.mjs` 断言根目录只有 15 个已知文件）+ 自己的变异。已实测：造一个 `tmp-stray-check.ts` 立刻红，删掉即绿 |
| **V14-6** 🟡 三处"守卫是摆设" | ✅ | ① `measure-*.mjs` 采样失败**打印并非零退出**（新增 `reportSampleFailures`）；② `trial-scenarios.mjs` 的假护栏改为**构造上不可能**（驱动器 `setTrialRoot(root)`，路径从 `--root` 派生）；③ `check-indent` 收集器扩到 `.mjs`——并**当场抓到我自己**在 `check-docs.mjs` 里写的错位缩进 |
| **V14-8** 🟡 v12 段落的快照被追溯覆盖 | ✅ | 改回 **596·30 / 73·11**；本轮数字只写在本轮段落 |
| **V14-9** 🟡 计时阈值压在噪声带上 | ✅ | 取 **5 次运行的最小值**，阈值 3 → **4**（仍能抓住二次特征的 3.91）。本地连跑 **12 次 0 假红**（评审实测旧阈值 25 次里 5 次假红） |
| **V14-7** 🟡 D-064 验证列不完整 / 效果③零覆盖 | ✅ 订正 + 补用例 | 补齐四组变异结果（M3 单独绿、M4 单独绿、M3+M4 才红）；**并把结论说清**：效果③在**本实现的 MCP 表面上不可观测**（`RunStore.settle` 只在 `running` 时写入，内核死亡的终态先落，随后到达的取消在**状态层**就写不进去，getter 的 `??=` 只是第二道防线），因此**不再声称它有独立用例**，保留 `??=`+getter 作为显式不变式；新增 `[V14-7]` 覆盖可观测的那一半 |
| **V14-1** 🟡 D-065 描述了一个不存在的字段 | ✅ | 条文改为事实（文本内标记 + 调用级警告）；写明 `text`/`json` 项在 §4.3 无 `truncated` 字段、结构化标志需人类批准；写明 `output_truncated` 在此处的**第四义** |
| **V14-2** 🟡 丢弃路径的建议不可执行 | ✅ | 改为对"单个 cell 的单个大输出"也成立的说法 |
| **V14-3** 🟢 8–10 MiB 区间被截断 | ✅ 登记 | README 补上后果与出路；**D-067** |
| **F6** 🟡 预算挡下的图片已物化 | ✅ 登记 | **D-066**：§4.4 的四条路径都不物化（U26 断言的正是这四条），只有"预算不够"这条会留下 artifact；真正的修法要把预算前移到 `applyImagePolicy`，属独立改动 |
| **F7** 🟡 `structuredClone` 注释不实 | ✅ | 注释改成事实（它是整载荷深拷贝，代价是罕见路径上一次载荷大小的复制） |
| **V14-10** 🟢 两处小账 | ✅ | `src/config.ts` 缩进已修；"待无并发时补跑"的两条构造按评审意见不列为缺陷 |

### 14.2 新增的两条规则（已写进 `AGENTS.md §9`）

1. **门禁不得与重负载探针并行跑**——两轮各一次假红的教训（v13 附录）：并行跑 204 MiB 探针时量到"5 s 超时花了 47.9 s"并据此写好解释，干净复测 11.3 s；同源争用还让 `stale.test.ts` 整文件假 FAIL。判据：**计时结论必须能在空载下复现**。同族的一半：计时阈值不能压在噪声带上（本轮 V14-9 的实测数据）。
2. **凡"消费者会怎么收到"的问题，必须用真消费者测**——v13 V13-1 靠裸 JSON-RPC 读取器躲过整轮 CI 与两路复核。判据：**这条路径上谁的代码在决定成败？** 如果是别人的实现（SDK、`nbformat.validate`、真客户端），就必须让它参与；夹具同样要按这条选（本轮换了夹具才让 V14-13 的守卫有判别力）。

### 14.3 未做与残留

- **E1–E9 真实第三方客户端矩阵**：仍 **0/9**。评审指出 v13 最重的两条 🔴 都只有"真客户端 + 真 notebook"能暴露，而本轮三条 🔴 里的 V14-13 也只有这一类内容能触发——所以这一门在发布前值得做。
- **F6**（预算与图片物化的时序）未实现，登记为 D-066。
- **macOS / arm64**：仍未在 macOS 复跑（SPEC §9 的既定分层）。
- **大 notebook 的成本上界**：仍为"已知行为 + README 数字"（D-054/D-062 的方式）。

## 〇-1、第十三轮（`ipynb-mcp-code-review-v13.md`）

> 本轮的性质与前几轮不同：**两个 P0 级修复都是真的**（OOM 从 33.9→203.5 MiB 四档全通过、sidecar 编码致死
> 正反对照都验过），而三条 🔴 里有**两条是那些修复的副作用**——"把风险从服务端搬到了别处"。
>
> **门禁实测（第十三轮整改后，亲跑）**：`pnpm typecheck` exit 0 ｜ `pnpm lint` **0 警 0 错**（现在覆盖
> **15 个文件**，含 `scripts/`）+ `format check: ok` + `structural indent check: ok (28 samples)` +
> `documentation self-test: ok (17 mutation(s), 0 skipped, control clean)` + `documentation check: ok` ｜
> 单测 **600 passed / 31 文件** ｜ 集成 **78 passed / 13 文件** ｜ `pnpm smoke` **26/26** ｜
> `pnpm check:package` **ok（144 文件，22 变异）** ｜ `pnpm check:release` **12/12** ｜
> `python scripts/check-connection-sweep.py` **PASS** ｜ `pnpm build` exit 0。

### 13.1 本轮条目

| 条目 | 状态 | 处置与证据 |
|---|---|---|
| **V13-1** 🔴 响应超过 10 MiB 时 MCP 客户端整条会话死掉 | ✅ | 新增 `src/core/response-budget.ts`：对组装后的载荷施加字节预算（`--max-response-bytes`，默认 **8 MiB**），先截断最大的文本字段、必要时丢弃整项输出，图片装不下就不返回块（走 §4.3 现成的 `artifact_path` 降级），**每一次删除都有 `output_truncated` 警告**；施加在六个工具共用的唯一出口。按 AGENTS §0 先登记偏离（**D-065**：SPEC §5.4/§7 只规定 stream 阈值，对总响应大小没有条款）。证据：新增集成用例（**真 SDK 客户端 + 真 stdio**，11 MiB 输出 → 返回在预算内 + 警告 + **下一次调用仍成功**；以及 60×300 KiB 累计超限）。**变异验证**：预算换成直通 → 两条都红，报出 `-32000: Connection closed` 与 `Not connected` |
| **V13-7** 🔴 `readString` 的 `indexOf('"')` 未按 `\` 截断 → O(n²)（**第十二轮修复引入的回归**） | ✅ | 改为**单次前向 token 扫描**（`/[^"\\]+|["\\]/g` + `String.matchAll`），普通段仍一次 `slice`，转义按"反斜杠+一个字符"整段消费。证据：1 MiB **17 ms** / 2 MiB **34 ms**（原 2328/9585 ms，翻倍即四倍），真实 37.5 MiB notebook 峰值 911.8 MiB 且 `notebook_run` 完整跑完。用例 `json-reader-scaling.test.ts`：耗时比 + 绝对上界 + 探针断言、16 个转义形状、4 个嵌套文档。登记 **D-063**。**过程中两次改错都被用例当场抓住**：`\\` 配对消费错导致 `"a\\\\b"` 读成三个反斜杠；`\"` 当成字符串结尾导致 `{"source": ["x = 1\n"]}` 报 "Expected ':'" |
| **V13-8** 🔴 后台 run 的内核异常死亡被报成 `cancelled` | ✅ | 按**实际先触发的那个**分类（`firstAbort.reason ??= …`），`abort.reason` 改为 getter，`RunRequest.abort.reason` 变可选，`notebook_run` 不再预设 `'cancelled'`。用例：真 MCP 客户端 + 后台 run + cell 内 `os._exit(7)` → `state==='failed'`、`error.code==='kernel_died'`、`facts_pending===false`、已完成 cell 仍被报告并写回。**变异验证**：撤掉修复 → 该用例红并打印 `{"state":"cancelled",…}`，同文件其余 5 条全绿；**只撤调用方的默认值仍通过** —— 这帮助定位到 getter 才是分类真正生效的那一半。登记 **D-064** |
| **V13-6** 🟡 `(interrupt did not land)` 是假事实 + 两条守卫不可能失败 | ✅ | ① 文案改为只陈述本层知道的事实；② `v9-regressions` 收紧为只接受 `exec_timeout`（此前把错误分类的**症状**当通过条件）；③ `kernel.test.ts` 拆成两条确定性用例：运行中显式 `registry.interrupt()` → `error` + `KeyboardInterrupt` 且**不**关闭内核，超时 → `timeout` 且关闭内核（旧的 `KeyboardInterrupt` 断言在超时恒为 `timeout` 后**不可达**）；④ `v12-timeout-status` 补非真空断言（Windows 上循环迭代零次） |
| **V13-2** 🟡 `scripts/` 在 lint 门禁之外（8 error / 4 warning） | ✅ | **修好而不是豁免**：输出改 `process.stdout.write`（这才是这些工具的本意，也是仓库其它地方的写法）；四处 warning 是死代码（一个未被调用的 `exists()`、未用的 `spawn` 导入、未用的 catch 绑定）与一处 `startsWith`；门禁扩为 `oxlint src tests scripts` |
| **V13-4** 🟡 `check:release` 不在 CI / `prepublishOnly` | ✅ | CI 的 integration job（ubuntu/py3.12）新增一步；`prepublishOnly` 追加 `&& npm run build && npm run check:release`。**订正评审上一稿的一半**：`prepack: tsc` 一直存在，所以"会发出旧代码"不成立；缺口只是这道门禁没进自动化 |
| **V13-3** 🟡 试用脚本会就地改写真实 notebook、非 Windows 假绿 | ✅ | 头部横幅警告"它写进 `--root`"；拒绝已知原件目录（解析后大小写折叠比较）；路径由 `IPYNB_TRIAL_DIR` 提供；"必须被拒"的围栏用例改用 root 的**兄弟路径**（此前在没有 `E:\ChangeJob` 的机器上会因"文件不存在"而假绿）；两个内存探针不再吞掉 `spawnSync` 失败（曾把探针坏掉打印成 `ratio=0.0`） |
| **V13-5** 🟢 状态表 / 矩阵数字滞后 + 头注释指错脚本 | ✅ | 更新为 600·31 / 78·13；`measure-real-notebook.mjs` 的头注释改正 |

### 13.2 V13-6 的"待澄清分歧"（cancel 终态语义）

评审记录了两方实测结论不同（子代理见 `status: "timeout"`，主审见 `status: "error"` + `error.code=cancelled`）。实现方结论：**两者都不算错，因为它们测的是不同时刻**——`notebook_run_cancel` 落在**在途 cell 内**时，该 cell 的结局取决于 interrupt 是否落地（落地 → `error`，未落地 → grace 截止 → `timeout`），而 `facts_pending` 归零后读到的是最终事实。本轮**不**把 cancel 与 timeout 在 `error.code` 上强制分开：两者都已是 `cancelled`（客户端请求的）与 `exec_timeout`（cell 超时），语义可分；需要区分的是**内核死亡**，那正是 V13-8 修掉的。若后续仍要一个显式信号，属新增返回字段，按 AGENTS §11 需人类批准。

### 13.3 未做与残留

- **E1–E9 真实第三方客户端矩阵**：仍 **0/9**。本轮三条 🔴 里最重的两条（10 MiB 帧上限、O(n²) 卡顿）**都只能由"真客户端 + 真 notebook"暴露**——`smoke`/`check:release` 虽然用了真 SDK，但用的是小 notebook 与无转义载荷。评审的建议照办：把试用脚本接到 E1–E9 并记进 `COMPATIBILITY.md`，这是发布前唯一剩下的非代码门。
- **macOS / arm64**：未在 macOS 复跑任何东西（SPEC §9 的既定分层）。
- **大 notebook 的成本上界**：`read` 2.7→11.2 s、`edit` 14.9→85.6 s、`run` 63→216 s（33.9→203.5 MiB），随体积近似线性但常数很大且无上限。本轮按 D-054/D-062 的方式在 README 登记为"已知行为 + 数字"，未加守卫。
- **`README` 的 `process.env` 安全声明**（v8 起挂着，🟢）：仍未写。

## 〇-2、第十二轮（`ipynb-mcp-code-review-v12.md`）

> 本轮的 🔴 是**第十一轮自己引入的回归**：把数值判据改成"按值"是对的方向，但零那一格被单独早退成
> `if (value === 0) return isNegativeZero(literal)`——**上溢被照顾到了，下溢落进了缝里**。
> 两条 🟠 也都是"守卫覆盖了被改的那一层"：run 路径的图片警告按 **code** 去重（read 已修、run 没修，且该路径**零覆盖**），
> 状态表三行"已修"没有产物而**新加的门禁抓不到**。
>
> **门禁实测（第十二轮整改后，亲跑）**：`pnpm typecheck` exit 0 ｜ `pnpm lint` **0 警 0 错** +
> `format check: ok` + `structural indent check: ok (28 self-test samples)` +
> `documentation self-test: ok (17 mutation(s) detected, 0 skipped, control clean)` +
> `documentation check: ok` ｜ 单测 **596 passed / 30 文件** ｜ 集成 **73 passed / 11 文件** ｜
> `pnpm smoke` **26/26** ｜ `pnpm check:package` **ok（140 文件，22 变异）** ｜
> `python scripts/check-connection-sweep.py` **PASS** ｜ `pnpm build` exit 0 ｜ 工作树干净。

### 12.1 本轮条目（完整清单）

| 条目 | 状态 | 处置与证据 |
|---|---|---|
| **V12-1** 🔴 下溢到零的字面量被静默改写成 `0`（本轮新引入的回归） | ✅ | 删掉"零"的笼统早退，拆成三种情形：`-0` 族（保留字节 + 负零文案）、**尾数为零**的字面量（`0e-5`/`0.0e-400` 等，确实表示零，只规范化写法）、**尾数非零**（`1e-400`，下溢 → 保留字节 + 专门的 "underflows to zero" 文案）。判据只看**尾数**（`denotationIsNonzero`），所以 `0e-400` 不会被指数里的数字误判。登记 **D-056 的 v12 订正**。证据：形态表 26→34、`[V12-1]` 用例、集成 2 例（无关编辑后盘上保留 + 默认出口也报告）。**变异验证**：把早退改回去 → **19 条红** |
| **V11-5 的判据同构**（子代理发现，我采纳） | ✅ | 表里对"不打标记"的断言是 `String(parsed) === String(Number(literal))`，而对 `1e-400` **两边都是 `'0'`** —— 加进表里也会绿。改成断言**用户能观察到的事实**：盘上字节 = `String(Number(literal))`，下溢单独断言逐字节保留 |
| **V12-2** 🟡 D-056 的 `1e21` 例子与实现不符 | ✅ | 实测它确实被规范化为 `1e+21`（属于"值不变、写法变"），例子按实现改正并写明同类共 16 种。D-056 的不变式②从"盘上字节不得被改写"改成"**数值**不得被改写"，并补上 `1e400`/`1e-400` 两个真正的逐字节保留例 |
| **V12-3** 🟠 run 路径按 code 去重、归因全丢、零覆盖 | ✅ | 去重键改为 **message**（与 read 路径一致）；新增 `tests/integration/v12-run-image-warnings.test.ts`（真 kernel、3 cell 坏图 → 3 条可区分消息 + 不累积）。**变异验证**：去重键改回 code → 2 条红，打印出评审实测的那一条。**这条用例同时封住了"整段关掉也全绿"**（旧状态下把警告全关，595 条单测仍绿） |
| **V12-4** 🟠 三行"已修"无产物 + 门禁抓不到 | ✅ | 三行订正并**真补产物**：`src/run.ts` 第二处幽灵符号改掉、D-050 补克隆订正段、D-054 补两格已知行为。门禁三处收紧：词表补"已修"/"fixed"等、判定改为**声明形态**（`isDeclared`）、声称修产品代码时佐证必须来自 `src`/`python`（测试里的同名局部变量不算）。**变异验证**：六种形态逐个跑（"已修"无产物 → 红；`callWarnings` 只存在于测试 → 红；真实声明/真实路径/测试文件路径 → 绿；不存在的符号 → 红），三条绕过形态进自测 |
| **V12-5①** 🟢 `oxlint` 文件数 | ✅ | **71 → 78**（实测） |
| **V12-5②** 🟢 V11-1 的变异红数 | ✅ | **12 → 11**（实测：`json-exact.test.ts` 1 + `json-number-forms.test.ts` 10） |
| **V12-5③** 🟢 §11.2 关于 `3.0` 的说法写反 | ✅ | 订正为"Python `json` 把它解析成 **float**，nbformat 因此判 INVALID，所以 `3.0 → 3` 是把被拒的写法规范成被接受的写法" |
| **V12-5④** 🟢 `json-exact.ts` 两句与用例相反的注释 | ✅ | 按实际行为重写（55 位那个是**被报告**的，不是 "accepted"；`1e21` 的行为写对），并把"注释里的例子也要跑"写进 AGENTS §9 |
| **V12-5⑤** 🟢 `run.ts` 注释缩进错位 | ✅ | 已修（`scripts/check-indent.mjs` 本来就放行，属观感；证据 `src/run.ts`） |
| **V12-5⑥** 🟢 json mime 的非有限值以 `"inf"` 交付且零警告 | ✅（登记为**已知行为**） | 与 `['a','b']` 同族，两格一起写进 **D-054** 的 v12 追加段；采纳评审建议**不**加通用魔数检查或字面量黑名单（会误伤 Jupyter 自己的分行 base64 与用户的合法字符串） |
| **V12-6** 🟢 值等价的写法规范化覆盖 16/28 种字面量 | ✅（知会 + 措辞订正） | 确认**不是缺陷**（SPEC §5.5.7 明确许可，`README` 原先第 89 行已声明）。采纳评审给的**可选建议之外**的最小改动：把 README 的保真声明改成它实际的意思——规范化的对象是**写法**（与 Python `json.dumps` 的输出同族），**值一律不改**；存不下的值逐字节保留并附精确数字的警告。"静默保留 vs 规范化"的产品取向留给 SPEC v3.1 决定，本轮不动行为 |
| **V11-11 的最后一个洞** 🟡 删掉整行 `entries:` | ✅ | 缺失的声明行现在是**问题**而不是"跳过该规则"（把规则的输入删掉就关掉规则，是让守卫失效最便宜的方式，而且看起来与"通过"一模一样）。自测加一格变异（17 个） |

### 12.2 未做与残留

- **E1–E9 真实第三方客户端矩阵**：仍 **0/9**。十二轮之后代码侧的边际收益已经很低，评审建议下一轮预算**全部**投到这里——**这是发布前唯一剩下的非代码门**。
- **macOS / arm64**：未在 macOS 复跑任何东西（SPEC §9 的既定分层）。
- **`execution_count` 的写法规范化**（`3.0` → `3`）：仍是一格已知的字节级规范化，未单独立项。
- **`--images=never` 与超限时 artifact 已写**：v10 登记的固有序，未动。
- **"静默保留原文"这一取向**：V12-6 提出的可选方案（打 marker 但不发警告）会同时满足字节保真与"不误报"，但会让未修改区域出现更多整文件 diff；本轮**不改行为**，留给 SPEC v3.1 决定。
- **`"inf"`/`"NaN"` 字符串与 `['a','b']` 的 join**：按已知行为登记（D-054），不加魔数检查。

## 〇-3、第十一轮（`ipynb-mcp-code-review-v11.md`）

> 本轮的三条 🟠 有一个共同点：**都在 v10 的"已修"里**。V10-3 的修复（保护数值不被改写）把判据定成了"写法"，
> 于是**对模型陈述假事实**；V10-7 的修复（装配 warnings）解决了"装配"没解决"**送达**"；V10-1 的修复（递归投射）
> 只覆盖了 json **值**。这正是本项目反复出现的那一格：**守卫只覆盖被改的那一层**。
>
> 另外，v10 引入的**守卫本身**有三处无法证伪自己（期望值由被测函数推导、文档计数自证、状态表 ✅ 没有可 grep 的产物）。
> 所以本轮除了修产品，还给这三处各加了一条机械门禁——**纪律守不住的东西，交给门禁守**。
>
> **门禁实测（第十一轮整改后，亲跑）**：`pnpm typecheck` exit 0 ｜ `pnpm lint` **0 警 0 错** +
> `format check: ok` + `structural indent check: ok (28 self-test samples)` +
> `documentation self-test: ok (12 mutation(s) detected, 0 skipped, control clean)` +
> `documentation check: ok` ｜ 单测 **595 passed / 30 文件** ｜ 集成 **69 passed / 10 文件**（约 287 s）｜
> `pnpm smoke` **26/26** ｜ `pnpm check:package` **ok（140 文件，22 变异）** ｜
> `python scripts/check-connection-sweep.py` **PASS** ｜ `pnpm build` exit 0 ｜ 工作树干净。

### 11.1 本轮条目（完整清单）

| 条目 | 状态 | 处置与证据 |
|---|---|---|
| **V11-1** 🟠 完全精确、只是写法不同的数字被报成"无法精确表示" | ✅ | 判据从**写法**改为**值**：`normalizedSpelling(literal) === String(Number(literal))`，`normalizedSpelling` 只去掉无信息的写法差异（指数正号/前导零、尾随 `.0` 与多余零、整数写法）。`100.0`/`2.0`/`1e2`/`1.5e3`/`0.10`/`1.5e-07`/`2.5e-05`/`1e+100` 现在**零警告**；`2**64`/`1e21`/高精度小数/`1e400` 仍被保护。`-0` 单独一条"符号无法传递"的文案。登记 **D-056**。证据：`json-exact.test.ts` 的**显式表**（两组字面量写死）、`json-number-forms.test.ts` 的 34 形态 × 8 位置 + 37 条规范化器期望。**变异验证**：把判据退回"写法相同"→ **11 条红**（`json-exact.test.ts` 1 + `json-number-forms.test.ts` 10；v12 复核订正了原先写的 12） |
| **V11-1 附带** 🟠 守卫用被测函数推导期望值 | ✅ | `inexactLiteralsIn()` 删除，改为 `expectedWarnedLiterals()`（从**写死的 FORMS 表**推导，带数字 token 边界以免 `1e-07` 里的 `-0` 被当成字面量）。这正是 v11 说的"期望自我循环" |
| **V11-2** 🟠 `structuredClone` 前提是反的，且撑住 marker 的全部身份保证 | ✅ | 实测确认（`isExactNumber(structuredClone(marker)) === false`、克隆后是**可扩展**的、序列化会把 marker **对象**写进文件），注释改为真话并写明**已知限制**而非不变量：marker 只保证不被**文件**伪造，任何克隆都会让它失效，因此**序列化路径必须使用未经克隆的原始文档**（今天确实如此：`structuredClone` 只用于比较用的快照）。新增 `[V11-2]` 断言把这条假设变成**测量**。**v12 复核订正**：本行原先还宣称 "D-050 的叙述同步订正"，而 `git diff` 显示该轮对 D-050 **无任何改动**——D-050 当时仍在用"克隆后 marker 依然有效"的措辞暗示克隆安全。**第十二轮已补**（D-050 增订正句 + 明确"序列化必须用原始解析树"）。产物：`isExactNumber`、`tests/unit/json-exact.test.ts` 的 `[V11-2]` |
| **V11-3** 🟠 取消后的"空壳终态" | ✅ | 新增 `facts_pending`（`RunHandle` + 两个载荷），取消时置 `true`，后台任务在**最后一条语句**里清 `false`。登记 **D-055**。证据：`tests/integration/v11-terminal-state.test.ts`（真 kernel：cell0 丢值完成 → cell1 在途 → 取消 → **立刻**读 status）。**变异验证**：去掉 raise → 用例立刻红并打印出评审实测的那个空壳载荷（`executed: []` / `warnings: []` / `write_back.performed: false`） |
| **V11-4** 🟡 状态表虚报（两项宣称已修而都没修） | ✅ | 该行订正为 ⚠️ 并**真修**：幽灵符号 `callWarnings` → `pushCallWarnings`（可 `git grep`），恒真断言 `Number(literal) !== NaN` → `losesPrecision(literal)`。新增机械门禁：`✅` 行含"已订正/已删除/已改名"等词时必须点名一个**存在**的符号或路径。**变异验证**：不存在的符号 → 红；存在且点名 → 绿；什么都不点名 → 红。**v12 复核订正**：门禁的两版都失效过（第一版在 `docs/` 里搜符号，于是那一行在自己身上找到自己；第二版被 `tests/unit/json-exact.test.ts` 里一个**同名局部变量**背书），且 `src/run.ts` 的**第二处**幽灵符号当时仍在。**第十二轮已补**：门禁改为"词表含`已修`/`fixed`"+"符号必须是 `src`/`python` 里的**声明**"（`isDeclared`），第二处幽灵符号一并改掉，三条绕过形态进自测（17 个变异）。产物：`pushCallWarnings`、`claimProblems`、`isDeclared` |
| **V11-5** 🟠 默认出口（`summary`）静默舍入且零警告 | ✅ | 警告提升移出 `full` 分支，`none` 除外。证据：`tests/integration/v11-read-warnings.test.ts`（四种出口的矩阵 + 干净输入零警告）。**变异验证**：只给 `full` → 默认与 summary 两条红 |
| **V11-6** 🟡 marker 从 `execution_count` 漏进响应；合法文件被拒且 hint 不实 | ✅ | 计数在 `parseNotebook` **归一化一次**：字段变成 accessor（**读者拿数字、写者拿 marker**，写回时由 `restoreExecutionCountMarkers` 还原，字节不变），规则拆出 `execution_count_not_an_integer`，hint 按规则分述（不再用 `-1` 的措辞描述大整数）。证据：`v10-regressions.test.ts` 的 3 条 V11-6（读大整数是数字、合法文件可编辑且字节不变、`1.5` 被拒且 hint 含 "whole number of executions"） |
| **V11-7** 🟡 message 上界只数条目、不限单条长度 | ✅ | 每个 mime 名截到 64 字符（`DROPPED_MIME_NAME_LIMIT`），用例断言 `message.length`。证据：`run-reporting.test.ts` 的 `[V11-7]`（20 000 字符的名单条 < 400；八个最长名 < 1000；能放下的名字不被截） |
| **V11-8** 🟡 parser 三格边界 | ✅ | ① 未转义控制字符拒绝（6 个样本与 `JSON.parse` 逐条对照）；② 显式深度上限 `MAX_JSON_DEPTH = 512` + 描述原因的 `parse_failed` 文案（不再断言"不是合法 JSON"）；③ 序列化按下标循环，空洞写 `null`。登记 **D-058** |
| **V11-9** 🟡 测试套件会写进并删除用户的 venv | ✅ | 外来目录（存在但无 marker）**完全不写**：立刻回退 `BASE_PYTHON`（或按 `IPYNB_TEST_REQUIRE_VENV` 报错），不再往里 build、不再种 marker。证据：`test-venv-ownership.test.ts` 的 `[V11-9]`（**字节级**目录快照 + 两轮驱动 + 断言无 marker）。**变异验证**：去掉提前返回 → 第二条调用把目录删掉（评审实测的同一形态） |
| **V11-10** 🟡 图片降级警告不指名 cell；read 不去重、run 去重 | ✅ | 文案改为 `image at cell N (output M) …`，`ExtractedImage` 新增 `cellIndex`，两处调用方传入。登记 **D-057**。证据：`image-blocks.test.ts` 的 `[V11-10]`（三 cell 坏图 → 三条互不相同的消息） |
| **V11-11** 🟡 `check-docs` 还剩两格 | ✅ | ① 加**不可自证**的锚：文档头部 `> digest:`（编号的 sha256 前 16 位），由 `--print-digest` 生成；删末行 + 改计数 → **红**。② `declareCount` 放宽到 40 行且接受 `entries: 54 rows` 这类修饰，缺 digest 行本身也算问题（"规则被关掉"不能看起来像"规则通过"）。自测变异 **10 → 12** |
| **V11-12①** 🟢 `1e400` 文案说会读到 `Infinity`，实际交付 `null` | ✅ | 文案按**实际交付的载荷**分三种生成（超范围 → null、`-0` → 符号、其余 → 舍入值）。 |
| **V11-12②** 🟢 `['a','b']` 仍可能被 join 成 1 字节"图片" | ✅（登记为**已知行为**） | 采纳评审建议**不加**魔数检查（会误伤 Jupyter 自己的分行 base64）。**v12 复核订正**：本行原先宣称 "在 D-054 里写明这一格"，而该轮对 D-054 **无任何改动**。**第十二轮已补**，并连带登记了同族的 `"inf"`/`"NaN"` 字符串那一格（D-054 的 v12 追加段）。产物：`imageValueText`、`docs/DEVIATIONS.md` 的 D-054 |

### 11.2 未做与残留

- **E1–E9 真实第三方客户端**：仍 **0/9**，发布前最后一道非代码门（与前几轮相同）。
- **macOS / arm64**：本轮未在 macOS 复跑任何东西；集成不在 macOS 上跑是 SPEC §9 的既定决策。
- **`execution_count` 的写法规范化**：文件里写 `3.0` 时，本工具写回 `3`（值相同；**v12 复核订正**：nbformat 判 `3.0` INVALID 是真的——Python `json` 把 `3.0` 解析为 **float**，而 schema 要 `"integer"`——所以本工具的 `3.0 → 3` 是**把一种 nbformat 拒绝的写法规范成它接受的写法**，不是两种权威结论不同。原先那句话把两个权威的说法写反了）。这是一格**已知的字节级规范化**，未在 D-056 之外单独立项。
- **`--images=never` 与超限时 artifact 已写**：v10 登记的固有序（先物化后组装）未动。
- **`facts_pending` 的 spec 缺口**：SPEC §4.8 的 status 载荷与 cancel 载荷都没有这个字段，属于**新增返回字段**（D22 允许只增不改），已按 AGENTS §0 登记为 **D-055**。

## 〇-4、第十轮（`ipynb-mcp-code-review-v10.md`）

> 本轮的两条 🔴 有一条是**新引入的回归**，而且它比被修的那条更重：为 V9-5 换上自研 JSON parser 之后，
> 对象键用 `result[key] = value` 承接，`__proto__` 命中的是 `Object.prototype` 的 **setter** —— 该键既不进对象也不进响应，
> **下一次写入就从用户文件里消失**（`x2 → x0`），编辑的还是**无关 cell**，而文件仍合法所以没有任何一处报警。
> `JSON.parse` 在这一格本来是**正确**的：**替换一个成熟实现时，先写出被替换者的行为矩阵，再替换。**
>
> **门禁实测（第十轮整改后，亲跑）**：`pnpm typecheck` exit 0 ｜ `pnpm lint` 0 警 0 错 +
> `format check: ok` + `structural indent check: ok (28 self-test samples)` +
> `documentation self-test: ok (10 mutation(s) detected, 0 skipped, control clean)` +
> `documentation check: ok` ｜ 单测 **552 passed / 30 文件** ｜ 集成 **58 passed / 8 文件**（`pnpm test:integration`，约 536 s）｜
> `pnpm smoke` **26/26** ｜ `pnpm check:package` **ok（140 文件，22 变异）** ｜
> `python scripts/check-connection-sweep.py` **PASS** ｜ `bash scripts/linux-check.sh --selftest`（WSL）**cases=26 failed=0**，
> 变异 `prefix-only` → 4 条红。

### 10.1 本轮条目（完整清单）

| 条目 | 状态 | 处置与证据 |
|---|---|---|
| **V10-6** 🔴 `__proto__` 键被静默删除 + marker 可伪造 | ✅ | `src/core/json-exact.ts`：`readObject` 改用 `Object.defineProperty` 定义自有属性（不再走 setter 路径）；marker 判据改为"形状 + **不可扩展**"（`exactNumber()` 用 `Object.freeze`，来自文件的解析结果必然可扩展）；补齐 JSON 数字文法与 `-0` 符号。**没有**用 `class`+`instanceof` 或 Symbol 键——`structuredClone` 会把类实例压平并丢弃 Symbol 键，那样 marker 会在克隆后失效并被当作对象写进用户文件（实测过）。登记 **D-050**。证据：`tests/unit/json-parser-semantics.test.ts`（28 语义样本 × 解析/写回/往返三断言 + 22 拒绝样本，逐条与 `JSON.parse` 对照）、集成 `v10-regressions.test.ts`（metadata / cell metadata / json 输出三处 `__proto__` + 真 `nbformat.validate`；marker 伪造返回对象且 `warnings: []`） |
| **V10-3** 🔴 编辑无关 cell 改写盘上的高精度小数 | ✅ | `losesPrecision` 判据从"看起来是整数"改为 `String(Number(literal)) !== literal`（即"能不能原样写回"），覆盖小数、超范围值、`1E+2`/`1e21`/`0.10`/`-0` 这类值与写法不同的形态；能往返的 `0.1`/`1.5` 仍是普通 number。登记 **D-051**。证据：`tests/unit/json-number-forms.test.ts`（**20 形态 × 8 位置** × 三条断言：盘上字节、模型可见值与警告、可往返值不产生 marker）、集成"编辑无关 cell 后盘上不变"与"run 写回同样保真" |
| **V10-1** 🟠 嵌套精确数把标记对象漏给模型且无警告 | ✅ | `jsonValueOf` 改为**递归**（`projectJsonValue`）：任何深度的 marker 换成数字，**每个不同字面量一条警告**，精确数字仍写在警告文本里；`D-048` 的不变式②现在对嵌套成立。登记 **D-052**。证据：`tests/unit/json-number-forms.test.ts` 的 `[V10-1]`（断言序列化结果里**不出现** `__ipynb_exact_number__`、每个不精确字面量恰好一条警告、两个不同字面量两条） |
| **V10-7** 🟠 中止类出口与后台 status 丢掉全部 warnings | ✅ | `failedRunError` 新增 `collected` 形参，`abortedRunError` 传入已收集的 warnings 与 droppedMimes；`executeBackgroundRun` 的 catch 把 `detail.warnings` 写回 `handle.warnings`；装配规则下沉到 core 的 `assembleCallWarnings`，四个终态出口共用。登记 **D-052**。证据：集成 `[V10-7]`（真 kernel：cell 0 丢值 → cell 1 在途取消 → 终态 `cancelled` 且 detail 里含 `cell 0: text/plain`；由 run 自己的 progress 事件驱动取消，不靠猜时长） |
| **V10-4** 🟠 hint 声称"文件会变合法"而权威判它不合法 | ✅ | 文案改为分别陈述"本工具不再检查"与"计数仍在文件里、`nbformat.validate` 仍会拒绝"；`selfCheckNotebook` 的**首次拒绝路径也一律带 hint**（此前未传 `originalDoc` 时没有）。证据：集成 `[V10-4]` 两例——`clear_outputs` 之后**真 nbformat 仍 INVALID**（并断言消息含 `-1`）、`set_cell_type`→markdown 之后 **VALID**；单测断言旧措辞已消失 |
| **V9-1 残留** 🟠 图片数组形式两条路径判据不同 + `[1,2,3]` 伪造图片 | ✅ | 共用 `imageValueText`：仅当元素全为字符串时 join；读入边界对图片 mime 保留数组形状、只在全字符串时 join，因此读路径与 run 路径交给 `mapRawOutputs` 的是同一种东西。登记 **D-054**。证据：`tests/unit/image-blocks.test.ts` 43 例（新增数字数组 / 混合数组 / 对象数组 / 空数组 / 嵌套数组 5 种非法形状，均断言零块 + `image_materialize_failed`） |
| **V10-5** 🟡 警告装配无行为级判据 + 幽灵符号 + 恒真断言 + check-docs 两个盲点 | ⚠️ **部分（v11 复核订正）** | 规则下沉到 core `assembleCallWarnings` 并用**真输入**直接单测（这一半成立，v11 也是这么确认的）；`check-docs` 新增"末尾条目被删"与"追加条目未改计数"两条可失败规则。**v11 复核订正了本行原先的两个 ✅ 断言——当时两句都不成立**（V11-4）：`src/run.ts` 里 `callWarnings` 这个**并不存在**的符号的注释**没有**订正；`tests/unit/json-exact.test.ts` 的恒真断言 `Number(literal) !== NaN` **一字未改**（当时只重写了紧邻的那个 `it`）。**第十一轮已真修**：幽灵符号改名为 `pushCallWarnings`（可 `git grep pushCallWarnings`），恒真断言换成 `losesPrecision(literal)` 的真判据；并新增一条**机械门禁**防止再次虚报（见第十轮段的 V11-4 行）。证据：`tests/unit/run-reporting.test.ts` 的 `[V10-5]`；`check-docs --selftest` 12 个变异全红 |
| **V10-8** 🟡 检查器会因**合法修订**变红 | ✅ | 自测的变异源改为**从当前文本推导**（最后一个编号 / 中间编号 / 下一个编号 / §12 的任一行），施加不了就**跳过并显著提示**，并设"可施加数量下限 5"防止容错退化成什么都不查；`editLine` 的 `throw` 改为返回 null 由调用方跳过。证据：把 SPEC §12 与 `OPEN_QUESTIONS.md` **同步**改一个词（verbatim 仍成立）→ `check` exit 0、`--selftest` exit 0（改前会 exit 1）；只改一边 → 两者都红 |
| **V10-9①** 🟡 警告 message 无上界 | ✅ | 最多列 8 个 `(cell, mime)` 对，其余 `… and N more`，**计数保持精确**；上限常量在 core 导出，用例引用而非写死。登记 **D-053**。证据：`[V10-9]` 用例（300 项 → message < 400 字符、含 `dropped 300` 与 `… and 292 more`；正好 8 项时不出现 `more`） |
| **V10-9②** 🟡 `analyze-op` 的 afterAll 判据与 helper 行为矛盾 | ✅ | 断言从"之前存在"收窄为"之前存在**且可用**"——不可用的共享 venv 被 helper 删除是登记过的设计，随后重建失败时路径合法地不存在，旧文案却指责测试删了不是自己创建的环境。 |
| **V10-9③** 🟢 `linux-check.sh` 的 `rm -rf` 用的是第二次归一化的字符串 | ✅ | 归一化之后再走一次 `guard`，使守卫注释里"每个删除目标都经过全部检查"成为事实。证据：WSL `--selftest` 26/26 通过、`prefix-only` 变异 4 条红 |
| **V10-9④** 🟢 README 的 venv 措辞 | ✅ | 改为"单测与集成共用一个临时 venv"，并补一条**安全声明**（sidecar/kernel 继承完整 `process.env`，执行不沙箱） |
| **给下一轮的硬规则** | ✅ | `AGENTS.md` §9 新增第 4、5 条：**判据必须与外部权威一致**（并反向要求"守卫不得因无关原因失败"）、**自己写 parser/序列化器时语言语义边界与数值形态都要有矩阵**（附必测格清单与"替换成熟实现前先写行为矩阵"的判据） |

### 10.2 未做与残留

- **E1–E9 真实第三方客户端**（Claude Desktop / Cursor / Cline 各跑一次并记录进 `COMPATIBILITY.md`）：仍 **0/9**。CI 已覆盖 ubuntu 的 unit + integration，但"服务端自认为正常、客户端收到协议错误"这类故障只有真客户端路径能可靠暴露（v9 的 `-32602` 就是例子）。**这是发布前最后一道非代码门。**
- **macOS / arm64**：集成不在 macOS 上跑（SPEC §9 的分层），本轮未在 macOS 复跑任何东西。
- **sidecar 探针的未实测分支**：Windows `PROCESS_QUERY_LIMITED_INFORMATION` 失败回退 `PROCESS_QUERY_INFORMATION`、`ERROR_ACCESS_DENIED → None`、以及"平台根本没有探针"那一级年龄阶梯，本机没有可造的真实场景（v8-6 轮报告已如实说明，本轮未变）。
- **`output_truncated` 的三义拆分**：D-042/D-048/D-052 都记了"若 SPEC v3.1 愿意新增专用码（如 `output_value_dropped` / `output_value_inexact`），改一两处即可"。SPEC 未改，符合 AGENTS §0。
- **两处仍值得将来处理的形状**（本轮未做，非阻塞）：① `--images=never` 与超限时，若某 cell 的块被 `result.ts` 丢弃，其 `artifact_path` 可能已指向刚写的文件——"先物化后组装"的固有序；② `run.test.ts` 的权威解释器用例依赖 `resolvedTestInterpreter()`，在没有 venv 的裸机上仍会走 base 解释器（这是设计，但值得在 CI 里断言它确实用了 venv）。


## 〇-5、第九轮（`ipynb-mcp-code-review-v9.md`）

> 本轮的两条 🔴 是**同一个错误的第四次与第五次形态**。v8 为修"data-URL 图片看得见读不出"只改了**解码/物化**那一层，
> 断言停在内部 `OutputItem`（`bytes > 0`、`__decodeFailed === false`），而**内容块**那一层仍把文档里的 `data:` 原值交给 SDK
> → 含该形状的 notebook 连 `notebook_read` 都以协议错误 `-32602` 失败（`notebook_run` 同），**门禁、CI、smoke 同时放行**；
> 另一条是刚写进 `AGENTS.md` §9 的"全部合法类型矩阵"漏了 **number 域**：超出 IEEE-754 的整数 JSON 被静默四舍五入，
> run 路径还把舍入后的值写回用户文件（用户数据在磁盘上永久丢失）。所以本轮除修代码外，把两条规则写进 `AGENTS.md` §9：
> **断言要断言到消费者真正拿到的那一层**、**单个字段的缺陷不得升级为工具级失败**。
>
> **门禁实测（第九轮整改后，本轮亲跑）**：`pnpm typecheck` exit 0 ｜ `npx oxlint src tests` **0 警 0 错（71 文件 / 99 规则）**
> ＋ `scripts/check-format.mjs` ＋ `scripts/check-indent.mjs`（**28 个自测样本全部通过**）＋ `scripts/check-docs.mjs`
> （**7 个自测变异全被抓到、真文档对照通过**）｜ 单测 **432 passed / 28 文件**（`npx vitest run --reporter=dot`）｜
> 集成 **50 passed / 7 文件**（`pnpm test:integration`，238.8 s，含新增的 `v9-regressions.test.ts`）｜
> `pnpm smoke` **26/26** ｜ `npm pack --dry-run` **140 文件**、`pnpm check:package` **ok（140 文件，22 个变异全被抓到）** ｜
> `python scripts/check-connection-sweep.py` **PASS**（本机 Windows，`liveness probe available: True`）｜
> `bash scripts/linux-check.sh --selftest`（本机 WSL）**cases=26 failed=0**，`IPYNB_SELFTEST_MUTATE=prefix-only` → **4 条转红**、
> `no-readlink-flag` → **2 条转红**。

### 9.1 本轮条目（完整清单）

| 条目 | 状态 | 处置与证据 |
|---|---|---|
| **V9-1** 🔴 内容块用文档原值 → 整次调用 `-32602` | ✅ | 块载荷改为**已解码的字节**：`src/core/outputs.ts` 的 `ExtractedImage.base64` 由刚解出的字节重新编码（`encodeBase64`，顺带补 `atob` 要求的 padding），`src/mcp/render/read.ts` 与 `src/run.ts` 的块构建只读它、不再回读文档；`src/mcp/tools/result.ts` 组装前再做一次 `isBase64Shaped` 过滤。**空值**归入同一出口：`imageBlockBase64` 拒绝空载荷，`imageDecodeProblem` 给出 `image value is empty`（V8-3 想区分的"空 vs 坏"此前在"空"这格失效）。**断言落在块层并用外部判据**：`tests/unit/image-blocks.test.ts`（14 种值形状 × SDK `CallToolResultSchema`，并断言块解码回文件字节）、集成 `tests/integration/v9-regressions.test.ts`（真 kernel：run 返回的块、盘上仍是原 data-URL、失败 run 写过的文件可再读）、`scripts/e2e-smoke.mjs`（真 stdio＋真客户端 **7 条图片断言**：run 的块与 artifact、read 的块与 artifact、`-32602` 不再发生、每个块都过 `atob`）。**D-047** |
| **V9-2** 🟠 断言只到内部投影 | ✅ | `scripts/e2e-smoke.mjs` 的 `call()` 现在收集 `type==='image'` 的块（此前只收 text，图片块对它完全不可见），并用 `atob` 当判据；`tests/unit/image-blocks.test.ts` 用 SDK 自己的 schema 判每一次结果，其中 `[V9-1] the OLD block source (the document value) is the thing the SDK rejects` 把**旧写法**交给 schema 并断言其**失败**，`[V9-3] withholds the block, keeps the text answer, and warns in the payload` 断言降级路径。实跑：`pnpm smoke` **26/26**（含 `an image output does not fail the whole tools/call`、`every returned image block carries SDK-valid base64`） |
| **V9-3** 🟡 缺"块合法性"闸门 | ✅ | `toCallToolResult` 逐块校验（非空 + `isBase64Shaped`），不合法的块**丢弃**并把 `image_materialize_failed` 追加进已序列化 payload 的 `warnings[]`；文本答案与其它块保留，解析失败则原样返回文本（**绝不**为了加警告而丢答案）。用例 `tests/unit/image-blocks.test.ts` 的 `[V9-3]` 三条：旧写法被拒、降级时文本仍在且带警告、全部合法时文本**逐字节不变**。**D-047** |
| **V9-5** 🔴 大整数 JSON 被静默四舍五入（run 还写回盘） | ✅ | 新增 `src/core/json-exact.ts`：`parseJsonExact`（递归下降，只把"看起来是整数且非安全整数"的字面量存成 marker）/`stringifyJsonExact`（marker 原文写回）；`src/core/parse.ts` 的读入与序列化、`src/kernel/protocol.ts` 的 sidecar 响应解析都改用它；`src/core/outputs.ts` 的 `jsonValueOf` 把 marker 投影成最近的 double，并生成**带精确数字**的 per-output 警告，`collectOutputWarnings` 把它升格进调用级 `warnings[]`（复用 §7 闭集内的 `output_truncated`，**零新增错误码**）。证据：`tests/unit/json-exact.test.ts`、`tests/unit/outputs.test.ts` 的 `[V9-5]`、集成 `tests/integration/v9-regressions.test.ts`（真 kernel `2**64` / `2**53+1` / `-2**63`：**盘上逐字节**与响应警告）。**D-048** |
| **V9-6** 🟠 `docs/DEVIATIONS.md` 被拼接成两份 | ✅ | 文件恢复成单份（表头 1 个、每个编号 1 行、编号从 D-001 连续到 D-049）；新增 `scripts/check-docs.mjs` 并接进 `pnpm lint`：断言表头与表头行唯一、每个 `D-0NN` 恰好一次、编号无缺口、行内列数与表头一致，且 `docs/OPEN_QUESTIONS.md` 仍是 SPEC §12 的**逐字**副本。可证伪：`--selftest` 用 **7 个变异**（整份重复、重复一行、缺号、列数断裂、重复表头、改写 Q 行、删除 Q 行）要求逐一被抓到，并以"真文档必须通过"为对照。实跑：`node scripts/check-docs.mjs --selftest` → `ok (7 mutations detected, control clean)`；`node scripts/check-docs.mjs` → `ok (1 authority document(s), SPEC §12 verbatim)` |
| **V9-7** 🟠 超时路径丢掉已收集的 warnings（v7 已修项回归） | ✅ | `src/run.ts` 的 `pushCallWarnings()` 是**唯一装配点**：成功出口与超时出口都调用它，且超时那次在 `throw … exec_timeout` **之前**（json 不等值在 cell 执行完就当场上报，被丢弃的 mime 在其写回前登记，两条都在 `pushCallWarnings` 里汇总）；丢弃警告现在带 cell 身份——`outputTruncatedWarning` 产出 `cell 3: text/plain`，同一 cell 同一 mime 去重、不同 cell 不去重。证据：`tests/unit/run-reporting.test.ts` 的 `[V7-2][V8-10]` 六条（驱动真函数）＋ `[V9-7] the run assembles those warnings in ONE place, used on every exit`；集成 `tests/integration/v9-regressions.test.ts` 的 `[V9-7]` 用**真 kernel 超时**断言 `exec_timeout` 的 detail 带 warnings。**D-042 的状态列已订正** |
| **V9-8** 🟠 hint 与行为不符、另一条规则推荐无效操作 | ✅ | `src/core/parse.ts` 的 `escapeHatchFor` 改为**按规则生成**：`execution_count_negative` 说的是真话（`clear_outputs` 不动计数，但输出清空后该计数不再被检查），`non_code_cell_has_execution_count` / `non_code_cell_has_outputs` 只推荐 `set_cell_type` 并点明 `clear_outputs` 在非 code cell 上不可用；同时 `execution_count >= 0` 的判据从"**本次请求**清空了该 cell 的输出"改为"**该 cell 此刻**没有输出"（`outputs: []`），所以照 hint 做完之后**下一次**编辑不再被同一条规则拒绝。证据：`tests/unit/edit-tool.test.ts` 的 `[V8-14][V9-8]` 四步会话 + 后续编辑、`tests/unit/run-reporting.test.ts` 的 `[V9-8] the rule is about a count that has outputs to belong to`。**D-049** |
| **V8-3 残留**（v9 §三·其余 🟡：`imageDecodeProblem` 的空值分支不可达） | ✅ | 空串/纯空白此前被判"解码成功"→ 返回 0 字节图片块 + 0 字节 artifact + **无警告**。现在 `imageBlockBase64` 明确拒绝空载荷，走解码失败出口，`text_fallback` 为 `image value is empty`。用例：`tests/unit/image-blocks.test.ts` 的 `empty string` / `whitespace only` / `empty data: URL payload` 三格（均要求无块 + `image_materialize_failed`） |
| **V8-4** 🟠 守卫不能失败 | ⚠️ **部分** | 本轮把**装配点**钉住：`tests/unit/run-reporting.test.ts` 断言全仓只有一处 `= outputTruncatedWarning(`（且必须落在 `pushCallWarnings` 体内），并断言超时出口的装配调用**早于** `throw new IpynbError('exec_timeout'`；`[V7-8]` 那条也从"断言源码文本"改成驱动真 `IpynbError` + `toCallToolResult`。**未收口**：这条 pin 仍是**读源码**的断言，而 V8-4 的原始判据是"守卫必须能被变异打红"；行为层证据在集成 `[V9-7]`（真超时）。见 9.3 |
| **V8-5** ⚠️→✅ 死导出与第六份 venv 复制 | ✅ | `tests/unit/analyze-op.test.ts` 删掉第六份 venv 逻辑（原占据该文件 `:19-214`），改为从 `tests/integration/test-venv.ts` 导入 `prepareVenv` / `BASE_PYTHON` / `TEST_VENV_PY` / `resolvedTestInterpreter`；死导出 `usableInterpreter` 删除（全仓只剩一处注释提到它）。证据：`npx vitest run --reporter=dot` **432 passed / 28 文件**（实跑） |
| **V8-6** 🟠 清扫判活：后缀误当 pid、Windows 退化 | ✅ | `python/ipynb_sidecar.py` 的 `_owner_pid` 改为**按位置**读：名字必须是 `ipynb-mcp-<kernelId>-<pid>-<random>.json`，最后一段是 mkstemp 的随机后缀（字符集校验），**倒数第二段**才是 pid（ASCII 数字、2–10 位、`< 2^31`），否则返回 `None`（不可归属 ⇒ 走 7 天保守年龄）；Windows 不再用 `os.kill(pid, 0)`（CPython 在 Windows 上把它实现为 `TerminateProcess`），改为 `OpenProcess` + `WaitForSingleObject`：`WAIT_OBJECT_0` ⇒ False（确证已死）、`WAIT_TIMEOUT` ⇒ True、打不开/`WAIT_FAILED` ⇒ `None`（**绝不把"判不了"说成"可以删"**）。年龄阶梯：活着不动 → 确证已死 = `ORPHAN_CONNECTION_AGE_SECONDS`（1 h）→ 探针可用但被拒 = 24 h → 平台无探针 = 7 天。证据：`python scripts/check-connection-sweep.py` 本机实跑 **PASS**（15 条归属规则 + 11 条清扫行为 + 2 条探针，含"全数字随机后缀不得被当 pid"与"活属主 + 上古文件必须留"）；本轮另把该检查器接进 **CI 的 integration job**（`.github/workflows/ci.yml`，见 9.3） |
| **V8-8 / V9-4** 🟡 `linux-check.sh` 的 `WORK` 守卫可被 `..` 绕过（v9 报告正文按 V8-8 编号，§四 维度段写作 V9-4） | ✅ | `guard()` 按顺序：空值 → 非绝对 → **原始值含 `..` 段**（`has_segment`，归一化之前）→ `readlink -m` 归一化（`-m` 不可用才退 `readlink -f`，两者都不可用或解不出来就**拒绝并说明**）→ 归一化后再查 `..` → 等于某个允许根 → 是 `/` 或 `$HOME` → 必须落在 `/tmp`、`/var/tmp`、`$HOME/tmp` 之下；新增 `--selftest` 与 `--guard <path>`。证据（本机 WSL 实跑）：`cases=26 failed=0`、`SELFTEST PASSED`；判别力：`IPYNB_SELFTEST_MUTATE=prefix-only` → **4 条转红**（`/tmp/../etc`、`/var/tmp/../etc`、`/tmp/..////etc`、`/tmp/a/../b`），`no-readlink-flag` → **2 条转红**（`/tmp/ok/sub`、`$HOME/tmp/x`）并打印 `readlink -f (fallback)`。第八轮那行的"实测"已按订正说明撤回 |
| **V8-9** 🟠 两点残留（`lib/*` 不可失败、两守卫互斥） | ✅ | `scripts/check-package.mjs` 重写为**纯检查 + 常驻变异矩阵**：`lib` 的模块清单**派生**自构建输出（`files` 漂移即红，不再手写不可失败的 `REQUIRED` 行），入口按 `package.json#bin` 断言、shebang 从**构建产物**读；`scripts/check-connection-sweep.py` 开头设 `sys.dont_write_bytecode = True`。证据（本机实跑）：`node scripts/check-package.mjs` → `ok (140 files, 22 mutations detected)`；`npm pack --dry-run` → `total files: 140`；跑完 sweep 后 `python/__pycache__` **不存在**且 `check:package` 仍绿（两个守卫不再互斥） |
| **V8-11** 🟡 权威问错解释器 | ✅ | `tests/integration/run.test.ts` 的 nbformat 权威改为 `nbformatSkipReason(authorityInterpreter())`，而 `authorityInterpreter()` 返回 `test-venv.ts` 记录下来的 `resolvedTestInterpreter()`（即**这次实际选中**的解释器，默认 base）；`fixtures-valid.test.ts` 用的也是搜索选中的那个。证据：全仓 `nbformatSkipReason(` 的调用点只有 `run.test.ts`（两处，均经 `authorityInterpreter()`）与 `fixtures-valid.test.ts`（选中解释器） |
| **V8-12** 🟡 单测删掉集成正在用的 venv | ✅ | `vitest.config.ts` 加 `fileParallelism: false`（与集成配置一致，理由写在注释里）；新增 `tests/unit/test-venv-ownership.test.ts`，用**真实 helper** 在隔离目录上钉住所有权规则：带 marker 的自己人 venv 不可用才删、**外来 venv（无 marker）绝不删**并回退 base、`requireVenv` 失败时也不删。证据：`npx vitest run --reporter=dot` 全绿（432 passed / 28 文件，含该文件 3 条） |
| **V8-17** 🟡 `check-indent` 守卫不可证伪 | ✅ | `scripts/check-indent.mjs` 的自测矩阵重构为**带标签的 28 个样本**（上一版 16 条分支变异基线只抓到 3 条），`SAMPLE_COUNT` 参与断言，矩阵为空即失败。证据（实跑）：`node scripts/check-indent.mjs` → `structural indent check: ok (28 self-test samples passed)`；`pnpm lint` 里同时跑它 |
| **卫生**（`mutate-pkg.mjs` 被跟踪、`.gitignore` 家族不全） | ✅ | 删除仓库根的 `mutate-pkg.mjs` 与 `patch-v88.mjs`（两者都已不在盘上）；`.gitignore` 补上 `/mutate-*.mjs`、`/mutate-*.cjs`、`/mutate-*.js`（第六次同类事故）。证据：`git ls-files` 的输出里含 `mutate`/`patch-`/`probe-` 的条目为空 |

> **第八轮表（§8.1）的订正**：v9 复核证伪或降级了其中 10 行，本轮已就地标注（**V8-3**、**V8-4**、**V8-5**、**V8-6**、**V8-10**、**V8-11**、**V8-12**、**V8-13**、**V8-15**、**V8-17**：
> 分别为"空值分支不可达"、"删掉调用点仍全绿"、"死导出与第六份复制仍在"、"后缀误当 pid + Windows 退化"、"超时路径丢掉 warnings 且 message 丢 cell 身份"、
> "**根本没改**（`run.test.ts` 仍问 `VENV_PY`）"、"**注释与代码相反**且删除仍会发生"、"`.gitignore` 家族没补全（第六次同类）"、"`analyze-op` 的注释修反"、"标 ✅ 却引用 §8.3 的'未做'"）。
> 其中 V8-11、V8-12 原文与代码不符，按本文件的撤回约定改为删除线 + 指向本节；V8-8 的订正说明见 §8.1 之后那段。

### 9.2 新增硬规则（`AGENTS.md` §9）

> **断言要断言到消费者真正拿到的那一层。** 数据形状有**四层**：① 内部投影 → ② 模型读到的内容块（`OutputItem` / `content[]`）→
> ③ 文件字节 → ④ 协议帧。形状类修复**至少**要断言到 ②，涉及写回/存储的再带上 ③，能走真链路的一律走 ③④。
> **单个字段的缺陷不得升级为工具级失败。** 默认出口是 warning + 降级项；只有"协议帧完整性"与"文件字节完整性"才允许升级为工具级失败。

两条都是本轮用真金白银换来的：V9-1 的根因不是能力问题，而是**测试层次选错**（断言停在 ①，用户拿到的是 ②，SDK 在 ② 上抛 `-32602`）；
V9-3/D-047 则把"组装结果"这一层也纳入了闸门——**不能假定生产者永远正确**，协议错误与产品错误的边界要由我们守。

### 9.3 未做，与原因 / 残留

- **V8-4 未收口**：`tests/unit/run-reporting.test.ts` 的"单一装配点"断言仍读 `src/run.ts` 的**源码文本**。它比 v8 那版强（删掉任一调用点、或把装配挪到 throw 之后都会红），但按 V8-4 的判据仍不是行为断言；
  行为层的对应证据在集成 `[V9-7]`（真 kernel 超时 → detail 带 warnings）。要彻底收口需要把 `run.ts` 的出口做成可注入的纯函数，属重构。
- **`scripts/check-connection-sweep.py` 不放在 `pnpm lint` 里**：它需要 `python`，而 `pnpm lint` 必须在**没有 Python 的机器上**通过（AGENTS §3）。本轮把它做成可独立运行且不写字节码（`sys.dont_write_bytecode = True`），并接进 **CI 的 integration job**（`.github/workflows/ci.yml`，紧跟 `pnpm build` 之后，那里本来就有 Python 与 `ipykernel`）—— 这同时回答了 v9 报告"检查器未接入任何门禁"那一条。
- **`docs/DEVIATIONS.md` 的 D-046 影响面措辞待订正**（该文件由下一批改动负责）：它还写着"`os.kill(pid, 0)` 判活；平台判不了时退化为……"，
  而现状是 Windows 用 `OpenProcess`/`WaitForSingleObject` 真探针、确证已死只等 1 h。**代码是权威**，措辞按本节 V8-6 行。
- **`scripts/check-package.mjs` 的"草稿脚本"规则**：`FORBIDDEN` 里写的是 `^(probe|patch)-`，`mutate-*` 由"根目录不得有 `.mjs/.js/.cjs/.ts`"那条兜住 —— 能红，但失败信息会归到另一条规则名下。属可读性问题，未改。
- **v9 报告 §五.4 的建议 ② 与仓库现状不符**（记录在案，免得下一轮照着它做）：`pnpm smoke` 早在第八轮整改时就已进入 CI 的 integration job
  （`git show HEAD:.github/workflows/ci.yml` → 第 90 行 `- run: pnpm smoke`，第 86 行 `- run: pnpm check:package`），所以"19/19 目前只是本机"这条不成立。
  本轮 smoke 的唯一缺口是**本轮尚未在 CI 上跑过**（本机 26/26，CI 结果看下一次运行）。

## 〇-6、第八轮（`ipynb-mcp-code-review-v8.md`）

> 第八轮的两条 TOP 都指向同一件事：**v7 的修复只覆盖了等价类的一半，而 v7 的复验也只跑了上一轮点名的那一格**。
> 因此本轮把"修数据形状缺陷 = 补该字段全部合法类型的矩阵 + 逐项先红后绿"写进 `AGENTS.md` §9（见"新增硬规则"一节），
> 并且**先写矩阵、眼见 79 条红**，再动实现。

### 8.1 本轮条目（完整清单）

| 条目 | 状态 | 处置 |
|---|---|---|
| **V8-2** 🔴 `application/json` 的**字符串值**被静默改写 | ✅ | `jsonValueOf` 不再做任何转换：`"123"` 保持字符串、`"hello"` 不再被降级成 `text/plain`、mime 不再被改写。**真实 kernel cell 复现并验证**（4 次 `display(..., raw=True)`，盘上与响应逐字节一致）。矩阵 19 类型 × 5 个 json mime = 95 条，**改代码前 79 条红** |
| **V8-1** 🟠 `+json` 一族读不回 | ✅ | 键查找改用 `isJsonMime`（与写方向同一条规则）；`unsupported` 的 message 现在说明"值原样保留在文件里"，因为"unsupported output type"读起来像"这个输出是空的" |
| **V8-4** 🟠 本轮新增的守卫**不能失败** | ⚠️ **部分**（v9 复核：删掉 `run.ts` 的调用点仍全绿；第九轮已把装配点钉住，见第九轮段） | 三个假守卫全部换掉：不再"自己演一遍产品的 if"，不再断言**源码字符串**（把行挪进注释也能过），不再用与标题无关的用例充数。规则下沉到 `core/outputs.ts`（`outputTruncatedWarning` / `countTruncatedCells`）以便直接驱动；sidecar env 用例改为构造真实 `SidecarTransport` 并读它实际传给子进程的 env。**复跑评审的 M1/M1b/M4/M6/M7/M8 六个变异，全部变红**（M1/M4 此前是绿的） |
| **V8-14** 🟠 拒绝时推荐的出路本身被拒 | ~~✅~~ ⚠️ **部分**（v9 复核：`clear_outputs` 确实能成功了，但 hint 文案不实、非 code cell 那条规则推荐了会被 `invalid_ops` 拒掉的操作；第九轮已修，见第九轮段 V9-8） | `clear_outputs` 曾被同一条 `execution_count_negative` 拒绝。**没有改 `clear_outputs`**：SPEC §4.5 规则 5 明写它不动 `execution_count`，所以改的是**我们的**闸门 —— `SelfCheckScope` 增 `clearedOutputCellIndexes`，被本次操作清空输出的 cell 不再受 cell 级计数规则约束（规则与它所属的 outputs 一起消失）。hint 改为按规则生成（`escapeHatchFor`）。四步会话 + 两条"没有放水"用例；三个变异（关掉 skip、把 skip 放宽到整个请求、恢复通用 hint）全部变红 |
| **V8-9** 🟠 发布产物带 `.pyc` | ✅ | `files` 从 `"python"` 改为 `python/*.py`（133→132 文件）；新增 `scripts/check-package.mjs` 断言**产物形状**（不含编译产物/源码/测试/内部文档/草稿脚本，且入口、server、sidecar 都在），接入 `pnpm check:package` 与 CI。**我前两版断言写错了**（把 source map 与 bin 的可执行位当缺陷），已删掉而不是留成永久噪音 |
| **V8-6** 🟠 清扫只按年龄 | ~~✅~~ ⚠️ **部分**（v9 复核：归属规则把 mkstemp 的全数字随机后缀当成 pid → 实测删掉活属主的文件；Windows 上全部退化为 7 天；第九轮已按位置判 pid 并加 Windows 真探针，见第九轮段） | 改为按**文件名里的 pid** 判活（`mkstemp` 的 prefix 就带着它）；判不了 pid 的平台退化为"无 pid 且超过一周"。另一个 bug 一并修：一个判不了的文件会中断整轮扫描却仍报部分计数 |
| **V8-7** 🟠 sidecar 越界未登记 | ✅ | 登记 **D-046**（含"为什么不放到 Node 层"：Node 看不见连接文件路径） |
| **V8-5** ⚠️→✅ 新 helper 零调用 | ~~✅~~ ⚠️ **部分**（v9 复核：`usableInterpreter` 仍零调用、`analyze-op.test.ts` 里的第六份复制仍在；第九轮已删干净，见第九轮段） | `prepareVenv()` 真正承担"建/校验/回退/不留下不可用 venv/尊重 `IPYNB_TEST_REQUIRE_VENV`"，五个集成文件全部改为调用，各自不再建 venv |
| **V8-11** 🟡 权威问错解释器 | ~~✅~~ **撤回：v8 这行与代码不符**（v9 复核：`run.test.ts:910` 当时仍问 `VENV_PY`，而 run 用的是可能回退到 base 的 `sidecarInterpreter`）。**第九轮已真修，见第九轮段** | ~~`nbformatSkipReason` 改为问**搜索实际选中的那个**解释器~~ |
| **V8-3** 🟡 data-URL 图片与含糊诊断 | ⚠️ **部分**（v9 复核：空值会被判"解码成功"→ 产出 0 字节图片块 + 无警告，"空 vs 坏"在"空"这格失效；第九轮已修，见第九轮段） | 接受 `data:<mime>;base64,` 前缀；解不出来时 fallback 文本说明原因（"空"与"坏"必须能区分） |
| **V8-10** 🟡 一条 message 两个计数 | ⚠️ **部分**（v9 复核：合并计数做到了，但超时路径重新丢掉"值被丢弃"的提示、message 丢掉 cell 身份；第九轮已修，见第九轮段 V9-7） | 丢弃与截断共用一条 `output_truncated`，message 同时给出两个计数 |
| **V8-8** 🟡 `..` 绕过 WORK 守卫 | ~~✅~~ **撤回：第八轮没做，这行是虚报；第九轮（V9-4）已真修** | **旧说法（不实，原文保留在此）**：~~"先拒绝任何含 `..` 的值，再 `readlink -m` 归一化后判前缀。WSL 实测：`/tmp/../etc`、`/`、`/tmp`、`/var/tmp`、`$HOME`、`/home/x/notebooks` 全拒，`/tmp/ok-check` 放行"~~。**核实**：`git diff HEAD -- scripts/linux-check.sh` 与 `git diff c78e36f~1 c78e36f -- scripts/linux-check.sh` **均为空**，第八轮该文件一行未动，所以那串"实测"没有对应的代码，属于无证据的 ✅。**现行为**：`guard()` 按顺序做下列检查，每道失败都打印**点名的那一项**——`empty-check`（空值）/ `absolute-check`（非绝对路径）/ `dotdot-check`（原始值含 `..` 段，**归一化之前**）/ `normalize-check`（`readlink -m` 归一化，仅当 `-m` 不可用时才退回 `readlink -f`，两者都不可用或解不出来则**拒绝并说明**，不静默放行）/ `root-check`（归一化后等于某个允许根本身）/ `toplevel-check`（归一化后是 `/` 或 `$HOME`）/ `temp-root-check`（归一化后不在 `/tmp`、`/var/tmp`、`$HOME/tmp` 之下）。新增 `--selftest` 与 `--guard <path>`。**自测实测（WSL，本机执行）**：`bash scripts/linux-check.sh --selftest` → **cases=26 failed=0，`SELFTEST PASSED`，退出码 0**（含 `/tmp/../etc`、`/var/tmp/../etc`、`/tmp/..`、`/tmp/.`、`/tmp/../etc` 的变体 `/tmp/..////etc`、`/tmp/a/../b`、`/`、`/tmp`、`/var/tmp`、空值、`.`、`foo/bar`、`$HOME`、`$HOME/tmp`、`$HOME/notebooks` 全拒；`/tmp/ipynb-linux-check`（脚本默认值）、`/tmp/ok-check`、`/tmp/ok/sub`、`/var/tmp/ipynb-linux-check`、`$HOME/tmp/x` 放行）。判别力实测：`IPYNB_SELFTEST_MUTATE=prefix-only`（拿掉 `..` 预检、只留归一化前缀判据）→ **4 条转红**；`IPYNB_SELFTEST_MUTATE=no-readlink-flag`（强制 `readlink -f` 退路）→ 2 条转红并打印 `normalizer : readlink -f (fallback)`。越界实测：`WORK=/tmp/../tmp/ipynb-guard-sentinel` 在 `rm -rf` **之前**退出码 2，哨兵目录仍在 |
| **V8-12** 🟡 共享 venv 生命周期文档不实 | ~~✅~~ **撤回：v8 写的注释与代码相反**（v9 复核：实测把带 marker 的健康 venv 交给单文件运行仍会被删；`vitest.config.ts` 当时也没有 `fileParallelism`）。**第九轮已真修，见第九轮段** | ~~`test-venv.ts` 头部改为描述**实际**行为（健康的 venv 作为缓存保留，只有不可用的才删），并说明为什么~~ |
| **V8-13** 🟡 跟踪的草稿脚本 | ⚠️ **部分**（v9 复核：三个脚本确实清了，但"整个家族"没补全 —— `mutate-pkg.mjs` 这一轮又被跟踪；第九轮补上 `/mutate-*`，见第九轮段） | 删掉三个被跟踪的 probe/patch 脚本；`.gitignore` 补上整个家族（第五次同类事故） |
| **V8-15** 🟡 注释/文档不实 | ⚠️ **部分**（v9 复核：README 那半是真修；`analyze-op` 的新注释与代码**相反** —— 第九轮已随第六份复制一起删掉，见第九轮段） | README 的集成 venv 路径改为事实（临时目录 + `IPYNB_TEST_VENV` 覆盖）；`analyze-op` 的 `afterAll` 注释改为描述真实行为 |
| **V8-16** 🟡 v5 表遗留 ✅ 与 v6/v7 段冲突 | ✅ | 两行改为删除线 + 指向撤回处 |
| **V8-17** 🟡 `disableConsoleIntercept`/守卫标注 | ~~✅~~ ⚠️ **未做**（v9 复核：行内标 ✅ 却指向 §8.3 的"未做"，`check-indent.mjs:195` 改成 `if (true)` 仍 exit 0。**第九轮已真修**：28 个带标签样本，见第九轮段） | 见 §8.3（记录为"未做，原因"） |
| **D-044 措辞超前** | ✅ | 范围改为"v7 写下时只有字面量 key 的非字符串值成立" |

> **V8-8 的订正说明（第九轮补记，2026-10-04）。** 第八轮的 ✅ 为什么是虚报：那一轮的改动清单里**没有** `scripts/linux-check.sh`（`git diff` 为空），
> 而这一行的措辞是照着"修复建议"写的、不是照着代码写的 —— 这正是本文件头部警告的同一类事故（"标 ✅ 但代码里不存在"），也是 V8-8 与 V8-16/V8-17 处理方式不同的原因：
> V8-8 不是"改了但没验证"，而是**根本没改**。本次真修按 v8 修复建议的两步做（先拒 `..` 原始值，再归一化后判前缀），并补上**可失败的**自测矩阵，
> 因为"守卫自己不能失败"等于没有守卫（`AGENTS.md` §9）。`/tmp/a/../b` 这类"归一化后回到临时根内部"的值**选择拒绝**（归一化后本就是 `/tmp/b`，安全，但 `..` 预检一律不放行）：
> 这是一条单一规则，成本只是一条错误消息，且不依赖"这个 `..` 恰好无害"的判断。自测在本机 WSL 实跑，证据见上表该行。

### 8.2 新增硬规则（`AGENTS.md` §9）

> **修数据形状缺陷 = 补该字段的「全部合法类型」矩阵 + 逐项先红后绿。**
> **等价类是复验的单位，不是"上轮点名的那一格"。**

这两条是本轮最贵的产出：v7 修了 `application/json` 的非字符串值就收工，v8 在**字符串值**与 `+json` 上又栽一次；
而 v7 的复验只跑了自己点名过的那几个形状，所以同族的未修分支活过了一整轮。规则对实现者与复验者**同时**成立。

判据写得很硬：**如果新增的矩阵项在改代码之前就是绿的，那它没有覆盖任何缺陷**。本轮 95 条里 79 条先红，满足这条判据。

### 8.3 未做，与原因

- **V8-17**（`disableConsoleIntercept` 未登记、守卫标注）：本轮**未改**。它属于"sidecar 与 ipykernel 的交互细节"，
  需要先确认该选项在我们的启动路径上是否真的被设置为有意义的值；在没有实测证据前改注释只会把一种不准确换成另一种。
  与本轮的 D-046 同族（都是 sidecar 边界），建议与下一次 sidecar 变更同批做。
- **V8-12 的另一半**（"共享 venv 的生命周期"）：`test-venv.ts` 已经承担建/校验/回退，vi 的 `globalSetup` 级别复用
  需要先决定"哪个进程拥有这个 venv"，属设计判断；本轮的注释已经如实描述现状，不再声称不存在的安排。

> **第九轮补记**：本节两条都已在第九轮落地，但走的是与本节设想不同的路 —— **V8-17** 改用"28 个带标签样本 + 矩阵为空即失败"把
> `check-indent.mjs` 的守卫变成可失败的；**V8-12 的另一半**没有做 `globalSetup` 级复用，而是 `vitest.config.ts` 的
> `fileParallelism: false` 加 `tests/unit/test-venv-ownership.test.ts` 的所有权用例（理由与证据见第九轮段对应两行）。


## 〇-7、第七轮（`ipynb-mcp-code-review-v7.md`）

> 第七轮的核查对象是**读方向**、**守卫之间的一致性**，以及**文档与代码是否相符**。
> 它给出的三条 TOP：V7-1（读方向把合法的 `application/json` 静默改写/丢弃）、P0-a（唯一的外部权威在唯一的自动化环境里恒缺席）、
> V7-3 + V7-2（fixer 与 checker 对合法一行 `case` 结论相反；`output_truncated` 一次发 2–3 条）。三条都已修复并做了变异验证。

### 7.1 本轮条目（完整清单）

| 条目 | 状态 | 处置 |
|---|---|---|
| **V7-1** 🔴 读方向静默改写/丢弃合法 json | ✅ | `RawOutput.data` 放宽为 `Record<string, unknown>`，json mime 的值原样保留、json 分支直接产出；9 种合法形态（数组/对象/数字/null/布尔/嵌套/空）逐一断言"原样 + 无警告"；不可解析的**字符串**仍按 §5.4 第 7 行降级为 `text`。**D-044** |
| **P1-b** 🟠 响应侧 `text` 可以不是字符串 | ✅ | 每个文本类 mime 经 `mimeText()` 窄化；`text/plain: 5` 不再产出 `text: 5`（与盘上 `data: {}` 一致） |
| **V7-4** 🟠 探针 stdout 注入 `install_command` | ✅ | stdout 截断到 4 KiB 且必须**整体等于**白名单里的模块名，否则退化为固定清单。**注意**："取第一个空白分隔的 token" 这类更弱的规则**仍然放行**注入串（注入串恰以真模块名开头），这正是第一版修法失败的原因，已写成注释与用例 |
| **V7-6** 🟠 不存在的解释器被报成缺 ipykernel | ✅ | `ProbeResult.status` 恢复；`not-found` 的 reason 是 `not found`，且**不给** `install_command`（SPEC §5.2 要求命令取自"存在但缺模块"的候选） |
| **P0-a** 🔴 外部权威在 CI 恒缺席且绿灯无痕 | ✅ | 两条断言不再被 `if` 挡住；用例缺权威时 `context.skip(原因)`；CI 装 `nbformat` + `IPYNB_REQUIRE_NBFORMAT=1`。两向变异验证。**D-043** |
| **P1-a** 🟠 cell 级 `execution_count < 0` 未进闸门 | ✅ | 闸门在要求 `outputs` **之前**检查 cell 自身的计数（计数在 cell 上）；run 侧对内核计数与恢复的保存计数都做归一化（`representableExecutionCount`） |
| **V7-2** 🟠 `output_truncated` 一次发 2–3 条 | ✅ | run 路径去重（与读路径一致）；保留的那条是"带 cell 与 mime"的信息性消息。**D-042** |
| **V7-8** 🟡 `exec_timeout` 的 detail 缺 `warnings` | ✅ | 与 `failedRunError` 同形，把已收集的警告带进失败详情 |
| **P1-c** 🟠 连接文件残留 + env 整体替换 | ✅ | `env` 改为与父环境**合并**（此前整体替换，导致 sidecar/kernel/cell 没有 PATH/TEMP/HOME）；sidecar 显式传 `dir=` 且拒绝 `gettempdir()` 的点号回退。清理了仓库根 45 个含 HMAC key 的连接文件 + 15 个 `tmp*.json` + `%TEMP%` 里 50 个 |
| **V7-3** 🟠 fixer 与 checker 自相矛盾 | ✅ | 两者共用 `ownsLine`：fixer 跳过同行节点，checker 在 switch 分支也跳过（在 `checkStatements` 仍**报告**，那是另一回事）；合法的单行 `case` 进入 checker 的 CLEAN 自测样例 |
| **V7-5** 🟠 集成测试仍在仓库里建 18.3 MB venv | ✅ | `tests/integration/test-venv.ts` 统一决定位置，5 个文件改为导入；仓库里那份已删除；README/COMPATIBILITY/CHANGELOG 口径统一 |
| **V7-9** 🟡 `absolutePath` 的 `platform` 是死参数 | ✅ | 去掉参数，并把"任一方言绝对即保留"这条**宿主无关**规则与其后果写清楚 |
| **V7-10** 🟡 `JSON_MIME` 比 nbformat 严 | ✅ | 改用 nbformat 自己的 `patternProperties`：`^application/(.*\+)?json$`（`application/x/y+json`、`application/+json` 此前被丢/拒） |
| **V7-11** 🟡 新增同款重复 `lockErrno`/`errnoCode` | ✅ | 合并为 `fs/atomic.ts` 的 `lockErrno`，`notebook-file.ts` 改为导入 |
| **V7-13** 🟡 `rm -rf "$WORK"` 无校验 | ✅ | 拒绝 `/tmp`、`/var/tmp`、`/` 与其外的任何路径 |
| **V7-14** 🟡 环境变量驱动的 `rmSync` | ✅ | 归属标记文件（`.ipynb-mcp-test-venv`）：只删自己建的，拒绝时打印原因，并在 `afterAll` 也清理 |
| **V7-12** 🟡 每次写入无条件 `structuredClone` | ⚠️ **登记未改** | 该拷贝只在"拒绝"路径被读，但惰性化需要把 thunk 穿过写入路径；评审自己定性为性能提示而非缺陷。保留在"剩余事项"，与下一次接口变更同批做 |
| **WARN-CODE-2** 🟡 语义借用未登记 | ✅ | 登记 **D-041**，并给 message 加固定前缀 `pre-existing-content: `，客户端不必从码推断含义 |
| **TRUNC-CODE** 🟡 语义借用未登记 | ✅ | 登记 **D-042**，message 带 dropped 计数与 mime，并写明"若 v3.1 愿新增专用码，改一处即可" |
| **NEW-2** 🟠 分工漂移 | ✅ | `mode` 不再是 schema enum（它会让 SDK 抢答 -32602），四个枚举型参数统一为"schema 声明形状 + 工具层校验值"；新增用例断言不合法的 mode 返回 `invalid_arguments`。变异验证 |
| **H-7** 🟡 R3 的 `cellInFlight` 未登记 | ✅ | 登记为 D-045 |
| **TST-4** 🟡 工具层 `markdown_invalid` 真写守卫 | ✅ | 新增**非 dry_run** 用例：坏 markdown 必须让文件字节不变且 `applied` 不出现；变异（关掉闸门）验证会红 |
| **V7-15** 🟡 两文档数字互斥 | ✅ | 以实测为准统一（见门禁段），并写明两份文档由同一次验收同时更新 |
| **工作树未提交** 🟡 hygiene | ✅ | `AGENTS.md` 的改动已随本轮提交入库 |
| **NEW-6** 🟢 stderr 尾巴挂到无关失败上 | ⚠️ **仍未收口** | 第六轮那行是虚报（只改了 `!this.alive` 一支）；本轮如实标 ⚠️ 并保留，因为"哪次失败与 stderr 有关"需要先定义，属设计判断而非机械修改 |
| **D-033 措辞** | ✅ | 已订正（`docs/DEVIATIONS.md` 的 D-033 行） |

### 7.2 本轮的验证方式

- 每个新守卫都做了**变异**：V7-4（退回"取第一个 token"→ 红）、V7-6（无条件给命令 → 红）、NEW-2（退回 schema enum → 红）、
  TST-4（关掉 markdown 闸门 → 红）、P0-a 两向（required → 失败；optional → 可见 skip）。
- V7-1 用**九种** nbformat 合法的 json 形态逐一断言，而不是只复查评审举的那一种。
- `analyze-op` 的两条失败最终查明是**测试自身的缓存污染**：模块级 `probeCache` 按候选路径作键，前一个用例的结论替后一个用例的假世界作答 ——
  于是"实现明明已修"却始终为红。改用每条用例一个空缓存后立刻转绿；这条经验（被测世界与缓存必须同生命周期）写进了注释。
- 本轮**没有**再出现"声称已修但代码里没有"：三条第六轮虚报逐条订正为真实状态，其中两条在本轮真正做完，一条如实标 ⚠️。

## 〇-8、第六轮（`ipynb-mcp-code-review-v6.md`）

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
| **NBFORMAT-GATE-SILENT** 🟡（v5 漏列） | ✅ **第七轮才真做**（第六轮这行是虚报：代码里仍是裸 `if (NBFORMAT_AVAILABLE)`，全仓无 `it.skip`） | 断言不再被 `if` 挡住，改为无条件执行；两个用例在缺权威时 `context.skip(原因)`（原因进测试名）；CI 装 `nbformat` 并设 `IPYNB_REQUIRE_NBFORMAT=1`，缺权威在那里是**失败**。两向变异验证（required→失败、optional→可见 skip） |
| **SCOPE-DEFAULT** 🟡 | ✅ | `move_cell` 不再进闸门 scope（纯重排不改 cell 字节）：`ChangedCell.content_changed` 区分"改写"与"重排"，`edit.ts` 按它过滤。scope 缺少默认值时的行为（`undefined` = 整份文档）保留给"创建文档"场景，调用点只有两个且都显式传入 |
| **SCOPE-REFUSE-HINT** 🟡 | ✅ | 拒绝的 `detail` 现在带 `pre_existing: true/false` 与 `hint`（指向 `clear_outputs`/`set_cell_type` 这条唯一出路）。判定方式：把**写前的文档**（`originalDoc`）也用同一 scope 跑一遍闸门，规则与 cell 相同即视为"本来就存在" |
| **SCOPE-SUCCESS-INVALID** 🟡 | ✅ | README 明说：保留历史内容的代价是**成功写入后文件仍可能不过 `nbformat.validate`**，本工具不会替你重写历史 |
| **NEW-2** 🟡（v5 漏列） | ⚠️ 部分 | `timeout_seconds` 用 `.int()`。广播枚举**保留在工具层**：schema enum 会让 SDK 抢先返回协议错误，而 U27 要求枚举违规返回 `invalid_arguments`——两者冲突，需 SPEC 裁决（列为剩余事项） |
| **DEP-2** 🟡（v5 漏列） | ✅ | `src/server.ts` 用 `createRequire` 读 `package.json` 的 version；单测 + `pnpm smoke` 各一条断言（19/19 里的"the server reports the version in package.json"） |
| **QUAL-2** 🟡（v5 漏列） | ✅ | `isAbortCause` 统一到 `core/errors.ts`（唯一实现），`edit.ts` 改为 re-export，`run.ts` 删掉逐字同构的副本 |
| **FID-6 注释** 🟡（v5 漏列） | ✅ | 传输层注释改为与收缩后的常量一致；sidecar 里 `SHELL_REPLY_BUDGET_SECONDS`/`INTERRUPT_GRACE_SECONDS` 成为具名常量并镜像到 `sidecar-transport.ts`（含"为何仍要计入预算"的说明） |
| **NEW-6** 🟢（v5 漏列） | ⚠️ **第六轮这行不实**（只改了 `!this.alive` 那一支，`#failureDetail()` 仍只要缓冲非空就附 `sidecar_stderr`）；**第七轮仍未收口** | 逐支修需要先定义"哪次失败与 stderr 有关"，属设计判断；本轮只登记真实状态，不再标 ✅ |
| **TST-2/3/4/5**（v5 漏列） | ⚠️ 三条已修、一条部分 | TST-2 `acquireRun` 调用点覆盖（新用例）、TST-3 `[I18b]` 扩到三 cell、TST-4 工具层 `markdown_invalid` 真写守卫：均已补。TST-5：U20 的 venv 改到 `os.tmpdir()` 并清理（不再落仓库），但单测并行度保持默认——六个文件各自用独立临时目录，串行只会让单测慢一倍（理由记在 `COMPATIBILITY.md`） |
| **DOC-DROP** 🟡 | ✅ | 本文件头部的规则 + v5 的 18 条覆盖表 + 四条被 v4/v5/v6 证伪的旧 ✅ 改为撤回；第六轮条目即本节 |
| **DEV-CLAIM-FALSE** 🟡 | ⚠️ **第六轮这行不实**（`git diff` 显示 D-033 一行未动，仍写"超时在 `timeoutMs` + 约 5 s 内返回"）；**第七轮已订正** | D-033 的数字改为实测口径并写明关闭是异步的（见该行） |

### 6.3 本轮新增的验证能力

- **Linux 实跑**（`scripts/linux-check.sh`）：本机是 Windows，而 CI 的失败全在非 Windows 上。该脚本把 tracked 文件复制到 WSL 的 Linux 文件系统、按 lockfile 安装、跑 typecheck/lint/单测。本轮四次 Linux 全绿（最近一次 **239 passed + 1 skipped，20 文件**），CI 的两个 P0 因此有本机可复现的验证，而不是"改完希望它对"。
- **缩进检查器自测**：`check-indent.mjs` 每次运行都会对 11 个构造的错位样本 + 1 个干净样本做自测，"某个构造不再受检"会直接失败——这正是 `if` 覆盖死掉两轮却没有信号的原因。
## 〇-B、第五轮（`ipynb-mcp-code-review-v5.md`）—— 完整条目清单

> 第六轮指出这一轮只列了 8 条、漏了 10 条（其中 INDENT-HOLE 是它 TOP-3 的第 3 条）。
> 下表补齐全部 18 条及其**本轮（第六轮）的处置**。

| v5 条目 | 五轮状态 | 六轮处置 |
|---|---|---|
| GATE-1 闸门审整份文档 | ✅ 已修 | ✅ 复验通过（六轮用同一复现复跑）。产物：`SelfCheckScope.touchedCellIndexes`（`src/core/parse.ts`） |
| GATE-2 比 nbformat 严 | ✅ 已修 | ✅ 复验通过。产物：`findStructuralProblem` 的 `lenientKinds` 分支 |
| GATE-3 `execution_count` 类型 | ✅ 已修 | ✅ 复验通过。产物：`execution_count_not_an_integer` 规则与 `tests/unit/run-reporting.test.ts` |
| FRAME-1 守卫恒真 | ✅ 已修 | ✅ 复验通过（两个变异各命中一条断言）。产物：`tests/unit/run-reporting.test.ts` 的 `[V10-5]` |
| **INDENT-HOLE** `if` 体不受检 | ⬜ **漏列** | ✅ **本轮修复**：`check-indent.mjs` 重写（`thenStatement`/`else`/`switch`/箭头/访问器 + 自测 + "语句必须独占一行"），并用它发现并修好了 `run.ts` 等 5 个文件里 68 行真实错位 |
| **NEW5-REPRO** 终态可二次翻转 | ⬜ **漏列** | ✅ **本轮修复**：`RunStore.settle()` 单写者 + `progress.completed` 收口 + 写回前 abort 复查 |
| **TST-CI** 用例全绿但 exit 1 | ⬜ **漏列** | ✅ **本轮修复**：`settled = inflight.then(...)`，在 kill 之前挂上 handler；I15 的相位错误同时修掉 |
| **NBFORMAT-GATE-SILENT** 校验静默消失 | ⬜ **漏列** | ~~✅ 本轮修复~~ **已撤回：第六轮代码里仍是裸 `if`；第七轮才真做（见第七轮段）** |
| **NEW-2** 值级校验漂成协议错误 | ⬜ **漏列** | ⚠️ **部分**：`timeout_seconds` 用 `.int()`（类型级）。广播枚举**保持工具层**——schema enum 会让 SDK 返回协议错误，与 U27 要求的 `invalid_arguments` 冲突，需 SPEC 先裁决（见剩余事项） |
| **NEW-6** stderr 尾巴挂在任意失败上 | ⬜ **漏列** | ~~✅ 本轮修复~~ **已撤回：第六轮只改了 `!this.alive` 一支，`#failureDetail()` 仍无条件附加；第七轮如实标 ⚠️（见第七轮段）** |
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
## 〇-C、第四轮（`ipynb-mcp-code-review-v4.md`）

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

## 〇-D、第三轮（`ipynb-mcp-code-review-v3.md`）

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
