// Tool-level edit tests (review D3): the CAS "never writes on failure"
// contract and dry_run semantics must be verified through the real tool
// handler on real files — core-level assertions on applyEditOps alone are
// tautological when nothing ever wrote the file.

import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IpynbConfig } from '../../src/config.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import type { ToolContext } from '../../src/mcp/context.js';
import { handleNotebookEdit } from '../../src/mcp/tools/edit.js';
import { toCallToolResult } from '../../src/mcp/tools/result.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { PathFence } from '../../src/fs/fence.js';
import { createLogger } from '../../src/log.js';

let workspace: string;
let ctx: ToolContext;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-edit-tool-'));
  const config: IpynbConfig = {
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
    logLevel: 'error',
  };
  ctx = {
    config,
    fence: new PathFence(workspace, false, process.platform),
    registry: new KernelRegistry({ idleSeconds: 3600, logger: createLogger('error') }),
    runStore: new RunStore(),
    hasher,
    logger: createLogger('error'),
    realpath: (target) => realpathSync(target),
    platform: process.platform,
  };
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function writeNb(name: string, cells: Array<Record<string, unknown>>): Promise<string> {
  const target = path.join(workspace, name);
  await writeFile(target, JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3' }, language_info: { name: 'python' } },
    cells,
  }));
  return target;
}

function codeCell(source: string, id: string): Record<string, unknown> {
  return { cell_type: 'code', id, metadata: {}, source, outputs: [], execution_count: null };
}

async function runEdit(args: Record<string, unknown>): Promise<{ isError?: boolean; body: Record<string, unknown> }> {
  const outcome = await handleNotebookEdit(ctx, args);
  const result = toCallToolResult(outcome);
  const text = result.content.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('');
  return { isError: result.isError, body: JSON.parse(text) as Record<string, unknown> };
}

describe('[U2][D3] a mismatched anchor fails through the tool layer without writing', () => {
  it('returns cas_mismatch and leaves the file byte-identical with no backup', async () => {
    const nb = await writeNb('u2-tool.ipynb', [codeCell('a = 1\nb = 2', 'c0')]);
    const before = await readFile(nb);
    const backupsBefore = (await readdir(workspace)).filter((n) => n.endsWith('.bak'));

    const { isError, body } = await runEdit({
      path: nb,
      ops: [{ op: 'replace_lines', cell_index: 0, start_line: 1, end_line: 1, expected_text: 'WRONG', new_text: 'a = 99' }],
    });
    expect(isError).toBe(true);
    expect(body['code']).toBe('cas_mismatch');
    const detail = (body['detail'] ?? {}) as Record<string, unknown>;
    expect(detail['failed_op_index']).toBe(0);

    expect(await readFile(nb)).toEqual(before);
    const backupsAfter = (await readdir(workspace)).filter((n) => n.endsWith('.bak'));
    expect(backupsAfter).toEqual(backupsBefore);
  });

  it('the retry with the reported current hash succeeds in ONE round trip', async () => {
    const nb = await writeNb('u2-retry.ipynb', [codeCell('a = 1\nb = 2', 'c0')]);
    const fail = await runEdit({
      path: nb,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'stale', new_text: 'a = 9' }],
    });
    const detail = (fail.body['detail'] ?? {}) as Record<string, unknown>;
    const currentHash = String(detail['current_source_hash']);
    expect(currentHash).toMatch(/^sha256:/);

    const ok = await runEdit({
      path: nb,
      ops: [{ op: 'replace_source', cell_index: 0, expected_source_hash: currentHash, new_text: 'a = 9' }],
    });
    expect(ok.isError).toBeUndefined();
    const changed = ok.body['changed_cells'] as Array<Record<string, unknown>>;
    expect(changed[0]!['new_source_hash']).toBe(`sha256:${hasher.sha256Hex('a = 9')}`);
    const written = JSON.parse(await readFile(nb, 'utf8')) as { cells: Array<{ source: unknown }> };
    expect(written.cells[0]!.source).toEqual(['a = 9']);
  });
});

