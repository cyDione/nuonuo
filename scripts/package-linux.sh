#!/usr/bin/env bash
# Builds the headless Linux package: the daemon (which serves the web UI) with its dependencies
# and its own Node.js runtime, so the target machine needs nothing installed.
# Usage: scripts/package-linux.sh [arch]   (arch: x64, default x64; must match the build machine)
# Output: dist/super-assistant-<version>-linux-<arch>.tar.gz
# Run `pnpm build` at the repository root first.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
arch="${1:-x64}"
version="$(node -p "require('$root/apps/daemon/package.json').version")"
node_version="${NODE_VERSION:-$(node -p 'process.versions.node')}"
name="super-assistant-$version-linux-$arch"
work="$root/dist/.work"
pkg="$work/$name"

rm -rf "$work" && mkdir -p "$work"
bash "$root/scripts/stage-daemon.sh" "$pkg/lib"

# Native modules ship prebuilds for every platform; keep only this one's.
find "$pkg/lib/node_modules/better-sqlite3/prebuilds" -type f ! -name "linux-$arch.node" -delete 2>/dev/null || true
rm -rf "$pkg/lib/node_modules/better-sqlite3/build" "$pkg/lib/node_modules/better-sqlite3/deps" "$pkg/lib/node_modules/better-sqlite3/src"

# Node.js runtime, the same version the package was built and tested with.
curl -fsSL "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-$arch.tar.xz" -o "$work/node.tar.xz"
mkdir -p "$pkg/runtime"
tar -xJf "$work/node.tar.xz" -C "$work"
cp "$work/node-v$node_version-linux-$arch/bin/node" "$pkg/runtime/node"
cp "$work/node-v$node_version-linux-$arch/LICENSE" "$pkg/runtime/LICENSE.node"

mkdir -p "$pkg/bin"
cat > "$pkg/bin/super-assistant" <<'SH'
#!/bin/sh
# Super-assistant launcher: runs the bundled daemon with the bundled Node.js.
dir="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
exec "$dir/runtime/node" "$dir/lib/cli.mjs" "$@"
SH
chmod +x "$pkg/bin/super-assistant" "$pkg/runtime/node"
# The installer, so `super-assistant update` still works when GitHub can't serve the newer one.
cp "$root/install.sh" "$pkg/install.sh"

cat > "$pkg/README.txt" <<TXT
Super-assistant $version (Linux $arch, headless: service + web UI)

  ./bin/super-assistant start      start the service; the web UI is served on 127.0.0.1:7420
                                   (prints a login link; add --no-open on a machine without a desktop)
  ./bin/super-assistant token      print the login link again
  ./bin/super-assistant status     check whether the service is running
  ./bin/super-assistant service install   start it at login (systemd user service)
  ./bin/super-assistant update     install the latest release (also in the web UI: Settings → System)

The service only listens on 127.0.0.1. From another computer, forward the port over SSH:
  ssh -L 7420:127.0.0.1:7420 <this machine>
then open the login link in your local browser.

Data and API keys live in ~/.super-assistant (override with SUPER_ASSISTANT_HOME).
Node.js $node_version is bundled in runtime/; nothing else needs to be installed.
TXT

mkdir -p "$root/dist"
tar -czf "$root/dist/$name.tar.gz" -C "$work" "$name"
rm -rf "$work"
echo "packaged $root/dist/$name.tar.gz"
