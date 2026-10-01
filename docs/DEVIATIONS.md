# DEVIATIONS — 每一次偏离 SPEC 的记录

> 规则（SPEC §6 R20 / AGENTS.md §0）：发现 SPEC 有错或需要偏离时，**先在此登记**（现象、已尝试的方案、判断的根因），再决定如何继续。接口契约与红线优先于任何示例代码；本文档**不改变** SPEC 的效力，仅记录偏离及理由。

| # | 日期 | SPEC 位置 | 偏离内容 | 理由 | 影响面 | 状态 |
|---|---|---|---|---|---|---|
| D-001 | 2026-10-02 | §5.1 `--backup-keep` / §5.9 | SPEC 未定义 `backup_keep=0` 的语义（"超过 backup_keep 时删除最旧的"在 0 时与"生成备份"自相矛盾）。实现取：`keep=0` 时**不创建备份**，返回 `backup_path: null`。 | 创建后立即删除是无意义的额外 I/O；"保留 0 份"的直译结果等价于"不备份"。 | 仅影响 `--backup-keep 0` 配置；默认 10 不受影响。 | 已实现（src/fs/backup.ts） |
| D-002 | 2026-10-02 | §5.7 `unclosed-fence` | SPEC 判定为"去掉行内代码后，\`\`\` 与 ~~~ 围栏计数为奇数"。实现取：**行首（trim 后）以 \`\`\` / ~~~ 开头才计入围栏**，不做行内代码剥离。 | CommonMark 行内代码可跨行，完整剥离需跨行状态机；而"行内 \`\`\`"出现在句子中间时不在行首、天然不影响行首判定。两种实现仅在"一行以 \`\`\` 开头但属于跨行行内代码的后半段"这一歧义场景下分歧，该场景本身对 CommonMark 也是 fence（歧义）。 | 极罕见歧义场景下 fence 计数与严格 CommonMark 不同；常规 notebook 内容无差异。 | 已实现（src/core/markdown.ts） |
| D-003 | 2026-10-02 | §5.8 `RawOutput` 类型 | §5.8 的 RawOutput 定义未含 `metadata` 字段，而 §4.4 要求图片宽高优先取 "output metadata 的 width/height"。实现为 RawOutput 增加 `metadata?: Record<string, unknown>`（sidecar 协议透传 jupyter output 的 metadata）。 | §4.4 的宽高优先级是明确的行为要求，无 metadata 字段则无法实现；jupyter 的 display_data/execute_result 天然携带 metadata。 | 仅增加可选字段，协议向后兼容；不影响既有判定顺序。 | 已实现（src/core/outputs.ts） |
| D-004 | 2026-10-02 | §5.1 / D14 | D14 规定"单 cell 执行前若已有累计耗时超 background_threshold_seconds"可转后台。实现取**纯预估判定**（`timeout_seconds × 目标 cell 数 > 阈值` → 后台），执行中途累计超阈值不转后台。 | 执行中途转后台需把在途执行移交给后台任务，引入复杂的对象所有权问题；预估判定已覆盖"长任务让出控制权"的核心目标（timeout×count 是上界估计）。 | 实际执行远超预估的场景（如每 cell 实际 60s 但 timeout 设 10s×1）会保持同步。 | 已实现（src/mcp/tools/run.ts） |
| D-005 | 2026-10-02 | §8 发布规则 2 | 运行期依赖在 `@modelcontextprotocol/sdk` 之外新增 `zod`（^3.25）。 | zod 是 SDK 的 **peerDependency**（sdk package.json 声明 `zod: ^3.25 || ^4.0`），本就要求消费者提供；SDK 的 `registerTool` inputSchema 只接受 zod shape，无 zod 则工具 schema 无法声明（模型将看不到参数定义）。 | zod 由 SDK 官方 peer 声明，非额外功能依赖；不引入任何新能力面。 | 已实现（package.json dependencies） |
| D-006 | 2026-10-02 | §4.1.12 | 参数的**类型级**错误（如 `timeout_seconds: "abc"`、必填字段缺失）由 SDK 的 zod 校验拒绝（JSON-RPC -32602 协议错误），**值级**错误（范围/长度/空串/enum 值）在工具层校验并以 `invalid_arguments` 工具错误返回。 | SDK 携带 schema 时必然执行校验且以协议错误拒绝；绕过需放弃 schema 声明（模型失去参数可发现性，代价更大）。U27 的三个用例（值级错误）全部按 SPEC 以 invalid_arguments 返回。 | 模型收到类型错误的形态是协议错误而非工具错误，两者均可恢复。 | 已实现（src/server.ts, src/mcp/context.ts） |



