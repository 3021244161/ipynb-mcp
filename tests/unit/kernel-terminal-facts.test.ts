import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { harness, LifecycleTransport } from './kernel-lifecycle-fixture.js';

describe('[I9][I16] kernel replacement and terminal facts', () => {
  // Without factsPending in abortRuns, the first terminal poll falsely says
  // write-back is final while the completed first cell is still unwritten.
  it.each(['shutdown', 'restart'] as const)('[U24][I16] declares pending facts during %s and clears them after write-back', async (action) => {
    const backend = new LifecycleTransport({ blockShutdown: true });
    const ctx = await harness(['first', 'second'], new Map([['old-spec', backend]]));
    let stopping: Promise<Record<string, unknown>> | undefined;
    let runId: string | undefined;
    try {
      const before = await readFile(ctx.notebook, 'utf8');
      const started = await ctx.call('notebook_run', { path: ctx.notebook, mode: 'full' });
      runId = String(started['run_id']);
      await backend.secondEntered.promise;
      stopping = ctx.call('notebook_kernel', { path: ctx.notebook, action });
      await backend.shutdownEntered.promise;
      expect(await ctx.call('notebook_run_status', { run_id: runId, include_outputs: 'none' })).toMatchObject({
        state: 'failed', facts_pending: true, error: { code: 'kernel_died' },
        executed: [{ cell_index: 0, status: 'ok' }], write_back: { performed: false },
      });
      expect(await readFile(ctx.notebook, 'utf8')).toBe(before);
      backend.allowShutdown.resolve();
      await stopping;
      await vi.waitFor(() => expect(ctx.runStore.get(runId!)?.finishedAt).not.toBeNull());
      expect(await ctx.call('notebook_run_status', { run_id: runId })).toMatchObject({
        state: 'failed', facts_pending: false, executed: [{ cell_index: 0, status: 'ok' }], write_back: { performed: true },
      });
      const written = JSON.parse(await readFile(ctx.notebook, 'utf8')) as { cells: Array<{ execution_count: number | null; outputs: unknown[] }> };
      expect(written.cells[0]!.execution_count).toBe(1);
      expect(written.cells[1]).toMatchObject({ execution_count: null, outputs: [] });
    } finally {
      backend.release();
      await stopping;
      if (runId !== undefined) { await vi.waitFor(() => expect(ctx.runStore.get(runId!)?.finishedAt).not.toBeNull()); }
      await ctx.close();
    }
  });

});
