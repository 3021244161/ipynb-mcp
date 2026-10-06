# ipynb-mcp 技术设计 v3（唯一权威实现规格）

- **版本**：v3.0（实现规格，冻结）。实现期间禁止偏离本文档；发现文档错误时记入 `docs/DEVIATIONS.md` 后继续，**但本文档的接口契约与红线优先于任何示例代码**。
- **文档效力**：本文档**取代** `TECH_DESIGN.md`（v1，dsh bundle 形态）与 `ipynb-mcp-DESIGN-v2.md`（v2，架构与定位）。两者移入 `docs/archive/` 仅作历史存档。
  v1 中已被本文档吸收的规范章节：§5.1（sidecar 协议）、§5.2（解析与序列化）、§5.3（CAS 文本锚定）、§5.4（输出映射）、§5.5（markdown 检查器）、§5.9（备份与 artifact）。**除此之外 v1 的一切条款均不再生效**（尤其是其 dsh 相关部分：D6/D8/D9/D12/D13、§4.3–§4.7 的工具 schema、R12/R13/R17/R18/R20）。
- **目标运行环境**：Node.js ≥ 22；Python ≥ 3.10（由 notebook 自身的 kernelspec 决定，本插件不安装任何 Python 包）。
- **本文档读者**：实现本插件的编码 AI。你不需要理解产品动机，只需严格实现本文档；§12 列出**唯一**允许向人类提问的事项。

---

## 0. 产品定位（仅供理解上下文，不影响实现）

一句话：**让任何 AI agent 安全地读取、编辑、执行本地 Jupyter Notebook，不需要预先启动任何服务。**

三个不可退让的卖点（违反即实现错误）：
1. **零服务**：`npx -y ipynb-mcp-server` + 一行客户端配置即可用，不要求用户启动 JupyterLab、不管 token。
2. **不会静默改坏**：任何源码改动都必须携带 CAS 锚，不匹配就失败，绝不写入。
3. **不会重跑你的长任务**：改一个 cell 只跑那一个（`resume`），或在没有 kernel 时静默重建状态（`replay`）。

三条工程硬约束：
1. **自己用不麻烦**：干净机器上从零到跑通第一个 cell ≤ 60 秒。
2. **不烧 token**：read 默认只给预览与摘要；编辑失败必须一次可重试；`replay` 静默。
3. **不烧算力**：read/edit 绝不起 kernel；只有 `notebook_run` 起；空闲回收。

---

## 1. 范围

### 1.1 做

6 个 MCP 工具：`notebook_read` / `notebook_edit` / `notebook_run` / `notebook_run_status` / `notebook_run_cancel` / `notebook_kernel`。

### 1.2 明确不做（任何情况都不实现）

1. 不做 notebook 编辑器 UI / 渲染器 / 图片查看器。
2. 不做 notebook 格式转换（`.ipynb` ↔ `.py` / `.md`）。
3. 不做协作、同步、云端上传、实时 CRDT。
4. 不安装任何 Python 包，不修改用户的解释器环境与 kernelspec。
5. 不做 kernel 状态快照 / 变量序列化 / 断点续训。
6. 不自动创建不存在的 notebook（B6）。
7. 不支持 `application/vnd.jupyter.widget-view+json` 等交互式 widget 输出（降级为 `unsupported`）。
8. 不收集任何遥测数据（B8）。
9. 不实现"自动补齐定义某变量的上游 cell"（`replay` 语义固定为"从头静默补到起点"）。

### 1.3 语言支持范围（A2 决策）

- **实现必须语言无关**：kernel 启动、执行、输出映射（按 MIME）、kernel 生命周期均不依赖 Python。
- **对外声明"已测试 = Python"**；非 Python kernel（R、Julia 等）必须能正常读取/编辑/执行，但：
  - 跳过 stale 分析，`stale_analysis.method = "skipped"` 并追加 warning `stale_analysis_skipped`；
  - 不参与 CI 矩阵。
- 编辑、序列化、备份、artifact、markdown 检查器全部语言无关，**不得**加入 Python 专属分支。

---

## 2. 技术决策

> 格式：**选定 / 理由 / 否决**。实现者禁止替换选定方案。标注 `[v1 变更]` 的是与 v1 不同的决定。

### D1 交付形态 = MCP server（stdio）

- **选定**：发布为 npm 包 `ipynb-mcp-server`，作为 stdio MCP server 运行；另发一个纯配置 dsh bundle 作为可选接入层。
- **理由**：一份代码同时服务所有 MCP 客户端（Claude Code、Cursor、VS Code、dsh……），且 dsh 本身是 MCP 客户端，可用纯配置 bundle 接入；受众最大化是开源目标的前提。
- **否决**：dsh 原生插件（受众仅限 dsh 用户）；HTTP/SSE 传输（增加部署面，stdio 才是 `npx` 即插即用的形态）。

### D2 单一 npm 包，不拆 monorepo `[v1 变更]`

- **选定**：一个仓库、**一个**发布包 `ipynb-mcp-server`，内部按 `src/core`、`src/fs`、`src/kernel`、`src/mcp` 分目录；`python/ipynb_sidecar.py` 随包发布。
- **理由**：`npx` 只解析一个包；多包会引入版本偏斜与 peer 解析失败，对即插即用是净损失。内部目录已提供同样的边界纪律。
- **否决**：pnpm workspace 多包（v2 曾这样设计；除非将来要单独发布 `@ipynb-mcp/core`，否则只有成本没有收益）。

### D3 执行后端 = Python sidecar（`jupyter_client`），接口隔离

- **选定**：Node 以 `<kernelspec 的 argv[0]> -u <sidecar.py>` 启动 sidecar；sidecar 用 `jupyter_client.KernelManager` 持有 kernel；Node↔Python 走 NDJSON over stdio。Node 侧通过 `KernelTransport` 接口隔离实现，为将来换纯 Node ZMQ 留缝。
- **理由**：(a) 需求"从被修改的 cell 继续执行、前面绝不重跑"要求 kernel 跨调用存活；(b) **不需要用户额外安装任何包**——能跑 notebook 的环境必有 `ipykernel`，而 `ipykernel` 自身依赖 `jupyter_client`；(c) `KernelTransport` 隔离使替换成本可控。
- **否决**：`jupyter nbconvert --execute`（整本执行、无法 resume）；Node 侧自实现 ZMQ Kernel Protocol（HMAC/多通道/iopub 自研，+3–5 天且引入新风险面；留作 M3 可选）；复用外部 Jupyter Server（违反"零服务"）。

### D4 文件读写 100% 在 Node 侧

- **选定**：`.ipynb` 的解析/修改/落盘全在 Node；sidecar 只接收 `{code, silent, storeOutputs, timeoutMs}` 与 `{sources}`，**永不接触文件路径**。
- **理由**：单一写入方，杜绝竞争；notebook 结构处理是纯 JSON 操作。
- **否决**：Python 侧用 `nbformat` 读写文件（引入第二写入方与文件锁）。

### D5 增量执行必须有三种显式模式

- **选定**：`resume` / `replay` / `full`（§5.3 矩阵）。默认 `mode='auto'`：存在存活且绑定的 kernel → `resume`；否则若起点 > 0 → `replay`；否则 → `full`。
- **理由**：kernel 状态不可序列化，"能 resume"与"不能"是两种本质不同的语义，必须显式暴露。
- **否决**：一律 `full`；kernel 已死时假装 resume；变量快照恢复。

### D6 源码编辑采用 CAS 双锚，无锚不写入

- **选定**：每个改动源码的 op 必须携带 **cell 级 `expected_source_hash`** 或 **行级 `expected_text`**（§5.2 矩阵）。不匹配 → 抛 `cas_mismatch`，**不写入**，并在 `detail` 中回传足以一次重试的信息。
- **理由**：(a) `.ipynb` 中"第 12 行"只是某版本的快照坐标，静默写错是最严重故障；(b) 只允许逐字回传原文会让能力较弱或上下文较长的模型反复失配，形成"读-重试"往返风暴，既烧 token 又伤体验——cell 级 hash 锚让你只需回传读到的 hash。**这一条同时是竞品对比中的核心差异点。**
- **否决**：只按行号写入；整体文件 hash 做 CAS（粒度过粗）；只做逐字文本锚（v1 方案，容错性不足）；把 patch 下推给 Python（违反 D4）。

### D7 cell 定位优先使用 nbformat 4.5 的 cell `id`

- **选定**：接受 `cell_id` 或 `cell_index`，`cell_id` 优先。`nbformat_minor < 5`（无 cell id）且使用 `cell_index` 时允许执行，但追加 warning `no_stable_cell_id`。
- **理由**：`index` 在任何 cell 增删后失效；`id` 是格式定义的稳定标识。
- **否决**：自动把用户文件升级到 4.5（对用户文件的非必要改写）；拒绝支持旧文件（用户存量大量是旧版）。

### D8 `move_cell` 不再要求稳定 id `[v1 变更]`

- **选定**：`move_cell` 在任意 nbformat_minor 下均允许；文件无 cell id 时追加 warning `no_stable_cell_id`。
- **理由**：v1 以"无稳定 id 时移动不安全"为由拒绝（`NB_E_MOVE_REQUIRES_IDS`），但单次请求内的坐标由 §4.1.8 的坐标系规则完全确定，跨请求由客户端重新读取确定——**拒绝没有正确性依据，只是把旧文件用户挡在门外**，而旧文件占存量多数。
- **否决**：v1 的拒绝策略；自动补写 cell id（违反"不自动升级格式"）。

### D9 图片经 MCP 原生 image content 返回

- **选定**：图片在**将作为 MCP `ImageContent` 块返回时**才 base64 解码并写入 artifact 目录（不返回则不物化、不写任何文件，见 §4.3），并保证 base64 **绝不出现**在任何文本内容中。图片返回策略由 `--images`（`auto|never|always`）控制（§4.4）。
- **理由**：MCP 工具结果原生支持图片内容块，客户端自行处理（dsh 会转成 attachment）；v1 那套"注入 user 消息"的方案建立在"工具结果无法携带图片"这一错误前提上。
- **否决**：base64 进文本（上下文爆炸）；只给 artifact 路径（多数模型无视觉读取能力）；自建注入机制。

### D10 cell 内异常不是错误，是领域结果

- **选定**：cell 内 Python 异常 → 工具**正常返回**（MCP `isError` 不置位），规范值中 `status:"error"` + 结构化错误信息。只有基础设施故障（sidecar 崩溃、文件读失败、路径越界、CAS 不匹配、超时、只读拒载）才置 `isError: true`。
- **理由**：错误卡片会丢失 traceback，模型无法据此修复。
- **否决**：cell 报错即 tool error。

### D11 陈旧分析 v3：Python AST 为主，非 Python 跳过

- **选定**：sidecar 新增 `analyze` op，用标准库 `ast` 提取每 cell 的定义名集合 `D(i)` 与使用名集合 `U(i)`；算法见 §5.6。非 Python kernel 跳过并声明。
- **理由**：v1 用四组正则，已知漏检 `a, b = f()`、`with ... as f`、`x: int = 1`、缩进块内赋值，却打 `confidence:"high"`——而 stale 分析是宣称为用户消除"失效输出"的能力，不可靠的 high 比不做更糟。`ast` 是标准库、零新增依赖、解释器已在手边。
- **否决**：v1 的正则方案（保留为纯 Node 路线下的降级实现，非当前路径）；"不做 stale 分析"（用户会拿到看似正确实则失效的输出）。

### D12 原子写 + 强制备份 + 占用处理 `[v1 增强]`

- **选定**：写入前生成备份；新内容写同目录临时文件 `.<name>.tmp-<uuid>`；`fsync` 文件后 `rename` 覆盖；POSIX 上再 `fsync` 目录。`rename` 遇到 `EBUSY`/`EPERM`/`EACCES` → 抛 `notebook_locked`（§7）。
- **理由**：notebook 是用户长期资产，半写入会造成不可读文件；**用户一边开着 Jupyter/VS Code 一边让 agent 改文件是常态**，被持有文件上的覆盖失败必须有专门错误码与可操作提示，不能落进内部错误。
- **否决**：直接 `writeFile`；备份进回收站；对占用失败做无限重试。

### D13 错误类型 = 单一 `IpynbError`（code + detail）

- **选定**：`class IpynbError extends Error { readonly code: string; readonly detail?: JsonValue }`；全部错误码见附录 A。工具层统一捕获并映射为 MCP tool error（`isError: true`），内容为单个文本块，内含 `{"code","message","detail"}` 的紧凑 JSON。
- **理由**：脱离 dsh 后不再需要 `HarnessError`；稳定 `code` 是模型与测试的可靠路由依据。
- **否决**：直接用字符串抛错；把 `detail` 塞进 `message`（不可解析）。

### D14 长任务 = progress 通知 + 异步句柄工具

