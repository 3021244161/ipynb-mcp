import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyEditOps, type EditOpInput } from '../../src/core/edit.js';
import { IpynbError } from '../../src/core/errors.js';
import { cellSource, cellSourceHash, parseNotebook, serializeNotebook } from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-edit-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function notebookJson(cells: Array<Record<string, unknown>>, minor = 5): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: minor,
    metadata: { kernelspec: { name: 'python3' } },
    cells,
  });
}

function codeCell(source: string, id: string, outputs: unknown[] = [], executionCount: number | null = null): Record<string, unknown> {
  return { cell_type: 'code', id, metadata: {}, source, outputs, execution_count: executionCount };
}

async function parseFile(name: string, json: string) {
  const target = path.join(dir, name);
  await writeFile(target, json);
  const bytes = await readFile(target);
  return { target, notebook: parseNotebook(bytes, hasher), bytes };
}

function apply(notebook: ReturnType<typeof parseNotebook>, ops: readonly EditOpInput[], minor = 5) {
  return applyEditOps(notebook, ops, { hasher, nbformatMinor: minor });
}

function expectError(action: () => unknown): IpynbError {
  try {
    action();
    throw new Error('expected IpynbError');
  } catch (cause) {
    if (cause instanceof IpynbError) {
      return cause;
    }
    throw cause;
  }
}

describe('[step4][U2] replace_lines with mismatched expected_text', () => {
  it('fails with cas_mismatch, leaves the file untouched, and reports a retryable anchor', async () => {
    const json = notebookJson([codeCell('a = 1\nb = 2\nc = 3', 'cell-0')]);
    const { target, notebook, bytes } = await parseFile('u2.ipynb', json);

    const err = expectError(() =>
      apply(notebook, [
        { op: 'replace_lines', cell_index: 0, start_line: 2, end_line: 2, expected_text: 'WRONG', new_text: 'b = 20' },
      ]),
    );
    expect(err.code).toBe('cas_mismatch');
    const detail = err.detail as Record<string, unknown>;
    expect(detail['anchor']).toBe('line_text');
    expect(detail['actual']).toBe('b = 2'); // the true text of line 2
    expect(detail['expected']).toBe('WRONG');
    expect(String(detail['current_source_hash'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(detail['current_source']).toBe('a = 1\nb = 2\nc = 3');
    expect(detail['current_source_truncated']).toBe(false);

    // Caller (tool layer) drops the model on error; file bytes unchanged.
    expect(await readFile(target)).toEqual(bytes);

    // One-retry contract: model retries with the reported current_source_hash.
    const retry = apply(parseNotebook(bytes, hasher), [
      { op: 'replace_lines', cell_index: 0, start_line: 2, end_line: 2, expected_source_hash: String(detail['current_source_hash']), expected_text: 'b = 2', new_text: 'b = 20' },
    ]);
    expect(retry.applied).toBe(1);
  });
});

describe('[step4][U3] the same anchor cannot be used twice', () => {
  it('first application succeeds, second fails with cas_mismatch', async () => {
    const json = notebookJson([codeCell('x = 1', 'cell-0')]);
    const { notebook, bytes } = await parseFile('u3.ipynb', json);
    const anchor = { op: 'replace_source' as const, cell_index: 0, expected_text: 'x = 1', new_text: 'x = 2' };

    const first = apply(notebook, [anchor]);
    expect(first.applied).toBe(1);

    // Second request re-parses the (would-be) written file: same old anchor now mismatches.
    const serialized = serializeNotebook(notebook);
    const reloaded = parseNotebook(new TextEncoder().encode(serialized), hasher);
    const err = expectError(() => apply(reloaded, [anchor]));
    expect(err.code).toBe('cas_mismatch');
    void bytes;
  });

  it('also holds within a single request (sequential application)', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([codeCell('x = 1', 'cell-0')])),
      hasher,
    );
    const err = expectError(() =>
      apply(notebook, [
        { op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 2' },
        { op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 3' },
      ]),
    );
    expect(err.code).toBe('cas_mismatch');
    expect((err.detail as Record<string, unknown>)['failed_op_index']).toBe(1);
  });
});

describe('[step4][U5] hash anchor alone is sufficient', () => {
  it('replace_source with only expected_source_hash succeeds', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([codeCell('x = 1', 'cell-0')])),
      hasher,
    );
    const hash = cellSourceHash(notebook.cells[0]!, hasher);
    const result = apply(notebook, [
      { op: 'replace_source', cell_index: 0, expected_source_hash: hash, new_text: 'x = 42' },
    ]);
    expect(result.applied).toBe(1);
    expect(cellSource(notebook.cells[0]!)).toBe('x = 42');
    expect(result.changedCells[0]!.new_source_hash).toBe(
      `sha256:${hasher.sha256Hex('x = 42')}`,
    );
  });
});

