# Measured Decision Core V2 — implemented schema (PR 1)

This document records what migration `058_core_v2_schema.sql` actually built, how
it maps onto the Core V2 specification (version 1.1, 2026-09-07), and every place
where the implementation had to decide something the specification left open or
where it collided with the schema that already exists.

Nothing in PR 1 runs. There is no worker, no orchestrator, no provider call, no
Studio screen and no production migration. What exists is the record those things
will later have to write into, and the rules that stop them writing something the
product could not defend.

## The one sentence everything here serves

    decision -> accepted claim(s) -> source anchor(s) -> immutable source revision

Every constraint, trigger and function below exists to make a break in that chain
impossible in the database rather than merely unusual in the code.

## Tables, and where they come from

Specification §5.1 – §5.17, in the order the specification names them.

| Specification | Table | Notes |
|---|---|---|
| 5.1 `intelligence_workflows` | `public.intelligence_workflows` | Row id is the durable workflow id. |
| 5.2 `workflow_outbox` | `public.workflow_outbox` | One start command per workflow, `workflow_id` unique. |
| 5.3 `source_pages` | `public.source_pages` | Unique `(document_id, page_index)`. |
| 5.4 `page_regions` | `public.page_regions` | Self-referencing `parent_region_id`; normalised bbox enforced. |
| 5.5 `extraction_tasks` | `public.extraction_tasks` | Unique identity index over type, subject, fingerprint, contract and independence group. |
| 5.6 `task_dependencies` | `public.task_dependencies` | Primary key on both task ids. |
| 5.7 `agent_attempts` | `public.agent_attempts` | Unique `(task_id, attempt_no)`; nullable `ai_run_id` into the existing cost ledger. |
| 5.8 `evidence_claims` | `public.evidence_claims` | |
| 5.9 `evidence_anchors` | `public.evidence_anchors` | Check that each `source_kind` carries the reference it needs. |
| 5.10 `project_entities` | `public.project_entities` | Partial unique index on active identities. |
| 5.11 `entity_aliases` | `public.entity_aliases` | |
| 5.12 `entity_relations` | `public.entity_relations` | |
| 5.13 `claim_assessments` | `public.claim_assessments` | |
| 5.14 `disagreements` | `public.disagreements` | Resolved requires `resolution_decision_id`. |
| 5.15 `decisions` | `public.decisions` | Decided requires exactly one decider. |
| 5.16 `decision_evidence` | `public.decision_evidence` | `supports` / `contradicts` / `context`. |
| 5.17 `decision_actions` | `public.decision_actions` | |

Deferred to the PR that first needs them, per §21:

- §5.18 `agent_capability_scores` — provider routing and benchmarking (PR 4 / §18).
- §5.19 – §5.22 spatial frames, registrations, anchors and tracks — PR 9.

The specification's deliverable for PR 1 is "the minimum V2 schema through
`decisions`, `decision_evidence`, `decision_actions`, and `workflow_outbox`",
which is what the table above is. Adding the spatial tables now would create
seventeen columns of state that nothing can write and nothing can read, which is
the opposite of what a schema PR should leave behind.

## State machines

`public.core_v2_transition_allowed(machine, from, to)` holds every legal move for
the six machines in §8.1 – §8.6, in one list. A `before update` guard on each
table refuses any move that is not in it — for **every** writer, the service role
included. The tests attempt all 386 ordered state pairs across the six machines
and compare each result against the table.

Named moves live in `core_v2_workflow_transition`, `core_v2_task_transition`,
`core_v2_attempt_transition`, `core_v2_claim_transition`,
`core_v2_disagreement_transition` and `core_v2_decision_transition`. These are
granted to `service_role` only. They are not a permission boundary — the service
role bypasses row-level security anyway — they are the single place a transition
is written, so the guard is never routed around by hand.

Two moves are refused even though the state table permits them, because the
machine alone cannot see the reason:

- `leased -> queued` when any attempt for that task has reached `submitted` or
  beyond. The provider may already be running; requeueing would buy it twice.
- `* -> cancelled` under the same condition. Cancelling is the same problem
  wearing a friendlier word: unsent work stops, sent work is reconciled.

And two moves are refused unless a person authorised them in this session:
`outcome_unknown -> queued` and `failed_known -> queued`. The only door is
`core_v2_authorize_task_retry`, which requires owner or administrator, records
who and when on the task, writes an audit event, and sets a session variable the
guard checks — so the authorisation is spent on exactly one move.

## The deferred checks, and why they are deferred

Three rules cannot be expressed as row constraints because they span tables, and
cannot be checked immediately because the ordinary write path is several
statements in one transaction:

| Constraint trigger | Fires on | Refuses |
|---|---|---|
| `core_v2_claim_evidence_check` | `evidence_claims` insert/update | A claim that is `verified` or `accepted` with no `evidence_anchors` row; a `counted_marks` quantity of *n* with fewer than *n* individually marked anchors; an `accepted` claim flagged `incomplete_source_attempt`. |
| `core_v2_anchor_removal_check` | `evidence_anchors` delete | Removing the last anchor from under a verified or accepted claim. |
| `core_v2_decision_evidence_check` | `decisions` insert/update | A `machine_decided` or `human_decided` decision with no `decision_evidence` row of link `supports` pointing at an `accepted` claim. |

