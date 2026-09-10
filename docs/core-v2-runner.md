# Production Runner V1 — deployment, activation, shutdown, recovery

One authorised start creates one workflow. From that moment the **record**
says when it runs again, and something with no person in front of it does the
running, until the workflow reaches a terminal state.

This document is what an operator needs and nothing else. The reasoning behind
each choice is in the files themselves — `workers/core-v2-runner/clock.ts`,
`supabase/migrations/060_the_workflow_wakes_itself.sql`.

---

## What is deployed

| Piece | What it is | Who calls it |
|---|---|---|
| `supabase/migrations/060_…sql` | the durable "when does this run again" record, its doors, and the watchdog entry point | applied once |
| `supabase/migrations/061_…sql` | one narrow door: a **settled** continuation may be reopened when the workflow itself records a cancellation and is not yet over | the cancel operation |
| `core-v2-runner` (Edge Function) | **start**, **cancel**, **status** | a person, with a token |
| `core-v2-runner-tick` (Edge Function) | **tick** — advance whatever is due | the watchdog, and the previous tick |

Two functions, because there are two kinds of caller. `core-v2-runner` is
deployed with `verify_jwt = true` and the platform checks every caller's token
before the code runs. `core-v2-runner-tick` has no user in front of it, so the
platform cannot check one; it proves the caller with a shared secret of its own
and **refuses to open at all until that secret is set**.

---

## Dormant by default

Nothing runs, and nothing can spend, until an operator turns on four separate
things. Each is named in the refusal when it is missing, so a runner that will
not work says which one to set.

| Secret | Until it is set |
|---|---|
| `CORE_V2_RUNNER_SECRET` | the tick door returns 503 and opens for nobody |
| `CORE_V2_RUNNER_REGISTRY` | the runner has no declaration of models, addresses, capabilities or prices, and invents none |
| `CORE_V2_RUNNER_AUTHORIZED_USD` | no workflow can be given an authority, so nothing can be reserved and nothing can be sent |
| `CORE_V2_ALLOW_PAID_CALLS=true` | the executors refuse before submission |

And one more, per invocation rather than per deployment:
`CORE_V2_RUNNER_ALLOW_PROVIDER_NETWORK=true`. With it unset the runner still
claims, still advances everything that costs nothing, and records a refusal for
anything that would cost — which is the state to deploy in first.

The **watchdog** is separately dormant: migration 060 creates the settings
table empty, `armed` defaults to `false`, and no cron job is created. Arming it
is step 5 below.

---

## Deployment

### 1 · Apply the migrations

```
supabase db push --linked
```

**060** adds `workflow_continuations`, its five doors, `core_v2_runner_settings`
(empty) and `core_v2_tick_due_continuations`. **061** adds one function,
`core_v2_reopen_continuation`, and nothing else. Neither rewrites anything in
058 or 059, and 061 does not change 060.

### 2 · Give the functions a route to the record

The Edge Runtime cannot reach the database's direct address; it reaches
Supavisor. Read the pooler's own facts rather than guessing a host:

```
curl -sS -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$PROJECT_REF/config/database/pooler"
```

Set the four route facts. **No password is set here** — the functions take it
from `SUPABASE_DB_URL`, which the platform already gives every function. A
secret in two places is a secret that gets rotated in one of them.

```
supabase secrets set --project-ref "$PROJECT_REF" \
  CORE_V2_RUNNER_DB_HOST=<pooler host> \
  CORE_V2_RUNNER_DB_PORT=5432 \
  CORE_V2_RUNNER_DB_USER=<pooler user> \
  CORE_V2_RUNNER_DB_NAME=postgres
```

### 3 · Deploy the two functions

```
supabase functions deploy core-v2-runner      --project-ref "$PROJECT_REF"
supabase functions deploy core-v2-runner-tick --project-ref "$PROJECT_REF"
```

At this point a person can start a workflow and read its status. Nothing
advances it yet, which is the correct state to stop and look around in.

### 4 · Turn the runner on, one thing at a time

