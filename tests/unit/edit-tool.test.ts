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
import { findStructuralProblem, parseNotebook } from '../../src/core/parse.js';
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
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } },
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

  it('[TST-4] the same guard holds on the REAL write path, not only under dry_run', async () => {
    // The case above runs with `dry_run: true`, where "nothing was written" is
    // guaranteed by the mode rather than by the markdown gate — so it cannot show
    // that the gate stops a WRITE. The review's point exactly: the tool-layer
    // `markdown_invalid` guard had no real-write coverage (v5 TST-4, still open in
    // v6 and v7). Here dry_run is absent, the markdown is broken, and the file must
    // come back byte-identical.
    const nb = await writeNb('u8-write.ipynb', [
      { cell_type: 'markdown', id: 'md-0', metadata: {}, source: '# Good' },
    ]);
    const before = await readFile(nb);
    const { isError, body } = await runEdit({
      path: nb,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: '# Good', new_text: '# Title\n\n```python\nprint(1)' }],
    });
    expect(isError).toBe(true);
    expect(body['code']).toBe('markdown_invalid');
    // Byte-identical, not merely "the source is unchanged": a partial write or a
    // rewritten-but-equivalent file would pass the weaker assertion.
    expect(await readFile(nb)).toEqual(before);
    // And the edit is not reported as applied.
    expect(body['applied']).toBeUndefined();
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
  it('leaves neither outputs nor execution_count in the written file', async () => {
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
      cells: Array<Record<string, unknown>>;
    };
    expect(written.cells[0]!['cell_type']).toBe('markdown');
    expect(written.cells[0]!['outputs']).toBeUndefined();
    // Not `null`: the key must be ABSENT (review v4 FID-3). The structural
    // self-check would now reject the file anyway, which is the point.
    expect('execution_count' in written.cells[0]!).toBe(false);
  });

  it('[FID-4] the structural gate refuses a hand-built invalid document', async () => {
    // The gate is what makes FID-1/FID-3 impossible to write again, so it gets
    // its own assertion at the layer that writes files: if a future change
    // produces protocol-shaped outputs or markdown residue, the write must fail
    // with selfcheck_failed instead of landing.
    const { findStructuralProblem, parseNotebook } = await import('../../src/core/parse.js');
    const protocolShaped = parseNotebook(new TextEncoder().encode(JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{
        cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', execution_count: 1,
        outputs: [{ outputType: 'stream', name: 'stdout', text: '1\n' }],
      }],
    })), hasher);
    expect(findStructuralProblem(protocolShaped.doc)).toMatchObject({
      rule: 'output_type_missing',
      saw: 'outputType',
    });

    const markdownResidue = parseNotebook(new TextEncoder().encode(JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'markdown', id: 'm0', metadata: {}, source: '# hi', execution_count: null }],
    })), hasher);
    expect(findStructuralProblem(markdownResidue.doc)).toMatchObject({
      rule: 'non_code_cell_has_execution_count',
    });
  });
});

