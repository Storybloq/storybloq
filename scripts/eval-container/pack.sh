#!/bin/bash
# T-538 pack profiles (plan section 9). Runs as its own short-lived container over a read-only mount.
# stdout: one pax tar of the profile's roots. stderr: NUL-framed records only, M missing root,
# O omitted folder, S socket, E tool message, A another name for the credential. The runner reads
# both on the host; nothing here judges what it packs.
# The helper is created as `sh pack.sh <profile>` (packCreateArgs), so the lines up to the re-exec are
# POSIX sh; the deadline then runs the rest under bash.
profile="${1:-}"; deadline="${2:-1200}"
if [ -z "${PACK_INNER:-}" ]; then export PACK_INNER=1; exec timeout -k 5 "$deadline" /bin/bash "$0" "$@"; fi
set -euo pipefail
# Every profile on the attempt volume scans for other names of the credential. The proxy volume holds
# no credential file (the proxy gets it in its environment) and a hard link cannot cross volumes.
alias_scan=yes
case "$profile" in
  attempt) cwd=/vol/att; roots=(project store global eval-events reviewers home/.codex/sessions);;
  judge)   cwd=/vol/att; roots=(out home/.codex/sessions);;
  proxy)   cwd=/vol/proxy; roots=(log); alias_scan=no;;
  live)    cwd=/vol/att/project; roots=(.story);;
  *) printf 'E\0unknown profile\0' >&2; exit 64;;
esac
cd "$cwd"
rec=$(mktemp /tmp/pack.rec.XXXXXX); err=$(mktemp /tmp/pack.err.XXXXXX); list=$(mktemp /tmp/pack.lst.XXXXXX)
touch "$rec.o" "$rec.s" "$rec.a"
present=()
# A root that is a link is present: tar records it as a link and the host classes it, never follows it.
for r in "${roots[@]}"; do if [ -e "$r" ] || [ -L "$r" ]; then present+=("$r"); else printf 'M\0%s\0' "$r" >> "$rec"; fi; done
status=0
if [ "${#present[@]}" -gt 0 ]; then
  find "${present[@]}" \( -type d \( -name node_modules -o -name bower_components -o -name .pnpm-store -o -name .venv -o -name venv \) -fprintf "$rec.o" 'O\0%p\0' -prune \) -o \( -type s -fprintf "$rec.s" 'S\0%p\0' \) -o -print0 > "$list" 2>>"$err" || status=$?
fi
tar --format=pax --null --no-recursion -T "$list" --no-xattrs --numeric-owner -cf - 2>>"$err" || status=$?
# Another name for the credential file would carry it out under an innocent path. The scan fails
# closed: if it cannot finish, the pack fails, since an alias it did not see is not proof of none.
# Only a credential that is not there needs no scan; any other failure to stat it fails the pack.
cred=/vol/att/home/.codex/auth.json
if [ "$alias_scan" = yes ]; then
  if seen=$(stat -c %i -- "$cred" 2>&1); then
    find /vol/att -samefile "$cred" -not -path "$cred" -printf 'A\0%p\0' > "$rec.a" 2>>"$err" || { status=$?; printf 'alias scan did not finish ' >> "$err"; }
  else
    case "$seen" in
      *"No such file or directory"*) ;;
      *) status=70; printf 'the credential could not be checked: %s ' "$seen" >> "$err";;
    esac
  fi
fi
cat "$rec" "$rec.o" "$rec.s" "$rec.a" >&2
if [ -s "$err" ]; then tr '\n\0' '  ' < "$err" | { printf 'E\0' >&2; cat >&2; printf '\0' >&2; }; fi
exit "$status"
