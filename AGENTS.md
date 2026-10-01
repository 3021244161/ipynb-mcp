# AGENTS.md — ipynb-mcp

> 本文件面向**在本仓库工作的编码 AI agent**。它规定工作方式、边界与常见陷阱。
> 接口契约不在这里 —— 在 [`SPEC.md`](./SPEC.md)。**动手前必须读 SPEC 的对应章节。**

---

## 0. 优先级与冲突处理

发生冲突时，按此顺序：

1. **`SPEC.md` 的接口契约与红线（§4、§6、§7）** —— 最高权威。
2. 用户在当前会话中的明确指示。
3. 本文件（工作方式与规范）。
4. 你自己的判断 —— 只在前三者都未覆盖时使用。

**不许做的事**：

- 不许修改 `SPEC.md` 去迁就实现（包括"顺手修正"）。发现 SPEC 有错 → 记入 `docs/DEVIATIONS.md` 后**按 SPEC 继续实现**。
- 唯一例外：SPEC 存在**自相矛盾或无法编译/无法运行**之处（例如某字段在 SPEC 里不存在、两个条款直接冲突）。此时同样记入 `DEVIATIONS.md`，然后选择**改动最小**的解法并在该文件写明理由。
- 不许在未读 SPEC 对应章节的情况下实现该模块。
- 本文件与 SPEC 都未覆盖的**产品**问题 → SPEC §12 已列出 7 项并给了默认行为，照默认做，不要停下来问人。除此之外的实现细节由你决定并记录。

---

## 1. 项目是什么

**让任何 AI agent 安全地读取、编辑、执行本地 Jupyter Notebook，不需要预先启动任何服务。**

- 形态：一个 npm 包 `ipynb-mcp`，作为 **stdio MCP server** 运行（`npx -y ipynb-mcp`）。
- 消费者是**模型**，不是程序 —— 所有返回值必须让模型能用。
- 运行时只有一个 Node 依赖：`@modelcontextprotocol/sdk`。执行侧用用户 notebook 自己的 Python 环境，**不装任何 Python 包**。

**三条不可退让的产品卖点**（违反即实现错误，SPEC §0）：

1. **零服务**：一行配置即可用，不要求用户起 JupyterLab、不管 token。
2. **不会静默改坏**：任何源码改动必须带 CAS 锚，不匹配就失败，绝不写入。
3. **不会重跑你的长任务**：改一个 cell 只跑那一个（`resume`），没有 kernel 时静默重建状态（`replay`）。

**三条工程硬约束**（是验收标准，不是口号）：

1. 干净机器上从零到跑通第一个 cell ≤ 60 秒。
2. 不烧 token：read 默认只给预览与摘要；编辑失败必须**一次**可重试；`replay` 静默。
3. 不烧算力：read/edit **绝不起 kernel**；只有 `notebook_run` 起；空闲回收。

不做的事见 SPEC §1.2（9 条）。**特别地**：不做 UI、不做格式转换、不做协作、不支持 widget 输出、不自动创建 notebook。

---

## 2. 文档地图

| 文件 | 作用 | 何时读/更新 |
|---|---|---|
| `SPEC.md` | **唯一权威实现规格**（24 项决策、逐字段 schema、35 个错误码、验收用例、实现顺序） | 动手前读对应章节；**不修改** |
| `README.md` | 面向用户：安装、配置、已知限制、安全声明 | 凡改动对外行为/配置项/限制，同一提交内更新 |
| `docs/COMPATIBILITY.md` | 实测过的客户端与版本矩阵 | 发布前更新；macOS 只跑 unit 的缺口必须写明 |
| `docs/DEVIATIONS.md` | 每一次偏离 SPEC 的记录（含理由与影响） | 每次偏离当场写 |
| `docs/OPEN_QUESTIONS.md` | SPEC §12 的原样抄录 | 初始化时建立 |
| `docs/archive/` | v1（dsh bundle 形态）与 v2（架构定位）**历史存档，不生效** | 只读；**禁止**照它实现 |
| `CHANGELOG.md` | 逐版本接口变化 | 每个发布版本 |

**警告**：`docs/archive/` 里的 v1 含大量 **dsh 专有设计**（`ctx.jobs`、policy 插件、`injectImagesToModel`、`HarnessError`、精确版本锁、`\n@` 哨兵、正则 stale）。这些**全部已废弃**。看到它们不要照抄 —— 见 SPEC 附录 B 的映射表。

---

## 3. 环境与命令

