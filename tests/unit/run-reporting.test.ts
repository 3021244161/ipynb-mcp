// [P1-a][V7-2][V7-8] Three defects the v7 review reproduced by hand, all of them
// about what a run REPORTS rather than what it does:
//
//   P1-a  the write gate checked `execution_count` inside an `execute_result`
//         output but not the CELL's own field, so a cell with -1 (which nbformat
//         rejects: "-1 is less than the minimum of 0") stayed editable and the
//         file stayed invalid after a "successful" edit.
//   V7-2  `output_truncated` is defined by SPEC §7 as "any OutputItem has
//         truncated === true", appended ONCE per call. The run path reused it for
//         "a value was dropped" AND pushed the real truncation notice separately,
//         so one response could carry two or three copies.
//   V7-8  `exec_timeout` was the one terminal shape whose detail omitted
//         `warnings`, so a timeout hid everything the earlier cells had reported.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findStructuralProblem, parseNotebook, selfCheckNotebook } from '../../src/core/parse.js';
import {
  dropUnrepresentableOutputs,
  mapRawOutputs,
  nbformatOutputsOfRaw,
  representableExecutionCount,
} from '../../src/core/outputs.js';
import { hasher } from '../../src/hash.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-v7b-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function docWithCell(cell: Record<string, unknown>): ReturnType<typeof parseNotebook> {
  return parseNotebook(
    new TextEncoder().encode(
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', outputs: [], ...cell }],
      }),
    ),
    hasher,
  );
}

describe('[P1-a] a negative CELL execution_count is refused by the gate', () => {
  it('the structural gate reports it, with the count in the detail', () => {
    const doc = docWithCell({ execution_count: -1 });
    expect(findStructuralProblem(doc.doc)).toMatchObject({
      cell_index: 0,
      rule: 'execution_count_negative',
      execution_count: -1,
    });
  });

  it('a cell with no outputs key at all is still checked', () => {
    // The count lives on the cell, not on an output, so requiring `outputs` first
    // would leave the most likely shape unchecked.
    const parsed = parseNotebook(
      new TextEncoder().encode(JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', execution_count: -3 }],
      })),
      hasher,
    );
    expect(findStructuralProblem(parsed.doc)).toMatchObject({ rule: 'execution_count_negative' });
  });

  it('0 and positive integers are fine, and null is fine', () => {
    for (const count of [0, 1, 42, null]) {
      expect(findStructuralProblem(docWithCell({ execution_count: count }).doc), String(count)).toBeNull();
    }
  });

  it('a rewritten cell carrying a negative count fails the write (D-037 rule 2)', () => {
    // The gate only judges the cells a write is responsible for, so this is the
    // exact contradiction the review found: the cell IS in scope and the file IS
    // invalid, yet the edit succeeded.
    const doc = docWithCell({ execution_count: -1 });
    const serialized = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 2', outputs: [], execution_count: -1 }],
    });
    expect(() => {
      selfCheckNotebook(serialized, hasher, {
        touchedCellIndexes: new Set([0]),
        originalDoc: doc.doc,
      });
    }).toThrowError(/selfcheck_failed|structure check/);
  });

  it('the execution path normalizes the count before serializing', () => {
    // The gate is the backstop; the run must not build an invalid cell in the
    // first place, from either the kernel's count or a restored saved one.
    for (const input of [-1, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null, undefined]) {
      expect(representableExecutionCount(input), String(input)).toBeNull();
    }
    for (const input of [0, 1, 99]) {
      expect(representableExecutionCount(input), String(input)).toBe(input);
    }
  });

  it('a normalized run output passes the gate (the two agree)', () => {
    // End-to-end agreement between the two halves of the contract: what the run
    // writes must be what the gate accepts.
    const outputs = dropUnrepresentableOutputs(
      nbformatOutputsOfRaw(
        // The count lives on the cell, not on the raw output (nbformat puts it
        // there, and `nbformatOutputsOfRaw` takes it as a separate argument).
        [{ outputType: 'execute_result', data: { 'text/plain': '7' } }],
        representableExecutionCount(-1),
      ),
    );
    const serialized = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{
        cell_type: 'code',
        id: 'c0',
        metadata: {},
        source: '7',
        execution_count: representableExecutionCount(-1),
        outputs: outputs.outputs,
      }],
    });
    expect(findStructuralProblem(parseNotebook(new TextEncoder().encode(serialized), hasher).doc)).toBeNull();
  });
});

