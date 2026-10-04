#!/usr/bin/env bash
# ISS-928: the type gate for storybloq. Runs two tsc programs with the pinned
# TypeScript, prints both counts next to both baselines, and exits:
#   0  both counts at or below their baselines (a count below prints a line
#      telling the reader to lower that baseline by hand; never automatic)
#   1  either count exceeds its baseline
#   3  fatal: tsc did not produce a trustworthy diagnostics run
# Run from anywhere: `npm run typecheck`, or `bash scripts/tsc-gate.sh`.
set -euo pipefail

# src program (tsconfig.json: src only). Counts diagnostic HEADS: one per
# diagnostic, a complete "path(line,col): error TSnnnn:" line starting in
# column 1. The ISS-928 filing's all-output-lines convention (299 lines = 108
# diagnostics) is retired. Never compare this number with TEST_BASELINE.
SRC_BASELINE=96
# test program (tsconfig.test.json: src + test). Counts test-anchored HEADS
# only: lines starting "test/...(line,col): error TSnnnn:". Heads anchored in
# src are the src program's business. A src-only change can move this count
# (test fixtures going stale against src types): that is signal, not noise.
# Never compare this number with SRC_BASELINE.
TEST_BASELINE=928

HEAD_RE='^[^[:space:]].*\([0-9]+,[0-9]+\): error TS[0-9]+:'
TEST_HEAD_RE='^test/.*\([0-9]+,[0-9]+\): error TS[0-9]+:'
GLOBAL_RE='^error TS[0-9]+:'

# Control flow rule: fatal() always runs in the main shell. Nothing that can
# call fatal() is ever wrapped in $( ), a pipeline, an `if` condition or an
# && / || list.
TMP=""
cleanup() {
  if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fatal() {
  local reason=$1 f
  shift
  echo "tsc-gate: fatal: $reason" >&2
  for f in "$@"; do
    if [ -s "$f" ]; then
      echo "--- $(basename "$f") ---" >&2
      cat "$f" >&2
    fi
  done
  exit 3
}

cd "$(dirname "$0")/.." || fatal "cannot cd to the package root"
export npm_config_update_notifier=false

TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsc-gate.XXXXXX") || fatal "cannot create a temp directory"
if [ -z "$TMP" ] || [ ! -d "$TMP" ]; then fatal "mktemp returned no directory"; fi

# count_heads FILE REGEX: sets COUNT to the number of matching lines. grep
# exits 1 for no match (fine) and above 1 on an operational error (fatal).
COUNT=""
count_heads() {
  local st=0
  COUNT=$(grep -cE -- "$2" "$1") || st=$?
  if [ "$st" -gt 1 ]; then fatal "grep failed (status $st) on $1"; fi
  case "$COUNT" in
    '' | *[!0-9]*) fatal "grep printed a non-numeric count '$COUNT' for $1" ;;
  esac
}

# count_files SHOWCONFIG DIR: sets COUNT to the number of entries in the
# top-level "files" array of tsc --showConfig output that start with "./DIR/".
# Only "files" is read: include and exclude patterns are not files.
count_files() {
  local st=0 out="$TMP/count_files.out" err="$TMP/count_files.err"
  node -e '
const fs = require("fs");
let j;
try {
  j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
} catch (e) {
  process.stderr.write("--showConfig output is not valid JSON\n");
  process.exit(2);
}
if (j === null || typeof j !== "object" || !Array.isArray(j.files)) {
  process.stderr.write("--showConfig output has no top-level files array\n");
  process.exit(2);
}
const prefix = "./" + process.argv[2] + "/";
const n = j.files.filter((f) => typeof f === "string" && f.startsWith(prefix)).length;
process.stdout.write(String(n) + "\n");
' "$1" "$2" >"$out" 2>"$err" || st=$?
  if [ "$st" -ne 0 ]; then fatal "node could not read the --showConfig output $1 (status $st)" "$err" "$1"; fi
  COUNT=$(cat -- "$out") || fatal "cannot read $out"
  case "$COUNT" in
    '' | *[!0-9]*) fatal "node printed a non-numeric file count '$COUNT' for $1" ;;
  esac
}

# run_program NAME CONFIG COUNT_REGEX DIR: sets PROGRAM_COUNT. DIR is the
# directory the config must cover: tsc parses a truncated tsconfig without an
# error and falls back to the inherited include, silently dropping DIR.
# Known limit: this proves the config covers DIR at all, not every file in it.
PROGRAM_COUNT=""
run_program() {
  local name=$1 config=$2 regex=$3 dir=$4 rc
  local cout="$TMP/$name.showconfig.out" cerr="$TMP/$name.showconfig.err"
  local out="$TMP/$name.out" err="$TMP/$name.err"

  rc=0
  npx --no-install tsc -p "$config" --showConfig >"$cout" 2>"$cerr" || rc=$?
  if [ "$rc" -ne 0 ]; then
    fatal "$name: tsc -p $config --showConfig exited $rc (config unreadable, or tsc unavailable)" "$cout" "$cerr"
  fi
  count_files "$cout" "$dir"
  if [ "$COUNT" -eq 0 ]; then
    fatal "$name: --showConfig lists no $dir/ file; the config does not cover $dir/" "$cerr"
  fi

  rc=0
  npx --no-install tsc --noEmit --pretty false -p "$config" >"$out" 2>"$err" || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; then
    fatal "$name: tsc exited $rc, which is not a diagnostics exit" "$out" "$err"
  fi

  count_heads "$out" "$GLOBAL_RE"
  if [ "$COUNT" -ne 0 ]; then
    fatal "$name: $COUNT diagnostic(s) with no file location (config or global error)" "$out" "$err"
  fi

  count_heads "$out" "$HEAD_RE"
  if [ "$rc" -eq 2 ] && [ "$COUNT" -eq 0 ]; then
    fatal "$name: tsc exited 2 but printed no file-anchored diagnostic" "$out" "$err"
  fi
  if [ "$rc" -eq 0 ] && [ -s "$out" ]; then
    fatal "$name: tsc exited 0 but printed output" "$out" "$err"
  fi

  count_heads "$out" "$regex"
  PROGRAM_COUNT=$COUNT
}

# report NAME COUNT BASELINE BASELINE_VAR: prints, and sets OVER=1 when over.
OVER=0
report() {
  echo "$1: $2 (baseline $3)"
  if [ "$2" -gt "$3" ]; then
    echo "tsc-gate: $1 count $2 exceeds its baseline $3"
    OVER=1
  elif [ "$2" -lt "$3" ]; then
    echo "tsc-gate: $1 count $2 is below its baseline $3: lower $4 to $2 in scripts/tsc-gate.sh"
  fi
}

run_program src tsconfig.json "$HEAD_RE" src
SRC_COUNT=$PROGRAM_COUNT
run_program test tsconfig.test.json "$TEST_HEAD_RE" test
TEST_COUNT=$PROGRAM_COUNT

report src "$SRC_COUNT" "$SRC_BASELINE" SRC_BASELINE
report test "$TEST_COUNT" "$TEST_BASELINE" TEST_BASELINE

if [ "$OVER" -ne 0 ]; then exit 1; fi
exit 0
