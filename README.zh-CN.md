# ipynb-mcp-server

[English](./README.md) | **简体中文**

[![npm version](https://img.shields.io/npm/v/ipynb-mcp-server.svg)](https://www.npmjs.com/package/ipynb-mcp-server)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node: >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/3021244161/ipynb-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/3021244161/ipynb-mcp/actions/workflows/ci.yml)

一个 [MCP](https://modelcontextprotocol.io) 服务端：让任何 AI agent **读取、编辑并执行本地的 Jupyter notebook**——安全，且零配置。

## 没有它会出事的三种情况

| 今天会发生什么 | 本服务怎么处理 |
|---|---|
| 你让 agent 改 notebook，而它同时还在 JupyterLab 里开着——agent **覆盖掉你刚改的 cell**，等你发现时文件已经坏了。 | 每一次源码修改都必须带 **compare-and-swap 锚点**（`expected_source_hash` 或 `expected_text`）。如果文件在 agent 上次读取之后被改过，这次修改会**直接失败、不写入**，而且错误里已经带回当前哈希，重试一次即可成功。写入是原子的，且每次写入前都会先做一份滚动备份。 |
| 你说"跑第 87 格"，结果**把开头那个 40 分钟的训练 cell 又跑了一遍**，或者把 `!wget` 下载 2 GB 数据集的那格重跑了。 | `mode='resume'` 只在存活 kernel 里跑你指定的 cell。没有存活 kernel 时，`mode='replay'` 会先静默地从第 0 格重建状态，再只跑目标格——并且 `replayed_cell_indexes` 会明确告诉你它重跑了哪些。`notebook_kernel(start)` + `resume` 可以做到**零重跑**只跑一格。 |
| 光是为了让 agent 能用，你就得先把 JupyterLab 起起来、复制 URL、管理一个 token，还得让它一直开着。 | **什么都不用起。** stdio 传输，一行配置，没有端口，没有 token。服务直连 Jupyter kernel，并随客户端一起退出。 |

## 安装

**不需要 clone，不需要构建。** 服务以「已构建好的 npm 包」发布，三种方式任选：

| 方式 | 命令 | 适用场景 |
|---|---|---|
| **按需运行（推荐）** | `npx -y ipynb-mcp-server --root /你的/notebook/目录` | 你只是要在 MCP 客户端配置里用它。不常驻安装，`npx` 首次使用时会从 npm 取包并缓存。 |
| **全局安装** | `npm install -g ipynb-mcp-server`，然后 `ipynb-mcp-server --root /你的/notebook/目录` | 你想让命令进 `PATH`，或想锁定版本（`ipynb-mcp-server@0.1.0`）。 |
| **从源码** | `git clone https://github.com/3021244161/ipynb-mcp && cd ipynb-mcp && pnpm install && pnpm build` | **只有你要改代码时才需要**，见 [开发](#开发)。 |

环境要求：**Node ≥ 22**（自带 `npm` 与 `npx`）。Python 只在真正执行 cell 的那一刻才需要，且由服务自己去找——见 [解释器选择](#解释器选择)。安装过程**不执行 `pip install`、不编译任何东西**。

## 加入你的客户端（60 秒）

```bash
# 1. 它就是个普通 stdio 服务——不需要安装，不需要启动常驻进程
npx -y ipynb-mcp-server --root /你的/notebook/目录
# 2. 然后把下面那段配置贴进你的客户端，重启客户端
```

不需要 `pip install`，不需要 JupyterLab，不需要端口，不需要 token。

## 与其他方案对比

| | 上手成本 | 写入不会静默损坏你的文件 | 长任务 | 维护状态 |
|---|---|---|---|---|
| **ipynb-mcp-server**（本项目） | 一行 `npx`，**无需任何常驻服务** | 每次编辑都有 CAS 锚点 + 原子写 + 滚动备份 | `resume` / `replay` / 单格 `resume`，外加 stale-cell 分析 | 活跃（2026-10） |
| [datalayer/jupyter-mcp-server](https://github.com/datalayer/jupyter-mcp-server)（约 1.3k★） | 需要**已在运行的 Jupyter Server** + `SERVER_URL` + `TOKEN`（或用 Docker） | — | — | 活跃（公司维护） |
| [jupyter-ai-contrib/jupyter-server-mcp](https://github.com/jupyter-ai-contrib/jupyter-server-mcp) | Jupyter Server **扩展**：要装进一个正在运行的 server | — | — | 活跃 |
| [jbeno/cursor-notebook-mcp](https://github.com/jbeno/cursor-notebook-mcp)（约 160★） | 从 PyPI/npx 安装，直接操作文件 | — | — | **2025-11 起停更** |
| [jjsantos01/jupyter-notebook-mcp](https://github.com/jjsantos01/jupyter-notebook-mcp)（约 130★） | 通过 WebSocket 桥接**正在运行的** Jupyter | — | — | **2025-04 起停更** |

> `—` 的含义是"该项目自己的文档没有承诺这一项"。上表每一格只写各项目文档与仓库里已经写明的事实（星数与最近 push 时间取自 2026-10-06 的 GitHub API）；本表刻意不对"别的项目做不到什么"下结论。

额外能力：stale-cell 分析（哪些输出因为输入变了而失效）、把图片输出作为原生 MCP image block 返回、长任务后台执行 + 轮询、按 notebook 管理 kernel 生命周期。

## 客户端配置

```jsonc
// Claude Code / Cursor / VS Code（通用 MCP stdio 配置）
{
  "mcpServers": {
    "ipynb": {
      "command": "npx",
      "args": ["-y", "ipynb-mcp-server"],
      "env": { "IPYNB_ROOT": "/你的/notebook/目录（绝对路径）" }
    }
  }
}
```

dsh 用户：安装配套的 `dsh-ipynb-mcp` bundle（见 [dsh-ipynb-mcp/](./dsh-ipynb-mcp/)）。

服务把所有路径都围栏在 `IPYNB_ROOT`（或 `--root`，或进程工作目录）之内。**当 root 是你的家目录或某个盘根时，服务会拒绝启动**——请显式传 `--root`。

## 配置项

优先级：命令行参数 > `IPYNB_*` 环境变量 > 默认值。布尔参数支持 `--no-` 前缀。

| 命令行 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--root <dir>` | `IPYNB_ROOT` | cwd | 根目录围栏 |
| `--allow-outside-root` | `IPYNB_ALLOW_OUTSIDE_ROOT` | `false` | 允许访问根目录之外的路径 |
| `--read-only` | `IPYNB_READ_ONLY` | `false` | 只允许 `notebook_read` 与 kernel `status` |
| `--images <auto\|never\|always>` | `IPYNB_IMAGES` | `auto` | 图片块策略（`auto`：只在完整输出读取与执行时返回图片） |
| `--python <path>` | `IPYNB_PYTHON` | 自动 | 显式指定解释器（指定后失败即失败，不再回退） |
| `--kernel-idle-seconds <n>` | `IPYNB_KERNEL_IDLE_SECONDS` | `3600` | 空闲 kernel 回收 |
| `--exec-timeout-seconds <n>` | `IPYNB_EXEC_TIMEOUT_SECONDS` | `300` | 单格超时 |
| `--background-threshold-seconds <n>` | `IPYNB_BACKGROUND_THRESHOLD_SECONDS` | `30` | 当"预估上界（`timeout_seconds × 目标格数`）"超过该值的 **10 倍**时转为后台执行 |
| `--backup-keep <n>` | `IPYNB_BACKUP_KEEP` | `10` | 每个 notebook 保留的滚动备份数 |
| `--artifact-dir <dir>` | `IPYNB_ARTIFACT_DIR` | 平台缓存目录 | 图片 artifact 写入位置 |
| `--inline-text-chars <n>` | `IPYNB_INLINE_TEXT_CHARS` | `20000` | 文本输出内联截断阈值 |
| `--preview-lines <n>` | `IPYNB_PREVIEW_LINES` | `12` | 源码预览行数 |
| `--max-images-per-call <n>` | `IPYNB_MAX_IMAGES_PER_CALL` | `20` | 单次工具调用返回的图片块上限 |
| `--max-image-bytes <n>` | `IPYNB_MAX_IMAGE_BYTES` | `20971520` | 单张图片最大字节数 |
| `--log-level <level>` | `IPYNB_LOG_LEVEL` | `info` | stderr 日志级别 |

启动失败（参数值非法、root 不存在 / 是家目录 / artifact 目录不可写）会以退出码 **2** 结束。

默认配置下，**单格**执行是同步返回的（其预估上界恰好等于那个 10 倍阈值）；**两格及以上**、或调大了 `--exec-timeout-seconds` 时，会返回一个后台 `run_id`，用 `notebook_run_status` 轮询。这个倍数来自 `DEVIATIONS.md` D-015。

## 解释器选择

当 notebook 需要 kernel 时，解释器按候选链解析：`--python` → notebook 自带的 `metadata.kernelspec` argv → notebook 同级的 `.venv`/`venv` → `PATH` 上的 `python3`/`python`。每个失败的候选都会被记录；**只有全部失败**时工具才报错（并附上可直接执行的 `pip install ipykernel` 命令——服务自己从不安装任何东西）。与 kernelspec 不一致的 `.venv` 会产生 `kernelspec_mismatch` 警告；用 `--python` 可以显式钉住一个。

## 输出、图片与大数

`include_outputs: 'full'` 的读取会把每个已存输出投影成 [SPEC.md](./SPEC.md) §5.4 定义的某种 `OutputItem`，并把图片项作为原生 MCP image block 返回。有两种取值形态值得单独说明，因为真实 notebook 里两种都常见。

**图片。** notebook 可能把图片存成纯 base64、存成大家常粘贴的 `data:image/png;base64,…` 形式、跨多行折行、或存成"行的数组"（nbformat 的多行形式）。完整输出读取与执行都会把这些一律返回为合法图片块，解码出的就是你文件里的那些字节，并用 `image_index` 与 `artifact_path` 标注是哪一个块、为它写了哪个 artifact（不返回块时——摘要式读取、`--images=never`、或超过 `max_images_per_call`——两者都是 `null`，见 SPEC §4.4）。**无法解码的值（包括空值）永远不会让整次调用失败**：该项保持 `kind: "image"`，带 `bytes: 0`、`artifact_path: null`、`image_index: null` 和一句说明原因的 `text_fallback`，同时该次调用带一个 `image_materialize_failed` 警告。文件里存的原值原样保留；图片块是从解码字节临时构造的——所以"你的 notebook 里存了但任何客户端都解不开"的值，是**降级的图片**，不是**失败的读取**。

**`application/json` 里的大整数。** nbformat 对 json 取值不做类型约束，而 JavaScript 无法精确表示的整数（超出 ±2^53，例如 `2**64`）无法原样穿过 JSON number 通道。这类值在文件里**逐字节保留**（一次读-写往返不再把它四舍五入），响应也会如实报告而不是假装无事：每当该输出被完整返回（完整输出读取或执行），该项会带 `warnings` 数组，调用级 `warnings[]` 也会增加一条——code 为 `output_truncated`（它本来就在 SPEC §7 的封闭码表里）——其 message 含**精确数字**。`value` 字段存的是最接近的 double，因为那正是 JSON 通道本身能承载、任何 JSON 客户端都会解析出来的东西；你需要的数字在 warning 里，也在文件里。

## 已知限制

- **执行就是任意代码执行。** 把 root 指向你愿意让 agent 写入的目录；围栏是路径边界，不是沙箱。只运行你愿意执行的 notebook。
- **stale 分析只支持 Python。** 非 Python kernel（R、Julia 等）可以读/改/跑，但会跳过 stale 分析（`method: "skipped"`）。它也看不穿 `globals()`/`locals()`/`exec`/`eval`/`setattr`、属性赋值（`obj.attr = 1`）和 `import *`。当某个 cell 解析失败时，整轮分析会退化为保守的正则兜底（所有置信度降为 `low`；正则兜底还漏掉元组解包、带注解的赋值、缩进赋值与 `with … as`，并可能把字符串/注释里的标识符误判为使用）。
- **不支持交互式 widget**（`application/vnd.jupyter.widget-view+json` 降级为 `unsupported`）。
- **单个响应有体积预算（默认 8 MiB），因为客户端超过 10 MiB 就会死。** 工具结果以单行 JSON-RPC 传输，而 MCP SDK 的读取器遇到超过 10 MiB 的行会直接关闭连接——你会看到 `-32000 Connection closed`，此后该会话里的每一次调用都回 `Not connected`：**丢的是会话，不是这一条响应**。所以服务会提前降级：最大的文本值被截短并标注，必要时整段输出被丢弃，图片在放不下时被扣住。每一次移除都带 `output_truncated` 警告，被扣住的图片字节仍可通过载荷里已有的 `artifact_path` 取回。**这个预算被刻意放在悬崖之下，因此 8–10 MiB 之间的响应是被截短后发出的**——本来能被你客户端接受的内容，会以"截短并标注"的形式到达。如果你的客户端缓冲区确实更大，可以调高 `--max-response-bytes`（或 `IPYNB_MAX_RESPONSE_BYTES`）；对超大 notebook，优先用 `include_outputs: 'summary'` 或 `cell_indexes`（`DEVIATIONS.md` D-065、D-067）。
- **内存占用与 notebook 体积成正比，而一个 notebook 可以比默认堆还大。** 读取与执行都会把文档整个持在内存里；一个真实的 37.5 MiB notebook（xgboost 调参那种，输出里塞满 SHAP 图与 dataframe）在一次完整 `notebook_run` 里峰值约 **0.9 GiB**。这在 Node 默认堆里是舒服的，而这个数字本身是"去掉一处 16 倍解析缺陷"之后的结果——更早的版本对同一个文件需要 **2.2 GiB**，并会以 `FATAL ERROR: Ineffective mark-compacts near heap limit` 崩掉，客户端只看到 `-32000 Connection closed`，而且那台 server 名下**所有** kernel 一起死（`DEVIATIONS.md` D-059）。如果你有远大于此的 notebook，给这个服务的环境块里加 `NODE_OPTIONS=--max-old-space-size=4096`；成本随文件线性增长，所以 100 MiB 的 notebook 需要几个 GiB。
- **图片密集的单格执行仍受传输层约束。** sidecar 每个响应只发一行 NDJSON，而行上限为 64 MiB；由于 `exec_cell` 响应要承载所有输出的 base64，单格产出超过约 64 MiB base64 图片数据（例如好几张接近 `max_image_bytes` 的图）时会以协议错误失败，而不是把图片返回给你。可以调低 `max_image_bytes`、拆格，或用 `notebook_read` 把图片单独读回来。记为 `DEVIATIONS.md` D-017。**一次协议错误会把整个 sidecar 拆掉，于是它承载的每一个 kernel（该解释器下所有 notebook 的）跟着一起死**：下一次 `notebook_run` 会通过 `replay` 静默重建，但已经在内存里跑完的长训练格不会重跑。
- **在"没有 cell 正在执行"时死掉的 kernel，要到下一次请求才会被发现。** sidecar 只在执行 cell 期间轮询 kernel 进程；格与格之间，它只会在下一次调用到达时才知道外部杀进程（OOM killer、`taskkill`）。`notebook_run` 在复用会话前会探测 kernel 存活，所以这种情况会变成静默 `replay`/重建而不是报错——但那一刻 kernel 的内存状态已经没了。
- **"能 `import ipykernel` 但托管不了 kernel"的解释器是硬失败，不是回退。** 候选链靠探测 `import ipykernel` 选解释器；如果 kernel 随后启动失败（现实中常见是 pyzmq 构建坏掉），本次运行以 `kernel_died` 失败，错误详情里带着 sidecar 最后的 stderr 与操作系统退出码（例如 `code=3221226505 (0xC0000409) = STATUS_STACK_BUFFER_OVERRUN`）。服务**不会**静默换一个解释器重试（`DEVIATIONS.md` D-030）。
- **`mode='auto'` 可能把你目标之前的 cell 全部重跑。** 在没有存活 kernel 时（读/改从不启动 kernel，所以这是常态），一个指名了具体 cell 的 `notebook_run` 会解析为 `replay`：它会先静默执行目标之前**每一个** code cell 来重建状态，并丢弃这些输出。在一个开头几格就要下载数据集或训练一小时的 notebook 上，`notebook_run(cell_selector='87')` 会把整套重跑一遍。响应事后会告诉你（`mode_used: "replay"` 加 `replayed_cell_indexes`）。**要严格只跑一格，就先起 kernel**——`notebook_kernel(action='start')`，然后 `notebook_run(mode='resume')`——这样零重跑；没有存活 kernel 时 `mode='resume'` 会干净地以 `kernel_not_available` 失败，而不是靠猜。SPEC §4.7 规则 1 要求静默 replay，而警告码表是封闭的，所以这条是**记录在案**而不是改掉（`DEVIATIONS.md` D-062）。
- **超时的 cell 同时结束它的 kernel**（SPEC §4.7 规则 6），所以那里累积的内存状态会丢；下一次运行通过 `replay` 重建（D-025）。关闭是**异步**的：响应先返回，kernel 进程可能还会活到那个被打断的 cell 自己跑完为止——长计算是几秒到几分钟。管理命令立刻报告"无 kernel"，而进程在它结束时已经消失；不会留下孤儿进程。
- **在 Windows 上，打断正在运行的 cell 通常不生效，所以超时靠上面那个关闭来实现。** 打断 kernel 需要一个控制台事件，而 stdio MCP 服务没有控制台可以投递它；一个 `time.sleep(30)` 的 cell 会无视打断跑完，而工具已经返回 `exec_timeout` 并关掉了 kernel。此为 Windows 上的实测；其他平台未验证。超时响应不再等待一个它无法回复的运行中 cell，因此它会在 **`timeout_seconds` + 约 10 秒**（打断宽限 + 拆除；2 秒超时实测 10.2 秒）到达，而不是等到 cell 全程结束（D-033）。
- **每次写入落盘前都会被校验——针对这次写入改写的那些 cell。** 即将写入的字节会被重新解析，本次改动涉及的 cell 会按"本实现可能破坏的 nbformat 规则"逐条检查；违反会以 `selfcheck_failed` 中止写入，而不是产出一个 Jupyter 会拒绝的文件。这**刻意不做**完整 schema 校验。**原本就存在**于你文件中、只是被顺带带过去的内容会被保留并以警告形式报告（`file_changed_externally`，消息里带规则与 cell），但永远不会用来阻断一次编辑或运行（D-032、D-037）——**这意味着一份本来就有这类内容的文件，在一次成功的编辑或运行之后，仍然无法通过 `nbformat.validate`。** 请你自行修正或清除那部分内容；本工具不会改写你的历史。`scripts/e2e-smoke.mjs` 会用 Python 自己的 `nbformat.validate` 复核一次真实的编辑+运行。
- **kernel 的 connection file 位于操作系统临时目录，并在本进程可控的每一条退出路径上被删除。** 硬杀（SIGKILL、断电）可能在**那里**留下一个；它绝不会被写进你的 notebook 目录（D-023），文件名不可预测且权限 0600（D-034）。它带着那个 kernel 的 HMAC key，所以出现遗留文件时请按敏感文件对待。
- **同一 notebook 同一时刻只允许一次运行。** 第二个并发的 `notebook_run` 会以 `kernel_busy` 失败，而不是把两次执行交错——包括它落在第一次运行的两格之间的情况。不同 notebook 之间可以并行。
- **字节级保真度是"逻辑上的"，不是"字面上的"。** 序列化会规范化 `\uXXXX` 转义与数字的**拼写**，所以一份大量使用转义的 notebook，在未被触碰的区域也可能出现文件级 diff。**被保留下来的是每一个值**：`100.0` 可能回来变成 `100`，`2.0` 变成 `2`，`1e-05` 变成 `0.00001`——同一个数；Python 自己的 `json.dumps` 输出也是这样，而这些拼写大多来自它。**不被容忍**的是值被改动：JavaScript 拿不住的数字会以文件里原本的字面量写回，并附一条点出精确数字的警告（见上文"输出、图片与大数"）；溢出（`1e400`）或下溢（`1e-400`）double 的字面量同理。其余情况由滚动备份（`<名字>.<时间戳>.ipynb.bak`）兜底。
- **未知的工具参数会报错，而不是静默取默认。** 往 `notebook_read`（它的参数是 `cell_indexes`）传 `cell_selector` 会以 `invalid_arguments` 失败，而不是悄悄把整个 notebook 读一遍。
- **与其他程序写入相撞时：先重试，再报告。** 在 Windows 上，操作系统把"另一个进程持有此文件"与"两次 rename 撞车"报成同一回事；瞬时情形会重试约 0.75 秒后才返回 `notebook_locked`，所以一次瞬时碰撞不再看起来像"文件被锁"（D-035）。
- **不自动创建** notebook、不做格式转换、没有协作功能。

## 与显而易见的替代方案的区别

- 对比 `jupyter nbconvert --execute`：那是整本批量执行，没有任何续跑状态的手段；每次都把全部重放一遍。
- 对比"用 shell 跑代码"：没有 notebook 状态、输出不会写回 `.ipynb`、没有图片、编辑也没有 CAS 保护。
- 对比"接入一个 Jupyter Server"：那需要有常驻服务和 token 管理；本项目是零配置 stdio。

## 开发

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test          # 单元测试（不需要 Python）
pnpm test:integration                              # 真实 kernel（需要 ipykernel）
pnpm smoke                                         # 用真实 MCP 客户端驱动真实 stdio server
pnpm check:package                                 # 看 `npm pack` 会发出去什么
pnpm build
```

`pnpm lint` 不只是 linter：它还会跑三个零依赖检查器——`scripts/check-format.mjs`（制表符、行尾空白）、`scripts/check-indent.mjs`（块结构，走 TypeScript 解析器）与 `scripts/check-docs.mjs`，后者守住文档不变量（`docs/DEVIATIONS.md` 的条目 id 唯一且无空号，`docs/OPEN_QUESTIONS.md` 仍是 SPEC §12 的逐字副本）。`pnpm smoke` 会把构建产物作为真实 stdio 进程启动，用 SDK 自带的客户端驱动它，检查单元测试够不到的端到端行为——目前 26 项，包括运行与读取一个存放 `data:` URL 图片的 notebook（这个形态过去会让整个 `tools/call` 失败）、一次超时、一次后台运行，以及用 Python 自己的 `nbformat.validate` 校验它写出的文件。`pnpm check:package` 断言发布包的形状（不含编译后的 Python、不含源码、不含测试文件、不含临时脚本），并用一套常驻的变异矩阵证明它自己的判断力。发布之前，`pnpm check:release` 会打包 tarball、装进空目录，并用真实 stdio 驱动**装好的**二进制（六个工具、一个真 kernel、一次真执行、干净退出）——这是"所有仓库门禁都绿、发布却仍可能搞砸"的那一步。

单元与集成测试共用**系统临时目录**里一个专用 venv（绝不在仓库内；用 `IPYNB_TEST_VENV` 可改位置），并且永不触碰你自己的解释器。单元测试也用它，因为它的分析器用例会启动真实 sidecar——这也是两个套件都串行跑文件的原因。把 `IPYNB_TEST_PYTHON` 指向一个已装 `ipykernel` 的基础解释器即可。不是本套件创建的 venv 永不被删除；它用不了的 venv，也只有在本套件创建时才被移除。

**安全：kernel 继承了什么。** sidecar 及其启动的 kernel 会继承本服务的**完整环境**（`PATH`、`HOME`、代理、token——任何你的 MCP 客户端传进来的东西），被执行的 cell 能读到它。kernel 进程也不以任何方式沙箱化：`notebook_run` 会以你的用户权限执行 notebook 里写的一切。请把 `--root` 指向你愿意让 agent 写入的目录，并只运行你愿意执行的 notebook。

实现遵循仓库中冻结的规格 [SPEC.md](./SPEC.md)；每一处偏离都记录在 [docs/DEVIATIONS.md](./docs/DEVIATIONS.md)。

## 许可证

MIT——见 [LICENSE](./LICENSE)。

> 本文是 [README.md](./README.md) 的中文版。若两者出现出入，以英文版为准。
