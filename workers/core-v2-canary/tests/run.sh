#!/usr/bin/env bash
# The canary's own checks. They run offline, read no key, open no socket and
# write no row: what is under test is the refusing.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

fail=0
run() {
  printf "\n\033[1m%s\033[0m\n" "── $1"
  if node --experimental-strip-types --no-warnings "$2" > /tmp/core-v2-canary-test.out 2>&1; then
    grep -E "ALL OK|FAILURE" /tmp/core-v2-canary-test.out | tail -n 1 | sed 's/^/  /'
  else
    fail=1
    cat /tmp/core-v2-canary-test.out | sed 's/^/  /'
  fi
}

run "the canary that has not run, and every lock on its door" canary.mjs

printf "\n\033[1m%s\033[0m\n" "── preflight, as the program an operator would run"
if node --experimental-strip-types --no-warnings ../canary.ts --preflight > /tmp/core-v2-canary-preflight.out 2>&1; then
  fail=1
  echo "  FAIL — preflight with nothing supplied should refuse"
else
  grep -c "·" /tmp/core-v2-canary-preflight.out | sed 's/^/  refusals printed: /'
  if grep -q "no key was read and nothing was sent" /tmp/core-v2-canary-preflight.out; then
    echo "  ok  it says what it did not do"
  else
    fail=1; echo "  FAIL — it did not say what it did not do"
  fi
fi

echo
echo "────────────────────────────────────────────"
if [ "$fail" = "1" ]; then echo "SOMETHING FAILED — see above"; exit 1; fi
echo "ALL CHECKS PASS"
