// Interpreter resolution (SPEC §5.2, D23): candidate chain
//   1. explicit --python / IPYNB_PYTHON (failure is final)
//   2. notebook kernelspec argv[0]
//   3. notebook-dir .venv / venv
//   4. PATH python3 -> python
// Steps 2-4 degrade: a failed candidate is recorded and the chain continues;
// only when ALL fail do we raise. kernelspec_mismatch warnings per §5.2.

import path from 'node:path';

import { IpynbError, createWarning, type JsonValue, type Warning } from '../core/errors.js';

export interface InterpreterCandidate {
  readonly path: string;
  readonly reason: string;
}

export interface InterpreterResolution {
  readonly interpreterPath: string;
  readonly kernelSpecName: string;
  readonly language: string;
  readonly warnings: Warning[];
}

export interface InterpreterCache {
  get(candidatePath: string): boolean | undefined;
  set(candidatePath: string, ok: boolean): void;
}

export interface InterpreterDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  existsSync(target: string): boolean;
  readFile(target: string): Promise<string>;
  /** Runs the command: 'ok' (exit 0), 'failed' (non-zero) or 'not-found' (ENOENT). */
  execFile(command: string, args: readonly string[], timeoutMs: number): Promise<'ok' | 'failed' | 'not-found'>;
  /** Absolute path of a PATH command (e.g. via `python -c "print(sys.executable)"`), null when absent. */
  resolveExecutable(command: string, timeoutMs: number): Promise<string | null>;
  homedir(): string;
}

export interface InterpreterInput {
  readonly explicitPython: string | null;
  readonly notebookPath: string;
  readonly kernelSpecName: string | null;
  readonly languageInfoName: string | null;
  readonly cache?: InterpreterCache;
}

interface KernelJsonInfo {
  readonly argv: readonly string[];
  readonly language: string | null;
  readonly dir: string;
}

