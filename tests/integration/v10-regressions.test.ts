// End-to-end cases for the two v10 blockers, on a real file with the real authority.
//
// V10-6: `parseJsonExact` replaced `JSON.parse` for the whole notebook, and it assigned
// keys with `result[key] = value`. For a key named `__proto__` that runs
// `Object.prototype`'s setter instead of storing anything, so the key vanished from the
// response AND from the next write — the tool deleted data from a user's file while
// reporting `applied: 1` and no warnings, and the file stayed valid nbformat so nothing
// else noticed.
//
// V10-3: any write re-serializes the whole document, so a high-precision DECIMAL in a
// cell the edit did not touch was rewritten. Both cases are asserted at the layer that
// reaches the user: the bytes on disk, checked by Python's `nbformat.validate` as well
// as by this project's own parser.

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IpynbError, JsonValue } from '../../src/core/errors.js';
import { hasher } from '../../src/hash.js';
import { SIDECAR_REQUIRED_MODULES } from '../../src/kernel/interpreter.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { createLogger } from '../../src/log.js';
import { PathFence } from '../../src/fs/fence.js';
import type { ToolContext } from '../../src/mcp/context.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { handleNotebookEdit } from '../../src/mcp/tools/edit.js';
import { handleNotebookRead } from '../../src/mcp/tools/read.js';
import { toCallToolResult } from '../../src/mcp/tools/result.js';
import { nbformatSkipReason, validateNotebook } from './nbformat-validator.js';
import { BASE_PYTHON, VENV_PY, prepareVenv, resolvedTestInterpreter } from './test-venv.js';

let workspace: string;
let registry: KernelRegistry;

beforeAll(async () => {
  prepareVenv({ modules: SIDECAR_REQUIRED_MODULES });
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-v10-'));
  registry = new KernelRegistry({ idleSeconds: 3600 });
  registry.start();
}, 180_000);

afterAll(async () => {
  await registry.shutdownAll();
  await rm(workspace, { recursive: true, force: true });
}, 120_000);

function context(): ToolContext {
  return {
    config: {
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
    },
    fence: new PathFence(workspace, false, process.platform),
    registry,
    runStore: new RunStore(),
    hasher,
    logger: createLogger('error'),
    realpath: (target) => target,
    platform: process.platform,
  };
}

/** The parsed body of a tool result, or the error body. */
function bodyOf(outcome: Awaited<ReturnType<typeof handleNotebookRead>>): Record<string, unknown> {
  const result = toCallToolResult(outcome);
  return JSON.parse(String((result.content[0] as { text: string }).text)) as Record<string, unknown>;
}

/** The warnings of the first output of the first cell of a read body. */
function itemWarnings(body: Record<string, unknown>): unknown[] {
  const cells = body['cells'] as Array<Record<string, unknown>> | undefined;
  const outputs = cells?.[0]?.['outputs'] as Array<Record<string, unknown>> | null | undefined;
  return (outputs?.[0]?.['warnings'] as unknown[] | undefined) ?? [];
}

/** The projected value of the first output of the first cell of a read body. */
function itemValue(body: Record<string, unknown>): unknown {
  const cells = body['cells'] as Array<Record<string, unknown>> | undefined;
  const outputs = cells?.[0]?.['outputs'] as Array<Record<string, unknown>> | null | undefined;
  return outputs?.[0]?.['value'];
}

const DECIMAL = '0.1234567890123456789012345';

/**
 * A notebook with `__proto__` in three different places and a high-precision decimal.
 *
 * Built as TEXT rather than by stringifying an object: `JSON.stringify` would round the
 * decimal before the file existed (that is v10-3's bug, and a fixture carrying the rounded
 * value cannot test it), and a JS object literal cannot express the `__proto__` KEY at
 * all — `{"__proto__": …}` in source sets the prototype and drops the key, which is the
 * very confusion this defect is about.
 */
