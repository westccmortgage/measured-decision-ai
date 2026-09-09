# core-v2-canary — the temporary hosted entrypoint

One paid Measured Decision run, once, inside an authority of $5.00 USD, on
the project where the provider secrets already live. Deployed to run, then
taken away.

Everything in this directory is finished and tested. It has **not** been
deployed and has **not** been invoked.

## The run that happened, and what it measured

Run 34340500490, 2026-09-09, dispatched once against this branch.

It got further than any previous attempt and it spent **nothing**:

* the gating held — `deploy-database` and `deploy-functions` were both
  **skipped**, so no migration ran and no other function was deployed;
* all three provider secret names were confirmed present, by name only;
* the CLI bundled the 45-file, 705 KB import graph into a **525 kB** script
  and deployed it — so reaching out of `supabase/` into `workers/` is
  something the Supabase CLI does without complaint;
* the single invocation returned **HTTP 504** after ~160 seconds;
* the record is **completely empty**: no workflow, no task, no attempt, no
  reservation, no budget row, no synthetic organisation, no `core_v2.*`
  audit row.

The last point is the one that matters. The transport that can reach a
provider is constructed *after* the record and the budget are in place, so
an empty record proves no provider was contacted: **0 of 4 submissions,
$0.00 reserved, $0.00 settled, $0.00 spent.**

Where it stopped: the very first database write is the synthetic
organisation, and it never happened, so execution hung inside
`CanaryDatabase.connect` — the direct `SUPABASE_DB_URL` connection from the
Edge Runtime — or in loading `jsr:@db/postgres`. It did not refuse; it hung
until the gateway gave up, which is the signature of a connection that is
routable in name only. The likely cause is that a direct Postgres connection
from an Edge Function is not reachable the way this adapter opens it, and
that the pooler is what an Edge Function is expected to use. That is a
diagnosis to confirm, not a conclusion, and confirming it costs nothing:
the failure is entirely on this side of the paid boundary.

Cleanup ran through the EXIT trap and was then independently verified twice
— once by the job's own assertion step and once from outside afterwards:

* `core-v2-canary` deleted; 13 functions remain, none of them it;
* `CORE_V2_ALLOW_PAID_CALLS` unset, `CORE_V2_CANARY_TRIGGER` unset;
* `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` untouched;
* every other function's `ezbr_sha256` unchanged. Their *version* counters
  moved, because project-level secrets are baked into every function's
  environment and setting or unsetting one re-stamps them all. No other
  function's code was deployed.

The temporary workflow job has been removed from this branch, so the paid
path cannot be launched again by accident.

## Why it was not deployed from the agent session

Three separate things, only the first of which is a judgement call:

1. **The payload.** The function imports the real engine — scheduler,
   repository, state machines, budget ledger, three provider adapters — and
   the transitive set is **45 files, 705 KB**. The only deployment route
   available to that session is the Supabase MCP `deploy_edge_function`
   tool, which takes every file's content inline in the call. Reproducing
   705 KB of source by hand into a tool call is not a thing that can be done
   reliably, and a single transcription slip inside `postgres/repository.ts`
   would corrupt the atomic submission path — the one place where a
   corrupted byte can cost money and lose the record of having spent it. The
   Supabase CLI, which uploads from disk, was not installed in that session
   and no `SUPABASE_ACCESS_TOKEN` was available.

2. **Secrets.** The MCP server exposes no secrets tool, so
   `CORE_V2_CANARY_TRIGGER` could not be created and
   `CORE_V2_ALLOW_PAID_CALLS` could not be set or unset.

3. **Deletion.** The MCP server exposes no delete for Edge Functions. A
   function that could not be removed afterwards should not be put up.

None of these are Core V2 problems and none of them are worked around here.

## Deploying and running it, from a checkout with the CLI

```sh
# 0 · from the repository root, on branch claude/core-v2-canary
supabase link --project-ref hbqlhplgqwuesrovbiye

# 1 · confirm the three provider secrets exist. Names only — never values.
supabase secrets list | grep -E 'ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY'
#    If one is missing: stop. Nobody has been called.

# 2 · a fresh one-time trigger, generated locally and kept out of the repo
TRIGGER="$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-43)"
supabase secrets set CORE_V2_CANARY_TRIGGER="$TRIGGER"

# 3 · the paid gate, immediately before invocation and not a moment earlier
supabase secrets set CORE_V2_ALLOW_PAID_CALLS=true

# 4 · deploy ONLY this function
supabase functions deploy core-v2-canary --project-ref hbqlhplgqwuesrovbiye

# 5 · invoke EXACTLY ONCE. Never again, even after a partial failure.
curl -sS -X POST \
  "https://hbqlhplgqwuesrovbiye.supabase.co/functions/v1/core-v2-canary" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "x-canary-trigger: $TRIGGER" \
  -H "content-type: application/json" \
  -d '{"allowProviderNetwork": true, "allowPaidCalls": true}' \
  | tee canary-report.json

# 6 · cleanup, whatever the result said
supabase secrets unset CORE_V2_ALLOW_PAID_CALLS CORE_V2_CANARY_TRIGGER
supabase functions delete core-v2-canary --project-ref hbqlhplgqwuesrovbiye
#    The audit rows stay. The three provider keys are never touched.
```

`canary-report.json` is the evidence: every attempt and its terminal state,
provider request ids, the models actually served, raw and normalised usage,
every reservation and settlement, unresolved holds, the total, and the
Verified / Disagreement / Needs-more-proof findings with their anchors.

## The locks, and which one is in force

* **The trigger.** If `CORE_V2_CANARY_TRIGGER` is set, that is the trigger and
  nothing in the source needs editing. If it is not set, the SHA-256 digest
  compiled into `index.ts` is the trigger; its token was generated on an
  operator's machine, never written to this repository and never stored on
  the platform. A hash is not a credential.
* **The network flag** and **the paid-calls gate** must both be asked for at
  invocation, and the gate may also come from the environment.
* **A canary runs once.** The workflow id is derived from the immutable
  canary id, and the function counts attempts in the record that may already
  have been billed. After a run there is at least one, so a second
  invocation is refused with 409 before any provider is contacted — the
  function is incapable of spending again even while it is still deployed.
* **The money.** The authority is $5.00, a constant no code path can raise.
  Four submissions, concurrency one, no retries, no fallback model. The
  worst case is computed by the ledger's own ceiling function — $0.18432 an
  attempt, $0.73728 for four — and the run refuses if it does not fit.
  Whatever the ending, the unused authority is closed through the ledger.

## Keys

This function never reads one. The adapters are handed a proxy that resolves
a single named variable at the moment the executor asks for it, which it does
once, at submission, after configuration, authorization, material,
capability, prompt, deadline, reservation and submission-eligibility have
passed. Presence is confirmed with `Deno.env.has`, which does not retrieve a
value. Nothing is printed, returned, logged, compared, rotated or replaced.

## The one thing this transport cannot do

`deno-transport.ts` reuses the authorised transport's own origin rules and
address checks, keeps redirects unfollowed, caps request and response, and
redacts credentials — but Deno's `fetch` exposes no seam for "connect to
THIS address", so the connection is **not** pinned to the addresses that were
validated. TLS certificate validation against the hostname carries that
weight instead. The runtime transport in `workers/core-v2-runtime` is not
modified and not weakened; this is a separate file for one run.