export async function resolveInterpreter(
  input: InterpreterInput,
  deps: InterpreterDeps,
): Promise<InterpreterResolution> {
  const notebookDir = path.dirname(input.notebookPath);
  const failed: InterpreterCandidate[] = [];
  let installCommand: string | null = null;
  const warnings: Warning[] = [];

  const languageInfo = input.languageInfoName ?? null;
  const pythonRequested = (kernelLanguage: string | null): boolean =>
    kernelLanguage === 'python' || languageInfo === 'python';

  const venvPython = findVenvPython(notebookDir, deps);

  // ---- candidate 2 lookup (needed early for warnings + search paths) ------
  const specName = input.kernelSpecName;
  let kernelJson: KernelJsonInfo | null = null;
  if (specName === null || specName === '') {
    pushMismatch(warnings, 'notebook has no metadata.kernelspec.name; interpreter selection may not match the authoring environment');
  } else {
    kernelJson = await findKernelJson(specName, { explicitPython: input.explicitPython, venvPython }, deps);
    if (kernelJson === null) {
      pushMismatch(warnings, `kernelspec '${specName}' could not be resolved; falling back through the interpreter candidate chain`);
    }
  }

  const checkIpykernel = async (candidate: string): Promise<boolean> => {
    const cached = input.cache?.get(candidate);
    if (cached !== undefined) {
      return cached;
    }
    const status = await deps.execFile(candidate, ['-c', 'import ipykernel'], 15_000);
    const ok = status === 'ok';
    input.cache?.set(candidate, ok);
    return ok;
  };

  // ---- candidate 1: explicit (failure is FINAL, never degrades) -----------
  if (input.explicitPython !== null) {
    const explicit = input.explicitPython;
    if (!deps.existsSync(explicit)) {
      throw new IpynbError('interpreter_not_found', `--python interpreter not found: ${explicit}`, {
        candidates: [{ path: explicit, reason: 'not found' }],
      });
    }
    const kernelLanguage = kernelJson?.language ?? languageInfo ?? 'python';
    if (pythonRequested(kernelLanguage)) {
      const ok = await checkIpykernel(explicit);
      if (!ok) {
        throw new IpynbError('ipykernel_missing', `--python interpreter cannot import ipykernel: ${explicit}`, {
          path: explicit,
          install_command: `"${explicit}" -m pip install ipykernel`,
        });
      }
    }
    return {
      interpreterPath: explicit,
      kernelSpecName: specName ?? defaultSpecName(deps),
      language: kernelLanguage,
      warnings,
    };
  }

  // ---- candidate 2: kernelspec argv[0] ------------------------------------
  if (kernelJson !== null) {
    const argv0 = kernelJson.argv[0] ?? '';
    const resolvedArgv0 = resolveArgv0(argv0, kernelJson.dir);
    if (argv0 !== '') {
      const language = kernelJson.language ?? languageInfo ?? 'python';
      if (!pythonRequested(language)) {
        // Non-Python kernel: the spec's executable is the interpreter (D23);
        // no ipykernel probing.
        maybeVenvMismatch(warnings, kernelJson, venvPython, deps);
        return {
          interpreterPath: resolvedArgv0,
          kernelSpecName: specName ?? '',
          language,
          warnings,
        };
      }
      if (deps.existsSync(resolvedArgv0)) {
        const ok = await checkIpykernel(resolvedArgv0);
        if (ok) {
          maybeVenvMismatch(warnings, kernelJson, venvPython, deps);
          return {
            interpreterPath: resolvedArgv0,
            kernelSpecName: specName ?? '',
            language,
            warnings,
          };
        }
        failed.push({ path: resolvedArgv0, reason: 'ipykernel_missing' });
        installCommand = `"${resolvedArgv0}" -m pip install ipykernel`;
      } else {
        failed.push({ path: resolvedArgv0, reason: 'not found' });
      }
    }
  }

  // ---- candidate 3: notebook-dir .venv / venv -----------------------------
  if (venvPython !== null) {
    const ok = await checkIpykernel(venvPython);
    if (ok) {
      return {
        interpreterPath: venvPython,
        kernelSpecName: specName ?? defaultSpecName(deps),
        language: 'python',
        warnings,
      };
    }
    failed.push({ path: venvPython, reason: 'ipykernel_missing' });
    if (installCommand === null) {
      installCommand = `"${venvPython}" -m pip install ipykernel`;
    }
  }

  // ---- candidate 4: PATH python3 -> python --------------------------------
  const pathCandidates = deps.platform === 'win32' ? ['python'] : ['python3', 'python'];
  for (const candidate of pathCandidates) {
    const status = await deps.execFile(candidate, ['-c', 'import ipykernel'], 15_000);
    if (status === 'ok') {
      return {
        interpreterPath: candidate,
        kernelSpecName: specName ?? defaultSpecName(deps),
        language: 'python',
        warnings,
      };
    }
    failed.push({
      path: candidate,
      reason: status === 'not-found' ? 'not found' : 'ipykernel_missing',
    });
    if (status !== 'not-found' && installCommand === null) {
      installCommand = `"${candidate}" -m pip install ipykernel`;
    }
  }

  const detail: JsonValue = {
    candidates: failed.map((entry) => ({ path: entry.path, reason: entry.reason })),
    ...(installCommand !== null ? { install_command: installCommand } : {}),
  };
  throw new IpynbError(
    'interpreter_not_found',
    'no usable Python interpreter found for this notebook (tried kernelspec, .venv/venv, PATH)',
    detail,
  );
}

// ---------------------------------------------------------------------------

function pushMismatch(warnings: Warning[], message: string): void {
  if (!warnings.some((warning) => warning.code === 'kernelspec_mismatch')) {
    warnings.push(createWarning('kernelspec_mismatch', message));
  }
}

function maybeVenvMismatch(
  warnings: Warning[],
  kernelJson: KernelJsonInfo,
  venvPython: string | null,
  deps: InterpreterDeps,
): void {
  if (venvPython === null) {
    return;
  }
  const argv0 = resolveArgv0(kernelJson.argv[0] ?? '', kernelJson.dir);
  const same = path.resolve(argv0).toLowerCase() === path.resolve(venvPython).toLowerCase();
  if (!same) {
    void deps;
    pushMismatch(
      warnings,
      `notebook directory has a virtualenv whose interpreter differs from the kernelspec argv[0] (${argv0}); pass --python to override if this is wrong`,
    );
  }
}

function defaultSpecName(_deps: InterpreterDeps): string {
  return 'python3';
}