- **Node ≥ 22**（`engines.node`）、pnpm、TypeScript ESM。
- **Python ≥ 3.10** 仅集成测试需要，且用**测试专用虚拟环境**，不得改动用户环境。

```bash
pnpm install
pnpm typecheck        # tsc --noEmit，必须零错误
pnpm lint             # oxlint 或 eslint，必须零告警
pnpm test             # 单测（SPEC §10.1，不需要 kernel）
pnpm test:integration # 集成测试（SPEC §10.2，需要真实 ipykernel）
pnpm build            # 产出 lib/（发布用）
```

单测必须能在**没有 Python 的机器上**全部通过。集成测试在本地无 Python 时允许跳过，但**必须在 CI 上跑**。

**禁止**：运行 `pip` / `conda` / 包管理器去修改任何解释器环境（R5）；引入需要原生编译的运行期依赖；联网。

---

## 4. 仓库结构与模块铁律

```
src/bin.ts            参数解析、启动 stdio server、进程信号
src/server.ts         MCP server 组装
src/mcp/              tools/*（6 个工具）· render/*（文本投影）· run-store.ts（异步句柄）· progress.ts
src/core/             model · parse · edit · outputs · markdown · stale · errors   ← 纯逻辑
src/fs/               fence · atomic · backup · artifact · lock                    ← 唯一做文件 I/O 的地方
src/kernel/           registry · transport（接口）· sidecar-transport · protocol   ← 进程与协议
python/ipynb_sidecar.py
tests/{unit,integration}
```

**模块边界（违反即回退）**：

| 模块 | 禁止 |
|---|---|
| `src/core/*` | **禁止** import `node:*` 或任何 I/O；禁止时钟/随机数影响返回语义（R11） |
| `src/fs/*` | 禁止解析 notebook 语义 |
| `src/kernel/*` | 禁止解析 notebook 结构 |
| `src/mcp/*` | 禁止直接碰 `node:fs`；禁止解析 notebook 语义 |
| `python/*.py` | **禁止读写任何文件**；只接收 `{code}` / `{sources}`，永不接收文件路径（R13） |

可变状态只允许存在于 `src/kernel/registry.ts` 的单一 `KernelRegistry` 与 `src/mcp/run-store.ts` 的 run 表。

---

## 5. 编码规范

- **TypeScript strict**；禁止 `any`、`as any`、`@ts-ignore`、`@ts-expect-error`（真的需要时先在 `DEVIATIONS.md` 说明）。
- **命名**：代码内用 camelCase；**工具名、参数名、返回字段、JSON 字段一律 snake_case**（D15）。notebook 内部字段沿用 nbformat 的 snake_case，转换只发生在 `parse.ts` 边界。
- **错误**：只抛 `IpynbError`（`code` + `detail`）。`code` **只能从 SPEC §7 的 35 个里取**，禁止新增。禁止空 `catch`（R7）；每个 `catch` 要么转成错误码上抛，要么记 `warn` 并说明理由。
- **日志**：一律经 `src/log.ts` 写 **stderr**。**禁止**在 `src/` 下出现 `console.log` / `console.error`（加 `no-console` lint 规则强制）。禁止把 cell 源码或输出内容写进日志（SPEC §5.10）。
- **文案**：所有模型可见/用户可见字符串**必须是英文**（R16）。中文只允许出现在代码注释、文档与测试名里。
- **注释**：只写"为什么"，不写"做了什么"。禁止保留注释掉的代码。
- **依赖**：运行期只允许 `@modelcontextprotocol/sdk`。新增任何依赖（含 devDependency）都要**先问人类**。
- **测试命名**：用例必须能在测试名里被搜到 SPEC 编号，例如 `it('[U2] rejects a mismatched expected_text without writing', ...)`。这是验收时定位覆盖率的唯一手段。
- **提交**：约定式提交（`feat:` / `fix:` / `test:` / `docs:` / `chore:`），正文引用 SPEC 用例编号。一个提交只做 SPEC §11 的一步。

---

## 6. 红线（最容易被无意违反的 12 条）

