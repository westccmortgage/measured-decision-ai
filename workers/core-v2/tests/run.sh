#!/usr/bin/env bash
# Every check the orchestration engine has, in one command. Pure TypeScript
# under node --experimental-strip-types; no build, no dependencies, no network.
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

run "the registry, and what it refuses to be"   registry.mjs
run "a project becomes bounded assignments"      distribution.mjs
run "a blind reader is blind"                    blindness.mjs
run "fan out, and gather back"                   fan-out-fan-in.mjs
run "where readers differ"                       disagreement.mjs
run "an agent asks; the orchestrator decides"    follow-up.mjs
run "what an envelope must be"                   evidence-discipline.mjs
run "restart, cancel, and the unknown outcome"   recovery.mjs
run "nothing of a client, nothing of a provider" nothing-real.mjs
run "what the skeptics found"                    adversarial.mjs
run "what the recovery skeptic found"            adversarial-recovery.mjs
run "what the evidence skeptics found"           adversarial-evidence.mjs
run "every door is closed"                       adversarial-guard.mjs
run "the CLI runs from wherever it is"           cli-entry.mjs

echo
echo "────────────────────────────────────────────"
if [ "$fail" = "1" ]; then echo "SOMETHING FAILED — see above"; exit 1; fi
echo "ALL CHECKS PASS"
