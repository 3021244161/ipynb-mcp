import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IpynbError } from '../../src/core/errors.js';
import {
  cellSource,
  cellSourceHash,
  parseNotebook,
  selfCheckNotebook,
  serializeNotebook,
  setCellSource,
  sourceToArray,
} from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';
import { readNotebookFile, writeNotebookFile } from '../../src/fs/notebook-file.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-parse-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Notebook with unknown fields everywhere, mixed source shapes, nbformat 4.5. */
function richNotebookJson(): string {
  return JSON.stringify({
    custom_top_level: { keep: 'me', nested: [1, 2, 3] },
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', argv: ['python', '-m', 'ipykernel'] },
      language_info: { name: 'python', version: '3.11.9' },
      unknown_meta: { keep: true },
    },
    cells: [
      {
        cell_type: 'code',
        id: 'cell-zero',
        execution_count: 7,
        metadata: { tags: ['untouched'], custom: 1 },
        source: ['import pandas as pd\n', 'print("zero")'],
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['zero\n'] }],
        custom_cell_field: 'keep-me',
      },
      {
        cell_type: 'markdown',
        id: 'cell-one',
        metadata: {},
        source: '# Title\n\nSome prose.',
      },
    ],
  });
}

describe('[step3] parseNotebook', () => {
  it('rejects invalid JSON with parse_failed', () => {
    expect(() => parseNotebook(new TextEncoder().encode('{not json'), hasher)).toThrowError(
      expect.objectContaining({ code: 'parse_failed' }),
    );
  });

  it('rejects non-object roots and missing/invalid structure', () => {
    expect(() => parseNotebook(new TextEncoder().encode('[1,2]'), hasher)).toThrowError(
      expect.objectContaining({ code: 'parse_failed' }),
    );
    expect(() => parseNotebook(new TextEncoder().encode('{"nbformat":4}'), hasher)).toThrowError(
      expect.objectContaining({ code: 'parse_failed' }),
    );
    expect(() =>
      parseNotebook(
        new TextEncoder().encode('{"nbformat":4,"cells":[{"cell_type":"bogus"}]}'),
        hasher,
      ),
    ).toThrowError(expect.objectContaining({ code: 'parse_failed' }));
  });

  it('rejects nbformat < 4 with nbformat_unsupported', () => {
    const v3 = '{"nbformat":3,"nbformat_minor":8,"metadata":{},"cells":[]}';
    const err = capture(() => parseNotebook(new TextEncoder().encode(v3), hasher));
    expect(err.code).toBe('nbformat_unsupported');
  });

  it('computes content_hash over the raw bytes (SPEC §4.1.6)', () => {
    const bytes = new TextEncoder().encode(richNotebookJson());
    const notebook = parseNotebook(bytes, hasher);
    expect(notebook.contentHash).toBe(`sha256:${hasher.sha256Hex(bytes)}`);
    expect(notebook.cells).toHaveLength(2);
  });

  it('source hash covers the merged source string (SPEC §4.1.7)', () => {
    const notebook = parseNotebook(new TextEncoder().encode(richNotebookJson()), hasher);
    const cell = notebook.cells[0]!;
    expect(cellSource(cell)).toBe('import pandas as pd\nprint("zero")');
    expect(cellSourceHash(cell, hasher)).toBe(
      `sha256:${hasher.sha256Hex('import pandas as pd\nprint("zero")')}`,
    );
  });
});

describe('[step3][U1] round-trip preserves unknown fields and untouched cells', () => {
  it('mutating one cell keeps everything else byte-compatible in shape', () => {
    const original = richNotebookJson();
    const notebook = parseNotebook(new TextEncoder().encode(original), hasher);

    // Modify only cell 1's source (string form -> array form is expected).
    setCellSource(notebook.cells[1]!, '# Title\n\nNew prose.');

    const serialized = serializeNotebook(notebook);
    const reparsed = JSON.parse(serialized);

    // Unknown top-level field preserved.
    expect(reparsed['custom_top_level']).toEqual({ keep: 'me', nested: [1, 2, 3] });
    // Metadata untouched.
    expect(reparsed['metadata']['kernelspec']).toEqual({
      name: 'python3',
      display_name: 'Python 3',
      argv: ['python', '-m', 'ipykernel'],
    });
    expect(reparsed['metadata']['unknown_meta']).toEqual({ keep: true });
    // Untouched cell 0 keeps its original array-shaped source and unknown field.
    expect(reparsed['cells'][0]['source']).toEqual(['import pandas as pd\n', 'print("zero")']);
    expect(reparsed['cells'][0]['custom_cell_field']).toBe('keep-me');
    expect(reparsed['cells'][0]['outputs']).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['zero\n'] },
    ]);
    // Modified cell 1 now stores array-form source.
    expect(reparsed['cells'][1]['source']).toEqual(['# Title\n', '\n', 'New prose.']);
    // 1-space indent + trailing newline (SPEC §5.5.4).
    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized).toContain('\n "cells": [');
  });

  it('a string-form source stays string-form when untouched, even on unrelated writes', () => {
    const nbJson = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { cell_type: 'code', id: 'a', metadata: {}, source: 'x = 1' },
        { cell_type: 'code', id: 'b', metadata: {}, source: ['y = 2\n'] },
      ],
    });
    const notebook = parseNotebook(new TextEncoder().encode(nbJson), hasher);
    setCellSource(notebook.cells[1]!, 'y = 3\n');
    const reparsed = JSON.parse(serializeNotebook(notebook));
    expect(reparsed['cells'][0]['source']).toBe('x = 1');
    expect(reparsed['cells'][1]['source']).toEqual(['y = 3\n']);
  });
});

