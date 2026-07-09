#!/usr/bin/env bash
# Until the deployed relay exists, genui-shell's relay-service/ stays the dev
# source of truth (it's verified there against the REAL daemon in
# server/relay-service.itest.ts). This script pulls the shared files into this
# repo; --check only reports drift (nonzero exit) without copying.
#
# Repo-owned here (never synced): package.json, package-lock.json, Dockerfile,
# .gitignore, README.md, DEPLOY.md, test/, scripts/.
set -euo pipefail

SHELL_DIR="${GENUI_SHELL_DIR:-$(dirname "$0")/../../genui-shell}/relay-service"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SYNCED=(src/contract.ts src/limits.ts src/main.ts src/relay.ts tsconfig.json fly.toml .dockerignore)

if [ ! -d "$SHELL_DIR" ]; then
  echo "genui-shell not found at $SHELL_DIR (set GENUI_SHELL_DIR)" >&2
  exit 2
fi

if [ "${1:-}" = "--check" ]; then
  drift=0
  for f in "${SYNCED[@]}"; do
    diff -u "$SHELL_DIR/$f" "$REPO_DIR/$f" || drift=1
  done
  [ "$drift" = 0 ] && echo "in sync with genui-shell/relay-service"
  exit "$drift"
fi

for f in "${SYNCED[@]}"; do
  cp "$SHELL_DIR/$f" "$REPO_DIR/$f"
done
echo "synced ${#SYNCED[@]} files from $SHELL_DIR"
