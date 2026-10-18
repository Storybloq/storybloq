#!/bin/sh
# T-538 S3a-2: replay.sh <name> [touch|seen] prints a recorded runner output
# (__fixtures__/t538-runner-output/<name>.txt) and exits with its recorded
# code. `touch` first creates ./ran; `seen` first writes the evidence
# variables it was given to ./seen.
dir="$(dirname "$0")/../__fixtures__/t538-runner-output"
case "$2" in
  touch) : > ran ;;
  seen) printf '%s|%s|%s|%s\n' "$CI" "$NO_COLOR" "$FORCE_COLOR" "$GOFLAGS" > seen ;;
esac
cat "$dir/$1.txt"
exit "$(sed -n "s/^  \"$1\": \([0-9]*\),\{0,1\}\$/\1/p" "$dir/exits.json")"