const NOTEBOOK_TEXT = `${[
  '{',
  ' "cells": [',
  '  {',
  '   "cell_type": "code",',
  '   "execution_count": 1,',
  '   "id": "c0",',
  '   "metadata": {',
  '    "__proto__": {',
  '     "inCellMetadata": 1',
  '    },',
  '    "keep": "me"',
  '   },',
  '   "outputs": [',
  '    {',
  '     "data": {',
  '      "application/json": {',
  '       "__proto__": {',
  '        "inOutput": true',
  '       },',
  '       "safe": 1,',
  `       "decimal": ${DECIMAL}`,
  '      }',
  '     },',
  '     "metadata": {},',
  '     "output_type": "display_data"',
  '    }',
  '   ],',
  '   "source": [',
  '    "x = 1"',
  '   ]',
  '  },',
  '  {',
  '   "cell_type": "code",',
  '   "execution_count": null,',
  '   "id": "c1",',
  '   "metadata": {},',
  '   "outputs": [],',
  '   "source": [',
  '    "y = 1"',
  '   ]',
  '  }',
  ' ],',
  ' "metadata": {',
  '  "__proto__": {',
  '   "inNotebookMetadata": 1',
  '  }',
  ' },',
  ' "nbformat": 4,',
  ' "nbformat_minor": 5',
  '}',
  '',
].join('\n')}`;


describe('[V10-6] a __proto__ key in a notebook survives read, edit and validation', () => {
  it('[V10-6] the read returns the key it read, and does not touch the file', async () => {
    const target = path.join(workspace, 'proto-read.ipynb');
    await writeFile(target, NOTEBOOK_TEXT, 'utf8');
    const before = await readFile(target, 'utf8');

    const outcome = await handleNotebookRead(context(), { path: target, include_outputs: 'full' });
    const body = bodyOf(outcome);
    expect(body['code'], JSON.stringify(body)).toBeUndefined();

    // ① The key the file has, the response has. `notebook_read` projects per-cell fields
    // (source, outputs) rather than the raw cell object, so the occurrence that can reach
    // a response is the one inside the json OUTPUT value. The cell-metadata and
    // notebook-metadata occurrences are asserted in the next case, on the file AFTER a
    // write — because a write is what used to delete them.
    const text = JSON.stringify(body);
    expect(text.match(/"__proto__"/g)).toHaveLength(1);
    expect(text).toContain('inOutput');
    // ② Reading is not writing.
    expect(await readFile(target, 'utf8')).toBe(before);

    // ③ The high-precision decimal in that same output is reported with its digits and is
    // not rounded in the response either — the read half of v10-3. (Exactly one warning:
    // the decimal is the only value here a double cannot carry.)
    const value = itemValue(body) as { decimal: number };
    expect(String(value.decimal)).toBe(String(Number(DECIMAL)));
    const messages = itemWarnings(body).map((warning) => (warning as { message: string }).message);
    expect(messages).toHaveLength(1);
    expect(messages.join('\n')).toContain(DECIMAL);
  });

  it('[V10-6] editing an unrelated cell keeps every __proto__ key and the decimal', async () => {
    const target = path.join(workspace, 'proto-edit.ipynb');
    await writeFile(target, NOTEBOOK_TEXT, 'utf8');

    const outcome = await handleNotebookEdit(context(), {
      path: target,
      ops: [{ op: 'replace_source', cell_index: 1, expected_text: 'y = 1', new_text: 'y = 2' }],
    });
    const body = bodyOf(outcome as Awaited<ReturnType<typeof handleNotebookRead>>);
    expect(body['code'], JSON.stringify(body)).toBeUndefined();
    expect(body['applied']).toBe(1);

    // The file after the write: the keys are still there (the v10-6 symptom was `x2 → x0`).
    const after = await readFile(target, 'utf8');
    expect(after.match(/"__proto__"/g)).toHaveLength(3);
    expect(after).toContain('inCellMetadata');
    expect(after).toContain('inOutput');
    expect(after).toContain('inNotebookMetadata');
    // …and the untouched decimal is byte-identical (v10-3's symptom).
    expect(after).toContain(DECIMAL);
    expect(after).toContain('"y = 2"');

    // The external authority, on the file as it sits on disk.
    const skip = nbformatSkipReason(resolvedTestInterpreter());
    if (skip !== null) {
      expect(skip).toContain('nbformat');
      return;
    }
    const validation = validateNotebook(target, resolvedTestInterpreter());
    expect(validation.ok, validation.message).toBe(true);
  });

  it('[V10-6] a value shaped like our marker is the user\'s object, not a number', async () => {
    // The forgery the review reproduced: the file holds an OBJECT, and the old marker
    // check accepted it, so the model received `42` plus a fabricated precision warning
    // and the write-back replaced the object with a bare number.
    const target = path.join(workspace, 'proto-marker.ipynb');
    const text = `${JSON.stringify(
      {
        cells: [
          {
            cell_type: 'code',
            execution_count: null,
            id: 'c0',
            metadata: {},
            outputs: [
              {
                data: { 'application/json': JSON.parse('{"__ipynb_exact_number__": "42", "a": 1}') },
                metadata: {},
                output_type: 'display_data',
              },
            ],
            source: ['x'],
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      },
      null,
      1,
    )}\n`;
    await writeFile(target, text, 'utf8');

    const outcome = await handleNotebookRead(context(), { path: target, include_outputs: 'full' });
    const body = bodyOf(outcome);
    const cells = body['cells'] as Array<Record<string, unknown>>;
    const outputs = cells[0]!['outputs'] as Array<Record<string, unknown>>;
    const item = outputs[0]!;
    expect(item['kind']).toBe('json');
    // The object comes back as an object, with no invented warning.
    expect(item['value']).toEqual({ __ipynb_exact_number__: '42', a: 1 });
    expect(item['warnings']).toEqual([]);

    // And a write keeps the object exactly as the file had it.
    const editOutcome = await handleNotebookEdit(context(), {
      path: target,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x', new_text: 'x2' }],
    });
    const editBody = bodyOf(editOutcome as Awaited<ReturnType<typeof handleNotebookRead>>);
    expect(editBody['code'], JSON.stringify(editBody)).toBeUndefined();
    const after = await readFile(target, 'utf8');
    expect(after).toContain('"__ipynb_exact_number__": "42"');
    expect(after).toContain('"a": 1');
  });
});

