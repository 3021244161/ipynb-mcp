"""Gate for the sidecar's connection-file sweep (`sweep_orphan_connection_files`).

Runnable with no arguments: `python scripts/check-connection-sweep.py`. Exits non-zero
if any expectation fails, so it can sit in `pnpm lint`.

What it guards, and why each case is here:

  1. ATTRIBUTION. `ipynb-mcp-<kernelId>-<pid>-<random>.json` must be read by POSITION,
     and only when the name has the shape `tempfile.mkstemp` actually writes. The old
     rule ("the first all-digit field counting back from the end") read mkstemp's random
     suffix as the owning pid whenever that suffix happened to be all digits, and the
     pid it invented was usually dead — so a LIVE process's connection file was
     deleted, HMAC key and all (review v9 V8-6).
  2. LIVENESS. Windows must use a real probe (`OpenProcess`/`WaitForSingleObject`), not
     `os.kill(pid, 0)` (which is TerminateProcess there) and not a blanket "cannot
     tell" — the blanket answer silently reinstated the very leak the pid rule exists
     to fix, by making every file wait out the conservative age (review v9 V8-6).
  3. THE LADDER. Owner alive ⇒ never removed. Owner provably gone ⇒ removed once past
     the orphan grace. Owner unjudgeable or name unattributable ⇒ only after the long
     conservative age.

Fixtures live in a fresh temporary directory created by this script — never in the
repository, and never in the machine's real %TEMP%: the directory is passed to the sweep
explicitly, which is exactly the seam that makes these rules testable. One child process
is spawned, only to obtain a pid that is certainly dead; everything else is a file in
that directory.
"""
import sys

# `python/__pycache__` is not merely untidy here: `scripts/check-package.mjs` fails when
# anything but the sidecar sits in `python/`, so byte-compiling the sidecar on import
# would make the two guards mutually exclusive — running this sweep turned the package
# check red (review v9 V8-9 residual). The flag has to be set before the import of the
# sidecar below, because that is where the interpreter writes the cache; it is checked
# at cache-write time, not at interpreter startup.
sys.dont_write_bytecode = True

# The report uses `→` and `—`, and a Windows console does not: Python picked cp1252 for
# stdout on the CI runner, printing an assertion line raised
# `UnicodeEncodeError: 'charmap' codec can't encode characters in position 18-19` — so the
# gate died on its own success message (the FAILING line printed, the PASSING line crashed)
# while passing locally, where the console is UTF-8. Two ways out: strip the typography, or
# tell the stream what it is. The second keeps the output readable and fixes every future
# non-ASCII character at once. `errors="replace"` is the belt for an environment that
# refuses even UTF-8, because a guard whose failure mode is an encoding crash is worse than
# one that prints a `?`.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):  # pragma: no cover - non-reconfigurable stream
    pass

import importlib.util
import os
import shutil
import subprocess
import tempfile
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIDECAR_PATH = os.path.join(REPO, "python", "ipynb_sidecar.py")


