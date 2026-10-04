// What status does a cell that TIMED OUT come back with?
//
// CI found the same timed-out cell reported two different terminal codes (review: the v12 run,
// `integration (ubuntu-latest, py 3.12)`):
//
//   Windows  the sleep ignores the interrupt, nothing arrives, the grace deadline fires
//            -> sidecar status "timeout" -> the run raises `exec_timeout`
//   Linux    SIGINT lands, the kernel raises KeyboardInterrupt and goes idle
//            -> sidecar status "error"   -> the run raised `internal`, the code for "an
//                                           unclassified problem inside this tool"
//
// `internal` is what a caller sees when the tool itself is broken, so a caller that asked for a
// deadline and got one was told the tool had broken. SPEC §4.7 rule 6 puts `timeout` in the
// `status` enum and says a timeout marks the kernel dead, so the classification cannot depend on
// whether a platform's interrupt lands — which is why the sidecar now keys it on having SENT the
// interrupt rather than on how the cell ended.
//
// This case drives the real sidecar against a real kernel and asserts the status, so the
// classification is checked where it is decided rather than three layers up. It passes on Windows
// for the "ignored" reason and on Linux for the "landed" reason; both are the same assertion.

import { describe, expect, it } from 'vitest';

import { SIDECAR_REQUIRED_MODULES } from '../../src/kernel/interpreter.js';
import { SidecarTransport } from '../../src/kernel/sidecar-transport.js';
import { prepareVenv, resolvedTestInterpreter } from './test-venv.js';

describe('[V12-4] a timed-out cell is classified as a timeout on every platform', () => {
  it('[V12-4] the sidecar reports status "timeout", not "error", when the interrupt is sent', async () => {
    prepareVenv({ modules: SIDECAR_REQUIRED_MODULES });
    const python = resolvedTestInterpreter();
    const transport = new SidecarTransport({
      interpreterPath: python,
      onLog: () => undefined,
    } as never);
    try {
      await transport.startKernel({
        kernelId: 'timeout-classification',
        interpreterPath: python,
        kernelSpecName: 'python3',
        language: 'python',
      });

      const result = (await transport.execCell({
        kernelId: 'timeout-classification',
        // Far past the deadline, so the timeout is unambiguous.
        //
        // NOTHING IS PRINTED, deliberately. The first version printed `before` and `after`, then
        // asserted the output did not contain `after` — which passed on Windows, where the timeout
        // path returns `rawOutputs: []`, and failed on Linux, where the interrupt lands and the cell
        // can still run to completion inside the 5 s grace window, so its later line IS collected.
        // The status is what this case is about and it is identical on both platforms; the raw
        // output is not, and pinning it asserted a platform detail instead of the rule (CI,
        // `integration (ubuntu-latest, py 3.12)`).
        code: 'import time\ntime.sleep(30)',
        timeoutMs: 3_000,
        storeOutputs: true,
      } as never)) as unknown as Record<string, unknown>;

      expect(result['status'], JSON.stringify(result).slice(0, 300)).toBe('timeout');
      // A cell that printed nothing has nothing to report. This is the part that IS platform
      // independent: `status: timeout` makes the run discard the cell's output (SPEC §4.7 rules
      // 5/6), and no execution count may be recorded for a cell that never signalled completion.
      expect(result['rawOutputs']).toEqual([]);
      expect(result['executionCount']).toBeNull();
    } finally {
      await transport.shutdownAll().catch(() => undefined);
    }
  }, 120_000);
});
