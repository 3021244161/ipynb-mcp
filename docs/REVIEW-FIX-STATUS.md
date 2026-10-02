# 代码审查整改状态（review fix status）

> **来源**：`docs/review/ipynb-mcp-code-review.md`（评级 C：需返工）
> **权威**：`SPEC.md` + `AGENTS.md`。整改只做「实现与被 SPEC 判定不符」的部分；
> SPEC 自身的缺陷按 AGENTS §0 记入 `DEVIATIONS.md` 后按 SPEC 继续。
> **更新时间**：2026-10-02

## 一、总览

| 批次 | 范围 | 提交 | 状态 |
|---|---|---|---|
| 1 | A1–A3（数据安全 P0） | `6191904` | ✅ 完成 |
| 2 | A4–A7（kernel 生命周期） | `e3dfe96` | ✅ 完成 |
| 3 | A8–A14, A16（校验与边界） | `893aa2e` | ✅ 完成 |
| 4 | A15, A17–A31（健壮性） | `f00d765` | ✅ 完成 |
| 5 | B1/B4（模块边界与去重） | `e884891` | ✅ 完成 |
| 5b | B2/B3/B5/B6（偏离登记） | — | ⬜ 待办 |
| 6 | C1–C6（发布链与 CLI） | `abaa0c7` | ✅ 完成 |
| 7 | D1–D3, D5(2/5), D7(1/4) | `867a19b` | 🟡 部分完成 |
| 7b | D4, D5 余项, D6, D7 余项 | — | ⬜ 待办 |
| 8 | E1–E3（SPEC 缺陷）+ 文档收尾 | — | ⬜ 待办 |

**门禁（提交 `867a19b` 时）**：`typecheck` 0 错 / `lint` 0 警 / 单测 **179/179** / 集成 **34/34**。

---

## 二、A 类：正确性与数据安全（31 项）

| # | 结论 | 修复要点 |
|---|---|---|
| A1 | ✅ | `clear_outputs_before` 改为**逐 cell 执行前**清空 + 快照回滚；拦截超时/取消时销毁未执行 cell 输出的数据丢失 |
| A2 | ✅ | `registry` 透传 `env: process.env`；此前 kernel 只拿到 2 个环境变量（无 PATH/HOME/conda） |
| A3 | ✅ | 空闲回收跳过 `busy` 会话 + `execCell` 入口刷新 `lastUsedAt`；长 cell 不再被中途回收 |
| A4 | ✅ | `getOrCreate` 增 `fresh`；`replay` 强制新 kernel（此前复用脏 kernel 仍报 `mode_used: replay`） |
| A5 | ✅ | `applyImagePolicy` 增 `indexStart`，read/run 传跨 cell 游标；`image_index` 全调用唯一 |
| A6 | ✅ | 新增 run 级锁 `registry.acquireRun`，`runNotebook` 全程持有；第二个并发 run 抛 `kernel_busy` |
| A7 | ✅ | 新增 in-flight promise map，同键并发启动合并；不再产生孤儿 kernel |
| A8 | ✅ | `index_shifted` 记录**第一个**结构性 op；`[insert, replace(idx), insert]` 不再漏警 |
| A9 | ✅ | `clear_outputs` 拒绝非 code cell（`invalid_ops`），不再给 markdown 写 `outputs` |
| A10 | ✅ | `'1-2-3'` 抛 `invalid_targets`，不再静默截断为 `1-2` |
| A11 | ✅ | 越界 → `range_out_of_bounds`；非 code → `invalid_targets`（错误码分工对齐 §7） |
| A12 | ✅ | sidecar 在 iopub `Empty` 分支轮询 `is_alive()`；kernel 死亡 ~5s 内报 `kernel_died` |
| A13 | ✅ | rename 后的目录 `fsync` 失败降级为 warn（文件已落盘，不再误报整体失败） |
| A14 | ✅ | `--artifact-dir` 相对值解析为绝对路径（§4.1.3 返回值一律绝对） |
| A15 | ✅ | `PathFence` 构造期 `path.resolve(root)`；`--root .` 不再全量误拒 |
| A16 | ✅ | 空环境变量视为「未设置」；`IPYNB_PYTHON=""` 不再变成显式空解释器 |
| A17 | ✅ | `notebook-file` 增 per-path 进程内写互斥，关闭「复检→rename」TOCTOU 丢改动窗口 |
| A18 | ✅ | `notebook_kernel status` 走 `transport.kernelStatus`；`alive` 反映真实 kernel 进程 |
| A19 | ✅ | `server.wrap` 套 `runTool`；`read_only_mode` 等前置异常回到结构化 `isError` |
| A20 | ✅ | stdio 三条流挂 `error` 监听 + 写前 `destroyed` 检查；EPIPE 不再崩溃整个服务 |
| A21 | ✅ | 64 MiB 上限改判「完整单行 + 未终结残行」；多条小行总量超限不再误杀健康 sidecar |
| A22 | ✅ | 传输层超时后回收 sidecar 进程树；不再留下不可达的孤儿 kernel |
| A23 | ✅ | 新增 `uncaughtException`/`unhandledRejection` 钩子；sidecar 异常退出也回收进程树 |
| A24 | ✅ | 6 处静默 `catch` 补 logger warn（R7） |
| A25 | ✅ | 写前清理 >1h 的 `.<name>.tmp-<uuid>` 残留（硬杀遗留） |
| A26 | ✅ | artifact `EEXIST` 复用前校验文件长度，截断残留重写（§5.9） |
| A27 | ✅ | 临时文件继承原 notebook 权限位；`0600` 不再被放宽为 umask 默认 |
| A28 | ✅ | `waitExit` 超时移除 once 监听；sidecar worker 线程表超 64 条压缩 |
| A29 | ✅ | 备份 `COPYFILE_EXCL` 独占拷贝（同秒命名竞态不覆盖）；裁剪失败仅 warn |
| A30 | ✅ | `shutdown` 失败保留 session 可重试并抛 `kernel_died`；超时清理不掩盖超时主结果 |
| A31 | ✅ | run 主写回传 abort signal；**完成 cell 写回故意不传**（它本身就是 abort 处理，§4.8 规则 3） |

