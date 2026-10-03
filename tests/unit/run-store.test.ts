// [NEW5-REPRO] the terminal state is single-writer, and progress is finalized.
import { describe, expect, it } from 'vitest';

import { RunStore } from '../../src/mcp/run-store.js';

function store(): { runs: RunStore; runId: string } {
  const runs = new RunStore();
  const handle = runs.create('/work/nb.ipynb', 1);
  return { runs, runId: handle.runId };
}

describe('[NEW5-REPRO] a terminal run state cannot be flipped afterwards', () => {
  it('settle() only accepts the FIRST terminal state', () => {
    const { runs, runId } = store();
    // The background task finishing normally…
    expect(runs.settle(runId, 'completed')).toBe(true);
    // …must not be undone by a late cancel, and vice versa.
    expect(runs.settle(runId, 'cancelled', { code: 'cancelled', message: 'late' })).toBe(false);
    expect(runs.get(runId)!.state).toBe('completed');
  });

  it('a cancel that lands first survives the background task completing', () => {
    // This is the ordering the review reproduced: `notebook_run_cancel` lands
    // `cancelled` immediately (SPEC §4.8 rule 1) and the run keeps going in the
    // background, so without single-writer settlement the client could observe
    // `cancelled` and then `completed` with `error: {code: 'cancelled'}`.
    const { runs, runId } = store();
    expect(runs.settle(runId, 'cancelled', { code: 'cancelled', message: 'run cancelled by the client' })).toBe(true);
    expect(runs.settle(runId, 'completed')).toBe(false);
    expect(runs.settle(runId, 'failed', { code: 'internal', message: 'late' })).toBe(false);
    const handle = runs.get(runId)!;
    expect(handle.state).toBe('cancelled');
    expect(handle.error).toEqual({ code: 'cancelled', message: 'run cancelled by the client' });
  });

  it('finish() still defaults a run that never reached a terminal state', () => {
    const { runs, runId } = store();
    runs.finish(runId);
    expect(runs.get(runId)!.state).toBe('failed');
    expect(runs.get(runId)!.error?.code).toBe('internal');
  });

  it('an unknown run id is not created by settle', () => {
    const runs = new RunStore();
    expect(runs.settle('run-999', 'completed')).toBe(false);
    expect(runs.get('run-999')).toBeNull();
  });
});
