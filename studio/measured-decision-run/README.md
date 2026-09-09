# Measured Decision Run

The first screen where the decision system is visible: a person presses one
button and watches independent workers read the same evidence separately,
disagree, be challenged, and produce a decision every claim of which points at
the material it rests on.

**Route:** `/studio/measured-decision-run/` — reached from the Studio landing.

## The integration boundary

There is exactly one, and it is `adapter.js`.

    index.html / run.css / run.js     the screen. Draws what it is given.
    adapter.js                        the only place the screen touches the
                                      engine: it starts a run, reads the
                                      record back, and translates role names
                                      into ordinary words. It decides nothing.
    engine/                           GENERATED. workers/core-v2 compiled to
                                      browser ESM by build-engine.mjs.
    engine-shims/                     the small part of node's surface the
                                      engine uses — Buffer, sha-256, sha-1,
                                      deflate — checked against node's own
                                      output by the suite.

`run.js` contains no rule about what agrees, what is proved, or what needs a
person. Those are the engine's answers and the screen only reads them. Nothing
in the page holds one reader's answer to give to another: the kernel builds
every packet, so independence is not something the screen has to remember.

## Rebuilding the engine

    node studio/measured-decision-run/build-engine.mjs

The output is committed because the Studio is served as static files with no
build step. `studio/tests/measured-decision-run.mjs` rebuilds and fails if what
is committed is not what the build produces, so `engine/` cannot drift from
`workers/core-v2` and cannot be hand-edited.

The build refuses to write anything if an engine file reaches for a node
built-in nobody has shimmed, rather than emitting a bundle that fails in a
browser later. That refusal has already earned its place once: it caught the
kernel's UUID v5 needing SHA-1.

## What this is not

It is a demonstration on invented records. It runs entirely in the browser
with mock executors, makes no network request of any kind, reads no key, and
costs nothing. It is not connected to any project, document or provider.