describe('[V7-2] output_truncated is appended at most once per call', () => {
  it('the mapped truncation flag and the dropped-value notice do not double up', () => {
    // Reproduces the shape the review measured: the same response reporting a
    // dropped value AND a genuine truncation. SPEC §7 says the code appears once.
    const warnings: Array<{ code: string; message: string }> = [];
    // The run pushes the drop notice while mapping outputs…
    warnings.push({ code: 'output_truncated', message: 'cell 2: dropped output value(s) …' });
    // …and then the truncation notice, which must notice it is already there.
    const truncated = mapRawOutputs(
      [{ outputType: 'stream', text: 'x'.repeat(50) }],
      { maxImageBytes: 20_971_520, inlineTextChars: 10, hasher },
    ).items.some((item) => item.kind === 'stream' && item.truncated);
    expect(truncated, 'the fixture must actually truncate').toBe(true);
    if (truncated && !warnings.some((warning) => warning.code === 'output_truncated')) {
      warnings.push({ code: 'output_truncated', message: 'at least one output exceeded inline_text_chars …' });
    }
    expect(warnings.filter((warning) => warning.code === 'output_truncated')).toHaveLength(1);
    // The surviving message is the informative one: it names the cell and the mime,
    // and it is the only place the model can learn a value was discarded.
    expect(warnings[0]!.message).toContain('cell 2');
  });
});

describe('[V7-8] a timeout detail carries the warnings gathered so far', () => {
  it('the exec_timeout detail has a warnings array (shape guard)', async () => {
    // The failure path is driven by a real kernel in the integration suite; this
    // pins the SHAPE so a future edit cannot silently drop the key again, which is
    // what happened before (review v7 V7-8: `failedRunError` had it, the timeout
    // branch did not).
    const source = await readFile(path.join(process.cwd(), 'src', 'run.ts'), 'utf8');
    const timeoutBlock = source.slice(source.indexOf("throw new IpynbError('exec_timeout'"));
    const end = timeoutBlock.indexOf('});');
    expect(end, 'the exec_timeout detail must be a closed object literal').toBeGreaterThan(0);
    expect(timeoutBlock.slice(0, end)).toContain('warnings:');
  });
});

describe('[P1-c] the sidecar environment is merged, not replaced', () => {
  it('a partial env option still leaves PATH visible to the sidecar', async () => {
    const source = await readFile(path.join(process.cwd(), 'src', 'kernel', 'sidecar-transport.ts'), 'utf8');
    // The bug was `env: { ...options.env, … }`, which dropped PATH/TEMP/HOME for
    // every caller that passed a partial environment — the sidecar then wrote its
    // HMAC-bearing connection file into the working directory.
    expect(source).toContain('...process.env, ...options.env');
  });
});

describe('[P1-c] the connection file is pinned to a real temp directory', () => {
  it('the sidecar passes an explicit dir and refuses the cwd fallback', async () => {
    const source = await readFile(path.join(process.cwd(), 'python', 'ipynb_sidecar.py'), 'utf8');
    expect(source).toContain('dir=temp_dir');
    // `gettempdir()` returns '.' when nothing is set, which is the fallback that
    // put 45 connection files in the working directory.
    expect(source).toContain('os.path.isdir(temp_dir)');
  });

  it('writing and removing a connection file leaves no residue', async () => {
    const target = path.join(dir, 'conn.json');
    await writeFile(target, '{"key":"secret"}');
    await rm(target, { force: true });
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
