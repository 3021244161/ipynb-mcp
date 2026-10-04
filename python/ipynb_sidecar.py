"""ipynb-mcp sidecar (SPEC §5.8).

Speaks NDJSON over stdio with the Node transport:
  request : {"id": "<uuid>", "op": "<name>", "params": {...}}
  response: {"id": "<uuid>", "ok": true, "result": {...}}
            {"id": "<uuid>", "ok": false, "error": {"code", "message", "detail"}}
  event   : {"event": "kernel_died"|"log", ...}

Hard rules:
  - NEVER reads or writes any USER file (the only writer of .ipynb files is
    Node). Its own jupyter_client connection file is placed in the OS temp
    directory (never the cwd, which is the user's project directory) and is
    removed on every exit path this process controls — see CONNECTION_FILE_
    DEVIATION below.
  - Only depends on jupyter_client + the standard library.
  - stdout carries protocol frames ONLY; debug output goes to stderr.
"""

from __future__ import annotations

import errno
import json
import os
import sys
import tempfile
import threading
import time
from queue import Empty

try:
    from jupyter_client.manager import KernelManager
except ImportError as exc:  # pragma: no cover - import guard for clear errors
    KernelManager = None
    _IMPORT_ERROR = str(exc)
else:
    _IMPORT_ERROR = None


class KernelEntry:
    def __init__(self, kernel_id: str, km: "KernelManager") -> None:
        self.kernel_id = kernel_id
        self.km = km
        self.client = km.client()
        self.client.start_channels()
        self.execution_count = None

    def pid(self):
        provisioner = getattr(self.km, "provisioner", None)
        process = getattr(provisioner, "process", None)
        return getattr(process, "pid", None)

    def shutdown(self) -> None:
        try:
            self.client.stop_channels()
        except Exception as exc:
            send_log("warn", f"stop_channels failed for {self.kernel_id}: {exc}")
        try:
            self.km.shutdown_kernel(now=False)
        except Exception as exc:
            send_log("warn", f"graceful shutdown failed for {self.kernel_id}: {exc}")
            try:
                self.km.shutdown_kernel(now=True)
            except Exception as exc2:
                send_log("warn", f"forced shutdown failed for {self.kernel_id}: {exc2}")
        self.remove_connection_file()

    def remove_connection_file(self) -> None:
        """Delete our connection file (it carries the kernel's HMAC key).

        jupyter_client only removes it inside a successful graceful shutdown, so
        every other exit path (forced kill, host crash, protocol error) used to
        leave it behind — in the sidecar's cwd when the interpreter's temp
        directory is unusable, i.e. the user's project directory
        (review v3 DEP-1 / SPEC §5.9 net-result rule).
        """
        path = getattr(self.km, "connection_file", None)
        if not path:
            return
        try:
            os.unlink(path)
        except OSError:
            pass  # already gone, or unlinkable: nothing left to do


# Prefix `tempfile.mkstemp` gives our connection files, so a later run can recognise
# its own leftovers.
CONNECTION_PREFIX = "ipynb-mcp-"

# `tempfile._RandomNameSequence.characters`, i.e. the alphabet of the suffix mkstemp
# appends. Spelled out here because the attribution rule below has to verify the shape
# the writer actually produces, and this is the only external fact in it.
MKSTEMP_SUFFIX_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_"

# Fallback only, and deliberately conservative. The PRIMARY test for "nobody is using
# this file" is the pid in its name: `tempfile.mkstemp` is called with
# `prefix=f"ipynb-mcp-{kernel_id}-{os.getpid()}-"`, so the owning process is right
# there in the filename and a liveness probe answers the question directly. Age alone
# was wrong in both directions: a kernel running longer than this still owns its file,
# and a file orphaned after the last sidecar started would never be swept at all
# (review v8 V8-6).
#
# So age is applied in a different shape depending on what the value of the pid test
# is — see the three constants below. A single "one hour and it is fair game" rule let
# a live sidecar's file be swept on Windows, where pid liveness was not testable.
ORPHAN_CONNECTION_AGE_SECONDS = 3600

# The age a file must reach when the name CANNOT be attributed to a process, or when
# this platform cannot judge the pid it names. A week is far longer than any test run
# and longer than a normal working session, so a file this old is certainly debris
# rather than something in use.
UNATTRIBUTABLE_CONNECTION_AGE_SECONDS = 7 * 24 * 3600

# The age a file must reach when its owner is known and known to be GONE, but this
# platform has no liveness probe at all. Same reasoning as the orphan grace below, only
# longer: without a probe, "the owner is gone" is not a fact anybody established, so
# this is the honest reading of a name we can parse but not verify. Windows is NOT in
# this class any more — it probes with `OpenProcess`/`WaitForSingleObject` and therefore
# uses ORPHAN_CONNECTION_AGE_SECONDS like everyone else (review v9 V8-6).
UNPROBEABLE_CONNECTION_AGE_SECONDS = 24 * 3600


