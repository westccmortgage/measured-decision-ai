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
run "every function is deployed"      studio/tests/functions-deployed.mjs
run "when the machine may start"      studio/tests/machine-wake.mjs
run "what the AI refusal says"        studio/tests/analysis-blocker.mjs
run "what the processing screen says" studio/tests/processing-headline.mjs
run "what the room count says"        studio/tests/room-picker-note.mjs
run "an upload keeps its room"        studio/tests/upload-room-key.mjs
run "a capture keeps its room"        studio/tests/capture-room.mjs
run "the create-project form"         studio/tests/create-project-form.mjs
run "the drop box has a way onward"   studio/tests/intake-dead-end.mjs
run "the two doors are told apart"    studio/tests/two-doors.mjs
run "every screen, pressed"           studio/tests/screen-audit.mjs
run "the whole path, walked"          studio/tests/e2e-studio.mjs
run "a project with nothing in it"   studio/tests/e2e-empty-project.mjs
run "the chain, state by state"       studio/tests/e2e-chain.mjs
run "accepting a missing capture"     studio/tests/e2e-waiver.mjs
run "a capture waiting for the machine" studio/tests/e2e-waiting-machine.mjs
run "removing a project"              studio/tests/e2e-remove-project.mjs
run "finding things in the record"    studio/tests/e2e-search.mjs
run "how the rooms connect"           studio/tests/e2e-routes.mjs
run "a page open for three hours"     studio/tests/aged-session.mjs
run "the headset probe"               studio/tests/vr-check.mjs
run "standing in a real capture"      studio/tests/pano-vr.mjs
run "a pin is where it was placed"    studio/tests/marker-direction.mjs
run "pressing a pin in the room"      studio/tests/pano-markers-vr.mjs

printf "\n%s\n" "────────────────────────────────────────────"
if [ "$fail" = "0" ]; then echo "ALL CHECKS PASS"; else echo "SOMETHING FAILED — see above"; fi
exit "$fail"