- **选定**：MCP 没有跨客户端一致的作业机制，因此：单 cell 执行前若已有累计耗时超 `background_threshold_seconds`（默认 30）或 `timeout_seconds × 目标 cell 数 > background_threshold_seconds`，`notebook_run` 返回 `{run_id, status:"running"}`；配 `notebook_run_status` / `notebook_run_cancel`。客户端提供 `_meta.progressToken` 时，每次 cell 完成发 `notifications/progress`。
- **理由**：多数 MCP 客户端对单次工具调用有超时预算，长任务必须让出控制权；progress 是 MCP 标准机制，但有客户端不发 token，故轮询必须独立可用。
- **否决**：前台阻塞至完成；自建进度通道；依赖客户端特定扩展。

### D15 参数与返回一律 snake_case

- **选定**：工具名、参数名、返回字段全部 `snake_case`（`notebook_read`、`include_outputs`、`cell_index`）。
- **理由**：MCP 生态惯例；v1 的 camelCase 是 dsh 惯例。
- **否决**：混用；camelCase。

### D16 日志一律 stderr

- **选定**：**stdout 只允许出现 JSON-RPC 消息**。所有日志经 stderr 输出（`--log-level` 控制）；sidecar 的 stderr 逐行转发为 debug 日志。**禁止**把用户源码或 cell 内容写入日志。
- **理由**：stdio 传输下任何非协议字节写入 stdout 都会污染帧、直接导致服务不可用——这是 MCP server 最经典的翻车点。
- **否决**：写文件日志（用户找不到）；默认 stdout。

### D17 默认路径围栏

- **选定**：`root` 默认取进程启动时的工作目录；**若解析后的 `root` 等于用户主目录或文件系统根，则拒绝启动**，并在 stderr 给出明确指引要求显式 `--root`。默认禁止操作 root 之外的文件（读与写都禁），`--allow-outside-root` 可放开。
- **理由**：否则围栏形同虚设（cwd 常为主目录），或第一次运行就管到整个磁盘。
- **否决**：无围栏；默认放开。

### D18 `--read-only` 只允许 read 与 kernel status

- **选定**：开启后 `notebook_read` 与 `notebook_kernel`（仅 `action:"status"`）可用，其余工具与动作返回 `read_only_mode`。
- **理由**：给谨慎部署一个可用的逃生口，同时语义边界唯一、可判定。
- **否决**：默认开启（功能残缺，反而促成用户关掉它）；语义模糊的"半只读"。

### D19 不自动创建 notebook

- **选定**：`path` 指向不存在的文件 → `file_not_found`，错误信息说明本工具只处理已存在的 notebook。
- **理由**：定位是"处理你已有的 notebook"；创建涉及 nbformat 默认值与 kernelspec 元数据，是独立功能。
- **否决**：自动创建空 notebook（隐式写用户的磁盘）。

### D20 零遥测

- **选定**：不收集、不发送任何数据；不联网（除用户自己的 kernel 代码之外）。README 显式声明。
- **理由**：收集必被质疑，对个人项目亦无收益。
- **否决**：匿名统计（哪怕 opt-in 也会被怀疑）。

### D21 Node ≥ 22，SDK 锁 `@modelcontextprotocol/sdk` 1.31.x

- **选定**：`engines.node: ">=22"`；依赖 `@modelcontextprotocol/sdk` 锁 `1.31.x`（当前实测 1.31.0）。CI 矩阵 Node 22 与 24。
- **理由**：22 是当前 LTS，且 SDK 需要现代 ESM / `AbortSignal`；锁定 SDK 次版本，避免协议面漂移。
- **否决**：`^1` 浮动（协议行为变化不可控）；Node 18/20（已过或临近 EOL）。

### D22 工具表面对外兼容承诺

- **选定**：工具**名**与**参数名**在 1.x 内不得删除或改名；新增参数一律可选且带默认值；返回字段只增不删。破坏性变更须升 major。
- **理由**：MCP 工具会被客户端缓存进提示词，静默改名会让老用户的会话突然失效。
- **否决**：无承诺的自由演进。

### D23 解释器解析优先使用 notebook 自己的 kernelspec `[v3 新增]`

- **选定**：候选顺序为 ① 显式 `--python` / `IPYNB_PYTHON` → ② notebook 的 `metadata.kernelspec.name` 指向的 `kernel.json` 的 `argv[0]` → ③ notebook 所在目录的 `.venv` / `venv` → ④ PATH 的 `python3` / `python`。**②–④ 构成候选链：任一候选不存在或校验失败即继续尝试下一个，并记录原因；仅当全部失败才抛错**，`detail` 列出每个候选及其失败原因。**唯一例外**：① 是显式指定，失败即终局，不降级。
- **理由**：(a) kernelspec 是 **notebook 作者声明的意图**——用户在 Jupyter / VS Code 里打开这个 notebook 时用的就是它，跟随它才能保证"agent 跑出来的结果和用户自己跑的一致"；(b) notebook 旁边的 `.venv` 只是**约定式猜测**，它可能是为仓库工具链建的、也可能缺 `ipykernel`；(c) **选错解释器的代价高于找不到**——它要么以 `ImportError` 暴露，要么更糟：用版本不同的库算出看起来合理的错结果，属于静默错误方向。
- **代价与补偿**：kernelspec 解析成功、但 notebook 旁边存在 `.venv`/`venv` 且其解释器与之不同时，追加 warning `kernelspec_mismatch`（§5.2 穷举了全部触发条件），提示用户可用 `--python` 一键覆盖。**禁止**自动改写 notebook 的 kernelspec。
- **否决**：① 让 `.venv` 优先于 kernelspec（"用户建了 .venv"并不等于"这个 notebook 用它"；把唯一权威信号降级为备选，会让"为什么跑错环境"变得不可解释）；② 只认 PATH 的 `python`（多环境机器上几乎必然错）；③ **首个候选失败即报错**（会把"kernelspec 指向的系统 python 没有 ipykernel、而旁边的 .venv 有"这一常见情形变成死路）。

### D24 不使用 `structuredContent`，返回值一律为单个文本 JSON 块 `[v3 新增]`

- **选定**：工具结果**只包含一个文本内容块**（紧凑 JSON），外加（按 §4.4 的）若干图片块。**不声明 `outputSchema`、不返回 `structuredContent`**。
- **理由**：(a) 本工具的直接消费者是**模型**而不是程序，文本 JSON 是唯一在所有 MCP 客户端上都会被完整转交给模型的形态；(b) 若同时提供文本与结构化副本，同一份数据被发送两遍，token 直接翻倍，与 §0 的"不烧 token"硬约束冲突；(c) 只走结构化则在不支持该能力的客户端上丢数据，并迫使实现维护两套响应形状与两套测试。
- **否决**：① "文本放摘要、结构化放全量"的分工（响应形状随客户端能力分叉，测试面对两种形态，且模型在支持该能力的客户端上可能只看到摘要、拿不到完成下一次调用所需的哈希）；② 双写（token 翻倍）；③ 按客户端能力做响应降级（引入不可预测的兼容面）。

---

## 3. 架构

### 3.1 分层

