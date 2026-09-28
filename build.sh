#!/usr/bin/env bash
# Bundle the ES-module source (js/app.js + its imports) into ONE classic IIFE that the oldest target
# engine can run. Tizen 4.0 (2018 sets) is ~Chromium 56, which predates ES modules (Cr61) — so
# index.html loads js/app.bundle.js (this output), never the raw modules. The same bundle also runs on
# the 2022 Cr85 sets, so there's a single load path, not one-per-engine.
#
# esbuild lowers newer SYNTAX to the target, but does NOT polyfill runtime APIs (padStart, fromEntries,
# flatMap, …). Keep the source within the Cr56 API set by hand; `npm run check:tizen` greps for the
# common offenders. Run this before `tizen build-web`/`package` (the WGT ships whatever is in js/).
set -euo pipefail
cd "$(dirname "$0")"

ESBUILD="../node_modules/.bin/esbuild"
[ -x "$ESBUILD" ] || ESBUILD="npx esbuild"

$ESBUILD js/app.js \
  --bundle \
  --format=iife \
  --target=chrome56 \
  --outfile=js/app.bundle.js \
  "$@"   # pass --watch / --minify through when wanted

echo "→ js/app.bundle.js"
