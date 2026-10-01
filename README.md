# ipynb-mcp

An [MCP](https://modelcontextprotocol.io) server (stdio) that lets any AI agent **read, edit and run local Jupyter notebooks** — safely, with zero setup.

- **Zero service**: `npx -y ipynb-mcp` plus one line of client config. No JupyterLab, no tokens.
- **Cannot silently corrupt your file**: every source edit requires a compare-and-swap anchor (`expected_source_hash` or `expected_text`); a mismatch fails the whole request without writing.
- **Never re-runs your long jobs**: `resume` runs only the target cells in the live kernel; `replay` silently rebuilds state from cell 0 when no kernel exists.

> README will be completed in step 10 (packaging & release) per SPEC §11.

## Status

Under construction — implementing [SPEC.md](./SPEC.md) step by step. See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT — see [LICENSE](./LICENSE).