```
┌───────────────────────── MCP 客户端（Claude Code / Cursor / VS Code / dsh / …） ─────────────────────────┐
│  stdio：JSON-RPC（MCP）。stdout 仅承载协议消息                                                          │
└───────────────────────────────────────────┬─────────────────────────────────────────────────────────────┘
                                            │
┌───────────────────────────────────────────┴─────────────────────────────────────────────────────────────┐
│ src/mcp/        server.ts（组装）· tools/*（6 个工具）· render/*（文本投影）· progress.ts                │
│ src/kernel/     registry.ts（会话注册表）· transport.ts（接口）· sidecar-transport.ts · protocol.ts      │
│ src/fs/         fence.ts（路径围栏）· atomic.ts（原子写）· backup.ts · artifact.ts · lock.ts             │
│ src/core/       model.ts · parse.ts · edit.ts · outputs.ts · markdown.ts · stale.ts · errors.ts          │
│ src/config.ts · src/log.ts · src/bin.ts                                                                  │
└───────────────────────────────────────────┬─────────────────────────────────────────────────────────────┘
                                            │  stdin/stdout：NDJSON（每行一个 JSON 对象）
┌───────────────────────────────────────────┴─────────────────────────────────────────────────────────────┐
│ python/ipynb_sidecar.py：守护 + 协议分发 + kernel 池 + 输出收集 + AST 分析                                │
└───────────────────────────────────────────┬─────────────────────────────────────────────────────────────┘
                                            │  Jupyter Kernel Protocol（ZMQ，由 jupyter_client 实现）
┌───────────────────────────────────────────┴─────────────────────────────────────────────────────────────┐
│ 用户 Kernel（ipykernel 或其它 kernelspec 指定的 kernel）：持有变量状态、执行代码、产出 outputs            │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 模块职责边界（强制）

| 模块 | 必须做 | 禁止做 |
|---|---|---|
| `src/bin.ts` | 解析参数、装配 config、启动 stdio server、处理进程信号 | 不含业务逻辑 |
| `src/mcp/*` | 参数补校验、调用 core/fs/kernel、投影文本与图片、映射错误 | 禁止直接碰 `node:fs`；禁止解析 notebook 语义 |
| `src/core/*` | 纯函数：输入模型 → 输出模型 | 禁止 `node:*` import、禁止 I/O、禁止时钟/随机数（`Date.now()` 仅允许出现在传给 edit 的时间戳参数中，且不得影响语义） |
| `src/fs/*` | 路径围栏、读写、原子写、备份、artifact、占用处理 | 禁止解析 notebook 语义 |
| `src/kernel/*` | 进程与协议、超时、生命周期、串行化 | 禁止解析 notebook 结构 |
| `python/*.py` | 协议分发、kernel 池、执行、中断、AST 分析 | **禁止读写任何文件**（文件 I/O 全在 Node 侧） |

### 3.3 强制规则

1. Node 侧跨模块可变状态**只允许**存在于 `src/kernel/registry.ts` 的单一 `KernelRegistry` 实例，以及 `src/mcp/run-store.ts` 的 run 句柄表。
2. 禁止调用 `jupyter` / `nbconvert` / `pip` / `conda` 等外部命令。
3. 禁止联网（除 kernel 内用户代码自身行为）。

---

## 4. 接口定义

### 4.1 通用约定

1. **命名**：工具名、参数、返回值一律 `snake_case`；notebook 内部字段沿用 nbformat 的 `snake_case`，转换只发生在 `parse.ts` 边界。
2. **坐标**：`line` / `start_line` / `end_line` / `at_line` 一律 **1-based**；`cell_index` / `at_index` / `from_index` / `to_index` 一律 **0-based**；`end_line` 闭区间。
3. **路径**：入参 `path` 接受绝对路径或相对 `root` 的路径；**返回值中一律为绝对路径，分隔符统一为 `/`**（Windows 亦然）。
4. **时间**：ISO-8601 带时区字符串。
5. **可序列化**：所有返回值必须无损 JSON 序列化 —— 禁止 `undefined`（用 `null`）、禁止 `Date`、禁止 `NaN`。
6. **`content_hash` 定义**：`"sha256:" + sha256(文件原始字节).toString('hex')`。计算对象是磁盘上的原始字节。
7. **`source_hash` 定义**：`"sha256:" + sha256(cell.source 的 UTF-8 字节).toString('hex')`，其中 `cell.source` 已按 §5.5.3 合并为单个字符串。
8. **乐观锁**：`notebook_read` / `notebook_edit` / `notebook_run` 均提供可选入参 `expected_content_hash`。传入且不匹配 → `file_changed`（`detail` 带 `{expected, actual}`）。**未传入时，写入前仍必须在"读取→写入"窗口内复检 hash**，不一致同样抛 `file_changed`。
9. **cellIndex 坐标系**：`ops` 中每个 op 的 `cell_index` / `at_index` / `from_index` / `to_index` 一律解释为「**该 op 应用到当前内存模型时**的坐标」，即前面 op 已生效后的坐标系。若同一请求中既存在改变 cell 数量的 op（`insert_cell` / `delete_cell`）又存在其后使用 `cell_index` 的 op，必须在 `warnings` 追加 `index_shifted`。返回值 `changed_cells[].cell_index` 一律是「**写回后最终文件**」坐标系中的下标。
10. **超时与预算**：单次工具调用内部的全部 I/O 必须观察 MCP 的 abort signal（§4.6）。
11. **两个"选 cell"的参数名必须不同（强制）**：`notebook_read` 用 **`cell_indexes`（integer 数组）**，`notebook_run` 用 **`cell_selector`（字符串选择器）**。**禁止**为二者取同一个参数名——同名不同类型的参数会让模型在连续调用中写错类型，白白浪费一轮往返；也**禁止**为 `notebook_read` 增加字符串选择器重载。
12. **参数校验在服务端强制**：SDK 或自实现必须校验类型、必填、`enum`、数组长度（如 `ops` 1..32）、数值范围（如 `timeout_seconds` 1..86400）。任何 schema 级约束失败 → `invalid_arguments`（`detail` 列出违规字段路径）。**跨字段规则**另用专码：锚/必填矩阵 → `invalid_ops`；`cell_selector` 语法 → `invalid_targets`。

### 4.2 六个工具总览

| 工具 | 作用 | 会起 kernel | 会写文件 |
|---|---|---|---|
| `notebook_read` | 读 cell 索引/源码/已有输出（含图片） | 否 | 否 |
| `notebook_edit` | 按 CAS 锚编辑源码、增删移 cell | 否 | 是（`dry_run` 除外） |
| `notebook_run` | 执行 cell（三模式） | 是 | 是（`write_outputs` 时） |
| `notebook_run_status` | 轮询后台 run | 否 | 否 |
| `notebook_run_cancel` | 取消后台 run | 否 | 否 |
| `notebook_kernel` | kernel 生命周期管理 | `start`/`restart` 是 | 否 |

**六个工具的 `description` 必须逐字使用以下文本**（模型可见，影响可发现性与 token 成本）：

| 工具 | description |
|---|---|
| `notebook_read` | `Read a Jupyter notebook: cell index, type, source and existing outputs. Set include_outputs='full' to get a cell's outputs including images.` |
| `notebook_edit` | `Edit notebook cells. Every source change requires a compare-and-swap anchor (expected_source_hash or expected_text); a mismatch fails the whole request without writing.` |
| `notebook_run` | `Execute notebook cells. mode='resume' runs only the target cells in the live kernel; 'replay' silently rebuilds state from cell 0 first; 'full' re-runs everything.` |
| `notebook_run_status` | `Poll a background notebook run started by notebook_run.` |
| `notebook_run_cancel` | `Cancel a background notebook run started by notebook_run.` |
| `notebook_kernel` | `Inspect or manage the kernels held for notebooks: status, start, shutdown, restart.` |

### 4.3 `notebook_read`

**参数**

```ts
{
  path: { type: 'string', required: true, description: 'Notebook path (absolute, or relative to the server root)' },
  cell_indexes: { type: 'array', items: { type: 'integer' }, description: '0-based cell indexes to read; omit for all cells. This is an integer array — do not pass a range string.' },
  include_source: { type: 'string', enum: ['none', 'preview', 'full'], description: "Default 'preview'" },
  include_outputs: { type: 'string', enum: ['none', 'summary', 'full'], description: "Default 'summary'" },
  expected_content_hash: { type: 'string', description: 'Optional optimistic-lock hash' },
}
```

**返回（文本 JSON，字段全部 snake_case）**

```jsonc
{
  "path": "…绝对路径，/ 分隔",
  "nbformat": 4, "nbformat_minor": 5,
  "kernel_name": "python3", "language_name": "python", "language_version": "3.11.9",
  "has_stable_cell_ids": true,
  "cell_count": 42,
  "content_hash": "sha256:…",
  "cells": [
    {
      "cell_index": 0, "cell_id": "a1b2c3d4", "cell_type": "code",
      "execution_count": 3,
      "source_preview": ["import pandas as pd"], "source_line_count": 12, "source_truncated": true,
      "source": null,                  // 仅 include_source='full' 时为字符串
      "outputs_summary": [ { "kind": "image", "media_type": "image/png", "width": 640, "height": 480, "bytes": 12345, "artifact_path": null, "image_index": null } ],   // 默认 summary 模式不物化图片
      "outputs": null                  // 仅 include_outputs='full' 时为 OutputItem[]
    }
  ],
  "warnings": [ { "code": "output_truncated", "message": "…" } ]
}
```

- `source_preview`：`include_source` 为 `none` 时为空数组；`preview` 时取前 `preview_lines`（默认 12）行；`full` 时为全部行。`source_truncated` 表示 preview 是否被截断。
- `source`：仅 `full` 时存在（字符串），否则为 `null`。
- `outputs_summary` 元素形状：`{ kind, stream_name?, line_count?, preview?, media_type?, width?, height?, bytes?, error_name?, mime_type? }`。
- `outputs`：仅 `full` 时存在，元素为 §5.4 的 `OutputItem`（其中 `image` 项的 `image_index` 指向随本次结果返回的第 N 个 image content 块）。
- **图片**：当 §4.4 的图片策略允许时，`outputs` 中每个 `kind:"image"` 项与 `outputs_summary` 中的 image 项都对应一个随结果返回的 MCP `ImageContent` 块，顺序与出现顺序一致；`image_index` 即其 0-based 序号。**任何文本字段中禁止出现 base64。**
- **`image_index` 与 `artifact_path` 取值规则（强制）**：图片**物化**（base64 解码 + 写 artifact）与图片块返回是**同一件事** —— 仅当本次调用会返回图片块时才物化。因此：
  - 返回了图片块 → `image_index` = 该块在本次结果图片块数组中的 0-based 序号；`artifact_path` = 已写入的 artifact 绝对路径。
  - 未返回图片块 → `image_index` 与 `artifact_path` **一律为 `null`**，且**不写 artifact、不写任何文件**。
  - 触发"未返回图片块"的情形（穷举）：`--images=never`；`--images=auto` 且 `include_outputs='summary'`（含 `notebook_run` 之外的一切 summary 读取）；该项超出 `max_images_per_call`；base64 解码失败；artifact 写入失败。
  - 图片 `kind` 字段**始终**为 `"image"`（唯一例外是单图超 `max_image_bytes` → `kind:"unsupported"`，见 §4.4）。
  - 后三种情形按 §4.4 追加对应 warning。
- 错误：`path_outside_root` / `file_not_found` / `parse_failed` / `nbformat_unsupported` / `range_out_of_bounds` / `cell_not_found` / `file_changed`。

### 4.4 图片策略（`--images`，默认 `auto`）

| 值 | 语义 |
|---|---|
| `auto`（默认） | `notebook_read`：仅当 `include_outputs='full'` 时返回图片块；`notebook_run`：始终返回本次执行的图片块。均受 `max_images_per_call` 限制 |
| `never` | 任何情况都不返回图片块，**也不物化图片**；`kind:"image"` 项仍按 §4.3 产生，但 `artifact_path` 与 `image_index` 恒为 `null` |
| `always` | 即使 `notebook_read` 用了 `outputs_summary` 也返回图片块 |

- **物化与返回同步发生**（见 §4.3 的取值规则）：不返回图片块就不写 artifact。
- `max_images_per_call`（默认 20）为**每次工具调用**的图片块上限；超限的图片仍产生 `kind:"image"` 项，但 `artifact_path` 与 `image_index` 均为 `null`、**不物化**，并对整个调用只追加一次 warning `image_limit`。
- 单张图片字节数 > `max_image_bytes`（默认 20 MiB）→ 该项变为 `kind:"unsupported"`，**不写 artifact、不返回图片块**。
- 图片解码或 artifact 写入失败 → 仍为 `kind:"image"`，`artifact_path` 为 `null`、`image_index` 为 `null`，追加 warning `image_materialize_failed`。
- 图片 `width` / `height` 取值优先级：output `metadata` 的 `width`/`height` → PNG/JPEG 头部解析 → `null`。**禁止引入图像处理库。**

### 4.5 `notebook_edit`

**参数**

```ts
{
  path: { type: 'string', required: true },
  ops: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    op: { type: 'string', required: true, enum: ['replace_lines', 'insert_lines', 'replace_source', 'insert_cell', 'delete_cell', 'move_cell', 'set_cell_type', 'clear_outputs'] },
    cell_id: { type: 'string' },
    cell_index: { type: 'integer' },
    start_line: { type: 'integer' },
    end_line: { type: 'integer' },
    at_line: { type: 'integer' },
    expected_text: { type: 'string' },
    expected_before: { type: 'string' },
    expected_after: { type: 'string' },
    expected_source_hash: { type: 'string' },
    new_text: { type: 'string' },
    at_index: { type: 'integer' },
    from_index: { type: 'integer' },
    to_index: { type: 'integer' },
    cell_type: { type: 'string', enum: ['code', 'markdown'] },
    source: { type: 'string' },
  } } },
  expected_content_hash: { type: 'string' },
  dry_run: { type: 'boolean', description: 'Compute everything but do not write. Default false' },
  create_backup: { type: 'boolean', description: 'Default true' },
}
```

- `ops` 长度必须为 1..32。
- **锚矩阵（强制，违反 → `invalid_ops`）**：

| `op` | 必填 | 锚要求 | 禁止出现的字段 |
|---|---|---|---|
| `replace_lines` | `start_line`, `end_line`, `new_text` + (`cell_id`\|`cell_index`) | **`expected_text` 必填**；`expected_source_hash` 可选（给了就一并校验） | `at_line`, `at_index`, `source`, `cell_type` |
| `insert_lines` | `at_line`, `new_text` + (`cell_id`\|`cell_index`) | **`expected_before` 与 `expected_after` 均必填**（边界处为 `""`）；`expected_source_hash` 可选 | `start_line`, `end_line`, `at_index`, `source`, `cell_type` |
| `replace_source` | `new_text` + (`cell_id`\|`cell_index`) | **`expected_source_hash` 或 `expected_text` 至少一个** | `start_line`, `end_line`, `at_line`, `at_index`, `source`, `cell_type` |
| `insert_cell` | `at_index`, `cell_type`, `source` | 无 | `cell_id`, `cell_index`, `from_index`, `to_index`, 所有锚字段, `new_text`, `start_line`, `end_line`, `at_line` |
| `delete_cell` | (`cell_id`\|`cell_index`) | **`expected_source_hash` 或 `expected_text` 至少一个** | `new_text`, `source`, `cell_type`, `at_index` |
| `move_cell` | `from_index`, `to_index` | 无 | `cell_id`, `cell_index`, 所有锚字段, `new_text`, `source`, `cell_type`, `at_index` |
| `set_cell_type` | `cell_type` + (`cell_id`\|`cell_index`) | **`expected_source_hash` 或 `expected_text` 至少一个** | `new_text`, `source`, `at_index` |
| `clear_outputs` | (`cell_id`\|`cell_index`) | 无（可选 `expected_source_hash` 与 `expected_text` 作为附加校验） | `new_text`, `source`, `cell_type`, `at_index` |

「所有锚字段」= `expected_text`、`expected_before`、`expected_after`、`expected_source_hash`。

- 越界 / 不存在的 `cell_index`、`cell_id` → `cell_not_found` 或 `range_out_of_bounds`（`detail` 含 `failed_op_index`）。
- **任一 op 失败 → 不写文件**，返回首个失败 op 的下标与错误码。

**锚校验细节**

- `expected_text` 精确字符串比对：不 trim、不归一化换行、不忽略空白。
- `replace_lines` 的 `expected_text` = `source.split('\n')` 后 `[start_line, end_line]` 闭区间各行以 `\n` 连接（不含末尾换行）。
- `insert_lines` 的 `expected_before` = 第 `at_line-1` 行内容（`at_line === 1` 时为 `""`）；`expected_after` = 第 `at_line` 行内容（`at_line === line_count+1` 时为 `""`）。`at_line` 合法范围 `[1, line_count+1]`。
- 行数 = `source.split('\n').length`；空 cell 的 `line_count` 为 1。
- 锚不匹配 → `cas_mismatch`，`detail` 必须包含：
  ```jsonc
  { "failed_op_index": 1, "anchor": "line_text" | "source_hash" | "insert_neighbors",
    "cell_index": 3, "cell_id": "a1b2", "expected": "…", "actual": "…", "actual_truncated": false,
    "current_source_hash": "sha256:…", "current_source": "…", "current_source_truncated": false }
  ```
  `actual` 与 `current_source` 各自超过 4000 字符时截断并置对应 truncated 标志。**这是"一次重试即可成功"契约的实现：模型拿到 `current_source_hash` 就能立刻用 hash 锚重试。**

**写入规则**

1. 全部 ops 在同一内存模型上顺序应用。
2. `replace_source` 作用于 markdown cell 且新文本长度 > 原文本 1.5 倍 → 追加 warning `large_markdown_rewrite`（不阻止）。
3. 任何 markdown cell 的写入（`replace_source` / `replace_lines` / `insert_lines` / `set_cell_type`→markdown / `insert_cell` 为 markdown）必须调用 §5.7 的 Markdown 检查器；存在 `severity="error"` → `markdown_invalid`，`detail.issues` 携带全部 issue。
4. `set_cell_type` → markdown 时必须删除该 cell 的 `outputs` 与 `execution_count`。
5. `clear_outputs` 只清 `outputs`，不动 `execution_count`、不动源码。
6. `move_cell`：`to_index` 为**移动完成后**该 cell 的目标下标，合法范围 `[0, cell_count-1]`。

**返回**

```jsonc
{
  "path": "…", "dry_run": false, "applied": 2, "failed_op_index": null,
  "backup_path": "…" | null,
  "content_hash_before": "sha256:…", "content_hash_after": "sha256:…",
  "changed_cells": [ { "cell_index": 3, "cell_id": "a1b2", "new_line_count": 14, "new_source_hash": "sha256:…", "outputs_cleared": false } ],
  "markdown_issues": [ { "severity": "warning", "rule": "heading-level-jump", "line": 7, "message": "…" } ],
  "warnings": [ { "code": "index_shifted", "message": "…" } ]
}
```

- `dry_run=true` 时：`backup_path` 为 `null`、`content_hash_after === content_hash_before`、**不写文件**；其余字段照常计算（含 `markdown_issues`）。
- 错误：`path_outside_root` / `file_not_found` / `parse_failed` / `nbformat_unsupported` / `cell_not_found` / `range_out_of_bounds` / `cas_mismatch` / `invalid_ops` / `markdown_invalid` / `file_changed` / `selfcheck_failed` / `notebook_locked` / `read_only_mode`。

### 4.6 MCP 行为契约（对全部工具生效）

1. **stdout 纯净性**：stdout 上只能出现 SDK 写出的 JSON-RPC 消息。任何调试输出、警告、第三方库的 print 都必须改道 stderr。**必须有一条自动化测试断言 stdout 在若干次调用后仍逐行可被 JSON 解析。**
2. **abort 语义**：SDK 提供的 abort signal 必须被传递到所有异步 I/O 与 kernel 调用。收到取消时：
   - 在途 `notebook_run`：向 kernel 发 `interrupt`，等待至多 5 秒；**已完成的写入不回滚**，未开始的写入不执行；
   - 在途 `notebook_edit`：若尚未 `rename`，删除临时文件并放弃写入；若已 `rename`，返回已完成的结果。
3. **错误映射**：`IpynbError` → `isError: true`，内容为单文本块 `{"code":…,"message":…,"detail":…}`；未预期异常 → `internal`（`detail` 带 stack，仅 stderr 记录完整 stack）。**任何工具**都可能返回 `invalid_arguments`（参数校验失败，§4.1.12），各工具的错误列表不再逐一重复该码。
4. **progress**：请求 `_meta.progressToken` 存在时，`notebook_run` 在开始、每个 cell 完成、写回完成时发 `notifications/progress`；`total` 为目标 cell 数（replay 阶段不单独计数，合并计入"准备"-progress）。
5. **服务退出**：stdin 关闭或收到 SIGINT/SIGTERM 时，必须 `shutdown_all` 并等待 sidecar 退出（5 秒后强杀）。**不得留下孤儿 kernel 进程。**

### 4.7 `notebook_run`

**参数**

```ts
{
  path: { type: 'string', required: true },
  cell_selector: { type: 'string', description: "Which code cells to run: 'all' (default), '3', '0-4', or a comma list like '0-4,7,9'. This is a string selector — do not pass an array." },
  mode: { type: 'string', enum: ['auto', 'resume', 'replay', 'full'], description: "Default 'auto'" },
  timeout_seconds: { type: 'integer', description: 'Per-cell timeout in seconds. Omit to use the server default (--exec-timeout-seconds, 300). Range 1..86400' },
  write_outputs: { type: 'boolean', description: 'Write fresh outputs back to the .ipynb. Default true' },
  clear_outputs_before: { type: 'boolean', description: "Clear target cells' outputs before running. Default true" },
  expected_content_hash: { type: 'string' },
  create_backup: { type: 'boolean', description: 'Default true' },
}
```

**`cell_selector` 解析（固定）**：`all` → 全部 code cell；`<n>` → 仅 n；`<n>-<m>` → 闭区间（`n>m` → `invalid_targets`）；逗号列表按出现顺序去重**升序**排列。解析失败或索引越界 → `invalid_targets` / `range_out_of_bounds`。仅 `cell_type === "code"` 的 cell 可被执行；选择器指向 markdown/raw cell → `invalid_targets`。

**`cell_selector` × `mode` 矩阵（固定，无例外）**

| `cell_selector` | `auto` | `resume` | `replay` | `full` |
|---|---|---|---|---|
| `all` | 有存活 kernel → 在现有 kernel 上执行全部；无 → 新建后执行全部 | 有 → 执行全部；无 → `kernel_not_available` | 等同 `full` | 新建 kernel 后执行全部 |
| 集合 S，f = min(S) | 有存活 kernel → `resume`；无 → `replay` | 有 → 只执行 S；无 → `kernel_not_available` | 新建 kernel，静默执行 `0..f-1` 后执行 S | 新建 kernel，执行**全部** code cell（忽略 S），追加 warning `targets_ignored` |

**执行与写回规则**

1. `replay` 的静默阶段：`silent=true`、`storeOutputs=false`、**不写回文件、不返回该阶段输出、不计入 `executed`**（记入 `replayed_cell_indexes`）。违反即触碰红线 R8。
2. 目标 cell 执行前若 `clear_outputs_before=true`：在内存模型中清空其 `outputs` 与 `execution_count`；否则保留，新输出直接替换。
3. 写回时：被执行 cell 的 `outputs` 替换为本次输出；`execution_count` 更新为 kernel 返回值；**未执行 cell 的 `execution_count` 与 `outputs` 一律不变**。
4. `write_outputs=false`：文件完全不变，但返回值仍必须包含本次执行的全部输出（含图片块）。
5. 全部 cell 执行完毕（或遇到首个 timeout / kernel 死亡）后，若 `write_outputs=true` 且至少一处变化 → 走 §5.9 的备份 + 原子写。
6. `status` 取值：`ok`（含正常输出）/ `error`（cell 内异常）/ `timeout`。出现 `timeout` → 该 kernel 标记死亡并关闭。
7. kernel 语言非 Python 时，`stale_analysis.method = "skipped"` 并追加 warning `stale_analysis_skipped`。

**返回（同步路径）**

```jsonc
{
  "kind": "completed",
  "path": "…", "mode_requested": "auto", "mode_used": "resume",
  "kernel_id": "kernel-1", "interpreter_path": "…", "kernel_language": "python",
  "executed": [ { "cell_index": 5, "cell_id": "a1b2", "status": "ok", "duration_ms": 812, "execution_count": 12,
                  "outputs": [ /* OutputItem[] */ ] } ],
  "replayed_cell_indexes": [0,1,2,3,4],
  "stale_cells": [ { "cell_index": 7, "cell_id": "e5f6", "reason": "uses-variable-defined-in-5", "confidence": "high" } ],
  "stale_analysis": { "approximate": true, "analysis_version": 1, "method": "python-symtable" },
  "kernel_alive": true,
  "write_back": { "performed": true, "backup_path": "…" | null },
  "warnings": [ { "code": "…", "message": "…" } ]
}
```

**返回（异步路径）**：`{ "kind": "background", "run_id": "run-1", "status": "running", "kernel_id": "kernel-1", "poll_after_ms": 2000 }`

**错误**：`path_outside_root` / `file_not_found` / `parse_failed` / `invalid_targets` / `range_out_of_bounds` / `kernel_not_available` / `kernel_died` / `kernel_busy` / `exec_timeout` / `file_changed` / `selfcheck_failed` / `interpreter_not_found` / `ipykernel_missing` / `notebook_locked` / `read_only_mode` / `cancelled`。
**cell 内异常不置 `isError`**（D10）。

### 4.8 `notebook_run_status` / `notebook_run_cancel`

**参数**：`{ run_id: { type: 'string', required: true } }`

**`notebook_run_status` 返回**

```jsonc
{
  "run_id": "run-1", "state": "running" | "completed" | "failed" | "cancelled",
  "kernel_id": "kernel-1",
  "progress": { "completed": 3, "total": 8, "current_cell_index": 3 },
  "executed": [ /* 已完成 cell 的结果，含 outputs */ ],
  "replayed_cell_indexes": [0,1,2],
  "stale_cells": [], "stale_analysis": { "approximate": true, "analysis_version": 1, "method": "python-symtable" },
  "write_back": { "performed": false, "backup_path": null },
  "error": null,                    // state='failed' 时为 {code, message}
  "warnings": []
}
```

**`notebook_run_cancel` 返回**：`{ "run_id": "run-1", "state": "cancelled" | "completed" | "failed", "kernel_shutdown": false }`

**run 生命周期（固定）**：`run_id` 形如 `run-<递增序号>`；最多保留 **20** 个已完成 run 或其最终结果保留 **10 分钟**（先到者为准）。未知 `run_id` → 错误 `run_not_found`；已结束的 `run_id` → 返回其最终状态（`cancelled` 请求对已结束 run 幂等返回，不报错）。

**与 kernel 生命周期的交互（强制，穷举）**

当承载某个在途 run 的 kernel 被 `notebook_kernel` 的 `shutdown` / `restart`、空闲回收、或侧车 `kernel_died` 事件终结时：

1. 该 run **立即**转为终态（不阻塞等待在途 cell 结束）：显式 `shutdown`/`restart` 与内核异常死亡 → `state:"failed"`、`error:{ "code":"kernel_died" }`；客户端 abort → `state:"cancelled"`、`error:{ "code":"cancelled" }`。
2. **在途 cell 的部分输出永不写回**：该 cell 的 `outputs` 与 `execution_count` 保持执行前的值。
3. **已完成的定向 cell 按 §4.7 规则 5 照常写回**（当 `write_outputs=true` 且至少一个 cell 完成时），终态中必须报告 `write_back:{ performed, backup_path }`。这样做的理由：把"已经算完的结果"丢掉，与"不会重跑你的长任务"这一产品承诺直接冲突；而"半截结果"指的是被中断 cell 的不完整输出，那部分确实永不写回。
4. 转换顺序固定为：标记 run 进入终结中 → 对在途 cell 发 `interrupt`（尽力而为，不等待 idle）→ 写回已完成 cell → 关闭 kernel → 发布终态。**`notebook_run_status` 在任何时刻都必须能查到该 run，不允许出现"kernel 已关但 run 悬空"的窗口。**
5. `executed` 保留终结前已完成 cell 的结果（含其 outputs），供 `notebook_run_status` 返回。
6. `restart` 后**不自动重跑**任何 cell（与 §4.9 一致）。

### 4.9 `notebook_kernel`

**参数**

```ts
{
  action: { type: 'string', required: true, enum: ['status', 'start', 'shutdown', 'restart'] },
  path: { type: 'string', description: 'Notebook path; required for start/shutdown/restart, ignored for status' },
}
```

**语义（强制）**
- `status`：返回**全部** kernel 会话（跨 notebook），忽略 `path`。
- `start`：该 notebook 已有存活 kernel → 直接返回；否则新建。
- `shutdown`：关闭该 notebook 的 kernel；不存在时**不报错**，返回 `kernels: []`。
- `restart`：关闭并新建（等价 Jupyter 的 Restart Kernel），**不自动执行任何 cell**。
- `read_only` 模式下仅 `status` 允许，其余 → `read_only_mode`。

**返回**

```jsonc
{
  "action": "status",
  "kernels": [ {
    "kernel_id": "kernel-1", "notebook_path": "…", "interpreter_path": "…",
    "kernel_spec_name": "python3", "language": "python", "alive": true,
    "started_at": "2026-…Z", "last_used_at": "2026-…Z",
    "execution_count": 12, "pid": 12345
  } ],
  "warnings": []
}
```

---

## 5. 关键技术细节

### 5.1 配置

优先级：**CLI 参数 > 环境变量 > 默认值**。布尔参数用 `--flag` / `--no-flag` 形式。

| CLI | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--root <dir>` | `IPYNB_ROOT` | 进程启动时 cwd | 路径围栏根（D17） |
| `--allow-outside-root` | `IPYNB_ALLOW_OUTSIDE_ROOT` | `false` | 放开围栏 |
| `--read-only` | `IPYNB_READ_ONLY` | `false` | D18 |
| `--images <auto\|never\|always>` | `IPYNB_IMAGES` | `auto` | §4.4 |
| `--python <path>` | `IPYNB_PYTHON` | 自动解析 | §5.3 |
| `--kernel-idle-seconds <n>` | `IPYNB_KERNEL_IDLE_SECONDS` | `3600` | 空闲回收 |
| `--exec-timeout-seconds <n>` | `IPYNB_EXEC_TIMEOUT_SECONDS` | `300` | 单 cell 超时 |
| `--background-threshold-seconds <n>` | `IPYNB_BACKGROUND_THRESHOLD_SECONDS` | `30` | D14 |
| `--backup-keep <n>` | `IPYNB_BACKUP_KEEP` | `10` | 备份滚动 |
| `--artifact-dir <dir>` | `IPYNB_ARTIFACT_DIR` | 见 §5.9 | 图片 artifact 根 |
| `--inline-text-chars <n>` | `IPYNB_INLINE_TEXT_CHARS` | `20000` | 文本截断阈值 |
| `--preview-lines <n>` | `IPYNB_PREVIEW_LINES` | `12` | 源码预览行数 |
| `--max-images-per-call <n>` | `IPYNB_MAX_IMAGES_PER_CALL` | `20` | §4.4 |
| `--max-image-bytes <n>` | `IPYNB_MAX_IMAGE_BYTES` | `20971520` | §4.4 |
| `--log-level <level>` | `IPYNB_LOG_LEVEL` | `info` | stderr |