def _owner_pid(name: str) -> int | None:
    """The pid embedded in a connection file's name, or None if there is none.

    THE RULE, in full — attribution is positional and the shape must match, because
    guessing here deletes a file that may belong to a running process:

      `ipynb-mcp-` + `<kernelId>` + `-` + `<pid>` + `-` + `<random>` + `.json`

      * the name must end in the literal `.json`;
      * the LAST `-`-separated field is `<random>`, mkstemp's suffix: one or more
        characters, all from MKSTEMP_SUFFIX_CHARS, and `tempfile` emits exactly eight;
      * the field BEFORE it is `<pid>`: two or more decimal digits, and the whole
        field (no `.`, no stray characters);
      * `<kernelId>` is everything between the prefix and those two fields, and is not
        interpreted at all — it is user-supplied and may contain `-`, digits, or both.

    Anything else returns None, i.e. "this file cannot be attributed". That is the
    point: the previous rule ("the first all-digit field counting back from the end")
    read mkstemp's random suffix as a pid whenever the suffix happened to be all
    digits (p ~ 3.5e-5 per file), and the owner it invented was usually gone — so it
    deleted a live process's connection file, HMAC key included (review v9 V8-6).
    A name we cannot attribute is not a name we may act on by age alone; the caller
    applies UNATTRIBUTABLE_CONNECTION_AGE_SECONDS instead.
    """
    if not name.endswith(".json"):
        return None
    fields = name[: -len(".json")].split("-")
    # fields[0] is "ipynb" for any name the caller considers; require our prefix so
    # this function stays honest when called directly (the sweep filters as well).
    if len(fields) < 4 or fields[0] != "ipynb" or fields[1] != "mcp":
        return None
    # Order matters and is easy to invert: the LAST field is mkstemp's random suffix,
    # the one BEFORE it is the pid. Stated one per line for exactly that reason.
    random_field = fields[-1]
    pid_field = fields[-2]
    if not random_field or any(ch not in MKSTEMP_SUFFIX_CHARS for ch in random_field):
        return None
    # At least two digits: single-digit fields are far more likely to be part of a
    # kernelId that leaked into the wrong position than a pid, and guessing wrong means
    # deleting someone's file. `isdigit` is True for non-ASCII digits, which `int()`
    # would then misread, so restrict it to ASCII as well. The upper bound rejects a
    # number no pid can be (2^31 outruns every real pid space) rather than passing a
    # nonsense value to the liveness probe, where "no such pid" would read as "the
    # owner is gone" and delete a file whose name we merely failed to parse.
    if not (pid_field.isascii() and pid_field.isdigit()) or not (2 <= len(pid_field) <= 10):
        return None
    pid = int(pid_field)
    return pid if pid < 2**31 else None


def _windows_owner_is_alive(pid: int) -> bool | None:
    """Real liveness probe for Windows: True, False, or None if not permitted.

    `os.kill(pid, 0)` is NOT a liveness probe on Windows — CPython implements it as
    `TerminateProcess` — so the sweep used to answer "cannot tell" for every file and
    fall through to the most conservative age rule. That silently reinstated the bug
    the pid rule exists to fix: the files a crashed run leaves behind sat in %TEMP%
    for a week instead of the hour the old rule allowed (review v9 V8-6 measured 6 of
    10 files with long-dead owners).

    `OpenProcess` + `WaitForSingleObject` is the liveness test the OS actually offers:
    an exited process is a signalled object, so a zero timeout returns WAIT_OBJECT_0
    for "gone" and WAIT_TIMEOUT for "still running". It cannot kill anything — the
    handle is opened query-only and closed immediately — and it imports nothing
    outside the standard library, so it costs the sidecar no new dependency
    (`tasklist` would: a spawned process per file, in a function that runs at startup).

    `None` (not `False`) when the process exists but we may not query it: "cannot
    tell" must never be paraphrased into "safe to delete".
    """
    api = _windows_process_api()
    if api is None:
        return None
    kernel32 = api["kernel32"]
    handle = None
    for access in (api["limited"], api["full"]):
        handle = kernel32.OpenProcess(access, False, pid)
        if handle:
            break
        # 87 is "no such process" in OpenProcess's vocabulary. Anything else (5, most
        # often: a protected or higher-integrity process) means the process may well be
        # there and we simply cannot look at it.
        if api["last_error"]() != api["invalid_parameter"]:
            return None
    if not handle:
        return False
    try:
        verdict = kernel32.WaitForSingleObject(handle, 0)
    finally:
        kernel32.CloseHandle(handle)
    if verdict == api["wait_object_0"]:
        return False
    if verdict == api["wait_timeout"]:
        return True
    # WAIT_FAILED and anything else: an unusable handle is not evidence of death.
    return None


