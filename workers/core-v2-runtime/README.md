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
                        file; `https.ts` is a real HTTPS client that cannot be
                        constructed until every gate has passed; credentials
                        are redacted wherever a request is rendered.
    material/           the provider-neutral material boundary: what a
                        resolver may return, and the verification every item
                        passes before a request is built. `memory-resolver.ts`
                        is the only resolver in the repository.
    providers/          the only place a provider is named. One protocol file
                        each for the three request formats, one skeleton that
                        holds the lifecycle they share, one file that says how
                        each provider's usage report is read, one registry that
                        builds exactly one adapter per provider, one local
                        stand-in that answers in each provider's own response
                        shape, and one invented operator configuration for
                        the offline commands.
    local-agent/        the offline stand-in's reasoning: it reads the request
                        it was handed — the compiled prompt and the attached
                        material — and answers from that and nothing else.
    prompt-compiler.ts  one provider-neutral compiler: a packet becomes a role,
                        the material, the rules and the shape of the answer.
    budget/             the durable cost ledger over migration 059, the
                        normalization of a provider's usage report into
                        billable components, and the decorator that puts both
                        on the path the work takes.
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

## How each request is addressed, and how sure we are of it

Each protocol file in `providers/` carries a **protocol note**: the official
document the adapter was written against, the date it was checked, and — where
the document could not be fetched from the machine doing the checking — a
plain statement of that, with the exact fields a paid canary must confirm.
Read those notes before trusting anything a fixture appears to prove. The
names, the URLs and the field-by-field claims live there, with the code they
describe, and nowhere else.

Three corrections in this version are worth stating as rules, because each was
a way of being wrong that a fixture happily agreed with:

**An API key goes in the header that provider's documentation names, carrying
the key and nothing else.** A bearer token is a *different, separately typed*
authentication mode, not a wrapper you may put an API key inside. The two are
never interchanged, and `tests/adapters.mjs` asserts the header by exact name
and asserts the key's absence from every URL, query string and log line.

**"Strict" is a word about the request, not about the intention.** Where a
protocol has a strict-schema mechanism, the request enables it; nothing in
this package describes an output as strict unless the request actually said
so. If a configured model cannot combine what a role needs — forced tool
choice, a strict schema, images, a thinking mode that cannot coexist with
forced choice — the adapter **refuses before submission with a configuration
error naming the combination.** Strictness is never quietly dropped to make a
request go through. `configurationProblems` on the protocol is where that
refusal is decided.

**A fixture is adjusted to the protocol, never the protocol to the fixture.**
Where re-reading the documentation and the handwritten fixture disagreed, the
fixture was wrong. Fixtures are stored raw — the provider's own response
shape — separately from the normalized result expected of them, so a fixture
cannot quietly become the specification.

Whether a provider *accepts* any of these requests is not something a fixture
can prove, and this package does not claim it.

## How source material reaches a model

A packet authorises named sources and, where a task is narrower than a whole
source, named segments of them. Until this version an agent was told *about*
that material and never given it. Now it is given it, and the giving is
bounded at every step.

A **`MaterialResolver`** lives outside the kernel and outside the adapters:

    resolve(sources: SourceReference[]): Promise<ResolvedMaterial[]>

It may receive only the `SourceReference` objects the packet already
authorised. It cannot widen scope, cannot choose a source of its own, and
cannot return a whole document when one segment was asked for — a result that
was not requested is refused, not ignored.

What it returns has room for the content and no room for its address:

    { sourceId, segmentId?, kind, mediaType, contentHash, byteLength,
      locator,          // the authorized locator, for the record only
      content }         // text, or bytes

There is no field for a bucket, a path, a signed URL or a token, so an address
cannot reach a model by mistake — the type is the guarantee, not a rule
somebody has to remember. The locator is the one the packet already carried,
and it is used for the record and never placed in a request.

Before a request is built, `verifyResolvedMaterial` refuses on any of:

* material missing for a source or segment the packet authorised;
* a source or segment that was never asked for;
* a `contentHash` that does not match the packet's, or does not match a fresh
  hash of the bytes actually returned;
* a media type the provider does not accept, or that does not match the kind;
* an item larger than the packet's limit, or a total larger than the
  provider's declared input ceiling.

A refusal is `material_not_resolved` or `material_refused`; either way nothing
is submitted and nothing is spent.

V1 carries four kinds: bounded UTF-8 text; image bytes with a media type; a
rendered page of a PDF, carried as an image; and transcript text carrying the
time range it covers. Each adapter translates a `ResolvedMaterial` into that
provider's own multimodal shape — the three formats differ, and each
translation lives beside the protocol it belongs to — and text is attached
under a heading naming the source and segment it came from.

