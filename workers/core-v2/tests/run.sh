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
run "agreement is not proof"                                           acceptance.mjs
run "evidence points at one place"                                     evidence-scope.mjs
run "the states the engine walks, and the ones the database allows"    workflow-states.mjs
run "restart, cancel, timeout, and the unknown outcome"                recovery.mjs
run "an agent asks; the orchestrator decides"                          follow-up.mjs
run "every limit is a place the run stops"                             budgets.mjs
run "a second domain"                                                  transcripts.mjs
run "the repository contract, in memory and in Postgres"               repository-contract.mjs
run "the whole chain against migration 058, with a restart"            postgres-e2e.mjs
run "nothing of a client, nothing of a provider, nothing of a project" nothing-real.mjs
run "every door is closed"                                             network-guard.mjs
run "the command line runs from wherever it is"                        cli-entry.mjs

echo
echo "────────────────────────────────────────────"
if [ "$fail" = "1" ]; then echo "SOMETHING FAILED — see above"; exit 1; fi
echo "ALL CHECKS PASS"
# Every suite the README names is listed above. A suite is listed only
# once it exists and passes.