```
# 4a — the tick door opens
supabase secrets set --project-ref "$PROJECT_REF" \
  CORE_V2_RUNNER_SECRET="$(openssl rand -hex 32)"

# 4b — the operator's declaration of models, addresses, capabilities, prices
supabase secrets set --project-ref "$PROJECT_REF" \
  CORE_V2_RUNNER_REGISTRY="$(cat operator-registry.json)"

# 4c — what one workflow may spend, and how many attempts may be open at once
supabase secrets set --project-ref "$PROJECT_REF" \
  CORE_V2_RUNNER_AUTHORIZED_USD=5 \
  CORE_V2_RUNNER_CONCURRENT_ATTEMPTS=6

# 4d — the paid gate, and the provider network
supabase secrets set --project-ref "$PROJECT_REF" \
  CORE_V2_ALLOW_PAID_CALLS=true \
  CORE_V2_RUNNER_ALLOW_PROVIDER_NETWORK=true

# 4e — where a tick hands on to the next one (the fast path)
supabase secrets set --project-ref "$PROJECT_REF" \
  CORE_V2_RUNNER_TICK_URL="https://$PROJECT_REF.functions.supabase.co/core-v2-runner-tick"
```

Setting any project secret bumps every function's version counter. That is the
platform, not a redeploy: the code is unchanged.

### 5 · Arm the watchdog

The chain in step 4e is an optimisation. The watchdog is the authority, and
without it a lost invocation strands a workflow until somebody notices.

```sql
-- the secret lives in Vault; the settings table holds only its NAME
select vault.create_secret('<the same value as CORE_V2_RUNNER_SECRET>', 'core_v2_runner_secret');

insert into public.core_v2_runner_settings (id, armed, endpoint, secret_name)
values (true, true,
        'https://<project-ref>.functions.supabase.co/core-v2-runner-tick',
        'core_v2_runner_secret')
on conflict (id) do update
   set armed = true, endpoint = excluded.endpoint, secret_name = excluded.secret_name;

create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.schedule('core-v2-runner-watchdog', '* * * * *',
                     $$select public.core_v2_tick_due_continuations(10)$$);
```

Check it is knocking, not merely scheduled:

```sql
select public.core_v2_tick_due_continuations(10);
-- {"armed": true, "due": 2, "posted": 2}
```

An unarmed watchdog, a missing `pg_net` and an unreadable secret each say so in
that answer rather than returning zero as though the queue were empty.

---

## Using it

### Start

```
POST /core-v2-runner            Authorization: Bearer <user token>
{"op":"start","organizationId":"<uuid>","sourceSetSeed":"<name of the source set>",
 "sources":1,"sheetsPerSource":1,"entriesPerTable":3}
→ 202 {"workflowId":"…","state":"created","sourceSet":{…},"continuation":"due now; …"}
```

The id is real and immutable the moment it returns. Nothing has run yet and
nothing needs to have.

**The workflow, its sources, its start command, its audit entry and its first
continuation are one commit.** A process that dies part way through a start
leaves nothing at all — never a real workflow that no watchdog will ever look
at.

**Every number is remembered and every number is checked.** `sources`,
`sheetsPerSource` and `entriesPerTable` are optional and default to 1, 1 and 3;
all three are written into the source names the record keeps, and a later
runner rebuilds the material from those rather than from any default. V1 runs
1–8 sources, 1–8 sheets each and 1–16 entries per table; anything outside that
is a 400 naming the field and the bounds, **before** a workflow exists.

### Status

```
POST /core-v2-runner            {"op":"status","workflowId":"…"}
```

Returns the workflow's state, its task and attempt counts by state, the
continuation row (when it is next due, who holds it, how many passes in a row
have moved nothing, and why it stopped if it has), the budget, and a count of
what is waiting for a person. Ids, states, counts, times — never content.

### Cancel

```
POST /core-v2-runner            {"op":"cancel","workflowId":"…"}
```

Asks. Whichever runner next holds the workflow honours it, including one
holding it right now. Finished work is kept. Unsent work is stopped. An attempt
that may have been served **stays an unknown outcome** and is not relabelled.

If the workflow's waking had already been settled — five idle passes, the
continuation ceiling, or a hand-off to a person — the cancel operation reopens
it for this one purpose, and the answer says `"wakingReopened": true`. That is
migration 061, and it is the only thing that can move a settled row: it reads
`cancel_requested_at` from the workflow itself and refuses a workflow that is
already over.

---

## Shutdown

Three levels, smallest blast radius first.

**Stop one workflow.** Cancel it, as above.

**Stop the fleet, keep the record.** Unschedule the watchdog and remove the
chain; in-flight invocations finish and write what they learned.

```sql
select cron.unschedule('core-v2-runner-watchdog');
update public.core_v2_runner_settings set armed = false where id;
```
```
supabase secrets unset --project-ref "$PROJECT_REF" CORE_V2_RUNNER_TICK_URL
```

**Stop spending immediately, keep everything running.** The engine will keep
advancing whatever costs nothing and record refusals for the rest.