/** Prefix of an interpreter: venvs put python in Scripts/ or bin/, conda
 *  environments put it directly in the environment root (SPEC §5.2). */
export function pythonPrefix(pythonPath: string): string {
  const parent = path.dirname(pythonPath);
  const parentBase = path.basename(parent).toLowerCase();
  if (parentBase === 'scripts' || parentBase === 'bin') {
    return path.dirname(parent);
  }
  return parent;
}

/** .venv/venv python next to the notebook, platform-shaped (SPEC §5.2 step 3). */
export function findVenvPython(notebookDir: string, deps: InterpreterDeps): string | null {
  const relative = deps.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  for (const venvDir of ['.venv', 'venv']) {
    const candidate = path.join(notebookDir, venvDir, ...relative);
    if (deps.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function findKernelJson(
  specName: string,
  hints: { explicitPython: string | null; venvPython: string | null },
  deps: InterpreterDeps,
): Promise<KernelJsonInfo | null> {
  const searchDirs: string[] = [];
  // Kernelspecs also live under the prefix of any locatable Python
  // (SPEC §5.2 search path item 2: candidates 1/3/4, located not validated).
  const pathPythons: string[] = [];
  for (const command of deps.platform === 'win32' ? ['python'] : ['python3', 'python']) {
    const status = await deps.execFile(command, ['-c', ''], 5_000);
    if (status !== 'not-found') {
      pathPythons.push(command);
    }
  }
  const jupyterPath = deps.env['JUPYTER_PATH'];
  if (jupyterPath !== undefined && jupyterPath !== '') {
    const separator = deps.platform === 'win32' ? ';' : ':';
    for (const entry of jupyterPath.split(separator)) {
      if (entry !== '') {
        searchDirs.push(path.join(entry, 'kernels'));
      }
    }
  }
  for (const python of [hints.explicitPython, hints.venvPython, ...pathPythons]) {
    if (python === null) {
      continue;
    }
    let resolved: string | null = python;
    if (!path.isAbsolute(python) && !deps.existsSync(python)) {
      resolved = await deps.resolveExecutable(python, 5_000);
    }
    if (resolved !== null && deps.existsSync(resolved)) {
      const prefix = pythonPrefix(resolved);
      searchDirs.push(path.join(prefix, 'share', 'jupyter', 'kernels'));
    }
  }
  if (deps.platform === 'win32') {
    const appData = deps.env['APPDATA'];
    if (appData !== undefined) {
      searchDirs.push(path.join(appData, 'jupyter', 'kernels'));
    }
    const programData = deps.env['PROGRAMDATA'];
    if (programData !== undefined) {
      searchDirs.push(path.join(programData, 'jupyter', 'kernels'));
    }
  } else {
    const home = deps.homedir();
    searchDirs.push(path.join(home, '.local', 'share', 'jupyter', 'kernels'));
    searchDirs.push('/usr/local/share/jupyter/kernels');
    searchDirs.push('/usr/share/jupyter/kernels');
  }

  for (const dir of searchDirs) {
    const kernelJsonPath = path.join(dir, specName, 'kernel.json');
    if (!deps.existsSync(kernelJsonPath)) {
      continue;
    }
    try {
      const raw = await deps.readFile(kernelJsonPath);
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        continue;
      }
      const argv = (parsed as Record<string, unknown>)['argv'];
      const language = (parsed as Record<string, unknown>)['language'];
      if (!Array.isArray(argv) || argv.length === 0) {
        continue;
      }
      return {
        argv: argv.filter((entry): entry is string => typeof entry === 'string'),
        language: typeof language === 'string' ? language : null,
        dir: path.dirname(kernelJsonPath),
      };
    } catch {
      // Unparseable kernel.json: keep searching other dirs.
      continue;
    }
  }
  return null;
}

/** kernel.json argv[0] -> absolute path ({resource_dir} + relative resolution). */
function resolveArgv0(argv0: string, kernelDir: string): string {
  if (argv0.includes('{resource_dir}')) {
    return argv0.replace('{resource_dir}', kernelDir);
  }
  if (path.isAbsolute(argv0)) {
    return argv0;
  }
  return path.resolve(kernelDir, argv0);
}
