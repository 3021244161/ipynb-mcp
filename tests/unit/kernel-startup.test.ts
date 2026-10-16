import { describe, expect, it, vi } from 'vitest';

import type { KernelRegistry } from '../../src/kernel/registry.js';
import { harness, LifecycleTransport } from './kernel-lifecycle-fixture.js';

describe('[I9][I16] kernel replacement and terminal facts', () => {
  // A shutdown that ignores pending starts leaves an old kernel registered
  // before the replacement, so notebook lookup executes in the old interpreter.
  it.each(['old-spec', 'new-spec'])('[U24][I9][I16] retires a pending startup before replacement with %s', async (replacementSpec) => {
    const oldBackend = new LifecycleTransport({ blockStart: true });
    const newBackend = replacementSpec === 'old-spec' ? oldBackend : new LifecycleTransport({ blockStart: true });
    const ctx = await harness(['first'], new Map([['old-spec', oldBackend], [replacementSpec, newBackend]]));
    const input = { notebookPath: ctx.notebook, interpreterPath: 'old-spec', kernelSpecName: 'old-spec', language: 'python' };
    const initial = ctx.registry.getOrCreate(input);
    let replacement: ReturnType<KernelRegistry['getOrCreate']> | undefined;
    try {
      await oldBackend.startEntered.promise;
      await ctx.writeNotebook(replacementSpec);
      replacement = ctx.registry.shutdown(ctx.notebook).then(() => ctx.registry.getOrCreate({ ...input, interpreterPath: replacementSpec, kernelSpecName: replacementSpec }));
      oldBackend.allowStart.resolve();
      const oldSession = await initial;
      newBackend.allowStart.resolve();
      const restarted = await replacement;
      expect(oldBackend.closedKernelIds).toContain(oldSession.kernelId);
      expect(restarted.kernelId).not.toBe(oldSession.kernelId);
      expect(ctx.registry.listKernels().map((session) => session.kernelId)).toEqual([restarted.kernelId]);
      expect(ctx.registry.findByNotebook(ctx.notebook)?.kernelId).toBe(restarted.kernelId);
      const started = await ctx.call('notebook_run', { path: ctx.notebook, mode: 'full', write_outputs: false });
      const runId = String(started['run_id']);
      await vi.waitFor(() => expect(ctx.runStore.get(runId)?.finishedAt).not.toBeNull());
      expect(await ctx.call('notebook_run_status', { run_id: runId })).toMatchObject({ state: 'completed', kernel_id: restarted.kernelId });
      expect(newBackend.executedKernelIds).toEqual([restarted.kernelId]);
    } finally {
      oldBackend.release();
      newBackend.release();
      await initial;
      await replacement;
      await ctx.close();
    }
  });
});