describe('[GATE-1] pre-existing content cannot lock the notebook', () => {
  // The v4 gate judged the whole DOCUMENT, which made it judge the user's INPUT
  // as well as our output. A file that already contained something we would not
  // write — a `display_data` without `metadata`, exactly what third-party tools
  // and older versions emit — made every edit and every run fail forever with
  // `selfcheck_failed` naming a cell the caller never touched. Refusing to write
  // protects the file but destroys the product (review v5 GATE-1).

  /** A notebook whose cell 1 is something we would never write ourselves. */
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
          // No `metadata`: legal in nbformat, but nbformat's own schema for
          // display_data requires it, so this is the shape that used to lock the
          // whole file. (`data` present, `metadata` absent.)
          outputs: [{ output_type: 'display_data', data: { 'text/plain': 'no metadata' } }],
        },
      ],
    }));
    return target;
  }

  it('editing an UNRELATED cell succeeds and leaves the quirk untouched', async () => {
    const nb = await writeQuirky('gate1-unrelated.ipynb');
    const before = await readFile(nb, 'utf8');
    const { isError, body } = await runEdit({
      path: nb,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 42' }],
    });
    expect(isError, `the edit was blocked: ${JSON.stringify(body)}`).toBeUndefined();
    expect(body['applied']).toBe(1);
    // And the caller is TOLD the file already contained something we would not
    // write, in the same warnings channel notebook_run uses — a log line alone
    // would inform the operator while the model, the actual consumer, went on
    // believing the file was clean.
    const warnings = body['warnings'] as Array<Record<string, unknown>>;
    // file_changed_externally is the §7 code whose trigger matches: the content
    // came from outside this tool. A 12th code would be outside the closed set
    // (review v6 WARN-CODE-1).
    expect(warnings.some((warning) => warning['code'] === 'file_changed_externally')).toBe(true);
    expect(String(warnings.find((w) => w['code'] === 'file_changed_externally')?.['message'])).toContain(
      'output_metadata_missing',
    );

    const written = JSON.parse(await readFile(nb, 'utf8')) as { cells: Array<Record<string, unknown>> };
    expect(written.cells[0]!['source']).toEqual(['x = 42']);
    // The quirk is carried forward verbatim rather than "fixed" or rejected:
    // the caller asked to change cell 0, and that is all this tool may do.
    const quirk = (written.cells[1]!['outputs'] as Array<Record<string, unknown>>)[0]!;
    expect(quirk['output_type']).toBe('display_data');
    expect('metadata' in quirk).toBe(false);
    expect(before).not.toBe(await readFile(nb, 'utf8'));
  });

  it('an edit to the QUIRKY cell itself still fails (we answer for what we touch)', async () => {
    const nb = await writeQuirky('gate1-touched.ipynb');
    const original = await readFile(nb, 'utf8');
    const { isError, body } = await runEdit({
      path: nb,
      ops: [{ op: 'replace_source', cell_index: 1, expected_text: 'y = 2', new_text: 'y = 3' }],
    });
    // Rewriting that cell's source leaves its invalid output in place, so the
    // document we would write still carries the problem we are responsible for.
    expect(isError).toBe(true);
    expect(body['code']).toBe('selfcheck_failed');
    expect(await readFile(nb, 'utf8')).toBe(original);
  });

  it('clearing the quirky cell\'s outputs is allowed (that write removes the problem)', async () => {
    const nb = await writeQuirky('gate1-cleared.ipynb');
    const { isError, body } = await runEdit({
      path: nb,
      ops: [{ op: 'clear_outputs', cell_index: 1 }],
    });
    // The touched cell is clean once its outputs are gone, so nothing is left to
    // refuse — the gate must not punish a write for a problem it just removed.
    expect(isError, `clearing was blocked: ${JSON.stringify(body)}`).toBeUndefined();
    const written = JSON.parse(await readFile(nb, 'utf8')) as { cells: Array<Record<string, unknown>> };
    expect(written.cells[1]!['outputs']).toEqual([]);
  });

  it('[GATE-2] an unrecognized output type stays acceptable for a newer minor', async () => {
    const { findStructuralProblem, parseNotebook } = await import('../../src/core/parse.js');
    const build = (minor: number, output: Record<string, unknown>): ReturnType<typeof parseNotebook> =>
      parseNotebook(new TextEncoder().encode(JSON.stringify({
        nbformat: 4,
        nbformat_minor: minor,
        metadata: {},
        cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', execution_count: 1, outputs: [output] }],
      })), hasher);

    const unknownOutput = { output_type: 'update_display_data', data: {}, metadata: {} };
    // nbformat's validator relaxes the output-type oneOf beyond the schema it
    // implements, so a file from a future minor version is VALID there. Rejecting
    // it here is a false positive that GATE-1 turned into a permanent lockout.
    expect(findStructuralProblem(build(6, unknownOutput).doc)).toBeNull();
    // Within the schema we implement, the whitelist still applies.
    expect(findStructuralProblem(build(5, unknownOutput).doc)).toMatchObject({
      rule: 'unknown_output_type',
    });

    // And the same relaxation applies to cell kinds... except that the PARSER
    // rejects an unknown cell_type long before the gate sees it. That is a
    // different, honest boundary: this tool cannot read such a notebook at all
    // (a `parse_failed`, with the file untouched), rather than reading it and
    // then refusing to write it back. Recorded here so the difference is a
    // decision on the record rather than an accident.
    expect(() =>
      parseNotebook(new TextEncoder().encode(JSON.stringify({
        nbformat: 4,
        nbformat_minor: 6,
        metadata: {},
        cells: [{ cell_type: 'someday', id: 'f0', metadata: {}, source: '' }],
      })), hasher),
    ).toThrow(/invalid cell_type/);
  });

  it('[GATE-3] execute_result.execution_count must be an integer or null', async () => {
    const { findStructuralProblem, parseNotebook } = await import('../../src/core/parse.js');
    const withCount = (count: unknown): Record<string, unknown> => ({
      output_type: 'execute_result', data: { 'text/plain': '1' }, metadata: {}, execution_count: count,
    });
    const doc = (output: Record<string, unknown>) => parseNotebook(new TextEncoder().encode(JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: '1', execution_count: 1, outputs: [output] }],
    })), hasher).doc;

    expect(findStructuralProblem(doc(withCount(3)))).toBeNull();
    expect(findStructuralProblem(doc(withCount(null)))).toBeNull();
    // Presence alone let `"3"` and `true` through, both of which nbformat
    // rejects: the gate was looser than the authority it claims to mirror.
    expect(findStructuralProblem(doc(withCount('3')))).toMatchObject({
      rule: 'execute_result_execution_count_not_an_integer',
    });
    expect(findStructuralProblem(doc(withCount(1.5)))).toMatchObject({
      rule: 'execute_result_execution_count_not_an_integer',
    });
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

