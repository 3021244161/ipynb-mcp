// Temporary perf check for the NDJSON framer (review v3 PERF-1).
import { NdjsonFramer } from './lib/kernel/protocol.js';

const MB = 1024 * 1024;
for (const totalMb of [8, 32, 64]) {
  const total = totalMb * MB;
  const framer = new NdjsonFramer();
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const started = process.hrtime.bigint();
  let fed = 0;
  while (fed + chunk.length < total) {
    framer.push(chunk);
    fed += chunk.length;
  }
  framer.push(Buffer.concat([chunk.subarray(0, total - fed), Buffer.from('\n')]));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`${totalMb} MiB line: ${ms.toFixed(0)} ms`);
}
