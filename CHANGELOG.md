# Changelog

本项目的接口变更遵循 D22 兼容承诺（工具名与参数名在 1.x 内不删不改；新增参数一律可选带默认值；返回字段只增不删）。

## [Unreleased] 0.1.0 — 第十三轮代码复核整改（发布前最后一轮）

> 来源：`docs/review/ipynb-mcp-code-review-v13.md`（评级 **C**：3 条 🔴 + 4 条 🟡）。
> **无工具名/参数名变更**；新增一个**可选**的 CLI/环境变量开关 `--max-response-bytes`（含默认值）；返回字段只增不减。

### Fixed — 单帧响应超过 10 MiB 会被客户端断连（🔴 V13-1）

每个工具结果走一行 NDJSON 帧，而 MCP SDK 的 `ReadBuffer` 对超过 `STDIO_DEFAULT_MAX_BUFFER_SIZE`（10 MiB）的帧**抛错断连** —— 客户端只看到 `McpError -32000: Connection closed`，之后每次调用都是 `Not connected`：丢的是**整条会话**，不是这次响应。服务端此前没有任何总响应预算：唯一的限额 `inline_text_chars` **只作用于 `stream` 项**，`text/plain`、`text/html`、`application/json` 与图片可以无限大。主审用真 SDK 客户端实测：9.9 MiB 静默通过、10.2 MiB 必死、60 个小区块累计 17.6 MiB 同样必死（悬崖在**整帧**上）。最坏的形态是 `notebook_run`：**文件已成功写回，而模型永远不知道跑过**。

新增 `src/core/response-budget.ts`：对组装后的载荷施加字节预算（默认 **8 MiB**，刻意低于 10 MiB 悬崖），先截断最大的文本字段、必要时丢弃整项输出，图片装不下就不返回块（走 SPEC §4.3 现成的 `artifact_path` 降级），**每一次删除都有 `output_truncated` 警告**。预算施加在六个工具共用的唯一出口，工具无法忘记它。见 D-065。

### Fixed — 转义密集的大 notebook 把读取拖成 O(n²)（🔴 V13-7，第十二轮修复引入的回归）

上一轮修 OOM 时把逐字符拼接换成"两次 `indexOf`"（找引号、找反斜杠各自从当前位置扫到文本结尾），于是**每个转义都要重扫剩余全文**。`\n` 就是转义，所以任何带换行的 cell 源码都中招：实测 0.5/1/2 MiB = 413/1611/6362 ms（翻倍即四倍），6.3 MiB 时一次 read 从 335 ms 变成 **56.5 s**，期间 server 完全无响应。

改为**单次前向 token 扫描**（`[^"\\]+|["\\]` + `String.matchAll`）：同一份数据 1 MiB **17 ms**、2 MiB **34 ms**，而上一轮的内存修复仍然有效（真实 37.5 MiB notebook 峰值 911.8 MiB、`notebook_run` 完整跑完）。见 D-063。

### Fixed — 后台 run 的内核异常死亡被报成"客户端取消"（🔴 V13-8）

cell 内 `os._exit()` 或 sidecar 被杀时，**同步**路径报 `kernel_died`、**后台**路径报 `state: cancelled` + `error.code: cancelled` —— 而没有任何人取消过这次运行。客户端因此无法区分"我取消的"（可重试/放弃）与"它崩了"（状态已丢、需要 `replay`）。修法：记录**实际先触发**的那一个（先触发者胜出，写回期间才到达的取消不会改写内核死亡），`abort.reason` 改为 getter，调用方不再预设 `'cancelled'`。见 D-064。

### Fixed / Changed — 文案、失去判别力的守卫与门禁作用域（🟡 V13-2/3/4/6）

- **`(interrupt did not land)` 是无法成立的断言**（V13-6）：它在 interrupt 生效的平台上是假事实，而两个平台都报 `exec_timeout`。文案改为只陈述本层知道的事实（deadline 已过）。
- **两条守卫此前不可能失败**（V13-6）：`v9-regressions` 曾同时接受 `internal` 与 `exec_timeout`（把错误分类的**症状**当成了通过条件）；`kernel.test.ts` 的 `KeyboardInterrupt` 断言在超时恒为 `timeout` 之后**不可达**（删掉 sidecar 的 interrupt 逻辑它照样绿）—— 现在拆成两条确定性用例（运行中显式 interrupt → `error` + `KeyboardInterrupt`，且**不**关闭内核；超时 → `timeout` 且关闭内核）。`v12-timeout-status` 的超时用例补了非真空断言（Windows 上那个循环迭代零次，"什么都没断言"与"没发现问题"长得一样）。
- **`scripts/` 在 lint 门禁之外**（V13-2）：`oxlint src tests` 留下了 8 个 error 与 4 个 warning，而 `scripts/` 里有诚实度门禁**自己**的实现。**修好而不是豁免**：输出改用 `process.stdout.write`，四处 warning 是死代码与一处 `startsWith`；门禁扩为 `oxlint src tests scripts`。
- **`check:release` 不在任何自动化路径**（V13-4）：它是唯一"装进空目录、驱动装好的二进制"的门禁，现在进 CI（ubuntu/py3.12）与 `prepublishOnly`。
- **试用脚本可能直接改写真实 notebook**（V13-3）：头部加横幅、拒绝已知原件目录（解析后大小写折叠比较）、路径改由 `IPYNB_TRIAL_DIR` 提供、"必须被拒"的围栏用例改用 root 的兄弟路径（此前在没有那个目录的机器上会因为"文件不存在"而**假绿**）；两个内存探针不再吞掉 `spawnSync` 失败（它曾把探针坏掉打印成看起来正常的 `ratio=0.0`）。
- **滞后数字**（V13-5）：状态表与兼容矩阵更新到本轮数字，`measure-real-notebook.mjs` 不再指错脚本名。

### Tests

- 新增 `tests/integration/v13-response-budget.test.ts`（**真 SDK 客户端 + 真 stdio**，2 例）：11 MiB 输出必须返回在预算内、带警告，且**同一条连接的下一次调用仍成功**；以及"60 个小输出累计超限"形态。变异验证：预算换成直通后两条都红，报出 `-32000: Connection closed` 与 `Not connected`。夹具刻意用 `display_data`+`text/plain`（stream 会被 `inline_text_chars` 先截断，第一版夹具正是如此，对着坏代码也全绿）。
- 新增 `tests/unit/json-reader-scaling.test.ts`（3 例）：1↔2 MiB 的耗时比 + 绝对上界，带"夹具确实转义密集"的探针断言；16 个转义形状（先与 `JSON.parse` 对照再断言）；4 个嵌套文档（裸字符串用例漏掉了"字符串吃掉自己的结束引号"这一让**所有文档**失败的形态）。
- `tests/integration/kernel.test.ts` 拆成"interrupt 落地"与"超时关闭内核"两条；`server.test.ts` 新增后台 `os._exit(7)` 用例；`v9-regressions` 收紧为只接受 `exec_timeout`。
- 单测 **600**（31 文件）；集成 **78**（13 文件）；`check:package` **144 文件 / 22 变异**。

## [Unreleased] 0.1.0 — 真实使用实测整改（发布前）

> 来源：`docs/review/ipynb-mcp-changejob-real-usage-trial.md`（5 个真实 ChangeJob notebook 端到端实测）。
> **无工具名/参数名变更**，**无新增返回字段**。

### Fixed — 37 MB 以上的 notebook 会让 server 进程 OOM 硬崩（🔴 实测阻塞项）

37.5 MiB 的 xgboost 调参 notebook 调 `notebook_run` 时 node 进程撞上 2048 MiB 默认堆，以 `FATAL ERROR: Ineffective mark-compacts near heap limit` 退出。客户端只看到 `MCP error -32000: Connection closed` —— **没有错误码、没有可读的失败信息**，而且**该 server 名下所有 notebook 的 kernel 一起死**。实测阈值：4 / 16 / 24.7 MB 通过，32.9 / 38.4 MB 崩。

根因不是"多份整文档副本"，而是**自研 JSON 解析器的 `readString` 逐字符拼接**（`result += char`）：一个 200 kB 的 json 载荷（SHAP 值、base64 图、dataframe）会变成 20 万节的 cons-string 链。实测 `parseNotebook` 单独占用 **1198 MiB 堆**，是文件的 **16 倍**，而对照的 `JSON.parse` 只需 **1 倍**。

