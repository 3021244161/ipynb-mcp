// nbformat validation from Node (review v4, "must add" test #1).
//
// Three review rounds missed a 🔴 that a single call to `nbformat.validate`
// found, because every existing assertion spoke the same private dialect the
// writer spoke: the tests read `outputType`, so a file full of `outputType`
// looked correct. An external, authoritative validator does not share that
// dialect, which is exactly why it belongs in the suite.
//
// The validator runs in a child process so the file is validated exactly as it
// sits on disk, and so a future Python import error cannot take the test
// process down with it.

import { execFileSync } from 'node:child_process';

/** Uses the interpreter under test, so the version matches what users have. */
export function validateNotebook(path: string, interpreter: string): { ok: boolean; message: string } {
  const script = [
    'import sys',
    'import nbformat',
    // `as_version=4` UPGRADES a lower-minor file before validating it (nbformat
    // fills in cell ids etc.), and `validate` then checks against the version it
    // received — i.e. 4.5 after the upgrade. That is exactly the write
    // direction's contract: everything this tool writes is 4.5, so what matters
    // is that the result is accepted as 4.5. It is NOT a byte-level validator for
    // arbitrary input, which is the precision the first comment lacked
    // (review v5 TEST-2).
    'nb = nbformat.read(sys.argv[1], as_version=4)',
    'nbformat.validate(nb)',
  ].join('\n');
  try {
    execFileSync(interpreter, ['-c', script, path], { stdio: 'pipe', timeout: 30_000 });
    return { ok: true, message: 'nbformat.validate passed' };
  } catch (cause) {
    const error = cause as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const detail = `${error.stdout?.toString() ?? ''}${error.stderr?.toString() ?? ''}`.trim();
    return { ok: false, message: detail === '' ? String(error.message) : detail };
  }
}

/** Whether nbformat is importable at all (skips the assertion on bare machines). */
export function nbformatAvailable(interpreter: string): boolean {
  try {
    execFileSync(interpreter, ['-c', 'import nbformat'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
