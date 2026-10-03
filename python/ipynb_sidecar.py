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

# A connection file older than this cannot belong to a live kernel: every path that
# ends a kernel deletes its own file, so anything this old was orphaned by a crash
# or a hard kill.
ORPHAN_CONNECTION_AGE_SECONDS = 3600


def sweep_orphan_connection_files() -> int:
    """Delete our own stale connection files from the temp directory.

    The files carry the kernel's HMAC key, so leaving them behind is a (small) leak
    of a credential. Every graceful path already deletes its own file; this exists
    for the paths that cannot — a SIGKILLed sidecar, a host crash, a CI job torn
    down mid-run, which is where the 45 files the v7 review found came from.

    Deliberately narrow: only files matching our own name prefix, only in the
    interpreter's temp directory, only when older than an hour, and never fatal —
    a sweep that fails must not stop kernels from working.
    """
    removed = 0
    try:
        temp_dir = tempfile.gettempdir()
        if not os.path.isdir(temp_dir):
            return 0
        cutoff = time.time() - ORPHAN_CONNECTION_AGE_SECONDS
        for name in os.listdir(temp_dir):
            if not (name.startswith(CONNECTION_PREFIX) and name.endswith(".json")):
                continue
            candidate = os.path.join(temp_dir, name)
            try:
                if os.path.getmtime(candidate) > cutoff:
                    continue
                os.unlink(candidate)
                removed += 1
            except OSError:
                continue
    except Exception as exc:  # pragma: no cover - the sweep must never be fatal
        send_log("warn", f"orphan connection-file sweep failed: {exc}")
        return removed
    if removed:
        send_log("info", f"removed {removed} orphaned connection file(s) from {tempfile.gettempdir()}")
    return removed


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
    with STDOUT_LOCK:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
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

    if status == "ok" and reply_status == "error":
        status = "error"
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