改为**整段复制**：一次 `indexOf` 找到下一个 `"` 或 `\`，无转义的整段一次 `slice` 取出；只有真正的转义序列才逐字符处理。语义一字未改（与 `JSON.parse` 逐条对照的 87 条语义矩阵全绿）。

**结果：峰值 RSS 2238.9 MiB → 922.7 MiB，同一个文件从"崩"变成"完整跑完"**（真 kernel、`write_back` 正常）；在 `--max-old-space-size=768` 下也成功。

### Fixed — 超时的终态码取决于平台（CI 实测）

CI 的 `integration (ubuntu-latest, py 3.12)` 抓到：同一个超时 cell 在 interrupt 无效处（Windows）报 `exec_timeout`，在 interrupt **生效**处（Linux，内核抛 `KeyboardInterrupt` 后转 idle）报 **`internal`** —— 后者是"本工具内部出了无法归类的问题"的码，于是**要了 deadline 也拿到了 deadline 的调用方被告知工具坏了**。SPEC §4.7 规则 6 把 `timeout` 写进 `status` 枚举并规定它标记内核死亡，这个判定不可能取决于某个平台的 interrupt 是否落地。

sidecar 现在记住"已送出超时所需的 interrupt"，收尾时无条件判定为 `timeout`。附带加固：iopub 上的 `error` 也成为 `error` 的判据（`execute_reply` 是可能不到达的第二条消息，只认它会让一个已经把 traceback 收齐的 cell 报 `ok`）。

### Fixed — 守卫死于自己的输出（CI 实测）

`check-connection-sweep.py` 在 CI 的 cp1252 控制台上因报告里的 `→` 抛出 `UnicodeEncodeError` —— **崩的是通过那一行**，判据恰好在无话可说时死掉。两处 Python 入口现在把 stdio 重配置为 UTF-8。

sidecar 里的同族隐患更严重：`send()` 用 `ensure_ascii=False`，用户 cell 的 traceback（可含任意 Unicode）会在写入时抛异常，异常逃出 `main`，**进程连同所有 kernel 一起死**，客户端只看到 `Connection closed`。`send()` 现在在编码失败时退回 `ensure_ascii=True`。

### Fixed — 测试对"超时后内核必须死亡"的隐式依赖

`tests/integration/kernel.test.ts` 的 I9 用例依赖前一个 interrupt 用例**留下**的 kernel，而这只在 interrupt 生效的平台成立（Windows 报 `timeout` → 注册表按 §4.7 规则 6 关闭内核）。现在 interrupt 用例自带 kernel 并**显式断言**"超时后句柄必须消失"，I9 用例自己启动内核。

### Documented, not changed — 实测发现的两处已知行为

- **`mode='auto'` 会重跑目标之前的 cell**（实测 `mode_used=replay`、`replayed=14`）。SPEC §4.7 规则 1 要求这个阶段静默，而 §7 的 warning 码表是封闭的，没有哪个既有码能表达"刚刚重跑了 14 个 cell"——复用会让模型读到假语义。因此**登记为已知行为**并写进 README：想只跑一格就先 `notebook_kernel(action='start')` 再 `mode='resume'`（实测 `replayed=0`）。代价在响应里可见（`mode_used` 与 `replayed_cell_indexes` 都是既有字段）。见 D-062。
- **`notebook_kernel(action='list')` 不存在**，合法值是 `status|start|shutdown|restart`（实测报 `invalid_arguments`）。评审脚本原本用了 `list`；这是工具按 SPEC 拒绝未知参数，不是缺陷。

### Tests

- `tests/unit/json-exact.test.ts` 新增 `[V13-1]`：2 MiB 载荷的**分配探针**（阈值 8 倍）。**变异验证**：把逐字符版本写回去，只有这一条红并打印 `retained 61.4 MiB`，其余 9 条全绿。
- 新增 `tests/integration/v12-timeout-status.test.ts`：真 kernel 断言超时 cell 的 `status === "timeout"` 且不含未执行的输出。
- 新增测量脚本 `scripts/measure-parse.mjs`、`scripts/measure-stages.mjs`、`scripts/measure-real-notebook.mjs`（后两者可用于任何 notebook）。
- 真实使用实测的驱动脚本入库：`scripts/trial-changejob.mjs`、`scripts/trial-scenarios.mjs`（缩进已规范化）。
- 单测 **597**（30 文件）；集成 **74**（12 文件）。

### Docs

- `docs/DEVIATIONS.md`：D-059（整段读取）、D-060（超时判定与平台无关）、D-061（守卫不得死于自己的输出）。
- `docs/review/ipynb-mcp-changejob-real-usage-trial.md` 入库（实测报告原件）。

## [Unreleased] 0.1.0 — 第十二轮代码复核整改（发布前最后一轮）

> 来源：`docs/review/ipynb-mcp-code-review-v12.md`（评级 **C**：1 条 🔴 + 2 条 🟠）。
> **无工具名/参数名变更**，**无新增返回字段**（本轮修的全是既有字段的行为与文案）。

### Fixed — 下溢到零的字面量被静默改写成 `0`（🔴，第十一轮引入的回归）

`1e-400`/`1e-330`/`1e-324`/`2e-400` 这类字面量**表示一个非零的数**，但 double 存不下，只能变成 `0`。v11 的判据里有一句早退 `if (value === 0) return isNegativeZero(literal)`，于是它们被判成"零，没有信息损失"——**编辑一个无关 cell 之后就从盘上消失（变成 `0`）**，零警告。v10 的旧判据下这些字面量是逐字节保留的，所以这是一条**回归**，也正是本产品第一条卖点要消灭的故障。

同一个早退还有第二个后果：`-1e-400` 保住了字节，却拿到一句**两处为假**的警告（"negative zero … the value is exact"——它既不是负零，值也不再精确）。

修法把"零"拆成它真正的三种情形，并把判据从**写法**推进到**语义**：

- `-0` / `-0.0` / `-0e0`：正好是零，符号无法经 JSON 通道传递 → 保留字节 + 负零文案；
- **尾数为零**的字面量（`0`、`0.0`、`0e0`、`0e-5`、`0.0e-400`）：确实表示零，只是写法不同 → 不打标记，规范化为 `0`。判据只看**尾数**里有没有非零数字，所以 `0e-400` 不会被"指数里有数字"误判成下溢；
- **尾数非零**（`1e-400`）：**下溢** → 保留字节 + 一句专门的 "underflows to zero" 文案。

于是下溢与上溢（`1e400` → `null` + 警告）**对称**了，D-056 的不变式①（值变了必须告知）在这一格成立。见 **D-056 的 v12 订正**。

**矩阵的判据也一并换掉了**，这是本轮的另一半收获：v11 的表对"不打标记"的字面量断言 `String(parsed) === String(Number(literal))`，而对 `1e-400` **两边都是 `'0'`** —— 也就是说**把这一格加进表里也会绿**，守卫与被测判据同构。现在断言的是**用户能观察到的事实**：盘上逐字节保留（新用例 `[V12-1]`）、响应里的值、以及文案。变异验证：把早退改回去 → **19 条红**。

### Fixed — run 路径的图片降级警告按 code 去重，归因全丢（🟠）

read 路径 v11 已修（3 个 cell → 3 条可区分消息），run 路径仍在 `if (!warnings.some((existing) => existing.code === warning.code))` 上按 **code** 去重，而 `image_materialize_failed` 对每个 cell 都是同一个 code——于是三个 cell 各自坏图只产出**一条**警告，且**只说 `cell 0`**，cell 1/2 的失败在响应里没有任何归因。

改为按 **message** 去重（与 read 路径一致）。因为文案已经带 cell（D-057），相同的消息现在真的意味着相同的事实。

**这条路径此前零覆盖**：把一个子代理变异（把整段警告关掉）跑在 v11 的 595 条单测上**全绿**。新增 `tests/integration/v12-run-image-warnings.test.ts`（2 例，真 kernel，3 个 cell 各坏图）：断言三条互不相同的消息、每条指名 cell、并断言第二次运行不会累积成六条。变异验证：去重键改回 code → 2 条红，打印出的正是评审实测的那一条 `image at cell 0 …`。

### Fixed — 三行"已修"没有对应产物，且门禁抓不到（🟠）

`docs/REVIEW-FIX-STATUS.md` 的三行声称已修而实测未修：幽灵符号 `callWarnings` 在 `src/run.ts` **还有第二处**（只改了第一处）；D-050 与 D-054 都宣称已订正，而 `git diff` 显示那两轮**对它们没有任何改动**。

三行都订正为"v12 复核订正 + 第十二轮已补"，并把缺失的产物真正补上：第二处幽灵符号改为 `pushCallWarnings`，D-050 补上"克隆会破坏 marker 身份、序列化必须用原始解析树"的订正段，D-054 补上两格已知行为（`['a','b']` 的 join、`"inf"`/`"NaN"` 字符串零警告）。

**门禁本身也失效了两轮**，两个变体值得记下来：第一版在 `docs/` 里搜符号，于是**那一行在自己身上找到了自己**；第二版在代码里搜子串，于是 `tests/unit/json-exact.test.ts` 里一个**同名局部变量**为"`callWarnings` 已改名"背了书。现在：

- 词表覆盖整族说法（补上"已修"/"fixed"/"已补齐"/"已同步"——v12 之前 `| ✅ | 已修 V11-99 的全部问题 |` 可以 exit 0）；
- 存在性判定落在**声明形态**上（`isDeclared`：`function`/`const`/`class`/`interface`/`type`/`def` + 词边界 + 调用形态），子串不算；
- 声称修**产品代码**时，佐证必须来自 `src`/`python`——测试里的同名局部变量不算。

三种绕过形态与一种"必须放行"的对照进了自测（变异 **12 → 17**）。

### Fixed — 文档与注释的小账（🟢）

- **D-056 的 `1e21` 例子与实现不符**（V12-2）：它**会**被规范化为 `1e+21`，属于"值不变、写法变"那一类；例子已按实现改正，并写明同类写法共 16 种。
- `oxlint` 的文件数 **71 → 78**（实测）。
- V11-1 的变异红数 **12 → 11**（实测）。
- `REVIEW-FIX-STATUS.md` §11.2 关于 `3.0` 的说法**写反了**：Python `json` 把 `3.0` 解析为 **float**，nbformat 因此判 INVALID——所以本工具的 `3.0 → 3` 是把一种 nbformat 拒绝的写法规范成它接受的写法，不是"两种权威结论不同"。
- `json-exact.ts` 里两句与用例相反的注释（55 位的 `0.1000…625` 并非 "accepted"、`0.10000000000000001` 并非 "names a different double"）已按实际行为重写，并把 `1e21` 的行为写对。
- `src/run.ts` 的一处注释缩进错位。

### Changed — 已知行为的登记与措辞

- **D-054 补记两格已知行为**：全字符串数组 `['a','b']` 会被 join 成 `"ab"`（恰好落在合法 base64 字母表里，1 字节，**无法从值本身分辨**）；json mime 里的非有限值以字符串 `"inf"`/`"NaN"` 交付且零警告（kernel 把 `1e400` 序列化成 `"inf"`）。两格都**不建议**加通用魔数检查（会误伤 Jupyter 自己的分行 base64 与用户的合法字符串）。
- **README 的保真声明改成它实际的意思**：规范化的对象是**写法**（`100.0` → `100`、`1e-05` → `0.00001`，与 Python `json.dumps` 的输出同族），**值一律不改**；存不下的值（大整数、上溢、下溢）逐字节保留并附带精确数字的警告。

### Tests

- `tests/unit/json-number-forms.test.ts`：形态表 **26 → 34**（+4 下溢、+3 次正规/零尾数），新增 `[V12-1]` 用例（下溢保留字节 + 文案 + 零尾数不误判 + 负零族），并把 `warned:false` 的断言换成"盘上字节 = `String(Number(literal))`"。
- 新增集成 `tests/integration/v12-run-image-warnings.test.ts`（2 例，真 kernel）。
- `tests/integration/v10-regressions.test.ts` 新增 2 例 `[V12-1]`（无关编辑后盘上保留 + 默认出口也报告）。
- `scripts/check-docs.mjs`：自测变异 **12 → 17**；`entries:` 行整行删除不再静默关闭规则（v11 的最后一个洞）。
- 单测 **595 → 596**（30 文件）；集成 **69 → 73**（11 文件）。

## [Unreleased] 0.1.0 — 第十一轮代码复核整改（未发布）

> 来源：`docs/review/ipynb-mcp-code-review-v11.md`。
> **无工具名/参数名变更**；**唯一新增返回字段**：`notebook_run_status` 与 `notebook_run_cancel` 的 `facts_pending`（登记 **D-055**，纯新增，不轮询的旧客户端行为不变）。

### Fixed — 对模型陈述假事实（🟠）

- **完全精确、只是写法不同的数字被报成"无法精确表示"**（🟠）：判据是"写法和 `String(Number(literal))` 是否相同"——也就是**字节**问题，却被当成了**值**问题。于是 Python 自己 `json.dumps` 的日常输出（`100.0`、`1.5e-07`、`2.5e-05`）全部被标成"was not representable exactly"，**任何含小数的 DataFrame/`float` 结果都中招**；真警报（`2**64`、`1e400`）淹没在噪声里。判据改为**值**：只去掉无信息的写法差异（指数正号与前导零、尾随 `.0` 与多余零、`String()` 的整数写法）后仍与 `String(Number(literal))` 不同的，才算损失。`-0` 仍标记，但改说"符号无法经 JSON 通道传递"。代价是 `100.0`/`1E+2` 现在写成 `100`——值相同、文件仍合法，符合 SPEC §5.5.7 的"逻辑不变，而非字节最小 diff"。见 **D-056**。
- **守卫无法证伪自己**（🟠，同一条的根因）：v10 的矩阵用**被测函数**推导期望值（`inexactLiteralsIn()` 内部调用 `losesPrecision`），所以判据错了，24 条用例照样全绿。现在两张表都把期望**写死**（`json-exact.test.ts` 的两组显式字面量、`json-number-forms.test.ts` 的 37 条规范化器期望），并新增 `[V11-1]` 规范化器对照表。

### Fixed — 终态与事实不同时到达（🟠）

- **取消后的"空壳终态"**（🟠，V10-7 的修复在最常见流程下等于没修）：`notebook_run_cancel` 按 SPEC §4.8 规则 1 **立刻**发布 `state: "cancelled"`，而 `executed`/`warnings`/`write_back` 要等在途 cell 结束、后台任务收尾才补上。于是在**整个在途 cell 的剩余时长**里（Windows 上 interrupt 无效，25 秒的 cell 就是 25 秒），客户端读到的是一份自洽而虚假的载荷：`cancelled` + `executed: []` + `warnings: []` + `write_back.performed: false`；**然后文件在它背后被改写**。模型有充分理由断定"什么都没发生"并重跑——恰好是规则 3 想避免的行为。现在终态**要么带着事实，要么声明事实还没到**：新增 `facts_pending`，由后台任务在最后一条语句里清回 `false`。这类缺陷**在单元测试里看不见**（它只存在于两次查询之间），所以用例是真的：真 kernel、真取消、取消后**立刻**读一次 status。见 **D-055**。

### Fixed — 默认出口静默舍入（🟠）

- **默认 read 路径（`summary`）把舍入后的数字给模型，且零警告**（🟠）：`mapRawOutputs` 已经把 `9007199254740993` 投影成 `…992`、把 `1e400` 投影成 `null` 并生成了逐项警告，但**提升到调用级 `warnings[]` 的那段代码只在 `include_outputs: "full"` 时执行**。而 `summary` 正是 SPEC §4.3 的默认出口、也是 README 推荐的省 token 用法。现在 `none` 之外的每个出口都提升，`none`（用户主动不看）保持沉默，并有一条"干净输入不产生警告"的反向用例。

### Fixed — 内部标记与不实提示（🟡）

- **内部 marker 从 `execution_count` 漏进模型可见响应**（🟡）：`jsonValueOf` 的递归投影只覆盖 json **值**，而 `execution_count` 由另一条路（`render/read.ts`）直接透传，于是 `9007199254740993` 被发成 `{"__ipynb_exact_number__": "9007199254740993"}`——一个文件里不存在、文档里也没有的结构。计数现在在**读入时归一化一次**（accessor：读者拿到数字，写者仍拿到 marker，字节不变），规则另拆出 `execution_count_not_an_integer`，hint 不再用为 `-1` 写的措辞去描述一个数值合法的大整数。
- **`1e400` 交付 `null`，文案却说客户端会读到 `Infinity`**（🟢）：文案必须描述**实际交付的载荷**，现在分三种情况生成（超范围 → null、`-0` → 符号、其余 → 舍入值）。

### Fixed — 有界性与可归因性（🟡）

- **警告 message 的上界只数"条目"、不限"单条长度"**（🟡）：v10 把明细截到 8 条，一个 20 000 字符的 mime **名**就把这条路重新打开（message ≈ 名字长度 + 70，线性）。现在每个 mime 名也被截到 64 字符，用例断言的是 `message.length`。见 **D-053** 的 v11 补充。
- **图片降级警告不指名 cell**（🟡）：文案只有输出下标，而每个 cell 的 outputs 都从 0 开始，于是三个 cell 各自坏图产出三条**逐字节相同**的消息：read 打印三遍（分不清是哪个 cell）、run 去重成一条（丢掉的正是"哪几个 cell"）。现在文案是 `image at cell N (output M) …`，去重不再损失归因。见 **D-057**。

### Fixed — parser 的三格边界（🟡）

- ① **未转义控制字符**被接受（`JSON.parse` 与 Python 都拒绝），而下一次写入会把它**转义**——非法文件被悄悄改合法、用户字节被改而无警告；② **12 000 层嵌套**耗尽栈，报 `parse_failed` + "notebook file is not valid JSON"——对一份 `JSON.parse` 能接受的文档说假话，并让它永久不可读（现在有显式深度上限 512 与描述**原因**的文案）；③ **序列化器能产出非法 JSON**（`[1,,3]`：`map` 跳过空洞、`join` 渲染成空）。见 **D-058**。

### Fixed — 测试与门禁自身（🟡）

- **测试套件会写进并删除用户的 venv**（🟡）：`IPYNB_TEST_VENV` 指向的环境缺依赖时，helper 先说"leaving it alone"，随后把 venv 建进**同一个目录**并盖上"本套件创建"的 marker；下一次该目录不可用时，marker 让删除分支成立——**用户的 venv 连内容一起被删**。现在外来目录**完全不写**，直接回退基础解释器，用例做**字节级**目录快照两轮驱动。见 **D-055** 轮次的说明。
- **状态表虚报**（🟡）：`REVIEW-FIX-STATUS.md` 有一行宣称两项已修，而两句都不成立（幽灵符号仍在、恒真断言一字未改）。已订正为 ⚠️ 并真修，同时加**机械门禁**：`✅` 行若声称"已订正/已删除/已改名"，必须点名一个**存在**的符号或路径——符号只在代码目录里找，否则那一行会在自己身上找到自己。
- **`check-docs` 的计数可以自证**（🟡）：删掉末行再把 `entries` 减一，两个数依然一致。现在文档头部有一个**指纹**（`node scripts/check-docs.mjs --print-digest` 生成），任何增删改都必须重新生成它。

### Tests

- 新增集成 `tests/integration/v11-terminal-state.test.ts`（3 例，真 kernel）：取消后**立刻**读 status 的载荷断言、`facts_pending` 落地后的两向断言、两个载荷构造器的形状断言；变异验证——去掉 raise 后立刻红并打印出那个空壳载荷。
- 新增集成 `tests/integration/v11-read-warnings.test.ts`（5 例，四种出口的矩阵）：默认/`summary` 必须报告舍入，`full` 同样，`none` 保持沉默，干净输入零警告。变异验证——只给 `full` 时默认与 summary 两条立刻红。
- `tests/integration/v10-regressions.test.ts` 新增 3 例 V11-6（大整数计数可读可编辑、`1.5` 被拒且 hint 符合原因）。
- `tests/unit/json-parser-semantics.test.ts` 新增 `[V11-8]` 三例（6 个控制字符样本、深度两侧边界、空洞与 `JSON.stringify` 对照）。
- `tests/unit/json-number-forms.test.ts` 重写为**显式表**（26 形态 × 8 位置）+ 37 条规范化器期望。
- `tests/unit/image-blocks.test.ts` 新增 `[V11-10]`（三 cell 坏图 → 三条互不相同的消息）。
- `tests/unit/test-venv-ownership.test.ts` 新增 `[V11-9]`（外来目录字节级未变、两轮驱动、无 marker）。
- 单测 **552 → 595**（30 文件）；集成 **58/8 → 69/10 文件**；`check-docs --selftest` 变异 **10 → 12**。

## [Unreleased] 0.1.0 — 第十轮代码复核整改（未发布）

> 来源：`docs/review/ipynb-mcp-code-review-v10.md`。
> **无工具名/参数名变更**；**无新增返回字段**（`OutputItem.json.warnings` 是 v9 已发布形态，本轮只是把它的**内容**补全）。

### Fixed — 本轮新引入的回归（🔴）

- **`__proto__` 键被静默删除，且对象能被写成裸数字**（🔴，**本轮新引入**）：为 V9-5 换上自研 parser 时，对象键用 `result[key] = value` 承接，而 `__proto__` 命中的是 `Object.prototype` 的 **setter**——该键既不进对象也不进响应，**写入时从用户文件里消失**（实测 `x2 → x0`），编辑的还是**无关 cell**；文件仍合法，所以自检、nbformat 与门禁都不报警。上一版的 `JSON.parse` 在这一格**是正确的**。修法：`Object.defineProperty` 定义自有属性；marker 改为"形状 + 不可扩展"双重判据（`exactNumber()` 冻结产出，来自文件的解析结果必然可扩展，因此伪造不了），不用 `class`/`instanceof` 或 Symbol 键——`structuredClone`（编辑路径会对文档调用）会把类实例压平并**丢弃** Symbol 键，那样 marker 会在克隆后失效并被当作对象写进文件。见 **D-050**。顺带补齐 JSON 数字文法（`01`/`1.`/`.1`/`+1` 与 `JSON.parse` 一样拒绝）与 `-0` 的符号保留。

### Fixed — 数值形态的原文保真（🔴）

- **编辑一个无关 cell 会在盘上静默改写别处的高精度小数**（🔴）：判据只覆盖"看起来是整数的字面量"，而任何写入都会重序列化**整份文档**，于是 `0.1234567890123456789012345` → `0.12345678901234568`、π 的 30 位 → 16 位、`1.0000000000000001` → `1`，`warnings: []`——改的是**没被要求改的 cell**。判据改为"**能不能原样写回**"（`String(Number(literal)) !== literal` 即保护），因此小数、超范围值与"值等价但写法不同"的 `1E+2`、`1e21`、`0.10` 一并覆盖；能往返的 `0.1`/`1.5` 仍是普通 number（不制造无谓的 marker 与警告）。见 **D-051**。

### Fixed — 同一族的另外三格

- **嵌套的精确数字把内部标记对象漏给模型**（🟠）：`jsonValueOf` 只判顶层，容器里的字面量以 `{"__ipynb_exact_number__": "…"}` 原样发出且**零警告**——模型看到文件里不存在的结构，而那个名字在任何文档里都没定义。现在递归投射：任何深度的标记都换成数字，**每个不同字面量一条警告**，精确数字仍写在警告文本里。见 **D-052**。
- **中止类出口丢掉全部已收集 warnings**（🟠）：`cancelled` / `kernel_died` 从未把已收集的 warnings 传进 detail，后台路径更彻底——即使 detail 里有也不写回句柄，于是 `notebook_run_status` **永远**看不到丢弃提示，而**文件已经被改写、值已经被丢弃**。四个终态出口与后台 status 现在共用 core 的 `assembleCallWarnings`（可用真输入直接单测，v9 那版藏在 `run.ts` 私有函数里、短路后 432 条单测全绿）。见 **D-052**。
- **hint 声称"文件会变合法"，而 nbformat 判它不合法**（🟠）：`clear_outputs` 之后计数仍是 `-1`、`nbformat.validate` 仍拒绝——把"我们不再检查"说成了"文件合法"。文案改为分别陈述两件事，用例改为**由外部权威判定**（集成里断言"clear_outputs 之后仍 INVALID、`set_cell_type` 之后才 VALID"），首次拒绝路径也一律带 hint。见 AGENTS §9 新增的第 4 条规则。
- **图片值的数组形式在两条路径上判据不同**（🟠，V9-1 残留）：读路径把数组 join 后当图片，run 路径要求 `typeof === 'string'`，同一份数据两条路径结论相反；更糟的是 `[1,2,3]` 被 join 成 `"123"`——合法 base64 字母表、解码出 2 字节，于是被**当成一张真图片**返回并写 artifact。两条路径现在共用 `imageValueText`：仅当元素**全部是字符串**时 join。见 **D-054**。

### Fixed — 守卫与文档

- **`check-docs.mjs` 会因合法的文档修订而变红**（🟡）：自测的变异源硬编码了文档里的字面量，同步修订两个文档（verbatim 仍成立）会让 `pnpm lint` 失败，而文档恰恰是改对了。变异改为**从当前文本推导**，施加不了就跳过并显著提示，另设"可施加数量下限"防止容错退化成什么都不查；同时补上 v9 遗留的两个盲点（**删掉最后一行**不报、**追加一条**不报）——计数现在写在文档头部（`entries: NN`）并由检查器校对。见 **D-053** 所在轮次的说明与 AGENTS §9 第 4 条。
- **警告 message 无上界**（🟡）：mime 名由用户 cell 决定，300 个 `application/x-bogus-N` 实测产出 9 897 字符的调用级 message 并进入响应与 `exec_timeout` 的 detail。现在最多列 8 个 `(cell, mime)` 对，其余概括为 `… and N more`，**计数保持精确**。见 **D-053**。
- **测试 venv 的所有权断言会因无关原因失败**（🟡）：共享 venv 存在但不可用时 helper **会**删它（V8-12 的设计），若随后的重建失败（Debian 缺 `python3-venv`），路径合法地不存在，而报错信息却指责测试删了"不是自己创建的环境"。断言改为"**之前存在且可用**的 venv 之后必须仍在"。
- `linux-check.sh` 的 `rm -rf` 目标改为**归一化之后再走一次守卫**（此前守卫注释承诺"每个删除目标都经过全部检查"，而实际删的是第二次归一化的字符串）；README 补 venv 措辞（单测也用同一个 venv）与**安全声明**（sidecar/kernel 继承完整 `process.env`，执行不沙箱）。

### Tests

- **新增 `AGENTS.md` §9 第五条硬规则**：自己写 parser / 序列化器时，**语言语义边界与数值形态都要有矩阵**；替换一个成熟实现时，先写出被替换者的行为矩阵再替换。
- 新增 `tests/unit/json-parser-semantics.test.ts`：**28 个语义样本 × 3 条断言**（解析结果与 `JSON.parse` 逐键一致、写回与 `JSON.stringify` 逐字节一致、round-trip 稳定）+ **22 个拒绝样本**（逐条先确认 `JSON.parse` 也拒绝）+ 深嵌套。`__proto__` 覆盖 metadata / cell metadata / json 输出 / 数组元素 / 深层嵌套 / 转义写法 / 重复键。
- 新增 `tests/unit/json-number-forms.test.ts`：**20 种数值形态 × 8 个位置**（顶层 / 深度 1 / 深度 2 / 数组 / 数组套对象 / 三层嵌套 / 与另一不精确值相邻 / 同值两处）× 3 条断言（盘上字节、模型可见的 `value` 与警告、能往返的值不产生 marker），另有"编辑无关 cell 后盘上不变"与"run 写回同样保真"。
- 新增集成 `tests/integration/v10-regressions.test.ts`（8 例，真 stdio + 真 kernel + `nbformat.validate`）：三处 `__proto__` 的读/编辑/权威校验、marker 伪造、无关 cell 的高精度小数、`clear_outputs` 之后仍 INVALID 而 `set_cell_type` 之后 VALID、取消的后台 run 仍报告丢弃、小数的 run 写回。
- 新增 `tests/unit/test-venv-ownership.test.ts`（3 例，独立沙箱目录）：外来 venv 不删、自己创建的不可用 venv 会删、`IPYNB_TEST_REQUIRE_VENV=1` 的失败也不以删除实现。
- `tests/unit/image-blocks.test.ts` 43 例（新增 5 种非法数组形状）。
- 单测 **432 → 552**（30 文件）；集成 **50 → 58**（8 文件）。

## [Unreleased] 0.1.0 — 第九轮代码复核整改（未发布）

> 来源：`docs/review/ipynb-mcp-code-review-v9.md`。
> **无工具名/参数名变更**；**一处返回字段内部结构变化**（`OutputItem` 的 `json` 变体新增 `warnings: []`，
> 仅新增，不删不改；详见下方"返回字段"）。

### Fixed — 图片内容块（本轮两个 🔴 之一）

- **含 data-URL 图片的 notebook 读写都失败**（🔴）：修 V8-3 时只改了**解码/物化**那一层，**内容块**那一层仍从文档取原值交给 SDK，而 SDK 用 `atob` 校验 `ImageContent.data`——一次非法值不是降级，而是整个 `tools/call` 以 `-32602` 失败（模型失去整份 notebook）；更糟的是**那次失败的 run 仍把 data-URL 写回了文件**，此后该文件永久读不回。现在块载荷由**已解码的字节**重新编码产生（`ExtractedImage.base64` 随物化决策一起返回），与"能否解码"共用同一判据；`result.ts` 另加一道块合法性闸门，任何未来的畸形值降级为 `image_materialize_failed` 警告而不是协议错误。见 D-047。
- **空载荷图片曾以 0 字节图片 + 0 字节 artifact + 无警告**的形式通过：`atob('')` 成功、`bytes: 0` 与"坏图"看起来一样。空值与空白值现在走 `image_materialize_failed`，`text_fallback` 说明原因。
- **非字符串图片值不再丢失 mime 名**：`{image/png: 123}` 此前连 key 一起被丢掉，读回来是 `unsupported (unknown)`；现在保留键并报"image value is not a string"，模型因此知道那是一个图片输出。

### Fixed — JSON 数值精度（本轮另一个 🔴）

- **超出 IEEE-754 的大整数被静默四舍五入，且 run 会把舍入后的值写回盘**（🔴）：`application/json` 的 `18446744073709551616` 读出来是 `18446744073709552000`，`warnings: []`，而写回路径把**舍入值**永久写进用户文件——这是"不会静默改坏"要消灭的故障本身。现在 `parse`/序列化走一对**精确保真**的 JSON 实现（`src/core/json-exact.ts`）：JS 无法精确表示的整数字面量以原文保存、原文写回；sidecar 协议解析同样换用精确解析（否则舍入发生在协议层，文件里就是错的）。响应里该值额外带一条 per-output 警告，**精确数字写在警告里**（JSON 通道本身无法承载它）。见 D-048。

### Fixed — 报告与提示

- **超时路径重新丢掉已收集的警告**（🟠，V8-10 的回归）：`exec_timeout` 的 `detail.warnings` 又变成空数组。警告装配现在只有一个入口，**成功出口与超时出口共用**，并在超时抛出**之前**完成。
- **丢弃值的提示重新带上 cell 身份**（🟠）：扁平化成 `string[]` 之后 message 丢了 cell 下标，而 D-042 登记的影响面写着"指名 cell 与 mime"。现在按 `(cell_index, mime)` 去重并逐个写出。
- **`clear_outputs` 的 hint 与行为不符**（🟠）：hint 曾声称"clear_outputs resets the cell execution count"，而 SPEC §4.5 规则 5 明写它不动计数，实现也照做；对 markdown cell 还推荐了一个必被拒的操作（`invalid_ops`）。hint 现在按规则生成且**每句为真**，非 code cell 只推荐 `set_cell_type`。
- **计数规则的作用域从"请求"改为"状态"**（🟠）：v8 的豁免只在清空输出的那一次调用内有效，于是"照 hint 做完之后的**下一次**编辑"又会被同一条规则拒绝。现在一条没有 outputs 的 cell 没有"属于它的计数"，规则不再适用；仍带 outputs 的负数计数照旧被拒（`clear_outputs` 与 `set_cell_type` 推荐的行为都已在用例里走通）。见 D-049。

### Fixed — 文档与守卫

- **`docs/DEVIATIONS.md` 被拼接损坏**（🟠）：D-044 那一行中间嵌进了整份文档的第二份（表头 + 全表），每条偏离出现两次、`D-001` 命中两次，而门禁全绿——`oxlint` 不读 markdown。文件已恢复为单份，D-044 的缺失片段按两份残片的**互补**重建；新增 `scripts/check-docs.mjs`（表头/编号唯一、编号连续、行 arity，外加 SPEC §12 与 `docs/OPEN_QUESTIONS.md` 的逐字一致），接入 `pnpm lint`，并带 7 个变异自测。
- **`linux-check.sh` 的 `WORK` 守卫可被 `..` 绕过**（🟡，v8 遗留）：先拒绝含 `..` 段的值，再用 `readlink -m` 归一化后判前缀；新增 `--selftest`（26 个 case）与两种变异（`prefix-only` / `no-readlink-flag`）实测转红。上一轮 CHANGELOG 与状态表里"已修"的说法**不实**（那个脚本当轮没有被改动），CHANGELOG 相应条目已订正。
- **守卫可证伪化**：`check-indent.mjs` 的自测矩阵重构为 28 个带标签样本（16 条分支变异基线只抓到 3 条，现在 28/28 全红）；`check-package.mjs` 重写为"纯函数检查 + 常驻变异矩阵"，`lib/*` 从"不可失败"改为**派生**（`files` 漂移即红，实测去掉 `lib` 后 32 个模块消失）；`check-connection-sweep.py` 设 `sys.dont_write_bytecode = True`，两个守卫不再互斥。
- **解释器与 venv 的单一决策点**（v8 遗留）：`usableInterpreter` 零调用且 `tests/unit/analyze-op.test.ts` 仍有**第六份复制**——现改为调用共享的 `prepareVenv()`，死导出删除；nbformat 权威改问**实际使用的解释器**（`resolvedTestInterpreter()`），测试 venv 的**所有权**（marker 文件）有了独立用例（`tests/unit/test-venv-ownership.test.ts`），`vitest.config.ts` 补 `fileParallelism: false`。
- **卫生**：删除根目录草稿脚本 `mutate-pkg.mjs`（曾入库）与 `patch-v88.mjs`，`.gitignore` 补 `/mutate-*` 家族；`atomic.ts` 的重复 doc 注释、`notebook-file.ts` 的尾部空行清理。

### Tests

- **断言到消费者真正拿到的那一层**（`AGENTS.md` §9 新硬规则）：本轮两个 🔴 都是"改了一层、断言停在那一层"。新规则把数据形状分成四层（内部投影 / 模型读到的内容块 / 文件字节 / 协议帧），要求**至少断言到模型读到的那一层**，凡触及磁盘的再带上文件字节。
- 新增 `tests/unit/image-blocks.test.ts`（**用 SDK 自己的 `CallToolResultSchema` 校验** `content[]`）：14 种图片值的矩阵（合法 base64、无填充、data-URL、标签不符、空 media type、换行、字符串数组、空串、纯空白、空载荷、非 base64、非字符串、null、对象）× 2 个判据，外加"旧写法确实会被 SDK 拒绝"的证伪锚。
- 新增 `tests/unit/json-exact.test.ts`：精确解析/序列化与 `JSON.stringify` 逐字节一致、只标记不精确的整数、大整数经过**编辑后写回**仍是原文，以及读路径的警告内容。
- 新增 `tests/integration/v9-regressions.test.ts`（真 kernel）：data-URL 图片跑完后**文件可读且块可解码**、`2**64` / `2**53+1` / `-2**63` **在盘上逐字节保留**并各带一条警告、超时运行的 `detail.warnings` 里带 `cell 0`。
- `scripts/e2e-smoke.mjs` 新增 7 条：run 与 read 的图片块用 `atob` + PNG 魔数校验、artifact 与块字节一致、`an image output does not fail the whole tools/call`；并新增第 6 个 cell 真实产生 data-URL 图片，`call()` 现在也收集图片块（此前只收 `type==='text'`，图片问题对它**完全不可见**）。26/26。

### 返回字段（唯一的结构性变化）

- `OutputItem` 的 `json` 变体新增 `warnings: []`（`{code, message}[]`，码仍在 SPEC §7 闭集内，取 `output_truncated`）。旧消费者读 `kind`/`value` 不受影响；D-048 登记了这次语义借用。

## [Unreleased] 0.1.0 — 第八轮代码复核整改（未发布）

> 来源：`docs/review/ipynb-mcp-code-review-v8.md`。
> **无工具名/参数名变更**；无新增返回字段。

### Fixed — 读方向（本轮的重点）

- **`application/json` 的字符串值被静默改写**（🔴）：`display({'application/json': '123'}, raw=True)` 盘上是 JSON **字符串**，模型拿到的是**数字 123**；`'hello'` 更被降级成 `text/plain`（**mime 也被改写**），全程零提示。见 D-044。修法是"不做任何转换"：nbformat 对 json mime 的值**没有类型约束**，值就是值。
- **`+json` 一族读不回**（🟠）：键查找只认字面量 `application/json`，而写方向用 `isJsonMime`。`application/x+json` 等**写进文件后读回来是 `unsupported`**。现在两侧同一条规则。
- **`unsupported` 的提示改为说明"值原样保留在文件里"**：原来的 "unsupported output type" 读起来像"这个输出是空的"，而模型相信自己看到空输出就会重写 cell。
- **data-URL 图片**（🟡）：`data:image/png;base64,…` 现在被接受（此前解码失败 → 0 字节图片）；解不出来时 fallback 文本说明原因，"空"与"坏"可以区分。

### Fixed — 守卫与报告

- **三个"不能失败"的守卫**（🟠）被替换：一个自己重演了产品的 `if`，两个断言**源码字符串**（把行挪进注释也能过）。规则下沉到 `core/outputs.ts` 以便直接驱动；复跑评审的六个变异全部变红。
- **拒绝时推荐的出路本身被拒**（🟠）：`clear_outputs` 被同一条 `execution_count_negative` 拒绝。**没有改 `clear_outputs`**（SPEC §4.5 规则 5 明写它不动 `execution_count`），改的是我们的闸门：本次操作清空输出的 cell 不再受 cell 级计数规则约束。hint 改为按规则生成。
- **`output_truncated` 一条 message 携带两个计数**（🟡）：丢弃与截断此前会互相顶掉，模型只被告知其一。

### Fixed — 打包、测试环境与卫生

- **发布产物带 `.pyc`**（🟠）：`files` 从 `"python"` 改为 `python/*.py`；新增 `pnpm check:package` 断言产物形状，并接入 CI。`pnpm smoke` 也进了 CI。
- **测试 venv 只有一个决策点**：`prepareVenv()` 承担建/校验/回退，五个集成文件全部改为调用（此前是常量集中、逻辑五份，新 helper 零调用）。
- **连接文件清扫按 pid 判活**（🟠）：此前只看年龄 —— 跑超过一小时的 kernel 的文件会被误删，而在上次 sidecar 启动之后被遗弃的文件永远扫不到。判不了 pid 的平台退化为"无 pid 且超过一周"（Windows 上"一小时"不算证据）。登记 D-046。
- **`linux-check.sh` 的 `WORK` 守卫可被 `..` 绕过**（🟡）——**订正（第九轮复核）**：本条声称本轮已修，**不实**：该脚本当轮**一个字节都没有改动**（`git diff c78e36f~1 c78e36f -- scripts/linux-check.sh` 为空），`/tmp/../etc` 在 WSL 上仍被接受。真正的修复在第九轮完成（见上一节），本条保留原文以示记录。
- README / 注释 / 状态表与实现对齐；三个被跟踪的草稿脚本删除；`.gitignore` 补全家族。

### Tests

- **新增硬规则**（`AGENTS.md` §9）：修数据形状缺陷必须补该字段**全部合法类型的矩阵**，并**逐项先红后绿**；复验按**等价类**而不是"上轮点名的那一格"。本轮 19 类型 × 5 个 json mime = 95 条，**改代码前 79 条红**。
- 新增 `scripts/check-package.mjs`（产物形状）与 `scripts/check-connection-sweep.py`（清扫边界，两平台实测：Linux 删 2、Windows 删 1）。
- 本轮所有新守卫都做了变异：六个（V8-1/V8-2/V8-4/P1-c）+ 三个（V8-14）+ 一个（产物含 `.pyc`）。
- 真实 kernel cell 复现 V8-2/V8-1：四次 `display(..., raw=True)` 的响应与盘上内容逐字节一致。

## [Unreleased] 0.1.0 — 第六轮代码复核整改 + CI 首次运行修复（未发布）

> 来源：`docs/review/ipynb-mcp-code-review-v6.md` 与 GitHub issue #1（CI 首次运行，10 个 job 中 8 个失败）。
> **无工具名/参数名变更**；三处**新增返回字段/取值**（错误 detail 的 `errno`、`pre_existing`/`hint`，
> 以及 `changed_cells[].content_changed`）。

### Fixed — CI 首次运行（issue #1）

- **非 Windows 平台上的单测全挂**：几处用例把 Windows 特有的路径语义写成了通用断言，其中一处还要求实现按**宿主**规则解析绝对路径 —— Linux 上 `C:/Users/...` 被当成相对路径拼在 cwd 之后。实现与测试同时收紧：新增 `absolutePath()` 按**目标平台**判绝对性；`config.test.ts` 改为三平台表驱动；`fence.test.ts` 的"另一块盘"改为 win32 独占并在 POSIX 上先断言前置条件；大小写折叠用例改为按平台断言各自的规则。**没有删除或放宽任何断言**。
- **"capable interpreter" 探针与 sidecar 真实依赖不一致**：探针只验 `import ipykernel`（SPEC §5.2 的字面要求），而 sidecar 启动即需要 `jupyter_client`。CI 的 integration job 因此在一个"看起来有能力"的解释器上失败于内部错误，真实用户机器上（kernelspec 指向被裁剪的环境）同样会踩到。现在探针验 sidecar 真正需要的模块集合，回报**缺失的模块名**与恰好需要的安装命令；CI 显式 `pip install ipykernel jupyter_client`（D-038）。
- **`I15` 在 Windows 上失败**：根因是用例自身的相位错误 —— "未改动"快照是在独占句柄已经生效之后读的，于是 `readFile` 自己抛 EBUSY。快照移到加锁之前，用例拆成**读相位**（处理程序的读撞上锁）与**写相位**（读成功之后锁才出现，用钩子确定性触发），并补上了 issue 要求的"读取阶段撞独占"覆盖；`notebook_locked` 的 detail 现在带 `errno`。
- **vitest 的 unhandled rejection**（"may cause false positive"）：`[I7]` 现在在杀掉 sidecar **之前**挂上 rejection handler，消除未观察窗口。
- macOS 的 unit 矩阵只跑声明的 LTS（macOS runner 按 10 倍计费，与 §9 排除 macOS integration 同一理由）。

### Fixed — 第六轮报告

- **写前闸门漏检 mime 值的类型**（GATE-5，🔴）：原来只检查 `data` 是对象，于是一个普通用户 cell（`display({'text/plain': 5}, raw=True)`）写出的文件被 nbformat 拒绝，而 run 报 `write_back.performed: true` 且无 warning。现在按 nbformat 的 schema 检查每个 mime 值（字符串或全字符串数组；`application/json` 例外）、`stream.text` 与 `error.traceback` 的元素类型、`execution_count >= 0`。**执行路径同时归一化**：不可表示的值被丢弃并追加一条 `output_truncated` warning —— 闸门拦在写入那一刻会让整次 run 的成果全部丢失（D-040）。
- **非字符串图片值曾以 `internal` 结束整个 run**（CRASH-1）：`display({'image/png': 123}, raw=True)` 让 `base64.replace` 抛 TypeError。现在值先做类型收窄，走既有的 `image_materialize_failed` 路径。
- **`stream.name` 的白名单比 nbformat 严**（GATE-6）：nbformat 的 schema 只要求它是字符串（无 enum），原来的 stdout/stderr 白名单拒绝合法文件并让该 cell 永久不可编辑。
- **自造了第 12 个 warning 码**（WARN-CODE-1）：`notebook_preexisting_content` 不在 SPEC §7 的闭集内，按白名单解析返回值的客户端会丢弃这条唯一提示。改用既有的 `file_changed_externally`（D-039），并且 **`notebook_run` 现在也返回它**（此前只写日志，模型看到 `warnings: []`）；失败路径的 `detail.warnings` 也不再恒为空。
- **缩进检查器的 `if` 覆盖是死代码**（INDENT-HOLE）：脚本读的是 `node.statement`，而 `IfStatement` 只有 `thenStatement`/`elseStatement`；脚本是 `.mjs`、不进 tsconfig，类型检查抓不到。重写后覆盖 `then`/`else`/`switch`（case 标签与 case 体分开判）/`try`/`catch`/`finally`/四种循环/函数·方法·箭头·访问器体，并加**每次运行都执行的自测**（11 个错位样本 + 1 个干净样本）。用它发现并修好了 5 个文件里 68 行真实错位，另加一条"语句必须独占一行"的检查 —— 它立刻抓到两处被早前批量编辑合并的 `describe(... {  it(...`。
- **终态可以被二次翻转**（NEW5-REPRO）：`notebook_run_cancel` 立刻落地 `cancelled`（§4.8 规则 1），而后台任务随后可能把它改写成 `completed`。`RunStore.settle()` 现在是终态的**唯一写者**；成功路径的 `progress.completed` 也按实际执行数收口（不再停在 total−1）；写回前复查 abort（stale 分析可能耗时，期间的取消必须走终态）。
- **一次纯重排不该算"我们改写了这个 cell"**：`move_cell` 不再进闸门作用域（`changed_cells[].content_changed` 区分改写与重排），并且 `selfcheck_failed` 的 `detail` 现在带 `pre_existing` 与 `hint`，指明唯一的出路是 `clear_outputs`/`set_cell_type`。
- **版本号双真源**（DEP-2）：`server.ts` 从 `package.json` 读版本，单测与 `pnpm smoke` 各断言一次。
- `isAbortCause` 的两份同构实现（QUAL-2）合并到 `core/errors.ts`；传输层注释与 sidecar 的具名常量对齐（FID-6）；stderr 尾巴只在 transport 真的失联时附带（NEW-6）。
- **Linux 可本地复现**：`scripts/linux-check.sh` 把 tracked 文件复制到 WSL 的 Linux 文件系统、按 lockfile 安装并跑 typecheck/lint/单测。CI 的失败全在非 Windows 上，而在 Windows 上"全绿"正是这些问题的成因。
- **`I15` 的两条用例在 windows-latest 上失败**，原因都在用例自身：READ 相位用一次 `readFile` 去验证"文件没变"，而那次读本身会被独占句柄拒绝（EBUSY），断言永远跑不到；WRITE 相位写完触发文件后 `sleep 750ms` 就假定持有者已经拿到句柄，在 runner 上并没有，于是编辑**成功**、用例报出 `expected [...] to include 'undefined'` 这种看起来像产品缺陷的失败。现在持有者通过 stdout 确认句柄已打开、钩子 **await** 该确认（钩子与序列化缝都是异步的），验证读也移到句柄关闭之后。
- **`notebook_locked` 的 `errno` 在备份拷贝这条路径上丢失**：Windows 上被独占打开的文件会先让**备份拷贝**失败，而该分支自己内联构造错误、没带 `errno`，于是同一把锁在"读路径"报 `EPERM`、在"备份路径"什么都不报。现在三条路径统一走 `translateLockError`；新增 `copyFileImpl` 注入点，用例 `[W1b]` 断言 `detail.errno`（已做变异验证）。
- **`U20` 的解释器选择有两个来源**：探针问 `interpreter()`（有 venv 就优先 venv），用例却在自己建 venv 后用它运行——于是同一个 commit 在 CI 上先过后败，差别只是上一次留下的 venv 无法导入 `jupyter_client`。现在只有一个决策（`prepareTestVenv()`）：不能运行 sidecar 的 venv 会被删除，只在基础解释器能服务时才新建并再次验证。
- `[I8]` 用固定 6.5 s 等一个 5 s 的回收定时器，事件循环稍有延迟就会失败（实测该用例耗时 9.6 s）；改为在 30 s 上限内轮询到回收完成，仍断言终态。

### Tests

- 新增 `tests/unit/interpreter.test.ts`（探针与 sidecar 依赖一致，含源码解析的漂移守卫）、`run-store.test.ts`（终态单写者）、`server-version.test.ts`、`warning-codes.test.ts`（码在闭集内 + 编辑路径返回）、`[GATE-5][CRASH-1]` ×3、`[I15]` 读/写相位两条、`[W1b]`（备份路径的 `errno`）、`[TST-2]`（整次 run 真的取到 run 级锁）、`[GATE-1]` 的重排用例。
- `pnpm smoke` 11 → **19** 项（新增版本一致性断言）；`[I18b]` 扩到三 cell（未执行的那个必须保留种子输出与 `execution_count`）。
- 本轮所有守卫都做了变异验证：GATE-1（去掉 scope → 变红）、`[NEW-3][FRAME-1]`（换成行为等价的二次实现 → 36 s，变红）、探针（清单退回只有 ipykernel → 3 条变红）、`[W1b]`（恢复内联错误 → 变红）、`[TST-2]`（去掉 `acquireRun` 调用 → 变红）、I15（Windows 集成实跑）。
- **测试 venv 移出仓库**：此前建在 `tests/.venv-test`（跑一次测试就在工作树里留一个虚拟环境），现在位于系统临时目录并可用 `IPYNB_TEST_VENV` 覆盖。
- **CI 全绿**：run `37136146902`，9 个 job 全部通过（首次运行是 10 个里 8 个失败）。

### Deviations

- 见 `docs/DEVIATIONS.md` **D-001 ~ D-040**（本轮新增 D-038 ~ D-040，并收窄 D-037 的措辞）。

## [Unreleased] 0.1.0 — 第五轮代码复核整改（未发布）

> 来源：`docs/review/ipynb-mcp-code-review-v5.md`。**无工具名/参数名变更**；一处**行为修正**
> （写前闸门的范围从"整份文档"收窄到"本次写入的 cell"）与一处**新增 warning**
> （`notebook_preexisting_content`，走既有的 warnings 通道）。

### Fixed — 写前闸门审错了范围（本轮最重要的一项）

- **一处历史遗留的不合规输出不再让整本 notebook 永久只读。** 上一轮引入的结构闸门校验的是**整份文档**，等于同时审了用户的**输入**：文件里只要有一处它不认可的内容（第三方工具写的 `display_data` 缺 `metadata`、`update_display_data` 等），**所有** `notebook_edit` 与 `notebook_run` 都会永久失败于 `selfcheck_failed`，而且错误位置指向调用方从未触碰的 cell —— "读得到、改不动"，与"安全地编辑本地 notebook"直接冲突。现在闸门只判**本次写入负责的 cell**（edit 用 `changedCells`，run 用 `executedCellsSet`）；历史内容原样带过，并以 warning `notebook_preexisting_content` 告知调用方。被触碰的 cell 若仍带着问题则照旧拒绝（我们只为自己的输出负责），而**清空**该 cell 的输出是被允许的 —— 闸门不惩罚一个刚刚修好问题的写入。
- **闸门不再拒绝 nbformat 认为合法的文件。** `nbformat.validator` 对 `nbformat_minor` 高于本地 schema 的文件会放宽 `additionalProperties` 并接受 `unrecognized_output`；此前我们一律按 4.5 的白名单拒绝，属误伤。现在 `nbformat_minor > 5` 时未知 `output_type` 不判错（未知 `cell_type` 仍是 `parse_failed`：读不了，而不是读了不写）。
- **闸门不再放行它声称能防的东西**：`execute_result.execution_count` 此前只查"键存在"，`"3"` 也能通过；现在要求 integer 或 null。README 的措辞同步收窄为"本实现可能写坏的形状"，而不是"合法性判定"（D-037，收窄 D-032）。

### Fixed — 测试可信度

- **性能守卫恢复判别力。** `[NEW-3]` 的计数器挂在父 Buffer 的**自有属性**上，而被测代码拿到的是 `subarray` 结果（不继承自有属性）：计数器恒为 0、断言恒真，把分帧器换成二次实现（实测 **36 s** vs 现在的 0.6 s）它照样全绿。计数器改挂 `Buffer.prototype` 并加"探针确实跑过"的断言；另加一条墙钟上界作为决定性判据。
- **分帧器抛协议错误后不再卡死**：状态复位，`pendingBytes` 不再说谎，对象可复用（FRAME-3）。
- **`pnpm smoke` 从 11 项扩到 18 项**：补上 `notebook_edit`（此前**从没调用过 edit**，所以"编辑被闸门挡住"这类故障它看不见）、`timeout_seconds=2` 的超时用例（断言 `exec_timeout`、响应及时、该 cell 保持运行前状态）、内容级 round-trip（原先只数条数）以及 kernel 关闭后无残留。
- `fixtures-valid.test.ts` 的 "every fixture" 名不副实（实际只覆盖两本手写 notebook），已改为如实分层：代表性字面量 + 一条静态扫描（只保证 kernelspec 有 `display_name`，且现在按大括号配对读整个对象并先剥离注释）。

### Docs

- README 两句与实测不符已修正：关闭 kernel 是**异步**的（响应先返回，进程可能要到被打断的 cell 自然结束才消失，期间不会留孤儿）；超时响应是 `timeout_seconds` + **约 10 s**（实测 2 s 预算 → 10.2 s），不是"加几秒"。
- AGENTS §9 新增两条规则："守卫必须自己证明有判别力"与"闸门的范围要等于它的责任范围"。
- 两处注释的引用编号与不可考据的数字修正（MISC-2）；`#normCache` 的失效改为按规范化值匹配，消除重指向 symlink 可能留下的陈旧映射（MISC-3）。

### Deviations

- 见 `docs/DEVIATIONS.md` **D-001 ~ D-037**（本轮新增 D-037，并收窄 D-032）。

## [Unreleased] 0.1.0 — 第四轮代码复核整改（未发布）

> 来源：`docs/review/ipynb-mcp-code-review-v4.md`。**无工具名/参数名变更**；一处**修正**（status 的
> `backupPath` → `backup_path`，与 `notebook_run` 对齐）、一处**行为收紧**（写前结构自检可能拒绝
> 此前会被写坏的文档）、一处**性能修正**（分帧算法第三次返工）。

### Fixed — 数据完整性（本轮最重要的一项）

- **执行后写出的 notebook 不再是非法 nbformat。** 此前把 sidecar 的私有输出形状（`outputType`，camelCase）**直接写进 `cell.outputs`**：每个执行过的 cell 都让文件变成 nbformat 拒绝的文档 —— JupyterLab/nbconvert 会拒绝或丢输出，本工具也读不回自己刚写的内容，而终态仍报 `write_back.performed: true` 且无任何 warning。新增 `nbformatOutputsOfRaw()` 作为写入方向的边界转换（含 nbformat 只在 `execute_result` 上要求的 `execution_count`），两条写回路径统一使用（FID-1）。
- **`set_cell_type` → markdown 不再留下 `execution_count: null`。** nbformat 禁止 markdown cell 出现该键，而序列化只为 code cell 填写它，于是这个 `null` 会**永久留在用户文件里**；现在按 SPEC §4.5 写规则 4 删除（FID-3）。
- **新增写前结构自检。** 除重新解析外，还检查 nbformat 结构规则（非 code cell 不得有 `outputs`/`execution_count`、`output_type` 必须存在、`stream`/`error`/`execute_result`/`data` 的必要字段），违反即 `selfcheck_failed` 中止写入。"不会静默改坏"因此成为对**结果**的承诺，而不只是对解析器的承诺（FID-4、D-032）。
- **读路径不再谎报"没有输出"**：未知 `output_type` 映射为 `unsupported` 而不是被静默丢弃（FID-2）。

### Fixed — 其他

- **`notebook_run_status` 的 `write_back.backupPath` → `backup_path`**，与 `notebook_run` 的同名字段一致（FID-5）。这是**修正**而非新增：同一字段在两条工具路径上曾拼法不同。
- **超时立刻返回，不再白等 30 秒。** sidecar 判定超时后去等一个**不可能到达**的 `execute_reply`（kernel 还在跑那个 cell），实测 `timeout_seconds=3` 的 `time.sleep(30)` 花掉 38 秒；现在 `timeout_seconds` + 约 5 秒返回（FID-6、D-033）。
- **内核启动失败的诊断完整了**：退出码符号化与 stderr 尾巴此前是**二选一**，于是"既有 stderr 又有退出码"的场景（pyzmq 崩溃）丢掉了符号名；现在两半都给，sidecar 自报错误在子进程已死时也带退出事实（ROB-10 补完）。
- **未知参数名重新变得可诊断**：v3 的 strict schema 让工具层白名单成为不可达代码，改为 passthrough + 工具层拒绝，未知参数现在返回 `invalid_arguments`（含 `detail.field`/`detail.reason`），符合 SPEC §4.1.12（NEW-1、D-024 更新）。
- **`notebook_locked` 不再因瞬时冲突误报**：Windows 对"文件被占用"与"两次 rename 撞车"返回同一批 errno，rename 现在有界重试约 0.75 秒后才报锁（D-035）。
- **connection file 用 `mkstemp` 原子创建**（0600、名不可预测），消除共享临时目录上的 TOCTOU 面；**失败启动也会清理**（此前本仓测试攒下 16 个残留）（SEC-TOCTOU、D-034）。
- `cell_selector` 增加 4096 字符上限，超限报 `invalid_arguments` 且不回显原值（NEW-3、D-036）。

### Fixed — 性能

- **NDJSON 分帧第三次返工并收敛为 O(L)**：v3 修了拷贝、v4 修了扫描，但游标方案的"跳过已扫描块"循环本身是 O(chunks²)，且 `Buffer.concat` 仍在拷贝增长中的前缀（64 MiB / 16 KiB 分块 ⇒ 3400 万次块遍历 + 8.6 GB 拷贝）。现在用**单个倍增缓冲**，并保持"永不回看已扫描字节"：每字节最多被拷两次、扫一次（NEW-3）。用例以"扫描字节数 ≤ 1.1 × 数据量"断言算法，而不是断言墙钟时间。
- **`realpath` 结果记忆化**：`#norm` 每次调用都做 `realpathSync`，且每个 session 一次 + 每次查询一次 —— 一次 N cell 的 run 会做 N 次同步 stat 链（NEW-4）。

### Changed

- `timeout_seconds` 声明为整数（`.int()`）。**广播类枚举保持在工具层**：schema enum 会让 SDK 抢先返回协议错误，而 U27 要求枚举违规返回 `invalid_arguments`（NEW-2 部分）。

### Internal

- **QUAL-1 第三次同类事故的根治**：新增 `scripts/check-indent.mjs`，用 TypeScript parser 校验"块内直接语句同列 + 闭合括号与开启行列相同"，接进 `pnpm lint`；`src/run.ts` 的全部块用同一个 AST 驱动收敛一致。此前三次都是手工局部修正，且我上一轮**方法错误地**判为已修（只抽样了旧行号）。
- `pnpm lint` 现在还跑 `check-format.mjs`（tab / 行尾空白）；`prepack` 不再依赖 pnpm 存在并已实测（删掉 `lib/` 后 `npm pack --dry-run` 重建成功）；`prepublishOnly` 改用 npm 脚本自调用。
- `src/fs/backup.ts` 的保留策略告警去掉了重复的 `[ipynb-mcp] warn` 前缀。

### Tests

- **外部权威成为固定动作**：`tests/integration/nbformat-validator.ts` 起子进程跑 Python `nbformat.validate`，被 `[FID-1]`、`[FID-3]`、`fixtures-valid.test.ts` 使用；后者对每个 notebook 字面量同时跑"自己的结构检查"与真 nbformat，另有零依赖静态检查禁止新增缺 `display_name` 的 kernelspec。**它第一次运行就发现 9 处测试 fixture 本身不是合法 nbformat**（`kernelspec` 缺 `display_name`、`execute_result` 缺 `execution_count`）——这正解释了三轮评审为何漏掉 FID-1：写入方与测试用同一套私有字段名。
- **新增真客户端冒烟 `pnpm smoke`**（`scripts/e2e-smoke.mjs`）：拉起 `lib/bin.js`，用 SDK Client 走完整 JSON-RPC，断言 11 项（工具清单、无 `outputSchema`、未知参数、run、nbformat 校验、字段形状、round-trip、stderr 分流）。**已用变异验证**：把 FID-1 改回去，它会变红。
- 新增 `[FID-4]`（结构自检）、`[W1]` ×2（rename 重试与有界性）、`[NEW-3]`（扫描字节数）、`[ROB-8]` 集成用例（取消落在写回窗口）；U9 ×2 改为断言 `execution_count` 键**不存在**。

### Deviations

- 见 `docs/DEVIATIONS.md` **D-001 ~ D-036**（本轮新增 D-032 ~ D-036）。

## [Unreleased] 0.1.0 — 第三轮代码复核整改（未发布）

> 来源：`docs/review/ipynb-mcp-code-review-v3.md`。**无工具名/参数名变更**；有一处行为收紧
> （未知参数名现在会被拒绝，见下）与一处错误 detail 增强。

### Fixed — 正确性

- **超时后 kernel 真的被关闭了。** 原来先摘 session 再调 `shutdown()`，后者查不到 session 直接返回：SPEC §4.7 规则 6 要求的关闭**从未发生**，kernel 进程继续存活而注册表已遗忘它，下一次 run 会在同一复用键下起第二个活 kernel（ROB-2）。探活判定"kernel 已死"时同样先尝试关闭再摘除，避免"已遗忘但仍活着"（ROB-13）。
- **取消落在写回窗口时不再丢失已完成的结果。** 原实现抛一个 detail 为空的 `cancelled`；现在与中途取消走**同一条终态路径**，已完成 cell 照常写回并在 `detail` 报告 `executed`/`write_back`（ROB-8）。
- **`exec_cell` 的传输余量大于 sidecar 最坏耗时。** 原余量比 sidecar 自己的预算少 5 秒，默认 300s 超时必然倒挂：模型拿到 `kernel_died` 而不是 `exec_timeout`，且回收逻辑会连带杀掉同一 sidecar 上**其他 notebook** 的 kernel（ROB-11）。
- **`resume` 不会在 kernel 被换掉后继续跑。** 目标 cell 前校验承载它的 session 仍是同一个；`replay`/`full` 不受影响（ROB-8 item 8）。
- **kernel 连接文件不再落在用户目录。** 位置钉在 OS 临时目录（不再依赖临时目录解析的兜底 cwd），并在优雅关闭 / shutdown_all / stdin EOF 三个出口删除（DEP-1、ROB-3/4）。
- **`notebook_locked` 的读路径映射有回归测试**（原来只测了 helper 的语义，没测它被调用）（TST-7）。
- **复用键与 run 锁改走 realpath**：同一文件经 symlink/junction 的两种拼写不再各自建 kernel、各自持锁（ROB-6）。
- **`notebook_run_cancel` 立即返回终态**，不再 sleep 50ms 后可能返回协议里不存在的 `running`（QUAL-8）。
- **`cell_indexes` 去重并限长**：20 000 次重复索引会从一个 5 cell 的 notebook 挤出 5.6 MB 响应，现在按 §4.1.12 在工具层拒绝（ROB-5）。
- **内核失败原因可见**：`kernel_died` 的 `detail` 现在带 sidecar 最近 20 行 stderr 与退出码符号名（如 `0xC0000409 = STATUS_STACK_BUFFER_OVERRUN`），sidecar stderr 也从 debug 提升为 warn（ROB-10）。
- **解释器探测缓存加 TTL**（成功 30s / 失败 1s）：按错误提示 `pip install ipykernel` 之后无需重启 MCP 服务（ARCH-2）。
- **写锁的规范化跟随调用方的 platform**，不再用进程全局值（ARCH-3）。

### Fixed — 性能

- **NDJSON 分帧不再 O(L²)**：64 MiB 单行从约 9.3 s 降到约 1.9 s（PERF-1）。
- **超大图片在解码前被拒绝**（按 base64 长度估算下界），省掉一次解码与一次 SHA-256（PERF-2）。
- **stale 分析从二次降为线性**；`run.ts` 的 code-index 映射不再逐格 `indexOf`（PERF-3）。

### Changed

- **未知参数名会被拒绝**：六个工具的参数 schema 改为 strict。SDK 原先用非 strict 的 zod object 校验，未知键在 handler 之前被**静默剥离**（对外 JSON Schema 却声明 `additionalProperties:false`），所以 `notebook_read` 收到 `cell_selector` 时会安静地读整个 notebook。代价是该失败形态是协议错误 `-32602` 而非工具错误（D-024）。
- `kernel_died` 的 `detail` 新增 `sidecar_stderr` / `sidecar_exit`（只增不删）。

### Internal

- 删除 7 处死导出/重复实现（QUAL-2）、`runNotebook` 内的死分支（QUAL-7）、`read.ts` 的死变量（QUAL-3）；两条终态路径合并为一处（ARCH-6/ROB-8）；工具层的 nbformat 输出解析下沉到 `core/outputs.ts`（ARCH-1，顺带修掉数组形式 `data` 值被丢弃）；开启 `noUnusedLocals`/`noUnusedParameters`（QUAL-3）；CI 去掉与 `packageManager` 冲突的 pnpm 版本声明（DEP-6）并让 integration job 跑单测（TST-1）；`prepack` 不再依赖 pnpm（DEP-3）；`server.ts` 的版本号与 `package.json` 对齐（DEP-2）。

### Tests

- 新增 `[ROB-2]`/`[ROB-6]`/`[ROB-13]`/`[ROB-14]`（fake transport）、`[TST-7]`（读路径映射）、`[SEC-1]`/`[ROB-5]`（工具层）、集成 `[ROB-8]`（写回窗口取消）；I9 改为"重启后旧变量消失"的可证伪断言（TST-6）；I12 覆盖 edit+run 的完整 stdout 纯度（TST-6）；CI 上用 `IPYNB_TEST_REQUIRE_VENV=1` 禁止解释器回退掩盖环境问题（TST-1）。`[ROB-2]`、`[ROB-8]`、`[TST-7]`、`[W4]` 均做过变异验证。

### Deviations

- 见 `docs/DEVIATIONS.md` **D-001 ~ D-031**（本轮新增 D-022 ~ D-031）。

## [Unreleased] 0.1.0 — 第二轮代码复核整改（未发布）

> 来源：`docs/review/ipynb-mcp-code-review-v2.md`（评级 C：需返工）。**无工具名/参数名变更**；
> `notebook_run` 的失败结果新增了一个可选字段（见下）。

### Fixed — 崩溃与数据安全（P0）

- **死 sidecar 不再让 notebook 永久无法 run。** `getOrCreate` 遇到 transport 已死的 session 时直接摘除并重建，而不是调用必然失败的 `shutdown`（后者抛 `kernel_died` 且保留 session，使该 notebook 直到 MCP 进程重启前都无法再执行）。`shutdown` 对死 transport 变为幂等的清理；sidecar 的 `exit`/stdio `error` 事件现在会通知 registry 清理其承载的全部 session。
- **空闲回收不再能让整个 MCP 服务自杀。** 回收循环逐 session `try/catch` 并记 `warn`；`process.on('unhandledRejection')` 从"致命退出（exit 2）"降级为"记 error 日志后继续服务"（SPEC §5.1 的退出码 2 只针对**启动期**失败）。
- **kernel 意外死亡时，已完成 cell 照常写回。** 在途 cell 抛 `kernel_died` 时，run 现在会把已完成 cell 写回磁盘并在错误 detail 里报告 `write_back`（SPEC §4.8 规则 3）。
- **写回失败不再顶掉主错误码。** 失败路径的写回包在 try/catch 内：`exec_timeout` / `cancelled` / `kernel_died` 始终是模型看到的码，写回失败以 `write_back.reason` + `warn` 呈现（W3）。

### Fixed — 传输层与生命周期

- **stdio 三条流都挂了 `error` 监听**，并在写入前检查 `stdin.destroyed`/`writableEnded`：EPIPE/EOF 不再升级为 `uncaughtException`（V1/A20）。
- **请求超时后回收 sidecar 进程树**，下一次调用不会被一个卡死的进程挡住（V2/A22）。
- **sidecar 异常退出时回收其承载的 session 与进程树**（V4/A23）。
- **run 的主写回传 abort signal**（SPEC §4.1.10/§4.6.2）；写回中途被取消返回 `cancelled`（V3/A31）。
- **run 级锁改挂在规范化 notebook 路径上**，`restart`/`replay` 换掉 session 后仍然有效（W5/A6）。
- **空闲回收跳过持有 run 锁的 notebook**，不再在两 cell 之间的间隙回收 kernel。

### Fixed — 文件与配置

- **`notebook_locked` 在读取路径也生效**：被独占打开的 notebook 现在读/写都返回 `notebook_locked` 而不是 `internal`（W1，SPEC §10.2 I15）。
- **per-path 写锁会真正释放**（此前比较表达式每次都构造新 promise，删除分支是死代码）（W7）；键改为平台感知的规范化路径。
- **CLI 空值等同"未设置"**：`--exec-timeout-seconds=` / `--python ""` 不再变成 0 秒超时或空解释器（W6，与 A16 的 env 侧行为对齐）。
- **`cell_selector` 拒绝 `-1`**（此前被解析为范围 `0-1`，会执行调用方没要求的 cell）（W10）。
- **read 的图片预算改为调用级绝对量**：cell 1 用掉 9 张不再把 cell 2 截断到剩余 11 张（W4）。
- **`kernel_status` 查询失败不再谎报 `alive:false`**，多 session 并发查询（W8）。
- **主写回的清理诊断走注入 logger**，受 `--log-level` 控制（W9）。

### Changed

- `notebook_run` 失败结果的 `detail.write_back` 在写回失败时新增 **`reason`** 字段（只增不删，D22 兼容）。

### Tests

- 新增 `tests/unit/kernel-registry.test.ts`（fake transport 驱动 R1/R2/R3/V4/W5/W8）、`tests/unit/notebook-file.test.ts`（W1/W7）。
- I7 补"下一次 run 走 replay"；I10 改为在**两 cell 之间的间隙**断言 run 级锁（删除 `acquireRun` 即变红）；I16/I13 换用带 seed 输出的夹具与真实断言（T1–T3）。
- U20 用例在无法启动 kernel 的环境下**显式 skip 并记录原因**，单测在无 Python 机器上仍全绿（T5）。

### Deviations

- 见 `docs/DEVIATIONS.md` **D-001 ~ D-021**（本轮新增 D-018 ~ D-021；D-004/D-015/D-016 已按实现更正，三处此前的不实描述已修正）。

### Known environment gap

- 本机 `tests/.venv-test` 继承的 **pyzmq 26.2.0 无法启动 kernel**（sidecar 以 `0xC0000409` 退出，`Bad file descriptor`）。`tests/integration/kernel.test.ts` 与 `run.test.ts` 的传输层用例现在会**探测解释器能否真正起 kernel**，起不来就回退到 base 解释器并记一行说明，因此集成套件在两种环境下都全绿。详见 `docs/COMPATIBILITY.md`。


### Added

- 6 个 MCP 工具：`notebook_read` / `notebook_edit` / `notebook_run` / `notebook_run_status` / `notebook_run_cancel` / `notebook_kernel`（SPEC §4）。
- CAS 双锚编辑（`expected_source_hash` / `expected_text` / `expected_before`+`expected_after`），8 种 op，失败原子性。
- 三模式执行（resume / replay / full + auto），静默 replay 前缀，kernel_busy 并发拒绝，exec_timeout 与 interrupt 语义。
- 陈旧（stale）分析：Python symtable 为主，正则降级，非 Python 跳过。
- 图片输出经 MCP 原生 ImageContent 块返回；物化与返回同步；幂等 artifact。
- 后台 run（run-store：20 个已完成 / 10 分钟保留）+ progress 通知 + 取消。
- D23 解释器候选链（kernelspec → .venv/venv → PATH，逐候选记录失败原因）。
- 原子写 + 滚动备份 + 占用检测（notebook_locked）。
- 路径围栏（realpath + 大小写规范化，拒绝主目录/根目录）。
- dsh 接入包 `dsh-ipynb-mcp`（本地就绪，未发布，见 OPEN_QUESTIONS Q6）。

### Deviations

- 见 `docs/DEVIATIONS.md` D-001 ~ D-006。