所有数值型参数在启动时校验；非法值 → 进程退出码 2 并在 stderr 打印用法。

**启动期失败统一退出码 2（强制，供 CI 断言）**：任何**启动期**校验失败——非法数值/枚举参数、`--root` 不存在或不是目录、`--root` 等于用户主目录或文件系统根（D17）、无法创建 artifact 目录——一律：stderr 打印**一条**说明原因的错误行 + 用法摘要，然后以**退出码 2** 结束。启动期失败**不得**使用退出码 1 或 0。运行期的工具错误不退出进程（按 §4.6.3 映射为 tool error）。

### 5.2 解释器解析

**候选顺序（固定，见 D23）**：

1. `--python` / `IPYNB_PYTHON`。**显式指定：不存在即终局**（`interpreter_not_found`，`detail` 列出该路径）；存在但不满足校验同样终局（`ipykernel_missing`），**不得降级到 2–4**。该参数对**任意语言**的 kernel 均生效，语义是"启动 kernel 的解释器/可执行文件"。
2. notebook 的 `metadata.kernelspec.name` → 在下方搜索路径中定位 `<name>/kernel.json` → 取其 `argv[0]`。
3. notebook **所在目录**（不是进程 cwd）下的 `.venv/Scripts/python.exe`（Windows）或 `.venv/bin/python`（POSIX），其次 `venv/`（同规则）。
4. PATH 上的 `python3`，其次 `python`。

