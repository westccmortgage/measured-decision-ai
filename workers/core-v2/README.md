# Core V2 agent orchestration engine

The central mechanism of Measured Decision AI is not one model reading one
project. It is:

    one bounded assignment → one agent attempt → atomic claims
      → evidence anchors → comparison → verification → decision

This directory is that mechanism, as pure TypeScript with no dependency on
Supabase, Temporal or any provider SDK. It runs under
`node --experimental-strip-types` like the rest of the repository. Nothing in it
makes a network call; the two run modes and every test close the network
before they start — `fetch` (frozen), `http`, `https`, `net`, `tls`, `dns`,
`WebSocket` and child processes, in `network-guard.ts` — and report that no
door was tried.

## Running it

    cd workers/core-v2
    npm run core-v2:orchestrate -- --dry-run     # the task graph, no executor called
    npm run core-v2:orchestrate -- --simulate    # the whole loop on mocked executors
    bash tests/run.sh                            # every check

No `npm install` is needed — there are no dependencies.

## Agents are roles, not providers

`role-registry.ts` holds sixteen versioned `AgentRoleDefinition`s. Fourteen are
the roles the product needs; two are code the pipeline needs that nobody had to
name (the ingestor and the comparator). No role is named after a provider, and
the registry's own consistency check refuses one that is.

| Role | Executor | Task type | Returns |
|---|---|---|---|
| `workflow_planner` | code | `plan_workflow` | a task graph — never a project conclusion |
| `deterministic_ingestor` | code | `ingest_page` | page identity claims |
| `sheet_cartographer` | model | `map_page_regions`, `read_sheet_register` | region geometry and classification only |
| `schedule_reader` | model, blind ×2 | `extract_schedule` | atomic anchored claims from one schedule region |
| `notes_reader` | model, blind ×2 | `extract_notes` | requirements with note numbers and stated scope |
| `legend_reader` | model | `extract_legend` | what symbols mean — counts nothing |
| `symbol_locator` | model, blind ×2 | `locate_symbol_family` | one instance claim per visible mark, each with its own box — never a total |
| `dimension_reader` | model | `extract_dimensions` | printed dimensions, apart from inferred geometry |
| `relationship_builder` | model | `resolve_relationships` | proposed relations; ambiguity becomes a disagreement |
| `deterministic_comparator` | code | `detect_disagreements` | agreement groups and disagreements — no winner |
| `evidence_critic` | model | `verify_claim` | assessments of one claim against its anchors |
| `disagreement_verifier` | model | `verify_disagreement` | assessments of anonymised claims A/B/C |
| `evidence_arbiter` | model | `adjudicate` | one proposed outcome: accept, correct, reject all, more evidence, a person |
| `deterministic_counter` | code | `count_instances` | counts of accepted unique instances, with every mark named |
| `assembly_calculator` | code | `derive_materials` | calculated quantities with formula and inputs — never an invented input |
| `decision_composer` | model | `compose_decision` | what is known, what conflicts, what can proceed, what must wait, what supports it |

Which executor family serves a model role is the `AgentRouter`'s decision from a
routing profile (`router.ts`). Families are abstract — `reader-family-one`, not
a vendor — and in this PR every family is served by a mock. Each blind group is
paired with its own family by position, so two readers dispatched in one tick
get two families; an independent reading is never sent to a family that
already read the subject and is never served from a cached attempt.

## The loop

    source manifest
        ↓ ingest_page                 one per page              code
        ↓ map_page_regions            one per page              cartographer
        ↓ extract_* / locate_*        one per region / family   specialists, blind pairs where required
        ↓ detect_disagreements        one per blind subject     code
        ↓ verify_disagreement         only where readers differ verifier, bounded rounds
        ↓ adjudicate                  after the verifier        arbiter, bounded rounds
        ↓ count_instances             one per symbol family     code
        ↓ derive_materials            one per family            code
        ↓ resolve_relationships       once                      builder
        ↓ compose_decision            one per subject           composer

`graph-builder.ts` makes the static part deterministically — the same manifest
gives the same task ids, so a restart re-plans nothing. `scheduler.ts` runs it:
release what is no longer waiting, lease within concurrency limits, build each
role's packet, route, execute, validate, persist, and create whatever the result
makes necessary. Verifiers and arbiters exist only for disagreements that were
actually found; follow-ups exist only for requests the follow-up planner
permitted.

## What an agent is handed, and what it may not see

`packet-builder.ts` builds a `WorkPacket` under `visibility-policy.ts`:

- an extractor's packet is blind: it carries the claims of its declared
  dependencies (a legend read before a locator runs) and never those of a
  parallel reader, which is not a dependency and so is not there;
- a critic's or arbiter's packet carries the disputed claims under letters, the
  exact disputed sources, and — for the arbiter — the assessments under the same
  letters and code's own validation notes;
- no packet carries a provider name, an executor family, a URL, a credential, a
  cost, or a count of who agreed. `assertPacketRespectsVisibility` is run over
  every packet before an executor sees it, and the tests run it over every
  packet a simulation produced.

## What comes back, and what is refused

`result-validator.ts` holds every envelope to the product's rules before any of
it becomes evidence. A claim without an anchor; an anchor on a sheet the packet
never handed over, or a box outside the region it names; a locator's total, or
two marks on one box; a reader returning a counted or calculated quantity; an
unknown carrying a zero or a reading; a known value with no reading; an
extractor returning a decision; a critic creating a fact, or anchoring its
verdict somewhere else, or giving two verdicts on one claim; an arbiter resting
on a majority, on anchors the packet never showed, or accepting a reading the
verifier contradicted; a correction that breaks a rule a claim obeys; a
composer citing a claim it was never shown; a code result naming no inputs, or
an input the packet never presented; a malformed envelope — each is refused,
the envelope is kept in full on the attempt, the task is `failed_known`, and
nothing of it enters the record. Validation is all or nothing. A request the
packet did not permit is refused by the follow-up planner, with an audit line,
and does not cost the reading its claims.