describe('[V11-6] a count in any legal spelling stays a number the model can use', () => {
  /** A cell whose count is legal for nbformat but not a plain JS-safe integer. */
  const COUNT_NOTEBOOK = (literal: string, withOutputs: boolean): string =>
    `{\n "cells": [\n  {\n   "cell_type": "code",\n   "execution_count": ${literal},\n   "id": "c0",\n   "metadata": {},\n   "outputs": [${withOutputs ? '\n    {\n     "name": "stdout",\n     "output_type": "stream",\n     "text": "x\\n"\n    }\n   ' : ''}],\n   "source": [\n    "x = 1"\n   ]\n  }\n ],\n "metadata": {\n  "kernelspec": {\n   "display_name": "Python 3",\n   "language": "python",\n   "name": "python3"\n  },\n  "language_info": {\n   "name": "python"\n  }\n },\n "nbformat": 4,\n "nbformat_minor": 5\n}\n`;

  it('[V11-6] a huge count is returned as a number, not as our internal marker', async () => {
    const target = path.join(workspace, 'big-count.ipynb');
    await writeFile(target, COUNT_NOTEBOOK('9007199254740993', true), 'utf8');
    // The authority: this file is VALID nbformat (verified against nbformat 5.10 while
    // writing this case — Python integers have no 2^53 ceiling).
    const skip = nbformatSkipReason(resolvedTestInterpreter());
    if (skip === null) {
      expect(validateNotebook(target, resolvedTestInterpreter()).ok).toBe(true);
    }

    const body = bodyOf(await handleNotebookRead(context(), { path: target, include_outputs: 'full' }));
    const cell = (body['cells'] as Array<Record<string, unknown>>)[0]!;
    // ① The model sees a number. Before the fix it saw
    // `{"__ipynb_exact_number__": "9007199254740993"}` — a structure that exists nowhere.
    expect(typeof cell['execution_count'], JSON.stringify(cell)).toBe('number');
    expect(cell['execution_count']).toBe(Number('9007199254740993'));
    expect(JSON.stringify(body)).not.toContain('__ipynb_exact_number__');
  });

  it('[V11-6] editing a VALID file is not refused, and no hint claims it was already broken', async () => {
    // The second half of the finding: with outputs present the count rule fired and told the
    // caller their file "already violated" a rule that nbformat does not have.
    const target = path.join(workspace, 'big-count-edit.ipynb');
    await writeFile(target, COUNT_NOTEBOOK('9007199254740993', true), 'utf8');
    const outcome = await handleNotebookEdit(context(), {
      path: target,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 2' }],
    });
    const body = bodyOf(outcome as Awaited<ReturnType<typeof handleNotebookRead>>);
    expect(body['code'], `a legal count must not block an edit: ${JSON.stringify(body)}`).toBeUndefined();
    // …and the digits are still in the file, unchanged.
    expect(await readFile(target, 'utf8')).toContain('"execution_count": 9007199254740993');
  });

  it('[V11-6] a count nbformat rejects is refused, with a hint that fits the reason', async () => {
    // `1.5` is what nbformat rejects: the schema is `"type": ["integer", "null"]`. The rule is
    // split in two so each message can be accurate — the v10 wording covered `-1` and `1.5`
    // with one sentence, and it described a legal file as a pre-existing violation.
    const target = path.join(workspace, 'float-count.ipynb');
    await writeFile(target, COUNT_NOTEBOOK('1.5', true), 'utf8');
    const outcome = await handleNotebookEdit(context(), {
      path: target,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 2' }],
    });
    const body = bodyOf(outcome as Awaited<ReturnType<typeof handleNotebookRead>>);
    expect(body['code'], JSON.stringify(body)).toBe('selfcheck_failed');
    const detail = body['detail'] as Record<string, unknown>;
    expect(detail['problem']).toMatchObject({ rule: 'execution_count_not_an_integer' });
    const hint = String(detail['hint'] ?? '');
    expect(hint).toContain('whole number of executions');
    // The wording written for `-1` must not be used for a count that is merely fractional,
    // and the count itself is reported without our marker.
    expect(hint).not.toContain('negative');
    expect(JSON.stringify(detail)).not.toContain('__ipynb_exact_number__');
  });
});

