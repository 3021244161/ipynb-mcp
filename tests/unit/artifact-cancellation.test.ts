import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { materializeImageArtifact } from '../../src/fs/artifact.js';
import { finalizeToolResult, type ToolSuccess } from '../../src/mcp/tools/result.js';

// The decorator keeps the actual filesystem write, and pins cancellation
// precisely between two writes instead of relying on a scheduling delay.
vi.mock('../../src/fs/artifact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fs/artifact.js')>();
  return { ...actual, materializeImageArtifact: vi.fn(actual.materializeImageArtifact) };
});

let directory: string;
beforeAll(async () => { directory = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-finalize-')); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function outcome(name: string, count = 2, bytes = 25, source = 'x = 1'): ToolSuccess {
  const png = Buffer.alloc(bytes);
  Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000100', 'hex').copy(png);
  const data = png.toString('base64');
  const plans = Array.from({ length: count }, (_, index) => ({
    imageIndex: index, artifactPath: path.join(directory, `${name}-${index}.png`), base64: data,
  }));
  return {
    payload: { cells: [{ source, outputs: plans.map((plan) => ({
      kind: 'image', media_type: 'image/png', bytes, width: 1, height: 1, text_fallback: '',
      image_index: plan.imageIndex, artifact_path: plan.artifactPath,
    })) }], warnings: [] },
    imageArtifacts: plans,
    imageBlocks: plans.map(() => ({ data, media_type: 'image/png' as const })),
  };
}

describe('[I14][U26] final image delivery observes cancellation and wire bytes', () => {
  it('[I14] leaves completed artifacts intact and does not start later writes after cancellation', async () => {
    const controller = new AbortController();
    const prepared = outcome('cancel');
    const actual = await vi.importActual<typeof import('../../src/fs/artifact.js')>('../../src/fs/artifact.js');
    vi.mocked(materializeImageArtifact).mockImplementationOnce(async (plan) => {
      const result = await actual.materializeImageArtifact(plan);
      controller.abort();
      return result;
    });
    const options = { maxResponseBytes: 65_536, signal: controller.signal };
    const result = await finalizeToolResult(prepared, options);
    expect(await readFile(prepared.imageArtifacts![0]!.artifactPath)).toEqual(Buffer.from(prepared.imageArtifacts![0]!.base64, 'base64'));
    expect(existsSync(prepared.imageArtifacts![1]!.artifactPath)).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content.filter((block) => block.type === 'image')).toHaveLength(1);
    const text = result.content[0]!;
    if (text.type !== 'text') {
      throw new Error('missing text result');
    }
    expect(JSON.parse(text.text)).toMatchObject({ code: 'cancelled' });
  });

  it('[I14] a pre-cancelled finalization writes no artifacts', async () => {
    const controller = new AbortController();
    controller.abort();
    const prepared = outcome('pre-cancel');
    const options = { maxResponseBytes: 65_536, signal: controller.signal };
    const result = await finalizeToolResult(prepared, options);
    expect(prepared.imageArtifacts!.map((plan) => existsSync(plan.artifactPath))).toEqual([false, false]);
    expect(result.isError).toBe(true);
    expect(result.content.filter((block) => block.type === 'image')).toEqual([]);
  });

  it('[U24] counts the outer text escaping before admitting a partial image set', async () => {
    const prepared = outcome('wire', 1, 30_000, '"'.repeat(10_000));
    const result = await finalizeToolResult(prepared, { maxResponseBytes: 65_536 });
    const wire = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
    expect(Buffer.byteLength(wire, 'utf8')).toBeLessThanOrEqual(65_536);
    expect(result.content.filter((block) => block.type === 'image')).toEqual([]);
    expect(existsSync(prepared.imageArtifacts![0]!.artifactPath)).toBe(false);
  });
});
