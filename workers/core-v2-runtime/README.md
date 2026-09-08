# Core V2 — the execution layer

The kernel in `../core-v2` decides what work exists and what its answers
mean. This package is what turns that into requests, and it is the only part
of the system that could ever spend money. It holds the dispatcher that takes
committed work off the outbox, the three provider adapters, the one prompt
compiler, the transport, and the durable budget.

Two rules shape everything here.

**The kernel never learns that providers exist.** Nothing in `../core-v2`
names one, and nothing in `../core-v2` imports this package; the dependency
runs one way, and `tests/boundary.mjs` fails if it ever stops running one way.
Provider names, request formats and response parsing live only in
`providers/`.

**Nothing can be sent by accident.** The transport a runtime gets by default
refuses every request. A paid call needs four separate authorizations at the
same moment, and every command in this package runs with none of them. As of
this version **no request has ever been made from this code to any provider**;
everything below has been proved against transports that answer inside the
process.

## Layout

    transport/          the HTTP seam. `SealedTransport` is the default and
                        refuses everything; `FixtureTransport` answers from a
                        file; credentials are redacted wherever a request is
                        rendered.
    providers/          the only place a provider is named. One protocol file
                        each for the three request formats, one skeleton that
                        holds the lifecycle they share, one registry that
                        builds exactly one adapter per provider, one local
                        stand-in that answers in each provider's own response
                        shape, and one invented operator configuration for
                        the offline commands.
    prompt-compiler.ts  one provider-neutral compiler: a packet becomes a role,
                        the material, the rules and the shape of the answer.
    budget/             the durable cost ledger over migration 059, and the
                        decorator that puts it on the path the work takes.
    dispatcher.ts       the outbox consumer: claim, own, advance, back off,
                        resume, cancel, shut down.
    cli.ts              --dry-run, --simulate, --simulate-postgres, and --run,
                        which refuses.
    tests/              one suite per rule, run by tests/run.sh

## Running it

    node --experimental-strip-types --no-warnings cli.ts --dry-run
    node --experimental-strip-types --no-warnings cli.ts --simulate
    node --experimental-strip-types --no-warnings cli.ts --simulate-postgres \
         --socket <unix socket> --database <name> --user <name>
    node --experimental-strip-types --no-warnings cli.ts --run     # refuses
    bash tests/run.sh

Every offline mode prints, before it starts: that the network is disabled,
that paid calls are disabled and the five reasons a paid run would refuse,
which invented pack it is about to read, which roles it plans, which
independence domain each provider is, and what it is allowed to spend. After
it ends it prints how the workflow ended, how many claims, disagreements and
decisions there are, and `external cost $0.00`.

`--simulate-postgres` writes into a database you name over a **unix socket**.
There is no host flag and no password flag, and there will not be one: it is
for a throwaway cluster on your own machine. It refuses anything that is not
a path, and refuses to run without `CORE_V2_CLI_ORGANIZATION` naming an
organisation that already exists there.

## How the dispatcher starts

A producer writes the workflow, its sources and one `pending` row in
`workflow_outbox`, in one transaction (`enqueueWorkflow`, or the database's
own `core_v2_start_workflow`). Nothing runs as a result.

A dispatcher is then constructed with a name, a way to open **its own**
connection, a way to build the record over that connection, the domain pack,
a function that builds the executors for a workflow, and an event sink:

    const dispatcher = new Dispatcher({
      name: "dispatcher-one",
      connect: () => WireClient.connect({ socketPath, user, database }),
      repository: (client) => meteredRepository(
        new PostgresOrchestrationRepository(client, { organizationId }),
        { ledger: new BudgetLedger(client, config), config, providerOfFamily }),
      pack, executors, events: jsonLines(console.log), now: Date.now,
    });
    await dispatcher.start();          // loop until stopped
    await dispatcher.runOnce();        // or one bounded pass
    await dispatcher.drain();          // or passes until there is nothing left

Two dispatchers must not share a connection. Each pass claims at most one
waiting command through `core_v2_claim_next_workflow`, which takes one row
under a lock and skips the rows another dispatcher is holding, so several
dispatchers on one queue start a workflow exactly once. The command is
acknowledged only after ownership is durable — the workflow has left
`created` and its first tasks are admitted. A dispatcher that dies in between
leaves a `dispatching` command and a `queued` workflow, and whoever picks
that workflow up finishes the handshake.

