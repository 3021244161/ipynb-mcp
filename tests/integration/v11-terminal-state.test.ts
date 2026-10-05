// The terminal-state rule (review v11 V11-3, AGENTS §9's "terminal state and facts arrive
// together").
//
// `notebook_run_cancel` must publish the terminal state immediately (SPEC §4.8 rule 1) while
// the in-flight cell keeps running, and every fact the run has to report arrives later. So
// there is a window — the remainder of that cell — in which a run that has ALREADY executed
// cells, ALREADY dropped values and is ABOUT to rewrite the file reports:
//
//   state: cancelled, executed: [], warnings: [], write_back: { performed: false }
//
// That payload is self-consistent and false. A client is entitled to believe it, conclude
// "nothing ran, nothing was written", and run the notebook again — which is precisely the
// behaviour SPEC §4.8 rule 3 exists to prevent.
//
// The rule: a terminal state either carries its facts or declares them outstanding. The
// assertions below are the only shape the defect cannot survive, and they are deliberately
// about the FIRST status after the cancel — the one a client reads.
//
// Why the unit suite cannot see this: the window exists only BETWEEN two queries, so a test
// that inspects the final handle (or awaits the run) sees a perfectly correct object. It has
// to be a real kernel, a real cancel and a real status read, in that order.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PathFence } from '../../src/fs/fence.js';
import { hasher } from '../../src/hash.js';
import { SIDECAR_REQUIRED_MODULES } from '../../src/kernel/interpreter.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { createLogger } from '../../src/log.js';
import type { ToolContext } from '../../src/mcp/context.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { toCallToolResult } from '../../src/mcp/tools/result.js';
import { handleRunCancel, handleRunStatus } from '../../src/mcp/tools/run-status.js';
import { handleNotebookRun } from '../../src/mcp/tools/run.js';
import { prepareVenv, resolvedTestInterpreter } from './test-venv.js';

let workspace: string;
let registry: KernelRegistry;

beforeAll(async () => {
  prepareVenv({ modules: SIDECAR_REQUIRED_MODULES });
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-v11-'));
  registry = new KernelRegistry({ idleSeconds: 3600 });
  registry.start();
}, 180_000);

afterAll(async () => {
  await registry.shutdownAll();
  await rm(workspace, { recursive: true, force: true });
}, 120_000);

function context(): ToolContext {
  return {
    config: {
      root: workspace,
      allowOutsideRoot: false,
      readOnly: false,
      images: 'auto',
      python: resolvedTestInterpreter(),
      kernelIdleSeconds: 3600,
      execTimeoutSeconds: 300,
      // Zero, so every run in this file takes the background path — the window this case is
      // about only exists there.
      backgroundThresholdSeconds: 0,
      backupKeep: 10,
      artifactDir: path.join(workspace, 'artifacts'),
      inlineTextChars: 20000,
      previewLines: 12,
      maxImagesPerCall: 20,
      maxImageBytes: 20971520,
      maxResponseBytes: 8_388_608,
      logLevel: 'error',
    },
    fence: new PathFence(workspace, false, process.platform),
    registry,
    runStore: new RunStore(),
    hasher,
    logger: createLogger('error'),
    realpath: (target: string) => target,
    platform: process.platform,
  } as unknown as ToolContext;
}

function bodyOf(outcome: Awaited<ReturnType<typeof handleRunStatus>>): Record<string, unknown> {
  const result = toCallToolResult(outcome);
  return JSON.parse(String((result.content[0] as { text: string }).text)) as Record<string, unknown>;
}

/** A cell that drops an unrepresentable value, then a cell that sleeps long enough to cancel. */
const CELLS = ["display({'text/plain': 5}, raw=True)", 'import time\ntime.sleep(20)'];

function cellsNotebook(sources: readonly string[]): string {
  return `${JSON.stringify(
    {
      cells: sources.map((source, index) => ({
        cell_type: 'code',
        execution_count: null,
        id: `c${String(index)}`,
        metadata: {},
        outputs: [],
        source,
      })),
      metadata: {
        kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
        language_info: { name: 'python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  )}\n`;
}

