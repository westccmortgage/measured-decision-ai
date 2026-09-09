# Core V2 — the universal decision kernel

Bounded work distribution → independent analysis → evidence → disagreement
detection → targeted verification → adjudication → traceable decision.

This directory is the kernel of that loop and nothing else. It knows what a
source, a segment, a claim, an anchor, an assessment, a disagreement and a
decision are; how to fan bounded assignments out to executors that are kept
blind and independent; how to compare, verify and adjudicate what comes back;
how to recover after a crash without repeating paid work; and where to stop.
It does not know what a drawing, a recording, an invoice or a contract is.
That knowledge lives in a **domain pack**, outside the kernel, and the only
packs in this repository are synthetic.

No provider is called from here. No client, property or project appears here.
The network is sealed before any test or command-line run begins.

## Layout

    kernel/      the universal kernel — contracts, state machines, ids, policy,
                 roles, routing, packet building, validation, comparison,
                 follow-ups, the repository contract, the in-memory repository,
                 the scheduler, the network guard
    domains/     the seam (kernel/domain.ts is the interface) and two synthetic
                 packs: synthetic-records (sources that declare sheets; tables
                 and notes are discovered; entries are read blind; totals are
                 derived) and synthetic-transcripts (recordings that declare
                 nothing; scenes are discovered as time ranges; speaker turns
                 are read blind; totals are derived). Each pack ships scripted
                 executors that answer from an invented truth. mock-executor.ts
                 is the scripted stand-in for a model; simulate.ts assembles a
                 scheduler for a test or a dry run.
    postgres/    a dependency-free wire client and the repository adapter for
                 migration 058 (supabase/migrations/058_core_v2_schema.sql)
    tests/       one suite per rule, run by tests/run.sh
    cli.ts       --dry-run and --simulate on the synthetic fixtures only

## The boundary

The kernel keeps: workflow, task and attempt lifecycle; bounded DAG
scheduling; leases with fencing tokens and recovery; work packets and result
envelopes; routing and independence enforcement; evidence claims, anchors,
assessments, disagreements and decisions; budgets, cancellation and audit.

A pack supplies (`kernel/domain.ts`): its roles (analysts, discoverers and
deterministic derivers only — a pack cannot add a critic, an arbiter or a
composer, and cannot redefine a kernel role); which role discovers the
segments of a source that declares none; `expand`, which turns persisted
segments into bounded assignments; `decisionSubjects`; domain rules on a
claim; unit and key normalisation; what "related", "reference" and "linked"
segments are; and `derive`, the code that computes derived claims. A pack
cannot reach the repository, the scheduler, an executor or another pack.

Pack task types are namespaced `<pack>:<name>`. The registry refuses a pack
that names a provider, serves a kernel task type, or ships a deriver that is
not deterministic code (`tests/registry.mjs`).

## Running it

    node --experimental-strip-types --no-warnings cli.ts --dry-run [--pack records|transcripts]
    node --experimental-strip-types --no-warnings cli.ts --simulate [--pack records|transcripts] [--seed name]
    bash tests/run.sh

Node 22 or later; no build step, no dependencies. The two database-backed
suites boot a throwaway local PostgreSQL 16 cluster under /var/tmp and never
touch anything else.

## What the tests prove

Each suite states its rule in its title; each check is a sentence about the
product. Read `docs/core-v2.md` for the design and its section numbers.

- `registry.mjs` — roles are work, never providers; the kernel's roles cannot
  be redefined; code never routes to a model.
- `expansion.mjs` — two phases: what a source declares is persisted at ingest,
  what a discoverer finds is persisted under its attempt, and the pack expands
  the rest; expansion twice creates nothing; every id is an RFC 4122 v5 UUID
  derived from identity.
- `blindness.mjs` — an analyst's packet carries no other reader's answer; a
  judge sees claims under letters and nothing that says who wrote them.
- `independence.mjs` — independence fails closed: one family, two aliases of
  one executor, simultaneous dispatch, exhausted visual families; the domain on
  every attempt is the registry's, not a label.
- `acceptance.mjs` — agreement is not proof; acceptance needs an independent
  verification supporting that exact claim, a deterministic rule against the
  source, or a person; two identical false readings are never accepted.
- `evidence-scope.mjs` — an anchor is one consistent tuple; a composer sees
  only its own subject; every material attribute is compared.
- `follow-up.mjs` — an agent asks, the orchestrator decides; one follow-up per
  round; one level deeper each time; a person is the answer past the limits.
- `workflow-states.mjs` — the engine's state machines are the database's, read
  from the migration; no `created → running`, no `running → completed`.
- `recovery.mjs` — fencing tokens, compare-and-set, atomic submission,
  timeouts that keep their slot, abort signals, restart without repeating work,
  cancellation that reconciles before it returns.
- `budgets.mjs` — every limit is a place the run stops of its own accord.
- `transcripts.mjs` — a second domain with time-range locators runs on the
  same kernel; the kernel's text contains neither pack's vocabulary.
- `repository-contract.mjs` — the same contract checks against the in-memory
  repository and the Postgres adapter.
- `postgres-e2e.mjs` — the whole chain against migration 058, with a restart
  in the middle and no duplicate execution.
- `nothing-real.mjs`, `network-guard.mjs`, `cli-entry.mjs` — nothing of a
  client or a provider anywhere; every network door closed; the command line
  runs only on invented sources.

## What is not here, and is not claimed

- **No provider adapter.** Nothing here can call a model. The scripted
  executors answer from a fixture; a real adapter would implement
  `AgentExecutor` behind the same registry, and nothing in the kernel would
  change.
- **No dispatcher.** `core_v2_start_workflow` writes an outbox command; the
  scheduler claims it in `plan()`. Nothing in this repository consumes the
  outbox on its own, and the migration grants the start door to the service
  role only, so no authenticated user can leave an unconsumed command behind.
- **No deployment, no production data.** The Postgres adapter is tested
  against a throwaway local cluster with the repository's own migrations. It
  has not run against any hosted database.
- **"Crash-safe" means what `recovery.mjs` and `postgres-e2e.mjs` show:** a
  lease expires and is reclaimed under a new token; a submitted attempt whose
  worker died becomes `outcome_unknown` and is never retried; a scheduler
  started on the same record after a crash plans nothing new and executes
  nothing twice. It does not mean every failure mode has been exercised.
- **Human decisions** enter through `core_v2_resolve_disagreement` in the
  migration; there is no user interface for them here.
- **Construction drawings** are not in this directory. If they come, they
  come as one pack among others, with the same rights as the synthetic ones.

## Writing a pack

Implement `DomainPack` from `kernel/domain.ts`, put it under `domains/<id>/`,
give every task type the `<id>:` prefix, and run
`new RoleRegistry(pack).assertConsistent()` first. Your fixtures must be
invented and your executors must be scripted; nothing under `domains/` may
name a client, a provider or a project.
