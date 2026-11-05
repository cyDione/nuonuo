#!/usr/bin/env bash
# Installs (or updates) the headless Linux build of Super-assistant from GitHub Releases.
#
#   Installs to  ~/.local/share/super-assistant   (SUPER_ASSISTANT_PREFIX to change)
#   Command      ~/.local/bin/super-assistant     (SUPER_ASSISTANT_BIN_DIR to change)
#   Version      latest release                   (SUPER_ASSISTANT_VERSION=v0.1.0 to pin)
#
# The repository is private, so downloads need GitHub access: either the gh CLI signed in
# (`gh auth login`), or a token with read access to the repository in GITHUB_TOKEN.
set -euo pipefail

repo="cyDione/super-assistant"
prefix="${SUPER_ASSISTANT_PREFIX:-$HOME/.local/share/super-assistant}"
bin_dir="${SUPER_ASSISTANT_BIN_DIR:-$HOME/.local/bin}"
version="${SUPER_ASSISTANT_VERSION:-}"

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

[ "$(uname -s)" = Linux ] || die "this installer is for Linux only"
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  *) die "unsupported CPU $(uname -m); only x86_64 builds are published" ;;
esac
command -v tar >/dev/null || die "tar is required"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pattern="super-assistant-*-linux-$arch.tar.gz"

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  say "downloading ${version:-the latest release} with gh…"
  gh release download ${version:+"$version"} -R "$repo" --pattern "$pattern" --dir "$tmp"
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  command -v curl >/dev/null || die "curl is required"
  api="https://api.github.com/repos/$repo/releases/${version:+tags/$version}"
  [ -n "$version" ] || api="${api}latest"
  say "downloading ${version:-the latest release}…"
  curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "$api" -o "$tmp/release.json" \
    || die "could not read the release from GitHub; check that GITHUB_TOKEN can read $repo and that a release exists"
  # The asset's API url (not browser_download_url) works for private repositories.
  asset_url="$(tr -d '\n' < "$tmp/release.json" | grep -o '"url": *"[^"]*/releases/assets/[0-9]*"[^}]*"name": *"super-assistant-[^"]*-linux-'"$arch"'\.tar\.gz"' | head -n1 | sed 's/^"url": *"\([^"]*\)".*/\1/')"
  [ -n "$asset_url" ] || die "the release has no linux-$arch package"
  curl -fSL --progress-bar -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/octet-stream" "$asset_url" -o "$tmp/super-assistant-linux-$arch.tar.gz"
else
  die "no GitHub access: sign in with 'gh auth login', or set GITHUB_TOKEN to a token that can read $repo"
fi

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
restarted=""
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet super-assistant.service 2>/dev/null; then
  systemctl --user restart super-assistant.service && restarted=1
fi
say ""
say "Super-assistant $installed installed to $prefix"
say "command: $bin_dir/super-assistant"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) say "note: $bin_dir is not on your PATH; add  export PATH=\"$bin_dir:\$PATH\"  to your shell profile" ;;
esac
[ -n "$restarted" ] && say "the running service was restarted on the new version"
say ""
say "start it:            super-assistant start --no-open   (prints the login link; web UI on 127.0.0.1:7420)"
say "start at login:      super-assistant service install"
say "from another machine: ssh -L 7420:127.0.0.1:7420 <this host>, then open the login link locally"
