// V7-1 reproduction: does the READ direction mangle or drop legal
// `application/json` values? The review says `[1,2,3]` becomes 123 and objects
// become "unsupported", with `warnings: []`.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = process.cwd();
const lib = (name) => pathToFileURL(path.join(here, 'lib', name)).href;
const { hasher } = await import(lib('hash.js'));
const { parseNotebook } = await import(lib('core/parse.js'));
const { rawOutputsOfCell } = await import(lib('core/outputs.js'));
const { mapRawOutputs } = await import(lib('core/outputs.js'));

const cases = [
  ['array of numbers', [1, 2, 3]],
  ['object', { k: 'v' }],
  ['number', 5],
  ['null', null],
  ['true', true],
  ['array of strings', ['a', 'b']],
  ['nested object', { a: [1, 2, 3] }],
];

for (const [label, value] of cases) {
  const doc = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        cell_type: 'code',
        id: 'c0',
        metadata: {},
        source: 'x',
        execution_count: 1,
        outputs: [{ output_type: 'display_data', data: { 'application/json': value }, metadata: {} }],
      },
    ],
  };
  const notebook = parseNotebook(new TextEncoder().encode(JSON.stringify(doc)), hasher);
  const cell = notebook.cells[0];
  const raw = rawOutputsOfCell(cell);
  const mapped = mapRawOutputs(raw, { maxImageBytes: 20971520, inlineTextChars: 20000, hasher });
  const keys = Object.keys((raw[0]?.data ?? {}));
  console.log(
    `${label.padEnd(18)} onDisk=${JSON.stringify(value).slice(0, 24).padEnd(26)} keysAfter=[${keys.join(',')}] -> ${JSON.stringify(mapped.items[0])}`,
  );
}
