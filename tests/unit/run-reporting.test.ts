// [P1-a][V7-2][V7-8][V8-4] Defects about what a run REPORTS rather than what it does.
//
// The cases here drive REAL functions. An earlier version of this file did not: it
// re-implemented the product's `if` on a local array and asserted source TEXT, so
// deleting the actual guard from `run.ts` left the suite green — the reviewer's
// mutation M1 (review v8 V8-4). A guard that cannot be made to fail is not a guard.
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findStructuralProblem, parseNotebook, selfCheckNotebook } from '../../src/core/parse.js';
import {
  countTruncatedCells,
  dropUnrepresentableOutputs,
  nbformatOutputsOfRaw,
  outputTruncatedWarning,
  representableExecutionCount,
  type OutputItem,
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
    const doc = docWithCell({
      execution_count: -1,
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'ran\n' }],
    });
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

  it('[V9-8] the rule is about a count that has outputs to belong to', () => {
    // v9 V9-8 moved the boundary from "this REQUEST emptied the outputs" to "this CELL
    // has no outputs". The request-shaped version accepted the file for exactly one
    // call and then refused the model's next edit with the rule the hint had just said
    // was handled; the cell-shaped version is stable, which is what makes the hint's
    // promise true. The count itself is untouched, as SPEC §4.5 rule 5 requires.
    const withOutputs = docWithCell({
      execution_count: -1,
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'stale\n' }],
    });
    expect(findStructuralProblem(withOutputs.doc)).toMatchObject({ rule: 'execution_count_negative' });
    // Empty outputs, and no outputs key at all: nothing for the count to belong to.
    expect(findStructuralProblem(docWithCell({ execution_count: -1, outputs: [] }).doc)).toBeNull();
    expect(findStructuralProblem(docWithCell({ execution_count: -1 }).doc)).toBeNull();
  });

  it('a rewritten cell that KEEPS its outputs and a negative count fails the write (D-037 rule 2)', () => {
    // The gate only judges the cells a write is responsible for, so this is the
    // exact contradiction the review found: the cell IS in scope and the file IS
    // invalid, yet the edit succeeded.
    const doc = docWithCell({
      execution_count: -1,
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'stale\n' }],
    });
    const serialized = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{
        cell_type: 'code',
        id: 'c0',
        metadata: {},
        source: 'x = 2',
        outputs: [{ output_type: 'stream', name: 'stdout', text: 'stale\n' }],
        execution_count: -1,
      }],
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