describe('[D7] ops boundary: exactly 32 is accepted, 33 is not (SPEC §4.5)', () => {
  it('applies a 32-op request end to end', async () => {
    const nb = await writeNb('d7-ops32.ipynb', [codeCell('seed = 0', 'c0')]);
    const ops = Array.from({ length: 32 }, (_, i) => ({
      op: 'insert_cell',
      at_index: 0,
      cell_type: 'code',
      source: `v${i} = ${i}`,
    }));
    const { isError, body } = await runEdit({ path: nb, ops });
    expect(isError).toBeUndefined();
    expect(body['applied']).toBe(32);
    const written = JSON.parse(await readFile(nb, 'utf8')) as { cells: unknown[] };
    expect(written.cells).toHaveLength(33);
  });

  it('rejects 33 ops with invalid_arguments', async () => {
    const nb = await writeNb('d7-ops33.ipynb', [codeCell('seed = 0', 'c0')]);
    const ops = Array.from({ length: 33 }, () => ({ op: 'clear_outputs', cell_index: 0 }));
    const { isError, body } = await runEdit({ path: nb, ops });
    expect(isError).toBe(true);
    expect(body['code']).toBe('invalid_arguments');
  });
});

describe('[V8-14] the refusal must recommend an operation that actually works', () => {
  // The reviewer ran this four-step session and found step 2 impossible: the hint
  // said "clear_outputs or set_cell_type removes it", and `clear_outputs` was refused
  // by the same rule — because a cell-level count is not in the outputs that
  // operation clears. So the only exit was an operation the model was never told
  // about, and a model following the hint loops (SPEC §4.1.11: a failure must be
  // retryable in one step).

  /** A code cell with a legal shape except for its negative execution count. */
  async function negativeCountNotebook(name: string): Promise<string> {
    const nb = path.join(workspace, name);
    await writeFile(nb, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
      cells: [
        {
          cell_type: 'code',
          id: 'c0',
          metadata: {},
          source: 'x = 1',
          outputs: [{ output_type: 'stream', name: 'stdout', text: 'stale\n' }],
          execution_count: -1,
        },
        { cell_type: 'code', id: 'c1', metadata: {}, source: 'y = 2', outputs: [], execution_count: null },
      ],
    }));
    return nb;
  }

  it('step 1: rewriting the cell is refused, and the hint states what the operations do', async () => {
    const nb = await negativeCountNotebook('v814-a.ipynb');
    const { isError, body } = await runEdit({
      path: nb,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 2' }],
    });
    expect(isError).toBe(true);
    expect(body['code']).toBe('selfcheck_failed');
    const detail = body['detail'] as Record<string, unknown>;
    expect(detail['problem']).toMatchObject({ rule: 'execution_count_negative' });
    // V9-8: the hint must be TRUE, not merely mention an operation. v8 asserted
    // `toContain('clear_outputs')` and the sentence it pinned claimed the operation
    // "resets the cell execution count" — which SPEC §4.5 rule 5 forbids, which
    // `edit.ts` deliberately does not do, and which step 2 below now measures.
    const hint = String(detail['hint'] ?? '');
    expect(hint).toContain('execution_count_negative');
    expect(hint).toContain('clear_outputs');
    expect(hint).toContain('does not change the count');
    expect(hint).toContain('set_cell_type');
  });

  it('step 2: the recommended clear_outputs SUCCEEDS and leaves a file the gate accepts', async () => {
    const nb = await negativeCountNotebook('v814-b.ipynb');
    const { isError, body } = await runEdit({
      path: nb,
      ops: [{ op: 'clear_outputs', cell_index: 0 }],
    });
    expect(body['code'], `clear_outputs was refused: ${JSON.stringify(body)}`).toBeUndefined();
    expect(isError).toBeUndefined();
    expect((body['changed_cells'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      outputs_cleared: true,
    });

    // SPEC §4.5 rule 5: the count is NOT touched by this operation. That is exactly
    // what the hint has to say, and the reason the file is nevertheless accepted:
    // with the outputs gone, the count is no longer part of any rule the gate applies.
    const written = JSON.parse(await readFile(nb, 'utf8')) as {
      cells: Array<Record<string, unknown>>;
    };
    expect(written.cells[0]!['outputs']).toEqual([]);
    expect(written.cells[0]!['execution_count']).toBe(-1);
    expect(findStructuralProblem(parseNotebook(new TextEncoder().encode(await readFile(nb, 'utf8')), hasher).doc))
      .toBeNull();
  });

  it('step 2b: the hint is a promise — a SECOND edit of the cleared cell is not refused', async () => {
    // The reviewer's four-step session: after following the hint, the model carries
    // on working. v8's version of this file left the notebook INVALID, so the next
    // unrelated edit would have failed again.
    const nb = await negativeCountNotebook('v814-b2.ipynb');
    await runEdit({ path: nb, ops: [{ op: 'clear_outputs', cell_index: 0 }] });
    const { isError, body } = await runEdit({
      path: nb,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 42' }],
    });
    expect(body['code'], JSON.stringify(body)).toBeUndefined();
    expect(isError).toBeUndefined();
  });

  it('step 3: the other recommended operation (set_cell_type) also works', async () => {
    const nb = await negativeCountNotebook('v814-c.ipynb');
    const { isError, body } = await runEdit({
      path: nb,
      ops: [{ op: 'set_cell_type', cell_index: 0, cell_type: 'markdown', expected_text: 'x = 1' }],
    });
    expect(isError).toBeUndefined();
    expect((body['changed_cells'] as Array<Record<string, unknown>>)[0]).toMatchObject({ cell_index: 0 });
    const written = JSON.parse(await readFile(nb, 'utf8')) as { cells: Array<Record<string, unknown>> };
    // A markdown cell cannot carry a count, so the rule is gone with the cell type.
    expect('execution_count' in written.cells[0]!).toBe(false);
  });

  it('step 4: an unrelated cell is never blocked by it (the control)', async () => {
    const nb = await negativeCountNotebook('v814-d.ipynb');
    const { isError } = await runEdit({
      path: nb,
      ops: [{ op: 'replace_source', cell_index: 1, expected_text: 'y = 2', new_text: 'y = 3' }],
    });
    expect(isError).toBeUndefined();
  });

  it('the count rule still refuses a write that is NOT clearing those outputs', async () => {
    // The gate must not have been disabled wholesale: the same cell, edited in a way
    // that leaves the outputs in place, is still refused.
    const nb = await negativeCountNotebook('v814-e.ipynb');
    const { isError, body } = await runEdit({
      path: nb,
      ops: [{ op: 'replace_lines', cell_index: 0, start_line: 1, end_line: 1, new_text: 'x = 9', expected_text: 'x = 1' }],
    });
    expect(isError).toBe(true);
    expect(body['code'], JSON.stringify(body)).toBe('selfcheck_failed');
    expect((body['detail'] as Record<string, unknown>)['problem']).toMatchObject({
      rule: 'execution_count_negative',
    });
  });

  it('the skip is scoped to the cell whose rule is gone, not to the whole request', async () => {
    // A request that clears ONE cell's outputs while rewriting another. Cell 1's
    // outputs are NOT empty, so its negative count still belongs to something and the
    // rule still applies to it. Without this the implementation could pass everything
    // above by skipping the rule whenever any cell was cleared.
    const nb = await negativeCountNotebook('v814-f.ipynb');
    const doc = JSON.parse(await readFile(nb, 'utf8')) as { cells: Array<Record<string, unknown>> };
    doc.cells[1]!['execution_count'] = -5;
    doc.cells[1]!['outputs'] = [{ output_type: 'stream', name: 'stdout', text: 'kept\n' }];
    await writeFile(nb, JSON.stringify(doc));

    const { isError, body } = await runEdit({
      path: nb,
      ops: [
        { op: 'clear_outputs', cell_index: 0 },
        { op: 'replace_source', cell_index: 1, expected_text: 'y = 2', new_text: 'y = 3' },
      ],
    });
    expect(isError).toBe(true);
    expect(body['code']).toBe('selfcheck_failed');
    // The refusal points at cell 1 — the one that still has outputs to carry the count.
    expect((body['detail'] as Record<string, unknown>)['problem']).toMatchObject({
      rule: 'execution_count_negative',
      cell_index: 1,
    });
  });

  it('[V9-8] the escape hatch is stable: the NEXT edit of the cleared cell is accepted', async () => {
    // The reviewer's four-step session ends by carrying on. v8's fix made the cleared
    // cell acceptable for exactly one call (`outputs_cleared` is a property of the
    // REQUEST), so the model's next edit was refused by the rule it had just been told
    // was handled (review v9 V9-8). Both halves are asserted here: the count is still
    // in the file (SPEC §4.5 rule 5), and the rule no longer applies to that cell.
    const nb = await negativeCountNotebook('v814-g.ipynb');
    await runEdit({ path: nb, ops: [{ op: 'clear_outputs', cell_index: 0 }] });
    const { isError, body } = await runEdit({
      path: nb,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 2' }],
    });
    expect(body['code'], JSON.stringify(body)).toBeUndefined();
    expect(isError).toBeUndefined();
    const written = JSON.parse(await readFile(nb, 'utf8')) as { cells: Array<Record<string, unknown>> };
    expect(written.cells[0]!['execution_count']).toBe(-1);
    expect(written.cells[0]!['outputs']).toEqual([]);
  });
});