describe('[V12-1] a literal that underflows to zero survives an unrelated edit', () => {
  /** A notebook whose cell 0 holds `literal` in a json output and whose cell 1 is editable. */
  const TWO_CELLS = (literal: string): string =>
    `{\n "cells": [\n  {\n   "cell_type": "code",\n   "execution_count": 1,\n   "id": "c0",\n   "metadata": {},\n   "outputs": [\n    {\n     "data": {\n      "application/json": ${literal}\n     },\n     "metadata": {},\n     "output_type": "display_data"\n    }\n   ],\n   "source": [\n    "x"\n   ]\n  },\n  {\n   "cell_type": "code",\n   "execution_count": null,\n   "id": "c1",\n   "metadata": {},\n   "outputs": [],\n   "source": [\n    "y = 1"\n   ]\n  }\n ],\n "metadata": {},\n "nbformat": 4,\n "nbformat_minor": 5\n}\n`;

  it('[V12-1] editing the OTHER cell leaves the underflowing literal on disk', async () => {
    // The v12 blocker: the value cannot be held by a double (it becomes zero), so a write must
    // keep the literal — and the READ side must not hand the model a bare `0` with no
    // explanation. v11 had an early return that treated every zero as "exactly zero".
    for (const literal of ['1e-400', '1e-324', '2e-400', '-1e-400']) {
      const target = path.join(workspace, `underflow-${literal.replace(/[^0-9a-zA-Z]/g, '_')}.ipynb`);
      await writeFile(target, TWO_CELLS(literal), 'utf8');
      // The file is legal nbformat before and after; the digits are what must not move.
      const skip = nbformatSkipReason(resolvedTestInterpreter());
      if (skip === null) {
        expect(validateNotebook(target, resolvedTestInterpreter()).ok, literal).toBe(true);
      }

      const outcome = await handleNotebookEdit(context(), {
        path: target,
        ops: [{ op: 'replace_source', cell_index: 1, expected_text: 'y = 1', new_text: 'y = 2' }],
      });
      const body = bodyOf(outcome as Awaited<ReturnType<typeof handleNotebookRead>>);
      expect(body['code'], `${literal}: ${JSON.stringify(body)}`).toBeUndefined();
      const written = await readFile(target, 'utf8');
      expect(written, `${literal} must survive the write`).toContain(`"application/json": ${literal}`);
      expect(written).toContain('"y = 2"');

      // …and the response says what happened instead of quietly reporting zero.
      const read = bodyOf(await handleNotebookRead(context(), { path: target, include_outputs: 'full' }));
      const warnings = (read['warnings'] ?? []) as Array<{ message: string }>;
      const joined = warnings.map((warning) => warning.message).join('\n');
      expect(joined, `${literal} must be reported`).toContain(literal);
      expect(joined, `${literal} must be described as underflow`).toContain('underflows to zero');
      expect(joined, 'the negative-zero sentence is false here').not.toContain('negative zero');
    }
  });

  it('[V12-1] the same literals are reported on the DEFAULT read path too', async () => {
    // The v11 V11-5 rule, applied to the new warnings: whatever the default output mode shows
    // must be qualified. Without this the fix would only exist in `full`, which is the bug v11
    // fixed one layer down.
    const target = path.join(workspace, 'underflow-default.ipynb');
    await writeFile(target, TWO_CELLS('1e-400'), 'utf8');
    const body = bodyOf(await handleNotebookRead(context(), { path: target }));
    const warnings = (body['warnings'] ?? []) as Array<{ message: string }>;
    const joined = warnings.map((warning) => warning.message).join('\n');
    expect(joined).toContain('1e-400');
    expect(joined).toContain('underflows to zero');
  });
});

