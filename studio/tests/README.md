# Studio tests

Six checks. Run them all:

```
bash studio/tests/run.sh
```

Nothing here touches the network or a real project. The browser tests are
served from a temporary local HTTP server with every off-host request blocked,
and Supabase is replaced by `fake-supabase.js` answering from `seed.mjs`.

## Why these, and not others

Every bug this product has shipped has been the same shape: **the screen knew
the truth and showed something else**, or **a control answered nothing**.

- Create project did nothing, because a required field was hidden.
- The AI refusal told somebody to add the file they had just added.
- The headline named the 360 machine while an AI review was running.
- The meter read 0% beside a line reading 18%.
- "Open 360 view" opened an arbitrary room.
- A room holding two files said it held one.

None of those are logic errors. Every one of them is a sentence or a control
that stopped matching the world. So the tests read sentences and press buttons.

| Check | Asks |
|---|---|
| `analysis-blocker.mjs` | Does the refusal name the real obstacle, for each of the four room states? |
| `processing-headline.mjs` | Does the headline describe what is running now, and does the meter carry the number beside it? |
| `room-picker-note.mjs` | Does the count explain itself when files collapse into one capture? |
| `create-project-form.mjs` | Does the form a person is looking at actually submit? |
| `screen-audit.mjs` | On all five screens: is anything required but invisible, does every visible button do something when pressed, does the script reach for elements that are not there, can every dialog be left, does the page fit a phone? |
| `e2e-studio.mjs` | The whole path: arrive, open the project by name, read the upload note, reach the AI stage, check all four room states, check the 360 button names its room, and confirm nothing on screen is dead. |

## The seed

`seed.mjs` is one building in the four states that have produced every bug:

- a room you can stand in — the machine has run
- a room holding a complete camera pair the machine has not reached
- a room holding only a document
- a room with nothing in it

A screen that survives all four survives a real project. Add a fifth state here
before adding a test for it.

## Rules for adding a check

**Test the sentence, not the function.** `focusProcessingHeadline()` returning
an object proves nothing; the headline saying "Reading Family" while Family is
being read is the thing that broke.

**Prove the test would have caught it.** Put the bug back, run the test, watch
it fail, name what it named. `create-project-form.mjs` was checked that way and
the note is in its header. A test that has never failed is a description.

**A finding the harness invented is worse than no finding.** An early audit run
produced a hundred confident reports about missing elements — it had followed a
redirect and was auditing the wrong page. Two more came from a filler typing `1`
into a field with `min="1700"`, and from judging a sign-in form while the panel
holding it was closed. When a finding looks surprising, suspect the harness
first.
