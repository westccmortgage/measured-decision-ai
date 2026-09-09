#!/usr/bin/env bash
# Every check the execution layer has, in one command. Pure TypeScript under
# node --experimental-strip-types; no build, no dependencies, no provider, no
# key, no money. The database-backed suites boot a throwaway local PostgreSQL
# cluster and reach nothing else; the suites that need no database seal every
# door in the process before their first line.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

fail=0
run() {
  printf "\n\033[1m%s\033[0m\n" "── $1"
  if node --experimental-strip-types --no-warnings "$2" > /tmp/core-v2-runtime-test.out 2>&1; then
    grep -E "ALL OK|FAILURE" /tmp/core-v2-runtime-test.out | tail -n 1 | sed 's/^/  /'
  else
    fail=1
    cat /tmp/core-v2-runtime-test.out | sed 's/^/  /'
  fi
}

run "the wall between the kernel and the things that cost money"        boundary.mjs
run "what an agent is given to read, and what is checked first"         material.mjs
run "the one door that can be opened, and every lock on it"             https-transport.mjs
run "what the counts mean, and why adding them up is wrong"             billing.mjs
run "one prompt compiler, and what it may never say"                    prompt-compiler.mjs
run "three adapters, one contract"                                      adapters.mjs
run "every way an answer can go wrong"                                  adapter-failures.mjs
run "the durable budget: reserved before, settled after, never twice"   budget.mjs
run "the durable dispatcher, against a real database"                   dispatcher.mjs
run "one whole workflow, offline, through three adapters and a record"  e2e.mjs
run "the operator's commands, run as programs"                          cli.mjs

printf "\n\033[1m%s\033[0m\n" "── the kernel and the runtime, type-checked together"
if bash ./typecheck.sh; then :; else fail=1; fi

echo
echo "────────────────────────────────────────────"
if [ "$fail" = "1" ]; then echo "SOMETHING FAILED — see above"; exit 1; fi
echo "ALL CHECKS PASS"
# Every suite the README names is listed above. A suite is listed only
# once it exists and passes.
