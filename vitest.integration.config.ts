import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    fileParallelism: false, // real kernels are timing-sensitive; run files serially
    hookTimeout: 180_000,
  },
});
