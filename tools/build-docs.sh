#!/usr/bin/env bash
# Régénère docs/ (GitHub Pages) à partir de web/ : page prof générique + guide + confidentialité.
set -e
cd "$(dirname "$0")/.."
V=$(grep -o "versionName '[^']*'" android/app/build.gradle | cut -d"'" -f2)
[ -n "$V" ] && echo "window.PARTOCHE_VERSION = '$V'" > web/version.js
rm -rf docs
cp -r web docs
cp tools/docs-config.js docs/config.js
touch docs/.nojekyll
echo "docs/ régénéré."
