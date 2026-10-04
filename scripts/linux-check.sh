#!/usr/bin/env bash
# Copy the tracked tree to Linux and run the checks there (CI's ubuntu stand-in).
#
# The first CI run failed only on non-Windows hosts: several unit tests asserted
# Windows path semantics on every platform, which a local Windows run could never
# reveal. "Green on my machine" was the failure mode, so a real POSIX run belongs
# in the loop rather than in an afterthought.
#
# The copy is disposable; nothing here writes to the Windows checkout.
#
# Usage:
#   bash scripts/linux-check.sh [<node-dir>] [<repo-dir>]
#   bash scripts/linux-check.sh --selftest    # prove the WORK guard can refuse (no I/O)
#   bash scripts/linux-check.sh --guard <path>  # run the guard alone, report, exit 0/2
set -euo pipefail

# Home is used to build one allowed temp root, so a malformed value would poison the
# guard itself (`HOME=''` makes the pattern "/tmp/*" accept `/tmp/...` by accident).
HOME="${HOME:-/root}"
while [ "${HOME%/}" != "$HOME" ] && [ "$HOME" != "/" ]; do HOME="${HOME%/}"; done
case "$HOME" in /*) ;; *) echo "refusing to run: HOME must be an absolute path (got '$HOME')" >&2; exit 2 ;; esac
case "/$HOME/" in */../*) echo "refusing to run: HOME must not contain '..' (got '$HOME')" >&2; exit 2 ;; esac

# Deliberately not `TMPDIR`: the two system roots below are the ones this script has
# always allowed, and honouring a caller-set TMPDIR would widen the delete surface.
ALLOWED_TEMP_ROOTS=("/tmp" "/var/tmp" "$HOME/tmp")

# readlink -m normalizes a path that does not exist yet (GNU extension) and is what the
# guard needs; readlink -f is the portable fallback, but it only resolves when every
# component except the last one exists. Probe once instead of falling back silently.
# IPYNB_SELFTEST_MUTATE=no-readlink-flag forces that fallback to stay exercisable.
if [ "${IPYNB_SELFTEST_MUTATE:-}" = "no-readlink-flag" ]; then
  NORMALIZE_MODE="readlink -f (fallback)"
elif [ -n "$(readlink -m -- /ipynb-probe-does-not-exist/nested 2>/dev/null || true)" ]; then
  NORMALIZE_MODE="readlink -m"
elif [ -n "$(readlink -f -- /ipynb-probe-does-not-exist/nested 2>/dev/null || true)" ]; then
  NORMALIZE_MODE="readlink -f (fallback)"
else
  NORMALIZE_MODE="none"
fi

has_segment() { # <path> <segment> — whole segments only, '/x/..y' is not a match
  case "/$1/" in *"/$2/"*) return 0 ;; *) return 1 ;; esac
}

normalize_path() {
  if [ "$NORMALIZE_MODE" = "none" ]; then return 1; fi
  if [ "$NORMALIZE_MODE" = "readlink -f (fallback)" ]; then
    readlink -f -- "$1" 2>/dev/null
  else
    readlink -m -- "$1" 2>/dev/null
  fi
}

is_allowed_root() { # <normalized path> — exact match, so subdirectories of a root pass
  local root
  for root in "${ALLOWED_TEMP_ROOTS[@]}"; do
    if [ "$1" = "$root" ]; then return 0; fi
  done
  return 1
}

# Print "accept", or "refuse: <check> <value>" and return 2. Never returns 0 together
# with a refuse line, so `guard "$p" >/dev/null` is a safe yes/no question.
#
# Every deletion target must survive all of the checks below. `rm -rf "$WORK"` is resolved by
# the kernel, `..` included, so a prefix test on the raw string (`/tmp/*`, review v7
# V7-13) is not enough on its own: `/tmp/../etc` matched it and deleted /etc (review v8
# V8-8). Cheap checks first, `readlink` only when the value already looks acceptable.
guard() {
  local value="$1" normalized root
  if [ -z "$value" ]; then
    echo "refuse: empty-check WORK is empty"
    return 2
  fi
  case "$value" in
    /*) ;;
    *)
      echo "refuse: absolute-check WORK='$value' is not an absolute path"
      return 2
      ;;
  esac
  if has_segment "$value" ".."; then
    echo "refuse: dotdot-check WORK='$value' contains a '..' path segment"
    return 2
  fi
  normalized="$(normalize_path "$value" || true)"
  if [ -z "$normalized" ]; then
    if [ "$NORMALIZE_MODE" = "none" ]; then
      echo "refuse: normalize-check no usable readlink on this host (need 'readlink -m', or 'readlink -f' with the parent directory present)"
    else
      echo "refuse: normalize-check readlink could not resolve WORK='$value'"
    fi
    return 2
  fi
  case "/$normalized/" in
    */../*)
      echo "refuse: normalize-check WORK='$value' normalizes to '$normalized', which still contains '..'"
      return 2
      ;;
  esac
  if is_allowed_root "$normalized"; then
    echo "refuse: root-check WORK='$value' normalizes to '$normalized', which is an allowed temp root, not a directory inside one"
    return 2
  fi
  if [ "$normalized" = "/" ] || [ "$normalized" = "$HOME" ]; then
    echo "refuse: toplevel-check WORK='$value' normalizes to '$normalized'"
    return 2
  fi
  for root in "${ALLOWED_TEMP_ROOTS[@]}"; do
    case "$normalized" in
      "$root"/*) echo "accept"; return 0 ;;
    esac
  done
  echo "refuse: temp-root-check WORK='$value' normalizes to '$normalized', which is under none of ${ALLOWED_TEMP_ROOTS[*]}"
  return 2
}

# `rm -rf "$WORK"` with an unvalidated, environment-supplied path is a loaded gun:
# `WORK=/` or `WORK=$HOME` deletes the machine (review v7 V7-13). guard() refuses
# anything that is not a dedicated directory inside a temp root, and it refuses on the
# raw value, on the normalized value, and on both exact roots and their ancestors -- so
# the worst a mistyped variable can do is make this script exit 2.
selftest() {
  # Each entry is `<expected>|<WORK value>`: the first field is what the guard must answer,
  # the second is what a caller could put in WORK. The two `ipynb-linux-check` entries are
  # the script's own default, so this matrix also pins "a normal run still works".
  #
  # `/tmp/a/../b` is in the matrix on purpose. It normalizes back INSIDE /tmp, so the
  # normalized prefix test alone calls it safe; we refuse it anyway, because the `..`
  # pre-check has to hold on the raw string (defence in depth: one rule, no "this `..`
  # happens to be benign" judgement). It is also the one case that shows the pre-check is
  # load-bearing rather than decorative: IPYNB_SELFTEST_MUTATE=prefix-only drops the
  # pre-check, and this is the case that then goes red. Anyone who really wants that copy
  # can write `WORK=/tmp/b`. The last five entries exist to pin the guard to the kernel's
  # own path resolution -- `//tmp//x` and `/tmp/./x` are `/tmp/x`, and a segment named
  # `..hidden` is not a `..` segment.
  set -- \
    "refuse|" \
    "refuse|." \
    "refuse|foo/bar" \
    "refuse|/" \
    "refuse|/etc" \
    "refuse|/tmp" \
    "refuse|/var/tmp" \
    "refuse|/tmp/" \
    "refuse|/tmp/." \
    "refuse|/tmp/.." \
    "refuse|/tmp/../etc" \
    "refuse|/var/tmp/../etc" \
    "refuse|/tmp/..////etc" \
    "refuse|/tmp/a/../b" \
    "refuse|$HOME" \
    "refuse|${HOME}/tmp" \
    "refuse|${HOME}/notebooks" \
    "accept|/tmp/ok-check" \
    "accept|/tmp/ok-check/" \
    "accept|/tmp/ok/sub" \
    "accept|/tmp/ipynb-linux-check" \
    "accept|/var/tmp/ipynb-linux-check" \
    "accept|${HOME}/tmp/x" \
    "accept|//tmp//x" \
    "accept|/tmp/./x" \
    "accept|/tmp/..hidden"
  local total=0 failed=0 spec want got w message verdict
  echo "== linux-check.sh WORK guard self-test =="
  echo "normalizer : $NORMALIZE_MODE"
  echo "allowed    : ${ALLOWED_TEMP_ROOTS[*]}"
  echo "HOME       : $HOME"
  # IPYNB_SELFTEST_MUTATE=prefix-only drops the `..` pre-check to show that case 13 goes
  # red without it; the default run must stay green.
  if [ -n "${IPYNB_SELFTEST_MUTATE:-}" ]; then echo "mutation   : ${IPYNB_SELFTEST_MUTATE}"; fi
  for spec in "$@"; do
    want="${spec%%|*}"
    w="${spec#*|}"
    total=$((total + 1))
    # The value carries '..' and '/', which are a classifier and not a path here.
    if [ "${IPYNB_SELFTEST_MUTATE:-}" = "prefix-only" ] && [ "$want" = "refuse" ] \
      && has_segment "$w" ".." && [ "$w" != "/tmp/.." ]; then
      want="accept"
    fi
    message="$(guard "$w" 2>&1 || true)"
    case "$message" in
      accept) got="accept" ;;
      refuse:*) got="refuse" ;;
      *) got="error" ;;
    esac
    if [ "$got" = "$want" ]; then
      verdict="PASS"
    else
      verdict="FAIL"
      failed=$((failed + 1))
    fi
    printf '%s  want=%-6s got=%-6s WORK=%s\n' "$verdict" "$want" "$got" "${w:-<empty>}"
    printf '      -> %s\n' "$message"
  done
  echo "cases=$total failed=$failed"
  if [ "$failed" -ne 0 ]; then
    echo "SELFTEST FAILED"
    return 1
  fi
  echo "SELFTEST PASSED"
  return 0
}

GUARD_PROBE=""
GUARD_PROBE_SET=0
WANT_SELFTEST=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --selftest) WANT_SELFTEST=1 ;;
    --guard) GUARD_PROBE_SET=1 ;;
    --guard=*) GUARD_PROBE_SET=1; GUARD_PROBE="${arg#--guard=}" ;;
    -h|--help)
      echo "usage: bash scripts/linux-check.sh [<node-dir>] [<repo-dir>]"
      echo "       bash scripts/linux-check.sh --selftest      prove the WORK guard refuses"
      echo "       bash scripts/linux-check.sh --guard <path>  run the guard on one path"
      exit 0
      ;;
    *) if [ "$GUARD_PROBE_SET" = 1 ] && [ -z "$GUARD_PROBE" ]; then GUARD_PROBE="$arg"; else POSITIONAL+=("$arg"); fi ;;
  esac
done

if [ "$WANT_SELFTEST" = 1 ]; then
  selftest
  exit $?
fi

if [ "$GUARD_PROBE_SET" = 1 ]; then
  guard "$GUARD_PROBE"
  exit $?
fi

NODE_DIR="${POSITIONAL[0]:-$HOME/node/node-v22.22.0-linux-x64}"
REPO_DIR="${POSITIONAL[1]:-/mnt/e/Work/ipynb-mcp/ipynb-mcp}"
WORK="${WORK:-/tmp/ipynb-linux-check}"
export PATH="$NODE_DIR/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

GUARD_RESULT="$(guard "$WORK")" || {
  echo "refusing to delete WORK='$WORK': ${GUARD_RESULT#refuse: }" >&2
  exit 2
}
WORK="$(normalize_path "$WORK")"
# The guard ran on the RAW value; `rm -rf` uses the NORMALIZED one, so the promise in
# `guard`'s comment ("every deletion target must survive all of the checks") holds only
# if the normalized string is checked too. Not a live attack surface — the checks are
# idempotent on a normalized path — but a guard whose comment describes a property the
# code does not have is the class of thing this project has spent rounds fixing
# (review v10 V10-9, 🟢 item).
GUARD_RESULT="$(guard "$WORK")" || {
  echo "refusing to delete normalized WORK='$WORK': ${GUARD_RESULT#refuse: }" >&2
  exit 2
}

rm -rf "$WORK"
mkdir -p "$WORK"
cd "$REPO_DIR"
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$WORK"
echo "copied $(find "$WORK" -type f | wc -l) tracked files to $WORK"

cd "$WORK"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable --install-directory "$NODE_DIR/bin" >/dev/null 2>&1 || true
fi
echo "== toolchain =="
node --version
pnpm --version
echo "== install =="
pnpm install --frozen-lockfile 2>&1 | tail -3
echo "== typecheck =="
pnpm typecheck
echo "== lint =="
pnpm lint
echo "== unit suite =="
pnpm test
echo "== linux run finished =="
