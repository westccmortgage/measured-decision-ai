# Measured Decision Core V2 — the universal decision kernel

Status: **implemented in `workers/core-v2/` and migration `058_core_v2_schema.sql`;
tested on synthetic sources only; not deployed; not integrated with any existing
project.** Every claim this document makes about behaviour points at a test that
proves it. Where a property is not yet proved, the document says so.

Core V2 is a multi-agent decision engine:

    bounded work distribution → independent analysis → evidence
      → disagreement detection → targeted verification → adjudication
      → traceable decision

It is not bound to construction drawings, to any client, to any property, or to
any table an existing project wrote. Sources are anything that can be identified
by content hash or immutable version, segmented, analysed by independent agents,
and cited by anchor: a document, a recording, a dataset, a register of records.
What a segment is, which analysts read it, what subjects and predicates they
report, and how a derived quantity is computed are the business of a **domain
pack**. The kernel neither knows nor enumerates them.

## 1. Kernel and domain pack

    workers/core-v2/
      kernel/        the universal engine — nothing in here names a domain
      domains/       domain packs — each versioned, each optional, each replaceable
      postgres/      the database adapter for migration 058
      cli.ts         dry-run and simulation over the synthetic packs
      tests/

**The kernel owns:** the workflow, task and attempt lifecycles; bounded DAG
scheduling with two-phase expansion; leases with fencing tokens, heartbeats and
recovery; work packets and result envelopes; routing and independence
enforcement; the evidence model (claims, anchors, assessments, disagreements,
decisions); budgets; cancellation; audit; the comparator; the critic, verifier,
arbiter and composer roles; and the acceptance rules.

**A domain pack owns:** its concrete analyst, discoverer and deriver roles; its
task types; how discovered segments expand into bounded assignments (phase B);
its claim-level validation rules; its normalisation of units and keys; its
derivation rules; its executors for deterministic derivation. It receives
persisted segments and returns task specifications. It cannot reach the
repository, the scheduler or another pack.

The kernel is tested with two synthetic packs (`domains/synthetic-records`,
`domains/synthetic-transcripts`) whose sources, segments, subjects and predicates
are invented and generic. Nothing under `workers/core-v2/` names a client, a
property, a drawing, or a legacy fixture; `tests/nothing-real.mjs` proves it.

Universal roles the kernel ships (a pack may add roles, never remove these):

| Role | Phase | Executor | Produces |
|---|---|---|---|
| `source_ingestor` | ingest | deterministic | identity claims about each source (hash, kind, size) and the top-level segments the source declares |
| `claim_comparator` | compare | deterministic | agreement groups and disagreements between independent readings |
| `evidence_critic` | verify | model | assessments of one or more claims against their own anchors |
| `disagreement_verifier` | verify | model | assessments of anonymised competing claims against the reopened source |
| `evidence_arbiter` | adjudicate | model | one proposed adjudication |
| `decision_composer` | compose | model | decisions from accepted evidence only |

Kernel task types: `ingest_source`, `discover_segments`, `compare_claims`,
`verify_claim`, `verify_disagreement`, `adjudicate`, `compose_decision`. A domain
pack's own task types are namespaced `<pack>:<name>` and belong to the `analyze`,
`discover` or `derive` phase.

## 2. Two-phase graph expansion

**Phase A — ingestion and source-level discovery.** From the workflow's
sources the kernel plans one `ingest_source` task per source and, where the
pack names a discoverer for a source that declares nothing about itself
(`pack.discovererFor(source)`), one discovery task per source under that
role's own namespaced task type. When an ingest task commits, the segments the
source **declares** about itself (the sheets of a register, the tracks of a
recording) are persisted from the manifest by the kernel, accepted by rule,
`discovered_by = deterministic`. When a discovery task commits, the segments
the discoverer **found** are persisted under its attempt, accepted when they
lie inside the parent the packet handed over, deduplicated by
`(source, parent, kind, content hash)`.

**Phase B — expansion.** After every ingest and every discovery commit, the
kernel hands the pack all persisted, accepted segments and every task the
workflow already holds, and the pack returns bounded assignments: further
discovery beneath declared segments, analysis tasks (blind pairs where the
pack says so), comparisons per blind subject, and derivations. The pack is
told nothing about executors, claims or the repository. Expansion is
**idempotent**: task ids are UUIDs derived from the work's identity, and
admission reuses a task whose identity already exists — running expansion
twice creates nothing the second time; a reused task that has not started
gains any prerequisite the new expansion names (`tests/expansion.mjs`). The
kernel closes the graph itself: one `compose_decision` task per subject the
pack names from the accepted claims, once everything else is terminal.

