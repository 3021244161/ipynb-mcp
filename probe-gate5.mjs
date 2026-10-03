// Reproduce the two kernel-driven defects the v6 review found, against the real
// stack: a plain user cell sending a non-string mime value.
//
//   GATE-5  (🔴) display({'text/plain': 5}, raw=True) used to write a file
//                nbformat.validate rejects, with write_back.performed and NO
//                warning.
//   CRASH-1 (🟠) display({'image/png': 123}, raw=True) used to abort the run with
//                `internal` / "base64.replace is not a function".
import path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = (name) => pathToFileURL(path.join(here, 'lib', name)).href;
const python = process.argv[2];
const { hasher } = await import(lib('hash.js'));
const { runNotebook } = await import(lib('run.js'));
const { KernelRegistry } = await import(lib('kernel/registry.js'));
const { createLogger } = await import(lib('log.js'));

const workspace = await mkdtemp(path.join(tmpdir(), 'gate5-'));
const registry = new KernelRegistry({ idleSeconds: 3600, logger: createLogger('warn') });
const deps = {
  registry,
  hasher,
  config: {
    root: workspace, allowOutsideRoot: false, readOnly: false, images: 'auto', python,
    kernelIdleSeconds: 3600, execTimeoutSeconds: 300, backgroundThresholdSeconds: 30, backupKeep: 10,
    artifactDir: path.join(workspace, 'artifacts'), inlineTextChars: 20000, previewLines: 12,
    maxImagesPerCall: 20, maxImageBytes: 20971520, logLevel: 'warn',
  },
  imagesPolicy: 'auto',
  realpath: (t) => realpathSync(t),
  logger: createLogger('warn'),
};

async function probe(label, source) {
  const nb = path.join(workspace, `${label}.ipynb`);
  await writeFile(nb, JSON.stringify({
    nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source, outputs: [], execution_count: null }],
  }));
  let outcome;
  let failure = null;
  try {
    outcome = await runNotebook(
      { path: nb, cellSelector: 'all', mode: 'auto', timeoutSeconds: 60, writeOutputs: true, clearOutputsBefore: true, createBackup: true },
      deps,
    );
  } catch (cause) {
    failure = cause;
  }
  const validation = spawnSync(python, ['-c', 'import sys, nbformat; nbformat.validate(nbformat.read(sys.argv[1], as_version=4))', nb], { timeout: 30_000 });
  const written = JSON.parse(await readFile(nb, 'utf8'));
  console.log(`--- ${label} ---`);
  if (failure !== null) {
    console.log('  run threw:', failure.code ?? failure.name, '|', String(failure.message).slice(0, 90));
    console.log('  detail:', JSON.stringify(failure.detail ?? {}).slice(0, 160));
  } else {
    console.log('  run status:', outcome.executed[0]?.status, '| write_back:', JSON.stringify(outcome.write_back));
    console.log('  warnings:', JSON.stringify(outcome.warnings));
  }
  console.log('  stored:', JSON.stringify(written.cells[0].outputs).slice(0, 150));
  console.log('  nbformat.validate:', validation.status === 0 ? 'VALID' : `INVALID: ${validation.stderr.toString().split('\n').filter(Boolean).pop()}`);
}

await probe('gate5-text-number', "from IPython.display import display\ndisplay({'text/plain': 5}, raw=True)");
await probe('crash1-image-number', "from IPython.display import display\ndisplay({'image/png': 123}, raw=True)");
await probe('gate5-traceback-number', "from IPython.display import display\ndisplay({'application/x-thing': [1, 2]}, raw=True)");
await registry.shutdownAll();
