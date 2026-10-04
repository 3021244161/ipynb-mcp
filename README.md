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

## Outputs, images and large numbers

An `include_outputs: 'full'` read projects every stored output into one of the `OutputItem` shapes of [SPEC.md](./SPEC.md) §5.4 and returns image items as native MCP image blocks. Two value shapes are worth their own paragraph, because real notebooks contain both.

**Images.** A notebook may store an image as plain base64, as the `data:image/png;base64,…` URL people paste, wrapped over several lines, or as an array of lines (nbformat's multi-line form). A full-output read, and a run, return all of those as a valid image block decoded to the bytes in your file, with `image_index` and `artifact_path` naming that block and the artifact written for it (when no block is returned — a summary read, `--images=never`, or past `max_images_per_call` — both stay `null`, per SPEC §4.4). A value that cannot be decoded — **including an empty one** — never fails the call: the item stays `kind: "image"` with `bytes: 0`, `artifact_path: null`, `image_index: null` and a `text_fallback` saying why, and the call carries an `image_materialize_failed` warning. The stored value itself is left exactly as it was; the block is built from the decoded bytes, so a value your notebook holds but no client could decode is a degraded image, not a failed read.

**Large integers in `application/json`.** nbformat puts no type constraint on a json value, and an integer JavaScript cannot represent exactly (anything past ±2^53, e.g. `2**64`) cannot survive a JSON number channel unchanged. Such a value is preserved byte-for-byte in the file — a read/write round trip no longer rounds it — and the response reports it rather than pretending: whenever that output is returned in full (a full-output read, or a run), the item carries a `warnings` array and the call-level `warnings[]` gains one entry — code `output_truncated`, which is already in SPEC §7's closed table — whose message contains the **exact digits**. `value` holds the nearest double, because that is what the JSON channel itself can carry and what any JSON client would parse; the digits you need are in the warning and in the file.

## Known limitations

- **Execution is arbitrary code execution.** Point the root at directories you would let the agent write to; the fence is a path boundary, not a sandbox. Only run notebooks you can read.
- **Stale analysis is Python-only.** Non-Python kernels (R, Julia…) work for read/edit/run but skip stale analysis (`method: "skipped"`). It also cannot see through `globals()`/`locals()`/`exec`/`eval`/`setattr`, attribute assignments (`obj.attr = 1`) or `import *`. When a cell fails to parse, the whole analysis degrades to a conservative regex pass (all confidences drop to `low`; the regex pass additionally misses tuple unpacking, annotated assignments, indented assignments and `with … as`, and may flag identifiers inside strings/comments).
- **Interactive widgets are unsupported** (`application/vnd.jupyter.widget-view+json` degrades to `unsupported`).
- **Image-heavy single executions are still bounded by the transport.** The sidecar speaks one NDJSON line per response, and a line is capped at 64 MiB; since an `exec_cell` response carries every output's base64, a single cell producing more than roughly 64 MiB of base64 image data (e.g. several near-`max_image_bytes` figures) fails with a protocol error rather than returning the images. Lower `max_image_bytes`, split the cell, or read the images back through `notebook_read`. Tracked as `DEVIATIONS.md` D-017. **A protocol error tears the whole sidecar down, so every kernel it hosted (for every notebook in that interpreter) dies with it**: the next `notebook_run` rebuilds silently via `replay`, but a long training cell that had already finished in memory will not be re-run.
- **A kernel that dies while no cell is running is noticed on the next request, not immediately.** The sidecar polls the kernel process while it is executing a cell; between cells it only learns of an external kill (OOM killer, `taskkill`) when the next call arrives. `notebook_run` probes kernel liveness before reusing a session, so that case becomes a silent `replay`/rebuild rather than a failure — but the kernel's in-memory state is gone at that point.
- **An interpreter that imports `ipykernel` but cannot host a kernel is a hard failure, not a fallback.** The candidate chain picks an interpreter by probing `import ipykernel`; if the kernel then fails to start (a broken pyzmq build is the common real-world case), the run fails with `kernel_died` and the error detail carries the sidecar's last stderr lines plus the OS exit status (e.g. `code=3221226505 (0xC0000409) = STATUS_STACK_BUFFER_OVERRUN`). The server does not silently retry with another interpreter (`DEVIATIONS.md` D-030).
- **A timed-out cell also ends its kernel** (SPEC §4.7 rule 6), so in-memory state accumulated there is lost; the next run rebuilds through `replay` (D-025). The shutdown is **asynchronous**: the response returns first, and the kernel process may live on until the interrupted cell finishes on its own — seconds to minutes for a long computation. The management command reports no kernel immediately, and the process is gone by the time it ends; nothing is orphaned.
- **On Windows, interrupting a running cell usually does not work, so a timeout relies on that shutdown instead.** Interrupting a kernel needs a console event that a stdio MCP server has no console to deliver; a `time.sleep(30)` cell ignores the interrupt and runs to completion, while the tool has already returned `exec_timeout` and closed the kernel. Observed on Windows; other platforms are not verified here. The timeout response no longer waits for a reply the running cell cannot send, so it arrives at **`timeout_seconds` + about 10 s** (interrupt grace plus teardown; measured 10.2 s for a 2 s timeout) rather than at the cell's full duration (D-033).
- **Every write is validated before it lands — for the cells the write rewrites.** The bytes about to be written are re-parsed, and the cells this write changed are checked against the nbformat rules this implementation could break; a violation aborts the write with `selfcheck_failed` instead of producing a file Jupyter would refuse. This is deliberately not a full schema validation. Content that was **already** in your file and is merely carried forward is preserved and reported as a warning (`file_changed_externally`, with the rule and cell in the message), never used to block an edit or a run (D-032, D-037) — **which means a file that already contained such content will still not satisfy `nbformat.validate` after a successful edit or run.** Fix or clear that content yourself; this tool will not rewrite your history. `scripts/e2e-smoke.mjs` re-checks a real edit+run with Python's own `nbformat.validate`.
- **The kernel's connection file lives in the OS temp directory and is removed on every exit path this process controls.** A hard kill (SIGKILL, power loss) can leave one behind *there*; it is never written into your notebook directory (D-023), and its name is unpredictable and its mode 0600 (D-034). It carries that kernel's HMAC key, so treat a leftover file as sensitive.
- **One run per notebook at a time.** A second concurrent `notebook_run` on the same notebook fails with `kernel_busy` instead of interleaving cell executions — including when it arrives in the gap between the first run's cells. Different notebooks run in parallel.
- **Byte-level fidelity is logical, not literal.** Serialization normalizes `\uXXXX` escapes and number *spellings*, so untouched regions of a heavily-escaped notebook may show file-level diffs. **What is preserved is every value**: `100.0` may come back as `100`, `2.0` as `2`, `1e-05` as `0.00001` — the same number, and the same is true of Python's own `json.dumps` output, which is where most of these spellings come from. What is *not* tolerated is a changed value: a number JavaScript cannot hold is written back as the literal that was there, with a warning naming the exact digits (see "Outputs, images and large numbers" above), and the same is true of literals that overflow (`1e400`) or underflow (`1e-400`) a double. Rolling backups (`<name>.<timestamp>.ipynb.bak`) cover the rest.
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
pnpm smoke                                         # real stdio server driven by a real MCP client
pnpm check:package                                 # what `npm pack` would ship
pnpm build
```

`pnpm lint` is more than a linter: it also runs the zero-dependency checkers `scripts/check-format.mjs` (tabs, trailing whitespace), `scripts/check-indent.mjs` (block structure, via the TypeScript parser) and `scripts/check-docs.mjs`, which keeps the documentation invariants honest (one `docs/DEVIATIONS.md` with unique, gap-free entry ids, and `docs/OPEN_QUESTIONS.md` still a verbatim copy of SPEC §12). `pnpm smoke` starts the built server as a real stdio process, drives it with the SDK's own client, and checks the end-to-end behaviours the unit suite cannot reach — 26 checks today, including a run and a read of a notebook holding a `data:` URL image (the shape that used to fail the whole `tools/call`), a timeout, a background run, and Python's own `nbformat.validate` on the file it wrote. `pnpm check:package` asserts the shape of the shipped package (no compiled Python, no sources, no test files, no scratch scripts) and proves its own judgment with a resident mutation matrix.

The unit and integration suites share one dedicated venv **in the system temp directory** (never in the repository; override the location with `IPYNB_TEST_VENV`) and never touch your interpreters. The unit suite uses it too, because its analyzer cases start a real sidecar — which is also why both suites run their files serially. Set `IPYNB_TEST_PYTHON` to a base interpreter that already has `ipykernel`. A venv this suite did not create is never deleted, and one it cannot use is removed only when it created it.

**Security: what the kernel inherits.** The sidecar and the kernel it starts inherit this server's full environment (`PATH`, `HOME`, proxies, tokens — anything your MCP client passed in), and executed cells can read it. Kernel processes are also not sandboxed in any way: `notebook_run` executes whatever the notebook says, with your user's privileges. Point `--root` at directories you would let the agent write to, and run notebooks you are willing to execute.

Implementation follows the frozen spec in [SPEC.md](./SPEC.md); every deviation is recorded in [docs/DEVIATIONS.md](./docs/DEVIATIONS.md).

## License

MIT — see [LICENSE](./LICENSE).
