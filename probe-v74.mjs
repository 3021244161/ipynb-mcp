import { pathToFileURL } from 'node:url';
import path from 'node:path';

const lib = (n) => pathToFileURL(path.join(process.cwd(), 'src', n)).href;
const { resolveInterpreter, SIDECAR_REQUIRED_MODULES } = await import(lib('kernel/interpreter.ts'));

const deps = {
  platform: 'linux',
  env: {},
  existsSync: (t) => t === '/usr/bin/python3',
  readFile: () => Promise.reject(new Error('none')),
  execFile: () => Promise.resolve('ok'),
  runCapturing: () => Promise.resolve({ status: 'failed', stdout: 'jupyter_client && rm -rf ~/notebooks' }),
  resolveExecutable: () => Promise.resolve(null),
  homedir: () => '/home/test',
};

const outcome = await resolveInterpreter(
  { explicitPython: '/usr/bin/python3', notebookPath: '/work/nb.ipynb', kernelSpecName: null, languageInfoName: 'python' },
  deps,
).then(
  () => null,
  (cause) => cause,
);
console.log('code:', outcome?.code);
console.log('message:', outcome?.message);
console.log('detail:', JSON.stringify(outcome?.detail));
console.log('required modules:', JSON.stringify(SIDECAR_REQUIRED_MODULES));
