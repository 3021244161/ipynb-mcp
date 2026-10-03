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
| `--background-threshold-seconds <n>` | `IPYNB_BACKGROUND_THRESHOLD_SECONDS` | `30` | Runs whose estimated upper bound (`timeout_seconds × target cells`) exceeds **10×** this go background |
| `--backup-keep <n>` | `IPYNB_BACKUP_KEEP` | `10` | Rolling backups per notebook |
| `--artifact-dir <dir>` | `IPYNB_ARTIFACT_DIR` | platform cache | Where image artifacts are written |
| `--inline-text-chars <n>` | `IPYNB_INLINE_TEXT_CHARS` | `20000` | Text output truncation threshold |
| `--preview-lines <n>` | `IPYNB_PREVIEW_LINES` | `12` | Source preview lines |
| `--max-images-per-call <n>` | `IPYNB_MAX_IMAGES_PER_CALL` | `20` | Image blocks per tool call |
| `--max-image-bytes <n>` | `IPYNB_MAX_IMAGE_BYTES` | `20971520` | Max bytes per image |
| `--log-level <level>` | `IPYNB_LOG_LEVEL` | `info` | stderr log level |

Startup failures (bad values, root does not exist / is your home dir / artifact dir unwritable) exit with code **2**.

With the defaults, a single-cell run is executed synchronously (its upper bound is exactly the 10× cut-off); two or more cells, or a raised `--exec-timeout-seconds`, return a background `run_id` you poll with `notebook_run_status`. The multiplier is `DEVIATIONS.md` D-015.

## Interpreter selection

When a notebook needs a kernel, the interpreter is resolved by candidate chain: `--python` → the notebook's own `metadata.kernelspec` argv → `.venv`/`venv` next to the notebook → `python3`/`python` on PATH. Every failed candidate is recorded; only if all fail does the tool error (with a ready-to-run `pip install ipykernel` command — the server never installs anything itself). A `.venv` that disagrees with the kernelspec produces a `kernelspec_mismatch` warning; pass `--python` to pin one explicitly.

## Known limitations

- **Execution is arbitrary code execution.** Point the root at directories you would let the agent write to; the fence is a path boundary, not a sandbox. Only run notebooks you can read.
- **Stale analysis is Python-only.** Non-Python kernels (R, Julia…) work for read/edit/run but skip stale analysis (`method: "skipped"`). It also cannot see through `globals()`/`locals()`/`exec`/`eval`/`setattr`, attribute assignments (`obj.attr = 1`) or `import *`. When a cell fails to parse, the whole analysis degrades to a conservative regex pass (all confidences drop to `low`; the regex pass additionally misses tuple unpacking, annotated assignments, indented assignments and `with … as`, and may flag identifiers inside strings/comments).
- **Interactive widgets are unsupported** (`application/vnd.jupyter.widget-view+json` degrades to `unsupported`).
- **Image-heavy single executions are still bounded by the transport.** The sidecar speaks one NDJSON line per response, and a line is capped at 64 MiB; since an `exec_cell` response carries every output's base64, a single cell producing more than roughly 64 MiB of base64 image data (e.g. several near-`max_image_bytes` figures) fails with a protocol error rather than returning the images. Lower `max_image_bytes`, split the cell, or read the images back through `notebook_read`. Tracked as `DEVIATIONS.md` D-017. **A protocol error tears the whole sidecar down, so every kernel it hosted (for every notebook in that interpreter) dies with it**: the next `notebook_run` rebuilds silently via `replay`, but a long training cell that had already finished in memory will not be re-run.
- **A kernel that dies while no cell is running is noticed on the next request, not immediately.** The sidecar polls the kernel process while it is executing a cell; between cells it only learns of an external kill (OOM killer, `taskkill`) when the next call arrives. `notebook_run` probes kernel liveness before reusing a session, so that case becomes a silent `replay`/rebuild rather than a failure — but the kernel's in-memory state is gone at that point.
- **An interpreter that imports `ipykernel` but cannot host a kernel is a hard failure, not a fallback.** The candidate chain picks an interpreter by probing `import ipykernel`; if the kernel then fails to start (a broken pyzmq build is the common real-world case), the run fails with `kernel_died` and the error detail carries the sidecar's last stderr lines plus the OS exit status (e.g. `code=3221226505 (0xC0000409) = STATUS_STACK_BUFFER_OVERRUN`). The server does not silently retry with another interpreter (`DEVIATIONS.md` D-030).
- **A timed-out cell also ends its kernel** (SPEC §4.7 rule 6), so in-memory state accumulated there is lost; the next run rebuilds through `replay` (D-025). The shutdown is **asynchronous**: the response returns first, and the kernel process may live on until the interrupted cell finishes on its own — seconds to minutes for a long computation. The management command reports no kernel immediately, and the process is gone by the time it ends; nothing is orphaned.
- **On Windows, interrupting a running cell usually does not work, so a timeout relies on that shutdown instead.** Interrupting a kernel needs a console event that a stdio MCP server has no console to deliver; a `time.sleep(30)` cell ignores the interrupt and runs to completion, while the tool has already returned `exec_timeout` and closed the kernel. Observed on Windows; other platforms are not verified here. The timeout response no longer waits for a reply the running cell cannot send, so it arrives at **`timeout_seconds` + about 10 s** (interrupt grace plus teardown; measured 10.2 s for a 2 s timeout) rather than at the cell's full duration (D-033).
- **Every write is validated before it lands — for the cells the write touches.** The bytes about to be written are re-parsed, and the cells this write changed are checked against the nbformat rules this implementation could break; a violation aborts the write with `selfcheck_failed` instead of producing a file Jupyter would refuse. This is deliberately not a full schema validation: content that was **already** in your file and is merely carried forward is preserved and reported as a warning, never used to block an edit or a run (D-032, D-037). `scripts/e2e-smoke.mjs` re-checks a real edit+run with Python's own `nbformat.validate`.
- **The kernel's connection file lives in the OS temp directory and is removed on every exit path this process controls.** A hard kill (SIGKILL, power loss) can leave one behind *there*; it is never written into your notebook directory (D-023), and its name is unpredictable and its mode 0600 (D-034). It carries that kernel's HMAC key, so treat a leftover file as sensitive.
- **One run per notebook at a time.** A second concurrent `notebook_run` on the same notebook fails with `kernel_busy` instead of interleaving cell executions — including when it arrives in the gap between the first run's cells. Different notebooks run in parallel.
- **Byte-level fidelity is logical, not literal.** Serialization normalizes `\uXXXX` escapes and number formats, so untouched regions of a heavily-escaped notebook may show file-level diffs. Semantics are preserved, and rolling backups (`<name>.<timestamp>.ipynb.bak`) cover the rest.
- **An unknown tool argument is an error, not a silent default.** Sending `cell_selector` to `notebook_read` (whose argument is `cell_indexes`) fails with `invalid_arguments` instead of quietly reading the whole notebook.
- **A write racing another program's write is retried, then reported.** On Windows the OS reports "another process holds this file" and "two renames collided" identically; the transient case is retried for about 0.75 s before `notebook_locked` is returned, so a momentary collision no longer looks like a locked file (D-035).
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
