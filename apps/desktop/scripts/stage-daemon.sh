#!/usr/bin/env bash
# Stages the daemon for packaging: the bundled CLI and web UI plus its production node_modules,
# laid out as resources/daemon/{cli.mjs,web,node_modules} inside the packaged app.
# Run `pnpm build` at the repository root first.
set -euo pipefail
desktop="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$desktop/../.." && pwd)"
out="$desktop/.stage/daemon"

if [ ! -f "$root/apps/daemon/dist/cli.mjs" ]; then
  echo "apps/daemon/dist/cli.mjs is missing; run pnpm build at the repository root first." >&2
  exit 1
fi

rm -rf "$out"
mkdir -p "$(dirname "$out")"
# A flat (hoisted) node_modules without symlinks, so it copies cleanly into the package.
(cd "$root" && pnpm --filter @super-assistant/daemon deploy --prod --legacy --config.node-linker=hoisted "$out")
cp -R "$root/apps/daemon/dist/." "$out/"
rm -rf "$out/dist" "$out/src" "$out/tsconfig.json" "$out/tsdown.config.ts" "$out/node_modules/.bin"
echo "staged daemon in $out"