A manifest with sources but no pre-existing segments therefore does not stop
after discovery; the discoverer's output creates the downstream graph.

## 3. Independence, fail closed

Every attempt records an **independence domain**: the identity of the executor
that will actually run it, assigned by the executor registry at registration
time from the executor instance, never from a label an envelope or a routing
table could spoof. Two families registered against one executor instance share
one domain. Two blind readers of one subject must run in two domains.

If, at dispatch, no executor domain distinct from every domain that already
read the subject is available, the blind assignment is **not executed**: its
attempt is `rejected_before_submission` with reason `independence_unavailable`,
the task fails known, it is never counted as an independent reading, and the
subject is placed in `needs_attention` through a `coverage` disagreement that
goes straight to a person (`holdSubject`, one write). The same check is made
again, atomically, at submission: `submitAttempt` refuses a blind attempt
whose domain already submitted a reading of the subject under another group,
whatever the router believed when it chose. Within one tick the blind readings
of one subject are dispatched one after another, in the declared order of
their groups, so the second is routed knowing the first's domain and a
shortage of domains always refuses the later group rather than whichever task
id happened to sort first. A blind reading that ends `failed_known` or
`outcome_unknown` holds its subject the same way: a subject read once is not
called read. Critics, verifiers and arbiters are never routed to a domain
that authored what they judge — nor to a domain that authored any blind
reading which agreed with it, because a critic handed one of two agreeing
readings is judging both. The packet still shows only the one claim, so no
count of who agreed reaches the judge. Tests: one family available; two aliases on
one executor; simultaneous blind dispatch; exhausted visual families
(`tests/independence.mjs`).

## 4. Agreement is not proof

Two matching blind readings become **corroborated** — and nothing more. A
claim becomes **accepted** only through one of:

1. an independent source-verification result — a `supports` assessment by a
   critic or verifier whose independence domain differs from the claim's, on an
   anchor at the place the claim points; or
2. a deterministic rule that directly validates the source — the ingestor's
   identity claims are checked by code against the source's own recorded hash;
   a derived claim is accepted when every input it names is accepted; or
3. human approval, through `core_v2_resolve_disagreement`.

After every comparison the kernel creates one `verify_claim` task for the
corroborated readings of the subject: an evidence critic, in a domain that
authored none of them, reopens the source at the claims' own anchors. A
`supports` assessment accepts the claim by rule
(`independent_verification_supports_anchor`). A negative assessment on a
corroborated reading opens a disagreement between the readings and the
source (`found_by: verification`), verified once more and adjudicated like
any other; `insufficient` or `unreadable` holds the subject for a person.
Nothing is left corroborated in silence.

