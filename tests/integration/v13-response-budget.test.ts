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

/** A notebook with a single stored output of `chars` characters, written directly as text. */
async function writeLargeNotebook(name: string, chars: number): Promise<string> {
  const target = path.join(workspace, name);
  // The output is a `display_data` with a `text/plain` value, NOT a `stream`. That detail is the whole
  // reason this case exists: the only per-item cap in the server applied to `stream` items, so a large
  // `text/plain`, `text/html` or `application/json` output went to the client unchecked. A stream
  // fixture would have been truncated by `inline_text_chars` and the frame budget would never have
  // mattered — the same blind spot that hid the defect through a whole review round.
  const payload = JSON.stringify({
    cells: [
      {
        cell_type: 'code',
        execution_count: 1,
        id: 'c0',
        metadata: {},
        outputs: [
          {
            data: { 'text/plain': 'x'.repeat(chars) },
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
