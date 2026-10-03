# Changelog

本项目的接口变更遵循 D22 兼容承诺（工具名与参数名在 1.x 内不删不改；新增参数一律可选带默认值；返回字段只增不删）。

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