All three are `deferrable initially deferred`, so they are evaluated when the
transaction commits. A transaction may therefore accept a claim and then add its
anchors; it may not *end* with an accepted claim that has none.

The tests exercise both directions: they build the valid case and force the
checks with `set constraints … immediate` to prove it survives, and they build
each violation inside a rolled-back block to prove it does not.

An individually marked anchor means `locator ->> 'mark'` is present. A count of
36 needs 36 distinct marks, not one reference to the sheet the marks are on.

## Row-level security

Every one of the seventeen tables has row-level security on and exactly one
policy: `select` for `public.is_org_member(organization_id)`. There is no
insert, update or delete policy anywhere in this migration, so:

- an organisation member reads their project's V2 record;
- another organisation sees nothing, and a write from it reaches nothing;
- a signed-out visitor sees nothing and can execute nothing;
- the browser cannot move machine state at all, whatever it sends;
- the worker writes as the service role, which is not subject to these policies.

People act through four functions, each of which checks the asker:

| Function | Who | What it does |
|---|---|---|
| `core_v2_start_workflow` | owner, admin | Validates membership, validates that every named document belongs to that property, computes the source fingerprint server-side, refuses a second live workflow over the same sources unless authorised, and writes the workflow **and** its outbox row in one transaction. |
| `core_v2_cancel_workflow` | owner, admin | Stops unsent work, leaves sent work to reconcile, returns the three counts, audits. |
| `core_v2_authorize_task_retry` | owner, admin | The only path out of `outcome_unknown` / `failed_known`. |
| `core_v2_resolve_disagreement` | owner, admin | Accepts one competing claim or records a human correction, rejects the others without deleting them, and creates the immutable human decision that names all of them. |

`core_v2_source_set_fingerprint` is `SHA-256` over the ordered document ids with
their storage path, byte size and revision label. A browser may state what it
believes the fingerprint is and be told it is stale; it never supplies the value.

## One project, all the way down

§16.8: source and evidence records cannot cross organisations through ids,
signed URLs, search, comparison, or joins. Since the browser cannot write any
V2 table, the risk is not a form post — it is a worker, a fixture or a later
migration joining a row of one project to a row of another and producing a
decision that opens somebody else's drawing.

`core_v2_guard_tenancy` runs before insert and update on every table that
carries a reference, with the column/parent pairs as trigger arguments, and
refuses any foreign key whose parent belongs to a different property. That
covers the outbox's workflow, a page's document, a region's page and parent, a
task's workflow and lineage, a dependency's two tasks, an attempt's task, a
claim's workflow, attempt, superseded claim and entity, an anchor's claim,
document, page, region and evidence item, an entity's workflows, an alias's
entity and attempt, a relation's entities and decision, an assessment's claim
and attempt, a disagreement's workflow and resolving decision, a decision's
workflow, entity, deciding attempt and superseded decision, decision evidence's
decision, claim and anchor, and an action's decision and completion evidence.

`core_v2_start_workflow` applies the same rule to the sources a person names:
every document must belong to the property being read, and a borrowed id cannot
ride along with a real one.

## Audit

`core_v2.workflow.started`, `core_v2.workflow.cancelled`,
`core_v2.task.retry_authorized`, `core_v2.disagreement.resolved`,
`core_v2.decision.superseded` and `core_v2.claim.superseded` are written into the
existing `public.audit_events` table — the last two by trigger, so a supersession
cannot happen without one. This covers §22's required audit list.

## V1 is untouched

This migration contains no `alter` and no `update` against any V1 table. The
invariant suite fingerprints `project_documents`, `document_baselines`,
`plan_spaces`, `project_requirements`, `material_takeoffs`,
`plan_analysis_jobs`, `plan_analysis_chunks`, `evidence_items`, `capture_tasks`
and `ai_runs` before the Core V2 section and compares the fingerprint afterwards.
The §3.3 read-only projections are not built here; they belong to PR 8.

## Divergences and additions

The specification asks that a conflict with the existing schema be documented
before implementation rather than resolved unilaterally. These are the ones
found. Nothing on this list was changed on my own authority.

### 1. The cost ledger cannot yet name a Core V2 attempt — open, unresolved

`agent_attempts.ai_run_id` references `public.ai_runs`, but that table's
`ai_runs_process_key_check` admits only the seven V1 process keys
(`plan-analyze`, `spatial-analyze`, `document-classify`, `document-evidence`,
`field-quality-check`, `project-search`, `compare-readings`). §16.6 requires
every provider call to link to `ai_runs`, and §5.7 requires it for every call
that may have been billed. A Core V2 extraction attempt has no key it may use.

Nothing in PR 1 writes an `ai_runs` row, so nothing is broken today. PR 2 or PR 4
cannot link a paid attempt to the ledger without a decision here.

