import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // The default suite is not as isolated as its name suggests: it talks to a REAL
    // sidecar (`tests/unit/analyze-op.test.ts` probes kernel startup and the symtable
    // analyzer) and shares one test venv at `IPYNB_TEST_VENV` with the integration
    // suite. Two files running at once can race on that venv, and `pnpm test` next to
    // `pnpm test:integration` is a window in which one suite deletes what the other is
    // using (review v8 V8-12, still open in v9). Serial files close the in-suite half
    // of that window; the flag is the same one the integration config has needed since
    // real kernels made it necessary there.
    fileParallelism: false,
  },
});
