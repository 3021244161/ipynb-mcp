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

| 文件                       | 作用                                                | 何时读/更新                      |
| ------------------------ | ------------------------------------------------- | --------------------------- |
| `SPEC.md`                | **唯一权威实现规格**（24 项决策、逐字段 schema、35 个错误码、验收用例、实现顺序） | 动手前读对应章节；**不修改**            |
| `README.md`              | 面向用户：安装、配置、已知限制、安全声明                              | 凡改动对外行为/配置项/限制，同一提交内更新      |
| `docs/COMPATIBILITY.md`  | 实测过的客户端与版本矩阵                                      | 发布前更新；macOS 只跑 unit 的缺口必须写明 |
| `docs/DEVIATIONS.md`     | 每一次偏离 SPEC 的记录（含理由与影响）                            | 每次偏离当场写                     |
| `docs/OPEN_QUESTIONS.md` | SPEC §12 的原样抄录                                    | 初始化时建立                      |
| `docs/archive/`          | v1（dsh bundle 形态）与 v2（架构定位）**历史存档，不生效**           | 只读；**禁止**照它实现               |
| `CHANGELOG.md`           | 逐版本接口变化                                           | 每个发布版本                      |

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

> **本树以 `src/` 的实际结构为准**（`git ls-files src` 可核对），与 `SPEC.md` §8 的清单有出入之处见  
> `docs/DEVIATIONS.md` D-007~D-011、D-022。

```
src/bin.ts                 参数解析、启动 stdio server、进程信号、退出路径
src/server.ts              MCP server 组装（6 个工具、严格参数 schema、read-only 守卫）
src/run.ts                 执行编排：选择器、模式矩阵、逐 cell 执行、写回、终态  ← 唯一跨层组装点（D-010）
src/config.ts              配置解析与启动期校验（退出码 2）
src/log.ts                 stderr 日志（R14）
src/hash.ts                core 哈希能力的 Node 适配器（让 core 完全不 import node:*）
src/mcp/                   context.ts（ToolContext + 值级校验）· run-store.ts（异步句柄）
  mcp/tools/               read · edit · run · run-status · kernel · result（D24 唯一出口）
  mcp/render/              read.ts（文本投影；nbformat 输出形状在 core，见 ARCH-1）
src/core/                  parse · edit · outputs · markdown · stale · errors        ← 纯逻辑
src/fs/                    fence · atomic · backup · artifact · notebook-file · markdown-targets
src/kernel/                registry · interpreter · transport（接口）· sidecar-transport · protocol
python/ipynb_sidecar.py
tests/{unit,integration}
```

**模块边界（违反即回退）**：