_WINDOWS_PROCESS_API: dict | None = None


def _windows_process_api() -> dict | None:
    """Load and cache the kernel32 entry points the liveness probe needs, once.

    Cached because the sweep calls the probe per candidate file and re-declaring four
    prototypes (and re-loading the DLL) for each is pointless work at startup, on the
    path the user waits for. Returns None if the API cannot be loaded at all, which the
    caller must treat as "no probe here", never as "the owner is gone".
    """
    global _WINDOWS_PROCESS_API
    if _WINDOWS_PROCESS_API is None:
        try:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel32.WaitForSingleObject.restype = wintypes.DWORD
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL
            _WINDOWS_PROCESS_API = {
                "kernel32": kernel32,
                "last_error": ctypes.get_last_error,
                "limited": 0x1000 | 0x00100000,  # PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
                "full": 0x0400,  # PROCESS_QUERY_INFORMATION
                "invalid_parameter": 87,  # ERROR_INVALID_PARAMETER
                "wait_object_0": 0x0,  # WAIT_OBJECT_0
                "wait_timeout": 0x102,  # WAIT_TIMEOUT
            }
        except Exception:  # pragma: no cover - only on a broken ctypes install
            return None
    return _WINDOWS_PROCESS_API


def _owner_is_alive(pid: int) -> bool | None:
    """Whether `pid` names a live process: True, False, or None if unknowable.

    The invariant this function exists to protect is one-directional, and both branches
    below keep it: `False` is only ever returned for a pid that was positively observed
    to be gone, and a pid we cannot observe returns `None` so the caller falls back to
    an age rule instead of deleting. `None` never means "probably dead".
    """
    if pid <= 0:
        return False
    if sys.platform == "win32":
        return _windows_owner_is_alive(pid)
    try:
        os.kill(pid, 0)
        return True
    except OSError as exc:
        # ESRCH: no such process. EPERM: it exists but belongs to someone else — alive
        # either way for our purposes.
        return getattr(exc, "errno", None) == errno.EPERM
    except BaseException:  # pragma: no cover - defensive, see the docstring
        return None


def sweep_orphan_connection_files(directory: str | None = None) -> int:
    """Delete our own abandoned connection files from the temp directory.

    The files carry the kernel's HMAC key, so leaving them behind is a (small) leak
    of a credential. Every graceful path already deletes its own file; this exists
    for the paths that cannot — a SIGKILLed sidecar, a host crash, a CI job torn
    down mid-run, which is where the 45 files the v7 review found came from.

    Deliberately narrow: only files matching our own name prefix, only in the sweep
    directory, only when the owning pid is provably gone, and never fatal — a sweep
    that fails must not stop kernels from working. A file whose name cannot be
    attributed to a process, or whose pid this platform cannot judge, is removed only
    after UNATTRIBUTABLE_CONNECTION_AGE_SECONDS, because "one hour old" is not evidence
    that nothing owns it.

    `directory` exists so the rule can be tested against a temporary directory of
    purpose-built names instead of the machine's real %TEMP% (that is what
    `scripts/check-connection-sweep.py` does); production callers pass nothing. It is
    an argument rather than a module constant precisely so a test cannot redirect the
    real sweep by accident.

    This is the ONLY place the sidecar touches a file it did not create, which is why
    it is registered as D-046 rather than left as an implicit exception to the module
    rule in AGENTS §4.
    """
    removed = 0
    try:
        temp_dir = directory if directory is not None else tempfile.gettempdir()
        if not os.path.isdir(temp_dir):
            return 0
        now = time.time()
        try:
            entries = os.listdir(temp_dir)
        except OSError as exc:
            send_log("warn", f"could not list {temp_dir} to sweep connection files: {exc}")
            return 0
        for name in entries:
            if not (name.startswith(CONNECTION_PREFIX) and name.endswith(".json")):
                continue
            # Each file is judged independently, and a failure to judge ONE file must
            # not abort the scan: the whole point is to clean up after crashes, and a
            # crashed run can leave anything behind. The previous shape let a single
            # bad entry end the loop with a warning, which is how the sweep "failed"
            # while still removing five files.
            try:
                pid = _owner_pid(name)
                candidate = os.path.join(temp_dir, name)
                age = now - os.path.getmtime(candidate)
                if pid is None:
                    # Nothing in the name says who owns it: only a file this old is
                    # certainly debris. Never a live candidate's file.
                    if age <= UNATTRIBUTABLE_CONNECTION_AGE_SECONDS:
                        continue
                else:
                    alive = _owner_is_alive(pid)
                    if alive is True:
                        continue
                    # The ladder is ordered by how much the platform actually knows,
                    # and the age it demands differs accordingly: a pid observed to be
                    # gone needs only the short grace period, "the probe was refused for
                    # this one pid" gets a day, and a platform with no probe at all has
                    # to be maximally conservative. Collapsing the middle case into the
                    # last is what made Windows wait a week per file (review v9 V8-6);
                    # collapsing it into the FIRST is what would delete a live owner's
                    # file, so `None` is never allowed to become `False`.
                    if alive is False:
                        limit = ORPHAN_CONNECTION_AGE_SECONDS
                    elif _liveness_probe_available():
                        limit = UNPROBEABLE_CONNECTION_AGE_SECONDS
                    else:
                        limit = UNATTRIBUTABLE_CONNECTION_AGE_SECONDS
                    if age <= limit:
                        # A just-exited kernel removes its own file; racing that path
                        # buys nothing.
                        continue
                os.unlink(candidate)
                removed += 1
            except OSError:
                continue
            except BaseException as exc:  # pragma: no cover - defensive
                send_log("warn", f"skipping {name} during the connection-file sweep: {exc!r}")
                continue
    except Exception as exc:  # pragma: no cover - the sweep must never be fatal
        send_log("warn", f"orphan connection-file sweep failed: {exc}")
        return removed
    if removed:
        send_log("info", f"removed {removed} orphaned connection file(s) from {temp_dir}")
    return removed