describe('[step4][U6] insert_lines boundaries', () => {
  it('at_line=1 uses "" for expected_before', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([codeCell('first\nsecond', 'cell-0')])),
      hasher,
    );
    const result = apply(notebook, [
      { op: 'insert_lines', cell_index: 0, at_line: 1, expected_before: '', expected_after: 'first', new_text: 'import os' },
    ]);
    expect(cellSource(notebook.cells[0]!)).toBe('import os\nfirst\nsecond');
    expect(result.applied).toBe(1);
  });

  it('at_line=line_count+1 uses "" for expected_after', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([codeCell('first\nsecond', 'cell-0')])),
      hasher,
    );
    const result = apply(notebook, [
      { op: 'insert_lines', cell_index: 0, at_line: 3, expected_before: 'second', expected_after: '', new_text: 'tail = True' },
    ]);
    expect(cellSource(notebook.cells[0]!)).toBe('first\nsecond\ntail = True');
    expect(result.applied).toBe(1);
  });

  it('an empty cell has line_count 1 and both anchors are ""', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([codeCell('', 'cell-0')])),
      hasher,
    );
    const result = apply(notebook, [
      { op: 'insert_lines', cell_index: 0, at_line: 1, expected_before: '', expected_after: '', new_text: 'new = 1' },
    ]);
    // Split model: the empty source is one empty line; inserting before it
    // keeps that empty line as line 2 (SPEC §4.5 anchor details).
    expect(cellSource(notebook.cells[0]!)).toBe('new = 1\n');
    expect(result.applied).toBe(1);
  });

  it('insert_lines inside the cell between real lines', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([codeCell('a\nb\nc', 'cell-0')])),
      hasher,
    );
    apply(notebook, [
      { op: 'insert_lines', cell_index: 0, at_line: 2, expected_before: 'a', expected_after: 'b', new_text: 'mid = 1' },
    ]);
    expect(cellSource(notebook.cells[0]!)).toBe('a\nmid = 1\nb\nc');
  });
});

describe('[step4][U7] insert_cell shifts subsequent cell_index ops', () => {
  it('warns index_shifted and reports final-coordinate indexes in changed_cells', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([
        codeCell('a = 1', 'cell-0'),
        codeCell('b = 2', 'cell-1'),
        codeCell('c = 3', 'cell-2'),
      ])),
      hasher,
    );
    const result = apply(notebook, [
      { op: 'insert_cell', at_index: 1, cell_type: 'code', source: 'import os' },
      // After the insert, original cell-1 ("b = 2") now lives at index 2.
      { op: 'replace_source', cell_index: 2, expected_text: 'b = 2', new_text: 'b = 22' },
    ]);
    expect(result.applied).toBe(2);
    expect(result.warnings.map((w) => w.code)).toContain('index_shifted');
    const changed = result.changedCells;
    // Final coordinates: new cell at 1, edited b-cell at 2.
    expect(changed.find((c) => c.cell_index === 1)?.cell_id).toBe('inserted-1');
    expect(changed.find((c) => c.cell_index === 2)?.cell_id).toBe('cell-1');
    expect(cellSource(notebook.cells[2]!)).toBe('b = 22');
    expect(cellSource(notebook.cells[1]!)).toBe('import os');
  });

  it('no warning when cell_index op comes before the structural change', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([
        codeCell('a = 1', 'cell-0'),
        codeCell('b = 2', 'cell-1'),
      ])),
      hasher,
    );
    const result = apply(notebook, [
      { op: 'replace_source', cell_index: 1, expected_text: 'b = 2', new_text: 'b = 22' },
      { op: 'insert_cell', at_index: 0, cell_type: 'code', source: 'import os' },
    ]);
    expect(result.warnings.map((w) => w.code)).not.toContain('index_shifted');
  });
});

