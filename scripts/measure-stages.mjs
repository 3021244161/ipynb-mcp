// Where does a large notebook's memory go? Measured per stage, on a real file.
//
// The trial report: `notebook_run` on a 37.5 MiB notebook peaks above the 2048 MiB default heap and
// the process dies, so the client sees `-32000 Connection closed` and every kernel on that server
// dies with it. Measured here: 2238.9 MiB peak, ratio 59.7, exit 134.
//
// A number that large is not one copy of anything. This walks the stages of a run and prints the
// retained heap after each, so the fix targets the stage that actually holds the memory instead of
// the stage that is easiest to guess about.
//
//   node --expose-gc scripts/measure-stages.mjs <notebook>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (target === undefined) {
  process.stderr.write('usage: node --expose-gc scripts/measure-stages.mjs <notebook>\n');
  process.exit(2);
}

const { parseNotebook, serializeNotebook } = await import(pathToFileURL(path.join(REPO, 'lib', 'core', 'parse.js')).href);
const { hasher } = await import(pathToFileURL(path.join(REPO, 'lib', 'hash.js')).href);
const outputs = await import(pathToFileURL(path.join(REPO, 'lib', 'core', 'outputs.js')).href);

const mib = (bytes) => (bytes / 1024 / 1024).toFixed(1).padStart(8);
const mark = (label) => {
  global.gc?.();
  global.gc?.();
  const used = process.memoryUsage();
  process.stdout.write(`${label.padEnd(40)} heapUsed=${mib(used.heapUsed)} MiB  rss=${mib(used.rss)} MiB\n`);
  return used.heapUsed;
};

mark('baseline');

const text = readFileSync(target, 'utf8');
mark('readFileSync(utf8) - one JS string');

const bytes = new TextEncoder().encode(text);
mark('TextEncoder().encode(text) - one Buffer');

const notebook = parseNotebook(bytes, hasher);
const afterParse = mark('parseNotebook');

// The run path holds the parse result while it edits and re-serializes. Whatever it costs, it costs
// twice the moment anything copies it, which is why the trial's first hypothesis was "several whole
// copies".
mark('still holding: text + bytes + parsed');

const serialized = serializeNotebook(notebook);
mark('serializeNotebook(parsed)');

// How much of the parse result is the OUTPUT VALUES themselves? If the json payload dominates, the
// memory is inherent to holding the document at all, and the fix is fewer copies or a bigger heap.
let outputBytes = 0;
for (const cell of notebook.doc.cells) {
  if (cell.cell_type !== 'code') {
    continue;
  }
  for (const output of cell.outputs) {
    const mapped = outputs.mapRawOutputs([output], { images: 'never', maxImages: 0, cellIndex: 0 });
    outputBytes += JSON.stringify(mapped.items).length;
    void mapped;
  }
}
mark(`mapRawOutputs over every output (~${(outputBytes / 1024 / 1024).toFixed(1)} MiB of items)`);

process.stdout.write(
  `\nfile on disk: ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(1)} MiB\n` +
    `parseNotebook retained: ${((afterParse - 0) / 1024 / 1024).toFixed(1)} MiB heap\n` +
    `serialize created a ${(serialized.length / 1024 / 1024).toFixed(1)} MiB string\n`,
);
void text;
void bytes;
void serialized;