def _liveness_probe_available() -> bool:
    """Whether `_owner_is_alive` can return a verdict on this platform at all.

    Used only to pick the fallback age: a platform that CAN probe but was refused
    permission for one particular pid is a different case from a platform that has no
    probe, and only the second one is allowed to be maximally conservative. Without
    this distinction every file on Windows waited a week (review v9 V8-6).
    """
    return sys.platform != "win32" or _windows_probe_usable()


def _windows_probe_usable() -> bool:
    """Whether the Windows ctypes probe can load. False ⇒ behave like the old fallback.

    Checked separately from the probe itself because the two answers mean different
    things: this one says "the question can be asked on this host", while a `None` from
    the probe says "it was asked and refused". Only the first decides the fallback age.
    """
    try:
        import ctypes

        return hasattr(ctypes, "WinDLL")
    except Exception:  # pragma: no cover - ctypes ships with CPython
        return False


KERNELS: dict[str, KernelEntry] = {}
KERNELS_LOCK = threading.Lock()
STDOUT_LOCK = threading.Lock()

# How long to wait for an `execute_reply` after iopub went idle. Mirrored by
# `SIDECAR_SHELL_REPLY_MS` in src/kernel/sidecar-transport.ts, which budgets the
# transport's own timeout above this value.
SHELL_REPLY_BUDGET_SECONDS = 30

# Grace period after an interrupt request. Mirrored by
# `SIDECAR_INTERRUPT_GRACE_MS` in src/kernel/sidecar-transport.ts.
INTERRUPT_GRACE_SECONDS = 5.0


class KernelDiedError(RuntimeError):
    """Raised when a kernel process dies during an operation."""


def send(obj: dict) -> None:
    # The frames carry the user's own text — a traceback from a cell, a path with Chinese
    # characters — and `ensure_ascii=False` writes it as raw UTF-8. The stream's encoding is
    # chosen by the ENVIRONMENT, not by us: a Windows console defaults to cp1252 and a POSIX
    # process with `LANG=C` gets ANSI_X3.4-1968, and `sys.stdout.write` then raises
    # `UnicodeEncodeError` in the middle of a response. That is not a theoretical failure: the
    # same shape took out `scripts/check-connection-sweep.py` in CI, where the runner's console
    # could not encode a `→` in its own report. For the sidecar the stakes are higher — the
    # exception would escape `main`, kill the process, and take every kernel with it, with the
    # client seeing only `Connection closed`.
    #
    # `errors="replace"` after the encoding attempt: a `?` in a diagnostic beats a dead
    # sidecar, and the JSON envelope itself is ASCII, so the protocol stays parseable.
    with STDOUT_LOCK:
        try:
            sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        except UnicodeEncodeError:
            sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
        sys.stdout.flush()


def send_log(level: str, message: str) -> None:
    send({"event": "log", "level": level, "message": message})


def send_kernel_died(kernel_id: str) -> None:
    send({"event": "kernel_died", "kernelId": kernel_id})


# ---------------------------------------------------------------------------
# op implementations
# ---------------------------------------------------------------------------

def op_ping(_params: dict) -> dict:
    if KernelManager is None:
        raise RuntimeError(f"jupyter_client is not importable: {_IMPORT_ERROR}")
    import jupyter_client
    versions = {
        "pythonVersion": sys.version.split(" ")[0],
        "jupyterClientVersion": jupyter_client.__version__,
        "ipykernelVersion": _module_version("ipykernel"),
    }
    return versions