describe('[V11-3] a terminal state carries its facts or declares them pending', () => {
  it('[V11-3] the first status after a cancel is never a false "nothing happened"', async () => {
    const target = path.join(workspace, 'cancel-window.ipynb');
    await writeFile(target, cellsNotebook(CELLS), 'utf8');
    const ctx = context();

    const started = bodyOf(
      await handleNotebookRun(ctx, { path: target, cell_selector: 'all', mode: 'auto', timeout_seconds: 120 }),
    );
    expect(started['kind'], JSON.stringify(started)).toBe('background');
    const runId = String(started['run_id']);

    // Wait until the FIRST cell has certainly finished (its value was dropped) and the run
    // is inside the second one: that is what makes the window non-trivial, because at this
    // point the run HAS something to report and has not reported it yet.
    const deadline = Date.now() + 90_000;
    let sawSecondCell = false;
    while (Date.now() < deadline) {
      const current = bodyOf(await handleRunStatus(ctx, { run_id: runId }));
      const progress = current['progress'] as { current_cell_index: number | null };
      if (progress.current_cell_index === 1) {
        sawSecondCell = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(sawSecondCell, 'cell 1 must start before the cancel, or the window is trivial').toBe(true);

    // Cancel, then read the status the way a client would: immediately.
    const cancelled = bodyOf(await handleRunCancel(ctx, { run_id: runId }));
    expect(cancelled['state']).toBe('cancelled');

    const first = bodyOf(await handleRunStatus(ctx, { run_id: runId }));
    expect(first['state']).toBe('cancelled');
    const warnings = (first['warnings'] ?? []) as Array<{ message: string }>;
    const executed = (first['executed'] ?? []) as unknown[];
    // THE RULE. Either the facts are here (cell 0's dropped value, named), or the payload
    // says they are still coming. What may not happen is a silent empty answer.
    expect(
      (warnings.length > 0 && executed.length > 0) || first['facts_pending'] === true,
      `a cancelled run reported neither facts nor facts_pending: ${JSON.stringify(first)}`,
    ).toBe(true);
    if (first['facts_pending'] === true) {
      // …and the cancel response, whose `state` is the whole point for a client, carries the
      // same fact (SPEC §4.8's cancel payload is three fields, so this fourth one is D-055).
      expect(cancelled['facts_pending'], 'the cancel response carries the same fact').toBe(true);
    }

    // The promise the field makes is kept: once it is false, the facts are present and the
    // file has been written.
    const settleDeadline = Date.now() + 180_000;
    let final: Record<string, unknown> = first;
    while (Date.now() < settleDeadline) {
      final = bodyOf(await handleRunStatus(ctx, { run_id: runId }));
      if (final['facts_pending'] !== true) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(final['facts_pending'], 'facts_pending must clear once the task unwinds').toBe(false);
    const finalWarnings = (final['warnings'] ?? []) as Array<{ message: string }>;
    expect(finalWarnings.map((warning) => warning.message).join('\n')).toContain('cell 0');
    expect((final['executed'] as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(final['write_back']).toMatchObject({ performed: true });
    const written = JSON.parse(await readFile(target, 'utf8')) as { cells: Array<Record<string, unknown>> };
    expect(written.cells[0]!['execution_count']).toBe(1);
  }, 300_000);

  it('[V11-3] a run that completes normally never claims facts are pending', async () => {
    // The flag must not become noise: a normal run publishes its facts WITH its state, so a
    // client that polls once and stops is looking at a complete answer.
    const target = path.join(workspace, 'normal.ipynb');
    await writeFile(target, cellsNotebook(['x = 1']), 'utf8');
    const ctx = context();
    const started = bodyOf(
      await handleNotebookRun(ctx, { path: target, cell_selector: 'all', mode: 'auto', timeout_seconds: 120 }),
    );
    const runId = String(started['run_id']);
    const deadline = Date.now() + 120_000;
    let final: Record<string, unknown> = started;
    while (Date.now() < deadline) {
      final = bodyOf(await handleRunStatus(ctx, { run_id: runId }));
      if (final['state'] !== 'running' && final['facts_pending'] !== true) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(final['state']).toBe('completed');
    expect(final['facts_pending']).toBe(false);
    expect((final['executed'] as unknown[]).length).toBe(1);
  }, 180_000);
});

describe('[V11-3] the field is in the payload a client parses', () => {
  it('[V11-3] both payload builders carry it, and a cancel of a live run raises it', async () => {
    // A cheap shape assertion so the field cannot be dropped by a refactor no kernel case
    // happens to reach. It also pins the direction of the flag at the one place where it is
    // knowable without a kernel: a run that is still `running` HAS a background task, so
    // cancelling it lands a terminal state whose facts have not been gathered yet.
    const ctx = context();
    const handle = ctx.runStore.create('x.ipynb', 2);
    const status = bodyOf(await handleRunStatus(ctx, { run_id: handle.runId }));
    expect(Object.keys(status)).toContain('facts_pending');
    expect(status['facts_pending']).toBe(false);
    expect(status['state']).toBe('running');

    const cancel = bodyOf(await handleRunCancel(ctx, { run_id: handle.runId }));
    expect(Object.keys(cancel)).toContain('facts_pending');
    expect(cancel['state']).toBe('cancelled');
    expect(cancel['facts_pending']).toBe(true);
    // The status agrees with the cancel reply, which is the property a polling client
    // depends on: both endpoints describe the same run the same way.
    const after = bodyOf(await handleRunStatus(ctx, { run_id: handle.runId }));
    expect(after['state']).toBe('cancelled');
    expect(after['facts_pending']).toBe(true);
    // Cancelling again is idempotent (SPEC §4.8) and the flag neither flaps nor clears by
    // itself — only the task that owns it may clear it.
    const again = bodyOf(await handleRunCancel(ctx, { run_id: handle.runId }));
    expect(again).toMatchObject({ state: 'cancelled', facts_pending: true });
  });
});