The only resolver in this repository is `InMemoryMaterialResolver`, which is
handed its bytes. **Nothing here connects to Supabase Storage or to any real
file**, and the offline commands resolve material rendered by the invented
pack in `../core-v2/domains/synthetic-records`.

The stand-in that answers offline (`local-agent/`) reads only the request it
was handed: the compiled prompt and the material attached to it. It has no
lookup table and never sees a task id as an answer key — change the text or
the pixels a task authorises and the resulting claim changes, with every
identifier untouched. `tests/e2e.mjs` proves exactly that.

## How a request could actually leave

`transport/https.ts` is a real HTTPS client. It is also the strictest thing in
the package, and no ordinary command can build one.

`createHttpsTransport(config, env)` **throws `NetworkNotAuthorized`, listing
every reason,** unless all four authorization gates are true at that moment.
There is no flag, no environment variable and no test seam that skips this;
`tests/boundary.mjs` proves nothing in the package constructs one, and
`tests/https-transport.mjs` drives it through an injected request seam that
never opens a socket.

Once constructed, it refuses:

* any scheme that is not `https:`;
* any host that is not the host of a configured provider's base URL;
* any URL carrying a username or password;
* loopback, private, link-local, unique-local and unspecified addresses —
  checked on the literal in the URL **and on every address DNS returns**, so a
  name that resolves inward is refused as firmly as `127.0.0.1`;
* a request body over its ceiling, and a response over its ceiling;
* a redirect — the response is returned unfollowed, never chased.

It applies the attempt's timeout and honours an `AbortSignal`. It never logs a
request body, a response body, source material or a key; credential headers
and credential query parameters are redacted wherever a request is rendered.

The one judgement it makes is the expensive one: **any exception after the
request was written is classified as possibly submitted.** `beforeSubmission`
is true only when nothing could have been written — a DNS failure, a refused
connection, or a refusal made before the socket was touched. Silence means
"it may have arrived", and the ledger treats it that way.

A key is read last. Configuration is validated, the four gates pass, the
deadline is checked, material is resolved and verified, the provider's
capability declaration is checked, and the prompt is compiled — **and only
then** is the named environment variable read.
`tests/adapter-failures.mjs` proves that ordering against a proxied
environment that records every read.

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
  submission, and nothing leaves the process. The hold stores the prices it
  was taken under as an immutable `price_basis`.
* the commit that writes the answer settles the hold at what the provider
  actually reported, priced **from that stored basis** — never from the
  configuration the process happens to be holding. Changing a price, or
  removing a model from the configuration entirely, cannot change or prevent
  the settlement of an attempt already reserved for.
* an attempt that never left gives its hold back.
* an attempt whose outcome nobody knows settles nothing and releases nothing.
  The money may already be gone.

Concurrent dispatchers cannot oversubscribe: every one of those numbers is
checked under a row lock in one statement.

### What a provider reported, and what it costs

Adding a provider's numbers together is wrong, and differently wrong for each
provider. So both things are kept:

* **`provider_usage`** — the usage object exactly as the provider reported it,
  unaltered.
* **`normalized_usage`** — billable components, with a
  **`normalization_version`** saying which set of rules produced them:
  uncached input, cached input read, cached input write, visible output,
  reasoning output, and whatever else that provider reports.

The normalization is **per provider**, and it lives in
`providers/usage-dialects.ts` rather than in `budget/`, because the semantics
genuinely differ and the kernel-facing side of the ledger may not know a
provider exists. The three dialects disagree about all three questions that
matter:

* whether the reported input figure already contains the cached figure;
* whether the reported output figure already contains the reasoning figure;
* whether cache reads and cache writes are reported separately at all.

Where a report gives a total and a subset of that total, **the subset is
subtracted before the separate rate is applied**; where it gives two
independent numbers, they are added. Getting that backwards is how a token
gets billed twice, so `tests/billing.mjs` proves it dialect by dialect,
against the raw report each one actually produces.

Rates come from the stored basis. A cache-read component with no cache rate is
priced at the full input rate — an upper bound, deliberately, and recorded as
such. A cache-*write* component with no cache-write rate is refused rather
than guessed at, because guessing low is guessing in the wrong direction.
Reasoning output with no separate rate is priced as output.