def _module_version(name: str):
    try:
        from importlib import metadata
        return metadata.version(name)
    except Exception:
        try:
            module = __import__(name)
            return getattr(module, "__version__", "unknown")
        except Exception:
            return "unknown"


def op_start_kernel(params: dict) -> dict:
    if KernelManager is None:
        raise RuntimeError(f"jupyter_client is not importable: {_IMPORT_ERROR}")
    kernel_id = params["kernelId"]
    interpreter_path = params["interpreterPath"]
    kernel_spec_name = params["kernelSpecName"]
    language = params.get("language", "python")

    km = KernelManager(kernel_name=kernel_spec_name)
    # Pin the connection file into the OS temp directory BEFORE start_kernel:
    # jupyter_client's default is `tempfile.mkstemp('.json')`, which falls back
    # to the CURRENT WORKING DIRECTORY when the interpreter's temp dir is
    # unusable — and the cwd is the user's notebook project when an MCP client
    # launches us via npx (review v3 DEP-1). The file carries the kernel's HMAC
    # key, so where it lives matters. The kernelId comes from Node, but it is
    # sanitized anyway: it ends up in a path.
    safe_kernel_id = "".join(ch for ch in kernel_id if ch.isalnum() or ch in "-_") or "kernel"
    try:
        # `mkstemp` creates the file atomically with mode 0600 and a name that
        # cannot collide or be pre-created by another local user. os.path.join
        # alone would leave a window in which a predictable name in a shared
        # /tmp is someone else's file (review v4 SEC-TOCTOU). jupyter_client
        # overwrites the contents, so an empty placeholder is fine.
        #
        # The directory is passed EXPLICITLY, and a temp dir that does not exist
        # fails the whole block rather than falling back: `tempfile.gettempdir()`
        # silently returns `'.'` when TEMP/TMPDIR are unset, which is how 45
        # connection files — each carrying an HMAC key — ended up in the user's
        # working directory (review v7 P1-c). Temp files belong in a temp
        # directory, and a missing one is a real environment problem worth warning
        # about.
        temp_dir = tempfile.gettempdir()
        if not os.path.isdir(temp_dir):
            raise OSError(f"no usable temp directory: {temp_dir}")
        fd, connection_path = tempfile.mkstemp(
            prefix=f"ipynb-mcp-{safe_kernel_id}-{os.getpid()}-", suffix=".json", dir=temp_dir
        )
        os.close(fd)
        os.chmod(connection_path, 0o600)
        km.connection_file = connection_path
    except Exception as exc:  # pragma: no cover - tempdir resolution failure
        send_log("warn", f"could not pin the connection file location: {exc}")
    if language == "python":
        # Run the kernel with the interpreter the Node side resolved (D23):
        # keep the spec's env/metadata but pin argv[0] to that interpreter.
        # jupyter_client 8.x has no kernel_cmd kwarg anymore; mutating the
        # cached spec's argv is the supported path.
        target_argv = [interpreter_path, "-m", "ipykernel", "-f", "{connection_file}"]
        try:
            spec = km.kernel_spec
        except Exception:
            spec = None
        if spec is not None:
            spec.argv = target_argv
        else:
            # No kernelspec registered under that name: run ipykernel directly.
            from jupyter_client.kernelspec import KernelSpec

            km._kernel_spec = KernelSpec(
                argv=target_argv, display_name=kernel_spec_name, language="python"
            )
    km.start_kernel()

    entry = KernelEntry(kernel_id, km)
    try:
        entry.client.wait_for_ready(timeout=60)
    except Exception as exc:
        # shutdown() unlinks the connection file too. Without this, every
        # FAILED start (the common case on a machine whose pyzmq is broken)
        # left a key-bearing file behind — the probes in this repository's own
        # test suite had accumulated 16 of them (D-023).
        entry.shutdown()
        raise RuntimeError(f"kernel did not become ready: {exc}") from exc
    except BaseException:
        # A crash between start_kernel and readiness must not leak either.
        entry.remove_connection_file()
        raise
    with KERNELS_LOCK:
        KERNELS[kernel_id] = entry
    return {"pid": entry.pid(), "kernelSpecName": kernel_spec_name, "language": language}


