#!/usr/bin/env bash
# Stages the daemon for packaging: the bundled CLI and web UI plus its production node_modules,
# laid out as <out>/{cli.mjs,web,node_modules,package.json}.
# Usage: scripts/stage-daemon.sh [out]   (default: apps/desktop/.stage/daemon)
# Run `pnpm build` at the repository root first.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/apps/desktop/.stage/daemon}"

if [ ! -f "$root/apps/daemon/dist/cli.mjs" ]; then
  echo "apps/daemon/dist/cli.mjs is missing; run pnpm build at the repository root first." >&2
  exit 1
fi
if [ ! -f "$root/apps/daemon/dist/web/index.html" ]; then
  echo "apps/daemon/dist/web is missing; run pnpm build at the repository root (it builds the web UI first)." >&2
  exit 1
fi

rm -rf "$out"
mkdir -p "$(dirname "$out")"
out="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
# Git Bash on Windows: pnpm (Node) needs C:/… paths, not /c/….
if command -v cygpath >/dev/null 2>&1; then out="$(cygpath -m "$out")"; root="$(cygpath -m "$root")"; fi
# A flat (hoisted) node_modules without symlinks, so it copies cleanly into a package.
(cd "$root" && pnpm --filter @nuonuo/daemon deploy --prod --legacy --config.node-linker=hoisted "$out")
cp -R "$root/apps/daemon/dist/." "$out/"
rm -rf "$out/dist" "$out/src" "$out/tsconfig.json" "$out/tsdown.config.ts" "$out/node_modules/.bin"
echo "staged daemon in $out"
