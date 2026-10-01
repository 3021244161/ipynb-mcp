"""ipynb-mcp sidecar (SPEC §5.8).

Speaks NDJSON over stdio with the Node transport:
  request : {"id": "<uuid>", "op": "<name>", "params": {...}}
  response: {"id": "<uuid>", "ok": true, "result": {...}}
            {"id": "<uuid>", "ok": false, "error": {"code", "message", "detail"}}
  event   : {"event": "kernel_died"|"log", ...}

Hard rules:
  - NEVER reads or writes any file (the only writer of .ipynb files is Node);
    jupyter_client's internal connection files are infrastructure it manages.
  - Only depends on jupyter_client + the standard library.
  - stdout carries protocol frames ONLY; debug output goes to stderr.
"""

from __future__ import annotations

import json
import sys
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
        except Exception:
            pass
        try:
            self.km.shutdown_kernel(now=False)
        except Exception:
            try:
                self.km.shutdown_kernel(now=True)
            except Exception:
                pass


KERNELS: dict[str, KernelEntry] = {}


def send(obj: dict) -> None:
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
        entry.shutdown()
        raise RuntimeError(f"kernel did not become ready: {exc}") from exc
    KERNELS[kernel_id] = entry
    return {"pid": entry.pid(), "kernelSpecName": kernel_spec_name, "language": language}


def op_exec_cell(params: dict) -> dict:
    kernel_id = params["kernelId"]
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
            if interrupt_deadline is None and now >= deadline:
                if not entry.km.is_alive():
                    send_kernel_died(kernel_id)
                    raise RuntimeError("kernel died during execution")
                try:
                    entry.km.interrupt_kernel()
                except Exception as exc:  # interrupt failed on a dead kernel
                    if not entry.km.is_alive():
                        send_kernel_died(kernel_id)
                        raise RuntimeError(f"kernel died during execution: {exc}") from exc
                interrupt_deadline = now + 5.0
                continue
            if interrupt_deadline is not None and now >= interrupt_deadline:
                if not entry.km.is_alive():
                    send_kernel_died(kernel_id)
                    raise RuntimeError("kernel died during execution")
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
    shell_deadline = time.monotonic() + 30
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
    entry = KERNELS.get(params["kernelId"])
    if entry is None:
        raise RuntimeError(f"unknown kernel: {params['kernelId']}")
    entry.km.interrupt_kernel()
    return {"ok": True}


def op_shutdown_kernel(params: dict) -> dict:
    kernel_id = params["kernelId"]
    entry = KERNELS.pop(kernel_id, None)
    if entry is None:
        return {"ok": True}
    entry.shutdown()
    return {"ok": True}


def op_kernel_status(params: dict) -> dict:
    entry = KERNELS.get(params["kernelId"])
    if entry is None:
        return {"alive": False, "executionCount": None, "pid": None}
    return {
        "alive": bool(entry.km.is_alive()),
        "executionCount": entry.execution_count,
        "pid": entry.pid(),
    }


def op_shutdown_all(_params: dict) -> dict:
    for kernel_id in list(KERNELS.keys()):
        entry = KERNELS.pop(kernel_id)
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
    return {"ok": len(failed) == 0, "failed_cell_indexes": failed, "defs": defs, "uses": uses}


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
        send({
            "id": request_id,
            "ok": False,
            "error": {"code": "internal", "message": f"{type(exc).__name__}: {exc}"},
        })


def main() -> int:
    send_log("info", "sidecar ready")
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
        handle_request(request)
    # stdin closed: clean shutdown path (Node normally calls shutdown_all first).
    op_shutdown_all({})
    return 0


if __name__ == "__main__":
    sys.exit(main())
