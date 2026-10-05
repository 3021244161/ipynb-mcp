# 手工端到端验收清单（E1–E9，SPEC §10.3）

> 这一步需要真实 MCP 客户端，由人（boss）执行并留档（截图或日志）。
> 每项通过后把证据路径填入"证据"列。全部通过即满足 §10.4 DoD 的最后一项。

服务器本地启动方式（无需发布）：

```bash
node <repo>/lib/bin.js --root <你的 notebook 目录>
```

或先本地打包再 `npx`：

```bash
cd <repo> && pnpm build && npm pack
npx -y file:./ipynb-mcp-server-0.1.0.tgz --root <你的 notebook 目录>
```

| # | 步骤 | 通过标准 | 证据（截图/日志路径） |
|---|---|---|---|
| E1 | 干净机器：`npx -y ipynb-mcp-server` + 一行客户端配置 → 让 agent 跑通一个 cell | 从零到跑通 ≤ 60 秒，中途无需 `pip install` 任何东西 | |
| E2 | 读一个带绘图的真实 notebook | 图确实出现在客户端对话中（`--images=auto` 且 `include_outputs='full'`） | |
| E3 | 用过期的行号让 agent 改代码 | 工具失败并回传 `current_source_hash`；agent **一次**重试成功 | |
| E4 | 跑 cell 0..4（cell 2 耗时 ≥ 60s），再改 cell 5 并重跑 | cell 2 未被重新执行；返回体含 stale 分析 | |
| E5 | 关闭客户端后重开，直接改 cell 5 并重跑 | `mode_used === 'replay'`，结果正确 | |
| E6 | 用 JupyterLab 打开被本工具改过的 notebook | 无告警、cell 数与源码一致、cell id 未被剥离 | |
| E7 | dsh 通过 `dsh-ipynb-mcp` bundle 接入 | 工具以 `mcp__ipynb__notebook_*` 出现且可用；图片进入对话 | |
| E8 | Claude Code 接入 | 编辑调用触发客户端的 diff/审批 UI | |
| E9 | Cursor 接入 | 同 E8 | |

## 备注

- E7 需要先把 `dsh-ipynb-mcp/` 发布到 npm 或以本地路径安装（Q6：发布前确认）。
- E1 的"干净机器"可用一台新虚拟机或新用户账号模拟（核心断言是不需要预装任何 Python 包之外的步骤）。
