#!/usr/bin/env bash
# Builds the standalone server package (Linux or macOS): the daemon (with optional --web UI) with its dependencies
# and its own Node.js runtime, so the target machine needs nothing installed.
# Usage: scripts/package-linux.sh [arch] [os]   (arch: x64|arm64; os: linux|darwin, defaults to linux)
# Output: dist/nuonuo-<version>-<os>-<arch>.tar.gz
# Run `pnpm build` at the repository root first.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
arch="${1:-$(node -p process.arch)}"
target_os="${2:-linux}"
version="$(node -p "require('$root/apps/daemon/package.json').version")"
node_version="${NODE_VERSION:-$(node -p 'process.versions.node')}"
name="nuonuo-$version-$target_os-$arch"
work="$root/dist/.work"
pkg="$work/$name"

rm -rf "$work" && mkdir -p "$work"
bash "$root/scripts/stage-daemon.sh" "$pkg/lib"

# Native modules ship prebuilds for every platform; keep only this OS's.
if [ "$target_os" = "darwin" ]; then
  find "$pkg/lib/node_modules/better-sqlite3/prebuilds" -type f ! -name "darwin-*.node" -delete 2>/dev/null || true
else
  find "$pkg/lib/node_modules/better-sqlite3/prebuilds" -type f ! -name "linux-$arch.node" -delete 2>/dev/null || true
fi
rm -rf "$pkg/lib/node_modules/better-sqlite3/build" "$pkg/lib/node_modules/better-sqlite3/deps" "$pkg/lib/node_modules/better-sqlite3/src"

# Node.js runtime, the same version the package was built and tested with.
mkdir -p "$pkg/runtime"
if [ "$target_os" = "darwin" ]; then
  curl -fsSL "https://nodejs.org/dist/v$node_version/node-v$node_version-darwin-$arch.tar.gz" -o "$work/node.tar.gz"
  tar -xzf "$work/node.tar.gz" -C "$work"
  cp "$work/node-v$node_version-darwin-$arch/bin/node" "$pkg/runtime/node"
  cp "$work/node-v$node_version-darwin-$arch/LICENSE" "$pkg/runtime/LICENSE.node"
else
  curl -fsSL "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-$arch.tar.xz" -o "$work/node.tar.xz"
  tar -xJf "$work/node.tar.xz" -C "$work"
  cp "$work/node-v$node_version-linux-$arch/bin/node" "$pkg/runtime/node"
  cp "$work/node-v$node_version-linux-$arch/LICENSE" "$pkg/runtime/LICENSE.node"
fi

mkdir -p "$pkg/bin"
cat > "$pkg/bin/nuonuo" <<'SH'
#!/bin/sh
# Nuonuo launcher: runs the bundled daemon with the bundled Node.js (portable across Linux & macOS).
src="$0"
while [ -L "$src" ]; do
  link="$(readlink "$src")"
  case "$link" in
    /*) src="$link" ;;
    *) src="$(dirname "$src")/$link" ;;
  esac
done
dir="$(cd "$(dirname "$src")/.." && pwd)"
exec "$dir/runtime/node" "$dir/lib/cli.mjs" "$@"
SH
chmod +x "$pkg/bin/nuonuo" "$pkg/runtime/node"
# The installer, so `nuonuo update` still works when GitHub can't serve the newer one.
cp "$root/install.sh" "$pkg/install.sh"

cat > "$pkg/README.txt" <<TXT
Nuonuo $version ($target_os $arch, standalone server: /v1 API + optional --web UI)

  ./bin/nuonuo start -d            start headless API server in the background (127.0.0.1:7420)
  ./bin/nuonuo start -d --web      start server with built-in WebUI enabled
  ./bin/nuonuo start -d --host 0.0.0.0 --port 7420
                                   listen on every interface so other devices can pair
  ./bin/nuonuo pair --admin --qr   generate a one-time pairing code & QR code for desktop/mobile/web clients
  ./bin/nuonuo auth set-password <pass>
                                   set an Owner password (scrypt) for direct password login
  ./bin/nuonuo config --host 0.0.0.0 --port 7420 --web on
                                   persist network & WebUI settings across restarts
  ./bin/nuonuo stop | restart | status | devices | sessions
  ./bin/nuonuo service install     start at login (macOS launchd / Linux systemd user service)
  ./bin/nuonuo update              install the latest server release

Listening on 0.0.0.0 uses plain HTTP: keep it on a trusted LAN or place an HTTPS reverse proxy / Tailscale in front for remote access.

Data and API keys live in ~/.nuonuo (override with NUONUO_HOME).
Node.js $node_version is bundled in runtime/; nothing else needs to be installed.
TXT

mkdir -p "$root/dist"
tar -czf "$root/dist/$name.tar.gz" -C "$work" "$name"
rm -rf "$work"
echo "packaged $root/dist/$name.tar.gz"