def op_exec_cell(params: dict) -> dict:
    kernel_id = params["kernelId"]
    with KERNELS_LOCK:
        entry = KERNELS.get(kernel_id)
    if entry is None:
        raise RuntimeError(f"unknown kernel: {kernel_id}")
    kc = entry.client
    code = params["code"]
    silent = bool(params.get("silent", False))
    store_outputs = bool(params.get("storeOutputs", True))
    timeout_ms = int(params.get("timeoutMs", 300_000))

    # Drain stale traffic from previous executions on both channels.
    _drain_iopub(kc)
    _drain_shell(kc)

    started = time.monotonic()
    deadline = started + timeout_ms / 1000.0
    msg_id = kc.execute(code, silent=silent, store_history=not silent)

    def own(msg: dict) -> bool:
        return msg.get("parent_header", {}).get("msg_id") == msg_id

    outputs: list[dict] = []
    status = "ok"
    interrupt_deadline = None
    # A cell that raised, seen on iopub. Authoritative for `error`, because the shell reply can
    # be missing (see the error branch below).
    exec_error = False
    # Did we send the interrupt that a TIMEOUT requires? If the cell then ends
    # with a `KeyboardInterrupt`, the status is still `timeout`: SPEC §4.7 rule 6
    # makes `timeout` a value of the `status` field and says a timeout marks the
    # kernel dead, so it cannot depend on whether the platform's interrupt lands.
    # It does land on Linux, and the cell used to come back as `error` there —
    # the same run reported `exec_timeout` on Windows and `internal` on Linux
    # (measured in CI, review D-025 收尾). The caller cannot act on that
    # difference: it asked for a deadline, and the deadline was exceeded.
    timed_out = False

    while True:
        now = time.monotonic()
        if interrupt_deadline is not None:
            wait_for = max(0.05, interrupt_deadline - now)
        else:
            wait_for = max(0.05, deadline - now)
        try:
            msg = kc.get_iopub_msg(timeout=min(wait_for, 5.0))
        except Empty:
            now = time.monotonic()
            # A dead kernel never delivers iopub messages: poll the process
            # state on every wake-up instead of waiting out the full timeout
            # (review A12 — OOM-killed kernels used to hang until timeout).
            if not entry.km.is_alive():
                send_kernel_died(kernel_id)
                raise KernelDiedError("kernel died during execution")
            if interrupt_deadline is None and now >= deadline:
                if not entry.km.is_alive():
                    send_kernel_died(kernel_id)
                    raise KernelDiedError("kernel died during execution")
                try:
                    entry.km.interrupt_kernel()
                except Exception as exc:  # interrupt failed on a dead kernel
                    if not entry.km.is_alive():
                        send_kernel_died(kernel_id)
                        raise KernelDiedError(f"kernel died during execution: {exc}") from exc
                # 5 s of grace for the interrupt to take effect. On Windows this
                # is the WHOLE budget: ipykernel's interrupt needs a console
                # event that a stdio MCP server does not have, so a slept cell
                # ignores it and the deadline below returns "timeout" (review v4
                # FID-6). Both outcomes are documented in README's known
                # limitations — the shutdown that follows the timeout is what
                # actually reclaims the CPU (SPEC §4.7 rule 6, D-025).
                interrupt_deadline = now + INTERRUPT_GRACE_SECONDS
                timed_out = True
                continue
            if interrupt_deadline is not None and now >= interrupt_deadline:
                if not entry.km.is_alive():
                    send_kernel_died(kernel_id)
                    raise KernelDiedError("kernel died during execution")
                status = "timeout"
                break
            continue

        if not own(msg):
            # Stale message from an earlier execution; never terminates ours.
            continue

        msg_type = msg.get("msg_type", "")
        content = msg.get("content", {})
        if msg_type == "status" and content.get("execution_state") == "idle":
            break
        if msg_type == "stream":
            text = content.get("text", "")
            if isinstance(text, list):
                text = "".join(text)
            outputs.append({
                "outputType": "stream",
                "name": content.get("name", "stdout"),
                "text": text,
            })
        elif msg_type in ("display_data", "execute_result"):
            outputs.append({
                "outputType": msg_type,
                "data": content.get("data", {}),
                "metadata": content.get("metadata", {}),
            })
        elif msg_type == "error":
            # Record that the cell raised. The shell reply normally says the same thing, but it
            # is a SECOND message that may never arrive inside `SHELL_REPLY_BUDGET_SECONDS`
            # (that budget exists because it sometimes does not), and a run that reported `ok`
            # for a cell whose traceback it had already collected would be a silent lie about
            # the result. The iopub error is first-hand evidence; the reply is corroboration.
            exec_error = True
            outputs.append({
                "outputType": "error",
                "ename": content.get("ename", ""),
                "evalue": content.get("evalue", ""),
                "traceback": content.get("traceback", []),
            })

    execution_count = None
    reply_status = None
    if status == "timeout":
        # Do NOT wait for the shell reply here. The kernel is still running the
        # cell (the interrupt did not land), so `execute_reply` cannot arrive:
        # waiting the full 30 s budget meant a 3 s timeout cost the caller
        # timeoutMs + 35 s of wall clock on Windows, where interrupt_kernel()
        # needs a console the MCP server does not have (review v4 FID-6:
        # measured 38.0 s for timeoutMs=3 s). SPEC §4.7 rule 5 says the
        # response IS the timeout, and the detached execution's output is
        # discarded by design, so there is nothing to wait for.
        duration_ms = int((time.monotonic() - started) * 1000)
        return {
            "status": "timeout",
            "executionCount": None,
            "rawOutputs": [],
            "durationMs": duration_ms,
        }
    # Budget for the `execute_reply` of a cell that DID become idle. This is the
    # sidecar's second timeout constant, and the Node transport must stay above
    # it: `SIDECAR_SHELL_REPLY_MS` in src/kernel/sidecar-transport.ts mirrors this
    # number (review v6 FID-6 收尾 — it used to be an unexplained literal here and
    # was still quoted in the transport's comments after the timeout path changed).
    shell_deadline = time.monotonic() + SHELL_REPLY_BUDGET_SECONDS
    while time.monotonic() < shell_deadline:
        try:
            reply = kc.get_shell_msg(timeout=shell_deadline - time.monotonic())
        except Empty:
            break
        if not own(reply):
            continue  # stale reply (e.g. leftover kernel_info_reply)
        reply_content = reply.get("content", {})
        reply_status = reply_content.get("status")
        execution_count = reply_content.get("execution_count")
        break

    if status == "ok" and (reply_status == "error" or exec_error):
        status = "error"
    if timed_out:
        # The deadline was exceeded and we sent the interrupt for it, so the answer is
        # `timeout` whether or not the interrupt landed. The two platforms differ in HOW the
        # cell ends — Windows: the sleep ignores the interrupt, nothing arrives, the grace
        # deadline above fires; Linux: SIGINT lands, the kernel raises KeyboardInterrupt and
        # reports `error` — and a caller cannot act on that difference. SPEC §4.7 rule 6 puts
        # `timeout` in the `status` enum and says it marks the kernel dead, so reporting
        # `error` here also mislabelled a user's own exception as a platform artefact.
        #
        # `execution_count` is preserved (the kernel DID run the cell) and `outputs` keeps
        # what the cell managed to print before the deadline; both are carried, while `status`
        # is what drives the terminal `exec_timeout` and the "do not write this cell back"
        # rule (SPEC §4.7 rules 5/6). On the Windows path outputs are empty by construction,
        # which is the one remaining asymmetry — and it is inherent: there is no idle message
        # to stop at, so nothing was collected.
        status = "timeout"
    if execution_count is not None:
        entry.execution_count = execution_count

    duration_ms = int((time.monotonic() - started) * 1000)
    return {
        "status": status,
        "executionCount": execution_count,
        "rawOutputs": outputs if store_outputs else [],
        "durationMs": duration_ms,
    }