**降级规则（强制）**：步骤 2–4 是**候选链**。任一候选"不存在"或"校验失败"时**继续尝试下一个候选**，并记录 `{ candidate, reason }`；仅当全部候选失败时抛错，`detail` 为 `{ "candidates": [ { "path", "reason" } ] }`。禁止在候选之间静默替换而不记录。

**`kernel.json` 的 `argv[0]` 解析**：若为相对路径或含 `{resource_dir}` 占位符，按 kernelspec 规范解析为相对 `<kernelspec 目录>` 的绝对路径。

**搜索路径（按顺序合并，前面的优先）**：
1. `$JUPYTER_PATH` 中以路径分隔符拆分的每一项 + `/kernels`；
2. 若进程能定位到一个 Python（候选 1 / 3 / 4 之一），其 `share/jupyter/kernels`（conda 与 venv 环境的 kernelspec 由这一项命中）；
3. POSIX：`~/.local/share/jupyter/kernels`、`/usr/local/share/jupyter/kernels`、`/usr/share/jupyter/kernels`；
   Windows：`%APPDATA%\jupyter\kernels`、`%PROGRAMDATA%\jupyter\kernels`。

**校验（仅当目标为 Python kernel 时执行）**：判定依据是 `kernel.json` 的 `language` 字段（或 notebook 的 `metadata.language_info.name`）等于 `python`。此时候选解释器必须能 `import ipykernel`（执行 `<python> -c "import ipykernel"`，5 秒超时，结果**按解释器路径缓存**）。失败 → 该候选记 `{ path, reason: "ipykernel_missing" }` 并继续下一候选；全部失败时 `detail` 额外含 `install_command`（取**第一个存在但缺 ipykernel** 的候选），形如 `"<path>" -m pip install ipykernel`。**禁止代为执行安装。** 非 Python kernel 跳过此校验（其可执行文件由 kernelspec 决定，不做额外探测）。

**warning `kernelspec_mismatch` 的触发（穷举，同一次调用只追加一次）**：
- notebook 无 `metadata.kernelspec.name`；或
- kernelspec 未能解析（未找到 `kernel.json`，或该文件不可解析）；或
- kernelspec 解析成功，但 notebook 所在目录存在 `.venv` / `venv`，且其解释器与 kernelspec 的 `argv[0]` 不同。

### 5.3 Kernel 生命周期与并发

| 事件 | 行为 |
|---|---|
| 首次 `notebook_run` / `notebook_kernel start` | 创建 kernel，`kernel_id = "kernel-<递增序号>"`，记录 `notebook_path` / `interpreter_path` / `kernel_spec_name` / `language` / `started_at` / `generation` |
| 每次成功使用 | 更新 `last_used_at` |
| 空闲超时 | 定时器真实关闭（间隔 `max(5, min(60, idle/2))` 秒），关闭前记 info 日志 |
| `shutdown` / `restart` | 立即关闭；`restart` 后新建 |
| 进程退出 / stdin 关闭 | `shutdown_all`，等待 sidecar 退出（5 秒超时后强杀），清理全部定时器 |
| notebook 在 kernel 存活期间被外部修改 | **不自动关 kernel**；下一次 `notebook_run` 追加 warning `file_changed_externally` |
| sidecar 退出 | 所有 kernel 标记为死；下一次 `notebook_run` 走 `replay` |

- **复用键**：`sha1(normalize(notebookAbsPath) + '|' + interpreterPath + '|' + kernelSpecName)`，其中 `normalize` = `realpath` 后再在 `win32`/`darwin` 上转小写（**跨平台必须做，否则同一文件会起两个 kernel**）。同一键**只允许一个** kernel 存活。
- **并发**：同一 kernel 上存在在途 `exec_cell` 时，新的 `notebook_run` → `kernel_busy`（不排队）。不同 kernel 之间允许并行。
- **生成计数**：`notebook_edit` 成功后该 notebook 的 `generation` 加 1；`notebook_run` 不因 `generation` 变化拒绝 `resume`（编辑不改变 kernel 状态是 Jupyter 的既定语义），但据此加强 stale 分析。
- **强制杀进程**：Windows 用 `taskkill /T /F /PID <pid>`；POSIX 用 `process.kill(-pid, 'SIGKILL')`（sidecar 以 `detached: true` 启动以获得进程组）。**必须有一条测试断言退出后无残留 kernel 进程。**

### 5.4 输出映射（`rawOutputs` → `OutputItem[]`）

按序判定，**先命中先返回**，每个 raw output 恰好产生 0 或 1 个 `OutputItem`：

| 顺序 | 条件 | 结果 |
|---|---|---|
| 1 | `outputType === 'stream'` | `stream`（超 `inline_text_chars` 截断并置 `truncated:true`） |
| 2 | `outputType === 'error'` | `error`（`traceback_lines` 取末尾 20 行） |
| 3 | `data['image/png']` 存在 | `image`（见 §4.4） |
| 4 | `data['image/jpeg']` 存在 | `image`（`media_type:'image/jpeg'`） |
| 5 | `data['text/markdown']` 存在 | `markdown` |
| 6 | `data['text/html']` 存在 | `html`（`text_fallback = data['text/plain'] ?? ''`） |
| 7 | `data['application/json']` 存在 | `json`（解析失败降级为 `text`） |
| 8 | `data['text/plain']` 存在 | `text` |
| 9 | 其他 | `unsupported`（`mime_type` 取第一个 mime 键，`message: 'unsupported output type'`） |

**`OutputItem` 判别联合（全部 `snake_case`）**

| `kind` | 字段 |
|---|---|
| `stream` | `stream_name: 'stdout'\|'stderr'`, `text`, `truncated: boolean`, `truncated_at_chars: number\|null` |
| `text` | `media_type: 'text/plain'`, `text` |
| `markdown` | `text` |
| `html` | `html`, `text_fallback` |
| `json` | `value` |
| `image` | `media_type: 'image/png'\|'image/jpeg'`, `width: number\|null`, `height: number\|null`, `bytes: number`, `artifact_path: string\|null`, `image_index: number\|null`, `text_fallback: string` |
| `error` | `error_name`, `error_value`, `traceback_lines: string[]`（末尾最多 20 行） |
| `unsupported` | `mime_type`, `message` |

- **禁止静默截断**：任何截断都必须置标志位。
- `unsupported.message` 等**所有模型可见文案一律英文**。

### 5.5 解析与序列化

1. 仅支持 `nbformat >= 4`；`< 4` → `nbformat_unsupported`。
2. **保留未知字段**：模型持有完整的原始 JSON 对象树，只修改 `cells[i].source` / `cells[i].outputs` / `cells[i].execution_count` / `cells[i].cell_type`；序列化以原始对象为基底。
3. `source` 可为字符串或字符串数组：读入时**统一合并为单个字符串**（数组元素直接拼接，元素已含换行）；写回时**统一输出为字符串数组**。**此转换只允许发生在被修改过的 cell 上**：未修改的 cell 保持原样。
4. 序列化：`JSON.stringify(obj, null, 1) + '\n'`（与 Jupyter 默认的 1 空格缩进一致；**禁止** 2 或 4 空格）。
5. 写回前必须用同一解析器解析自己产出的字节做自校验，失败 → `selfcheck_failed` 且**不写文件**。
6. markdown/raw cell 无 `outputs` / `execution_count`；code cell 若无该字段则写入时补 `execution_count: null`。
7. **保真度声明（必须写进 README）**：`JSON.parse → 修改 → JSON.stringify` 会把原始字节中的 `\uXXXX` 转义、指数形式数字等规范化，因此**未修改区域也可能出现整文件级 diff**。备份是这场景的兜底；本插件的承诺是"**逻辑不变**"，不是"字节最小 diff"。

### 5.6 陈旧（stale）分析

**输入**：cells（源码、`execution_count`、是否有非空 outputs）、本次**定向执行**的 cell 下标集合 `T`、**静默 replay** 的 cell 下标集合 `R`。`E = R ∪ T`。

**定义集合**（Python kernel：sidecar `analyze` op 用标准库 **`symtable`**，**禁止**用朴素 AST 遍历）：

sidecar 对每个 cell 执行 `symtable.symtable(source, "<cell>", "exec")`，然后：
- `D(i)` = **模块作用域**符号中满足 `is_assigned() ∨ is_imported() ∨ is_namespace()` 且非 `is_parameter()` 的名字。`is_namespace()` 覆盖 `def`/`class`；`is_imported()` 覆盖 `import a.b as c`（绑定 `c`）与 `import a.b`（绑定 `a`）；`from x import a, b` 绑定 `a`、`b`；元组/列表解包目标、`for` 目标、`with ... as`、海象赋值均由 `is_assigned()` 覆盖。
- `U(i)` = 读取**模块级**名字的集合 = 模块作用域中 `is_referenced()` 的名字 ∪ **全部后代作用域**中 `is_global() ∧ is_referenced()` 的名字，最后减去 `D(i)`。

**为什么必须用 `symtable` 而不是遍历 `ast`**：朴素地收集全树 `Name(Load)` 会把函数体内的**局部变量**当成模块级依赖——两个 cell 各自在函数里用了同名的局部变量，就会被误报为 stale。`symtable` 由解释器给出每个作用域的绑定关系，`is_global()` / `is_local()` 直接消除了这个误报源，代价为零（同为标准库）。

**允许的误差（必须在 README 声明）**：`globals()` / `locals()` / `exec` / `eval` / `setattr` 造成的动态绑定、属性赋值（`obj.attr = 1`）、`import *` 的星号导入，均无法追踪。

**判定**（对每个未执行、且拥有非空 outputs 的 code cell `j`）：
1. 若存在 `i ∈ E`、`i < j`、`U(j) ∩ D(i) ≠ ∅`，取满足条件的**最大** `i`：
   - `i ∈ T` → `{ reason: "uses-variable-defined-in-<i>", confidence: "high" }`
   - `i ∈ R` → `{ reason: "depends-on-replayed-cell-<i>", confidence: "low" }`
2. 否则若存在 `i ∈ T`、`i > j` → `{ reason: "out-of-order-execution", confidence: "low" }`。
3. 结果按 `cell_index` 升序，最多返回 50 条。

**为什么 `R` 只给 `low`**：replay 只重放未改动或未定向执行的前缀，其源码通常与产出该输出的那次执行一致；把它标成 high 会产生大量噪声，反而让真正的高危提示被忽略。

**强制声明**：`stale_analysis = { approximate: true, analysis_version: 1, method: "python-symtable" | "regex" | "skipped" }`。

| `method` | 何时出现 |
|---|---|
| `python-symtable` | 全部 cell 解析成功（默认路径） |
| `regex` | **至少一个** cell 解析失败 → **整次分析**降级为 §5.6.1 的正则实现，并追加 warning `stale_analysis_degraded` |
| `skipped` | 非 Python kernel（§1.3） |

- `(method, analysis_version)` 是分析语义的**唯一标识对**：任一 method 的返回语义发生变化（**包括 regex 实现的改进**）都必须递增 `analysis_version`。消费者只应在同一 `(method, analysis_version)` 内比较结果。
- **禁止**在 `method="skipped"` 时返回任何 `stale_cells`。

#### 5.6.1 正则降级实现（仅当 `method="regex"` 时）

由 **Node 侧**执行（`src/core/stale.ts`，纯函数，源码已在手）：

1. `^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)` → 定义名
2. `^(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)` → 定义名（`import a.b as c` 取 `c`；`import a.b` 取 `a`；`from x import a, b` 取 `a`、`b`）
3. `^(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)` → 定义名
4. `^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)` → 定义名
5. 使用名 = 全部 `[A-Za-z_][A-Za-z0-9_]*` 词法 token 集合（**含字符串与注释中的词**）减去 `D(i)`

**已知误差（必须同时写进 README）**：漏检元组解包 `a, b = f()`、注解赋值 `x: int = 1`、缩进块内的赋值、`with ... as`；误报字符串/注释中的标识符，以及函数内的同名局部变量。

