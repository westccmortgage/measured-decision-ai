# The canary

One paid run, once, under one immutable name, inside one authority of $5.00
USD — and nothing in this directory can raise that number, because it is a
constant every path reads from `operator-registry.ts`.

Nothing here has run. `preflight` is the default and prints every reason.

    node --experimental-strip-types --no-warnings canary.ts --preflight --registry <path>

## What is missing, and why this directory cannot supply it

A paid run needs facts that are an operator's, not a program's:

* which models exist, by the exact ids their operator names them by,
* where each one's requests go,
* what each one is capable of — forced tool choice, strict schemas, images,
  reasoning — because nothing in this package infers a capability from a
  model's name,
* what each one costs per million tokens, **including what it costs to write
  a cache entry**. That last rate is the one the reservation ceiling is built
  on. A provider that writes a cache entry has billed for it whether or not
  this runtime can price it, so a price that omits the rate establishes no
  upper bound: no ceiling, no reservation, nothing sent.

`registry.example.json` is that declaration with every one of those fields
left blank. It names no provider, no model and no rate, and it is **refused**
until a person fills it in and puts their name and the date on it. The
refusals are the checklist: run preflight against the blank file and it
prints one line per missing fact.

The only configuration this repository ships otherwise is the invented one in
`../providers/demonstration.ts`, whose addresses end in `.invalid` and whose
models exist in that file and in no catalogue anywhere. The loader refuses a
declaration that looks like it — a reserved address, or the demonstration's
own key-variable names.

## What preflight does not do

It does not read a key. Not the value, and not to see whether one exists: a
key is read by the sealed executor, once, at submission, after configuration,
authorization, material, capability, prompt, deadline, reservation and
submission-eligibility have all passed. Preflight opens no socket, builds no
transport and writes no row.

## What `--execute` requires

All of these, at once, and each from a different person or place:

1. `--allow-provider-network` on the command line,
2. `CORE_V2_ALLOW_PAID_CALLS=true` in the environment,
3. an operator's registry declaration that passes every check above,
4. `CORE_V2_CANARY_ORGANIZATION` naming an organisation that exists,
5. a record to write to, on a **unix socket on this machine** — there is no
   host flag and there will not be one. A canary's rows belong in a throwaway
   cluster with the migrations applied, not in a hosted database.

Then the arithmetic has to fit: the dearest attempt any declared provider and
model could produce, taken as often as submissions are permitted, must come
in at or under the authority. That worst case is computed from the ledger's
own ceiling function, not a second arithmetic beside it.

## What it will not do at any flag

Retry, fall back to another model, dispatch a task twice, or send anything
after the first refusal, protocol error, authentication error, timeout,
unknown outcome or accounting mismatch. An attempt whose outcome is unknown
counts against the authority in full. The unused authority is closed at the
end of the run, whatever the ending.

## The identity

`core-v2-canary-1`. The workflow id is derived from it, so a second run under
the same name finds the first one's attempts in the record and refuses. A
canary runs once.
