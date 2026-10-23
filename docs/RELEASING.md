# Releasing Sparrow

Sparrow ships raw standalone binaries for macOS and Linux, on arm64 and x64. Users need tmux and an authenticated supported coding harness. They do not need Bun for a binary install. Windows users should install inside WSL.

## One-time setup

- Create an npm account and reserve `sparrow-agents` and `sparrow-agents-{darwin,linux}-{arm64,x64}` (four platform packages). All five packages must be publishable by the token owner.
- Create a granular npm access token with write access to those packages. If npm requires two-factor authentication, configure the token's permitted automation/bypass settings. Store it as the repository Actions secret `NPM_TOKEN`. Refresh it before expiry.
- Allow GitHub Actions to create releases with the workflow's `contents: write` permission. `GITHUB_TOKEN` is supplied automatically; no personal GitHub token is required.
- Create the public repository `vermarjun/homebrew-tap`. The workflow generates and uploads the formula; it does not push to the tap. Copy `sparrow.rb` from the release into the tap's `Formula/sparrow.rb`, review, and commit it there. Users can then run `brew install vermarjun/tap/sparrow`.

## Local dry run

Install Bun, Node/npm, and tmux. From the source root run:

```sh
bun run release:local
```

This installs locked development dependencies, builds the web UI, compiles all four binaries, writes `dist/checksums.txt`, generates five publishable packages under `dist/npm/`, packs tarballs into `dist/npm-pack/`, and generates `dist/brew/Formula/sparrow.rb`. Re-running replaces the artifacts for the current version. Old versions' tarballs may remain in `dist/npm-pack/`; publish only the version being released.

The binary build contract is:

```sh
bun scripts/build-binary.ts --target all --outdir dist/bin
# Or --target bun-darwin-arm64 (also bun-darwin-x64/bun-linux-x64/bun-linux-arm64)
bun scripts/build-npm.ts
bun scripts/brew-formula.ts
```

Both generators accept `SPARROW_BIN_DIR` for an alternate input directory. The formula generator checks those binaries against `dist/checksums.txt`.

Test the native npm packages without touching the global prefix (replace the platform and version):

```sh
prefix=$(mktemp -d)
npm install -g --prefix "$prefix" \
  ./dist/npm-pack/sparrow-agents-darwin-arm64-0.1.0.tgz \
  ./dist/npm-pack/sparrow-agents-0.1.0.tgz
"$prefix/bin/sparrow" --version
```

Only install the matching platform tarball locally: npm rejects other platforms' explicit packages. The wrapper uses optional dependencies for platform selection with npm, npx, bunx, and pnpm. Do not disable optional dependencies. `SPARROW_BINARY_PATH=/absolute/path/to/sparrow` overrides resolution.

Test the installer against local assets with curl's `file://` support:

```sh
prefix=$(mktemp -d)
SPARROW_DOWNLOAD_URL="file://$PWD/dist/bin" SPARROW_INSTALL_DIR="$prefix" sh install.sh
```

First copy `dist/checksums.txt` into `dist/bin/checksums.txt` for that test. `SPARROW_DOWNLOAD_URL` replaces the entire asset directory URL. The installer verifies checksums before atomically replacing the executable. A failed verification preserves an existing installation. For a specific published version use `SPARROW_VERSION=0.1.0`; without it the installer uses the latest release.

## Smoke test

`bun run smoke:binary` (or `bun scripts/smoke-binary.ts <binary>`) copies a compiled binary outside the checkout and runs it with its own HOME, `SPARROW_HOME`, free port and tmux socket (never `~/.sparrow`, port 4040 or your tmux server). It needs tmux and takes about 30 seconds. CI runs it on the host binary on both ubuntu and macOS, and the release workflow runs it on darwin-arm64 before anything is published. Run `bun run build:binary:all` to compile all four targets (cross-compiling downloads Bun's runtime for each target once).

## Artifact sizes (0.1.0)

Bun's compiled binaries embed the Bun runtime, so they are large; compression helps a lot. `--minify` and `--bytecode` were tried on darwin-arm64: the binary stayed 62 MB (the runtime dominates, not the bundled JS), so the build uses neither.

| Platform | Binary (GitHub Release asset) | npm tarball (`sparrow-agents-<platform>`) |
| --- | --- | --- |
| darwin-arm64 | 62 MB | 23 MB |
| darwin-x64 | 67 MB | 25 MB |
| linux-arm64 | 102 MB | 39 MB |
| linux-x64 | 104 MB | 39 MB |
| `sparrow-agents` (launcher) | | 1.9 kB |

The largest tarball is 39 MB. I could not verify npm's current registry size limit from here (it is not stated in npm's public docs and has been reported in the low hundreds of MB), so the first publish is the real test; the packages are far smaller than the packages that are known to publish fine (e.g. esbuild/biome platform packages are 10–30 MB). GitHub release assets may be up to 2 GB each. A user installs only the one platform package matching their machine.

## Cut a release

1. Bump root `package.json` version, update release notes, and review changes. Keep the dev package private. Run the CI checks and the local dry run. Run `bun run smoke:binary` on the native binary before publishing.
2. Commit the version change, tag it `vX.Y.Z`, and push the commit and tag to `vermarjun/Sparrow`.
3. The release workflow rejects tags that differ from `package.json`. It builds on macOS so the binary builder can ad-hoc sign the Darwin executables. It builds the web UI and all four binaries, generates checksums and packages, runs `scripts/smoke-binary.ts` on the darwin-arm64 binary (first run, UI, fake-agent hire to done, hooks through the binary, sandbox, upgrade path) and stops there if it fails, then creates the GitHub Release with generated notes, and only then publishes the four platform packages followed by the wrapper to npm (`--access public`). The Release comes before npm because npm versions are immutable while `install.sh` and Homebrew read the Release assets.
4. Review the release assets and copy the generated formula into `vermarjun/homebrew-tap/Formula/sparrow.rb`. Verify `brew install vermarjun/tap/sparrow` and `sparrow --version` on a supported host.

Release assets are named exactly `sparrow-darwin-arm64`, `sparrow-darwin-x64`, `sparrow-linux-x64`, `sparrow-linux-arm64`, and `checksums.txt`; the formula `sparrow.rb` is also attached. Checksums use `<sha256>  <filename>` with no directory prefix. The installer and formula use `https://github.com/vermarjun/Sparrow/releases/download/vX.Y.Z/<asset>`.

npm versions are immutable. If publication stops partway through, inspect which packages exist before manually publishing only the missing packages; an unmodified rerun will fail on already published versions. Do not retag a published version; fix it in a new release. The workflow cannot be exercised locally, so inspect Actions logs and all registry/release outputs on the first release.

Darwin binaries are ad-hoc signed by the binary builder on macOS. Browser-downloaded applications may require Developer ID signing and notarization, which this release process does not provide. CLI downloads through curl, Homebrew, and npm are the supported distribution paths.