describe('[V7-2][V8-10] output_truncated is emitted once, and carries both facts', () => {
  // These cases call the REAL function the run uses. The previous version
  // re-implemented the product's `if` on a local array, so deleting the actual guard
  // from `run.ts` kept the suite green (review v8 V8-4, mutation M1) — the same class
  // of fake guard as a source-text assertion, only harder to notice.

  it('reports a dropped value, naming the cell it came from', () => {
    expect(outputTruncatedWarning([{ cellIndex: 3, mime: 'text/plain' }], 0)).toEqual({
      code: 'output_truncated',
      message: expect.stringContaining('dropped 1'),
    });
    // V9-7: the cell index is part of the fact. Without it the model is told a value
    // was lost but not where, which is what D-042 claimed the message did.
    expect(outputTruncatedWarning([{ cellIndex: 3, mime: 'text/plain' }], 0)!.message)
      .toContain('cell 3: text/plain');
  });

  it('reports truncation', () => {
    expect(outputTruncatedWarning([], 2)).toEqual({
      code: 'output_truncated',
      message: expect.stringContaining('2 output(s) exceeded inline_text_chars'),
    });
  });

  it('reports BOTH when both happened, instead of one silencing the other', () => {
    // V8-10: the drop notice used to be pushed first and the truncation notice was
    // deduped away, so a call that had lost a value AND truncated an output told the
    // model about only one of them.
    const warning = outputTruncatedWarning(
      [{ cellIndex: 0, mime: 'image/png' }, { cellIndex: 1, mime: 'text/plain' }],
      3,
    );
    expect(warning).not.toBeNull();
    expect(warning!.message).toContain('dropped 2');
    expect(warning!.message).toContain('3 output(s) exceeded');
    expect(warning!.message).toContain('cell 0: image/png');
    expect(warning!.message).toContain('cell 1: text/plain');
  });

  it('deduplicates one cell losing the same mime twice', () => {
    const warning = outputTruncatedWarning(
      [
        { cellIndex: 1, mime: 'text/plain' },
        { cellIndex: 1, mime: 'text/plain' },
        { cellIndex: 1, mime: 'text/plain' },
      ],
      0,
    );
    expect(warning!.message).toContain('dropped 1');
    expect(warning!.message.match(/text\/plain/g)).toHaveLength(1);
  });

  it('does NOT deduplicate the same mime lost by two different cells', () => {
    // The distinction the flattened `string[]` erased: two cells losing a value is
    // two facts, and a model told "one" will go looking in one place (review v9 V9-7).
    const warning = outputTruncatedWarning(
      [{ cellIndex: 0, mime: 'text/plain' }, { cellIndex: 2, mime: 'text/plain' }],
      0,
    );
    expect(warning!.message).toContain('dropped 2');
    expect(warning!.message).toContain('cell 0: text/plain');
    expect(warning!.message).toContain('cell 2: text/plain');
  });

  it('is silent when nothing was lost — the case a blanket push would break', () => {
    // Without this, `outputTruncatedWarning` could return a warning unconditionally
    // and every case above would still pass.
    expect(outputTruncatedWarning([], 0)).toBeNull();
  });

  it('counts the cells that actually truncated, not the outputs', () => {
    const truncated = (text: string): OutputItem => ({
      kind: 'stream',
      stream_name: 'stdout',
      text,
      truncated: true,
      truncated_at_chars: 10,
    });
    const whole: OutputItem = {
      kind: 'stream',
      stream_name: 'stdout',
      text: 'ok',
      truncated: false,
      truncated_at_chars: null,
    };
    expect(countTruncatedCells([{ outputs: [truncated('a'), truncated('b')] }])).toBe(1);
    expect(countTruncatedCells([{ outputs: [whole] }, { outputs: [truncated('a')] }])).toBe(1);
    expect(countTruncatedCells([{ outputs: [whole] }])).toBe(0);
  });
});

