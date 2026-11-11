#!/usr/bin/env bash
# Installs (or updates) Nuonuo from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash
#
# Linux: the headless build (service + web UI).
#   Installs to  ~/.local/share/nuonuo   (NUONUO_PREFIX to change)
#   Command      ~/.local/bin/nuonuo     (NUONUO_BIN_DIR to change)
#   CPU          x86_64 (amd64) and aarch64 (arm64)
# macOS: the desktop app, into /Applications (~/Applications when that is not writable; NUONUO_APP_DIR to
#   change), for Apple silicon and Intel. curl does not mark what it downloads as "from the internet", so Gatekeeper
#   does not stop the first open even while the app has no Developer ID signature.
# Both: latest release, or NUONUO_VERSION=v0.2.0 to pin.
#
# The repository is public, so nothing needs signing in. GITHUB_TOKEN, if set, is only used to raise the API rate limit.
#
# The project was called super-assistant up to v0.2.4. Updating such an install moves it to the new names: the app,
# the command, the folder and the systemd unit. The service moves the data directory (~/.super-assistant) itself.
set -euo pipefail

repo="cyDione/nuonuo"
# SUPER_ASSISTANT_VERSION: an older version's updater runs this script with it.
version="${NUONUO_VERSION:-${SUPER_ASSISTANT_VERSION:-}}"
prefix="${NUONUO_PREFIX:-$HOME/.local/share/nuonuo}"
bin_dir="${NUONUO_BIN_DIR:-$HOME/.local/bin}"
legacy_prefix="$HOME/.local/share/super-assistant"
legacy_unit="$HOME/.config/systemd/user/super-assistant.service"

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

os="$(uname -s)"
case "$os" in
  Linux) ;;
  Darwin) ;;
  *) die "this installer is for Linux and macOS; the Windows desktop app is on https://github.com/$repo/releases" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "unsupported CPU $(uname -m); x86_64 and aarch64 builds are published" ;;
