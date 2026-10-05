// The warning that a write preserved content this tool would not have written.
//
// Review v6 WARN-CODE-1: v5 minted a 12th warning code for this, outside SPEC §7's
// closed set, and `notebook_run` never delivered it at all — only the edit path
// did. Both halves are pinned here: the code must come from the table, and BOTH
// write paths must return it.
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IpynbConfig } from '../../src/config.js';
import { PREEXISTING_CONTENT_WARNING, WARNING_CODES } from '../../src/core/errors.js';
import { PREEXISTING_CONTENT_PREFIX } from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { PathFence } from '../../src/fs/fence.js';
import { createLogger } from '../../src/log.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { handleNotebookEdit } from '../../src/mcp/tools/edit.js';
import { toCallToolResult } from '../../src/mcp/tools/result.js';

let workspace: string;
let registry: KernelRegistry;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-warn-'));
  registry = new KernelRegistry({ idleSeconds: 3600, logger: createLogger('error') });
});

afterAll(async () => {
  await registry.shutdownAll();
  await rm(workspace, { recursive: true, force: true });
});

function config(): IpynbConfig {
  return {
    root: workspace,
    allowOutsideRoot: false,
    readOnly: false,
    images: 'auto',
    python: null,
    kernelIdleSeconds: 3600,
    execTimeoutSeconds: 300,
    backgroundThresholdSeconds: 30,
    backupKeep: 10,
    artifactDir: path.join(workspace, 'artifacts'),
    inlineTextChars: 20000,
    previewLines: 12,
    maxImagesPerCall: 20,
    maxImageBytes: 20971520,
    maxResponseBytes: 8_388_608,
    logLevel: 'error',
  };
}

/** A notebook whose cell 1 is something this tool would never write itself. */
async function writeQuirky(name: string): Promise<string> {
  const target = path.join(workspace, name);
  await writeFile(target, JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [
      { cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', outputs: [], execution_count: null },
      {
        cell_type: 'code', id: 'c1', metadata: {}, source: 'y = 2', execution_count: 1,
        outputs: [{ output_type: 'display_data', data: { 'text/plain': 'no metadata' } }],
      },
    ],
  }));
  return target;
}

describe('[WARN-CODE-1] the pre-existing-content warning obeys the closed code set', () => {
  it('the code is one of the eleven SPEC §7 warnings', () => {
    expect(WARNING_CODES).toHaveLength(11);
    expect(WARNING_CODES).toContain(PREEXISTING_CONTENT_WARNING);
  });

  it('notebook_edit returns it in warnings[]', async () => {
    const nb = await writeQuirky('warn-edit.ipynb');
    const outcome = await handleNotebookEdit(
      {
        config: config(),
        fence: new PathFence(workspace, false, process.platform),
        registry,
        runStore: new RunStore(),
        hasher,
        logger: createLogger('error'),
        realpath: (target) => realpathSync(target),
        platform: process.platform,
      },
      { path: nb, ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 2' }] },
    );
    const result = toCallToolResult(outcome);
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(String((result.content[0] as { text?: string }).text ?? '{}')) as {
      warnings?: Array<{ code: string; message: string }>;
    };
    const warning = body.warnings?.find((entry) => entry.code === PREEXISTING_CONTENT_WARNING);
    expect(warning, `warnings were ${JSON.stringify(body.warnings)}`).toBeDefined();
    expect(warning!.message).toContain('output_metadata_missing');
    // The code is BORROWED (§7's `file_changed_externally` means "an external
    // change was detected"), so the message carries a fixed machine-readable prefix
    // that says what actually happened. A client that branches on the code alone
    // would discard CAS state or retry for a file nobody touched (review v7
    // WARN-CODE-2 / D-041).
    expect(warning!.message.startsWith(PREEXISTING_CONTENT_PREFIX)).toBe(true);
    // The quirk is carried forward, so the file still fails nbformat — the
    // documented trade-off this warning is the signal for.
    const written = JSON.parse(await readFile(nb, 'utf8')) as { cells: Array<Record<string, unknown>> };
    expect((written.cells[1]!['outputs'] as Array<Record<string, unknown>>)[0]!['metadata']).toBeUndefined();
  });
});
