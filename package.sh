#!/usr/bin/env bash
# Bundle, stage and sign the Samsung TV package.
#   ./package.sh <certificate-profile>      → MytView.wgt (signed with your Tizen Studio profile)
# Needs Tizen Studio's `tizen` CLI on PATH (the full SDK one, normally ~/tizen-studio/tools/ide/bin)
# and a certificate profile that includes YOUR TV's DUID (see README.md, "Certificates").
set -euo pipefail
cd "$(dirname "$0")"
profile="${1:-}"
[ -n "$profile" ] || { echo "usage: ./package.sh <certificate-profile>" >&2; exit 1; }
command -v tizen >/dev/null || { echo "tizen CLI not found: add ~/tizen-studio/tools/ide/bin to PATH" >&2; exit 1; }

./build.sh                                   # esbuild: js/app.js + imports → js/app.bundle.js
# Only the bundle and js/vendor/ run on the TV; keep the ES-module sources and repo files out of
# the package (one -e per pattern: the CLI silently keeps only the last entry of a comma list).
# Root FILES need a leading wildcard (*build.sh), root DIRECTORIES a trailing /* (.git/*).
exargs=(-e "*build.sh" -e "*package.sh" -e "*README.md" -e "*LICENSE" -e "*package.json" -e "*package-lock.json" -e "*.gitignore" -e ".git/*" -e "node_modules/*")
for f in js/*.js; do [ "$f" = "js/app.bundle.js" ] || exargs+=(-e "$f"); done
tizen build-web "${exargs[@]}" -- .
tizen package -t wgt -s "$profile" -- .buildResult
# A profile the CLI cannot see yields an UNSIGNED package with exit 0, which the TV then rejects
# with error 118012. Fail here instead.
# (Capture the listing first: `unzip | grep -q` under pipefail reports failure on every signed package.)
listing="$(unzip -l .buildResult/MytView.wgt 2>/dev/null || true)"
case "$listing" in
  *signature1.xml*) ;;
  *) echo "package is UNSIGNED: is profile '$profile' in Tizen Studio's Certificate Manager?" >&2; exit 1 ;;
esac
cp -f .buildResult/MytView.wgt MytView.wgt
echo "→ MytView.wgt (signed with profile '$profile'). Install: sdb connect <tv-ip> && tizen install -n MytView.wgt -t <tv-serial>"
