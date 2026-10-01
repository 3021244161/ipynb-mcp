# OPEN_QUESTIONS — SPEC §12 原样抄录

> 按 SPEC §12 的要求逐字抄录。这些问题由人类决定，实现者按【默认行为】继续。

| # | 问题 | 默认行为 |
|---|---|---|
| Q1 | `max_images_per_call` 默认 20 是否合适 | 保持 20 |
| Q2 | `kernel_idle_seconds` 默认 3600 是否合适（长任务中途接续） | 保持 3600 |
| Q3 | 是否提供"attach 到已存在的 Jupyter kernel"（连接用户自己 JupyterLab 里正在运行的 kernel，以同时获得人机共享会话） | 不实现，等需求验证 |
| Q4 | 是否支持在 notebook 中创建新 cell 之外的"新建 notebook" | 不实现（D19） |
| Q5 | npm 组织/仓库归属与最终包名 | 按 `ipynb-mcp` 开发；发布前由人类确认 |
| Q6 | 是否发布 `dsh-ipynb-mcp` bundle 到 npm | 先本地开发，发布前确认 |
| Q7 | 纯 Node transport（去 sidecar）是否立项 | 不立项；保留 `KernelTransport` 接口 |