describe('[step4][U8] dry-run semantics (tool layer skips the write)', () => {
  it('computes everything (incl. markdown issues) while bytes stay unchanged', async () => {
    const json = notebookJson([
      { cell_type: 'markdown', id: 'md-0', metadata: {}, source: '# Title\n\ncontent' },
    ]);
    const { target, notebook, bytes } = await parseFile('u8.ipynb', json);
    const checkMarkdown = (): Array<{ severity: 'error' | 'warning'; rule: string; line: number; message: string }> => [
      { severity: 'warning', rule: 'heading-level-jump', line: 3, message: 'jump' },
    ];
    const result = applyEditOps(notebook, [
      { op: 'replace_source', cell_index: 0, expected_text: '# Title\n\ncontent', new_text: '# Title\n\n## Section' },
    ], { hasher, nbformatMinor: 5, checkMarkdown });

    expect(result.applied).toBe(1);
    expect(result.markdownIssues).toHaveLength(1); // computed even in dry-run
    // Tool layer does not call writeNotebookFile for dry_run: file untouched.
    expect(await readFile(target)).toEqual(bytes);
  });
});

describe('[step4][U9] set_cell_type to markdown', () => {
  it('deletes outputs and nulls execution_count', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([
        {
          cell_type: 'code',
          id: 'cell-0',
          metadata: {},
          source: 'print(1)',
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
          execution_count: 5,
        },
      ])),
      hasher,
    );
    const result = apply(notebook, [
      { op: 'set_cell_type', cell_index: 0, cell_type: 'markdown', expected_text: 'print(1)' },
    ]);
    const cell = notebook.cells[0]!;
    expect(cell.cell_type).toBe('markdown');
    expect(cell.outputs).toBeUndefined();
    expect(cell.execution_count).toBeNull();
    expect(cellSource(cell)).toBe('print(1)'); // source content untouched
    expect(result.applied).toBe(1);
  });

  it('markdown -> code fills outputs/execution_count', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([
        { cell_type: 'markdown', id: 'md-0', metadata: {}, source: 'text' },
      ])),
      hasher,
    );
    apply(notebook, [
      { op: 'set_cell_type', cell_index: 0, cell_type: 'code', expected_text: 'text' },
    ]);
    const cell = notebook.cells[0]!;
    expect(cell.cell_type).toBe('code');
    expect(cell.outputs).toEqual([]);
    expect(cell.execution_count).toBeNull();
  });
});

describe('[step4][U14] move_cell on nbformat_minor=4', () => {
  it('succeeds and warns no_stable_cell_id (D8)', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([
        codeCell('a', 'cell-0'),
        codeCell('b', 'cell-1'),
        codeCell('c', 'cell-2'),
      ], 4)),
      hasher,
    );
    const result = apply(notebook, [
      { op: 'move_cell', from_index: 2, to_index: 0 },
    ], 4);
    expect(result.applied).toBe(1);
    expect(result.warnings.map((w) => w.code)).toContain('no_stable_cell_id');
    expect(cellSource(notebook.cells[0]!)).toBe('c');
    expect(cellSource(notebook.cells[1]!)).toBe('a');
    expect(cellSource(notebook.cells[2]!)).toBe('b');
  });
});