def op_interrupt(params: dict) -> dict:
    with KERNELS_LOCK:
        entry = KERNELS.get(params["kernelId"])
    if entry is None:
        raise RuntimeError(f"unknown kernel: {params['kernelId']}")
    entry.km.interrupt_kernel()
    return {"ok": True}


def op_shutdown_kernel(params: dict) -> dict:
    kernel_id = params["kernelId"]
    with KERNELS_LOCK:
        entry = KERNELS.pop(kernel_id, None)
    if entry is None:
        return {"ok": True}
    entry.shutdown()
    return {"ok": True}


def op_kernel_status(params: dict) -> dict:
    with KERNELS_LOCK:
        entry = KERNELS.get(params["kernelId"])
    if entry is None:
        return {"alive": False, "executionCount": None, "pid": None}
    return {
        "alive": bool(entry.km.is_alive()),
        "executionCount": entry.execution_count,
        "pid": entry.pid(),
    }


def op_shutdown_all(_params: dict) -> dict:
    with KERNELS_LOCK:
        pending = list(KERNELS.items())
        KERNELS.clear()
    for kernel_id, entry in pending:
        try:
            entry.shutdown()
        except Exception as exc:
            send_log("warn", f"shutdown_all failed for {kernel_id}: {exc}")
    return {"ok": True}


def op_analyze(params: dict) -> dict:
    """Per-cell module-level definitions and uses via symtable (SPEC §5.6)."""
    import symtable

    sources = params["sources"]
    defs: list[list[str]] = []
    uses: list[list[str]] = []
    failed: list[int] = []
    for index, source in enumerate(sources):
        try:
            table = symtable.symtable(source, "<cell>", "exec")
        except SyntaxError:
            failed.append(index)
            defs.append([])
            uses.append([])
            continue
        cell_defs, cell_uses = _extract_symbols(table)
        defs.append(cell_defs)
        uses.append(cell_uses)
    return {"ok": len(failed) == 0, "failedCellIndexes": failed, "defs": defs, "uses": uses}