describe('[step3] serialization details (SPEC §5.5)', () => {
  it('fills execution_count: null for code cells missing it', () => {
    const nbJson = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'code', id: 'a', metadata: {}, source: 'x = 1' }],
    });
    const notebook = parseNotebook(new TextEncoder().encode(nbJson), hasher);
    const reparsed = JSON.parse(serializeNotebook(notebook));
    expect(reparsed['cells'][0]['execution_count']).toBeNull();
  });

  it('empty source serializes as an empty array', () => {
    expect(JSON.stringify(sourceToArray(''))).toBe('[]');
    expect(JSON.stringify(sourceToArray('a\nb'))).toBe('["a\\n","b"]');
  });
});

describe('[step3][U10] self check guards the write path', () => {
  it('selfCheckNotebook re-parses valid output successfully', () => {
    const notebook = parseNotebook(new TextEncoder().encode(richNotebookJson()), hasher);
    const serialized = serializeNotebook(notebook);
    const checked = selfCheckNotebook(serialized, hasher);
    expect(checked.cells).toHaveLength(2);
  });

  it('a corrupted serializer triggers selfcheck_failed and the file stays untouched', async () => {
    const target = path.join(dir, 'u10.ipynb');
    const notebook = parseNotebook(new TextEncoder().encode(richNotebookJson()), hasher);
    const before = await readFile(target, 'utf8').catch(() => null);
    if (before === null) {
      await writeFile(target, richNotebookJson());
    }
    const bytesBefore = await readFile(target);

    await expect(
      writeNotebookFile(notebook, target, {
        hasher,
        backupKeep: 10,
        createBackup: true,
        serialize: () => '{"nbformat":4,"cells":[TRUNCATED',
      }),
    ).rejects.toMatchObject({ code: 'selfcheck_failed' });

    // No backup, no write: bytes identical.
    expect(await readFile(target)).toEqual(bytesBefore);
  });

  it('rejects serialize output that would parse but is not a notebook', async () => {
    const target = path.join(dir, 'u10-notnb.ipynb');
    await writeFile(target, richNotebookJson());
    const notebook = parseNotebook(new TextEncoder().encode(richNotebookJson()), hasher);
    await expect(
      writeNotebookFile(notebook, target, {
        hasher,
        backupKeep: 10,
        createBackup: true,
        serialize: () => '"just a string"',
      }),
    ).rejects.toMatchObject({ code: 'selfcheck_failed' });
  });
});

describe('[step3] notebook-file orchestration', () => {
  it('read + write round trip creates a backup and updates the hash', async () => {
    const target = path.join(dir, 'roundtrip.ipynb');
    await writeFile(target, richNotebookJson());
    const notebook = await readNotebookFile(target, hasher);
    setCellSource(notebook.cells[0]!, 'import pandas as pd\nprint("edited")');
    const result = await writeNotebookFile(notebook, target, {
      hasher,
      backupKeep: 10,
      createBackup: true,
    });
    expect(result.backupPath).toContain('.bak');
    expect(result.contentHashAfter).not.toBe(notebook.contentHash);
    const reread = await readNotebookFile(target, hasher);
    expect(reread.contentHash).toBe(result.contentHashAfter);
    expect(cellSource(reread.cells[0]!)).toBe('import pandas as pd\nprint("edited")');
  });

  it('write without backup (create_backup=false) leaves no .bak file', async () => {
    const target = path.join(dir, 'nobackup.ipynb');
    await writeFile(target, richNotebookJson());
    const notebook = await readNotebookFile(target, hasher);
    const result = await writeNotebookFile(notebook, target, {
      hasher,
      backupKeep: 10,
      createBackup: false,
    });
    expect(result.backupPath).toBeNull();
  });

  it('detects external modification in the read->write window (file_changed)', async () => {
    const target = path.join(dir, 'external.ipynb');
    await writeFile(target, richNotebookJson());
    const notebook = await readNotebookFile(target, hasher);
    // External editor touches the file between read and write.
    // (Target a quote-free substring: JSON.stringify escapes the quotes.)
    await writeFile(target, richNotebookJson().replace('import pandas', 'import numpy'));
    await expect(
      writeNotebookFile(notebook, target, { hasher, backupKeep: 10, createBackup: true }),
    ).rejects.toMatchObject({ code: 'file_changed' });
  });

  it('read of a missing file raises file_not_found', async () => {
    await expect(readNotebookFile(path.join(dir, 'missing.ipynb'), hasher)).rejects.toMatchObject({
      code: 'file_not_found',
    });
  });
});

function capture(action: () => unknown): IpynbError {
  try {
    action();
    throw new Error('expected an IpynbError');
  } catch (cause) {
    if (cause instanceof IpynbError) {
      return cause;
    }
    throw cause;
  }
}
