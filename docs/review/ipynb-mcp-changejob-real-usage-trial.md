# ipynb-mcp 真实使用实测（ChangeJob 5 个真实 notebook）— 2026-10-05 02:13

Boss 要求："试试最近我做的 ipynb-mcp，用 Changejob 里的 ipynb，挑 5 个来试试"。

**做法**：不读代码猜——写了一个真实 MCP 客户端驱动脚本，通过 stdio 把本地构建 `E:\Work\ipynb-mcp\ipynb-mcp\lib\bin.js` 当 server 拉起来（与 Claude Code / dsh 接进去同一条链路），对 5 个真实 notebook 做端到端调用。原始文件**零改动**（只复制到 `E:\tmp\ipynb-trial\nb` 再操作，已用时间戳核实原文件 mtime 未变；fence 也实测拒绝了 root 外的路径）。

- 驱动脚本（新增，未提交 git）：`E:\Work\ipynb-mcp\ipynb-mcp\scripts\trial-changejob.mjs` + `scripts/trial-scenarios.mjs`
- 用法：`node scripts/trial-changejob.mjs --root <dir> --scenario suite|one|contract [--notebook X --probe plain|image|env --heap 8192 --mode auto --write false --kernel-start false --stderr-log <file>]`
- 挑选的 5 个：`20py.ipynb`（天竺街py30+20）、`simple-baseline-aai3100.ipynb`（SimpleCNN45，0 输出作业模板）、`便捷性.ipynb`（xgboost调参70，39MB）、`hw2_solved.ipynb`（老客户任务80，88 cells）、`coursework_base.ipynb`（english-hw，信号处理模板）

## 结论：能用，而且够硬；但有一个"让 server 直接崩掉"的致命边界

### 一、✅ 已验证可用（4/5 全绿）

| notebook | 结果 |
| --- | --- |
| 20py.ipynb | ✅ 全流程：read→CAS 负例→dry-run→插 cell→kernel start→resume 跑 cell→write_back→读回(exec_count=1, outs=2)→**stale=12**→背景运行+轮询→markdown 检查→shutdown |
| simple-baseline-aai3100 | ✅ 0 输出的作业模板跑完变 1 输出，写回正确 |
| hw2_solved（88 cells） | ✅ resume 跑单 cell 成功，写回正确（无 replay） |
| coursework_base | ✅ 同上；`stale_analysis_degraded`（见下） |
| 便捷性（39MB） | ❌ 崩溃（见二）；**4MB / 16MB / 24.7MB 变体全绿**，抬 heap 后原文件也全绿 |

合同项全部通过（实测）：路径 fence 拒绝 root 外真实中文路径（`path_outside_root`）；未知参数报错（`invalid_arguments`）；伪造 run_id 报 `run_not_found`；CAS 负例拒写且文件 content_hash 不变、错误里带回 current_source_hash+current_source（一次重试即可成功）；dry_run 不落盘；markdown 未闭合围栏 → `markdown_invalid` 拒绝整次编辑；kernel start/status/shutdown 干净，**事后 tasklist 确认无孤儿 sidecar/kernel 进程**。

### 二、🔴 P0：38MB notebook 执行 `notebook_run` → node 进程 OOM 硬崩（可复现）

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
heap 2048MB 撞顶 → 连接被掐断
```
- 客户端只看到 `MCP error -32000: Connection closed`，**没有错误码、没有任何可读失败信息**；因为崩的是 server 进程，**该 server 名下所有 notebook 的 kernel 一起死**。
- 连跑两次完全一致（可复现）。**`write_outputs=false` 照样崩** → 不是 write-back 那一跳的锅，是 run 路径本身的内存放大。
- 阈值实测：4MB ✅ / 16MB ✅ / 24.7MB ✅ / 32.9MB ❌ / 38.4MB ❌ → 断点在 ~25–33MB 之间，约 **文件大小的 50 倍内存放大**（38MB → >2GB heap）。
- **根因确认**：纯 heap 上限问题。加 `NODE_OPTIONS=--max-old-space-size=8192` 后，同一个 39MB 文件 `notebook_run` **完整成功**（write_back=true、stale=22、python-symtable、零 warning）。疑似原因：run 路径同时持有 `preRunDoc` + 当前 doc + 写入前自检再解析 + 序列化字符串等多份整文档副本。
- **影响面很大**：Boss 的 4 个 xgboost 调参 notebook 全是 35–39MB（SHAP/部分依赖图正常产物）。这属于"真实用户第一个会撞到的问题"。
- 建议修法（按性价比排序）：①`bin.js` 自己 re-exec 加 `--max-old-space-size`（客户端是 `node lib/bin.js`，shebang 用不上）；②run 前按 stored output 字节数做守卫，超阈值给干净的 `notebook_too_large` 而不是死进程；③减少整文档副本（preRunDoc 只保留被 touched cells 所需信息）；④README Known limitations 明写这个体积边界。

### 三、⚠️ P1：没有"只跑这一格、不 replay"的模式（实测）

实测 `mode=auto` + 单 cell selector + 无活 kernel → `mode_used=replay`、`replayed=14`（我插在末尾的探针 cell 前面 14 个 cell 被静默全部重跑）。代码路径：`src/run.ts:308-326`（auto 无活 kernel 时 `replayPrefix = cells < first`）。
- 危险场景：`hw2_solved` 前面有 `!wget aclImdb`（下载 IMDb 数据集）+ torch 100 epoch 训练；对它调 `notebook_run(cell_selector='87')` 会把整套重跑一遍。
- **正确姿势（本次实测采用的）**：先 `notebook_kernel(action='start')`，再 `notebook_run(mode='resume')` → `replayed=0`，只跑目标格。这个套路**目前没有任何文档/工具描述提示**，建议写进 README + 工具 description。
- 附带实测：无活 kernel 时 `mode='resume'` → 干净的 `kernel_not_available`（行为正确）。

### 四、ℹ️ 其它观察

- `stale_analysis_degraded`（hw2_solved、coursework_base）**不是 bug**，是文档说过的行为被正确触发：hw2 cell 12 有 `!wget` shell magic（非 Python 语法）；coursework_base 的作业模板里本来就有非 Python 占位符（`n = np.arange(0, ?)`、`x_original = `）。代价：交作业/学生模板类文件上 stale 分析基本永远退化成 regex 低置信度——值得在 README 里更醒目。
- stale 分析正向用例实测有效：20py 跑 cell 0 后报 12 个 stale cell；便捷性报 22 个。
- read 一个 38MB notebook 只要 ~2.0s，`include_outputs='none'/'summary'` 体感无压力。
- 小瑕疵：`notebook_edit` 的 `changed_cells[]` 里没有 op/change 名（我按 `change`/`op` 取都是 undefined），只暴露 cell_index，调试时少一点信息。
