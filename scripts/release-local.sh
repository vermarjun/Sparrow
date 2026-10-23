#!/bin/sh
# Build the complete release without publishing anything.
set -eu
cd "$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
command -v bun >/dev/null 2>&1 || { echo 'Bun is required to build releases.' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo 'npm is required to pack releases.' >&2; exit 1; }
bun install --frozen-lockfile
(cd web && bun install --frozen-lockfile && bun run build)
bun scripts/build-binary.ts --target all --outdir dist/bin
mkdir -p dist/npm-pack
# Explicit names keep unrelated files out of the manifest.
(
  cd dist/bin
  for binary in sparrow-darwin-arm64 sparrow-darwin-x64 sparrow-linux-x64 sparrow-linux-arm64; do
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$binary"
    else
      shasum -a 256 "$binary"
    fi
  done
) > dist/checksums.txt
bun scripts/build-npm.ts
for package in sparrow-agents-darwin-arm64 sparrow-agents-darwin-x64 sparrow-agents-linux-x64 sparrow-agents-linux-arm64 sparrow-agents; do
  npm pack "./dist/npm/$package" --pack-destination ./dist/npm-pack
done
bun scripts/brew-formula.ts
if command -v ruby >/dev/null 2>&1; then
  ruby -c dist/brew/Formula/sparrow.rb
fi
printf 'Release ready in dist/: bin/, checksums.txt, npm/, npm-pack/, brew/Formula/sparrow.rb\n'