**强制**：`method="regex"` 时**禁止**给出 `confidence="high"` —— 全部降级为 `"low"`（`reason` 字符串不变）。

**禁止**：执行被测代码、导入用户模块、读取用户文件。

### 5.7 Markdown 结构检查器

| rule | severity | 判定 |
|---|---|---|
| `unclosed-fence` | error | 去掉行内代码后，``` 与 ~~~ 围栏计数为奇数 |
| `unbalanced-math` | error | 去掉转义与代码围栏后，`$$` 计数为奇数；或 `$` 计数为奇数 |
| `missing-relative-target` | error | `![](p)` / `[x](p)` 中非 `http(s):` / `#anchor` / `data:` 的相对路径解析后不存在 |
| `heading-level-jump` | warning | 标题层级相对上一个标题跃升 > 1（首个标题除外） |
| `duplicate-heading-anchor` | warning | 同一 cell 内两个标题产生相同 slug |
| `table-column-mismatch` | warning | 同一表格内各行管道符数量不一致 |

签名（纯函数，唯一允许的外设是注入的 `existsSync`）：

```ts
export function checkMarkdown(
  source: string,
  notebookDirForRelativePaths: string,
  existsSync: (absolutePath: string) => boolean,
): MarkdownIssue[]
export interface MarkdownIssue { severity: 'error' | 'warning', rule: string, line: number, message: string }
```

**禁止**在 `src/core/markdown.ts` 内 `import 'node:fs'`。

### 5.8 Python sidecar 协议

**启动**：`spawn(interpreterPath, ['-u', sidecarPath], { stdio: ['pipe','pipe','pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, detached: process.platform !== 'win32' })`

`sidecarPath` **必须**由 `fileURLToPath(new URL('../python/ipynb_sidecar.py', import.meta.url))` 求得，**禁止**依赖 `process.cwd()`。`python/` 必须列入 `package.json` 的 `files`。

**消息形态**
- 请求：`{ "id": "<uuid>", "op": "<name>", "params": { … } }`
- 响应：`{ "id": "<uuid>", "ok": true, "result": { … } }` | `{ "id": "<uuid>", "ok": false, "error": { "code": "…", "message": "…", "detail": "…" } }`
- 事件（无 `id`）：`{ "event": "kernel_died", "kernelId": "…" }`、`{ "event": "log", "level": "info|warn|error", "message": "…" }`

**op 清单（完整，禁止扩展）**

| op | params | result |
|---|---|---|
| `ping` | `{}` | `{ pythonVersion, jupyterClientVersion, ipykernelVersion }` |
| `start_kernel` | `{ kernelId, interpreterPath, kernelSpecName, language }` | `{ pid, kernelSpecName, language }` |
| `exec_cell` | `{ kernelId, code, silent, storeOutputs, timeoutMs }` | `{ status: 'ok'\|'error'\|'timeout', executionCount, rawOutputs, durationMs }` |
| `interrupt` | `{ kernelId }` | `{ ok: true }` |
| `shutdown_kernel` | `{ kernelId }` | `{ ok: true }` |
| `kernel_status` | `{ kernelId }` | `{ alive, executionCount, pid }` |
| `analyze` | `{ sources: string[] }` | `{ ok: boolean, failed_cell_indexes: number[], defs: string[][], uses: string[][] }` |
| `shutdown_all` | `{}` | `{ ok: true }` |

`RawOutput = { outputType: 'stream'|'display_data'|'execute_result'|'error', data?: Record<string,string>, text?: string, name?: 'stdout'|'stderr', ename?: string, evalue?: string, traceback?: string[] }`

**分帧规则（强制）**
- Node 侧必须用 `Buffer` 累积 stdout，按 `\n` 切片；**禁止**假设"一个 chunk 等于一行"。单行超过 64 MiB → 视为协议错误，杀掉 sidecar 并让在途请求以 `kernel_died` 失败。
- sidecar 侧必须 `sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")` 并立即 `flush`。
- sidecar 的 **stderr 逐行转发为 debug 日志，禁止丢弃**。

**强制规则**
- `storeOutputs=false` 时 sidecar 仍必须消费消息直到该次 `execute_input` 对应的 idle，但 `rawOutputs` 返回空数组。
- `timeoutMs` 到期：Node 先发 `interrupt`，等待 5 秒；仍未 idle → 返回 `status:'timeout'`，Node 侧标记该 kernel 死亡并关闭。
- sidecar 内任何未捕获异常必须转为 `ok:false` 响应；只有解释器级崩溃允许退出。
- sidecar **禁止读写任何文件**，禁止使用 `jupyter_client` 与标准库之外的依赖（`zmq` 由 `jupyter_client` 传递依赖带入）。
- `src/kernel/sidecar-transport.ts` 必须接受注入的 `spawn` 函数（默认 `node:child_process.spawn`），以便测试替换。
- `analyze` 只要存在解析失败的 cell（`failed_cell_indexes` 非空）→ 返回 `ok:false`；Node 侧据此把**整次分析**的 `method` 置为 `"regex"`（§5.6.1）并追加 warning `stale_analysis_degraded`。失败 cell 在 `defs`/`uses` 中对应位置返回空数组，但 Node 侧**不得采用**这次返回的任何 AST 结果（避免 AST 与 regex 混用产生不可解释的置信度）。

### 5.9 备份与 artifact

- **备份**：`<notebook_dir>/<basename>.<yyyyMMdd-HHmmss>.ipynb.bak`；同秒冲突追加 `-<n>`。写入前必须完成备份（`dry_run` 除外）。超过 `backup_keep` 时删除最旧的同名备份。备份计时使用本地时间；**时间戳不得影响任何返回值语义**。
- **artifact 根**：`--artifact-dir` 非空则用其值；否则
  - Windows：`%LOCALAPPDATA%\ipynb-mcp\artifacts`
  - macOS：`~/Library/Caches/ipynb-mcp/artifacts`
  - Linux：`$XDG_CACHE_HOME/ipynb-mcp/artifacts` 或 `~/.cache/ipynb-mcp/artifacts`
- **artifact 路径**：`<root>/<sha1(normalize(notebookAbsPath)).slice(0,16)>/cell-<cellIndex>-out-<outputIndex>-<sha256[:8]>.<png|jpg>`
- **幂等**：同一内容（相同 sha256 前缀 + 相同 cell/output 下标）重复物化必须命中同一文件，**不覆盖、不追加**。
- **禁止**在用户仓库内创建除备份文件与 artifact 之外的任何文件或目录。

### 5.10 日志

- 全部日志写 **stderr**（D16），级别 `debug` / `info` / `warn` / `error`；`error` 只用于基础设施故障。
- **禁止**把用户源码、cell 内容、notebook 路径之外的上下文写入日志。notebook 路径可记（便于排障），但**不得记录 cell 源码或输出内容**。

---

## 6. 约束与红线

> 违反任一条即视为实现错误，必须回退重做。

| 编号 | 红线 |
|---|---|
| R1 | 禁止用自建对象整体替换 notebook JSON；只允许在原始对象树上增量修改（§5.5.2） |
| R2 | 禁止修改 `metadata`、`kernelspec`、`language_info`、`nbformat`、`nbformat_minor`（唯一例外：`set_cell_type` 对 cell 级字段的修改） |
| R3 | 禁止在缺少 CAS 锚校验的情况下写入 cell 源码（§4.5 矩阵） |
| R4 | 禁止把 base64 图片数据放入任何文本内容或返回值 |
| R5 | 禁止执行 `pip` / `conda` / 任何包管理器；禁止修改用户解释器环境与 kernelspec |
| R6 | 禁止读写 `root` 之外的文件（`--allow-outside-root` 为**服务级**开关，工具参数无法逐次放开） |
| R7 | 禁止吞掉错误：任何 `catch` 必须转成结构化错误码向上抛，或记 `warn` 并说明理由；**空 `catch` 一律禁止** |
| R8 | 禁止在 `replay` 静默阶段写文件，也禁止把该阶段输出返回给模型 |
| R9 | 禁止自动升级 nbformat、自动重排 cell、自动格式化用户源码 |
| R10 | 禁止用环境变量、当前时间、随机数决定**返回值语义**（时间戳字段除外） |
| R11 | 禁止在 `src/core/*` 中 import Node 内置模块或任何 I/O 库 |
| R12 | 禁止对 cell 内异常置 `isError`（必须作为领域结果返回） |
| R13 | 禁止让 Python sidecar 接触任何文件路径参数 |
| R14 | 禁止任何非协议字节写入 stdout（D16） |
| R15 | 禁止安装/卸载时执行构建脚本；发布包必须是可直接运行的构建产物 |
| R16 | 禁止在工具结果、日志、错误信息中出现非英文的模型可见文案 |
| R17 | 禁止收集或外发任何遥测数据 |
| R18 | 禁止在未观察 abort signal 的情况下执行长任务（§4.6.2） |
| R19 | 禁止留下孤儿 kernel / sidecar 进程（§5.3） |
| R20 | 禁止不写 `docs/DEVIATIONS.md` 就地改设计；但接口契约与红线**优先于任何示例代码** |

---

## 7. 错误码总表（完整枚举，禁止新增）

> 表中 `error` 类必须置 MCP `isError: true`（§4.6.3）；`warning` 类经返回值的 `warnings` 数组返回，**不得**置 `isError`。

| code | 触发条件 | 类型 |
|---|---|---|
| `path_outside_root` | 路径越出围栏 | error |
| `file_not_found` | notebook 不存在 | error |
| `file_changed` | `content_hash` 不匹配（乐观锁或写入前复检） | error |
| `parse_failed` | JSON 解析失败或结构非法 | error |
| `nbformat_unsupported` | `nbformat < 4` | error |
| `range_out_of_bounds` | cell / 行号越界 | error |
| `cell_not_found` | `cell_id` / `cell_index` 不存在 | error |
| `invalid_arguments` | 参数未通过 schema 级约束（类型/必填/enum/数组长度/数值范围，§4.1.12） | error |
| `invalid_ops` | ops 必填字段矩阵或锚矩阵被违反 | error |
| `invalid_targets` | `cell_selector` 选择器非法或指向非 code cell | error |
| `cas_mismatch` | CAS 锚不匹配 | error |
| `markdown_invalid` | markdown 检查器报 error | error |
| `interpreter_not_found` | 解释器解析全失败 | error |
| `ipykernel_missing` | 选定解释器无法 `import ipykernel` | error |
| `kernel_not_available` | 请求 `resume` 但无存活 kernel | error |
| `kernel_died` | sidecar 或 kernel 异常退出 | error |
| `kernel_busy` | 同一 kernel 有在途 `exec_cell` | error |
| `exec_timeout` | interrupt 后仍未 idle | error |
| `selfcheck_failed` | 写回前自校验失败 | error |
| `notebook_locked` | 写入时文件被其它进程持有（EBUSY/EPERM/EACCES） | error |
| `read_only_mode` | 只读模式下调用了被禁工具/动作 | error |
| `run_not_found` | 未知 `run_id` | error |
| `cancelled` | 调用被客户端取消且未完成 | error |
| `internal` | 其他未归类故障（`detail` 带 stack） | error |
| `no_stable_cell_id` | 无 cell id 且使用 index | warning |
| `index_shifted` | 请求内 index 受前序 cell 增删影响 | warning |
| `large_markdown_rewrite` | markdown 重写体积异常增大 | warning |
| `kernelspec_mismatch` | 见 §5.2 的穷举触发条件（缺失 / 未解析 / 与旁边 `.venv` 不一致） | warning |
| `file_changed_externally` | 检测到外部改动 | warning |
| `image_limit` | 图片数超过 `max_images_per_call` | warning |
| `image_materialize_failed` | artifact 写入或图片解码失败 | warning |
| `targets_ignored` | `full` 模式下 `cell_selector` 被忽略 | warning |
| `stale_analysis_skipped` | 非 Python kernel，跳过 stale 分析 | warning |
| `stale_analysis_degraded` | AST 解析失败，降级为正则 | warning |
| `output_truncated` | 本次调用返回中**任意一个 `OutputItem`** 的 `truncated === true`（超 `inline_text_chars`）；整个调用只追加一次 | warning |

> **`output_truncated` 的边界（强制）**：`source_truncated`（源码预览被截断）与 summary 模式的 `preview` 被截断**均不触发**该 warning——它们是 `include_source` / `include_outputs` 参数的正常语义，不是意外截断。`error` 项的 traceback 只保留末尾 20 行，同样**不触发**（其行数由 §5.4 固定）。

---

## 8. 包结构与发布

```
ipynb-mcp/
├── package.json          # name: ipynb-mcp-server · version 0.1.1 · license MIT · type module
│                         # bin: { "ipynb-mcp-server": "./lib/bin.js" } · engines.node ">=22"
│                         # files: ["lib", "python", "README.md", "LICENSE"]
│                         # dependencies: @modelcontextprotocol/sdk 1.31.x（唯一运行时依赖）
├── tsconfig.json · vitest.config.ts
├── README.md · LICENSE · CHANGELOG.md
├── SPEC.md               # 本文档（唯一权威规格）
├── src/{bin,server,config,log}.ts
├── src/mcp/{tools/*,render/*,run-store.ts,progress.ts}
├── src/core/{model,parse,edit,outputs,markdown,stale,errors}.ts
├── src/fs/{fence,atomic,backup,artifact,lock}.ts
├── src/kernel/{registry,transport,sidecar-transport,protocol}.ts
├── python/ipynb_sidecar.py
├── tests/{unit,integration}
└── docs/{archive/,DEVIATIONS.md,OPEN_QUESTIONS.md,COMPATIBILITY.md}
```