Every pass is bounded: at most `ticksPerPass` scheduler ticks per workflow and
at most `workflowsPerPass` workflows. With nothing to do it backs off —
doubling to a ceiling, with jitter — rather than asking the same question
forever.

## How it stops

`await dispatcher.stop()` stops the next pass from taking new work, lets the
pass in flight settle, and returns. An `AbortSignal` in the options does the
same thing from outside. Work already leased stays leased until its lease
expires, and another dispatcher takes it then; nothing is abandoned silently.

Cancellation is different from shutdown: `requestCancel` on the record, or the
database's own cancelling list, is honoured wherever the workflow is — the
dispatcher picks up workflows asking to be cancelled even when it holds none
of them. Work not yet sent is dropped without cost; work already sent is
preserved as possible exposure rather than pretended away.

## How recovery works

On any pass, `core_v2_resumable_workflows` returns the workflows past the door
and unfinished, and the dispatcher takes them up. Leases decide who runs what,
so several dispatchers may look at one workflow and only one gets each piece.

An attempt whose outcome was never seen is `outcome_unknown`, and that is
terminal until somebody resolves it. The tick reconciles before it considers
anything else: it asks the executor what became of the attempt. A provider
adapter can only answer "unknown", because it genuinely cannot know, so such
an attempt stays unknown and its task stays unfinished until a person
authorises a retry (`retry_authorized_by` and `retry_authorized_at` on the
task — columns a machine can never fill in). **Nothing is ever repurchased on
a guess.**

The dispatcher keeps one rule about its own honesty: a workflow that says it
is `running` has something to run. When a pass goes quiet and nothing is
runnable, leased or reconcilable, it moves the workflow to `needs_attention`
with `nothing_runnable` rather than leaving a spinner.

## How provider configurations are supplied

An operator supplies, per provider: an opaque id, an address, **the name of
the environment variable that holds the key**, the models that may be asked,
the model to use when a task names none, an input ceiling, an output ceiling
and a timeout. Plus a price per model, with an effective date and the input,
output, cached and reasoning rates.

The runtime never holds a key. It reads the named variable once, at the moment
of the request, after every gate has passed, puts it in one header, and keeps
it nowhere else. It is never printed, logged, measured, tested or validated.
There is no default model anywhere in the code: an unconfigured model is a
refusal, and an unpriced model cannot be reserved for and therefore cannot be
sent.

`configurationProblems(config)` says everything wrong with a configuration
before anything is built from it.

## How independence domains are assigned

The kernel gives every executor **instance** one independence domain. Two
families registered against one instance are one domain, whatever a routing
table calls them.

`buildProviderRegistry` builds **exactly one adapter per configured provider**,
however many families or models that provider serves, and registers it under
its provider id as a durable name. Two consequences, both intended:

* two models, two aliases or two keys from one provider are one opinion, by
  construction rather than by a rule somebody has to remember;
* the domain a reading was made in is the same domain after a restart, so the
  record's independence survives a crash. (A domain invented per process would
  make every restart look like a fresh opinion.)

Routing fails closed. A blind reading is refused unless a domain that has not
read that subject is available; a critic, verifier or arbiter is refused if
every domain serving its profile took part in what it would judge. Refusal
means the subject is held for a person, never that the work runs anyway.

**Three providers are not always enough.** Two blind readings, a reviewer that
is neither of them, and an arbiter that is none of the three is four domains.
With three configured, a dispute between two readings can be settled — the
reviewer's verdict comes from the third domain — but an arbiter's *correction*
of two readings that agreed cannot be accepted by machine, because the only
reviewer of that source is the arbiter's own domain. The engine says so and
holds the subject for a person. That is the discipline working, not a fault;
add a fourth independent provider if you want that case settled by machine.

## How cost authorization works

Two separate things, and both are required.

**Permission to spend at all** — four gates, all true at the same moment:

1. the run was started with `--allow-provider-network`;
2. `CORE_V2_ALLOW_PAID_CALLS=true` in the environment;
3. an explicit maximum authorised cost above zero;
4. configured allowlists of providers and of models, with a price for each.

