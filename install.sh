#!/bin/sh
# Install Sparrow from its GitHub Release assets. No Bun or Node required.
set -eu
fail() { printf 'sparrow: %s\n' "$*" >&2; exit 1; }
case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW*|MSYS*|CYGWIN*|Windows*) fail 'Windows is supported through WSL. Run this installer inside WSL.' ;;
  *) fail 'Unsupported OS. Sparrow supports macOS and Linux; use WSL on Windows.' ;;
esac
case $(uname -m) in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail "Unsupported architecture: $(uname -m)" ;;
esac
asset=sparrow-$os-$arch
version=${SPARROW_VERSION:-}
if [ -n "$version" ]; then
  version=${version#v}
  case $version in *[!0-9A-Za-z.+-]*|'') fail 'Invalid SPARROW_VERSION' ;; esac
  base=https://github.com/vermarjun/Sparrow/releases/download/v$version
else
  base=https://github.com/vermarjun/Sparrow/releases/latest/download
fi
# This override is the exact directory containing binaries and checksums.txt.
base=${SPARROW_DOWNLOAD_URL:-$base}
base=${base%/}
install_dir=${SPARROW_INSTALL_DIR:-$HOME/.local/bin}
work=$(mktemp -d)
staged=
cleanup() {
  [ -z "$staged" ] || rm -f "$staged"
  rm -f "$work/checksums.txt" "$work/$asset"
  rmdir "$work"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fLsS "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail 'Install curl or wget first.'
  fi
}
printf 'Downloading %s...\n' "$asset"
download "$base/checksums.txt" "$work/checksums.txt"
download "$base/$asset" "$work/$asset"
expected=$(awk -v name="$asset" '$2 == name { print $1; count++ } END { if (count != 1) exit 1 }' "$work/checksums.txt") || fail "Missing or duplicate checksum for $asset"
case $expected in *[!a-fA-F0-9]*|'') fail 'Invalid checksum' ;; esac
[ ${#expected} -eq 64 ] || fail 'Invalid checksum length'
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$work/$asset" | awk '{print $1}')
else
  fail 'Install sha256sum or shasum to verify the download.'
fi
[ "$actual" = "$expected" ] || fail "Checksum verification failed for $asset"
printf 'Checksum verified.\n'
mkdir -p "$install_dir"
staged=$(mktemp "$install_dir/.sparrow.XXXXXX")
cp "$work/$asset" "$staged"
chmod 755 "$staged"
if [ "$os" = darwin ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$staged" 2>/dev/null || :
fi
mv -f "$staged" "$install_dir/sparrow"
staged=
printf 'Installed Sparrow to %s/sparrow\n' "$install_dir"
case :$PATH: in
  *:"$install_dir":*) ;;
  *)
    printf 'Add Sparrow to your PATH (%s):\n' "${SHELL:-your shell}"
    # Single-quote the path so shell metacharacters stay literal.
    quoted_dir=$(printf '%s' "$install_dir" | sed "s/'/'\\\\''/g")
    case ${SHELL:-} in
      */fish) printf "  fish_add_path '%s'\n" "$quoted_dir" ;;
      *) printf "  export PATH='%s':\"\$PATH\"\n" "$quoted_dir" ;;
    esac
    ;;
esac
if ! command -v tmux >/dev/null 2>&1; then
  printf 'Sparrow needs tmux. Install it with:\n'
  if [ "$os" = darwin ]; then
    printf '  brew install tmux\n'
  elif command -v apt-get >/dev/null 2>&1; then
    printf '  sudo apt-get update && sudo apt-get install -y tmux\n'
  elif command -v dnf >/dev/null 2>&1; then
    printf '  sudo dnf install tmux\n'
  elif command -v pacman >/dev/null 2>&1; then
    printf '  sudo pacman -S tmux\n'
  elif command -v apk >/dev/null 2>&1; then
    printf '  sudo apk add tmux\n'
  else
    printf '  Install tmux with your system package manager.\n'
  fi
fi
printf 'Run sparrow to get started.\n'
