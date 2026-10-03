"""Verify the connection-file sweep: pid liveness, the age fallback, and safety.

Run on Linux to exercise the primary (pid) rule, and on Windows to exercise the
conservative fallback. The expectations differ by what the platform can judge, which
is the point: on Windows a file whose owner cannot be checked must NOT be removed on
age alone, because "an hour old" is not evidence that nothing owns it.
"""
import importlib.util
import os
import sys
import tempfile
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sidecar_path = os.path.join(REPO, "python", "ipynb_sidecar.py")
spec = importlib.util.spec_from_file_location("sc", sidecar_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

temp_dir = tempfile.gettempdir()
own_pid = os.getpid()
# 999999 is above the default pid_max on Linux, so this is a pid that is certainly gone.
files = {
    "live-owner": os.path.join(temp_dir, "ipynb-mcp-k-%d-old.json" % own_pid),
    "dead-owner": os.path.join(temp_dir, "ipynb-mcp-k-999999-old.json"),
    "dead-owner-fresh": os.path.join(temp_dir, "ipynb-mcp-k-999999-fresh.json"),
    "no-pid-old": os.path.join(temp_dir, "ipynb-mcp-nopid-old.json"),
    "foreign": os.path.join(temp_dir, "other-tool-old.json"),
}
OLD = time.time() - 7200
ANCIENT = time.time() - 30 * 24 * 3600
for label, path in files.items():
    with open(path, "w") as handle:
        handle.write("{}")
    if label in ("live-owner", "dead-owner", "foreign"):
        os.utime(path, (OLD, OLD))
    elif label == "no-pid-old":
        os.utime(path, (ANCIENT, ANCIENT))

can_judge_pid = module._owner_is_alive(own_pid) is not None
print("platform can judge pid liveness:", can_judge_pid)
print("live-owner pid judged:", module._owner_is_alive(own_pid))
print("dead-owner pid judged:", module._owner_is_alive(999999))

removed = module.sweep_orphan_connection_files()

expectations = [
    ("live-owner", True, "a live owner's file is never deleted"),
    ("foreign", True, "another tool's file is never deleted"),
    ("dead-owner-fresh", True, "a fresh file is kept"),
    ("no-pid-old", False, "no readable pid and months old: removed"),
    # The one that differs by platform, and the reason the fallback is conservative:
    # where the pid cannot be judged, two hours of age is NOT evidence that nothing
    # owns the file, so it stays.
    ("dead-owner", not can_judge_pid, "orphaned, but only removed where the pid can be judged"),
]

failures = 0
for label, should_exist, why in expectations:
    exists = os.path.exists(files[label])
    ok = exists == should_exist
    failures += 0 if ok else 1
    print(("  ok   " if ok else "  FAIL ") + label.ljust(18) + why)
print("removed:", removed)

for path in files.values():
    if os.path.exists(path):
        os.unlink(path)

sys.exit(1 if failures else 0)
