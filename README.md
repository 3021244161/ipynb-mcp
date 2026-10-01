# ipynb-mcp

An [MCP](https://modelcontextprotocol.io) server that lets any AI agent **read, edit and run local Jupyter notebooks** — safely, with zero setup.

```bash
npx -y ipynb-mcp
```

## Why this one

| Promise | What it means |
|---|---|
| **Zero service** | No JupyterLab to start, no tokens to manage. One line of config and the agent can open your `.ipynb`. |
| **Cannot silently corrupt your file** | Every source edit carries a compare-and-swap anchor (`expected_source_hash` or `expected_text`). If the notebook changed since the agent last read it, the edit **fails without writing** — and the error already contains the current hash so one retry succeeds. Writes are atomic, always preceded by a rolling backup. |
| **Never re-runs your long jobs** | `mode='resume'` runs only the target cells in the live kernel. No kernel alive? `mode='replay'` silently rebuilds state from cell 0, then runs just the target. A 40-minute training cell in cell 2 will not re-execute because you edited cell 5. |

Extras: stale-cell analysis (which outputs are now invalid because their inputs changed), image outputs as native MCP image blocks, background execution with polling for long runs, per-notebook kernel lifecycle management.

## Client configuration

```jsonc
// Claude Code / Cursor / VS Code (generic MCP stdio config)
{
  "mcpServers": {
    "ipynb": {
      "command": "npx",
      "args": ["-y", "ipynb-mcp"],
      "env": { "IPYNB_ROOT": "/absolute/path/to/your/notebooks" }
    }
  }
}
```

dsh users: install the companion `dsh-ipynb-mcp` bundle (see [dsh-ipynb-mcp/](./dsh-ipynb-mcp/)).

The server fences all paths to `IPYNB_ROOT` (or `--root`, or the process working directory). The fence refuses to start when the root is your home directory or a filesystem root — pass an explicit `--root`.

## Configuration

Precedence: CLI flags > `IPYNB_*` environment variables > defaults. Boolean flags accept `--no-` prefixes.

| CLI | Env | Default | Description |
|---|---|---|---|
| `--root <dir>` | `IPYNB_ROOT` | cwd | Root directory fence |
| `--allow-outside-root` | `IPYNB_ALLOW_OUTSIDE_ROOT` | `false` | Allow paths outside the root |
| `--read-only` | `IPYNB_READ_ONLY` | `false` | Only `notebook_read` and kernel `status` allowed |
| `--images <auto\|never\|always>` | `IPYNB_IMAGES` | `auto` | Image block policy (`auto`: images only on full-output reads and runs) |
| `--python <path>` | `IPYNB_PYTHON` | auto | Explicit interpreter (failure is final) |
| `--kernel-idle-seconds <n>` | `IPYNB_KERNEL_IDLE_SECONDS` | `3600` | Idle kernel reclamation |
| `--exec-timeout-seconds <n>` | `IPYNB_EXEC_TIMEOUT_SECONDS` | `300` | Per-cell timeout |
| `--background-threshold-seconds <n>` | `IPYNB_BACKGROUND_THRESHOLD_SECONDS` | `30` | Runs longer than this go background |
| `--backup-keep <n>` | `IPYNB_BACKUP_KEEP` | `10` | Rolling backups per notebook |
| `--artifact-dir <dir>` | `IPYNB_ARTIFACT_DIR` | platform cache | Where image artifacts are written |
| `--inline-text-chars <n>` | `IPYNB_INLINE_TEXT_CHARS` | `20000` | Text output truncation threshold |
| `--preview-lines <n>` | `IPYNB_PREVIEW_LINES` | `12` | Source preview lines |
| `--max-images-per-call <n>` | `IPYNB_MAX_IMAGES_PER_CALL` | `20` | Image blocks per tool call |
| `--max-image-bytes <n>` | `IPYNB_MAX_IMAGE_BYTES` | `20971520` | Max bytes per image |
| `--log-level <level>` | `IPYNB_LOG_LEVEL` | `info` | stderr log level |

Startup failures (bad values, root does not exist / is your home dir / artifact dir unwritable) exit with code **2**.

## Interpreter selection

When a notebook needs a kernel, the interpreter is resolved by candidate chain: `--python` → the notebook's own `metadata.kernelspec` argv → `.venv`/`venv` next to the notebook → `python3`/`python` on PATH. Every failed candidate is recorded; only if all fail does the tool error (with a ready-to-run `pip install ipykernel` command — the server never installs anything itself). A `.venv` that disagrees with the kernelspec produces a `kernelspec_mismatch` warning; pass `--python` to pin one explicitly.

## Known limitations

- **Execution is arbitrary code execution.** Point the root at directories you would let the agent write to; the fence is a path boundary, not a sandbox. Only run notebooks you can read.
- **Stale analysis is Python-only.** Non-Python kernels (R, Julia…) work for read/edit/run but skip stale analysis (`method: "skipped"`). It also cannot see through `globals()`/`locals()`/`exec`/`eval`/`setattr`, attribute assignments (`obj.attr = 1`) or `import *`. When a cell fails to parse, the whole analysis degrades to a conservative regex pass (all confidences drop to `low`; the regex pass additionally misses tuple unpacking, annotated assignments, indented assignments and `with … as`, and may flag identifiers inside strings/comments).
- **Interactive widgets are unsupported** (`application/vnd.jupyter.widget-view+json` degrades to `unsupported`).
- **Byte-level fidelity is logical, not literal.** Serialization normalizes `\uXXXX` escapes and number formats, so untouched regions of a heavily-escaped notebook may show file-level diffs. Semantics are preserved, and rolling backups (`<name>.<timestamp>.ipynb.bak`) cover the rest.
- **No auto-creation** of notebooks, no format conversion, no collaboration features.

## Differences from the obvious alternatives

- vs `jupyter nbconvert --execute`: whole-notebook batch execution with no way to resume state; every run replays everything.
- vs running code through the shell: no notebook state, no outputs written back to the `.ipynb`, no images, no CAS protection on edits.
- vs attaching to a Jupyter Server: needs a running service and token management; this is zero-config stdio.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test          # unit (no Python needed)
pnpm test:integration                              # real kernels (needs ipykernel)
pnpm build
```

Integration tests create a dedicated venv (`tests/.venv-test`, system-site-packages) and never touch your interpreters. Set `IPYNB_TEST_PYTHON` to a base interpreter that already has `ipykernel`.

Implementation follows the frozen spec in [SPEC.md](./SPEC.md); every deviation is recorded in [docs/DEVIATIONS.md](./docs/DEVIATIONS.md).

## License

MIT — see [LICENSE](./LICENSE).