describe('[V10-4] the hint is judged by the authority, not by our own gate', () => {
  /** A code cell that nbformat rejects for its negative count, with stale outputs. */
  const NEGATIVE_COUNT = `${[
    '{',
    ' "cells": [',
    '  {',
    '   "cell_type": "code",',
    '   "execution_count": -1,',
    '   "id": "c0",',
    '   "metadata": {},',
    '   "outputs": [',
    '    {',
    '     "name": "stdout",',
    '     "output_type": "stream",',
    '     "text": "stale\\n"',
    '    }',
    '   ],',
    '   "source": [',
    '    "x = 1"',
    '   ]',
    '  }',
    ' ],',
    ' "metadata": {',
    '  "kernelspec": {',
    '   "display_name": "Python 3",',
    '   "language": "python",',
    '   "name": "python3"',
    '  },',
    '  "language_info": {',
    '   "name": "python"',
    '  }',
    ' },',
    ' "nbformat": 4,',
    ' "nbformat_minor": 5',
    '}',
    '',
  ].join('\n')}`;

  it('[V10-4] clear_outputs is accepted, and the file is still INVALID for nbformat', async () => {
    const skip = nbformatSkipReason(resolvedTestInterpreter());
    if (skip !== null) {
      expect(skip).toContain('nbformat');
      return;
    }
    const target = path.join(workspace, 'negative-count.ipynb');
    await writeFile(target, NEGATIVE_COUNT, 'utf8');
    // The fixture itself is invalid: proof that the authority is looking at something.
    expect(validateNotebook(target, resolvedTestInterpreter()).ok).toBe(false);

    const outcome = await handleNotebookEdit(context(), {
      path: target,
      ops: [{ op: 'clear_outputs', cell_index: 0 }],
    });
    const body = bodyOf(outcome as Awaited<ReturnType<typeof handleNotebookRead>>);
    expect(body['code'], JSON.stringify(body)).toBeUndefined();

    // The count is untouched (SPEC §4.5 rule 5)…
    const written = JSON.parse(await readFile(target, 'utf8')) as { cells: Array<Record<string, unknown>> };
    expect(written.cells[0]!['outputs']).toEqual([]);
    expect(written.cells[0]!['execution_count']).toBe(-1);
    // …so OUR gate accepts the edit but the AUTHORITY still refuses the file. This pair
    // is exactly what the hint has to describe, and what v9's wording got wrong.
    const validation = validateNotebook(target, resolvedTestInterpreter());
    expect(validation.ok, 'clear_outputs must not be described as making the file valid').toBe(false);
    expect(validation.message).toContain('-1');
  });

  it('[V10-4] the other operation in the hint really does make the file valid', async () => {
    const skip = nbformatSkipReason(resolvedTestInterpreter());
    if (skip !== null) {
      expect(skip).toContain('nbformat');
      return;
    }
    const target = path.join(workspace, 'set-cell-type.ipynb');
    await writeFile(target, NEGATIVE_COUNT, 'utf8');
    const outcome = await handleNotebookEdit(context(), {
      path: target,
      ops: [{ op: 'set_cell_type', cell_index: 0, cell_type: 'markdown', expected_text: 'x = 1' }],
    });
    const body = bodyOf(outcome as Awaited<ReturnType<typeof handleNotebookRead>>);
    expect(body['code'], JSON.stringify(body)).toBeUndefined();
    const validation = validateNotebook(target, resolvedTestInterpreter());
    expect(validation.ok, validation.message).toBe(true);
  });
});

