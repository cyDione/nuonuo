#!/usr/bin/env bash
# Builds the headless Linux package: the daemon (which serves the web UI) with its dependencies
# and its own Node.js runtime, so the target machine needs nothing installed.
# Usage: scripts/package-linux.sh [arch]   (x64 or arm64, default this machine's; native modules come from the build
#        machine, so build each CPU on its own machine)
# Output: dist/nuonuo-<version>-linux-<arch>.tar.gz
# Run `pnpm build` at the repository root first.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
arch="${1:-$(node -p process.arch)}"
version="$(node -p "require('$root/apps/daemon/package.json').version")"
node_version="${NODE_VERSION:-$(node -p 'process.versions.node')}"
name="nuonuo-$version-linux-$arch"
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
cat > "$pkg/bin/nuonuo" <<'SH'
#!/bin/sh
# Nuonuo launcher: runs the bundled daemon with the bundled Node.js.
dir="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
exec "$dir/runtime/node" "$dir/lib/cli.mjs" "$@"
SH
chmod +x "$pkg/bin/nuonuo" "$pkg/runtime/node"
# The installer, so `nuonuo update` still works when GitHub can't serve the newer one.
cp "$root/install.sh" "$pkg/install.sh"

cat > "$pkg/README.txt" <<TXT
Nuonuo $version (Linux $arch, headless: service + web UI)

  ./bin/nuonuo start -d   start the service in the background; prints the login link
                                   (web UI on 127.0.0.1:7420; without -d it runs in this terminal)
  ./bin/nuonuo start -d --host 0.0.0.0 --port 8080
                                   listen on every interface (other devices on the network can log in) and port 8080
  ./bin/nuonuo config --host 0.0.0.0 --port 8080
                                   save the address for every later start (also in the web UI: Settings → System)
  ./bin/nuonuo stop | restart | status
  ./bin/nuonuo token      print the login link again
  ./bin/nuonuo service install   start it at login (systemd user service)
  ./bin/nuonuo update     install the latest release (also in the web UI: Settings → System)

The login link is the password. Listening on the network is plain HTTP: keep it on a trusted network, and put an
HTTPS reverse proxy in front (or use ssh -L 7420:127.0.0.1:7420 <this machine>) for remote access.

Data and API keys live in ~/.nuonuo (override with NUONUO_HOME).
Node.js $node_version is bundled in runtime/; nothing else needs to be installed.
TXT

mkdir -p "$root/dist"
tar -czf "$root/dist/$name.tar.gz" -C "$work" "$name"
rm -rf "$work"
echo "packaged $root/dist/$name.tar.gz"
