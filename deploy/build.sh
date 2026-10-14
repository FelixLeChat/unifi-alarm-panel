#!/usr/bin/env bash
# Build the app and assemble a runnable standalone/ directory.
#
# Next's `output: "standalone"` traces only the files server.js actually
# needs at runtime — it deliberately excludes public/ and .next/static/
# (normally meant for a CDN), so those have to be copied in by hand. This
# script does that copy; without it, /panel.js, /icon.svg, and the compiled
# CSS all 404.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm install --frozen-lockfile
pnpm build

rm -rf .next/standalone/public .next/standalone/.next/static
cp -r public .next/standalone/public
cp -r .next/static .next/standalone/.next/static

# lib/version.ts reads this at runtime to show the deployed version in the panel/admin UI.
git describe --tags --always --dirty 2>/dev/null > .next/standalone/VERSION || echo "dev" > .next/standalone/VERSION

echo "Built. Run with: node .next/standalone/server.js"
