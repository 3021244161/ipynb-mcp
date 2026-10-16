# Interface decisions for GitHub issues #2, #3, #5, #6 and #8

The #3 fallback warning and #6 optional polling parameter were approved by the user on 2026-10-15 and implemented on `dev` (DEVIATIONS D-071/D-072). The #8 static transformation below remains a proposal. SPEC.md remains unchanged.

## Interpreter fallback (#3)

The existing resolver selects a usable named Windows user kernelspec, unless `--python` or `IPYNB_PYTHON` overrides it. A separate gap exists when a resolved kernelspec points to a missing interpreter or one missing required modules: successful fallback loses the rejection reason and can return no mismatch warning.

The real-kernel regression also reproduced a restart defect: `notebook_kernel(restart)` reused the previous session's interpreter and spec instead of reading the current notebook. After changing `python3` to a valid custom spec, restart still reported `python` / `python3`. Restart now resolves the current notebook before replacement, and creates a fresh kernel when none exists, as SPEC §4.9 requires. Tests verify both the reported interpreter and the executed cell's `sys.executable`.

Approved correction: reuse `kernelspec_mismatch` to name the rejected interpreter and reason before continuing the existing candidate chain. No new fields, error codes or dependency. SPEC §5.2 requires recorded candidate failures but its exhaustive mismatch-warning triggers omit this case; the user approved extending that trigger under AGENTS.md §11. An explicit interpreter still wins and never falls back.

## Cheap polling (#6) and visible cell failures (#5)

Approved interface: optional `include_outputs: 'none' | 'full'` on `notebook_run_status`, defaulting to `'full'` for compatibility.

- `'none'` returns the existing status and completed-cell metadata, with `executed[].outputs: []`. State, kernel ID, progress, each cell's status/index, warnings, write-back and pending facts remain available.
- It returns no images and creates no artifacts. Projection must not mutate the stored full results.
- `'full'` retains current output/image behavior and the existing response budget. Details can also be read explicitly with `notebook_read(cell_indexes=[...], include_outputs='full')` after write-back.
- Repeated `'none'` polls therefore avoid resending output. No cursor, new tool, new aggregate field or execution-policy change is needed.

`completed` continues to mean orchestration ended. Agents determine cell failures from `executed[].status`; a printed score is independent of Python exception status. The English/Chinese documentation can clarify this immediately.

Acceptance coverage: default behavior unchanged; four run states; mixed successful/failed cells; many small outputs/many cells; native image omission without artifact writes; full retrieval after cheap polling; cancellation and kernel death; invalid enum and unknown-argument validation; real SDK client delivery.

## IPython analysis (#8)

Current behavior deliberately falls back for the entire notebook when raw `symtable` cannot parse any cell. This includes `!command`, `%magic` and `%%cell-magic`. Malformed ordinary Python must continue to cause fallback. U19b module/local scope semantics must remain intact.

Existing IPython transformation capabilities can turn this syntax into valid Python without executing it. Transformation alone does not justify high confidence: `%run`, `%reset`, `%store`, cell magics and shell variable interpolation can hide definitions or uses inside strings. Blind transformation would replace an explicit limitation with false confidence.

`tests/integration/ipython-analysis.test.ts` characterizes the current fallback for shell syntax, both magic forms and malformed Python while preserving U19b scope behavior. It also demonstrates with the existing IPython transformer that `%time y = x` becomes a magic call whose symtable contains neither `x` nor `y`; static transformation by itself loses the very dependency facts the analysis needs. No source is executed by these analysis checks.

Recommended next design: a static, conservative whitelist of transformations, rejecting opaque or interpolated forms and preserving whole-notebook regex fallback for every unsupported cell. Use only capabilities already present in the selected environment, install nothing, and bump `analysis_version` when semantics change. Read/edit must still start no kernel. Approve the exact supported syntax and confidence/version rules before implementation.

## Notebook creation (#2)

SPEC D19 and §12 Q4 explicitly exclude notebook creation. Keep that boundary. Users can create a valid notebook with their editor/Jupyter first, then use the existing tools. Adding creation requires a separate product/interface decision.