**Unknown is not zero.** If the provider reports no usable billing counts — no
usage object, unparseable counts, or components the stored basis cannot price
— the settlement is *refused*. The hold stays open, the attempt is moved to
`core_v2_attempt_cost_needs_attention` with the reason recorded, and
`budget.settlement_refused` and `budget.needs_attention` are emitted. A $0
settlement happens only when a provider explicitly reports zero. Money that
nobody can account for stays held, where it goes on blocking further spending
until a person looks at it.

An actual cost above the reservation is recorded at what it actually was, not
capped to the hold; it counts against the workflow's authorised maximum, so
the overspend stops further spending rather than being quietly absorbed.

A reservation and the budget it is taken against must be in the same currency.
A mismatch is refused by the schema, not by the code that happens to be
calling.

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

## Three different kinds of confidence

Nothing here should be read as one undifferentiated claim of "tested". There
are three levels, and they are not interchangeable.

**Proved locally.** Provable in this repository with no network at all, and
proved: the material boundary and every refusal it makes; the HTTPS
transport's gates, host restriction, address rules, redirect refusal, size
ceilings and before/after-submission classification, through an injected
request seam; the order in which a key is read; usage normalization for the
three dialects and the absence of double counting; settlement from the stored
price basis under a changed configuration; a missing usage report becoming an
open reservation rather than $0; currency refusal; the whole workflow offline
through three adapters, a real record and a durable budget; crash and restart;
an attempt whose outcome nobody ever learns.

**Checked against documentation, not against a provider.** The shape of each
request — required fields, header names, where structured output goes, where
usage counts are read from — was written against the official protocol and is
asserted by contract tests over handwritten fixtures. A fixture proves the
code does what the code intends. **A fixture cannot prove a provider accepts
anything**, and two of the three protocol notes record that the official
document could not be fetched from this environment.

**Provable only by an authorised paid canary, and not proved.** None of this
has been done, and no request has ever been made from this code to any
provider:

* that each provider accepts the request its adapter builds at all;
* that the header each adapter puts its key in is accepted for the configured
  model and endpoint;
* that a strict schema, a forced tool choice and a thinking mode combine the
  way each capability declaration assumes;
* that structured output, refusals, incomplete responses, request ids and the
  four token counts arrive where each parser looks for them;
* that images and PDF pages are accepted in the multimodal shapes the adapters
  build, at the sizes the ceilings allow;
* that a real refusal, a real output ceiling, a real 401/403, a real 429, a
  real 5xx and a real timeout classify the way the fixtures say they do;
* what an answer actually costs, and therefore whether the operator's prices,
  the normalization and a provider's own invoice agree;
* latency, and whether the attempt timeout and lease TTL are the right size;
* whether independent real models actually disagree in the ways the engine is
  built to detect — every disagreement proved so far was scripted.

Until that canary is authorised and run, treat every number this package
prints as what a run **would** have cost, and every classification as what
this code does with an answer of that shape.

## Tests

    bash tests/run.sh

    boundary.mjs           the kernel names no provider, imports nothing of
                           this package, and the door out is shut by default —
                           nothing here can even construct the open one
    material.mjs           what a resolver may return, and every way material
                           is refused before a request is built
    https-transport.mjs    the gates, the host allowlist, credentials in a
                           URL, private addresses, redirects, size ceilings,
                           timeouts, redaction, and what counts as
                           "possibly submitted"
    billing.mjs            three usage dialects, no token counted twice,
                           settlement from the stored basis, and a missing
                           usage report that never becomes $0
    prompt-compiler.mjs    what a packet becomes, and what it may never say
    adapters.mjs           three adapters, one contract: what goes on the
                           wire, which header carries the key, that strict is
                           actually declared, and both usage records
    adapter-failures.mjs   every way an answer can go wrong, and what each
                           becomes — never a successful empty result; plus
                           capability refusals and the order a key is read in
    budget.mjs             reservations, settlement, release, the attention
                           condition, a frozen price basis, currency, and two
                           dispatchers racing for one budget
    dispatcher.mjs         claiming, ownership, restart, cancellation and
                           shutdown, against a real database
    e2e.mjs                one whole workflow offline through all three
                           adapters, with real synthetic text and image
                           material on the wire; changing the material changes
                           the claim; a tampered hash refuses; then the same
                           with the dispatcher dropped mid-run; then a request
                           that leaves and never comes back
    cli.mjs                the commands as programs, including one real run
                           against a throwaway cluster
    typecheck.sh           the kernel and the runtime type-check together

The database-backed suites boot a local PostgreSQL cluster on a unix socket
and reach nothing else. `e2e.mjs` shuts every other door in the process
first — `fetch`, `http`, `https`, `tls`, DNS and any socket that is not a
path on this machine — and reports the count of attempts, which is nil.
