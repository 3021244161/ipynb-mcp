# ipynb-mcp 项目记忆

## 项目定位

- MCP stdio server `ipynb-mcp`：AI agent 安全读写执行本地 Jupyter notebook。
- 仓库：`E:/Work/ipynb-mcp/ipynb-mcp`；SPEC（冻结）：仓库内 `SPEC.md`（源自 `E:/Work/ipynb-mcp/ipynb-mcp-SPEC-v3.md`）。
- 遵循 SPEC §11 十一步流程与一任务一提交；偏离 SPEC 必须登记 `docs/DEVIATIONS.md`。

## 命令速查

```bash
cd E:/Work/ipynb-mcp/ipynb-mcp
pnpm typecheck && pnpm lint && pnpm test
IPYNB_TEST_PYTHON="E:/tool/anaconda/ana/envs/yolo/python.exe" pnpm test:integration   # 真实 kernel；首次自动建 tests/.venv-test
pnpm build   # 产出 lib/
node lib/bin.js --root <dir>   # 本地起 server
```

## 架构关键事实

- 分层：core（纯逻辑，禁 node:*）/ fs（I/O）/ kernel（进程协议）/ mcp（工具投影）+ src/run.ts（执行编排，src 根）。
- sidecar（python/ipynb_sidecar.py）：**每请求一个工作线程**（控制类 op 必须能打断在途 exec_cell）；jupyter_client 8.x 用 `km.kernel_spec.argv` 原地改写指定解释器；iopub/shell 按 msg_id 过滤 + 双 drain。
- 解释器候选链：--python → kernelspec argv[0] → notebook .venv/venv → PATH；conda 的 python 在 `<env>/python.exe`（pythonPrefix 处理）。
- 集成测试 vitest `fileParallelism: false`（kernel 时序敏感）。

## 状态（2026-10-02）

- SPEC 步骤 1–10 完成；单测 148 + 集成 26 全绿；14 个提交。
- 步骤 11（E1–E9 手工端到端）待 boss 执行：`docs/E2E-CHECKLIST.md`。
- npm 发布与 dsh bundle 发布待人类确认（OPEN_QUESTIONS Q5/Q6）。