## An agent asks; the orchestrator decides

Agents never call each other. An envelope may carry `requestedActions` from a
closed vocabulary; `follow-up-planner.ts` turns a permitted one into at most one
child task, one level deeper, deduplicated by the identity of the work — two
agents asking for the same region to be read make one task, and asking twice
makes one task. Past the policy's depth the answer is a person. A request for
human review makes no task at all.

`orchestration-policy.ts` holds the numbers: concurrency per workflow and per
role, depth, children per parent, attempts per task, blind readers per subject,
critic and arbiter rounds, tasks per workflow, disagreements verified per
subject, and how long an attempt may take before its outcome is unknown. Two
rounds of criticism that cannot read the source, an arbiter that asks for the
same evidence twice, a request past the depth, a subject whose readers differ
everywhere, a verifier or arbiter that failed — each stops the branch and
hands it to a person, with the reason on the disagreement; the rest of the
workflow continues.

## What is accepted, and by whom

Nothing becomes accepted evidence by a model's say-so:

- two blind readers agreeing on an anchored, known value — code accepts one
  representative by rule (`corroborated_by_independent_anchored_readings`).
  One reader agreeing with itself is one reading; two readers agreeing that a
  value is unreadable is corroborated unreadability, not a fact;
- a single reading nobody else made (a dimension) — accepted when a critic
  supports it on an anchor at the same place. A blind reading is never accepted
  on a critic's word alone: its comparison decides;
- a dispute — accepted, corrected or rejected only by an adjudication whose
  evidence the packet actually showed, that no assessment contradicts, and that
  cites the accepted reading's own anchor or an assessment supporting it. A
  rationale that counts readers is refused whatever else it says;
- code results — counted marks and calculated quantities — accepted by rule,
  and only code may return them: a reader returning a `drawn_quantity` is refused.

A reading that said it could not finish keeps its claims, compared and never
accepted (`incompleteSourceAttempt`).

## Restart, cancellation, and what is never paid for twice

A lease is granted once. Two workers that share a name are two workers; the
second gets nothing until the first's lease expires. Every tick reconciles
expired leases: a task still `leased` goes back to the queue with its prepared
attempt closed; one `running` whose attempt was submitted ends
`outcome_unknown` and is never requeued; one whose attempt had already ended
fails known with the answer still on the attempt. A stop that arrives while a
packet is being built closes the attempt unsent; one that arrives after
submission is reconciled, never cancelled. A cancelled workflow re-planned
stays cancelled. A workflow with any task still open ends `partial`, never
`completed`.

Two places where this engine is stricter than migration 058, on purpose: the
database permits `outcome_unknown → queued` under an authorised retry, which
no code path here takes; and an attempt that ended `failed_known` after
submission is treated, as in the database's trigger, as never sent — a
provider that answered "failed" is not re-run automatically either way,
because the task is then terminal.

## Persistence

`repository.ts` is the interface the scheduler writes through, and an in-memory
implementation that enforces the same state machines as migration 058
(`transitions.ts` mirrors its transition table). The mapping is one-to-one and
no other table is needed:

| Orchestration concept | Core V2 table |
|---|---|
| overall execution | `intelligence_workflows` |
| assignment | `extraction_tasks` |
| dependency edge | `task_dependencies` |
| actual execution | `agent_attempts` |
| atomic output | `evidence_claims` |
| source location | `evidence_anchors` |
| critic result | `claim_assessments` |
| critic evidence | `claim_assessment_anchors` |
| conflict | `disagreements` |
| competing claims | `disagreement_claims` |
| adjudicated result | `decisions` |
| decision provenance | `decision_evidence` |
| required next work | `decision_actions` |

There is no table of agents, messages or conversations, and chat history is not
orchestration state. The task, attempt and claim records are the state.

The packet a role receives (`packet-builder.ts`) carries claims with their
scope and locators cut to the keys the manifest defines — whatever else a
reader wrote there, its group or a name, travels to nobody, while the record
keeps the original. The comparator alone is told which blind groups read a
subject, so a reader that returned nothing is still a reader that read, and
its silence is recorded as `missing`.

**One vocabulary gap, recorded here for PR 2.** Three task types this engine
needs are not yet in `extraction_tasks_task_type_check`: `plan_workflow`,
`verify_claim` and `compose_decision`. They are listed in
`contracts.ts` as `TASK_TYPES_NOT_YET_IN_DATABASE`; the persistence adapter of
PR 2 adds them to that check in one line. This commit does not touch
migration 058.

## Not in this PR

No Temporal, no worker deployment, no provider adapter, no owner interface, no
spatial work, no production data. The synthetic fixture in
`fixtures/synthetic-project.ts` is two invented documents with invented hashes;
`tests/nothing-real.mjs` walks every file in this directory, whatever it is
called, and asserts that no client project is named in any of them — the words
it looks for are held as digests, so the directory does not name one in its
own denylist — and that the engine imports no provider SDK, no transport and
nothing of Node beyond `node:crypto` (the network guard imports the
transports only to close them; the CLI imports `fs` and `url` only to know it
was run directly).

## What the skeptics found

Before this commit the engine was read and probed by six independent
reviewers told to break one guarantee each — visibility, spending limits,
recovery, evidence discipline, decision integrity, and "nothing real". What
they found is fixed and kept as tests: `tests/adversarial.mjs`,
`tests/adversarial-recovery.mjs`, `tests/adversarial-evidence.mjs`,
`tests/adversarial-guard.mjs`, `tests/cli-entry.mjs`.