## 三、B 类：架构与模块边界

| # | 结论 | 说明 |
|---|---|---|
| B1 | ✅ | `src/mcp/*` 已零 `node:fs` / `node:child_process`（已 grep 验收）；解释器解析收敛到 `resolveForNotebook` 单一入口（共享 ipykernel 探测缓存），markdown 判定下沉 `fs/markdown-targets.ts` |
| B2 | ⬜ | `core/model.ts` / `fs/lock.ts` / `mcp/progress.ts` 三处文件缺失需补 DEVIATIONS 登记 |
| B3 | ⬜ | 根级 `run.ts` 归属需 DEVIATIONS 登记（或迁移） |
| B4 | ✅ | `readNotebookMetadata` 纯函数消除三处重复提取 |
| B5 | ⬜ | `run-store` 反向依赖根层类型 —— 随 B3 一并登记 |
| B6 | ⬜ | `hash.ts` / `mcp/context.ts` / `mcp/tools/result.ts` / `fs/notebook-file.ts` 属合理新增，建议登记 |

## 四、C 类：发布链与仓库卫生

| # | 结论 | 修复要点 |
|---|---|---|
| C1 | ✅ | `prepack` 构建 + `prepublishOnly` 门禁 + CI unit job 加 `pnpm build`；`npm pack --dry-run` 实测含 `lib/` 与 sidecar（132 文件） |
| C2 | ✅ | `src/bin.ts` 加 shebang，产物 `lib/bin.js` 首行生效 |
| C3 | ✅ | `typecheck` 改为文档字面写法 `tsc --noEmit -p tsconfig.test.json` |
| C4 | ✅ | `OPEN_QUESTIONS.md` 逐字抄录 SPEC §12（已 diff 校验）；`docs/archive/README.md` 说明原文不可得 |
| C5 | ✅ | `zod` 依赖必要性已由 D-005 记录（本轮未改） |
| C6 | ✅ | C6a `-h` 别名；C6b POSIX `/` 拒绝；C6c 探测回 5s；C6d `normalizeForCompare` 平台感知；C6e 表格须有分隔行；C6f sidecar `except` 记日志；C6g 清理诊断走 logger |

