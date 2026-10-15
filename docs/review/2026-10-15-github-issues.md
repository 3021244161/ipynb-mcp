# GitHub issue repair evidence — 2026-10-15

Work is on `dev`, based on main `3e7d24c3796ef01906d5f809f4b3def8874c4980`, in a separate Windows worktree. The original checkout's three existing document edits were preserved. No dependencies, Python packages, package version, LICENSE or SPEC were changed.

## Scope

- #3: restart now resolves the current notebook's interpreter/spec, including cold restart. Rejected spec interpreters produce an explanatory mismatch warning. Explicit interpreter precedence stays intact.
- #4: kernel binding and completed target-cell results publish while subsequent cells run. Replay stays silent; interrupted-cell partial results are excluded. Full status captures a coherent cell list with its progress and image plans.
- #6: approved optional `include_outputs: 'none' | 'full'` on status, default full. None returns metadata without outputs/images/artifact writes and preserves stored detailed results.
- #5/#7: tool descriptions and both READMEs distinguish orchestration completion, cell exceptions and printed grading results, and document restart plus full for clean validation. Full still reuses a live kernel and preserves import state.
- #8: current conservative analysis behavior is documented and characterized; the proposed static preprocessing is not implemented. Blind IPython transformation demonstrably loses `%time y = x` dependency names.
- #2: notebook creation remains outside SPEC D19 / Q4.

The user explicitly approved #3's warning-trigger extension and #6's optional parameter on 2026-10-15. They are registered as D-071/D-072; SPEC remains unchanged.

## Reproductions and regression coverage

- A real SDK client against controlled execution reproduced `kernel_id: null` / empty `executed` during a blocked second cell. The fix exposes only the completed first cell, including error status and native image delivery. The disk remains unchanged until write-back.
- Cancellation previously returned the interrupted second cell's partial output as completed; a regression failed before removing that entry and passes with completed cells preserved.
- Real kernels reproduced restart retaining `python` / `python3` after a notebook switched to a valid custom spec. Tests now check both returned interpreter metadata and actual `sys.executable`, for cold and changed-spec restart.
- Invalid notebook / interpreter preflight must not cancel an active run. Deterministic tests failed before moving preflight ahead of run cancellation and now preserve the active run and its eventual write-back.
- A deterministic capture/interleaving test reproduced 251 returned cells beside progress 250 and older image plans. Full and none projections now retain one coherent capture.
- A 250-cell status fixture covers running/completed/failed/cancelled, failed-cell indexes, many small outputs, CJK/escaping, repeated cheap polling, no image writes, later full retrieval, enum validation and unchanged cancel arguments.
- Response budgeting could fit the data then refuse it solely because the truncation explanation crossed the limit. It now fits those warning bytes by omitting further outputs, retaining run facts and one accurate truncation warning.

## Guard mutation checks

All four deliberately bad variants failed assertions and were restored in `finally`:

1. Cheap polling returned stored outputs/images.
2. Full status retained the mutable executed array reference.
3. Live completion omitted its image blocks/artifact plans.
4. The final budget did not account for the truncation warning.

Baseline: typecheck, lint and 663 unit tests passed. The first integration attempt exposed a missing prebuilt `lib/bin.js` in the new worktree and the restart reproduction above; final verification builds before running stdio integration.

## Final local verification

Windows x64, Node 26.7.0, pnpm 11.7.0, existing test virtualenv; all commands completed successfully after the four mutations were restored:

- `pnpm typecheck` and `pnpm lint` (including format, structural indentation and document mutation guards).
- `pnpm test`: **679/679**, 36 files.
- `pnpm build` before stdio integration.
- `pnpm test:integration`: **107/107**, 14 files, with no skipped tests; includes external nbformat validation, live snapshots, changed/cold kernelspec restart, cancellation, kernel death, budgets and process cleanup.
- `pnpm check:package`: **145 packaged files**, all **23** package mutations detected. The existing checker emits Node 26's DEP0190 deprecation notice; the check succeeds.
- `pnpm smoke`: **26/26**, real SDK stdio client, real kernel, native images and external nbformat validation.

The worktree reuses existing Node dependencies; commands used `--config.verify-deps-before-run=false` to prevent pnpm from attempting to reinstall a linked modules directory. No package was installed.

Read-only review found and then approved fixes for the status-array capture race and restart preflight ordering. No actionable P0/P1/P2 findings remain. Third-party GUI clients and Linux/macOS are not exercised by this Windows-only run; remote CI evidence is separate.
