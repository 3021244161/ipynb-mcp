# Changelog

本项目的接口变更遵循 D22 兼容承诺（工具名与参数名在 1.x 内不删不改；新增参数一律可选带默认值；返回字段只增不删）。

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
