# ipynb-mcp 代码审查报告（第十六轮 / v16，上线前）

> **审查对象**：`E:\Work\ipynb-mcp\ipynb-mcp` @ HEAD `73df154`（v15 之后 **1 个提交**；工作树干净）
> **上轮基线**：`c11f15a`（v15 报告：1 🔴 V15-1 + 2 🟡/🟢）
> **方法**：主审亲跑门禁 + **复用 v15 的探针全集**（F1 大源码 / F2 错误路径 / F3 非 ASCII）+ 新增 1 组（source 截断的标志位与文案）

---

## 一、门禁（主审亲跑）

| 门禁 | 实测 |
|---|---|
| `pnpm typecheck` | exit **0** |
| `pnpm lint` | **0 warnings / 0 errors** + format ok + indent 28 样例 + docs check ok |
| `pnpm test` | **609 passed / 32 文件**（↑ 607→609） |
| `pnpm smoke` | **26/26** |
| `pnpm check:package` | **ok（144 文件，23 变异）** |

提交：`73df154 fix: the budget must cover the payload's SHAPE, not just its failure paths` —— 逐条对准 V15-1。

---

## 二、v15 阻塞项与回归复验（同一批探针）

### 2.1 V15-1（预算不覆盖 `source`）→ ✅ **真修**

```
v15: read full（12 MiB 源码 + 小输出）→ ✗ McpError -32000: Connection closed
v16: 同一夹具                          → ✓ 422 ms，响应 8.00 MiB，warnings=1，cells=1/cell_count=1
```
交付语义（**新增探针**）：
```
响应 8.00 MiB     source 交付长度 = 8 387 552 字符（盘上 12 583 227 B）
source 尾部 = "…# y# y# y# y# …[truncated to fit the response budget]"
warning[output_truncated] "1 value(s) in `source` shortened (marked `…[truncated to fit the response budget]`) to fit
                           the 8.00 MiB response budget. The notebook still holds every value on disk: read it
                           in parts with `cell_index…`"
盘上未改 = true
```
即：截断在**带内**有标记 ✓、警告**指名对象（`source`）并给出出路**（分批读 + 盘上完整）✓、**盘上原文一字未改** ✓ —— v15 的 V15-2（文案三要素）在这一条上已经兑现。

### 2.2 F2 / F3 回归 → ✅ 无回退

```
F2  run（cell0 12 MiB 输出 + cell1 超时）→ ✓ 8.00 MiB，code=exec_timeout，客户端存活
F3  3 MiB 反斜杠 / 4 M 中文 / 5 M latin-1 / 2 MiB U+0001 → ✓ 全部存活（177–503 ms），warnings=1
```

---

## 三、本轮发现

【V16-1】
严重程度：🟡 警告
所在位置：`src/mcp/render/read.ts` 的 `source_truncated` 赋值 · `src/core/response-budget.ts`（预算对 `source` 的改写路径）
问题描述：**预算把交付的 `source` 截短了，却把 `source_truncated` 留成 `false`** —— 字段与事实矛盾。
详细分析（**主审实测**）：12 MiB 源码的 notebook，`include_source='full'` → 交付 `source` 只有 8 387 552 字符（尾部带 `…[truncated to fit the response budget]`）、盘上 12 583 227 B，而 **`source_truncated=false`、`source_line_count=1`**。按 SPEC §4.1，`source_truncated` 是模型判断"这段源码是不是全部"的**结构化信号**；现在模型若只读该字段，会认为拿到的 12 MiB 源码是完整的。带内标记与警告能补救（本轮已验），但**结构化字段在说谎**——这与 V11-12①（文案必须描述实际交付的载荷）、V14-1（D-065 声称置了标志位而实际只在字符串里加标记）是同一族，且这次是**具体的布尔字段**，比文案更硬。
修复建议：预算截断 `source` 时把 `source_truncated` 置 `true`（并核对 SPEC §4.1 对该字段的定义是否只覆盖 `include_source='preview'` 的情形——若是，则需在 `DEVIATIONS.md` 登记"该字段现在也覆盖预算截断"，因为模型可见语义被扩展了）；补一条断言：**截断后的 `source_truncated === true` 且 `source` 以标记结尾**。
设计文档对齐：SPEC §4.1（`source_truncated`）、§5.4（禁止静默截断）、§7（`output_truncated`）；D-065。

【V16-2】
严重程度：🟢 建议（沿用 v15 未完成项）
① **夹具形状矩阵**（v15 V15-3）：预算用例现已覆盖 source 形状（本轮修的就是它）✓，但仍建议显式列出五形状（大 text / 大 source / 非 ASCII / 转义富集 / 图片）各至少一条，并把这条写进 `AGENTS.md §9`——**v13–v15 四轮漏检全部源于夹具形状太窄**。
② `check-indent` 扩到 `.mjs`（v14 V14-6 第 3 条）仍未做，`scripts/` 15 个文件只受 `check-format` 覆盖。
③ v14 的 F7（`structuredClone` 整载荷深拷贝）与 F6（被预算挡下的图片已物化）本轮我**未逐条复核**（提交标题只说覆盖"形状与失败路径"），若要闭环建议再审一轮 `73df154` 的 diff。

