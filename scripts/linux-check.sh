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
# Usage: bash scripts/linux-check.sh [<node-dir>] [<repo-dir>]
set -euo pipefail

NODE_DIR="${1:-$HOME/node/node-v22.22.0-linux-x64}"
REPO_DIR="${2:-/mnt/e/Work/ipynb-mcp/ipynb-mcp}"
WORK="${WORK:-/tmp/ipynb-linux-check}"
export PATH="$NODE_DIR/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

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