Any one missing refuses before a request is built. `paidCallRefusals(config)`
gives every reason at once. On top of that, a transport that can reach a
provider has to be built and injected; nothing in this package builds one.

**What one workflow may spend** — a durable budget row, written once by
`core_v2_authorize_workflow_spending`: an authorised maximum, a per-attempt
maximum, input- and output-token ceilings, an attempt ceiling, a concurrency
ceiling and a wall-clock deadline. Then, on the path the work takes:

* `submitAttempt` — the last thing before anything is sent — takes a hold for
  **the most this attempt could cost**, priced from the ceilings the request
  will carry, atomically in the database. A refused hold refuses the
  submission, and nothing leaves the process.
* the commit that writes the answer settles the hold at what the provider
  actually reported, priced at the rate the hold was taken under.
* an attempt that never left gives its hold back.
* an attempt whose outcome nobody knows settles nothing and releases nothing.
  The money may already be gone.

Concurrent dispatchers cannot oversubscribe: every one of those numbers is
checked under a row lock in one statement.

## How to find a stuck or unknown attempt

    -- attempts nobody knows the outcome of, oldest first
    select a.workflow_id, a.task_id, a.id, a.provider_stop_reason, a.error_code, a.submitted_at
      from public.agent_attempts a
     where a.state = 'outcome_unknown' and a.reconciliation_outcome is null
     order by a.submitted_at;

    -- money still held for work that may or may not have happened
    select * from public.attempt_cost_reservations where state = 'reserved';

    -- workflows the engine has stopped being able to advance
    select id, state, error_code, error_message from public.intelligence_workflows
     where state in ('needs_attention','partial');

    -- subjects waiting for a person, with the reason
    select workflow_id, subject_signature ->> 'subject_key', needs_human_reason
      from public.disagreements where state = 'needs_human';

`core_v2_unreconciled_workflows` returns the same thing from the dispatcher's
side. The dispatcher also emits `workflow.stalled`, `workflow.needs_person`
and `workflow.settled` events; every event is one JSON line with counts and
identifiers only — never a key, a prompt, an answer or a piece of a source.

A reservation that stays `reserved` is the signal that matters: it is money a
run cannot spend twice, and it comes off only when a person or an executor
says what became of the attempt.

## What is still unproved

Everything in this package has been exercised offline. The following can only
be proved by a small, separately authorised, paid canary, and none of it has
been:

* that each provider accepts the request the adapter builds, and that its
  strict-output mechanism returns the envelope this code expects;
* that the identifier, the model, the token counts and the stop reason are
  where the parsers look for them in a real response;
* that a real refusal, a real output ceiling, a real rate limit, a real 5xx
  and a real timeout classify the way `tests/adapter-failures.mjs` says they
  do against fixtures;
* what a real answer actually costs, and therefore whether the operator's
  prices and the settlement match a provider's own invoice;
* latency, and whether the attempt timeout and lease TTL are the right size;
* whether independent real models actually disagree in the ways the engine is
  built to detect — every disagreement proved so far was scripted.

Until that canary is authorised and run, treat every number this package
prints as what a run **would** have cost, and every classification as what
this code does with an answer of that shape.

## Tests

    bash tests/run.sh

    boundary.mjs           the kernel names no provider, imports nothing of
                           this package, and the door out is shut by default
    prompt-compiler.mjs    what a packet becomes, and what it may never say
    adapters.mjs           three adapters, one contract: what goes on the wire
    adapter-failures.mjs   every way an answer can go wrong, and what each
                           becomes — never a successful empty result
    budget.mjs             reservations, settlement, release, and two
                           dispatchers racing for one budget
    dispatcher.mjs         claiming, ownership, restart, cancellation and
                           shutdown, against a real database
    e2e.mjs                one whole workflow offline through all three
                           adapters, a real record and a durable budget; then
                           the same with the dispatcher dropped mid-run; then
                           a request that leaves and never comes back
    cli.mjs                the commands as programs, including one real run
                           against a throwaway cluster

The database-backed suites boot a local PostgreSQL cluster on a unix socket
and reach nothing else. `e2e.mjs` shuts every other door in the process
first — `fetch`, `http`, `https`, `tls`, DNS and any socket that is not a
path on this machine — and reports the count of attempts, which is nil.