describe('[V10-7] a cancelled run still reports what its completed cells lost', () => {
  /**
   * Cell 0 drops a value nbformat cannot store; cell 1 sleeps long enough to be cancelled.
   *
   * Cancelling runs the failure path: completed cells are written back (so the file HAS
   * changed) and the terminal error is `cancelled`. Before v10 that detail carried
   * `warnings: []` — the model was told nothing was lost while the file had already been
   * rewritten (review v10 V10-7).
   */
  const DROP_THEN_SLEEP = [
    "display({'text/plain': 5}, raw=True)",
    'import time\ntime.sleep(20)',
  ] as const;

  it('[V10-7] the cancelled detail names the dropped cell', async () => {
    const { runNotebook } = await import('../../src/run.js');
    const target = path.join(workspace, 'abort-warnings.ipynb');
    await writeFile(target, `${JSON.stringify(
      {
        cells: DROP_THEN_SLEEP.map((source, index) => ({
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
    )}\n`, 'utf8');

    // The abort must land while cell 1 is IN FLIGHT, and the test cannot guess a duration
    // for that: under load cell 0 may still be starting when a timer fires, which would
    // leave the run with nothing executed and the assertion (rightly) with nothing to
    // check. The progress callback is the run's own signal, so the abort is driven by it —
    // cell 1 is announced, then a moment passes so the cell is really executing.
    //
    // The sleep is short (20 s) on purpose: where the interrupt does not land (Windows has
    // no console to deliver it) the run waits for that cell to finish, so the cell's own
    // duration is the test's duration.
    const controller = new AbortController();
    let aborted = false;
    const abortOnSecondCell = (): void => {
      if (aborted) {
        return;
      }
      aborted = true;
      controller.abort();
    };

    let failure: IpynbError | null = null;
    try {
      await runNotebook(
        {
          path: target,
          cellSelector: 'all',
          mode: 'auto',
          timeoutSeconds: 120,
          writeOutputs: true,
          clearOutputsBefore: true,
          createBackup: false,
          abort: { signal: controller.signal, reason: 'cancelled' },
        },
        {
          registry,
          hasher,
          config: context().config,
          imagesPolicy: 'auto',
          realpath: (value) => value,
          onProgress: (event) => {
            if (event.phase === 'cell' && event.current_cell_index === 1) {
              // Deferred a moment: the progress event is emitted BEFORE the cell runs, and
              // an abort that lands between cells still exercises the terminal path but
              // not the in-flight one this case is about.
              setTimeout(abortOnSecondCell, 1_000);
            }
          },
        },
      );
    } catch (cause) {
      failure = cause as IpynbError;
    }

    expect(failure, 'the run should have been cancelled').not.toBeNull();
    expect(failure!.code).toBe('cancelled');
    // The abort really was driven by cell 1 starting, so cell 0's work exists to report.
    expect(aborted, 'cell 1 must have been announced before the abort').toBe(true);
    const detail = failure!.detail as Record<string, unknown>;
    // The earlier cell is reported as executed — the run got far enough to have dropped a
    // value. (`write_back.performed` is not asserted here: cell 0's output was an
    // UNREPRESENTABLE value, so clearing and dropping it leaves the file's bytes
    // unchanged, and "nothing changed" is the honest report. The v10-7 defect is about the
    // warnings, not about the write.)
    const executed = detail['executed'] as Array<Record<string, unknown>>;
    expect(executed.length).toBeGreaterThanOrEqual(1);
    expect(executed[0]!['cell_index']).toBe(0);
    // …and the value it dropped is reported, by cell, in the terminal detail. Before the
    // fix this array was EMPTY while the model had already lost the value.
    const warnings = detail['warnings'] as Array<{ code: string; message: string }>;
    expect(Array.isArray(warnings)).toBe(true);
    const messages = warnings.map((warning) => warning.message).join('\n');
    expect(messages, "the cancelled detail lost the earlier cell's warning").toContain('cell 0');
    expect(messages).toContain('text/plain');
  }, 120_000);
});

