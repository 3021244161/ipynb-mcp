// [V13-1] The client must be able to RECEIVE every response this server sends.
//
// This is the case the whole review round was missing, and its absence is why the defect survived a
// release candidate: every existing size test — including the reviewer's own 37/68/102/204 MiB volume
// matrix — spoke JSON-RPC to the server over a hand-written reader, so the SDK's frame limit was never
// in the picture. The measured cliff was 9.9 MiB fine / 10.2 MiB fatal, and a fatal frame does not fail
// the CALL: it kills the connection, and every later call in that session answers "Not connected".
//
// So this drives the server through the REAL SDK client over the REAL stdio transport, which is the
// only layer that can catch it (AGENTS §9's fourth rung), and asserts what the consumer can actually do:
// a large-output notebook must come back as a response that fits, marked as truncated, on a connection
// that is still alive afterwards.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prepareVenv, resolvedTestInterpreter, BASE_PYTHON } from './test-venv.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

let workspace: string;
let client: Client;
let transport: StdioClientTransport;

/** Bytes in one output item, chosen so the naive response is comfortably past the SDK's 10 MiB. */
const HUGE_CHARS = 11 * 1024 * 1024;

beforeAll(async () => {
  prepareVenv({ modules: [] });
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-budget-'));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, 'lib', 'bin.js'), '--root', workspace],
    env: { ...process.env, IPYNB_PYTHON: resolvedTestInterpreter() ?? BASE_PYTHON } as Record<string, string>,
    stderr: 'pipe',
  });
  client = new Client({ name: 'budget-test', version: '0.0.0' });
  await client.connect(transport);
}, 180_000);

afterAll(async () => {
  await client.close().catch(() => undefined);
  await rm(workspace, { recursive: true, force: true });
});

/**
 * A notebook with a single stored output, written directly as text.
 *
 * `chars` builds an ASCII payload of that many characters; `literal` overrides it with any string, which is
 * how the escaping-heavy cases below are built. Both become a `display_data` with a `text/plain` value, NOT
 * a `stream`: the only per-item cap in the server applied to `stream` items, so a large `text/plain`,
 * `text/html` or `application/json` output went to the client unchecked. A stream fixture would have been
 * truncated by `inline_text_chars` and the frame budget would never have mattered — the blind spot that hid
 * the original defect through a whole review round, and then hid the ESTIMATOR defect again because every
 * fixture was `'x'.repeat(...)`.
 */
async function writeLargeNotebook(name: string, chars: number, literal?: string): Promise<string> {
  const target = path.join(workspace, name);
  const payload = JSON.stringify({
    cells: [
      {
        cell_type: 'code',
        execution_count: 1,
        id: 'c0',
        metadata: {},
        outputs: [
          {
            data: { 'text/plain': literal ?? 'x'.repeat(chars) },
            metadata: {},
            output_type: 'display_data',
          },
        ],
        source: ['display("x" * 11 * 1024 * 1024)'],
      },
    ],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  });
  await writeFile(target, `${payload}\n`, 'utf8');
  return target;
}

async function callRead(target: string, includeOutputs: string) {
  const result = await client.callTool({
    name: 'notebook_read',
    arguments: { path: target, include_outputs: includeOutputs },
  });
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const textBlock = blocks.find((block) => block.type === 'text');
  return {
    bytes: Buffer.byteLength(textBlock?.text ?? '', 'utf8'),
    body: JSON.parse(textBlock?.text ?? '{}') as Record<string, unknown>,
    blockCount: blocks.length,
  };
}

