import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { SIDECAR_REQUIRED_MODULES } from '../../src/kernel/interpreter.js';
import { SidecarTransport } from '../../src/kernel/sidecar-transport.js';
import { prepareVenv, resolvedTestInterpreter } from './test-venv.js';

let transport: SidecarTransport;
beforeAll(() => {
  prepareVenv({ modules: SIDECAR_REQUIRED_MODULES });
  transport = new SidecarTransport({ interpreterPath: resolvedTestInterpreter(), onLog: () => undefined });
}, 180_000);
afterAll(async () => { await transport?.shutdownAll(); });

it.each([
  ['shell', 'if True:\n    !echo never-executed'],
  ['line magic', '%time y = x'],
  ['cell magic', '%%bash\necho never-executed'],
  ['malformed Python', 'def broken(:\n    pass'],
])('[U25][U19b] preserves conservative analysis for %s (#8)', async (_name, source) => {
  // The syntax cell is never executed. Silently dropping it or promoting a
  // transformed opaque magic to high confidence would break this contract.
  const result = await transport.analyze(['tmp = 99', 'def g():\n    tmp = 2\n    return tmp', source!]);
  expect(result.ok).toBe(false);
  expect(result.failedCellIndexes).toEqual([2]);
  expect(result.defs[1]).toEqual(['g']);
  expect(result.uses[1]).toEqual([]);
});

it('[U25] demonstrates why transforming opaque magics alone loses dependencies', () => {
  const script = [
    'import json, symtable',
    'from IPython.core.inputtransformer2 import TransformerManager',
    'source = TransformerManager().transform_cell("%time y = x")',
    'table = symtable.symtable(source, "<cell>", "exec")',
    'print(json.dumps({"source": source, "names": list(table.get_identifiers())}))',
  ].join('\n');
  const result = JSON.parse(execFileSync(resolvedTestInterpreter(), ['-c', script], { encoding: 'utf8', timeout: 10_000, windowsHide: true })) as { source: string; names: string[] };
  expect(result.source).toContain('run_line_magic');
  expect(result.names).not.toContain('x');
  expect(result.names).not.toContain('y');
});
