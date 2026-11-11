#!/usr/bin/env bash
# Installs (or updates) Super-assistant from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/cyDione/super-assistant/main/install.sh | bash
#
# Linux: the headless build (service + web UI).
#   Installs to  ~/.local/share/super-assistant   (SUPER_ASSISTANT_PREFIX to change)
#   Command      ~/.local/bin/super-assistant     (SUPER_ASSISTANT_BIN_DIR to change)
#   CPU          x86_64 (amd64) and aarch64 (arm64)
# macOS: the desktop app, into /Applications (~/Applications when that is not writable; SUPER_ASSISTANT_APP_DIR to
#   change), for Apple silicon and Intel. curl does not mark what it downloads as "from the internet", so Gatekeeper
#   does not stop the first open even while the app has no Developer ID signature.
# Both: latest release, or SUPER_ASSISTANT_VERSION=v0.2.0 to pin.
#
# The repository is public, so nothing needs signing in. GITHUB_TOKEN, if set, is only used to raise the API rate limit.
set -euo pipefail

repo="cyDione/super-assistant"
prefix="${SUPER_ASSISTANT_PREFIX:-$HOME/.local/share/super-assistant}"
bin_dir="${SUPER_ASSISTANT_BIN_DIR:-$HOME/.local/bin}"
version="${SUPER_ASSISTANT_VERSION:-}"

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
asset() { grep -o '"browser_download_url": *"[^"]*/super-assistant-[^"]*-'"$1"'"' "$tmp/release.json" | head -n1 | sed 's/^"browser_download_url": *"\([^"]*\)"$/\1/'; }

if [ "$os" = Darwin ]; then
  app_name="Super-assistant.app"
  asset_url="$(asset "mac-$arch\\.zip")"
  [ -n "$asset_url" ] || die "the release has no mac-$arch app"
  if pgrep -qf "/$app_name/Contents/MacOS/" 2>/dev/null; then
    die "Super-assistant is running; quit it first (menu bar icon → 退出), then run this again"
  fi
  dest="${SUPER_ASSISTANT_APP_DIR:-/Applications}"
  if [ -z "${SUPER_ASSISTANT_APP_DIR:-}" ] && [ ! -w "$dest" ]; then dest="$HOME/Applications"; fi
  say "downloading $(basename "$asset_url")…"
  curl -fSL --progress-bar "$asset_url" -o "$tmp/app.zip" || die "download failed: $asset_url"
  mkdir -p "$tmp/x"
  ditto -x -k "$tmp/app.zip" "$tmp/x" || die "could not unpack $(basename "$asset_url")"
  [ -d "$tmp/x/$app_name" ] || die "the package looks broken (no $app_name)"
  # Swap the app in; the data directory (~/.super-assistant) is never touched.
  mkdir -p "$dest"
  rm -rf "$dest/$app_name.new"
  ditto "$tmp/x/$app_name" "$dest/$app_name.new"
  xattr -dr com.apple.quarantine "$dest/$app_name.new" 2>/dev/null || true
  rm -rf "$dest/$app_name"
  mv "$dest/$app_name.new" "$dest/$app_name"
  say ""
  say "Super-assistant ${version:-$(basename "$asset_url" | sed 's/^super-assistant-\(.*\)-mac-.*$/v\1/')} installed to $dest/$app_name"
  say "open it:  open \"$dest/$app_name\"   (or from Launchpad)"
  say "update later: run this command again"
  exit 0
fi

asset_url="$(asset "linux-$arch\\.tar\\.gz")"
[ -n "$asset_url" ] || die "the release has no linux-$arch package"
say "downloading $(basename "$asset_url")…"
curl -fSL --progress-bar "$asset_url" -o "$tmp/super-assistant-linux-$arch.tar.gz" || die "download failed: $asset_url"

archive="$(ls "$tmp"/super-assistant-*linux-"$arch".tar.gz | head -n1)"
mkdir -p "$tmp/x"
tar -xzf "$archive" -C "$tmp/x"
pkg="$(ls -d "$tmp"/x/super-assistant-*/ | head -n1)"
[ -x "$pkg/bin/super-assistant" ] || die "the package looks broken (no bin/super-assistant)"

# Swap the new version in; the data directory (~/.super-assistant) is never touched.
mkdir -p "$(dirname "$prefix")" "$bin_dir"
rm -rf "$prefix.new" "$prefix.old"
cp -R "$pkg" "$prefix.new"
[ -e "$prefix" ] && mv "$prefix" "$prefix.old"
mv "$prefix.new" "$prefix"
rm -rf "$prefix.old"
ln -sf "$prefix/bin/super-assistant" "$bin_dir/super-assistant"

installed="$("$prefix/bin/super-assistant" --version)"
restart=""
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet super-assistant.service 2>/dev/null; then
  restart=1
fi
say ""
say "Super-assistant $installed installed to $prefix"
say "command: $bin_dir/super-assistant"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) say "note: $bin_dir is not on your PATH; add  export PATH=\"$bin_dir:\$PATH\"  to your shell profile" ;;
esac
say ""
say "start in background:   super-assistant start -d          (prints the login link; web UI on 127.0.0.1:7420)"
say "  on the network:      super-assistant start -d --host 0.0.0.0 --port 7420"
say "  save the address:    super-assistant config --host 0.0.0.0 --port 7420   (or Settings → System)"
say "stop / restart:         super-assistant stop | restart | status"
say "start at login:         super-assistant service install"
say "update later:           super-assistant update   (or Settings → System in the web UI)"

# Restart last, without waiting: when the service itself runs this script (the web UI's update button), stopping the
# service stops this script too, so everything else has to be done by then.
if [ -n "$restart" ]; then
  rm -rf "$tmp"
  say ""
  say "restarting the running service on the new version"
  systemctl --user restart --no-block super-assistant.service || die "could not restart super-assistant.service; run: systemctl --user restart super-assistant.service"
fi