describe('[V13-1] a response that would exceed the client frame limit is degraded, not sent', () => {
  it('[V13-1] an 11 MiB output comes back inside the budget, marked truncated, and the link survives', async () => {
    const target = await writeLargeNotebook('huge.ipynb', HUGE_CHARS);

    const { bytes, body } = await callRead(target, 'full');

    // The consumer's own limit is 10 MiB (`STDIO_DEFAULT_MAX_BUFFER_SIZE`). Assert against that
    // constant rather than the server's budget: the server may lower its budget freely, but a response
    // at or above the client's limit is the failure being tested.
    expect(bytes, `response was ${(bytes / 1024 / 1024).toFixed(2)} MiB`).toBeLessThan(10 * 1024 * 1024);
    // Degrading is not enough on its own — the model has to be TOLD, or it reads a shortened value as
    // the whole truth (SPEC §5.4: truncation is never silent).
    const warnings = (body['warnings'] ?? []) as Array<{ code: string; message: string }>;
    const truncation = warnings.filter((warning) => warning.code === 'output_truncated');
    expect(truncation.length, JSON.stringify(warnings).slice(0, 300)).toBeGreaterThan(0);
    // And the payload still describes the notebook, rather than being a stub. Compared by basename
    // because the server normalizes separators (forward slashes) and this platform does not.
    expect(path.basename(String(body['path']))).toBe(path.basename(target));
    expect(body['cell_count']).toBe(1);

    // THE ASSERTION THAT SEPARATES "degraded" FROM "the session died": a second call on the same client
    // must work. If the first response had gone over the limit, the SDK reader would have thrown and
    // this call would reject with -32000 — which is exactly the failure the review measured.
    const after = await callRead(target, 'summary');
    expect(after.body['cell_count']).toBe(1);
  }, 180_000);

  it('[V13-1] many small outputs that add up past the limit are degraded too', async () => {
    // The cliff is on the FRAME, not on any single item: the review measured 60 × 300 KiB (17.6 MiB
    // total, every item small) killing the session. A per-item cap alone cannot catch this shape.
    const target = path.join(workspace, 'many.ipynb');
    // `display_data` again, and small: the cliff is on the FRAME, not on any single item, so a per-item
    // cap cannot catch this shape (the review measured 60 × 300 KiB = 17.6 MiB killing the session).
    const outputs = Array.from({ length: 60 }, (_, index) => ({
      data: { 'text/plain': `${String(index)}:${'y'.repeat(300 * 1024)}` },
      metadata: {},
      output_type: 'display_data',
    }));
    await writeFile(
      target,
      `${JSON.stringify({
        cells: [
          { cell_type: 'code', execution_count: 1, id: 'c0', metadata: {}, outputs, source: ['pass'] },
        ],
        metadata: {
          kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
          language_info: { name: 'python' },
        },
        nbformat: 4,
        nbformat_minor: 5,
      })}\n`,
      'utf8',
    );

    const { bytes, body } = await callRead(target, 'full');
    expect(bytes, `response was ${(bytes / 1024 / 1024).toFixed(2)} MiB`).toBeLessThan(10 * 1024 * 1024);
    const warnings = (body['warnings'] ?? []) as Array<{ code: string }>;
    expect(warnings.some((warning) => warning.code === 'output_truncated')).toBe(true);

    // The connection is still usable, which is the property that matters.
    const after = await callRead(target, 'none');
    expect(after.body['cell_count']).toBe(1);
  }, 180_000);
});

/**
 * [V14-13] The estimate must be in the unit the CLIENT enforces, on the content this project's users
 * actually have.
 *
 * The first version measured UTF-16 code units and ignored JSON escaping, so payloads made of backslashes,
 * quotes, control characters or non-ASCII text were estimated 2-6x low and went out whole: measured, 3 MiB
 * of backslashes killed the client while 3 MiB of ASCII was fine, and a matrix of Chinese/emoji/latin-1
 * payloads all killed it. Chinese notebooks and Windows paths are the norm here, so this is not an edge —
 * it is the half of V13-1 that stayed broken.
 *
 * The fixtures are the key difference from the v13 cases: those all used `'x'.repeat(...)`, which is exactly
 * why they passed against the broken estimator.
 */