| 红线 | 为什么 | 自检方式 |
|---|---|---|
| **stdout 只能有 JSON-RPC** | 混入任何字节都会污染 stdio 帧，服务直接不可用 | I12 断言每一行都能 `JSON.parse`；lint `no-console` |
| **任何文本字段不得出现 base64** | 上下文爆炸，且是本项目对用户的承诺 | U15 用"可解码且解码后是 PNG/JPEG 魔数"的字符串断言 |
| **不返回图片块时不得物化图片** | 默认的 read 调用不该产生磁盘写入 | U26 断言 artifact 目录无新文件 |
| **不使用 `structuredContent` / 不声明 `outputSchema`** | 双写会让 token 翻倍（D24） | U24 断言恰好 1 个文本块、无结构化字段 |
| **`replay` 静默阶段不写文件、不返回输出** | 否则会把"补齐状态"误当成用户要的结果 | I3 断言文件字节级未变 |
| **无 CAS 锚不得写入源码** | 静默写错是本工具要消灭的头号故障 | U2 / U3 / U5 |
| **不改 `metadata` / `kernelspec` / `nbformat`，不自动升级格式，不重排 cell** | 对用户文件的非必要改写 | U1 断言未知字段与未修改 cell 原样保留 |
| **不碰 `root` 之外的文件** | 默认安全姿态 | U11；围栏比较必须 `realpath` + win32/darwin 转小写 |
| **不执行 `pip` / `conda` / 包管理器** | 不修改用户环境 | 代码里搜 `spawn` 的用途；只有 sidecar 与 `python -c "import ipykernel"` 两处合法 |
| **sidecar 不得接触文件路径** | 单一写入方 | 审 `python/ipynb_sidecar.py` 的 op 参数 |
| **不得留下孤儿 kernel / sidecar** | 用户体验与环境整洁 | I11 按 pid 断言；退出路径必须 `shutdown_all` |
| **零遥测** | 承诺 | 仓库内搜 `fetch` / `http` |

完整 20 条见 SPEC §6。

---

## 7. 常见陷阱（本项目已踩过或已被评审点名）

1. **stale 分析必须用 `symtable`，不要遍历 `ast`。** 朴素遍历会把函数体内的局部变量当作模块级依赖，两个 cell 各自在函数里用同名局部变量就会被误报 stale。用 `is_global()` / `is_local()` 按作用域取名字（SPEC §5.6）。U19b 就是这条的回归用例。
2. **`notebook_read.cell_indexes` 与 `notebook_run.cell_selector` 名字必须不同。** 不许统一成同一个名字，也不许给 read 加字符串选择器重载（SPEC §4.1.11）。
3. **图片"物化"与"返回图片块"是同一件事。** `summary`、`--images=never`、超限、失败四种情形都不写 artifact，`artifact_path` 与 `image_index` 一律 `null`（SPEC §4.3）。
4. **run 被 kernel 终结时的写回规则**：在途 cell 的**半截输出永不写回**；**已完成的定向 cell 照常写回**并在终态报告 `write_back`（SPEC §4.8）。
5. **参数校验用 `invalid_arguments`**，不要用 `invalid_ops`（那是锚/必填矩阵）或 `invalid_targets`（那是选择器语法）。
6. **并发**：MCP 客户端可能并发调用工具。同一 kernel 上并发 exec 必须抛 `kernel_busy`，**不排队**；不同 notebook 之间允许并行。
7. **Windows 三件事**：无进程组（杀 kernel 用 `taskkill /T /F /PID`）、路径大小写不敏感（复用键与围栏必须规范化）、覆盖被占用文件会 EBUSY/EPERM（抛 `notebook_locked`，不要落进 `internal`）。
8. **NDJSON 分帧**：一个 chunk ≠ 一行。用 `Buffer` 累积按 `\n` 切；单行 > 64 MiB 视为协议错误。U22 专测这条。
9. **解释器解析是候选链**：kernelspec 失败/无 ipykernel 要继续往下试（`.venv` → PATH），全部失败才报错并列出每个候选的原因（D23）。只有显式 `--python` 失败即终局。
10. **`analyze` 只要有一个 cell 失败就整次降级为 regex**，且 regex 模式下**禁止**给 `confidence: "high"`（SPEC §5.6.1）。
11. **启动期失败一律退出码 2**（含 `--root` 是主目录/文件系统根时的拒绝），便于 CI 断言（SPEC §5.1）。
12. **不要为了让测试变绿而放宽断言**，也不要为了让类型通过而 `any`。测试是验收依据。

---

## 8. 工作流（强制）

按 SPEC §11 的 11 步顺序实现，**每一步完成前不得开始下一步**：