describe('[V10-3] a high-precision number in an untouched cell is not rewritten', () => {
  it('[V10-3] the edit that names cell 1 leaves cell 0 output byte-identical', async () => {
    const target = path.join(workspace, 'decimal-edit.ipynb');
    // Every form, in the cell that will NOT be edited.
    const forms = ['0.1234567890123456789012345', '1.0000000000000001', '3.141592653589793238462643383279', '1E+2', '-0'];
    const outputs = forms.map((literal) => `      "${literal}"`).join(',\n');
    const text = `{\n "cells": [\n  {\n   "cell_type": "code",\n   "execution_count": 1,\n   "id": "c0",\n   "metadata": {},\n   "outputs": [\n    {\n     "data": {\n      "application/json": [\n${outputs}\n      ]\n     },\n     "metadata": {},\n     "output_type": "display_data"\n    }\n   ],\n   "source": [\n    "x"\n   ]\n  },\n  {\n   "cell_type": "code",\n   "execution_count": null,\n   "id": "c1",\n   "metadata": {},\n   "outputs": [],\n   "source": [\n    "y = 1"\n   ]\n  }\n ],\n "metadata": {},\n "nbformat": 4,\n "nbformat_minor": 5\n}\n`;
    await writeFile(target, text, 'utf8');

    const outcome = await handleNotebookEdit(context(), {
      path: target,
      ops: [{ op: 'replace_source', cell_index: 1, expected_text: 'y = 1', new_text: 'y = 2' }],
    });
    const body = bodyOf(outcome as Awaited<ReturnType<typeof handleNotebookRead>>);
    expect(body['code'], JSON.stringify(body)).toBeUndefined();

    const after = await readFile(target, 'utf8');
    for (const literal of forms) {
      expect(after, `${literal} was rewritten`).toContain(literal);
    }
    // The rounded forms must not be there in the value's place.
    expect(after).not.toContain('0.12345678901234568');
    expect(after).not.toContain('3.141592653589793\n');
    expect(after).toContain('"y = 2"');
  });

  it('[V10-3] the values survive a run write-back too', async () => {
    // The run path parses the sidecar message with the same parser, and then writes the
    // document. If either layer rounded, this is where it would show.
    const { runNotebook } = await import('../../src/run.js');
    const target = path.join(workspace, 'decimal-run.ipynb');
    await writeFile(target, `${JSON.stringify(
      {
        cells: [
          {
            cell_type: 'code',
            execution_count: null,
            id: 'c0',
            metadata: {},
            outputs: [],
            source: ["display({'application/json': 3.141592653589793238462643383279}, raw=True)"],
          },
        ],
        metadata: {
          kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
          language_info: { name: 'python' },
        },
        nbformat: 4,
        nbformat_minor: 5,
      },
      null,
      1,
    )}\n`, 'utf8');
    const outcome = await runNotebook(
      {
        path: target,
        cellSelector: 'all',
        mode: 'auto',
        timeoutSeconds: 60,
        writeOutputs: true,
        clearOutputsBefore: true,
        createBackup: false,
      },
      {
        registry,
        hasher,
        config: context().config,
        imagesPolicy: 'auto',
        realpath: (value) => value,
      },
    );
    // Python's repr of that literal is the same digits; what matters is that the file
    // holds them and the run did not round them into a double's short form.
    const after = await readFile(target, 'utf8');
    const item = outcome.executed[0]!.outputs[0] as { kind: string; value: JsonValue };
    expect(item.kind).toBe('json');
    expect(after).toContain('3.141592653589793');
    // The exact digits from Python, if the kernel could carry them at all: Python sends
    // the literal it was given, so either the full 30 digits or the double's own form is
    // acceptable — but the WRITE must not be a normalized double that loses what the
    // kernel actually sent.
    expect(after.includes('3.141592653589793238462643383279') || after.includes(String(Number('3.141592653589793238462643383279')))).toBe(true);
  }, 120_000);
});

// Keep the interpreter selection honest: these cases never start a kernel, but the venv
// arrangement is shared, and a skip reason must name nbformat rather than "no Python".
void existsSync;
void VENV_PY;
void BASE_PYTHON;
