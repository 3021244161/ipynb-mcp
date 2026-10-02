# Changelog

本项目的接口变更遵循 D22 兼容承诺（工具名与参数名在 1.x 内不删不改；新增参数一律可选带默认值；返回字段只增不删）。

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
