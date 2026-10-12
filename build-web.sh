#!/usr/bin/env bash
# Build the Bevy page for deployment at / into prebuilt/, which is committed: Vercel's build image has no
# Rust toolchain, so scripts/build-static.mjs copies this folder instead of compiling it. The vehicle models are not
# duplicated here; the Vercel build copies them from bevy/assets/. Rerun after changing the Rust code or index.html.
set -euo pipefail

cd "$(dirname "$0")"
node scripts/build-deck.mjs
cd bevy
export PATH="$HOME/.cargo/bin:$PATH"
command -v trunk >/dev/null || { echo "✗ trunk not found; see the one-time setup in README.md"; exit 1; }

# Trunk expects a boolean even when the caller uses the common NO_COLOR=1 convention.
if [ -n "${NO_COLOR:-}" ]; then export NO_COLOR=true; fi
trunk build --release --public-url / --dist ../prebuilt
rm -rf ../prebuilt/assets
du -sh ../prebuilt/*.wasm