| 步 | 内容 | 该步必须通过的用例 |
|---|---|---|
| 1 | 脚手架：`package.json` / tsconfig / vitest / `config` / `log` / `errors` | `typecheck` + `lint` |
| 2 | `fs/fence` + `fs/atomic` + `fs/backup` | U11 |
| 3 | `core/parse` | U1、U10 |
| 4 | `core/edit`（双锚、坐标系、op 矩阵） | U2、U3、U5–U9、U14 |
| 5 | `core/markdown` | U4 |
| 6 | `core/outputs` + `fs/artifact` | U15、U16、U17、U26 |
| 7 | `kernel/*` + `python/ipynb_sidecar.py` | U22、I1、I5–I12、I17 |
| 8 | `core/stale` + sidecar `analyze` | U18、U19、U19b、U20、U25 |
| 9 | `mcp/*`：6 个工具、render、run-store、progress、abort | U21、U21b、U23、U24、U27、I13、I14、I16 |
| 10 | 打包与发布：`files`、README、LICENSE、dsh bundle、CI | I15 |
| 11 | 手工端到端 | E1–E9 |

**每一步的"完成"= 该步全部用例通过 + `pnpm typecheck` + `pnpm lint` + `pnpm test` 全绿。** 不满足就不算完成，不许进入下一步，也不许宣称完成。

**卡住时的升级路径**：同一个问题连续两次尝试仍失败 → 在 `DEVIATIONS.md` 写下现象、已尝试的方案、你判断的根因，然后**问人类**。不要第三次盲试同一个方向。

---

## 9. 测试要求

- 框架固定 **vitest**。
- **单测**（§10.1，U1–U27 含 U19b/U21b）：不需要 kernel，不许依赖网络、时钟、随机数；副作用只能落在临时目录且必须清理。
- **集成测试**（§10.2，I1–I17）：需要真实 ipykernel，用**测试专用虚拟环境**；每个用例自己起停 kernel 并断言无残留进程。
- sidecar 的 `spawn` **必须可注入**（SPEC §5.8），否则 I7/I11 无法测。
- 不许 mock 掉被测逻辑本身（例如为了通过 CAS 测试而 mock 掉 CAS 校验）。
- 新增行为必须同时新增或扩展用例，并在提交信息里说明。

---

## 10. 反面清单（不要做）

- 不要"顺手"重构、加功能、加工具、加参数、改返回字段 —— 1.x 有对外兼容承诺（D22）。
- 不要改动用户文件里的任何东西，除：被执行/编辑 cell 的 `source`/`outputs`/`execution_count`/`cell_type`，加上备份文件与 artifact。
- 不要为"更方便"而修改 SPEC、放宽红线或跳过某一步。
- 不要在 `src/core/*` 里为了省事直接 `import fs`。
- 不要把日志打到 stdout，也不要为了调试在 `src/` 里留 `console.*`。
- 不要新增错误码；不要在文本里塞 base64。
- 不要在 README 里承诺 SPEC 未定义的行为（尤其是 stale 分析的精度与保真度：**对外承诺是"逻辑不变"，不是"字节最小 diff"**，见 SPEC §5.5.7）。
- 不要把 `docs/archive/` 的设计当作现行规格。

---

## 11. 需要人类决定的事

**照 SPEC §12 的默认行为做，不要停下来问**：`max_images_per_call=20`、`kernel_idle_seconds=3600`、不做 attach 模式、不做"新建 notebook"、包名 `ipynb-mcp`、`dsh-ipynb-mcp` bundle 暂不发布、纯 Node transport 不立项。

**必须先问人类**：

1. 新增任何依赖（含 devDependency）。
2. 改动任何工具名、参数名、返回字段名，或新增/删除工具。
3. 发布到 npm / 改版本号 / 改 LICENSE。
4. 与 SPEC 的红线、错误码表、验收用例发生冲突的任何做法。
5. 需要联网、需要安装 Python 包、需要写入 `root` 之外路径的任何操作。

---

## 12. 开工前的第一件事

按此顺序确认环境，然后从 SPEC §11 第 1 步开始：

1. `SPEC.md` 已在仓库根，`docs/{archive,DEVIATIONS.md,OPEN_QUESTIONS.md,COMPATIBILITY.md}`、`CHANGELOG.md`、`LICENSE`(MIT) 已建立。
2. `docs/OPEN_QUESTIONS.md` 已原样抄录 SPEC §12。
3. `package.json` 满足 SPEC §8：`name: ipynb-mcp`、`license: MIT`、`type: module`、`bin`、`engines.node >= 22`、`files` 含 `lib` 与 `python`、**无 `prepare`/`postinstall` 构建脚本**（R15）、运行期依赖只有 `@modelcontextprotocol/sdk` 1.31.x。
4. 读一遍 SPEC §0、§4.1、§6、§7、§11 —— 这五节决定了后面所有代码的形状。
