// Integration tests for the v9 findings that only a REAL kernel can settle.
//
// Every case here ends at the layer the consumer or the file actually has:
//   - the image block the MCP client receives (V9-1), checked with `atob`, which is
//     the SDK's own validator;
//   - the BYTES of the .ipynb on disk (V9-5/V9-7), checked against the digits the
//     kernel produced, because "the value survived the round trip" is a claim about
//     the file and nothing else;
//   - the terminal error detail of a timed-out run (V9-7), which is where the v7 fix
//     had regressed.
//
// A hand-built RawOutput cannot reach any of these: the value has to travel
// kernel -> sidecar -> protocol -> document -> disk -> response.

import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IpynbConfig } from '../../src/config.js';
import { IpynbError } from '../../src/core/errors.js';
import { PathFence } from '../../src/fs/fence.js';
import { hasher } from '../../src/hash.js';
import { SIDECAR_REQUIRED_MODULES } from '../../src/kernel/interpreter.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { createLogger } from '../../src/log.js';
import type { ToolContext } from '../../src/mcp/context.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { handleNotebookRead } from '../../src/mcp/tools/read.js';
import { toCallToolResult } from '../../src/mcp/tools/result.js';
import { runNotebook, type RunDeps } from '../../src/run.js';
import { prepareVenv } from './test-venv.js';

let workspace: string;
let artifactRoot: string;
let registry: KernelRegistry;

beforeAll(async () => {
  // Same single entry point the other integration files use (review v8 V8-5): the venv
  // is built, validated and fallen back in ONE place, and no case here builds its own.
  prepareVenv({ modules: SIDECAR_REQUIRED_MODULES });
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-v9-'));
  artifactRoot = path.join(workspace, 'artifacts');
  registry = new KernelRegistry({ idleSeconds: 3600 });
  registry.start();
}, 180_000);

afterAll(async () => {
  await registry.shutdownAll();
  await rm(workspace, { recursive: true, force: true });
}, 120_000);

function config(): IpynbConfig {
  return {
    root: workspace,
    allowOutsideRoot: false,
    readOnly: false,
    images: 'auto',
    python: null,
    kernelIdleSeconds: 3600,
    execTimeoutSeconds: 300,
    backgroundThresholdSeconds: 30,
    backupKeep: 10,
    artifactDir: artifactRoot,
    inlineTextChars: 20000,
    previewLines: 12,
    maxImagesPerCall: 20,
    maxImageBytes: 20971520,
    maxResponseBytes: 8_388_608,
    logLevel: 'error',
  };
}

function deps(): RunDeps {
  return {
    registry,
    hasher,
    config: config(),
    imagesPolicy: 'auto',
    realpath: (target) => realpathSync(target),
  };
}

/** Context for driving a tool handler directly, as the integration suite does (FID-3). */
function readContext(): ToolContext {
  return {
    config: config(),
    fence: new PathFence(workspace, false, process.platform),
    registry,
    runStore: new RunStore(),
    hasher,
    logger: createLogger('error'),
    realpath: (target) => realpathSync(target),
    platform: process.platform,
  };
}

async function writeNb(name: string, sources: readonly string[]): Promise<string> {
  const target = path.join(workspace, name);
  await writeFile(target, JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python' },
    },
    cells: sources.map((source, index) => ({
      cell_type: 'code',
      id: `c${String(index)}`,
      metadata: {},
      source,
      outputs: [],
      execution_count: null,
    })),
  }));
  return target;
}

function raw(target: string): Promise<string> {
  return readFile(target, 'utf8');
}