## 五、D 类：测试质量

| # | 结论 | 说明 |
|---|---|---|
| D1 | ✅ | 夹具支持预置输出；I5 断言超时/未执行 cell 的既有输出保留；新增 I18 / I18b / I-env |
| D2 | ✅ | 新增 `tests/unit/analyze-op.test.ts` 驱动**真实 sidecar** analyze op（无 Python 时 skip）；**顺带捕获真实协议 bug**：sidecar 返回 `failed_cell_indexes` 而类型声明 `failedCellIndexes`，降级分析一直丢失失败索引 —— 已改名并覆盖 |
| D3 | ✅ | 新增 `tests/unit/edit-tool.test.ts` 走真实工具层（U2/U8/U9/U12）；CAS 失败文件与备份均不变、一次重试契约、`dry_run` 三断言、`file_changed` 带 expected/actual |
| D4 | ⬜ | 8 处用例缺失/失真待修：U13 ✅（本轮补）、U20 ✅（本轮补）已解决；**余** U12 工具层 ✅、I3（去掉 `void before`）、I7（补下一次 replay）、I9（restart 无 cell 执行）、I12（stderr 断言）、I13/I14（真在途）、I16（终态集合断言）、I17（不 mock 探针） |
| D5 | 🟡 | 已修 2/5：protocol 胶囊常量 → 独立字面量 ✅；log stdout 定向断言 ✅。**余** `atomic.test.ts` 用例名（wx flag）与实际不符、`outputs.test.ts` base64 前缀断言（应解码判魔数）、`tools-shape.test.ts` 恒真式 |
| D6 | ⬜ | 状态污染：两个集成文件改 `JUPYTER_PATH` 不恢复；`kernel.test.ts` 的 I11 PID 采集依赖同文件前序用例 |
| D7 | 🟡 | 已修 1/4：NDJSON 恰好 64 MiB ✅。**余** `ops` 恰好 32、`timeout_seconds` = 1/86400、`max_images_per_call` 恰好 20 |
| D8 | ⬜ | E1–E9 手工验收未执行（DoD 未达成，清单已交付 `docs/E2E-CHECKLIST.md`，由 boss 执行留档） |
| D9 | ✅ | 评审确认为正面实践，无需整改 |

## 六、E 类：SPEC 自身缺陷（不改代码，登记 DEVIATIONS）

| # | 结论 | 处理 |
|---|---|---|
| E1 | ⬜ | D14 后台判定式使同步路径在默认配置下不可达（`300 × 1 = 300 > 30` → **每次 run 都进后台**），与 §0「≤60s 跑通第一个 cell / 不烧 token」冲突。属 SPEC 自相矛盾 → 记 DEVIATIONS 后取**改动最小**解法（保守估计式，不加新参数） |
| E2 | ⬜ | R6「禁止读写 root 之外」与 §5.2 解释器探测（读 `~/.local/share/jupyter/kernels`、执行 PATH 上 `python`）冲突。实现按 §5.2 → 记 DEVIATIONS 并注明豁免面 |
| E3 | ⬜ | 单行 64 MiB 上限与 §4.4「20 × 20 MiB 图片」上限自相矛盾（合法内容可触发协议错误并杀 sidecar）。记 DEVIATIONS，建议动态上限 |

---

## 七、下一步（按优先级）

1. **D4 / D5 余项 / D7 余项**：补齐缺失与失真的验收用例（评审列为 P1）。
2. **D6**：修测试状态污染，使用例可单独运行。
3. **B2 / B3 / B5 / B6**：补 `DEVIATIONS.md` D-007 起各条（AGENTS §0 强制）。
4. **E1–E3**：登记 SPEC 缺陷偏离；E1 附带最小实现修正（保证默认单 cell 走同步路径）；README 补「已知限制」（单次执行图片总体积受 64 MiB 限制）。
5. **D8**：E1–E9 由 boss 手工执行留档。

> **停点说明**：本轮（token 受限后）完成了「批次 7 的进度收口 + 本状态文档」这一最小可控单元，
> 门禁全绿并已提交 `867a19b`。后续从上方第 1 项继续。