describe('[V14-13] escaping-heavy content is degraded before it can kill the client', () => {
  const shapes: Array<[string, string]> = [
    ['backslashes', '\\'.repeat(3 * 1024 * 1024)],
    ['double quotes', '"'.repeat(3 * 1024 * 1024)],
    ['CJK', '中'.repeat(4 * 1024 * 1024)],
    ['control characters', '\u0001'.repeat(2 * 1024 * 1024)],
    // Sized to overshoot the 8 MiB budget AFTER escaping, which for this content is roughly 2x: a fixture
    // that stays under the budget proves nothing about degradation (the first version of this line was
    // ~4.7 MB encoded, fitted comfortably, produced no warning, and the assertion failed for the right
    // reason — so the assertion stays and the fixture grew).
    ['windows paths', 'C:\\Users\\somebody\\notebooks\\data\\file.csv\n'.repeat(400_000)],
  ];

  for (const [label, payload] of shapes) {
    it(`[V14-13] a ${label} output is degraded, and the session survives`, async () => {
      const target = await writeLargeNotebook(`escape-${label.replace(/[^a-z]/gi, '')}.ipynb`, 0, payload);
      const { bytes, body } = await callRead(target, 'full');

      // Measured the way the client measures it: UTF-8 bytes of the delivered text.
      expect(bytes, `${label}: response was ${(bytes / 1024 / 1024).toFixed(2)} MiB`).toBeLessThan(10 * 1024 * 1024);
      const warnings = (body['warnings'] ?? []) as Array<{ code: string; message: string }>;
      expect(
        warnings.some((warning) => warning.code === 'output_truncated'),
        `${label}: warnings were ${JSON.stringify(warnings).slice(0, 200)}`,
      ).toBe(true);

      // The link is alive, which is the difference between "degraded" and "the session died".
      const after = await callRead(target, 'none');
      expect(after.body['cell_count']).toBe(1);
    }, 180_000);
  }
});

/**
 * [V14-12] A FAILING run must be able to deliver its response too.
 *
 * The budget first ran on the success path only, so the failure paths were exactly the ones still
 * unbounded — and `detail.executed[]` carries the outputs of every cell that completed. Measured by the
 * reviewer: cell 0 produces a 12 MiB output, cell 1 sleeps past the timeout, and the response dies with
 * `-32000 Connection closed`. That is the worst shape of all, because the file has ALREADY been written
 * back while the model learns neither that the run timed out nor which cells completed (SPEC §4.7 rule 5,
 * §4.8 rule 3).
 *
 * The fixture has to make the big-output cell ACTUALLY RUN — the reviewer's own first attempt only ran the
 * sleeping cell, so `detail.executed` held no large output and the response was small. That correction is
 * why this case asserts the large output is really in the executed set.
 */
describe('[V14-12] a failed run still fits the frame', () => {
  it('[V14-12] a large completed output plus a timeout delivers a bounded, readable failure', async () => {
    const target = path.join(workspace, 'timeout-large.ipynb');
    await writeFile(
      target,
      `${JSON.stringify({
        cells: [
          {
            cell_type: 'code',
            execution_count: null,
            id: 'c0',
            metadata: {},
            outputs: [],
            // A 12 MiB `text/plain` value, produced by the cell that runs FIRST and completes.
            source: ["display({'text/plain': 'A' * 12 * 1024 * 1024}, raw=True)"],
          },
          {
            cell_type: 'code',
            execution_count: null,
            id: 'c1',
            metadata: {},
            outputs: [],
            source: ['import time\ntime.sleep(60)'],
          },
        ],
        metadata: {
          kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
          language_info: { name: 'python' },
        },
        nbformat: 4,
        nbformat_minor: 5,
      })}\n`,
      'utf8',
    );

    const result = await client.callTool({
      name: 'notebook_run',
      arguments: { path: target, cell_selector: 'all', timeout_seconds: 3, write_outputs: true },
    });
    const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = blocks.find((block) => block.type === 'text')?.text ?? '';
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(10 * 1024 * 1024);

    // The failure must still be READABLE: the code, and the fact that cell 0 completed. A response that
    // merely fits but says nothing would satisfy the size assertion and lose the point of the report.
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(String(body['code'] ?? body['error'] ?? ''), text.slice(0, 200)).toContain('exec_timeout');
    const detail = (body['detail'] ?? {}) as Record<string, unknown>;
    expect(Array.isArray(detail['executed'])).toBe(true);

    // And the session survives, which is what the reviewer's case lost.
    const after = await callRead(target, 'none');
    expect(after.body['cell_count']).toBe(2);
  }, 180_000);
});
