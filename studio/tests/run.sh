#!/usr/bin/env bash
# Every check this product has, in one command.
#
# Three kinds, in the order that catches things soonest:
#   unit    — the functions that write sentences a person reads
#   audit   — every screen, in a real browser, pressed
#   walk    — the whole path end to end against a known world
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

fail=0
run() {
  printf "\n\033[1m%s\033[0m\n" "── $1"
  if node "$2" > /tmp/mdai-test.out 2>&1; then
    grep -E "ALL OK|ALL CHECKS|findings|Nothing found|FINDING" /tmp/mdai-test.out | tail -n 2 | sed 's/^/  /'
  else
    fail=1
    cat /tmp/mdai-test.out | sed 's/^/  /'
  fi
}

run "cached files match the markup"   studio/tests/asset-versions.mjs
run "what the AI refusal says"        studio/tests/analysis-blocker.mjs
run "what the processing screen says" studio/tests/processing-headline.mjs
run "what the room count says"        studio/tests/room-picker-note.mjs
run "the create-project form"         studio/tests/create-project-form.mjs
run "the drop box has a way onward"   studio/tests/intake-dead-end.mjs
run "the two doors are told apart"    studio/tests/two-doors.mjs
run "every screen, pressed"           studio/tests/screen-audit.mjs
run "the whole path, walked"          studio/tests/e2e-studio.mjs
run "a project with nothing in it"   studio/tests/e2e-empty-project.mjs

printf "\n%s\n" "────────────────────────────────────────────"
if [ "$fail" = "0" ]; then echo "ALL CHECKS PASS"; else echo "SOMETHING FAILED — see above"; fi
exit "$fail"
