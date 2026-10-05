# OPEN_QUESTIONS — SPEC §12 原样抄录

> 本文件是 `SPEC.md` §12 的逐字副本（C4：原样抄录，不做格式改写）。

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