---

## 四、七个审查维度逐条覆盖

**1. 架构与模块对齐** —— 该维度未发现明显问题。修复仍在 `response-budget.ts` 与 render 层，模块边界未破（`core/*` 无 I/O）。
**2. 代码质量与可维护性** —— 1 项（V16-1 的字段赋值，与逻辑同处）。
**3. 健壮性与错误处理** —— 1 项（V16-1）。v15 的唯一阻塞项已修，且**失败路径（F2）与非 ASCII（F3）无回归**。
**4. 性能与资源效率** —— 该维度未发现明显问题。大源码读从 v14 的"永久无响应"到 v15 的"1028 ms 后断连"，现在是 **422 ms 正常返回**。
**5. 安全性** —— 该维度未发现明显问题（盘上保真：读前后字节数一致 ✓）。
**6. 测试覆盖与自测质量** —— 1 项（V16-2②）。单测 +2（607→609），lint 真 0 警。
**7. 依赖与配置** —— 该维度未发现明显问题（144 文件 / 23 变异不变）。

---

## 五、总体评估

### 1. 整体质量评级：**B（小修后合并）**

**为什么是 B**：**v15 的唯一 🔴（V15-1）真修**，且我用同一批探针复验了交付语义（带内标记 + 指名警告 + 盘上完整）；F2/F3 无回归；门禁全绿（609/32、26/26、144+23、lint 真 0 警）。剩下的是一条 🟡（`source_truncated` 字段与事实矛盾）与两条 🟢（夹具矩阵、`check-indent`）。
**为什么不是 A**：我的 A 判据要求"文档与实测一致"，而 V16-1 正是一个**具体的结构化字段在说谎**；另外 v14 的 F6/F7 未闭环、两路复核未在本轮重跑——在这些收敛前不宣称 A。
**为什么不是 C**：没有可达的 🔴/🟠；不再有任何"客户端会话被打死/挂死"的路径（这一点我已用四类夹具逐一验过）。

### 2. TOP 3

| # | 事项 | 修复量 |
|---|---|---|
| 1 | **V16-1（🟡）**：预算截断 `source` 时置 `source_truncated=true`（若 SPEC §4.1 的定义只覆盖 preview，则登记偏离）；断言"截断后该字段为 true 且 `source` 以标记结尾" | 极小（1 处赋值 + 1 断言） |
| 2 | **V16-2①（🟢）**：五形状夹具矩阵写进用例与 `AGENTS.md §9` | 小 |
| 3 | **V16-2③（🟢）**：对 `73df154` 的 diff 做一轮定向复核（F6 图片物化 / F7 深拷贝 / 丢弃文案） | 中（一轮复核） |

### 3. 与原始设计文档的偏离清单

| 偏离 | 状态 |
|---|---|
| 整帧响应预算（D-065） | ✅ 现在覆盖**形状**（source 可截断）、**失败路径**（F2）与**字节计量**（F3）三面；⚠️ 但截断 `source` 后 `source_truncated` 仍为 false（V16-1），需补登记或修正 |
| 仓库根白名单门禁（`c11f15a`） | ✅ 变异数 22→23 |

### 4. 后续开发建议

- **上线判断**：**修掉 V16-1（一处赋值）即可发 `0.1.0`**。四轮以来的"会话被打死/挂死"路径我已用大 text / 大 source / 非 ASCII / 转义富集 / 错误路径 / 8 MiB 边界六类夹具逐一验过，**全部存活**。
- **发布前的最后一道非代码门仍是 E1–E9（0/9）**——v13–v15 的漏检全部来自"夹具形状太窄"，只有真客户端 + 真 notebook 能补这一维。
- 若要我把 v14 的 F6/F7 与 `73df154` 的 diff 做一轮定向复核（对应用户"有没有大问题"的关切），说一声即可。

---

## 附录：方法与局限

- **主审亲验**：门禁全家桶；v15 探针全集复跑（F1/F2/F3，共 6 个构造）；新增 source 截断语义探针（`source_truncated` / `source_line_count` / 交付长度 / 警告原文 / 盘上字节数）。
- **局限**：① 未跑完整 `test:integration`；② v14 的 F6/F7 与 F4/F5 的修复未逐条复核（只验了"cell 不再被删"与文案）；③ 两路复核未在本轮重跑；④ 未在 Linux/macOS 与真实第三方客户端验证（E1–E9 仍 0/9）。