describe('[step4] op matrix violations (invalid_ops)', () => {
  const base = (): ReturnType<typeof parseNotebook> =>
    parseNotebook(new TextEncoder().encode(notebookJson([codeCell('x = 1', 'cell-0')])), hasher);

  it('rejects replace_source without any anchor', () => {
    const err = expectError(() => apply(base(), [{ op: 'replace_source', cell_index: 0, new_text: 'x = 2' }]));
    expect(err.code).toBe('invalid_ops');
  });

  it('rejects forbidden fields per op', () => {
    const cases: Array<[EditOpInput, string]> = [
      [{ op: 'replace_lines', cell_index: 0, start_line: 1, end_line: 1, expected_text: 'x = 1', new_text: 'y', at_line: 1 }, 'at_line'],
      [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'y', cell_type: 'code' }, 'cell_type'],
      [{ op: 'insert_cell', at_index: 0, cell_type: 'code', source: 's', cell_index: 0 }, 'cell_index'],
      [{ op: 'move_cell', from_index: 0, to_index: 0, cell_id: 'cell-0' }, 'cell_id'],
      [{ op: 'delete_cell', cell_index: 0, expected_text: 'x = 1', new_text: 'y' }, 'new_text'],
    ];
    for (const [op, field] of cases) {
      const err = expectError(() => apply(base(), [op]));
      expect(err.code).toBe('invalid_ops');
      expect(String((err.detail as Record<string, unknown>)['reason'])).toContain(field);
    }
  });

  it('rejects missing required anchors and locators', () => {
    const err1 = expectError(() => apply(base(), [{ op: 'replace_lines', cell_index: 0, start_line: 1, end_line: 1, new_text: 'y' }]));
    expect(err1.code).toBe('invalid_ops');
    const err2 = expectError(() => apply(base(), [{ op: 'replace_source', cell_id: 'cell-0', new_text: 'y' }]));
    expect(err2.code).toBe('invalid_ops');
    const err3 = expectError(() => apply(base(), [{ op: 'insert_lines', cell_index: 0, at_line: 1, new_text: 'y', expected_before: '' }]));
    expect(err3.code).toBe('invalid_ops');
  });

  it('rejects malformed field types defensively', () => {
    const err = expectError(() => apply(base(), [{ op: 'replace_source', cell_index: 'zero', expected_text: 'x = 1', new_text: 'y' }]));
    expect(err.code).toBe('invalid_ops');
  });
});

describe('[step4] locator and range errors', () => {
  const base = (): ReturnType<typeof parseNotebook> =>
    parseNotebook(new TextEncoder().encode(notebookJson([codeCell('x = 1', 'cell-0')])), hasher);

  it('unknown cell_id and out-of-range cell_index raise cell_not_found', () => {
    expect(expectError(() => apply(base(), [{ op: 'clear_outputs', cell_id: 'nope' }])).code).toBe('cell_not_found');
    expect(expectError(() => apply(base(), [{ op: 'clear_outputs', cell_index: 9 }])).code).toBe('cell_not_found');
  });

  it('line and index ranges raise range_out_of_bounds', () => {
    expect(
      expectError(() => apply(base(), [{ op: 'replace_lines', cell_index: 0, start_line: 1, end_line: 99, expected_text: 'x = 1', new_text: 'y' }])).code,
    ).toBe('range_out_of_bounds');
    expect(
      expectError(() => apply(base(), [{ op: 'insert_lines', cell_index: 0, at_line: 5, expected_before: '', expected_after: '', new_text: 'y' }])).code,
    ).toBe('range_out_of_bounds');
    expect(
      expectError(() => apply(base(), [{ op: 'move_cell', from_index: 0, to_index: 9 }])).code,
    ).toBe('range_out_of_bounds');
    expect(
      expectError(() => apply(base(), [{ op: 'insert_cell', at_index: 5, cell_type: 'code', source: 'x' }])).code,
    ).toBe('range_out_of_bounds');
  });
});

