#!/usr/bin/env bash
# compat-fetch.sh -- T-486 7b: fetch and install the published CLIs the compat
# tests run (pins in test/compat/old-dists.json), once per machine.
#
# Each version is packed from the registry with no user config and an empty
# cache, its sha256 checked against the pin, then installed with scripts
# ignored under $STORYBLOQ_OLD_DIST_DIR/<version> (default
# $HOME/.cache/storybloq/old-dists). Exits non-zero on any mismatch or failure.
# Tests read only the installed prefix; they never touch the network.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
dir="${STORYBLOQ_OLD_DIST_DIR:-$HOME/.cache/storybloq/old-dists}"
mkdir -p "$dir"
cache="$(mktemp -d)"
trap 'rm -rf "$cache"' EXIT

pins="$(node -e 'const p=require(process.argv[1]); for (const d of p.dists) console.log(d.version+" "+d.sha256)' "$here/test/compat/old-dists.json")"

while read -r version sha; do
  tgz="$dir/storybloq-storybloq-$version.tgz"
  if [ ! -f "$tgz" ]; then
    (cd "$dir" && npm pack "@storybloq/storybloq@$version" --userconfig /dev/null --cache "$cache" --silent >/dev/null)
  fi
  actual="$(shasum -a 256 "$tgz" | cut -d' ' -f1)"
  if [ "$actual" != "$sha" ]; then
    echo "compat-fetch: $tgz has sha256 $actual, expected $sha" >&2
    exit 1
  fi
  if [ ! -x "$dir/$version/node_modules/.bin/storybloq" ]; then
    npm install --prefix "$dir/$version" --userconfig /dev/null --cache "$cache" --ignore-scripts --no-audit --no-fund "$tgz" >/dev/null
  fi
  echo "compat-fetch: storybloq $version ok ($sha)"
done <<< "$pins"
