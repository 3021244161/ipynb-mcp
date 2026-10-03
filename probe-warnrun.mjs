// Verify the RUN path carries the pre-existing-content warning to the caller
// (review v6 WARN-CODE-1: v5 only logged it there, so the model saw warnings:[]).
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = (name) => pathToFileURL(path.join(here, 'lib', name)).href;
const python = process.argv[2];
const { hasher } = await import(lib('hash.js'));
const { runNotebook } = await import(lib('run.js'));
const { KernelRegistry } = await import(lib('kernel/registry.js'));
const { createLogger } = await import(lib('log.js'));

const workspace = await mkdtemp(path.join(tmpdir(), 'warnrun-'));
const nb = path.join(workspace, 'quirky.ipynb');
await writeFile(nb, JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
  cells: [
    { cell_type: 'code', id: 'c0', metadata: {}, source: 'value = 21', outputs: [], execution_count: null },
    { cell_type: 'code', id: 'c1', metadata: {}, source: 'unused = 1', execution_count: 1,
      outputs: [{ output_type: 'display_data', data: { 'text/plain': 'no metadata' } }] },
  ],
}));

const registry = new KernelRegistry({ idleSeconds: 3600, logger: createLogger('warn') });
const outcome = await runNotebook(
  { path: nb, cellSelector: '0', mode: 'auto', timeoutSeconds: 60, writeOutputs: true, clearOutputsBefore: true, createBackup: true },
  {
    registry, hasher,
    config: {
      root: workspace, allowOutsideRoot: false, readOnly: false, images: 'auto', python,
      kernelIdleSeconds: 3600, execTimeoutSeconds: 300, backgroundThresholdSeconds: 30, backupKeep: 10,
      artifactDir: path.join(workspace, 'artifacts'), inlineTextChars: 20000, previewLines: 12,
      maxImagesPerCall: 20, maxImageBytes: 20971520, logLevel: 'warn',
    },
    imagesPolicy: 'auto',
    realpath: (t) => realpathSync(t),
    logger: createLogger('warn'),
  },
);
console.log('status:', outcome.executed[0]?.status, '| write_back:', JSON.stringify(outcome.write_back));
console.log('warnings:', JSON.stringify(outcome.warnings));
await registry.shutdownAll();