**Minimal option, not applied:** extend the check with one key per registered
task type, prefixed so the ledger can be read by generation — for example
`core-v2:extract_schedule`. A larger option, if the architecture owner prefers,
is to replace the enumeration with a `process_registry` table and a foreign key,
which stops every future process needing a migration.

### 2. Reject-everything has no shape as a decided decision — open, needs a ruling

§5.16 says a decision cannot become decided without at least one supporting
accepted claim, "except a cancellation or administrative decision". The
`decision_type` vocabulary in §5.15 contains no cancellation or administrative
type. The implementation treats `supersede` as the administrative type and
exempts it; every other decided decision must rest on an accepted claim.

The consequence is deliberate and worth naming: an adjudication that rejects
*all* competing claims cannot currently be recorded as a decided decision,
because there is nothing accepted to hang it on. `core_v2_resolve_disagreement`
therefore offers `correct` — the person supplies the corrected value and the
source they read it off, which becomes a human claim with a `human_record`
anchor, is accepted, and supports the decision — and `needs_more_evidence`,
which returns the disagreement to `needs_human` and creates no decision at all.

**Minimal option, not applied:** add `reject_all` to the decision vocabulary
together with an explicit exemption in the evidence rule, or require that a
reject-all adjudication first accept a claim stating what the source does show.
This matters from PR 5 onwards, not before.

### 3. Who may settle a disagreement — §15 and §22 disagree, narrower implemented

§22's deliverable 4 reads "owner/admin initiate/cancel/resolve". §15's
`POST /v2/disagreements/{id}/resolve` reads "Owner/admin/reviewer action". The
same call, two role sets, in the same specification.

`core_v2_resolve_disagreement` implements the narrower one: owner and
administrator. Widening a permission later is a one-line migration; narrowing one
after people have relied on it is a conversation with customers. The product
invariant — a human decision, recorded immutably, naming every claim it kept — is
unaffected either way, which is why this was implemented rather than stopped on.

**Minimal option if §15 is the intended rule:** add `'reviewer'` to the role array
in that one function. Nothing else changes.

### 4. Columns added beyond §5, each because a stated rule had nowhere to live

| Column | Table | Why |
|---|---|---|
| `duplicate_authorized_by` | `intelligence_workflows` | §5.1 refuses a duplicate start "unless explicitly forced". Without a column, the unique index has no exception and the authorised second reading could not exist. |
| `retry_authorized_by`, `retry_authorized_at` | `extraction_tasks` | §8.2 and §9.3 require explicit human action to re-run a terminal task, and §9.3 requires the decision to be auditable. |
| `incomplete_source_attempt` | `evidence_claims` | §8.3 names the flag by that meaning: claims parsed from an `output_limited` attempt "cannot become accepted without another complete verification". |
| `supersedes_decision_id` | `decisions` | §8.6 says a decided record is superseded, never edited; the lineage needed somewhere to point. |
| `organization_id`, `property_id` | `task_dependencies`, `decision_evidence`, `entity_relations`, `claim_assessments` | §5's preamble requires them on all V2 tables; the per-table column lists for these four name only the join columns. Carrying them keeps one uniform RLS rule instead of four different joins. |

### 5. Choices the specification left to the implementation

- **`text` + `check` rather than Postgres enums.** Migrations 048–057 use this
  idiom; adding a value is one line and takes no exclusive lock, and
  `pg_get_constraintdef` makes the vocabulary directly testable.
- **`sha256()`, built in, rather than pgcrypto `digest()`.** No extension and no
  `search_path` question inside a `security definer` function.
- **Closed vocabularies where §5 ends a list with "etc."** — `subject_type`,
  `entity_type`, `region_kind`, `task_type`. A closed list is what makes the
  "a component type is not an instance" invariant testable. Widening one is a
  one-line migration.
- **`counted_marks` made concrete** as distinct `locator ->> 'mark'` values,
  because §5.9's "separate instance/mark anchors" needs a countable form.
- **Region and anchor boxes are normalised 0..1**, enforced by
  `core_v2_is_normalised_bbox`, so a box found at one rendering resolution means
  the same thing at another.

## The Noble fixture

`supabase/fixtures/core_v2_noble.sql` builds S-2, S-3 and S-4 as V2 holds them:
three page identities and eight regions — schedules, plan views, a legend,
general notes, a title block — from invented geometry and invented hashes. It
contains no client drawing, no rendered page and no provider response, and it
defines its function in `pg_temp` so it cannot be mistaken for data later.

    \ir supabase/fixtures/core_v2_noble.sql
    select pg_temp.core_v2_noble_fixture('<organisation>', '<property>', '<document>');

## Running the tests

    bash supabase/tests/run.sh

The Core V2 section is at the end of `supabase/tests/security_invariants.sql`.
It covers every invariant §22 requires: cross-organisation reads and writes,
borrowed source ids, workflow/outbox atomicity, duplicate fingerprints, the full
transition matrix, lease expiry before and after submission, unknown outcomes,
`output_limited` retention, zero versus null, the four entity types, the four
observation bases, counted marks, decided decisions without evidence,
disagreement resolution, supersession, the audit trail, and V1 left unchanged.