```
supabase secrets unset --project-ref "$PROJECT_REF" CORE_V2_ALLOW_PAID_CALLS
```

To stop one workflow's spending durably, without touching the fleet:

```sql
select public.core_v2_stop_workflow_spending('<workflow id>', 'why');
```

---

## Recovery

### "It is not moving"

```sql
select state, due_at, held_by, held_until, continuations, idle_streak,
       backoff_ms, settled_reason, last_error
  from public.workflow_continuations where workflow_id = '…';
```

| What it says | What it means | What to do |
|---|---|---|
| `settled`, reason `workflow_reached_a_terminal_state` | it is finished | read the decisions |
| `settled`, reason `handed_to_a_person` | the engine did what it can; something needs a person | look at `waitingForAPerson` in status |
| `settled`, reason `no_progress_in_5_continuations` | five passes in a row moved nothing | `last_error`, then the audit trail |
| `settled`, reason `material_not_provable` | the runner could not rebuild this workflow's material from its own sources | the source set is not one this deployment can read |
| `held` with `held_until` in the past | a runner died holding it | nothing: the next claim takes it |
| `due` with `due_at` in the past | nobody is ticking | check the watchdog (below) |
| `due` with `due_at` a few seconds ahead | a pass is waiting for a lease somebody else holds | nothing: it comes back when that lease could no longer be alive |

**Whenever a continuation settles for anything but a terminal workflow, the
WORKFLOW is written too** — including when the SQL settled it without a runner
ever holding it (a workflow already over, or one at the continuation ceiling).
That case is caught by the next idle tick, which reports `reconciled` in its
answer. It moves to `needs_attention` — or to `failed`, if it
never got past its own start handshake — with `error_code = 'runner_stopped'`
and the settling reason in `error_message`, and one `core_v2.workflow.runner_stopped`
audit entry. So the two records never disagree, and a workflow that says
`running` really is one something intends to run.

```sql
select state, error_code, error_message from public.intelligence_workflows where id = '…';
select detail from public.audit_events
 where entity_id = '…' and action = 'core_v2.workflow.runner_stopped';
```

### "Nothing is ticking"

```sql
select public.core_v2_tick_due_continuations(10);          -- what does it say?
select * from cron.job where jobname = 'core-v2-runner-watchdog';
select * from cron.job_run_details order by start_time desc limit 5;
```

Then the function's own logs: every line is one JSON object with `fn`, `event`
and the ids. `chain.failed` appearing every tick means the fast path is broken
and the watchdog is carrying everything — latency, not loss.

### "Something is stuck at an unknown outcome"

That is the design, not a fault. An attempt that may have been served is never
bought again by a machine. A person decides:

```sql
select id, task_id, role_key, error_code, submitted_at
  from public.agent_attempts
 where workflow_id = '…' and state = 'outcome_unknown';
```

Reconcile it with what the provider's own record says, through
`core_v2_reconcile_attempt`. The money stays held until then, which is correct:
"free" and "unknown" are different facts.

### "A task keeps going back to the queue"

That is the clock working, not a fault. A reading is only started when there is
room left to answer it *and* write it down inside this invocation's life; when
there is not, the task is handed back unrun and uncharged and the next pass
starts it. Each one leaves a trail:

```sql
select entity_id, detail from public.audit_events where action = 'core_v2.task.deferred';
```

A tick's answer reports the same number as `deferred`. Seeing it every pass
means one reading takes longer than the window allows — raise
`CORE_V2_RUNNER_LIFETIME_MS` if the platform gives more life, or lower the
answer window so more readings fit. Seeing it occasionally is the design.

### "I need it to run right now"

```sql
select public.core_v2_schedule_continuation('<workflow id>', now());
```

Only brings a due time forward, never resurrects a settled workflow.

---

## What V1 does not do

Stated plainly so nobody discovers it in production:

- **Material lives in the fixture, not in object storage.** A workflow's
  sources name the set they belong to — seed, sheets per source, entries per
  table — and the runner rebuilds them from that name and checks them hash by
  hash. Sources whose bytes live in object storage are the next step; a source
  whose scheme this runner does not recognise is refused by name rather than
  guessed at.
- **One domain pack.** The synthetic-records pack is the one this repository
  has, and the runner runs it.
- **No fan-out across workflows.** One invocation advances one workflow. Two
  runners overlapping is safe and tested; a fleet sized to a queue is not V1.
- **The watchdog's floor is one minute.** `pg_cron` does not go below it, so a
  lost chain costs up to a minute of latency.