An arbiter cannot machine-accept a claim that has no supporting assessment, or
one assessed `wrong_scope`, `wrong_unit`, `duplicate`, `insufficient` or
`unreadable`; cannot accept a reading an assessment contradicts; cannot correct
to a value no assessment proposed (assessments carry the value the assessor
read instead, and the arbiter's packet shows it); and cannot reject everything
without an assessment contradicting every candidate. Two identical false
readings with valid-looking anchors are never accepted: the critic contradicts
them, the dispute is verified and adjudicated, and the correction rests on the
assessments' anchors while both false readings end rejected
(`tests/acceptance.mjs`).

## 5. Evidence scope

An anchor is one consistent tuple: source → segment → locator. The segment must
belong to the source, the source to the workflow, and the locator to the
segment's own locator space (a box inside the segment's box; a time range
inside the segment's range). A segment of one source cannot be combined with
another source's id. The kernel validates every anchor against the persisted
segments, not against the envelope's own say-so.

Decision composers receive only the accepted claims of their own subject (and
the claims those claims name as inputs). A decision for subject A cannot cite
evidence about subject B: the validator refuses it.

Every material attribute of a claim value is compared. Two readings that agree
on quantity and disagree on an attribute disagree.

## 6. Repository contract

Both repositories — the in-memory double and the Postgres adapter — implement
`kernel/repository.ts` and pass the same contract tests
(`tests/repository-contract.mjs`, run twice). The contract is built from atomic
operations:

- `leaseTask` grants a lease with a fresh fencing token; a live lease is never
  granted again, to anyone; `heartbeatLease` extends it under its token;
- `transitionTask` and every other transition are compare-and-set on the
  expected current state;
- `submitAttempt` checks, atomically, that the workflow is active and not
  cancelled, that the task is running under the caller's lease token, and that
  the lease has not expired — or refuses;
- `admitTasks` (planned work and children alike) inserts-or-reuses by identity
  with canonical payload comparison, adds missing prerequisites to a reused
  task that has not started, and enforces the workflow, parent, depth and
  edge budgets inside one operation, returning refusals rather than throwing;
- `commitValidatedResult` writes the attempt's raw result (write-once), its
  validation state, the claims, anchors, assessments and disagreements, and the
  task's terminal state in one transaction, and is idempotent: a second commit
  of the same attempt returns what the first wrote;
- `applyDecision` writes the decision, its evidence, and the claim and
  disagreement transitions it entails in one transaction; `holdSubject`
  writes a coverage disagreement, its hold decision, the `needs_human`
  transition and the audit together, idempotently by disagreement key;
- `recordReconciliation` writes what an executor later said became of an
  attempt whose outcome this engine never saw. Only an `outcome_unknown`
  attempt takes one, it is written once, and it is never a reason for the
  machine to run the work again: `core_v2_authorize_task_retry` is a person's
  door and the only way back to the queue.

What an attempt stores as its result is what the executor returned, verbatim —
a string, a null, a malformed object, whatever came back — with its digest
over that same value. The kernel works from a normalised copy it does not
persist, so the record shows what was said and not what the engine made of it.

Cancellation reconciles already-submitted attempts before anything else; the
cancelled-workflow early return in `tick` comes after reconciliation. The lease
duration must exceed the attempt timeout plus a settlement allowance, and the
scheduler heartbeats the lease while an attempt runs.

## 7. Workflow state machine

The engine uses exactly the database's machine and nothing else:

    created → queued → planning → running → ready_for_decision → deciding → completed | partial
                       running ↔ needs_attention
                       any active state → cancelled | failed

- `created`: `core_v2_start_workflow` wrote the row and its outbox command;
- `queued`: a dispatcher claimed the outbox command;
- `planning`: phase A tasks are being admitted;
- `running`: tasks execute; phase B expansion happens here;
- `needs_attention`: nothing more runs by machine on at least one subject and
  a person's decision is required; work on other subjects continues;
- `ready_for_decision`: every task that is not a composition is terminal;
- `deciding`: compositions run;
- `completed` / `partial`: all compositions terminal; `partial` when any subject
  is held for a person or any task ended `failed_known` / `outcome_unknown`.

`tests/workflow-states.mjs` walks every transition the engine takes and refuses
every one the table forbids.

## 8. Identifiers

Every persisted entity has an RFC 4122 version-5 UUID derived from its identity
(`kernel/ids.ts`): the same manifest plans the same task ids, the same attempt
number makes the same attempt id, the same claim key under the same attempt
makes the same claim id. Deterministic ids are what make re-planning, restart
and idempotent admission cheap.

## 9. The database (migration 058)

Tenancy is the organisation. No Core V2 row references a property, a project
document or any other table an existing project owns. Every table carries
`organization_id`; every reference a row carries must resolve to the same
organisation and, where the referenced row has one, the same workflow
(`core_v2_guard_tenancy`).

| Table | What it holds |
|---|---|
| `intelligence_workflows` | one requested analysis: domain pack and version, workflow type, engine version, state, both fingerprints, scope, budget, counters |
| `workflow_outbox` | one start command per workflow, claimed and acknowledged by a dispatcher |
| `workflow_sources` | the immutable sources a workflow reads: kind, opaque uri, content identity (hash or version), size, media metadata |
| `source_segments` | bounded parts of a source, discovered in phase A: kind, ordinal, locator, content hash, status, who discovered them |
| `workflow_tasks` | bounded assignments: phase, task type, role and version, subject, fingerprint, independence group, depth, rounds, lease owner/token/expiry |
| `task_sources` | what a task reads (a source or a segment), ordered |
| `task_dependencies` | what a task waits for |
| `task_target_claims` | the claims a verification task is about |
| `agent_attempts` | one execution: executor kind, family, independence domain, model configuration, packet fingerprint, raw result (write-once), validation state, reconciliation outcome |
| `evidence_claims` | atomic assertions with independence group and domain |
| `claim_inputs` | the claims a derived claim was computed from |
| `evidence_anchors` | where a claim or an assessment points: source, segment, locator, quoted text |
| `claim_assessments` | what a critic or verifier found about one claim |
| `disagreements`, `disagreement_claims`, `disagreement_follow_ups` | conflicts, their candidates, and the one follow-up admitted per round |
| `decisions`, `decision_evidence`, `decision_actions` | traceable decisions, what they rest on, what they require |

Universal vocabularies held by the database:

- task `phase`: `ingest`, `discover`, `analyze`, `compare`, `verify`, `adjudicate`, `derive`, `compose`
- attempt `executor_kind`: `deterministic`, `model`, `human`
- claim `observation_basis`: `observed`, `derived`, `inferred`, `reported`
- anchor `source_kind`: `segment_locator`, `segment`, `source`, `human_record`
- assessment: `supports`, `contradicts`, `insufficient`, `wrong_scope`, `wrong_unit`, `duplicate`, `unreadable`
- disagreement `kind`: `missing`, `value`, `unit`, `scope`, `basis`, `identity`, `duplicate`, `coverage`
- decision `decision_type`: `accept_claim`, `reject_claim`, `reject_all`, `hold`, `proceed`, `request_information`, `supersede`
- decision `authority`: `deterministic_rule`, `adjudicator`, `human`

Domain vocabularies — task types, role keys, subject types, predicates, segment
kinds, units — are text and are validated by the pack in the engine, never
enumerated by the schema.

A terminal attempt does not move at all, with one exception: an attempt that
ended `outcome_unknown` may still receive its `reconciliation_outcome`, once,
because the answer to "what became of this?" can only arrive afterwards.

What the database refuses, for every writer including the service role: an
illegal state move on any of the seven machines; a change to a workflow's
intent; a change to an accepted segment, an anchor under an authoritative claim,
an accepted or rejected claim, a decided decision, a terminal attempt, or a
provider fact once written; a raw result replaced; a task or an edge past the
workflow's budget; a second follow-up in one disagreement round; a claim
accepted with no anchor or from a cut-short attempt; a decision decided with no
accepted supporting claim, or a machine decision with no deciding attempt; a
`reject_all` naming fewer than every candidate or pointing at nothing; a
superseded claim under a standing decision; a row whose references cross
organisations or workflows.

Human doors: `core_v2_cancel_workflow` (owner, admin),
`core_v2_authorize_task_retry` (owner, admin), `core_v2_resolve_disagreement`
(owner, admin, reviewer). `core_v2_start_workflow` is callable by the service
role only until a dispatcher exists — an authenticated caller must not be able
to leave a permanent unconsumed outbox row. The engine's own moves are
`security definer` functions granted to the service role alone.

Provider cost is recorded on the attempt (`provider_request_id`,
`model_reported`, `usage`). The kernel does not reference any ledger table an
existing project owns; a ledger integration is an adapter concern.

## 10. What is proved, and what is not

Proved by tests in this repository, on synthetic sources, against the in-memory
repository and against migration 058 on a local PostgreSQL:

- bounded distribution, blind packets, two-phase expansion, idempotent
  admission;
- fail-closed independence in the four named scenarios;
- corroboration without acceptance; acceptance only by independent
  verification, deterministic source validation, or a person;
- the arbiter's refusals;
- anchor tuple consistency and subject-scoped composition;
- lease fencing, compare-and-set transitions, atomic submission, atomic
  admission, idempotent commit, transactional decisions;
- reconciliation before the cancelled early return; heartbeat and timeout
  accounting;
- the exact workflow machine, deterministic UUIDs, canonical storage of every
  restart-critical field;
- a database-backed run: start → claim outbox → discover → expand → execute
  mocks → persist → resolve or hold → restart → finish with no duplicate
  execution.

Not proved, and therefore not claimed: behaviour against a real provider,
against a real dispatcher, under real concurrency across processes, or on any
source that is not synthetic. The kernel is not called universal, crash-safe,
integrated or deployable anywhere in this repository beyond what the tests
above show.

## 11. Deviations from the v1.2 specification, recorded

The v1.2 specification described Core V2 in construction-drawing terms — pages,
regions, schedules, symbol families, counted marks, releases for pricing. Per
the architecture owner's ruling that no existing project may define the kernel,
those terms are not in the kernel or the schema. `source_pages` and
`page_regions` became `workflow_sources` and `source_segments`;
`extraction_tasks` became `workflow_tasks` with a universal `phase`; the
drawing task types became domain task types; `counted_marks` became a domain
rule on `derived` claims; `release_for_pricing` and `release_for_ordering`
became `proceed` with a domain-supplied subtype in the decision summary;
`property_id` and `project_documents` are gone; the ledger link is gone;
`project_entities`, `entity_aliases` and `entity_relations` are deferred to the
pack that first needs them. The rulings of §2.1 that are independent of the
domain — tenancy proved on every row, no UUID arrays in evidence relationships,
the immutable chain, whole-row immutability, write-once provider facts, two
fingerprints, the disagreement outcomes, reviewers settling disputes — are all
kept.
