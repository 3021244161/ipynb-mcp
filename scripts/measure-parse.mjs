// How does `parseNotebook` scale with file size, and where inside it does the memory sit?
//
// Measured on the trial's 37.5 MiB notebook: 1198 MiB of retained heap after the parse alone, which
// is what pushes a run past the 2048 MiB default and kills the process (and every kernel with it).
// A factor that large cannot come from "one copy of the document", so this walks the parser's own
// stages and two shapes of content to find what a copy actually costs.
//
//   node --expose-gc scripts/measure-parse.mjs
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseNotebook } = await import(pathToFileURL(path.join(REPO, 'lib', 'core', 'parse.js')).href);
const { hasher } = await import(pathToFileURL(path.join(REPO, 'lib', 'hash.js')).href);

const mi = (bytes) => (bytes / 1024 / 1024).toFixed(1).padStart(7);
const heap = () => {
  global.gc?.();
  global.gc?.();
  return process.memoryUsage().heapUsed;
};

/** A notebook of about `megabytes`, as `application/json` outputs holding a repeated payload. */
function synthetic(megabytes, char) {
  const payload = char.repeat(200_000);
  const outputs = [];
  for (let index = 0; index < (megabytes * 1024 * 1024) / payload.length; index += 1) {
    outputs.push({
      data: { 'application/json': { blob: payload, index } },
      metadata: {},
      output_type: 'display_data',
    });
  }
  return `${JSON.stringify({
    cells: [{ cell_type: 'code', execution_count: 1, id: 'c0', metadata: {}, outputs, source: ['x = 1'] }],
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 1)}\n`;
}

const workspace = mkdtempSync(path.join(tmpdir(), 'ipynb-mcp-parse-'));
process.stdout.write(`content            file MiB   parsed heap MiB   ratio   (json string, no custom parser)\n`);

for (const [label, char, megabytes] of [
  ['ascii 4', 'x', 4],
  ['ascii 8', 'x', 8],
  ['ascii 16', 'x', 16],
  ['ascii 32', 'x', 32],
  ['cjk 8', '中', 8],
  ['cjk 16', '中', 16],
]) {
  const notebookPath = path.join(workspace, `${label.replace(' ', '-')}.ipynb`);
  const text = synthetic(megabytes, char);
  writeFileSync(notebookPath, text, 'utf8');
  const onDisk = Buffer.byteLength(text);

  const bytes = new TextEncoder().encode(text);
  const before = heap();
  const parsed = parseNotebook(bytes, hasher);
  const after = heap();
  void parsed;

  // The control: what does V8's own parser retain for the same text? If the custom parser is in the
  // same ballpark, the memory is the CONTENT's cost and no parser rewrite will change it.
  const control = JSON.parse(readFileSync(notebookPath, 'utf8'));
  const controlAfter = heap();
  void control;

  process.stdout.write(
    `${label.padEnd(18)} ${mi(onDisk)}      ${mi(after - before)}       ${((after - before) / onDisk).toFixed(1).padStart(5)}   ${mi(controlAfter - after)}\n`,
  );
}

rmSync(workspace, { recursive: true, force: true });
