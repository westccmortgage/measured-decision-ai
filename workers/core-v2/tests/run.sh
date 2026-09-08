#!/usr/bin/env bash
# Every check the kernel has, in one command. Pure TypeScript under
# node --experimental-strip-types; no build, no dependencies, no network,
# no provider, no project. The database-backed suites boot a throwaway
# local PostgreSQL cluster and never touch anything else.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

fail=0
run() {
  printf "\n\033[1m%s\033[0m\n" "── $1"
  if node --experimental-strip-types --no-warnings "$2" > /tmp/core-v2-test.out 2>&1; then
    grep -E "ALL OK|FAILURE" /tmp/core-v2-test.out | tail -n 1 | sed 's/^/  /'
  else
    fail=1
    cat /tmp/core-v2-test.out | sed 's/^/  /'
  fi
}

run "the registry, and what it refuses to be"                          registry.mjs
run "two phases: what the source declares, what the pack expands"      expansion.mjs
run "a blind reader is blind"                                          blindness.mjs
run "independence fails closed"                                        independence.mjs

echo
echo "────────────────────────────────────────────"
if [ "$fail" = "1" ]; then echo "SOMETHING FAILED — see above"; exit 1; fi
echo "ALL CHECKS PASS"
# Suites still being written, each named in README.md: acceptance,
# evidence-scope, follow-up, workflow-states, recovery, budgets, transcripts,
# repository-contract, postgres-e2e, nothing-real, network-guard, cli-entry.
# A suite is listed above only once it exists and passes.