def _extract_symbols(table) -> tuple[list[str], list[str]]:
    defined = set()
    for symbol in table.get_symbols():
        if symbol.is_parameter():
            continue
        if symbol.is_assigned() or symbol.is_imported() or symbol.is_namespace():
            defined.add(symbol.get_name())

    used = set()
    for symbol in table.get_symbols():
        if symbol.is_referenced() and symbol.get_name() not in defined:
            used.add(symbol.get_name())
    # Names referenced from nested scopes that resolve to module globals.
    for child in _iter_descendants(table):
        for symbol in child.get_symbols():
            if symbol.is_global() and symbol.is_referenced():
                used.add(symbol.get_name())

    return sorted(defined), sorted(used - defined)


def _iter_descendants(table):
    for child in table.get_children():
        yield child
        yield from _iter_descendants(child)


OPS = {
    "ping": op_ping,
    "start_kernel": op_start_kernel,
    "exec_cell": op_exec_cell,
    "interrupt": op_interrupt,
    "shutdown_kernel": op_shutdown_kernel,
    "kernel_status": op_kernel_status,
    "analyze": op_analyze,
    "shutdown_all": op_shutdown_all,
}


def _drain_iopub(client) -> None:
    try:
        while True:
            client.get_iopub_msg(timeout=0.05)
    except Empty:
        pass


def _drain_shell(client) -> None:
    try:
        while True:
            client.get_shell_msg(timeout=0.05)
    except Empty:
        pass


def handle_request(request: dict) -> None:
    request_id = request.get("id")
    op = request.get("op")
    params = request.get("params", {})
    handler = OPS.get(op)
    if handler is None:
        send({
            "id": request_id,
            "ok": False,
            "error": {"code": "internal", "message": f"unknown op: {op}"},
        })
        return
    try:
        result = handler(params)
        send({"id": request_id, "ok": True, "result": result})
    except Exception as exc:
        code = "kernel_died" if isinstance(exc, KernelDiedError) else "internal"
        send({
            "id": request_id,
            "ok": False,
            "error": {"code": code, "message": f"{type(exc).__name__}: {exc}"},
        })


def main() -> int:
    # Both directions of the protocol carry the user's text, and neither stream's encoding is
    # ours to assume: a cp1252 console on Windows or `LANG=C` on POSIX makes `sys.stdin`
    # decode ASCII and `sys.stdout` encode it, so a notebook with a Chinese path fails on the
    # way in as well as on the way out (the outgoing half is also defended in `send`, which
    # must keep working even if this call is unavailable).
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):  # pragma: no cover - non-reconfigurable stream
            pass
    send_log("info", "sidecar ready")
    # Before starting any kernel: clear the connection files an earlier crashed or
    # SIGKILLed run could not delete. Doing it at startup rather than at exit is
    # deliberate — the runs that leak are exactly the ones that never reach an exit
    # path, so only a later run can clean up after them (review v7 P1-c).
    sweep_orphan_connection_files()
    workers: list[threading.Thread] = []
    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            request = json.loads(stripped)
        except json.JSONDecodeError as exc:
            send_log("warn", f"unparseable request line: {exc}")
            continue
        if not isinstance(request, dict):
            send_log("warn", "request is not an object")
            continue
        # Each request runs on its own worker thread: an in-flight exec_cell
        # (which blocks for its whole timeout window) must not delay interrupt
        # or shutdown ops (SPEC §4.6.2 / §4.8 — "interrupt immediately").
        worker = threading.Thread(target=handle_request, args=(request,), daemon=True)
        worker.start()
        workers.append(worker)
        # Bound the thread table: finished workers must not accumulate for
        # the lifetime of a long session (review A28).
        if len(workers) > 64:
            workers = [w for w in workers if w.is_alive()]
    # stdin closed: clean shutdown path (Node normally calls shutdown_all first).
    for worker in workers:
        worker.join(timeout=5)
    op_shutdown_all({})
    _remove_leftover_connection_files()
    # ...and only now sweep, for a reason that is about ordering and not about tidiness
    # (review v9 V8-6: the startup-only sweep left this on the table). At this point our
    # own files are already unlinked above, so nothing here can be ours, and the rules
    # that protect a live owner are the same ones that ran at startup — a file whose
    # owner is still alive is skipped no matter how old it is, so a concurrent sidecar
    # is never at risk. What this buys: a session that runs for hours and leaks a file
    # mid-session (a SIGKILLed kernel grandchild, a failed start) no longer waits for
    # the NEXT sidecar to clean up after it. Deliberately the last thing before exit:
    # the sweep is best-effort and must never delay or replace the shutdown above.
    sweep_orphan_connection_files()
    return 0


def _remove_leftover_connection_files() -> None:
    """Belt and braces for DEP-1: any kernel entry that survived shutdown_all
    (started milliseconds ago, or already dropped from KERNELS) still gets its
    connection file unlinked before we exit."""
    with KERNELS_LOCK:
        entries = list(KERNELS.values())
    for entry in entries:
        entry.remove_connection_file()


if __name__ == "__main__":
    sys.exit(main())