/** The block payload must clear `atob` — the SDK's `ImageContent.data` validator. */
function decodedBlock(data: string): Buffer {
  expect(() => atob(data)).not.toThrow();
  return Buffer.from(data, 'base64');
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A 1x1 PNG built with the standard library only, then handed to `display` as a
// `data:` URL — the value shape that used to make the whole call fail (review v9 V9-1).
const IMAGE_CELL = [
  'import base64, struct, zlib',
  'def chunk(t, d):',
  "    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))",
  "ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)",
  "raw = b'\\x00' + bytes([9, 8, 7])",
  "png = b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')",
  "display({'image/png': 'data:image/png;base64,' + base64.b64encode(png).decode()}, raw=True)",
].join('\n');

describe('[V9-1] a data: URL image survives a real run, on the wire and on disk', () => {
  it('the run returns a valid block, writes an artifact, and stores the data: URL unchanged', async () => {
    const nb = await writeNb('v91-image.ipynb', [IMAGE_CELL]);
    const outcome = await runNotebook(
      {
        path: nb,
        cellSelector: 'all',
        mode: 'auto',
        timeoutSeconds: 120,
        writeOutputs: true,
        clearOutputsBefore: true,
        createBackup: false,
      },
      deps(),
    );

    expect(outcome.image_blocks).toHaveLength(1);
    const bytes = decodedBlock(outcome.image_blocks[0]!.data);
    expect(bytes.subarray(0, 8)).toEqual(PNG_MAGIC);

    const item = (outcome.executed[0]!.outputs[0] ?? {}) as Record<string, unknown>;
    expect(item).toMatchObject({ kind: 'image', media_type: 'image/png', bytes: bytes.byteLength });
    // SPEC §4.4: materialization and the returned block are the same event.
    const artifactPath = String(item['artifact_path']);
    expect(existsSync(artifactPath)).toBe(true);
    expect(await readFile(artifactPath)).toEqual(bytes);
    expect(item['image_index']).toBe(0);
  });

  it('[V9-1] the failed-run amplifier is gone: the file it wrote is readable again', async () => {
    // At HEAD this sequence ended with the notebook PERMANENTLY unreadable: the run
    // wrote the data: URL to disk, and every later `notebook_read` of that file failed
    // with `-32602 Invalid tools/call result`, because the stored value was handed to
    // the SDK's image validator verbatim.
    const nb = await writeNb('v91-reread.ipynb', [IMAGE_CELL]);
    await runNotebook(
      {
        path: nb,
        cellSelector: 'all',
        mode: 'auto',
        timeoutSeconds: 120,
        writeOutputs: true,
        clearOutputsBefore: true,
        createBackup: false,
      },
      deps(),
    );
    const onDisk = await raw(nb);
    expect(onDisk).toContain('data:image/png;base64,');
    expect(onDisk).toContain('"image/png"');

    // The read TOOL, on the file the run just wrote: the whole call must succeed and
    // the blocks it produces must clear `atob`. A count of blocks is not enough — the
    // value has to decode to the bytes the kernel displayed.
    const outcome = await handleNotebookRead(readContext(), { path: nb, include_outputs: 'full' });
    expect('error' in outcome).toBe(false);
    const result = toCallToolResult(outcome);
    expect(result.isError).toBeUndefined();
    const images = result.content.filter((block) => block.type === 'image') as Array<{ data: string }>;
    expect(images).toHaveLength(1);
    expect(decodedBlock(images[0]!.data).subarray(0, 8)).toEqual(PNG_MAGIC);
    const body = JSON.parse(String((result.content[0] as { text: string }).text)) as {
      cells: Array<{ outputs: Array<Record<string, unknown>> }>;
    };
    expect(body.cells[0]!.outputs[0]).toMatchObject({ kind: 'image', image_index: 0 });
  });
});

describe('[V9-5] a big integer from the kernel reaches the file with its digits', () => {
  it('2**64, 2**53+1 and -2**63 are stored verbatim and reported as inexact', async () => {
    const nb = await writeNb('v95-bigint.ipynb', [
      "display({'application/json': 2**64}, raw=True)",
      "display({'application/json': 9007199254740993}, raw=True)",
      "display({'application/json': -2**63}, raw=True)",
      "display({'application/json': 1234}, raw=True)",
    ]);
    const outcome = await runNotebook(
      {
        path: nb,
        cellSelector: 'all',
        mode: 'auto',
        timeoutSeconds: 120,
        writeOutputs: true,
        clearOutputsBefore: true,
        createBackup: false,
      },
      deps(),
    );

    // The FILE is the claim that matters: a rounded value here is permanent data loss.
    const onDisk = await raw(nb);
    expect(onDisk).toContain('18446744073709551616');
    expect(onDisk).toContain('9007199254740993');
    expect(onDisk).toContain('-9223372036854775808');
    expect(onDisk).not.toContain('18446744073709552000');
    expect(onDisk).not.toContain('9007199254740992,');

    // The response says so, per output and in the call-level list — three inexact
    // values, one exact one, so the warning count is a real count and not a constant.
    const messages = outcome.warnings.map((warning) => warning.message).join('\n');
    expect(messages).toContain('18446744073709551616');
    expect(messages).toContain('9007199254740993');
    expect(messages).toContain('-9223372036854775808');
    expect(messages).not.toContain('1234');
    for (const cell of outcome.executed.slice(0, 3)) {
      const item = cell.outputs[0] as { kind: string; warnings: Array<{ code: string }> };
      expect(item.kind).toBe('json');
      expect(item.warnings).toHaveLength(1);
      expect(item.warnings[0]!.code).toBe('output_truncated');
    }
    const exactItem = outcome.executed[3]!.outputs[0] as { warnings: unknown[] };
    expect(exactItem.warnings).toEqual([]);
    expect(outcome.warnings.filter((warning) => warning.code === 'output_truncated')).toHaveLength(3);
  });
});

describe("[V9-7] a timed-out run still reports what its completed cells lost", () => {
  it('exec_timeout carries the warnings gathered before the timeout', async () => {
    const nb = await writeNb('v97-timeout.ipynb', [
      // A value nbformat cannot store is DROPPED, and the cell that produced it is
      // completed before the next cell runs past the timeout.
      "display({'text/plain': 5}, raw=True)",
      'import time\ntime.sleep(30)',
    ]);
    let failure: IpynbError | null = null;
    try {
      await runNotebook(
        {
          path: nb,
          cellSelector: 'all',
          mode: 'auto',
          timeoutSeconds: 3,
          writeOutputs: true,
          clearOutputsBefore: true,
          createBackup: false,
        },
        deps(),
      );
    } catch (cause) {
      failure = cause as IpynbError;
    }

    // THE CODE IS NOW THE SAME ON EVERY PLATFORM. This used to tolerate `internal` here, because the
    // interrupt landing (Linux) made the sidecar report `error` instead of `timeout` and the run then
    // reported the catch-all code for a bug inside the tool. Tolerating it is what let that stand: the
    // assertion accepted the very symptom of the misclassification, so a wrong answer and a right one
    // both passed. The sidecar keys the timeout on having SENT the interrupt rather than on how the
    // cell ended, so a timed-out cell is `exec_timeout` whether or not the interrupt lands
    // (review v13 V13-6, D-060).
    expect(failure).not.toBeNull();
    expect(failure!.code, JSON.stringify(failure?.detail ?? null).slice(0, 200)).toBe('exec_timeout');
    const detail = (failure as IpynbError).detail as Record<string, unknown>;
    const warnings = detail['warnings'] as Array<{ code: string; message: string }>;
    expect(Array.isArray(warnings)).toBe(true);
    // v8 shipped `warnings: []` here: the assembly ran after the loop, so the one
    // terminal shape that ends inside the loop lost everything the earlier cells had
    // reported (review v9 V9-7).
    expect(warnings.map((warning) => warning.code)).toContain('output_truncated');
    expect(warnings.map((warning) => warning.message).join('\n')).toContain('cell 0');
    // SPEC §4.7 rule 5: the completed cell IS written back, so the response and the
    // file agree about what ran.
    expect(detail['write_back']).toMatchObject({ performed: true });
    const stored = JSON.parse(await raw(nb)) as { cells: Array<{ outputs: unknown[] }> };
    expect(stored.cells[0]!.outputs).toHaveLength(1);
  }, 60_000);
});