**发布规则（强制）**
1. **发布构建产物**（`lib/*.js` + `lib/*.d.ts`），**禁止** `prepare` / `postinstall` / 任何安装期构建脚本（R15）：`plugin_manager` 与 npm 都可能需要用户额外批准构建脚本，对即插即用是净损失。开发期用 `pnpm build`。
2. 运行时依赖**只有** `@modelcontextprotocol/sdk`；`zeromq` 仅在未来切换到纯 Node transport 时引入。
3. `python/` 必须列入 `files`。
4. 版本遵循 D22 的兼容承诺；`CHANGELOG.md` 逐版本列出接口变化。
5. `docs/COMPATIBILITY.md` 记录实测过的客户端与版本（Claude Code / Cursor / VS Code / dsh）与 Node/Python 版本矩阵。
6. dsh 接入包单独发布为 `dsh-ipynb-mcp`：纯配置 bundle（`dsh.bundle.patch` + 一段 YAML 插入 `@deepseek-ai/dsh-mcp-client`，`transport: stdio`、`command: npx`、`args: ["-y","ipynb-mcp-server"]`），并包含 `meta.title`/`meta.description`（`locale/en.json`、`locale/zh.json`）、顶层 `icon`、`exports` 含 `./package.json` 与 `./locale/*.json`、`files` 数组。**peer 依赖写实测范围（如 `>=0.2.0-rc.2 <0.3.0`）而非精确版本**——dsh 的版本门禁会因 peer 范围不匹配而静默拒绝加载整个 bundle。

---

## 9. 跨平台要求

| 平台 | 支持级别 | 强制处理 |
|---|---|---|
| Windows 10/11 x64 | 主要开发平台 | `MoveFileExW` 覆盖语义；**无进程组** → `taskkill /T /F`；路径大小写不敏感 → 复用键与围栏比较必须 `normalize`；跳过目录 fsync |
| macOS arm64/x64 | 支持 | `.venv/bin/python`；路径大小写不敏感（默认文件系统）→ 同 Windows 规范化；`~/.local/share/jupyter/kernels` |
| Linux x64/arm64 | 支持 | `rename` 后 `fsync` 目录；`detached: true` + 进程组 kill；`$XDG_CACHE_HOME` |

**CI 矩阵（分层，强制）**

| 层 | 运行内容 | 组合 |
|---|---|---|
| unit | §10.1 全部（无 kernel） | `{ubuntu, windows, macos} × {node 22, 24}` |
| integration | §10.2 全部（真实 kernel） | `{ubuntu, windows} × {node 22} × {py3.10, py3.12}` —— **macOS 不跑 integration** |
| 手工 | §10.3 | 发布前人工执行并留档 |

理由：12 个真 kernel 组合的**耗时与不稳定**远高于其覆盖增益；macOS 的 kernel 生命周期语义与 Linux 一致，unit 层已覆盖其平台特有分支（路径规范化、缓存目录、`.venv/bin/python`）。公开仓库的 GitHub 托管 runner 通常不产生费用，所以这里省下的是时间与维护成本，不是账单。**macOS 的 integration 缺口必须写入 `docs/COMPATIBILITY.md`**（明写"macOS 仅通过 unit 层验证"）。

---

## 10. 验收标准

### 10.1 单元测试（vitest，无需 kernel，必须全部通过）

| # | 用例 | 判定 |
|---|---|---|
| U1 | 含未知字段的 notebook → 改一个 cell 源码 → 序列化 | 未知字段、`metadata`、未修改 cell 的原始 `source` 形态全部保留 |
| U2 | `replace_lines` 用不匹配的 `expected_text` | 抛 `cas_mismatch`；文件字节不变；`detail.actual` 等于真实文本；`detail.current_source_hash` 可用 |
| U3 | 连续两次用同一锚 | 第一次成功，第二次 `cas_mismatch` |
| U4 | markdown cell 写入未闭合围栏 | 抛 `markdown_invalid`，文件不变 |
| U5 | `replace_source` 只给 `expected_source_hash`（无 `expected_text`） | 成功；这证明 hash 锚独立可用 |
| U6 | `insert_lines` 边界：`at_line=1` 与 `at_line=line_count+1` | `expected_before`/`expected_after` 按 `""` 处理正确 |
| U7 | `insert_cell` 后跟使用 `cell_index` 的 op | `warnings` 含 `index_shifted`；`changed_cells[].cell_index` 为最终文件坐标 |
| U8 | `dry_run=true` | 文件字节不变、`backup_path === null`、`markdown_issues` 仍被计算 |
| U9 | `set_cell_type` → markdown | 该 cell 的 `outputs` 被删除、`execution_count` 为 `null` |
| U10 | 注入损坏序列化器使自校验失败 | 抛 `selfcheck_failed` 且目标文件字节不变 |
| U11 | `path` 在 root 之外且未开 `--allow-outside-root` | 抛 `path_outside_root` |
| U12 | `expected_content_hash` 过期 | 抛 `file_changed`，`detail` 含 `expected`/`actual` |
| U13 | `cell_selector='5-3'` | 抛 `invalid_targets` |
| U14 | `move_cell` 于 `nbformat_minor=4` 文件 | **成功**，且 `warnings` 含 `no_stable_cell_id`（D8） |
| U15 | 30 张 base64 图 + `include_outputs='full'` | 每图产生 `kind:"image"`；**任何文本内容中不存在可被 base64 解码且解码后为 PNG/JPEG 魔数的字符串** |
| U16 | 图片字节 > `max_image_bytes` | 产出 `unsupported`，无 artifact 文件 |
| U17 | `--images=never` | 无图片块；`kind:"image"` 项的 `artifact_path` 与 `image_index` 均为 `null`；**artifact 目录不存在任何新文件** |
| U18 | symtable stale：cell0 为 `a, b = f()`，cell1 使用 `a`；只执行 cell0 | `stale_analysis.method === "python-symtable"`；`stale_cells` 含 `{cell_index:1, reason:"uses-variable-defined-in-0", confidence:"high"}`（**正则实现无法通过的用例**） |
| U19 | replay 依赖：`R={0}`、`T={5}`，cell 7 使用 cell0 定义的名 | `stale_cells` 含 `{cell_index:7, reason:"depends-on-replayed-cell-0", confidence:"low"}` |
| U19b | **作用域误报**：cell3 定义模块级 `tmp = 99`；cell4 为 `def g():\n    tmp = 2\n    return tmp` 且有 outputs；只执行 cell3 | `stale_cells` **不含** cell4（**朴素 AST 遍历实现会误报的用例**，见 §5.6） |
| U20 | 非 Python kernel（`language="R"`） | `stale_analysis.method === "skipped"` 且 `stale_cells` 为空 |
| U21 | 500 cell、单 cell 输出 100 KB 的 notebook + **默认参数** read（`summary`） | 返回文本总长度受控（断言上限）；**不含** `output_truncated`（summary 的 preview 截断不触发该 warning） |
| U21b | 同一 notebook + `include_outputs='full'` | 该 stream 项 `truncated === true` 且 `truncated_at_chars === inline_text_chars`；`warnings` 中 `output_truncated` **恰好出现一次** |
| U22 | NDJSON 分帧：把一条响应拆成多个 chunk 注入 | 正确重组，不丢消息、不误判 |
| U23 | 报错文案 | 所有 warning/错误 message 的**模板文案**为纯 ASCII 英文（R16）；其中嵌入的动态值（如路径）不受此限 |
| U24 | **响应形状（D24）**：对六个工具各调用一次 | 每次返回恰有 **1 个文本块**（可解析为 JSON）+ 0..N 个图片块；不存在 `structuredContent` 字段；不声明 `outputSchema` |
| U25 | **分析降级**：notebook 中有一个语法错误的 cell | `method === "regex"`；`warnings` 含 `stale_analysis_degraded`；**所有** `stale_cells` 条目的 `confidence === "low"` |
| U26 | **图片取值规则**：默认参数（`summary`）读一个含图的 notebook | 每个 image 项的 `artifact_path` 与 `image_index` 均为 `null`，且 artifact 目录**无新文件**；改用 `include_outputs='full'` 后二者均非 `null` 且文件存在 |
| U27 | **参数校验**：`notebook_run` 传 `timeout_seconds: 0`；`notebook_edit` 传 33 个 op；`notebook_read` 传 `path: ""` | 三者均抛 `invalid_arguments`（`detail` 含违规字段路径），**不**抛 `invalid_ops` / `internal` |

### 10.2 集成测试（真实 kernel，CI 必须通过）

| # | 用例 | 判定 |
|---|---|---|
| I1 | 启动 kernel → 执行一个 cell | `execution_count` 写入该 cell；其它 cell 的 `outputs`/`execution_count` 不变 |
| I2 | 先跑 cell 0（写一个时间戳文件），再 `mode=resume` 跑 cell 1 | **cell 0 未被重新执行**（时间戳文件 mtime 不变） |
| I3 | 冷启动 `mode=auto` 跑 cell 5（cell 2 耗时 ≥ 3s） | `mode_used="replay"`；`replayed_cell_indexes=[0,1,2,3,4]`；`executed` 只含 cell 5；**文件里 0..4 的 outputs 与 execution_count 字节级未变** |
| I4 | `mode=full` + `cell_selector='3'` | 全部 code cell 被执行，`warnings` 含 `targets_ignored` |
| I5 | 死循环 cell | `exec_timeout`；该 kernel 被标记死亡并关闭 |
| I6 | `write_outputs=false` | 文件字节不变，返回体含本次输出 |
| I7 | kill sidecar | 在途请求以 `kernel_died` 失败；下次 `notebook_run` 的 `mode_used === "replay"` |
| I8 | `kernel_idle_seconds=2`，等 5 秒 | `notebook_kernel status` 中该 kernel 不存在 |
| I9 | `notebook_kernel restart` | 旧 kernel 关闭、新 `kernel_id` 不同、**无任何 cell 被执行** |
| I10 | 同一 kernel 并发两次 `notebook_run` | 第二次抛 `kernel_busy` |
| I11 | 进程退出（stdin 关闭）后 3 秒 | **无残留 sidecar / kernel 进程**（按 pid 断言） |
| I12 | **stdout 纯净性**：完整跑一遍上述用例并抓取 stdout | 每一行都能 `JSON.parse`；日志只出现在 stderr（R14） |
| I13 | 客户端取消（abort）在途 `notebook_run` | 返回 `cancelled`；kernel 被 interrupt 且不再有输出写入 |
| I14 | 客户端取消在途 `notebook_edit` | 文件要么完全未变，要么已是完整新内容；不存在 `.tmp-*` 残留 |
| I15 | 被独占打开的文件上写入（Windows） | 抛 `notebook_locked`（非 `internal`）；平台受限则跳过并记录 |
| I16 | **在途 run × kernel 终结（§4.8）**：后台 run 执行到第 3 个 cell 时调用 `notebook_kernel restart` | 该 run 立即变 `state:"failed"`、`error.code === "kernel_died"`；**在途 cell 的 outputs 与 execution_count 未写回**；前 2 个已完成 cell 的结果已写回且 `write_back.performed === true`；`notebook_run_status` 在此后任意时刻都能查到终态（无悬空窗口）；`restart` 后无 cell 被自动执行 |
| I17 | **候选链降级（D23）**：kernelspec 指向的解释器存在但无 `ipykernel`，而同目录 `.venv` 的解释器有 | 不报错；实际使用 `.venv` 的解释器；`warnings` 含 `kernelspec_mismatch` |

### 10.3 手工端到端验收（必须真实客户端完成，留存截图或日志）

| # | 步骤 | 通过标准 |
|---|---|---|
| E1 | 干净机器：`npx -y ipynb-mcp-server` + 一行配置 → 让 agent 跑通一个 cell | **从零到跑通 ≤ 60 秒**，中途无需 `pip install` 任何东西 |
| E2 | 读一个带绘图的真实 notebook | 图确实出现在客户端对话中（`--images=auto` 且 `include_outputs='full'`） |
| E3 | 用过期的行号让 agent 改代码 | 工具失败并回传 `current_source_hash`；agent **一次**重试成功 |
| E4 | 跑 cell 0..4（cell 2 耗时 ≥ 60s），再改 cell 5 并重跑 | **cell 2 未被重新执行**；返回体含 stale 分析 |
| E5 | 关闭客户端后重开，直接改 cell 5 并重跑 | `mode_used === "replay"`，结果正确 |
| E6 | 用 JupyterLab 打开被本工具改过的 notebook | 无告警、cell 数与源码一致、cell id 未被剥离 |
| E7 | dsh 通过 `dsh-ipynb-mcp` bundle 接入 | 工具以 `mcp__ipynb__notebook_*` 出现且可用；图片进入对话 |
| E8 | Claude Code 接入 | 编辑调用触发客户端的 diff/审批 UI |
| E9 | Cursor 接入 | 同 E8 |