describe('[V7-8][V9-7] a timeout detail carries the warnings gathered so far', () => {
  it('the exec_timeout detail keeps a warnings array on the wire', async () => {
    // V8-4: this used to assert SOURCE TEXT (`expect(source).toContain('warnings:')`),
    // which passes even when the line sits inside a comment. It drives the real
    // error and the real projection instead.
    const { IpynbError } = await import('../../src/core/errors.js');
    const { toCallToolResult } = await import('../../src/mcp/tools/result.js');

    const error = new IpynbError('exec_timeout', 'cell execution timed out', {
      cell_index: 2,
      completed_cells: 2,
      warnings: [{ code: 'output_truncated', message: 'dropped 1 mime value(s) (cell 1: text/plain)' }],
    });
    const outcome = await (await import('../../src/mcp/tools/result.js')).runTool(async () => {
      throw error;
    });
    const result = toCallToolResult(outcome);
    expect(result.isError).toBe(true);
    const body = JSON.parse(String((result.content[0] as { text?: string }).text ?? '{}')) as Record<string, unknown>;
    expect(body['code']).toBe('exec_timeout');
    // The point of V7-8: the earlier cells' warnings must survive into the failure.
    expect(body['detail']).toMatchObject({
      warnings: [{ code: 'output_truncated', message: 'dropped 1 mime value(s) (cell 1: text/plain)' }],
    });
  });

  it('[V9-7] the run assembles those warnings in ONE place, used on every exit', async () => {
    // V8-4's finding was that this file proved the PROJECTION and nothing about the
    // run: deleting the call site in `run.ts` kept everything green. The v9 shape
    // routed both exits through `callWarnings`, so what has to be pinned is that the
    // helper exists, is what the timeout path calls, and that the assembly is not
    // inlined back into the happy path.
    const source = await readFile(new URL('../../src/run.ts', import.meta.url), 'utf8');
    expect(source).toContain('function pushCallWarnings(');
    // Call sites: the timeout exit and the successful exit, and nothing else pushes
    // `outputTruncatedWarning` directly.
    const assemblyCalls = source.match(/pushCallWarnings\(/g) ?? [];
    expect(assemblyCalls.length).toBeGreaterThanOrEqual(3); // 1 definition + 2 exits
    // Exactly one CALL, which must be inside the helper: a second one would be the
    // inlined happy-path shape coming back.
    expect(source.match(/= outputTruncatedWarning\(/g) ?? []).toHaveLength(1);
    const helperStart = source.indexOf('function pushCallWarnings(');
    const helperEnd = source.indexOf('\n}', helperStart);
    expect(source.indexOf('= outputTruncatedWarning(')).toBeGreaterThan(helperStart);
    expect(source.indexOf('= outputTruncatedWarning(')).toBeLessThan(helperEnd);
    // The truncation fact must be assembled BEFORE the timeout throw, or the timeout
    // path ships an empty list again (the regression this test exists for).
    const timeoutThrow = source.indexOf("throw new IpynbError('exec_timeout'");
    const timeoutAssembly = source.indexOf('pushCallWarnings(warnings, executed, droppedMimes);');
    expect(timeoutAssembly).toBeGreaterThan(0);
    expect(timeoutAssembly).toBeLessThan(timeoutThrow);
  });
});

describe('[P1-c] the sidecar environment is merged, not replaced', () => {
  /** A ChildProcess stand-in: the transport only attaches listeners in its ctor. */
  function fakeChild(): EventEmitter & Record<string, unknown> {
    const stream = new EventEmitter() as EventEmitter & { write: () => boolean; end: () => void };
    stream.write = () => true;
    stream.end = () => undefined;
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child['stdout'] = stream;
    child['stderr'] = stream;
    child['stdin'] = stream;
    child['kill'] = () => true;
    child['pid'] = 4242;
    return child;
  }

  it('a transport built with a partial env still gives the sidecar PATH', async () => {
    // A source-text assertion cannot show this; the constructor can. A transport
    // created with a partial `env` must still hand the child the parent's variables,
    // or the sidecar and every executed cell lose PATH/TEMP/HOME — which is how 45
    // HMAC-bearing connection files ended up in the working directory (v7 P1-c).
    const { SidecarTransport } = await import('../../src/kernel/sidecar-transport.js');
    const spawned: Array<Record<string, unknown>> = [];
    new SidecarTransport({
      interpreterPath: 'python',
      env: { IPYNB_TEST_MARKER: '1' },
      onLog: () => undefined,
      spawnImpl: ((_command: string, _args: readonly string[], options: Record<string, unknown>) => {
        spawned.push(options);
        return fakeChild();
      }) as never,
    });
    // Spawning is synchronous; `shutdownAll()` waits for an exit the stand-in
    // never produces, so nothing here awaits it.

    expect(spawned).toHaveLength(1);
    const env = spawned[0]!['env'] as Record<string, string | undefined>;
    // The caller's variable survives…
    expect(env['IPYNB_TEST_MARKER']).toBe('1');
    // …and so do the parent's, which the old `{ ...options.env }` dropped.
    expect(Object.keys(env).length).toBeGreaterThan(1);
    if (process.env['PATH'] !== undefined) {
      expect(env['PATH']).toBe(process.env['PATH']);
    }
    // PYTHONUNBUFFERED/PYTHONIOENCODING are this tool's own, and must still win.
    expect(env['PYTHONUNBUFFERED']).toBe('1');
    expect(env['PYTHONIOENCODING']).toBe('utf-8');
  });

  it('the called env cannot smuggle a cwd onto the child', async () => {
    // The other half of P1-c: the connection file goes to the interpreter's TEMP
    // directory, so the child must not be given a working directory of our choosing
    // (the transport never sets `cwd`). Pinned because setting one would silently
    // reintroduce the "files land in the repository" failure.
    const { SidecarTransport } = await import('../../src/kernel/sidecar-transport.js');
    const spawned: Array<Record<string, unknown>> = [];
    new SidecarTransport({
      interpreterPath: 'python',
      env: {},
      onLog: () => undefined,
      spawnImpl: ((_command: string, _args: readonly string[], options: Record<string, unknown>) => {
        spawned.push(options);
        return fakeChild();
      }) as never,
    });
    // Spawning is synchronous; `shutdownAll()` waits for an exit the stand-in
    // never produces, so nothing here awaits it.
    expect(spawned[0]).not.toHaveProperty('cwd');
  });
});