| 模块             | 禁止                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/core/*`   | **禁止** import `node:*` 或任何 I/O；禁止时钟/随机数影响返回语义（R11）；nbformat 的形状转换只能发生在这里（`parse`/`outputs`）                         |
| `src/fs/*`     | 禁止解析 notebook 语义（字节与 errno 是它的职责面）                                                                                  |
| `src/kernel/*` | 禁止解析 notebook 结构                                                                                                    |
| `src/mcp/*`    | 禁止直接碰 `node:fs`；禁止解析 notebook 语义                                                                                    |
| `python/*.py`  | **禁止读写用户文件**；只接收 `{code}` / `{sources}`，永不接收用户文件路径（R13）。唯一例外是它自己 kernel 的 connection file（位置被钉在 OS 临时目录并负责清理，D-023） |

可变状态只允许存在于 `src/kernel/registry.ts` 的单一 `KernelRegistry` 与 `src/mcp/run-store.ts` 的 run 表（外加 `src/kernel/interpreter.ts` 的带 TTL 探测缓存）。

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

| 红线                                                             | 为什么                        | 自检方式                                                              |
| -------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| **stdout 只能有 JSON-RPC**                                        | 混入任何字节都会污染 stdio 帧，服务直接不可用 | I12 断言每一行都能 `JSON.parse`；lint `no-console`                        |
| **任何文本字段不得出现 base64**                                          | 上下文爆炸，且是本项目对用户的承诺          | U15 用"可解码且解码后是 PNG/JPEG 魔数"的字符串断言                                 |
| **不返回图片块时不得物化图片**                                              | 默认的 read 调用不该产生磁盘写入        | U26 断言 artifact 目录无新文件                                            |
| **不使用 `structuredContent` / 不声明 `outputSchema`**               | 双写会让 token 翻倍（D24）         | U24 断言恰好 1 个文本块、无结构化字段                                            |
| **`replay` 静默阶段不写文件、不返回输出**                                    | 否则会把"补齐状态"误当成用户要的结果        | I3 断言文件字节级未变                                                      |
| **无 CAS 锚不得写入源码**                                              | 静默写错是本工具要消灭的头号故障           | U2 / U3 / U5                                                      |
| **不改 `metadata` / `kernelspec` / `nbformat`，不自动升级格式，不重排 cell** | 对用户文件的非必要改写                | U1 断言未知字段与未修改 cell 原样保留                                           |
| **不碰 `root` 之外的文件**                                            | 默认安全姿态                     | U11；围栏比较必须 `realpath` + win32/darwin 转小写                          |
| **不执行 `pip` / `conda` / 包管理器**                                 | 不修改用户环境                    | 代码里搜 `spawn` 的用途；只有 sidecar 与 `python -c "import ipykernel"` 两处合法 |
| **sidecar 不得接触文件路径**                                           | 单一写入方                      | 审 `python/ipynb_sidecar.py` 的 op 参数                               |
| **不得留下孤儿 kernel / sidecar**                                    | 用户体验与环境整洁                  | I11 按 pid 断言；退出路径必须 `shutdown_all`                                |
| **零遥测**                                                        | 承诺                         | 仓库内搜 `fetch` / `http`                                             |

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

| 步  | 内容                                                                   | 该步必须通过的用例                        |
| -- | -------------------------------------------------------------------- | -------------------------------- |
| 1  | 脚手架：`package.json` / tsconfig / vitest / `config` / `log` / `errors` | `typecheck` + `lint`             |
| 2  | `fs/fence` + `fs/atomic` + `fs/backup`                               | U11                              |
| 3  | `core/parse`                                                         | U1、U10                           |
| 4  | `core/edit`（双锚、坐标系、op 矩阵）                                            | U2、U3、U5–U9、U14                  |
| 5  | `core/markdown`                                                      | U4                               |
| 6  | `core/outputs` + `fs/artifact`                                       | U15、U16、U17、U26                  |
| 7  | `kernel/*` + `python/ipynb_sidecar.py`                               | U22、I1、I5–I12、I17                |
| 8  | `core/stale` + sidecar `analyze`                                     | U18、U19、U19b、U20、U25             |
| 9  | `mcp/*`：6 个工具、render、run-store、progress、abort                        | U21、U21b、U23、U24、U27、I13、I14、I16 |
| 10 | 打包与发布：`files`、README、LICENSE、dsh bundle、CI                           | I15                              |
| 11 | 手工端到端                                                                | E1–E9                            |

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
- **断言不能只说产品自己的方言。** 这是本项目付出过代价的教训：四轮评审都没发现"执行后写出的 notebooks 根本不是合法 nbformat"，因为写入方与测试**用同一套私有字段名**（`outputType`），于是整套用例都在验证一个错误的世界观。凡是"产出的文件/协议/接口是否合规"这类问题，必须引入**外部权威**来判定：
  - notebooks 的合规性用 Python 的 `nbformat.validate`（`tests/integration/nbformat-validator.ts`）；
  - 端到端行为用**真客户端**驱动真 stdio server（`scripts/e2e-smoke.mjs`，`pnpm smoke`）；
  - 自己写的检查器（如 `findStructuralProblem`）只能当**快速防线**，不能替代外部权威，且必须与外部权威对同一批 fixture 同时通过（`tests/integration/fixtures-valid.test.ts`）。
- **测试 fixture 本身也要过外部权威。** 历史上多个 fixture（kernelspec 缺 `display_name`、`execute_result` 缺 `execution_count`）本身就是非法 nbformat，这让"文件没问题"类断言失去意义。
- **格式类问题必须用解析器查，不能抽样。** 同一个"整块缩进错位"事故出现过三次；`git diff -w` 看不见它，`oxlint` 也不管。`pnpm lint` 现在会跑 `scripts/check-format.mjs`（tab/行尾空白）与 `scripts/check-indent.mjs`（用 TypeScript parser 校验块缩进与闭合括号列）。
- **守卫必须自己证明有判别力。** 第五轮评审把仓库的测试当**被测对象**做变异，立刻抓到一条"看着很硬、实际无判别力"的性能守卫：它的计数器挂在父 Buffer 的**自有属性**上，而被测代码拿到的是 `subarray` 结果（不继承自有属性），于是计数器恒为 0、断言恒真，把实现换成二次版本仍然全绿。  
  **规则**：新增或修改任何"守卫型"断言（性能上界、不变量、安全边界、错误路径）时，必须在提交信息或注释里写明**在什么变异下它会红**，并亲手做一次该变异。做不到，就说明它守不住任何东西，等于没有。同理，断言里出现的计数器/探针要有一条"探针确实跑过"的断言（例如 `expect(calls).toBeGreaterThan(0)`），否则探针失效时守卫会静默变成恒真。
- **闸门的范围要等于它的责任范围。** 校验"我们写出的东西"时，不要把"用户本来就有的东西"一起判：第五轮的写前结构闸门审整份文档，于是一处历史遗留的不合规输出让**所有**编辑与运行永久失败（`selfcheck_failed`），而错误位置指向调用方从未触碰的 cell。**判据**：任何"拒绝写入/拒绝执行"的检查，都要能回答"这是本次操作引入的，还是本来就存在的"；后者应当是 warning，不是失败。
- **修数据形状缺陷 = 补该字段的「全部合法类型」矩阵 + 逐项先红后绿。** 这是第七→第八轮用两条同族缺陷换来的规则，两边都栽在同一件事上：
  - v7 修了 `application/json` 的**非字符串**值（`[1,2,3]` 曾被变成 `123`），把"读方向已兑现 json 契约"写进文档，却没测**字符串**值与 `+json` 一族 —— 于是 v8 又抓到 `"123"` 被 parse 成数字、`application/x+json` 一律 `unsupported`；
  - 复验方**也只复跑了 v7 点名的那一格**，所以同一族的未修分支活过了一轮。
  **规则**：修任何"值/字段的形状"缺陷时，先写出该字段**全部合法类型**的矩阵（对 mime 就是"该 mime 的 schema 允许的每一种 JSON 类型" × "schema 认可的每一个键变体"），**先跑一遍确认它们红**，再改实现让它们绿。只补一条"评审举的那个例子"不算修完。
  **判据**：如果新增的矩阵项在改代码**之前**就是绿的，那它没有覆盖任何缺陷 —— 要么报告里那条缺陷没被理解，要么矩阵选错了。
- **等价类是复验的单位，不是"上轮点名的那一格"。** 与上一条配套：复验别人的修复时，按**等价类**跑（同一 mime 的全部类型、同一字段的全部变体、同一规则的全部触发路径），不要只跑上一轮报告里出现的那一个具体值。评审自己在这件事上栽过一次，所以写下来对双方都成立。
- **断言要断言到消费者真正拿到的那一层。** 改数据形状时，"我修好了"必须落在**模型实际收到的东西**上，不能停在内部对象。本项目的数据形状有**四层**，一次修复至少要断言到**"模型读到的那一层"**，触及磁盘的再带上**"文件字节那一层"**：

  | 层 | 是什么 | 怎么断言 |
  |---|---|---|
  | ① 内部投影 | `mapRawOutputs` 之类的返回对象 | **最弱**。只是中间量，不能作为"修好了"的依据 |
  | ② 模型读到的那一层 | 工具结果里的内容块（`OutputItem` / `content[].text`） | 形状类修复的**最低要求** |
  | ③ 文件字节 | `.ipynb` 在磁盘上真实是什么 | 凡修复涉及"写回/存储"就必须带上 |
  | ④ 协议帧 | stdout 的 JSON-RPC 行 | 端到端才跑得出来（`pnpm smoke`） |

  为什么不能只测①：v8 的 json 缺陷里，①和②同时对，但**盘上是字符串而响应是数字** —— 只断言①的用例全绿，用户仍然拿到被改写的数据。
  为什么只测②也不够：v8-2 的最终证据是**真 kernel cell**（`display({'application/json':'123'}, raw=True)` → 盘上与响应逐字节一致）。手搓 raw output 到不了④，而"盘上的字符串其实是字符串"这件事只有在真实通路上才看得见。
  **顺序**：先按上一层补等价类矩阵，再**至少**把②写成断言；能走真链路的一律走真链路（③④）。
  **为什么写成硬规则**：同一个错误换着面貌出现过四次 —— 字段名（v4）→ 值类型（v6）→ 读方向（v7）→ **解码层 vs 内容块层（v9）**。每次的共同点都是"**新守卫只覆盖被改的那一层**"。v9 的具体形态：为了修"data-URL 图片看得见读不出"，只改了**解码/物化**那一层，断言停在内部 `OutputItem`（`bytes > 0`、`__decodeFailed === false`），而**内容块**那一层仍把 `data:` 原值交给 SDK —— 于是"解码已修好"的三条用例全绿，含 data-URL 图片的 notebook 却连 `notebook_read` 都以 `-32602` 失败（`notebook_run` 同），**门禁、CI、smoke 同时放行**。所以断言必须落在 `content[]` 上，并用**不属于本项目的判据**（SDK 自己的 `CallToolResultSchema`、Python 的 `nbformat.validate`）来判。
- **单个字段的缺陷不得升级为工具级失败。** 任何"某个字段/值不合法"的情形，默认出口是**warning + 降级项**（`unsupported` / `bytes: 0` / 空串 + 说明原因的 `text_fallback`），**不是**让整个工具返回 `isError`。因为消费者是模型：一个坏掉的图片字段让整次读取失败，模型失去的是**整份 notebook**，而它本来只需要知道"这一张图坏了"。现状已经是这样（坏图片 → `image_materialize_failed` warning + 0 字节 image item），写成规则是为了**约束未来新增的字段**：新字段的解析若会抛 fatal，必须先回答"这会连累整个工具吗"。
  这条规则在 v9 得到了一次**协议级**的印证：内容块不合法时 SDK 抛的是 `-32602`，那不是"工具返回错误"，而是**整个结果作废**——连文本块与其它图片一起消失。所以"组装结果"这一层也要有闸门（`toCallToolResult` 现在会丢弃不合法的块并降级为警告），不能假定生产者永远正确。
  **只有两种情况可以升级为工具级失败**：
  1. **协议帧完整性**（④）：stdout 混入非 JSON-RPC 字节、单行超限（U22/I12）—— 帧坏了就没有"部分正确"可言；
  2. **文件字节完整性**（③）：写不进去、锁不住、写出的东西不是合法 nbformat —— 此时"部分成功"等于损坏用户文件，必须失败并说清（这正是 CAS 与写前闸门存在的理由）。
  两者都不是"形状"问题，而是**承载层**问题 —— 判据就是这个：**问的是"这个值对不对"，还是"承载它的东西还完好么"。** 前者一律降级，后者一律失败。
- **判据必须与外部权威一致。** 本工具自己的闸门（`findStructuralProblem`）是**快速防线**，不是合法性判据：v10 抓到一条 hint 写着"清空输出后**文件就变合法了**"，而实测 `nbformat.validate` 仍然拒绝它——因为那句话把"我们不再检查"说成了"文件合法"（V10-4）。**规则**：凡是用"合法/合规"这种词的文案，必须有外部权威的用例背书；写不出来就不要说。同理，任何"我修好了"的断言都不能只用本项目的检查器自证。
  **反面也成立**：守卫**不得因无关原因失败**。v10 抓到 `check-docs.mjs` 的自测把文档里的字面量硬编码成变异源，于是一次**合法的**文档修订（两个文件同步改一个词）会让 `pnpm lint` 变红，而文档恰恰是改对了（V10-8）。**规则**：变异/夹具从**当前内容推导**，施加不了就**跳过并显著提示**，同时给"可施加数量"设下限，避免容错退化成"什么都不查了"。
- **自己写 parser / 序列化器时，语言语义边界与数值形态都要有矩阵。** 这是 v9→v10 两轮换来的规则，两次都是"**以为已经覆盖了**"的那一格：v9 只保护了整数字面量（v10 抓到小数在盘上被静默改写，V10-3）；v9 只在**顶层**判断内部标记（v10 抓到嵌套的标记对象原样漏给模型，V10-1）；而 `JSON.parse` → 自研 parser 的替换恰好丢了 `__proto__` 这一格（V10-6），后果是**从用户文件里静默删掉一个键**——同一份代码在替换**之前**是正确的。
  **必测格**：
  - **数值**：整数 / 小数 / 指数 / 超范围 × 顶层 / 嵌套 / 数组 / 深嵌套（`tests/unit/json-number-forms.test.ts`：20 形态 × 8 位置）；
  - **解析语义**：`__proto__` / `constructor` / `prototype` / 声明的原型方法名 / 稀疏数组（`[1,,3]` 是**语法错误**，与 `JSON.parse` 一致）/ 重复键（后者胜，且**不移动键位**）/ `-0` / 非 BMP 键与代理对 / 控制字符转义 / 空键（`tests/unit/json-parser-semantics.test.ts`：28 语义样本 + 22 拒绝样本，逐条与 `JSON.parse`/`JSON.stringify` 对照）。
  **判据**：**替换一个成熟实现（`JSON.parse`、`JSON.stringify`、`open()`…）时，先写出"它替掉的那个东西"的行为矩阵，再替换**。被替换者是最好的规格说明，而它的每一条边都可能是你没想到的那一格。

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