describe('[step4] remaining op behaviors', () => {
  it('delete_cell removes the cell (anchor mandatory)', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([codeCell('a', 'cell-0'), codeCell('b', 'cell-1')])),
      hasher,
    );
    const result = apply(notebook, [
      { op: 'delete_cell', cell_id: 'cell-0', expected_text: 'a' },
    ]);
    expect(result.applied).toBe(1);
    expect(notebook.cells).toHaveLength(1);
    expect(cellSource(notebook.cells[0]!)).toBe('b');
    expect(result.changedCells).toHaveLength(0); // deleted cells are not reported
  });

  it('clear_outputs empties outputs but keeps execution_count and source', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([
        { cell_type: 'code', id: 'cell-0', metadata: {}, source: 'print(1)', outputs: [{ output_type: 'stream', name: 'stdout', text: ['1'] }], execution_count: 4 },
      ])),
      hasher,
    );
    const result = apply(notebook, [{ op: 'clear_outputs', cell_index: 0 }]);
    const cell = notebook.cells[0]!;
    expect(cell.outputs).toEqual([]);
    expect(cell.execution_count).toBe(4);
    expect(cellSource(cell)).toBe('print(1)');
    expect(result.changedCells[0]!.outputs_cleared).toBe(true);
  });

  it('clear_outputs validates optional anchors when provided', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([codeCell('x = 1', 'cell-0')])),
      hasher,
    );
    const err = expectError(() => apply(notebook, [
      { op: 'clear_outputs', cell_index: 0, expected_text: 'wrong' },
    ]));
    expect(err.code).toBe('cas_mismatch');
  });

  it('insert_cell assigns deterministic unique ids on nbformat 4.5 and none on 4.4', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([codeCell('a', 'cell-0')])),
      hasher,
    );
    apply(notebook, [
      { op: 'insert_cell', at_index: 0, cell_type: 'markdown', source: '# hi' },
      { op: 'insert_cell', at_index: 0, cell_type: 'code', source: 'x = 1' },
    ]);
    expect(notebook.cells[0]!.id).toBe('inserted-2');
    expect(notebook.cells[1]!.id).toBe('inserted-1');

    const old = parseNotebook(
      new TextEncoder().encode(notebookJson([codeCell('a', 'cell-0')], 4)),
      hasher,
    );
    apply(old, [{ op: 'insert_cell', at_index: 0, cell_type: 'code', source: 'x' }], 4);
    expect(old.cells[0]!.id).toBeUndefined();
  });

  it('expected_text is byte-exact: no trimming or newline normalization', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([codeCell('x = 1  \n', 'cell-0')])),
      hasher,
    );
    const err = expectError(() => apply(notebook, [
      { op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'y' },
    ]));
    expect(err.code).toBe('cas_mismatch'); // trailing whitespace/newline differs
  });

  it('replace_source on markdown beyond 1.5x warns large_markdown_rewrite', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([
        { cell_type: 'markdown', id: 'md-0', metadata: {}, source: '# T' },
      ])),
      hasher,
    );
    const result = apply(notebook, [
      { op: 'replace_source', cell_index: 0, expected_text: '# T', new_text: `# T\n\n${'word '.repeat(200)}` },
    ]);
    expect(result.warnings.map((w) => w.code)).toContain('large_markdown_rewrite');
  });

  it('no_stable_cell_id fires once for index-based ops on old notebooks', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([codeCell('x = 1', 'cell-0')], 4)),
      hasher,
    );
    const result = apply(notebook, [
      { op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 2' },
      { op: 'clear_outputs', cell_index: 0 },
    ], 4);
    const warns = result.warnings.filter((w) => w.code === 'no_stable_cell_id');
    expect(warns).toHaveLength(1);
  });

  it('anchors by cell_id take precedence over cell_index when both are present', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([codeCell('a', 'cell-0'), codeCell('b', 'cell-1')])),
      hasher,
    );
    apply(notebook, [
      { op: 'replace_source', cell_id: 'cell-1', cell_index: 0, expected_text: 'b', new_text: 'b!' },
    ]);
    expect(cellSource(notebook.cells[0]!)).toBe('a');
    expect(cellSource(notebook.cells[1]!)).toBe('b!');
  });
});

describe('[step4][A8] index_shifted survives a later structural op (SPEC §4.1.9)', () => {
  it('warns when an index op sits BETWEEN two structural ops', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([
        codeCell('a', 'cell-0'), codeCell('b', 'cell-1'), codeCell('c', 'cell-2'), codeCell('d', 'cell-3'),
      ])),
      hasher,
    );
    const result = apply(notebook, [
      { op: 'insert_cell', at_index: 0, cell_type: 'code', source: 'new' },
      // This index op is affected by the insert above, but a THIRD structural
      // op used to reset the scan window and silence the warning.
      { op: 'replace_lines', cell_index: 2, start_line: 1, end_line: 1, expected_text: 'b', new_text: 'b!' },
      { op: 'insert_cell', at_index: 0, cell_type: 'code', source: 'newer' },
    ]);
    expect(result.warnings.map((w) => w.code)).toContain('index_shifted');
  });
});

describe('[step4][A9] clear_outputs rejects non-code cells (SPEC §5.5.6)', () => {
  it('throws invalid_ops for a markdown target instead of writing outputs', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(notebookJson([
        { cell_type: 'markdown', id: 'md-0', metadata: {}, source: '# hi' },
      ])),
      hasher,
    );
    const err = expectError(() => apply(notebook, [{ op: 'clear_outputs', cell_index: 0 }]));
    expect(err.code).toBe('invalid_ops');
    expect(String((err.detail as Record<string, unknown>)['reason'])).toContain('code cell');
    // The markdown cell is never given an outputs field.
    expect('outputs' in (notebook.cells[0] as unknown as Record<string, unknown>)).toBe(false);
  });
});