### 10.4 完成定义（DoD）

- `pnpm lint`（oxlint 或 eslint）、`pnpm typecheck`（`tsc --noEmit`）、`pnpm test` 全绿。
- §10.1 与 §10.2 全部通过；§10.3 全部有截图或日志存档。
- README 含：一行安装、客户端配置示例、配置项表、**已知限制**（非 Python kernel 无 stale 分析、widget 不支持、保真度声明 §5.5.7、执行 notebook = 任意代码执行的安全声明）、与竞品的差异小节。
- `docs/DEVIATIONS.md`、`docs/COMPATIBILITY.md`、`CHANGELOG.md` 存在。
- `LICENSE` = MIT。

---

## 11. 实现顺序（强制，禁止跳步）

1. 脚手架：`package.json` / tsconfig / vitest / `src/config.ts` / `src/log.ts` / `src/core/errors.ts`（§7 全部错误码）→ DoD：`typecheck` + `lint` 通过
2. `src/fs/fence.ts` + `src/fs/atomic.ts` + `src/fs/backup.ts` → 测 U11
3. `src/core/parse.ts` → 测 U1、U10
4. `src/core/edit.ts`（双锚、坐标系、op 矩阵）→ 测 U2、U3、U5–U9、U14
5. `src/core/markdown.ts` → 测 U4
6. `src/core/outputs.ts` + `src/fs/artifact.ts` → 测 U15、U16、U17、U26
7. `src/kernel/protocol.ts` + `src/kernel/sidecar-transport.ts` + `src/kernel/registry.ts` + `python/ipynb_sidecar.py` → 测 U22、I1、I5–I12、I17
8. `src/core/stale.ts` + sidecar `analyze` op → 测 U18、U19、U19b、U20、U25
9. `src/mcp/*`：6 个工具、render 投影、run-store、progress、abort → 测 U21、U21b、U23、U24、U27、I13、I14、I16
10. 打包与发布：`files`、README、LICENSE、dsh bundle、CI 矩阵 → 测 I15
11. 手工端到端 E1–E9

**每一步完成前不得开始下一步。**「完成」= 该步列出的全部用例通过 + `typecheck` + `lint` 通过（§10.4）。

---

## 12. 需要人类决定的事项（实现者不得自行决定）

> 实现者遇到下列问题时，记录到 `docs/DEVIATIONS.md` 并按【默认行为】继续，同时把本节原样抄录进 `docs/OPEN_QUESTIONS.md`。

| # | 问题 | 默认行为 |
|---|---|---|
| Q1 | `max_images_per_call` 默认 20 是否合适 | 保持 20 |
| Q2 | `kernel_idle_seconds` 默认 3600 是否合适（长任务中途接续） | 保持 3600 |
| Q3 | 是否提供"attach 到已存在的 Jupyter kernel"（连接用户自己 JupyterLab 里正在运行的 kernel，以同时获得人机共享会话） | 不实现，等需求验证 |
| Q4 | 是否支持在 notebook 中创建新 cell 之外的"新建 notebook" | 不实现（D19） |
| Q5 | npm 组织/仓库归属与最终包名 | 已由人类确认：发布为 `ipynb-mcp-server`（`ipynb-mcp` 0.1.0 已发布，保留并标记废弃） |
| Q6 | 是否发布 `dsh-ipynb-mcp` bundle 到 npm | 先本地开发，发布前确认 |
| Q7 | 纯 Node transport（去 sidecar）是否立项 | 不立项；保留 `KernelTransport` 接口 |

---

## 附录 A：MCP 工具 JSON Schema 摘要

> 完整 schema 以 §4.3–§4.9 为准；本附录仅列出参数名与必填性，供快速核对。

| 工具 | 必填参数 | 可选参数 |
|---|---|---|
| `notebook_read` | `path` | `cell_indexes`, `include_source`, `include_outputs`, `expected_content_hash` |
| `notebook_edit` | `path`, `ops` | `expected_content_hash`, `dry_run`, `create_backup` |
| `notebook_run` | `path` | `cell_selector`, `mode`, `timeout_seconds`, `write_outputs`, `clear_outputs_before`, `expected_content_hash`, `create_backup` |
| `notebook_run_status` | `run_id` | — |
| `notebook_run_cancel` | `run_id` | — |
| `notebook_kernel` | `action` | `path` |

**SDK API 说明**：`@modelcontextprotocol/sdk` 1.31.x 中注册工具的确切方法名（`registerTool` / `tool`），以**安装后的类型声明**为准；本文档规定的是**行为契约**：每个工具的结果必须恰好包含 **1 个文本块**（紧凑 JSON，见 D24），图片按 §4.4 以 `ImageContent` 块附加；**不声明 `outputSchema`、不返回 `structuredContent`**（D24）。

---

## 附录 B：与历史文档的决策映射

| 来源 | 决策 | v3 处理 |
|---|---|---|
| v1 D1/D2 | sidecar + Node 侧 I/O | 保留（D3/D4） |
| v1 D3 | 三种执行模式 | 保留（D5） |
| v1 D4 | 行级 CAS | 保留并增强为双锚（D6） |
| v1 D5 | cell id 优先 | 保留（D7） |
| v1 D6 | 图片注入 user 消息 | **删除** → MCP 原生图片块（D9） |
| v1 D7 | cell 异常非错误 | 保留（D10） |
| v1 D8 | `ctx.jobs` | **删除** → progress + 异步句柄（D14） |
| v1 D9 | policy 插件 | **删除** → 交给客户端审批 |
| v1 D10 | 正则 stale | **改为 AST**（D11） |
| v1 D11 | 原子写 + 备份 | 保留并加占用处理（D12） |
| v1 D12 | 不用 deferLoading | 不适用 |
| v1 D13 | `HarnessError` | **改为** `IpynbError`（D13） |
| v1 §5.3 | `\n@` 哨兵 | **删除** → `expected_before`/`expected_after` |
| v1 A17 | `move_cell` 拒绝旧文件 | **改为允许 + warning**（D8） |
| v1 §4.7 | pythonPath 探测序 | **重排**，kernelspec 提前（§5.2） |
| v1 §5.11 | 精确锁版 + `prepare` | **改为** peer 范围 + 发布构建产物（§8） |
| v2 全文 | MCP-first 形态、零服务、竞品定位 | 采纳（D1、§0、v2 附录 A 移入 `docs/`） |

---

## 附录 C：v2 → v3 补齐的歧义清单（自检记录）

按「一个从零开始的编码 AI 能否不加提问开工」逐项检查 v2，v3 补齐了以下缺口：

| v2 的缺口 | v3 补全位置 |
|---|---|
| MCP 协议版本与 SDK 版本未锁 | D21、附录 A |
| 未规定日志去向（stdout 污染风险） | D16、R14、I12 |
| 无错误码表 | §7（35 个：24 error + 11 warning） |
| 双锚规则自相矛盾、无 per-op 矩阵 | §4.5 锚矩阵 |
| `notebook_read` 返回模型缺失 | §4.3 |
| 六个工具的参数与返回未逐字段定义 | §4.3–§4.9 |
| 图片策略只有 `auto\|always\|never` 三个词，无语义 | §4.4 |
| `--read-only` 语义边界未定义 | D18 |
| 并发与串行化未定义 | §5.3 |
| `run_id` 生命周期未定义 | §4.8 |
| 两份文档效力关系未定义 | 文首"文档效力"声明 |
| kernelspec 定位只有原则 | §5.2 |
| 验收用例只有一句"移植 v1" | §10（U1–U23、I1–I15、E1–E9） |
| 命名为 snake_case 未声明 | D15、§4.1.1 |
| 无实现顺序 | §11 |
| 无打包与发布规格 | §8 |
| 无 abortsignal / 取消语义 | §4.6.2 |
| stale 的 `E` 集合（是否含 replay）未定义 | §5.6（`R` 与 `T` 分离，含判定理由） |
| 未处理"文件被占用" | D12、`notebook_locked` |
| 跨平台差异只有原则 | §9（含复用键规范化、进程组杀灭、目录 fsync） |
| 未声明"非 Python kernel"策略 | §1.3 |

自检结论：**补齐后，一个从零开始的编码 AI 可按 §11 的顺序、依 §4 的接口定义与 §10 的用例直接开工，无需向人类提问**；唯一被要求"不得自行决定"的是 §12 的 7 个产品问题，均已给出可直接照做的默认行为。

---

## 附录 D：v3 外部审核轮修复记录

外部审核提出 10 项，全部已处理；其中 1 项（A3）按其建议会与既有条款冲突，改用等价方案并说明理由。

| # | 类别 | 问题 | 处理 | 位置 |
|---|---|---|---|---|
| A1 | 必修 | `stale_analysis.method` 两处定义冲突（2 值 vs 3 值） | 统一为三值 `python-symtable` / `regex` / `skipped`；新增 **§5.6.1** 定义正则降级实现；`(method, analysis_version)` 定为语义标识对，任一实现改进都必须递增 `analysis_version` | §5.6、§5.6.1 |
| A2 | 必修 | `auto` + `summary` 下 `image_index` 取值未定义 | 新增取值规则：**物化与图片块返回是同一件事**；不返回块时 `artifact_path` 与 `image_index` 一律 `null` 且不写任何文件；穷举 5 种触发情形 | §4.3、§4.4、D9 |
| A3 | 必修 | 在途 run 与 `restart` / `shutdown` / 空闲回收 / 内核死亡的交互未定义 | 新增 §4.8 六条穷举规则 | §4.8 |
| A4 | 必修 | `analyze` 的 `ok` 是整体字段，无法表达"某个 cell 失败" | 改为 `{ ok, failed_cell_indexes, defs, uses }`；任一 cell 失败即**整次**降级，且禁止 AST 与 regex 结果混用 | §5.8、§5.6.1 |
| B1 | 应修 | 解释器解析顺序无对应决策，且"kernelspec 优先于 .venv"缺理由 | 提为 **D23**（选定/理由/否决）；同时把"首候选失败即终止"改为**候选链降级**（理由：kernelspec 指向无 `ipykernel` 的系统 python 是常见情形，不应变成死路）；`kernelspec_mismatch` 触发条件改为穷举 | D23、§5.2、§7 |
| B2 | 应修 | `output_truncated` 触发条件未写 | 明确定义为"本次返回中任一 `OutputItem.truncated === true`"，并穷举**不**触发的三种情形 | §7 |
| B3 | 应修 | `notebook_read.cells` 与 `notebook_run.cells` 同名不同类型 | 采用**改名**方案：`cell_indexes`（integer 数组）与 `cell_selector`（字符串选择器）；并在 §4.1.11 立法禁止同名 | §4.1.11、§4.3、§4.7、附录 A |
| C1 | 提醒 | CI 矩阵 12 组合成本过高 | 改为分层：integration 只跑 `{ubuntu, windows} × node22 × {py3.10, py3.12}`；macOS 只跑 unit，其 integration 缺口必须写入 `docs/COMPATIBILITY.md` | §9 |
| C2 | 提醒 | `structuredContent` 双写会与"不烧 token"冲突 | 采用更彻底的方案：**新增 D24，完全不使用 `structuredContent`**；返回恒为 1 个文本块（可解析 JSON）+ 可选图片块 | D24、附录 A、U24 |
| C3 | 提醒 | 三处小未定义 | ① 启动期失败统一退出码 **2**（含 `--root` 拒绝）→ §5.1；② `timeout_seconds` 缺省取配置值 → §4.7；③ **`U(i)` 误报**：改用标准库 `symtable` 按作用域取 `is_global()` 而非遍历 `ast`，并新增用例 U19b | §5.1、§4.7、§5.6、§10.1 |

**本轮实现者自查新增的两处**（外部审核未覆盖）：

1. **缺少通用参数校验错误码**：原文只定义了 `invalid_ops`（矩阵）与 `invalid_targets`（选择器语法），而数组长度、数值范围、空字符串等 schema 级约束无处安放。新增 **`invalid_arguments`**，并规定它适用于任何工具。
2. **A3 的原始修法与 §4.7 规则 5 冲突**：审核建议"run 转 `failed` 且 `write_back.performed = false`"，但 §4.7 规则 5 已规定"遇到首个 timeout / kernel 死亡后仍写回已完成 cell"。若照审核建议落地，会出现同一情形两种规定。最终采用：**在途 cell 的"半截输出"永不写回；已完成的定向 cell 照常写回并在终态报告 `write_back`**。理由：丢掉已经算完的结果与"不会重跑你的长任务"这一核心承诺直接冲突，而"半截"指的正是被中断那一个 cell 的不完整输出。若产品上更希望"用户一按 restart 就完全不动文件"，只需在 §4.8 第 3 条把条件改为恒 `false` 即可（一处改动）。
