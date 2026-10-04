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
  DROPPED_MIME_DETAIL_LIMIT,
  assembleCallWarnings,
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

  it('[V9-8] the count rule keys on whether there are outputs, not on the key being present', () => {
    // v7 shape: "a cell with no outputs key at all is still checked", because the count
    // lives on the cell and not on an output. v9 moved the boundary — a count with no
    // outputs to belong to is not something this gate needs to refuse, and refusing it
    // made the documented escape hatch impossible (V9-8) — so the assertion is inverted
    // here on purpose. What must NOT change is the other direction: the same count on a
    // cell that HAS outputs is still refused, which the next cases cover.
    const parsed = parseNotebook(
      new TextEncoder().encode(JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', execution_count: -3 }],
      })),
      hasher,
    );
    expect(findStructuralProblem(parsed.doc)).toBeNull();
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
    // Empty outputs, and no outputs key at all: nothing for the count to belong to. The
    // second spelling is the one this file's own probe caught — requiring `[]` exactly
    // left a cell without an `outputs` key permanently refused, the same lockout in a
    // different spelling of the same state.
    expect(findStructuralProblem(docWithCell({ execution_count: -1, outputs: [] }).doc)).toBeNull();
    expect(findStructuralProblem(docWithCell({ execution_count: -1 }).doc)).toBeNull();
    // …but a cell whose outputs are ALSO malformed is still reported on the count rule:
    // "clear the outputs" fixes both, and its hint is the one that unsticks the caller.
    expect(
      findStructuralProblem(
        docWithCell({
          execution_count: -1,
          outputs: [{ output_type: 'display_data', data: { 'text/plain': 5 }, metadata: {} }],
        }).doc,
      ),
    ).toMatchObject({ rule: 'execution_count_negative' });
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

  it('[V10-9] the dropped-mime list is bounded, and the count stays exact', () => {
    // A cell can name the mime keys, so an unbounded list lets it size the response —
    // the reviewer measured 9 897 characters from a 300-iteration loop (review v10 V10-9).
    const many = Array.from({ length: 300 }, (_, index) => ({
      cellIndex: 0,
      mime: `application/x-bogus-${String(index)}`,
    }));
    const warning = outputTruncatedWarning(many, 0);
    expect(warning).not.toBeNull();
    const message = warning!.message;
    expect(message).toContain('dropped 300');
    expect(message).toContain('application/x-bogus-0');
    // The tail is summarised, not silently dropped: the model is told how many it is
    // not seeing. 300 names would be ~6 600 characters; the cap keeps it under 400.
    expect(message).toContain('… and 292 more');
    expect(message).not.toContain('application/x-bogus-299');
    expect(message.length).toBeLessThan(400);
    // Under the cap, every name is still listed.
    const few = many.slice(0, DROPPED_MIME_DETAIL_LIMIT);
    const short = outputTruncatedWarning(few, 0)!.message;
    expect(short).not.toContain('more');
    expect(short).toContain(`application/x-bogus-${String(DROPPED_MIME_DETAIL_LIMIT - 1)}`);
  });

  it('[V11-7] one long mime name cannot size the message either', () => {
    // V10-9 capped the number of ENTRIES, and the reviewer showed that is not a cap on the
    // message: a single 20 000 character mime name produced a 20 176 character warning, and
    // the growth was linear in the name. The invariant has to be about the message.
    const longName = `application/x-${'b'.repeat(20_000)}`;
    const warning = outputTruncatedWarning([{ cellIndex: 0, mime: longName }], 0);
    expect(warning).not.toBeNull();
    const message = warning!.message;
    expect(message.length, `message was ${String(message.length)} characters`).toBeLessThan(400);
    expect(message).toContain('application/x-');
    // The cut is visible, so a shortened name is not read as the real one.
    expect(message).toContain('…');
    // …and a name that fits is left exactly as it was.
    const short = outputTruncatedWarning([{ cellIndex: 2, mime: 'application/vnd.plotly.v1+json' }], 0)!;
    expect(short.message).toContain('application/vnd.plotly.v1+json');
    expect(short.message).not.toContain('…');
  });

  it('[V11-7] the bound holds for the worst combination of the two limits', () => {
    // Eight maximum-length names is the largest message the entry cap allows, so this is the
    // number the invariant is really about: 8 × (64 + a cell label) + framing, under 1 KB.
    const dropped = Array.from({ length: DROPPED_MIME_DETAIL_LIMIT }, (_, index) => ({
      cellIndex: index,
      mime: `application/x-${String(index)}-${'z'.repeat(500)}`,
    }));
    const message = outputTruncatedWarning(dropped, 0)!.message;
    expect(message.length).toBeLessThan(1000);
    expect(message).toContain(`dropped ${String(DROPPED_MIME_DETAIL_LIMIT)}`);
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

  it('[V10-5] the assembly rule is a core function a unit test can falsify', () => {
    // V8-4's finding was that this file proved the PROJECTION and nothing about the run.
    // v9's answer was better but still weak: the rule lived inline behind a private
    // helper in `run.ts`, so the reviewer's mutation — short-circuit the helper — left
    // all 432 unit cases green and only the integration suite noticed. The rule is now
    // `assembleCallWarnings` in core, driven here with REAL inputs.
    const truncated: OutputItem = {
      kind: 'stream',
      stream_name: 'stdout',
      text: 'x'.repeat(10),
      truncated: true,
      truncated_at_chars: 10,
    };
    const inexact: OutputItem = {
      kind: 'json',
      value: 18446744073709552000,
      warnings: [{ code: 'output_truncated', message: 'json value 18446744073709551616 was not representable exactly' }],
    };
    const plain: OutputItem = {
      kind: 'stream',
      stream_name: 'stdout',
      text: 'ok',
      truncated: false,
      truncated_at_chars: null,
    };

    // All three facts, in one call: a dropped value, a truncation, an inexact number.
    const all = assembleCallWarnings(
      [{ outputs: [truncated, inexact] }],
      [{ cellIndex: 0, mime: 'text/plain' }],
    );
    expect(all).toHaveLength(2);
    expect(all[0]!.message).toContain('dropped 1');
    expect(all[0]!.message).toContain('cell 0: text/plain');
    expect(all[0]!.message).toContain('1 output(s) exceeded inline_text_chars');
    expect(all[1]!.message).toContain('18446744073709551616');

    // Nothing lost, nothing said — the case a blanket push would break.
    expect(assembleCallWarnings([{ outputs: [plain] }], [])).toEqual([]);

    // Deduplicated: the same inexact literal in two cells is one fact, and calling the
    // assembly twice must not double it either.
    const twice = assembleCallWarnings([{ outputs: [inexact] }, { outputs: [inexact] }], []);
    expect(twice).toHaveLength(1);
    expect(all.map((warning) => warning.code)).toEqual(['output_truncated', 'output_truncated']);
  });

  it('[V9-7][V10-7] every terminal exit routes its warnings through one assembly', async () => {
    // The remaining source-level claim, kept because it is about WIRING rather than
    // about the rule: the assembly is called before the timeout throw, and the aborted /
    // kernel_died exits pass the collected warnings into `failedRunError` (v10 V10-7 — a
    // run that had already written the file and dropped values reported nothing).
    const source = await readFile(new URL('../../src/run.ts', import.meta.url), 'utf8');
    expect(source).toContain('function pushCallWarnings(');
    const timeoutThrow = source.indexOf("throw new IpynbError('exec_timeout'");
    const timeoutAssembly = source.lastIndexOf('pushCallWarnings(warnings, executed, droppedMimes);', timeoutThrow);
    expect(timeoutAssembly).toBeGreaterThan(0);
    expect(timeoutAssembly).toBeLessThan(timeoutThrow);
    // Every abort exit collects first and hands the result over.
    const abortCalls = source.match(/throw await abortedRunError\(/g) ?? [];
    expect(abortCalls.length).toBeGreaterThanOrEqual(3);
    expect(source.match(/\{ warnings, droppedMimes \},/g)?.length ?? 0).toBeGreaterThanOrEqual(abortCalls.length);
    // And nothing re-derives the rule locally any more.
    expect(source).not.toContain('outputTruncatedWarning(');
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
