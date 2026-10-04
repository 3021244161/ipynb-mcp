// The run path's image warnings (review v12 V12-3, D-057).
//
// The read path was fixed in v11: three cells each holding a broken image produce three
// DISTINCT warnings ("image at cell 0/1/2 (output 0) failed to decode"). The run path kept
// deduplicating `applyImagePolicy`'s warnings BY CODE, and `image_materialize_failed` is the
// same code for every cell — so three broken images produced ONE warning naming only `cell 0`,
// and cells 1 and 2 had no attribution anywhere in the response.
//
// The second half of the finding is why this file exists at all: that code path had NO test.
// A subagent mutation (`if (false)` at `src/run.ts`'s warning loop) left all 595 unit cases
// green, so the "same message now means the same fact" claim in D-057 was unguarded on the run
// side. The case below fails if that loop is shortened to a single warning, or disabled.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IpynbConfig } from '../../src/config.js';
import { hasher } from '../../src/hash.js';
import { SIDECAR_REQUIRED_MODULES } from '../../src/kernel/interpreter.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { createLogger } from '../../src/log.js';
import { runNotebook, type RunDeps } from '../../src/run.js';
import { prepareVenv, resolvedTestInterpreter } from './test-venv.js';

let workspace: string;
let artifactRoot: string;
let registry: KernelRegistry;

beforeAll(async () => {
  prepareVenv({ modules: SIDECAR_REQUIRED_MODULES });
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-v12-images-'));
  artifactRoot = path.join(workspace, 'artifacts');
  registry = new KernelRegistry({ idleSeconds: 3600, logger: createLogger('error') });
  registry.start();
}, 180_000);

afterAll(async () => {
  await registry.shutdownAll();
  await rm(workspace, { recursive: true, force: true });
}, 120_000);

function config(): IpynbConfig {
  return {
    root: workspace,
    allowOutsideRoot: false,
    readOnly: false,
    images: 'auto',
    python: resolvedTestInterpreter(),
    kernelIdleSeconds: 3600,
    execTimeoutSeconds: 300,
    backgroundThresholdSeconds: 30,
    backupKeep: 10,
    artifactDir: artifactRoot,
    inlineTextChars: 20000,
    previewLines: 12,
    maxImagesPerCall: 20,
    maxImageBytes: 20971520,
    logLevel: 'error',
  };
}

function deps(): RunDeps {
  return {
    registry,
    hasher,
    config: config(),
    imagesPolicy: 'auto',
    realpath: (target: string) => target,
    platform: process.platform,
  };
}

/**
 * Three cells, each displaying an image value that cannot be decoded.
 *
 * `[1, 2, 3]` is the shape v10-5 closed: nbformat accepts an array of strings for a mime value,
 * and an array of NUMBERS is not one — so it takes the documented `image_materialize_failed`
 * route rather than being joined into `"123"` and served as a 2-byte "image".
 */
const CELLS = [0, 1, 2].map(() => "display({'image/png': [1, 2, 3]}, raw=True)");

function notebookText(): string {
  return `${JSON.stringify(
    {
      cells: CELLS.map((source, index) => ({
        cell_type: 'code',
        execution_count: null,
        id: `c${String(index)}`,
        metadata: {},
        outputs: [],
        source,
      })),
      metadata: {
        kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
        language_info: { name: 'python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  )}\n`;
}

describe('[V12-3] a run reports one image failure per cell, not one per code', () => {
  it('[V12-3] three cells with a broken image produce three distinguishable warnings', async () => {
    const target = path.join(workspace, 'three-broken-images.ipynb');
    await writeFile(target, notebookText(), 'utf8');

    const outcome = await runNotebook(
      {
        path: target,
        cellSelector: 'all',
        mode: 'auto',
        timeoutSeconds: 120,
        writeOutputs: true,
        clearOutputsBefore: false,
        createBackup: false,
      },
      deps(),
    );

    // The three cells ran and each produced an image item with no bytes — the failure is real
    // and per cell, which is what makes a single warning wrong.
    expect(outcome.executed).toHaveLength(3);
    for (const [index, executed] of outcome.executed.entries()) {
      expect(executed.status, `cell ${String(index)}`).toBe('ok');
      const images = executed.outputs.filter((item) => item.kind === 'image');
      expect(images, `cell ${String(index)} must have an image item`).toHaveLength(1);
      expect(images[0]).toMatchObject({ bytes: 0, artifact_path: null, image_index: null });
    }

    const failures = outcome.warnings.filter((warning) => warning.code === 'image_materialize_failed');
    const messages = failures.map((warning) => warning.message);
    // THE ASSERTION. By code this was one; by message it is three, one per cell.
    expect(messages, `warnings were: ${JSON.stringify(messages)}`).toHaveLength(3);
    expect(new Set(messages).size, 'each cell must be named').toBe(3);
    for (const [index, message] of messages.entries()) {
      expect(message, 'the message identifies the cell').toContain(`cell ${String(index)}`);
    }
    // Same shape as the read path, so a client can read both without special-casing.
    expect(messages[0]).toContain('(output 0)');
    expect(messages[0]).toContain('artifact_path and image_index stay null');
  }, 180_000);

  it('[V12-3] a second run of the same notebook does not accumulate duplicates', async () => {
    // The other side of changing a dedup key: warnings are per call, so running the same three
    // cells again must still report three — not six.
    const target = path.join(workspace, 'three-broken-images.ipynb');
    const outcome = await runNotebook(
      {
        path: target,
        cellSelector: 'all',
        mode: 'auto',
        timeoutSeconds: 120,
        writeOutputs: true,
        clearOutputsBefore: false,
        createBackup: false,
      },
      deps(),
    );
    expect(outcome.warnings.filter((warning) => warning.code === 'image_materialize_failed')).toHaveLength(3);
  }, 180_000);
});