esac
# A shell running under Rosetta reports x86_64 on Apple silicon; install the native app anyway.
if [ "$os" = Darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
command -v curl >/dev/null || die "curl is required"
[ "$os" = Darwin ] || command -v tar >/dev/null || die "tar is required"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Which release: the pinned tag, or the latest one (read from the API, which also lists the file names).
auth=()
[ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
api="https://api.github.com/repos/$repo/releases/${version:+tags/$version}"
[ -n "$version" ] || api="${api}latest"
say "looking up ${version:-the latest release}…"
curl -fsSL ${auth[@]+"${auth[@]}"} -H "Accept: application/vnd.github+json" "$api" -o "$tmp/release.json" \
  || die "could not read the release from GitHub (${version:-latest}); check your network, or try again later if the API rate limit was hit"
asset() { grep -o '"browser_download_url": *"[^"]*/nuonuo-[^"]*-'"$1"'"' "$tmp/release.json" | head -n1 | sed 's/^"browser_download_url": *"\([^"]*\)"$/\1/'; }

if [ "$os" = Darwin ]; then
  app_name="Nuonuo.app"
  legacy_app="Super-assistant.app"
  asset_url="$(asset "mac-$arch\\.zip")"
  [ -n "$asset_url" ] || die "the release has no mac-$arch app"
  if pgrep -qf "/$app_name/Contents/MacOS/" 2>/dev/null || pgrep -qf "/$legacy_app/Contents/MacOS/" 2>/dev/null; then
    die "Nuonuo is running; quit it first (menu bar icon → 退出), then run this again"
  fi
  dest="${NUONUO_APP_DIR:-/Applications}"
  if [ -z "${NUONUO_APP_DIR:-}" ] && [ ! -w "$dest" ]; then dest="$HOME/Applications"; fi
  say "downloading $(basename "$asset_url")…"
  curl -fSL --progress-bar "$asset_url" -o "$tmp/app.zip" || die "download failed: $asset_url"
  mkdir -p "$tmp/x"
  ditto -x -k "$tmp/app.zip" "$tmp/x" || die "could not unpack $(basename "$asset_url")"
  [ -d "$tmp/x/$app_name" ] || die "the package looks broken (no $app_name)"
  # Swap the app in; the data directory (~/.nuonuo) is never touched.
  mkdir -p "$dest"
  rm -rf "$dest/$app_name.new"
  ditto "$tmp/x/$app_name" "$dest/$app_name.new"
  xattr -dr com.apple.quarantine "$dest/$app_name.new" 2>/dev/null || true
  rm -rf "$dest/$app_name"
  mv "$dest/$app_name.new" "$dest/$app_name"
  # The same app under its name from before the rename.
  for dir in "$dest" /Applications "$HOME/Applications"; do
    if [ -d "$dir/$legacy_app" ]; then rm -rf "$dir/$legacy_app" && say "removed the old $dir/$legacy_app"; fi
  done
  say ""
  say "Nuonuo ${version:-$(basename "$asset_url" | sed 's/^nuonuo-\(.*\)-mac-.*$/v\1/')} installed to $dest/$app_name"
  say "open it:  open \"$dest/$app_name\"   (or from Launchpad)"
  say "update later: run this command again"
  exit 0
fi

asset_url="$(asset "linux-$arch\\.tar\\.gz")"
[ -n "$asset_url" ] || die "the release has no linux-$arch package"
say "downloading $(basename "$asset_url")…"
curl -fSL --progress-bar "$asset_url" -o "$tmp/nuonuo-linux-$arch.tar.gz" || die "download failed: $asset_url"

archive="$(ls "$tmp"/nuonuo-*linux-"$arch".tar.gz | head -n1)"
mkdir -p "$tmp/x"
tar -xzf "$archive" -C "$tmp/x"
pkg="$(ls -d "$tmp"/x/nuonuo-*/ | head -n1)"
[ -x "$pkg/bin/nuonuo" ] || die "the package looks broken (no bin/nuonuo)"

# Swap the new version in; the data directory (~/.nuonuo) is never touched.
mkdir -p "$(dirname "$prefix")" "$bin_dir"
rm -rf "$prefix.new" "$prefix.old"
cp -R "$pkg" "$prefix.new"
[ -e "$prefix" ] && mv "$prefix" "$prefix.old"
mv "$prefix.new" "$prefix"
rm -rf "$prefix.old"
ln -sf "$prefix/bin/nuonuo" "$bin_dir/nuonuo"

# An install from before the rename: the old folder becomes a link to the new one, so that a service still running from
# it (its unit, its own restart after an update) starts the new version; the old command goes away.
if [ "$prefix" != "$legacy_prefix" ] && [ -d "$legacy_prefix" ] && [ ! -L "$legacy_prefix" ]; then
  rm -rf "$legacy_prefix" && ln -s "$prefix" "$legacy_prefix"
  say "moved $legacy_prefix to $prefix"
fi
if [ -L "$bin_dir/super-assistant" ] || [ -f "$bin_dir/super-assistant" ]; then rm -f "$bin_dir/super-assistant"; say "the command is now: nuonuo"; fi

installed="$("$prefix/bin/nuonuo" --version)"
restart=""
legacy_service=""
if command -v systemctl >/dev/null 2>&1; then
  if [ -f "$legacy_unit" ]; then legacy_service=1
  elif systemctl --user is-active --quiet nuonuo.service 2>/dev/null; then restart=1
  fi
fi
say ""
say "Nuonuo $installed installed to $prefix"
say "command: $bin_dir/nuonuo"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) say "note: $bin_dir is not on your PATH; add  export PATH=\"$bin_dir:\$PATH\"  to your shell profile" ;;
esac
say ""
say "start in background:   nuonuo start -d          (prints the login link; web UI on 127.0.0.1:7420)"
say "  on the network:      nuonuo start -d --host 0.0.0.0 --port 7420"
say "  save the address:    nuonuo config --host 0.0.0.0 --port 7420   (or Settings → System)"
say "stop / restart:         nuonuo stop | restart | status"
say "start at login:         nuonuo service install"
say "update later:           nuonuo update   (or Settings → System in the web UI)"

# Restart last, without waiting: when the service itself runs this script (the web UI's update button), stopping the
# service stops this script too, so everything else has to be done by then.
if [ -n "$legacy_service" ]; then
  # super-assistant.service → nuonuo.service: the new unit conflicts with the old one, so systemd stops it and starts
  # the new one in a single step.
  rm -rf "$tmp"
  say ""
  say "replacing super-assistant.service with nuonuo.service"
  "$prefix/bin/nuonuo" service install || die "could not install nuonuo.service; run: nuonuo service install"
elif [ -n "$restart" ]; then
  rm -rf "$tmp"
  say ""
  say "restarting the running service on the new version"
  systemctl --user restart --no-block nuonuo.service || die "could not restart nuonuo.service; run: systemctl --user restart nuonuo.service"
fi
