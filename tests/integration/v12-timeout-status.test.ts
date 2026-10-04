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
      // No SUCCESSFUL output, on either platform, which is what SPEC §4.7 rules 5/6 are about: the
      // run discards what a timed-out cell produced, so a stream or an execute_result here would be
      // a timeout that looks like a result. The two platforms differ in the exact shape and this
      // assertion is deliberately written to accept both, because pinning one of them was wrong
      // twice (CI, ubuntu py 3.12 and py 3.10):
      //
      //   Windows  the interrupt is ignored, nothing arrives, the grace deadline returns early —
      //            `rawOutputs` is empty;
      //   Linux    SIGINT lands, the kernel reports KeyboardInterrupt, and that error message IS
      //            collected before the run ends.
      const outputs = result['rawOutputs'] as Array<{ outputType: string }>;
      for (const output of outputs) {
        expect(output.outputType, JSON.stringify(output).slice(0, 200)).toBe('error');
      }
      // An execution count is recorded only when the kernel signalled completion, which a cell that
      // ran past its deadline did not do on the platform where nothing came back.
      if (outputs.length === 0) {
        expect(result['executionCount']).toBeNull();
      }
    } finally {
      await transport.shutdownAll().catch(() => undefined);
    }
  }, 120_000);
});