describe('[U8][D3] dry_run computes everything and writes nothing', () => {
  it('error-severity markdown issues fail even in dry_run, and nothing is written', async () => {
    // The markdown gate is semantic, not about writing: an unclosed fence
    // must fail the request regardless of dry_run.
    const nb = await writeNb('u8-tool.ipynb', [
      { cell_type: 'markdown', id: 'md-0', metadata: {}, source: '# Good' },
    ]);
    const before = await readFile(nb);
    const { isError, body } = await runEdit({
      path: nb,
      dry_run: true,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: '# Good', new_text: '# Title\n\n```python\nprint(1)' }],
    });
    expect(isError).toBe(true);
    expect(body['code']).toBe('markdown_invalid');
    expect(await readFile(nb)).toEqual(before);
  });

  it('warning-severity markdown issues appear in the dry-run payload without writing', async () => {
    const nb = await writeNb('u8-warn.ipynb', [
      { cell_type: 'markdown', id: 'md-0', metadata: {}, source: '# Good' },
    ]);
    const before = await readFile(nb);
    const { body } = await runEdit({
      path: nb,
      dry_run: true,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: '# Good', new_text: '# a\n### jumped' }],
    });
    expect(body['backup_path']).toBeNull();
    expect(body['content_hash_after']).toBe(body['content_hash_before']);
    expect((body['markdown_issues'] as unknown[]).length).toBeGreaterThan(0);
    expect(await readFile(nb)).toEqual(before);
  });

  it('a non-dry run of the same edit DOES write and back up', async () => {
    const nb = await writeNb('u8-write.ipynb', [
      { cell_type: 'markdown', id: 'md-0', metadata: {}, source: '# Good' },
    ]);
    const { body } = await runEdit({
      path: nb,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: '# Good', new_text: '# a\n### jumped' }],
    });
    expect(body['backup_path']).not.toBeNull();
    expect(existsSync(String(body['backup_path']))).toBe(true);
    expect(body['content_hash_after']).not.toBe(body['content_hash_before']);
  });
});

describe('[U9][D3] set_cell_type to markdown through the tool layer', () => {
  it('deletes outputs and nulls execution_count in the written file', async () => {
    const nb = await writeNb('u9-tool.ipynb', [
      {
        cell_type: 'code', id: 'c0', metadata: {}, source: 'print(1)',
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
        execution_count: 5,
      },
    ]);
    const { isError } = await runEdit({
      path: nb,
      ops: [{ op: 'set_cell_type', cell_index: 0, cell_type: 'markdown', expected_text: 'print(1)' }],
    });
    expect(isError).toBeUndefined();
    const written = JSON.parse(await readFile(nb, 'utf8')) as {
      cells: Array<{ cell_type: string; outputs?: unknown; execution_count?: unknown }>;
    };
    expect(written.cells[0]!.cell_type).toBe('markdown');
    expect(written.cells[0]!.outputs).toBeUndefined();
    expect(written.cells[0]!.execution_count).toBeNull();
  });
});

describe('[U12][D3] tool-level optimistic lock on expected_content_hash', () => {
  it('a stale expected_content_hash raises file_changed with expected/actual in detail', async () => {
    const nb = await writeNb('u12-tool.ipynb', [codeCell('x = 1', 'c0')]);
    const staleHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    const { isError, body } = await runEdit({
      path: nb,
      expected_content_hash: staleHash,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 2' }],
    });
    expect(isError).toBe(true);
    expect(body['code']).toBe('file_changed');
    const detail = (body['detail'] ?? {}) as Record<string, unknown>;
    expect(detail['expected']).toBe(staleHash);
    expect(String(detail['actual'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Nothing was written.
    const written = JSON.parse(await readFile(nb, 'utf8')) as { cells: Array<{ source: unknown }> };
    expect(written.cells[0]!.source).toBe('x = 1');
  });
});
