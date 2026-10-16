# GitHub issue fixes

**Goal:** Repair background result visibility (#4), verify interpreter selection (#3), and clarify execution semantics (#5, #7) without changing the public interface.

**Architecture:** Keep orchestration in `src/run.ts`. Publish kernel binding and completed-cell snapshots through internal callbacks into `RunStore`; use the existing MCP response budget and deferred image delivery. Preserve cancellation, partial write-back, and D10 cell-error semantics.

**Tech stack:** TypeScript, vitest, the existing MCP SDK, and the existing test Python environment. No new dependencies.

**Spec:** `SPEC.md` sections 4.7, 4.8, 5.2, 5.6, 6, 7; GitHub issues #2–#8.

## Constraints

- Do not change SPEC, return field names, error codes, package version, or LICENSE. The user approved the optional run-status output parameter and interpreter-fallback warning trigger on 2026-10-15; record both in DEVIATIONS.
- Keep the main checkout's existing document changes untouched.
- Use the local Windows tools in this `dev` worktree.
- No package installation, user environment modification, or analysis-time source execution.

## Tasks

- [x] Confirm remote main matches local base; create `dev` worktree; run typecheck, lint, and 663 baseline unit tests.
- [x] Reproduce #4 with controlled transport and a real SDK client; require kernel binding and completed results while a later cell is blocked.
- [x] Publish only completed target cells, with matching deferred image plans and warnings; keep replay silent and partial cells private.
- [x] Verify the same visibility with a real kernel and a deliberately blocked second cell, including mixed cell success/failure.
- [x] Verify Windows user kernelspec selection and explicit interpreter precedence for #3; document the actual behavior and only fix a demonstrated defect.
- [x] Clarify full versus restart-and-full and orchestration completion versus cell success in English/Chinese README and tool descriptions.
- [x] Implement the approved #6 projection, record its approval and #3's warning approval, and document the #8 proposal / #2 no-creation boundary.
- [x] Run typecheck, lint, all unit and integration tests, build, package checks, and a real SDK smoke test; review and commit only this work.

## Review focus

- Polls must contain only completed target cells; replay and interrupted cells must not leak into live snapshots.
- Image indexes and artifact plans must stay aligned when polling before completion; budgeted-out images must not be written.
- Polling must not mutate stored results or duplicate them on later polls.
- Cancellation and kernel death must keep the previously published completed cells while final write-back facts settle.
- `completed` must continue to describe orchestration, and `full` must continue to reuse a live kernel.