def load_sidecar(path: str = SIDECAR_PATH):
    spec = importlib.util.spec_from_file_location("sidecar_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _same_path(a: str, b: str) -> bool:
    """Path equality with Windows' case folding, without importing a platform check."""
    return os.path.normcase(a) == os.path.normcase(b)


def spawn_dead_pid():
    """A pid that belonged to a process this script has already reaped.

    Inventing a "surely unused" number is not portable: Windows' OpenProcess caps the
    pid at MAXDWORD-3 and answers ERROR_INVALID_PARAMETER for anything above it, while
    `os.kill(pid, 0)` semantics differ per platform. A child that has been started,
    waited for and reaped is dead by construction on every platform — and on Linux its
    pid is then released for reuse, so nothing else can claim it in between.
    """
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    return child.pid


def wait_for(probe, want, timeout=10.0):
    """Poll `probe` until it returns `want`; return the last value seen.

    Needed because "process exited" and "process is observed as exited" are not the
    same instant: on Windows the last handle must close, on Linux the child must be
    reaped (which `spawn_dead_pid` does) before `os.kill` stops succeeding. Without
    the poll this guard would fail intermittently, and a flaky guard gets deleted.
    """
    deadline = time.time() + timeout
    value = probe()
    while value != want and time.time() < deadline:
        time.sleep(0.05)
        value = probe()
    return value


def build_fixtures(sweep_dir, module, live_pid, dead_pid):
    """Create the names the sweep has to judge, with ages chosen relative to its rules.

    Ages are set with `os.utime` rather than by waiting, so the run is deterministic and
    instant. They are placed well away from the thresholds (hours, days) rather than on
    them, because an off-by-a-few-milliseconds test is a test that fails on a slow CI.
    """
    old = time.time() - 2 * module.ORPHAN_CONNECTION_AGE_SECONDS
    ancient = time.time() - (module.UNATTRIBUTABLE_CONNECTION_AGE_SECONDS + 24 * 3600)
    fresh = time.time()

    # (file name, age, why). The comments say what each name is for; the expectation
    # table below re-states the outcome as a runnable assertion. The names are built so
    # that the RIGHTMOST number is `dead_pid` in every case where the owner is really
    # alive: a parser that reads "a number in the name" instead of the pid field then
    # concludes the owner is gone, which is precisely how the old rule deleted a live
    # process's file.
    plan = [
        # --- attribution: a live owner whose file the old rule deleted ----------------
        # The realistic defect: mkstemp's random suffix happens to be all digits, so the
        # old rule read 12345678 for the pid, found it dead, and removed a live
        # process's connection file (HMAC key included, review v9 V8-6).
        ("ipynb-mcp-k-%d-12345678.json" % live_pid, ancient, "all-digit random suffix"),
        # A dead number sitting in the kernelId, ahead of the live owner's pid field.
        # Rightmost-number-wins ⇒ "owner gone" ⇒ deleted; positional ⇒ kept.
        ("ipynb-mcp-k-%d-%d-abcdefgh.json" % (dead_pid, live_pid), ancient, "dead number in front of the pid"),
        ("ipynb-mcp-1-9999-%d-%d-abcdefgh.json" % (dead_pid, live_pid), ancient, "dead number two fields in front"),
        # The reverse shape: the dead number IS in the pid field (so this name is inside
        # the writer's shape and the sweep will remove it once past the grace) while the
        # live pid sits earlier. Kept because attribution follows position, not because
        # any live number appears anywhere in the string.
        ("ipynb-mcp-k-%d-%d-abcdefgh.json" % (live_pid, dead_pid), ancient, "live number in the kernelId"),
        # --- the ladder: owner provably gone ------------------------------------------
        # Distinct suffix fields on purpose: two entries that resolve to the same file
        # name would silently overwrite each other's age, and the case would then assert
        # something other than what it says (this bit the fresh/old pair once already).
        ("ipynb-mcp-k-%d-abcdefgh.json" % dead_pid, old, "dead owner, past the grace"),
        ("ipynb-mcp-k-%d-qrstuvwx.json" % dead_pid, fresh, "dead owner, inside the grace"),
        # --- the ladder: owner alive ---------------------------------------------------
        ("ipynb-mcp-k-%d-abcdefgh.json" % live_pid, ancient, "live owner"),
        # --- the ladder: nothing to attribute ------------------------------------------
        # No readable pid at all (runs before this shape was introduced, or another
        # tool's file that happens to share the prefix): the conservative age applies.
        ("ipynb-mcp-abcdefgh.json", ancient, "no pid, ancient"),
        ("ipynb-mcp-abcdefgh-fresh.json", fresh, "no pid, fresh"),
        # A live pid in a name outside the writer's shape: unattributable, and ancient,
        # so it goes — the conservative age is reached, not the live-owner exemption.
        ("ipynb-mcp-k-%d-999999-abcdefgh.json" % live_pid, ancient, "live pid outside the shape"),
        # Prefix-shaped but not one of ours: never touched, at any age.
        ("other-tool-abcdefgh.json", ancient, "foreign prefix"),
    ]
    paths = {}
    for name, mtime, _why in plan:
        # A duplicate name means the plan itself is wrong: the second entry would
        # overwrite the first file's age and the expectation attached to the first would
        # be tested against the second one's file.
        if name in paths:
            raise AssertionError("duplicate fixture name: " + name)
        path = os.path.join(sweep_dir, name)
        with open(path, "w") as handle:
            handle.write("{}")
        os.utime(path, (mtime, mtime))
        paths[name] = path
    return paths


def expectations(module, paths, live_pid, dead_pid):
    return [
        ("live owner + all-digit random suffix survives", paths["ipynb-mcp-k-%d-12345678.json" % live_pid], True,
         "the suffix is mkstemp's random field, not a pid (the V8-6 repro)"),
        ("live owner with a dead number in front survives", paths["ipynb-mcp-k-%d-%d-abcdefgh.json" % (dead_pid, live_pid)], True,
         "the pid must be read from its field, not as 'some number'"),
        ("live owner two fields behind a dead number survives", paths["ipynb-mcp-1-9999-%d-%d-abcdefgh.json" % (dead_pid, live_pid)], True,
         "positional from the end, not first-number-from-the-front either"),
        ("live number in the kernelId does not save the file", paths["ipynb-mcp-k-%d-%d-abcdefgh.json" % (live_pid, dead_pid)], False,
         "attribution is positional: the pid field says the owner is gone"),
        ("dead owner + old file is removed", paths["ipynb-mcp-k-%d-abcdefgh.json" % dead_pid], False,
         "pid positively observed gone, past the orphan grace"),
        ("dead owner + fresh file survives", paths["ipynb-mcp-k-%d-qrstuvwx.json" % dead_pid], True,
         "the kernel's own unlink gets a grace period"),
        ("live owner + ancient file survives", paths["ipynb-mcp-k-%d-abcdefgh.json" % live_pid], True,
         "age never overrides a live owner"),
        ("no pid + ancient file is removed", paths["ipynb-mcp-abcdefgh.json"], False,
         "conservative age reached"),
        ("no pid + fresh file survives", paths["ipynb-mcp-abcdefgh-fresh.json"], True,
         "an age we cannot corroborate is not evidence"),
        ("live pid outside the writer's shape is unattributable", paths["ipynb-mcp-k-%d-999999-abcdefgh.json" % live_pid], False,
         "an unattributable name gets the conservative age, not the live-owner exemption"),
        ("foreign prefix survives", paths["other-tool-abcdefgh.json"], True,
         "not our file, so not ours to delete"),
    ]


def check_attribution(module, live_pid, dead_pid):
    """The rule itself, stated as a table — these are what the sweep's answer rests on."""
    rows = [
        # Names INSIDE the writer's shape: the pid is the second-to-last field.
        ("ipynb-mcp-k-%d-abcdefgh.json" % live_pid, live_pid, "the writer's shape"),
        ("ipynb-mcp-k-%d-12345678.json" % live_pid, live_pid, "all-digit random field is still the random field"),
        ("ipynb-mcp-my-kernel-7-%d-ab12cd34.json" % dead_pid, dead_pid, "kernelId may contain '-'"),
        ("ipynb-mcp-k_1.2-9-%d-01234567.json" % live_pid, live_pid, "kernelId may contain '.', '_' and digits"),
        ("ipynb-mcp-2-%d-abcdefgh.json" % live_pid, live_pid, "numeric kernelId, pid still read by position"),
        # Not the writer's shape ⇒ unattributable, i.e. None. Each of these was, or
        # could be, read as a pid by the old "first all-digit field from the end" rule.
        ("ipynb-mcp-k-abcdefgh.json", None, "no pid field at all"),
        ("ipynb-mcp-k--abcdefgh.json", None, "empty pid field"),
        ("ipynb-mcp-k-12345678901234567890-abcdefgh.json", None, "pid field too long to be a pid"),
        ("ipynb-mcp-k-4294967296-abcdefgh.json", None, "pid field beyond every real pid space"),
        ("ipynb-mcp-k-2-abcd.json", None, "single-character pid field is never a pid"),
        ("ipynb-mcp-k-%d-abc-defgh.json" % live_pid, None, "random field contains '-'"),
        ("ipynb-mcp-k-%d-abcdefg.json" % live_pid, live_pid, "seven-character suffix is still mkstemp's alphabet"),
        ("ipynb-mcp-k-%d-abcdefgh.txt" % live_pid, None, "not a .json connection file"),
        ("ipynb-mcp-\u0661\u0662-abcd.json", None, "non-ASCII digits are not a pid"),
        ("ipynb-mcp-k-%d-12345678.json.tmp" % live_pid, None, "temporary sibling"),
    ]
    rows = [(name, want, why, module._owner_pid(name)) for name, want, why in rows]
    return rows


def main() -> int:
    module = load_sidecar()
    failures = []

    print("sidecar:", SIDECAR_PATH)
    print("platform:", sys.platform)
    print("liveness probe available:", module._liveness_probe_available())

    live_pid = os.getpid()
    dead_pid = spawn_dead_pid()
    judged_live = wait_for(lambda: module._owner_is_alive(live_pid), True)
    judged_dead = wait_for(lambda: module._owner_is_alive(dead_pid), False)
    print("liveness probe on this pid (%d, alive):" % live_pid, judged_live)
    print("liveness probe on a reaped child pid (%d):" % dead_pid, judged_dead)

    # The probe is the whole basis of the pid branch, so an unusable probe is a failure
    # here rather than a silent downgrade to the conservative age: a platform that
    # cannot answer the question leaves every orphan waiting out the long timeout, which
    # is the defect V8-6 measured (6 of 10 stale files in %TEMP% with dead owners).
    probe_rows = [
        ("live pid is judged alive", judged_live, True, "a probe that cannot see a live process proves nothing"),
        ("reaped child pid is judged gone", judged_dead, False, "a probe that never says 'gone' can never clean up"),
    ]
    for label, got, want, why in probe_rows:
        ok = got is want
        print(("  PASS  " if ok else "  FAIL  ") + label + "  [probe said %r] — %s" % (got, why))
        if not ok:
            failures.append(label)

    sweep_dir = tempfile.mkdtemp(prefix="ipynb-mcp-sweep-check-")
    real_sweep = os.path.realpath(sweep_dir)
    real_temp = os.path.realpath(tempfile.gettempdir())
    # Belt and braces against ever handing the sweep a directory that is not this
    # script's own: it must be a freshly created directory DIRECTLY under this platform's
    # temp root. That one property rules out the two ways this could go wrong — passing
    # the temp root itself (which would sweep other tools' leftovers) and passing a path
    # in the repository. Stated as "the parent is the temp root" rather than by comparing
    # against the repo on purpose: on Windows the checkout and %TEMP% normally live on
    # different drives, so any repo-containment arithmetic here (`relpath`, `commonpath`)
    # raises instead of answering, and a guard that raises is a guard that reports the
    # wrong failure — which is exactly what happened while this checker was being
    # mutation-tested. Deliberately also NOT "sweep_dir == gettempdir()": that would
    # forbid a caller which legitimately relocates TEMP/TMPDIR for its own children.
    #
    # The check runs INSIDE the try below, not before it: an early `return` out here
    # skipped the cleanup and left the directory behind, which this script then did on
    # every abort (25 of them accumulated while it was being written). A guard that
    # litters is a guard you stop running.
    try:
        if os.path.dirname(real_sweep) != real_temp or _same_path(real_sweep, os.path.realpath(REPO)):
            print("  FAIL  fixture directory is not a private dir under %s: %s" % (real_temp, sweep_dir))
            # SystemExit rather than `return`: the check runs inside `try`, so this still
            # runs the cleanup, but it does not fall through into code that expects the
            # fixtures to exist (the first attempt exited 1 via an UnboundLocalError,
            # which is a failure reported for the wrong reason).
            raise SystemExit(1)
        print("fixtures:", sweep_dir)
        rows = check_attribution(module, live_pid, dead_pid)
        print("attachment rule:")
        for name, want, why, got in rows:
            ok = got == want
            print(("  PASS  " if ok else "  FAIL  ") + name + "  -> %r (want %r) — %s" % (got, want, why))
            if not ok:
                failures.append("attribute " + name)

        paths = build_fixtures(sweep_dir, module, live_pid, dead_pid)
        checks = expectations(module, paths, live_pid, dead_pid)
        # A check whose path is not one of the fixtures is checking nothing: `paths[...]`
        # would have raised above, but the reverse mistake (a fixture nobody asserts on,
        # or two checks wired to the same file) is silent and is exactly how this guard
        # first reported a failure against the wrong file. So assert both directions.
        checked = [os.path.basename(path) for _label, path, _want, _why in checks]
        unchecked = sorted(set(paths) - set(checked))
        duplicated = sorted({name for name in checked if checked.count(name) > 1})
        for label, offenders in (("fixture(s) never asserted on", unchecked), ("check(s) wired to a shared file", duplicated)):
            ok = not offenders
            print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else ": " + ", ".join(offenders)))
            if not ok:
                failures.append(label)

        removed = module.sweep_orphan_connection_files(sweep_dir)
        print("sweep removed", removed, "file(s)")

        print("sweep behaviour:")
        for label, path, should_exist, why in checks:
            exists = os.path.exists(path)
            ok = exists == should_exist
            state = "kept" if exists else "removed"
            want_state = "kept" if should_exist else "removed"
            print(
                ("  PASS  " if ok else "  FAIL  ")
                + label.ljust(46)
                + " [%s, want %s] — %s" % (state, want_state, why)
            )
            if not ok:
                failures.append(label)
    finally:
        shutil.rmtree(sweep_dir, ignore_errors=True)
        if os.path.exists(sweep_dir):
            print("  WARN  could not remove the fixture directory:", sweep_dir)

    if failures:
        print("FAIL: %d expectation(s) not met" % len(failures))
        for label in failures:
            print("  -", label)
        return 1
    print("PASS: connection-file sweep behaves as specified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
