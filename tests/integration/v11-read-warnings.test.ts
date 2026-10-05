// The default read path must not round silently (review v11 V11-5).
//
// `mapRawOutputs` projects a json number the JSON channel cannot carry exactly — `2**53 + 1`
// becomes `…992`, `1e400` becomes `null` — and reports it per item. The renderer lifted those
// per-item warnings into the call-level `warnings[]` only for `include_outputs: "full"`, so
// `summary` (the DEFAULT per SPEC §4.3, and the token-cheapest path the README recommends)
// showed the rounded number in its preview with `warnings: []`.
//
// The model reads `9007199254740992`, the file says `9007199254740993`, and nothing says so.
// SPEC §5.4 forbids silent truncation, and the prompt for this round put it more bluntly:
// "the guard covers the layer that was changed". So the assertion is on the payload the
// model receives, for EVERY value of `include_outputs` — the matrix, not the one path that
// happened to be under the lamp.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PathFence } from '../../src/fs/fence.js';
import { hasher } from '../../src/hash.js';
import { createLogger } from '../../src/log.js';
import type { ToolContext } from '../../src/mcp/context.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { handleNotebookRead } from '../../src/mcp/tools/read.js';
import { toCallToolResult } from '../../src/mcp/tools/result.js';

let workspace: string;

/** Every literal the review measured, in one json output. */
const LITERALS = ['9007199254740993', '18446744073709551616', '1e400', '0.1234567890123456789012345'];

function notebookText(): string {
  return `${JSON.stringify(
    {
      cells: [
        {
          cell_type: 'code',
          execution_count: 1,
          id: 'c0',
          metadata: {},
          outputs: [
            {
              data: { 'application/json': { big: 0, huge: 0, over: 0, digits: 0 } },
              metadata: {},
              output_type: 'display_data',
            },
          ],
          source: ['x'],
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
  ).replace('"big": 0', `"big": ${LITERALS[0]!}`)
    .replace('"huge": 0', `"huge": ${LITERALS[1]!}`)
    .replace('"over": 0', `"over": ${LITERALS[2]!}`)
    .replace('"digits": 0', `"digits": ${LITERALS[3]!}`)}\n`;
}

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
      maxResponseBytes: 8_388_608,
      logLevel: 'error',
    },
    fence: new PathFence(workspace, false, process.platform),
    registry: null,
    runStore: new RunStore(),
    hasher,
    logger: createLogger('error'),
    realpath: (target: string) => target,
    platform: process.platform,
  } as unknown as ToolContext;
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-v11-read-'));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function bodyOf(outcome: Awaited<ReturnType<typeof handleNotebookRead>>): Record<string, unknown> {
  const result = toCallToolResult(outcome);
  return JSON.parse(String((result.content[0] as { text: string }).text)) as Record<string, unknown>;
}

describe('[V11-5] the rounding is reported on every output path, including the default', () => {
  for (const includeOutputs of [undefined, 'summary', 'full', 'none'] as const) {
    it(`[V11-5] include_outputs=${includeOutputs ?? '(default)'}: the payload says what it rounded`, async () => {
      const target = path.join(workspace, `read-${includeOutputs ?? 'default'}.ipynb`);
      await writeFile(target, notebookText(), 'utf8');
      const args: Record<string, unknown> = { path: target };
      if (includeOutputs !== undefined) {
        args['include_outputs'] = includeOutputs;
      }
      const body = bodyOf(await handleNotebookRead(context(), args));
      const warnings = (body['warnings'] ?? []) as Array<{ code: string; message: string }>;
      const joined = warnings.map((warning) => warning.message).join('\n');
      const visible = JSON.stringify(body);

      if (includeOutputs === 'none') {
        // A caller that asked not to see outputs gets none, and no claims about them. This
        // is the one path where silence is correct, and it is asserted so the others cannot
        // be excused by "warnings are optional here".
        expect(warnings).toEqual([]);
        expect(visible).not.toContain('9007199254740992');
        return;
      }

      // The model sees a rounded number or a null…
      if (includeOutputs !== 'full') {
        expect(visible, 'the summary preview carries the projected value').toContain('9007199254740992');
      }
      // …and is told about every distinct literal that was projected, with the digits.
      for (const literal of LITERALS) {
        expect(joined, `${literal} must be named in warnings`).toContain(literal);
      }
      expect(warnings.every((warning) => warning.code === 'output_truncated')).toBe(true);
    });
  }

  it('[V11-5] a value that needs no projection produces no warning on the default path', () => {
    // The other half of the rule: lifting warnings onto the default path must not invent
    // them, or the model learns to ignore the field (the over-correction v10 already made
    // once with the precision criterion).
    return (async () => {
      const target = path.join(workspace, 'clean.ipynb');
      await writeFile(
        target,
        `${JSON.stringify(
          {
            cells: [
              {
                cell_type: 'code',
                execution_count: 1,
                id: 'c0',
                metadata: {},
                outputs: [
                  {
                    data: { 'application/json': { ok: 1, pi: 0.5, text: 'x' } },
                    metadata: {},
                    output_type: 'display_data',
                  },
                ],
                source: ['x'],
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
        )}\n`,
        'utf8',
      );
      const body = bodyOf(await handleNotebookRead(context(), { path: target }));
      expect(body['warnings']).toEqual([]);
    })();
  });
});
