# ipynb-mcp 代码审查报告（第八轮 / v8）

> **审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp` @ HEAD `0af7f20`（v7 整改后，**8 个提交 / 38 文件 / +1695 −170**；工作树**干净**）
> **上轮基线**：`1209164`（v7 报告已归档为 `docs/review/ipynb-mcp-code-review-v7.md`）
> **方法**：主审亲跑六道门禁 + **用 v7 全部原探针复跑** + **新增 8 形状投影矩阵与真实 kernel cell 复现** + 磁盘/产物/文档核对 + 两路独立复核（其中"新问题猎取"一路做了 28 形状 × `nbformat` 对照与 5 个变异）
> **日期**：2026-10-04

---

## 〇、先更正我自己

我在这份报告的第一版里给了 **A（可直接合并）**，依据是"v7 的条目逐条闭合 + 门禁全绿 + 无新 🔴"。**该结论作废**：子代理用"28 形状 × `nbformat.validate` 对照 + 5 个变异"的方式复核后，我用**真实 kernel cell** 复现出一条 🔴（V8-2：`application/json` 的字符串值被静默改写成数字）与三条 🟠（V8-1 `+json` 一族仍读不回、V8-4 本轮新守卫**不能失败**、V8-9 发布产物带 `.pyc`）。

**我的方法错在哪**：我只复跑了"v7 点名过的那几条"，因此我的探针**天生无法发现同一族的未修分支**（v7 的 V7-1 我测了 `application/json` 的 6 种形状，没测 `+json` 变体与字符串值）。这与前几轮"同一族只修一半"是**同一个失误，只是这次发生在我身上**。教训：复验不能只跑"上轮点名的那一格"，必须跑**等价类**。

---

## 一、门禁实测（主审亲跑）

| 门禁 | 实测 |
|---|---|
| `pnpm typecheck` | exit 0 ✅ |
| `pnpm lint` | 0 警 + `format check: ok` + `structural indent check: ok` ✅ |
| `pnpm test` | **287 passed（25 文件，0 skipped）** ✅ |
| `pnpm test:integration` | **46 passed / 46**，217.8 s，`VITEST_EXIT=0` ✅ |
| `pnpm smoke` | **19/19** ✅ |
| `pnpm build` / `npm pack` | exit 0；**133 文件** ✅（但**清单里有 `.pyc`**，见 V8-9） |
| 工作树 | **干净**（v7 的 `AGENTS.md` 脏状态已提交）✅ |
| CI | `ci.yml:78` 装 `ipykernel jupyter_client **nbformat**`，`:100` 设 `IPYNB_REQUIRE_NBFORMAT: '1'`（缺权威即失败）✅；**子代理用 GitHub API 外部核到两次成功 run**（`0af7f20` → 37144171378、`b49ede4` → 37143775026，各 **9 个 job = 5 unit + 4 integration** 全 success） |

---

## 二、v7 问题闭环核查（**逐条亲验，全部真修**）

| v7 项 | 结论 | 主审证据 |
|---|---|---|
| **V7-1** 读方向 `application/json` | ✅ **但只修了字面量那一支**（见 V8-1/V8-2） | `[1,2,3]`→`value:[1,2,3]`、对象/数字/`null`/`true`/`false`/字符串数组**原样返回** ✓ |
| **P1-a** cell 级负 `execution_count` | ⚠️ **部分**（闸门进了，但**提示的出路是错的** → V8-14） | 编辑 → `selfcheck_failed`（此前静默写出 INVALID）✓；但按提示做 `clear_outputs` **同样被拒**（我实测） |
| **P1-b** 响应 `text` 非字符串 | ✅ 真修 | `text/plain:5` 的 run → `text:""`（字符串） |
| **P1-c** 工作目录连接文件 + env | ✅ 真修 | 仓库根 45→**0**、`tmp*.json` 15→**0**；env 已改 `{...process.env, ...options.env}` |
| **V7-2** `output_truncated` 重复 | ✅ 真修（有残留语义，见 V8-10） | `run.ts:608` 去重 + 引用 §7"只追加一次" |
| **V7-3** fixer/checker 单行 `case` 矛盾 | ✅ 真修 | 两侧共享 `ownsLine`；子代理在 65 个 `.ts` 上跑两遍 `fix-indent` = 0 改动 |
| **V7-4** `install_command` 注入 | ✅ 真修 | `reportedModuleName()` 白名单；注入串与 20 万字符 stdout 均不进命令 |
| **V7-5** 集成 venv 在仓库内 | ⚠️ **部分**（见 V8-5 与 V8-15） | `tests/.venv-test` 实测不存在 ✓（子代理跑 `server.test.ts` 后仍 ABSENT），但五个集成文件仍各写一遍建 venv 逻辑、新 helper 零调用；`README.md:101` 仍写 `tests/.venv-test` |
| **V7-6** PATH 候选丢 not-found | ✅ 真修 | `not-found` 候选给 `reason:'not found'` 且不设 `install_command` |
| **NEW-2** `mode` 的 schema enum | ✅ 真修（端到端） | `mode:'bogus'` → 工具层 `invalid_arguments`（不再是 -32602） |
| **NBFORMAT + CI 权威缺席** | ✅ 真修 | required 模式下**抛错**（硬断言），可选环境显式 skip |
| **三行虚报** | ✅ 逐行订正并标注"第六轮这行是虚报" | 七轮里第一次把虚报本身写进记录 |
| **D-033 / WARN-CODE-2 / TRUNC-CODE / H-7(R3)** | ✅ 已订正/已登记 | 新增 **D-041/D-042（语义借用）、D-043（权威可强制）、D-044（读方向契约）、D-045（R3）** |
| 旧行为无回归 | ✅ | GATE-1 四条语义、GATE-5/CRASH-1、NEW-5 progress、合法值不误伤 —— 全部一致 |

---

## 三、本轮新发现

【V8-2】
严重程度：🔴 阻塞
所在位置：`src/core/outputs.ts:326-335`（`jsonValueOf`：字符串一律 `JSON.parse`）· `:513-521`（降级产出 `kind:'text'`）
问题描述：**`application/json` 的字符串值被静默改写**——盘上是 JSON 字符串，模型拿到的是另一种类型；非 JSON 文本还会被降级成 `text/plain`（**mime 被改写**）。
详细分析（**主审用真实 kernel cell 复现**）：
```
用户 cell: from IPython.display import display; display({'application/json': '123'}, raw=True)
盘上:      {"application/json": "123"}            ← JSON 字符串，nbformat VALID
run 响应:  executed[0].outputs = [{"kind":"json","value":123}]   ← 数字！值被改写
warnings:  []                                     ← 零提示
```
另一格：`{'application/json': 'hello'}` → `{"kind":"text","media_type":"text/plain","text":"hello"}`（mime 被改写）。
机制：v7 把 `rawOutputsOfCell` 改成"盘上值原样带出"（正确），于是"字符串必然是 JSON 文本"这个**旧前提失效**，而 `jsonValueOf` 仍无条件 `JSON.parse(value)`。nbformat 对 json mime 不限类型，`"123"`/`"hello"` 都是合法值。
**这与 v7 的 V7-1（`[1,2,3]`→`123`）是同一类缺陷、同一处代码**：可复现、静默、给模型错误数据，触发者是普通用户 cell。
修复建议：区分"盘上的值"与"侧车传来的 JSON 文本"。最简做法——`mapRawOutputs` 对 json mime 的**字符串**值直接产出 `{ kind: 'json', value: <string> }`（因为侧车路径的值早已是解析好的 JSON 类型，只有手写/历史文件才可能是字符串，而按 nbformat 那正是"JSON 字符串"）；若坚持解析，至少降级时把原 mime 与依据写进 message。
设计文档对齐：SPEC §5.4 第 7 行、§6 R2「不静默改坏」、D-044（本轮登记"读方向已兑现 json 契约"——**实际只兑现了非字符串那一半**）。

【V8-1】
严重程度：🟠 严重
所在位置：`src/core/outputs.ts:513`（只判 `data['application/json'] !== undefined`）vs `:114/:236`（写侧用 `isJsonMime`）
问题描述：`application/<x>+json` 一族在**盘上合法保留**，但在响应里一律变成 `unsupported`（且无提示、无覆盖）。
详细分析（**主审实测**，文件经 `nbformat.validate` 判 VALID）：`application/x+json:{a:1}`、`application/x/y+json:[1,2,3]`、`application/+json:42`、`application/vnd.custom+json:{k:v}` → 全部 `{"kind":"unsupported","mime_type":"…"}`；对照组 `application/json:{a:1}` → `{"kind":"json","value":{"a":1}}`。
**我不同意子代理把它定为 🔴**，理由是 SPEC §5.4 的匹配表（`SPEC.md:666`）写的是**精确键** `data['application/json']`，而 SPEC 第 41 行明确要求 widget 类 `application/vnd.jupyter.widget-view+json` **降级为 `unsupported`** —— 所以"只有字面量映射为 json"是 SPEC 的规定，投影本身合规。真正的问题有三点：① **同一文件里两套 json 判定**（写侧 `isJsonMime` 管 nbformat 合法性、读侧字面量管投影），没有任何注释解释这是有意为之；② 合法数据"写在盘上、模型看不见"且**不给任何线索**；③ **零测试覆盖**——子代理的变异 M4（把 `JSON_MIME` 退回 v7 的过严正则）**54 passed 全绿**，证明这一族没有任何守卫。D-044 的措辞（"读方向已兑现 json 契约"）因此**超出实际**。
修复建议：短期在 `:513` 附近加注释说明"投影按 §5.4 精确键、写侧按 nbformat 语义"，并给 `unsupported` 的 message 带上"值已保留在文件中"；中期由 SPEC 裁决是否把 `+json` 纳入 `kind:"json"`。无论哪条，先补用例（`+json` 变体）。
设计文档对齐：SPEC §5.4 第 7 行 + 第 41 行、D-044（措辞需收窄）。

【V8-4】
严重程度：🟠 严重（验证能力）
所在位置：`tests/unit/run-reporting.test.ts:142-163`（V7-2 去重）、`:165-177`、`:179-187`、`:189-196`、`:198-203`；`tests/unit/outputs.test.ts:483-563`（`LEGAL` 矩阵只含 `application/json`）
问题描述：本轮新增的两条"守卫"**不能失败**——一条在测试自己的局部数组上重演产品逻辑，两条直接断言**源码文本**；因此它们无法发现 V8-1/V8-2/V8-3。
详细分析（子代理在 `%TEMP%` 副本上做的 5 个变异，我已核对代码形态）：
| 变异 | 期望 | 实测 |
|---|---|---|
| **M1** 删掉 `run.ts` 的 `output_truncated` 去重守卫 | 红 | **11 passed 全绿** |
| **M4** `JSON_MIME` 退回 v7 过严正则 | 红 | **54 passed 全绿** |
| M2 去掉 `rawOutputsOfCell` 的 json 直通 | 红 | 红 ✅ |
| M3 `jsonValueOf` 恢复"字符串必 parse" | 红 | 红 ✅（但它守的是 v7 已修的路径） |
| M5 删掉 cell 级 `execution_count` 闸门 | 红 | 红 ✅ |
机制：`:146-162` 全程在测试自己的 `warnings` 数组上重演 `if`，从未调用产品代码；`:171-176`/`:181-186` 是 `expect(source).toContain('warnings:')` 这类**源码字符串断言**（把代码挪进注释仍绿）；`:198-203` 与标题声称的连接文件无关。
**值得记一笔**：这些用例出现在"修 P0-a（权威静默跳过）"的同一个提交里——**用不可失败的守卫去证明另一个"守卫不会静默"的修复**。
修复建议：把 `collectWarnings()` 抽成 core 的纯函数直接测（或走真 `runNotebook` 的失败/超时路径）；删掉源码字符串断言与 `:198-203`；`LEGAL` 矩阵补 `+json` 变体、data-URL、字符串 json 三条（每条都先红后绿）。
设计文档对齐：AGENTS §9「不许 mock/绕过被测逻辑」+ 本轮新写的"守卫必须自证能失败"。

【V8-5】
严重程度：🟠 严重（死代码 + 文档与事实相反）
所在位置：`tests/integration/test-venv.ts:45-50`（`usableInterpreter`，注释自称"Callers used to check `existsSync(TEST_VENV_PY)` on its own"）vs `kernel.test.ts:53-54`、`run.test.ts:66`、`locked-file.test.ts:47-49`、`server.test.ts:35`、`stale.test.ts:24`
问题描述：V7-5 的修法本应是"抽一个共享 helper，六个集成文件统一"，实际**只搬了常量**；建 venv/判可用/回退 base 仍是**五份重复**，而新写的 `usableInterpreter`/`canImport` **零调用**（**主审实测**：全仓 `usableInterpreter` 只有 1 处命中 = 定义处；五个文件仍各自 `existsSync(VENV_PY)` + `execFileSync(BASE_PYTHON, ['-m','venv',…])`）。
详细分析：文件头注释描述的规则（"一个模块决定它，套件就不能再和文档悄悄不一致"）与实际结构不符；`COMPATIBILITY.md` 关于"该文件现在只有一个解释器决策"的表述同样超前。
修复建议：把 `prepareVenv()`（建 + 标记 + 校验 + 回退，含 TST-1 语义）真正下沉到 `test-venv.ts`，五个文件只调它；或删掉死函数并把注释改成事实。
设计文档对齐：AGENTS §4/§9、v7 V7-5 的要求。

【V8-9】
严重程度：🟠 严重（发布产物）
所在位置：`python/__pycache__/ipynb_sidecar.cpython-310.pyc`（被 `.gitignore:23` 忽略，但**未被 `package.json` 的 `files` 排除**）
问题描述：**npm 产物里带着 Anaconda 3.10 编译的 sidecar 字节码**。
详细分析（**主审实测**）：`npm pack --dry-run` 的 133 项清单里 `python/` 下恰好两项——`python/__pycache__/ipynb_sidecar.cpython-310.pyc` 与 `python/ipynb_sidecar.py`；`.npmignore` 不存在。子代理进一步核出该 `.pyc` 头部的 mtime/size 与源码**完全一致**，因此 CPython 的 vintage 检查会**优先使用这份字节码**——发布产物里出现"与源码等价的编译副本"是典型的隐患（源码改动若 size 恰好不变，用户可能跑到旧字节码）。
修复建议：`files` 改为 `["lib", "python/*.py", "README.md", "LICENSE"]`（或加 `"!python/__pycache__"`）；CI 的 pack 校验里断言产物不含 `.pyc`；本机删掉 `python/__pycache__`。
设计文档对齐：SPEC §8（发布产物）、AGENTS §1（不装 Python 包、零服务）。

【V8-3】
严重程度：🟡 警告
所在位置：`src/core/outputs.ts:435-437`（data-URL 直接 `atob` 失败 → `decoded === null`）、`:446-468`（产出 `bytes:0 / artifact_path:null`）
问题描述：`image/png` 取 data-URL 形式时，盘上原样保留，响应里变成**零字节图片**且不落 artifact，只有一条笼统的 `image_materialize_failed`。
详细分析（**主审实测**）：`{'image/png': 'data:image/png;base64,iVBOR…'}` → `kind=image mt=image/png bytes=0 artifact=null idx=null` + 警告；对照组纯 base64 → `bytes=70` + artifact 路径 + `idx=0` ✓。
**我把它定为 🟡 而非 🟠**：nbformat 的 `image/png` 只要求字符串，data-URL 前缀**Jupyter 自己也渲染不了**（`base64.b64decode` 会失败），所以这不是"合法数据被吞"，而是"无效值 + 诊断太含糊"。值得改：解码前剥 `data:<mime>;base64,` 前缀（对用户更友好），或至少在 message 里点明"data-URL 前缀未处理"；并补一条 data-URL 的写→读往返用例。
设计文档对齐：SPEC §4.4（物化 = 返回图片块同一事件）、§6 R2。

【V8-6】
严重程度：🟡 警告
所在位置：`python/ipynb_sidecar.py:84-95`（`ORPHAN_CONNECTION_AGE_SECONDS = 3600`）、`:98-126`（`sweep_orphan_connection_files`）、调用点 `:570-574`（**只在启动时**）
问题描述：清扫用"mtime 早于 1 小时"当"不可能属于活 kernel"的判据——但**一个已运行超过 1 小时的 kernel**，其连接文件的 mtime 就是创建时刻，会被下一个新起的 sidecar 扫掉；反之，被硬杀留下的文件若此后没有新 sidecar 启动，会**永久**躺在 `%TEMP%`（子代理实测：18:03 的历史文件 >30 min 从未被清理）。
详细分析：清扫的**收窄**做得对（只匹配 `ipynb-mcp-` 前缀 + `.json`、只在解释器的临时目录、失败不致命、有日志），我确认它**不会误删无关文件**。问题在判据：注释写"cannot belong to a live kernel"，实际成立的是"不可能属于**刚启动**的 kernel"。影响有限（已建立的连接不依赖该文件），但文件名里**已带 pid**，有一条确定性判据可用。
修复建议：`os.kill(pid, 0)` 判活（pid 不存在即可删），年龄只作兜底；`shutdown_all` 之后再扫一次；`send_log` 复用已解析的 `temp_dir`。
设计文档对齐：SPEC §6 R19（不留孤儿）。

【V8-7】
严重程度：🟡 警告（架构边界）
所在位置：`python/ipynb_sidecar.py:98-126`（新增 `os.listdir` + `os.unlink`）；`AGENTS.md:116`（§4 模块铁律：`python/*.py` **禁止读写用户文件**，唯一例外是它自己 kernel 的 connection file）；`docs/DEVIATIONS.md` 只有 **D-023**（2026-10-02，覆盖"自己的连接文件"）
问题描述：清扫是本轮新增的**第一处**"sidecar 主动遍历目录并删除**不是自己创建**的文件"的代码，属边界扩张，但**未登记 DEVIATIONS**。
详细分析：**主审核对**：`DEVIATIONS.md` 里与清扫/unlink 相关的条目只有 D-023（那条讲的是"sidecar 需要写自己的连接文件"），D-041~D-045 均未覆盖"清扫他人遗留文件"。
修复建议：二选一——① 在 DEVIATIONS 登记"仅限本工具前缀 + 自身 temp 目录 + 永不影响内核启动"（并说明为何放在 Python 侧）；② 把清扫移到 Node 的 `fs/` 层（天然合规，且能用 pid 判定，见 V8-6）。
设计文档对齐：AGENTS §4/§6 红线、SPEC §5.8。

【V8-8】
严重程度：🟡 警告
所在位置：`scripts/linux-check.sh:20-33`（`case "$WORK" in /tmp/*|/var/tmp/*|"$HOME"/tmp/*)`）
问题描述：守卫用**未归一化**的前缀匹配，`WORK="/tmp/../etc"` 能通过，随后 `rm -rf "$WORK"` 由内核沿 `..` 解析到 `/etc`。
详细分析（子代理在 WSL 实测）：`GUARD-ACCEPT: /tmp/../tmp/ipynb-..-probe` → `rm -rf` 后目录**确实被删除**；`WORK=/`、`/tmp`、`var/tmp`、`$HOME`、`/home/x/notebooks` 全部 REFUSE（这部分是对的）。可达性低（需要显式设一个带 `..` 的 `WORK`），但守卫存在的唯一理由就是防这一类。
修复建议：`WORK=$(readlink -m -- "$WORK")` 之后再跑同一组 `case`，并拒绝含 `..` 的原始值。
设计文档对齐：v7 V7-13 的修复意图、AGENTS §6 R5。

【V8-10】
严重程度：🟡 警告
所在位置：`src/run.ts:552-557`（drop 先 push）、`:608-613`（截断被 `some()` 去重）；`docs/DEVIATIONS.md` D-042
问题描述：两个**不同事实**（有值被丢 / 有输出被截断）共用一个码，且"drop 优先"——真正发生截断时截断提示会消失，反之亦然。
详细分析：V7-2 的"2–4 条同码"确实修好了（真机只 1 条），但去重优先级让"同时发生"时的可见性退化。D-042 只登记了"含义借用 + 只追加一次"，未解决这一点。
修复建议：闭集前提下让**一条** message 同时承载两个计数（`dropped N value(s) …; M output(s) truncated`），或在 D-042 明确"drop 优先"并把优先级写进 §7 的边界段。
设计文档对齐：SPEC §7 `output_truncated` 行 + 边界段、U21b。

【V8-11】
严重程度：🟡 警告
所在位置：`tests/integration/run.test.ts:912/950/961/983`（用 `VENV_PY` 问 nbformat）vs `:72-81`（`canStartKernel(VENV_PY)` 失败时回退 `BASE_PYTHON`）；`nbformat-validator.ts:80-86`（required 模式抛错）
问题描述：同一文件承认"venv 可能起不了 kernel 且已回退 base"，但外部权威仍固定去问 `VENV_PY`。设 `IPYNB_REQUIRE_NBFORMAT=1`（CI 就这么做）后，只要 venv 缺 nbformat 或不存在，`nbformatSkipReason` 就**抛异常让整个文件失败**——即使 base 有 nbformat、run 用例都在 base 上跑得好。这是"环境问题伪装成产品失败"，与 TST-1/`I15` 那三次同族。
修复建议：把 `VENV_PY` 换成**实际使用的解释器**（`sidecarInterpreter` 或 `usableInterpreter([...SIDECAR_REQUIRED_MODULES, 'nbformat'])`），并在 message 里带上实际路径。
设计文档对齐：SPEC §9 CI 矩阵、v7 P0-a 的可执行性要求。

【V8-12】
严重程度：🟡 警告
所在位置：`tests/unit/analyze-op.test.ts:151-161/187-193/209-211`（建 venv + `afterAll(removeOwnedVenv)`）vs `tests/integration/test-venv.ts:17-18`（`TEST_VENV_DIR` 现在全局共用）
问题描述：`TEST_VENV_DIR` 变成全局共享目录后，单测侧在同一路径上"建→用→删"，而**单测配置没有 `fileParallelism:false`**（`vitest.integration.config.ts:7` 有）。并行跑 `pnpm test` 与 `test:integration` 时会出现"集成 `existsSync` 看到 venv → 单测 `afterAll` 删掉 → 集成 `execFileSync(VENV_PY)` ENOENT"的窗口；顺序跑则每次都白重建 18 MB。
修复建议：把 venv 的所有权/生命周期下沉到 `test-venv.ts`（refcount 或"只有未显式指定 `IPYNB_TEST_VENV` 且带 marker 才删"）；或让 `analyze-op` **不删**，交给 `tmpdir` 自然回收；并给单测配置也加 `fileParallelism:false`。
设计文档对齐：AGENTS §9、v7 V7-14 的修复意图。

【V8-14】
严重程度：🟠 严重（新引入的可用性陷阱：被推荐的出路自己也被拒）
所在位置：`src/core/parse.ts:321-325`（cell 级计数检查）· `src/core/edit.ts:320-321`（`clear_outputs` 只清 outputs）· `src/mcp/tools/edit.ts` 的 hint 文案（`parse.ts:200` 附近的通用 hint）
问题描述：P1-a 修好之后，拒绝的 `detail.hint` 推荐"`clear_outputs` or `set_cell_type` removes it"，但 **`clear_outputs` 自己也被同一条规则拒绝**——于是含负 `execution_count` 的 notebook 事实上**只有 `set_cell_type` 一条出路**，而模型会按提示反复尝试被拒的那条。
详细分析（**主审实测**，同一次会话四个操作）：
```
1. replace_source on the negative-count cell -> selfcheck_failed rule=execution_count_negative
                                               hint="…clear_outputs or set_cell_type removes it"
2. clear_outputs on the SAME cell           -> selfcheck_failed rule=execution_count_negative   ← 推荐的做法失败
3. set_cell_type -> markdown (with anchor)  -> applied=1 ✓（markdown cell 不能带 execution_count，故被删除）
4. replace_source on the OTHER cell         -> applied=1 ✓（对照：无关编辑正常）
```
根因：`clear_outputs` 只清 `outputs`、**不重置 `execution_count`**，而该 cell 因被改写而进入 scope → 仍被审。注意这与 v6/v7 那个"`clear_outputs` 能解除 `output_metadata_missing`"的设计**不冲突**——那一类问题在被清的 outputs 里，这一类在 cell 级字段上；但 **hint 是通用文案**，对这一条规则就是错的。
影响：① 模型会按提示循环（"清空输出"→被拒→再试），正是 SPEC §4.1.11"编辑失败必须一次可重试"要避免的；② 状态表给 P1-a 打了 ✅ 但未提这一点；③ 与 `tests/unit/edit-tool.test.ts` 里 v6 写下的设计声明"闸门不惩罚一个刚刚修好问题的写入"矛盾。
修复建议（择一，建议前两条一起）：① `clear_outputs` 顺手把 `execution_count` 归一为 `null`（清输出本就把"计数"这件事作废，且 SPEC §4.5 对 `clear_outputs` 的写规则是"清 outputs"，把它降级为 warning 更符合意图）；② 让 hint 按规则生成（`execution_count_negative` 只提 `set_cell_type`，`output_*` 类才提 `clear_outputs`）；③ 补一条用例：负计数 → `clear_outputs` 必须成功且文件转为 VALID。
设计文档对齐：SPEC §4.5（`clear_outputs` 的写规则）、§4.1.11（失败一次可重试）、D-037 ② 的意图。

【V8-1 补充：这个行为被测试**反向钉死**，且文档过度声明】
- `tests/unit/outputs.test.ts:130,136` 断言 `application/vnd.foo+json` → `unsupported`。也就是说：即使将来决定把 `+json` 纳入 `kind:"json"`（按 nbformat 语义），**改 read 分支会让套件变红**——当前行为被测试锁在"unsupported"这一侧。
- `docs/REVIEW-FIX-STATUS.md:47` 写"`application/x/y+json`、`application/+json` 此前被丢/拒" ✅，`docs/DEVIATIONS.md:50`（D-044）写"`application/json`（**及 `+json`**）的 mime 值在读方向原样保留"——**两条均与实测不符**（我在 §三 V8-1 里给的四组测量：全部 `unsupported`）。D-044 的措辞需收窄为"字面量 `application/json`"。
- 附带（我认为**不是**问题，记录以免误判）：字符串值 `"plain json string"` 降级为 `{"kind":"text"}`、`"{\"k\":1}"` 解析为 `{"kind":"json"}`——这与 SPEC §5.4 第 7 行"解析失败降级为 text"的字面一致；但 V8-2 的 `"123"` → `123` **不是降级而是值变型**，两者要分开看。

【V8-15】
严重程度：🟡 警告（文档与代码相反）
所在位置：`README.md:101`（仍写 "Integration tests create a dedicated venv (`tests/.venv-test`, system-site-packages)"）vs `tests/integration/test-venv.ts:17-18`（`IPYNB_TEST_VENV ?? tmpdir()/ipynb-mcp-test-venv`）、`CHANGELOG.md:41`、`docs/COMPATIBILITY.md:39`
问题描述：venv 落点已真正移出仓库（**主审实测**：跑完 `server.test.ts` 后 `tests/.venv-test` **不存在**），但 README 仍写它建在 `tests/.venv-test`——三处文档里两处对、一处错，而错的那处正是**面向用户**的 README。
另一处同类：`tests/unit/analyze-op.test.ts` 的注释声称 venv "在 afterAll 清理"，而 `removeOwnedVenv()` 实测是**空操作**（跑完单测 `%TEMP%\ipynb-mcp-test-venv` 仍在）。当缓存保留可以接受，但注释与行为相反。
修复建议：README 改为"测试 venv 落在系统临时目录（可用 `IPYNB_TEST_VENV` 覆盖）"；`analyze-op` 的注释改成"保留作缓存；不健康时才重建"。
设计文档对齐：AGENTS §2（README 必须如实）、§9。

【V8-16】
严重程度：🟡 警告（同一文件内自相矛盾）
所在位置：`docs/REVIEW-FIX-STATUS.md:131`（v5 对照表仍写"NEW-6 … **本轮修复**：只在 transport 确实失联时附带，超时路径不再无条件附加"）、`:133`（同表仍写"NBFORMAT … 用 `it.skip`"）
问题描述：本轮把 v6/v7 段的三行虚报订正了（并在正文里标注"第六轮这行是虚报"），但**同一文件更早的 v5 对照表里那两行旧 ✅ 没有撤回**——于是读者在同一份文件里能读到互相否定的记录：一处说"NEW-6 本轮修复"，另一处说"NEW-6 仍未收口：第六轮这行是虚报"。
修复建议：在 `:131/:133` 行尾加"（已撤，见第七轮段）"或直接改成 ⬜；这与 v3 段已经做过的处理保持一致即可。
设计文档对齐：状态表头部自己定的"未做/未验证一律标 ⬜/⚠️，不再标 ✅"。

【V8-17】
严重程度：🟢 建议
所在位置：`scripts/check-indent.mjs` 的 switch 子句守卫；`scripts/check-indent.mjs` 的 SELF-TEST
问题描述：把 switch 子句的 `if (ownsLine(text, where))` 改成 `if (true)`，`check-indent` **仍 exit 0**（自测不红）——因为该守卫在"合法形状"上恒真（同行语句的起始列恰等于 `caseColumn`）。也就是说这一条守卫**不可变异证伪**；真正的判别力来自同行语句的**起始列**比较（子代理用"case 行缩进 6 / case 体缩进 8"两条实测证明 checker 会报、fixer 会修 ✓）。
修复建议：把它标注为"形状标记"而非守卫（或删掉，让起始列判定独立成立）；自测矩阵里补一条"case 与语句同行但起始列错"的样例，让判别力可被变异验证。
设计文档对齐：AGENTS §9（守卫必须自证能失败）。


【V8-13】
严重程度：🟢 建议
所在位置：多处（卫生）
- `src/fs/atomic.ts:209-216`：V7-11 合并 `errnoCode`/`lockErrno` 时**残留了旧 doc 注释**（两条相邻块注释指向同一函数）。
- `src/fs/notebook-file.ts:270-271`：文件末尾两个空行。
- `src/run.ts:558` 附近：空行 + 缩进异常（`check-indent` 只查块缩进，不报）。
- 仓库根三个探针脚本被跟踪（`patch-nbformat.mjs`、`probe-v7-1.mjs`、`probe-v74.mjs`），全仓**零引用**；**我已实测它们不在 npm 产物里**（133 项清单无 `probe-*`/`patch-*`），所以只是仓库卫生（同类第四次）。
- `tests/unit/run-reporting.test.ts:198-203` 与连接文件无关（见 V8-4）。
修复建议：删旧注释与空行；三个探针脚本移入 `scripts/probes/` 并登记用途，或删除（结论已进单测）。

---

## 四、七个审查维度逐条覆盖

**1. 架构与模块对齐** —— 1 项（V8-7）
写侧（`core/parse.ts` 的 `isJsonMime` 用于 nbformat 合法性）与读侧（`core/outputs.ts:513` 的字面量用于 §5.4 投影）承担**不同问题**却长得像同一件事，缺少注释解释；V8-7 是新引入的架构边界扩张（sidecar 开始删文件）且未登记。其余：`core/*` 未 import `node:*`、`mcp/*` 未碰 `node:fs`、可变状态仍只在 registry/run-store。

**2. 代码质量与可维护性** —— 3 项（V8-4 自重言式测试、V8-5 死 helper、V8-13 卫生）
正面：`mode` 的两层不一致被彻底消除、`ownsLine` 在 fixer 与 checker 间共享同一判据、`reportedModuleName` 用白名单替代回显、连接文件清扫的注释把"为什么这样收窄"写得清楚。
负面：`usableInterpreter` 零调用而注释宣称集中化；`run-reporting.test.ts` 的"源码字符串断言"是典型的假守卫；三处注释/空行残留。

**3. 健壮性与错误处理** —— 3 项（V8-2 🔴、V8-3、V8-6）
读方向对**字符串形式的 json 值**仍会改写（V8-2）；data-URL 图片的降级路径没有把"盘上是 data-URL"告诉模型（V8-3）；清扫判据可能在活 kernel 上动手（V8-6）。其余（P1-a/P1-b 的契约收窄、拒绝时自证身份、终态唯一写者）均已验证正确。

**4. 性能与资源效率** —— 未发现明显问题
分帧仍线性且有用例守着；`#normCache` 记忆化；清扫只在启动跑、不在热路径；本轮 `+112` 的 `outputs.ts` 改动是纯投影逻辑（无新增同步 I/O）。

**5. 安全性** —— 2 项（V8-9 产物带 `.pyc`、V8-8 `..` 绕过）
`install_command` 注入已关闭 ✓、连接文件不再堆在工作目录 ✓、CI 强制权威 ✓。新增两点：产物里带了与源码 mtime/size 完全匹配的 `.pyc`（发布卫生 + 潜在"跑旧字节码"）；`linux-check.sh` 的 `WORK` 守卫可被 `..` 绕过。
**另有一条周边风险**（子代理指出，我认同并转述）：env 现在是**完整 `process.env`** 交给 sidecar→kernel→被执行的 cell——这是标准行为，但扩大了"被执行的代码可读环境变量（含 token）"的面，建议在 README 的安全声明里点一句。

**6. 测试覆盖与自测质量** —— 3 项（V8-4、V8-5、V8-12）
正面：单测 **287**（+35）、集成 46、CI 现在会因缺 `nbformat` 而失败（**这是七轮里对验证能力最实质的一次修补**）、`fix-indent` 幂等性经 65 文件双跑验证、工具层真写 markdown 守卫补齐。
负面：**本轮新增的两条守卫不能用变异证伪**（M1/M4 全绿）→ 恰好是 V8-1/V8-2/V8-3 能活下来的原因；`usableInterpreter` 零调用；共享 venv 的删除时机有并行窗口。

**7. 依赖与配置** —— 1 项（V8-9）
运行期依赖仍只有 SDK（零新增）、`prepack` = `tsc`、CI 矩阵与文档一致、`pnpm/action-setup` 仍不带 `version:`（DEP-6 保持）。唯一问题是 `files` 未排除 `python/__pycache__`。

---

## 五、总体评估

### 1. 整体质量评级：**C（需返工）**

**为什么不是 A（更正我自己的初判）**：存在一条**已用真实 kernel cell 复现**的 🔴（V8-2：合法 json 字符串被静默改写成另一种类型，零 warning），它与 v7 的 V7-1 同族同处；另有 **6 条 🟠**——V8-1（`+json` 一族写得进读不回、被 `outputs.test.ts:130/136` **反向钉死**、两处文档过度声明）、**V8-14（新引入的可用性陷阱：拒绝提示推荐的 `clear_outputs` 自己也被拒，只有 `set_cell_type` 有效）**、V8-4（本轮新守卫不能失败，M1/M4 变异全绿）、V8-5（`usableInterpreter` 零调用而文档称已集中化）、V8-9（发布产物带 `.pyc`）、V8-15（README 仍写 `tests/.venv-test`，而代码已移出）。

**为什么不是 D**：本轮把 v7 的**全部**条目真修了（我逐条亲验，含 P1-a/P1-b/P1-c/NEW-2/CI 硬断言/三行虚报订正/D-041~D-045 登记），并新增 35 条单测；问题集中在**"同一族的未修分支"与"新守卫不具备判别力"**——都是小改动，不需要返工架构。

**这一轮留下的最重要教训（对我也是对实现者）**：v7 的 V7-1 修好之后，**我的复验只跑了 v7 点名的那一格**（`application/json` 的 6 种形状），没跑等价类（`+json` 变体、字符串值）；实现者的新用例**同样只覆盖那一格**。于是"同一条缺陷只修一半 + 守卫无法证伪"这对组合又活了一轮。**结论：修完一条缺陷后，必须按等价类补一张矩阵，并用变异证明新守卫能红。**

### 2. TOP 3 必须优先修复

| # | 事项 | 为什么 | 修复量 |
|---|---|---|---|
| 1 | **V8-2（🔴）+ V8-1（🟠）**：`outputs.ts:513` 用 `isJsonMime` 找键、字符串值原样产出（或标记来源）；同时给 `unsupported` 的 `+json` 情况带上"值已保留在文件中"的提示 | 前者是静默给错数据（真实 cell 可触发）；后者是合法数据模型看不见且零覆盖。**改法都在同一处，且必须先补 V8-4 的用例** | 小（10 行内 + 用例） |
| 2 | **V8-14（🟠）**：`clear_outputs` 顺手把 `execution_count` 归一为 `null`（或让闸门把"刚清空 outputs 的 cell 的负计数"视为已修），并让 hint **按规则生成**（`execution_count_*` 只提 `set_cell_type`） | 这是**新引入的可用性陷阱**：模型被推荐的做法**自己也被拒**，只能靠另一条它没被告知/需要锚的操作脱困——正是 SPEC §4.1.11"失败必须一次可重试"要避免的循环；且与 v6 写下的"闸门不惩罚一个刚刚修好问题的写入"矛盾 | 小（3–5 行 + 1 条用例） |
| 3 | **V8-4（🟠）**：`run-reporting.test.ts:142-203` 换成真行为断言（抽 `collectWarnings()` 到 core 直接测，或走真 run 的失败/超时路径）；删掉源码字符串断言与 `:198-203`；`LEGAL` 矩阵补 `+json`/data-URL/字符串 json 三条 | 这两条"守卫"是本轮唯一声称覆盖 V7-2/P1-c 的东西，而它们**不能失败**（M1/M7 变异全绿）；不修就等于下一轮还会出现"改了一半没人发现" | 小-中 |
紧随其后：**V8-9**（`files` 排除 `python/__pycache__` + CI 断言产物不含 `.pyc`，5 分钟）→ **V8-15**（README:101 与 `analyze-op.test.ts` 的注释改成事实）→ **V8-16**（撤回 `REVIEW-FIX-STATUS.md:131/:133` 里被证伪的旧 ✅）→ **V8-5**（真正下沉 `prepareVenv()` 或删死函数）→ **V8-11 / V8-12**（权威问对解释器、共享 venv 的删除时机）→ **V8-6**（清扫改 pid 判活 + shutdown 后再扫；文档写明硬杀后滞留上界）→ **V8-7**（登记 sidecar 边界扩张，或把清扫移到 `fs/`）→ **V8-8**（`readlink -m` 归一化后再判）→ **V8-10**（一条 message 承载两个计数）→ **V8-3**（data-URL 前缀与提示）→ **V8-17 / V8-13**（守卫可证伪性标注、旧注释与空行、三个探针脚本）。

### 3. 与原始设计文档的偏离清单

| 偏离 | 性质 | 状态 |
|---|---|---|
| 读方向只把 `application/json` 字面量映射为 json（`+json` → unsupported） | **与 SPEC §5.4 + §41 行一致**（不是偏离），但 D-044 的措辞"已兑现 json 契约"超出实际 | 🟠 收窄措辞 + 补注释 |
| json mime 的**字符串**值被 parse 成别的类型 | 违反 SPEC §5.4 第 7 行与 §6 R2 | 🔴 V8-2 |
| **拒绝提示推荐的补救操作自己也被拒**（`clear_outputs` vs `execution_count_negative`） | 违反 SPEC §4.1.11"失败一次可重试"与 D-037 ② 的意图 | 🟠 V8-14 |
| 执行路径丢弃 nbformat 存不下的值 | 已登记 D-040 | ✅ 保持 |
| 复用 `file_changed_externally` / `output_truncated` | 已登记 D-039/D-041/D-042 | ✅ 留档（V8-10 建议补优先级） |
| 外部权威必须可强制 | 已登记 D-043，已实现 | ✅ |
| **sidecar 主动清扫并删除非自己创建的文件** | **AGENTS §4/§6 的边界扩张，未登记** | 🟡 V8-7 |
| 发布产物 `files` 未排除 `python/__pycache__` | 与 SPEC §8 的发布意图不符 | 🟠 V8-9 |
| `SelfCheckScope` 缺省 = 整份文档 | 保留给创建场景，两处调用点显式传入 | 🟢 已给理由 |

### 4. 后续开发建议

- **把"等价类矩阵"变成硬规则**（与 AGENTS §9 的"守卫必须自证能失败"配套）：每次修一条数据形状缺陷，必须同时补一张"该 mime/该字段的**全部合法类型**"矩阵，并对每个矩阵项做一次"先红后绿"。v7→v8 的教训完全出在这一点上。
- **发布前两件事**（与上一轮相同，仍未做）：① **E1–E9 真实第三方客户端**；② **`pnpm smoke` 纳入 CI**（19/19 目前只是本机）。
- **发布产物检查纳入 CI**：`npm pack` 后断言"不含 `.pyc`、不含 `probe-*`/`patch-*`、含 `lib/bin.js`（shebang）与 `python/ipynb_sidecar.py`"——V8-9 说明产物内容目前没有任何守卫。
- **README 安全声明补一句**：sidecar 与 kernel 继承完整 `process.env`（含用户的 token/密钥），被执行的 notebook 代码因此可读到它们。
- **代码卫生**：把仓库根的三个探针脚本移入 `scripts/probes/` 或删除；给 `.gitignore` 补 `probe-*`/`patch-*.mjs`（同类已第四次）。

---

## 附录：验证分工与局限

- **主审亲验（一手证据）**：六道门禁实跑（typecheck/lint/**287 passed、0 skipped**/integration **46/46**/smoke **19/19**/build/pack **133**）；**v7 全部探针复跑**（scope-test、gate5、progress、legal-mime、json-read、neg-resp、proj）；**新增 8 形状投影矩阵**（`text/plain` 字符串与数组、`text/html`、`text/markdown`、`vendor+json`、未知 mime、image data-URL、`application/json` 对象）；**新增长 v8-check 矩阵**（4 种 `+json` + 字符串 json + data-URL + 纯 base64 对照），并用**真实 kernel cell** 复现 V8-2 与 V8-1；`npm pack` 清单逐项核对（含 `.pyc`）；`mode:'bogus'` 端到端；连接文件与 `tests/.venv-test` 的磁盘核对；`DEVIATIONS`/状态表逐行比对；`usableInterpreter` 调用点核对。
- **子代理复核（两路，**均已完整并入**）**：① **v7 修复的深度核实**（独立 worktree、无 junction）：7 种 json 形状逐条通过、`mimeText()` 收窄、闸门覆盖边界（`2.5`/`"3"` 拦、`0`/`null` 放行）、清扫的直接驱动实测（旧文件删/新文件留/外来文件留）、`[V7-2]` 真 kernel 实测只 1 条 + V7-8 的超时 detail 带 warnings、fixer 逐字节幂等与两条判别力实测、`install_command` 白名单、`not-found` 判定、CI 真跑（GitHub API 两次 run）、三行虚报订正与 D-033 正文、NEW-2、TST-4、`npm pack` 133 与 `PROBE_IN_PACK=[]`；并发现 **P1-a 的补救提示不成立（V8-14）**、`+json` 被测试钉死、README/注释两处与行为相反、`check-indent` 的 switch 守卫不可证伪。② **新问题猎取**：28 形状 × `nbformat` 对照、5 个变异（M1–M5）、两场真 stdio 黑箱、WSL 实跑 `linux-check.sh`（`..` 绕过）、`npm pack --dry-run --json` 与 `.pyc` 头解析。
- **主审独立复现的关键项**：**V8-2**（真 kernel cell：`display({'application/json': '123'}, raw=True)` → 盘上字符串、响应 `value:123`）、**V8-1**（4 种 `+json` + 对照）、**V8-14**（四步会话：replace 拒 → `clear_outputs` 拒 → `set_cell_type` 成 → 无关 cell 成）、V8-3（data-URL vs 纯 base64 对照）、V8-9（**我自己的 `npm pack` 清单里含 `python/__pycache__/ipynb_sidecar.cpython-310.pyc`**）、V8-7（`DEVIATIONS` 只有旧 D-023）、V8-5（`usableInterpreter` 全仓 1 处命中 = 定义）、V8-6（清扫阈值 + 文件名含 pid）。
- **我与子代理的分歧（已按证据裁定）**：① 子代理把 V8-1 定为 🔴，我定为 🟠（SPEC §5.4 是精确键匹配、§41 行要求 widget `+json` 降级，投影合规；真正的问题是零覆盖/无提示/D-044 措辞超前）；② 子代理把 V8-3 定为 🟠，我定为 🟡（Jupyter 自己也无法渲染 data-URL，属无效值 + 诊断含糊）。其余条目我按证据采信。
- **局限**：① 未做 macOS/arm64 与真实第三方客户端（E1–E9 仍是 0/9）；② 我未在干净机器上 `npm i` 后实跑（只核了 pack 清单）；③ `.pyc` 是否会被 CPython 真正采用，我采信子代理的头部 mtime/size 比对，未在用户机上验证；④ V8-8 的 `..` 绕过是子代理在 WSL 实测的，我未复跑（代码形态与判据可核）。
