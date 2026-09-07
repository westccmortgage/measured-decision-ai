# Measured Decision Core V2 — implemented schema (PR 1)

Governing specification: **Core V2 v1.2, 2026-09-07**, including the architecture
rulings in §2.1 from the review of this pull request.

This document records what migration `058_core_v2_schema.sql` actually built, how
it maps onto the specification, and the two places where the implementation had
to choose something the specification leaves open. The three deviations the first
draft raised are gone: §2.1 answered all three, and the answers are implemented.

Nothing in PR 1 runs. There is no worker, no orchestrator, no provider call, no
Studio screen and no production migration. What exists is the record those things
will later have to write into, and the rules that stop them writing something the
product could not defend.

## The one sentence everything here serves

    decision -> accepted claim(s) -> source anchor(s) -> immutable source revision

Every constraint, trigger and function below exists to make a break in that chain
impossible in the database rather than merely unusual in the code — and to keep
it unbroken *afterwards*, which is the part the first draft missed. It is not
enough to check the chain when a claim is accepted; the evidence underneath it
must be unable to move, be repointed, or disappear while the decision stands.

## Tables, and where they come from

Specification §5.1 – §5.17, in the order the specification names them.

| Specification | Table | Notes |
|---|---|---|
| 5.1 `intelligence_workflows` | `public.intelligence_workflows` | Row id is the durable workflow id; carries both fingerprints. |
| 5.2 `workflow_outbox` | `public.workflow_outbox` | One start command per workflow, `workflow_id` unique. |
| 5.3 `source_pages` | `public.source_pages` | Unique `(document_id, page_index)`; append-only. |
| 5.4 `page_regions` | `public.page_regions` | Self-referencing `parent_region_id`; normalised bbox; frozen once accepted. |
| 5.5 `extraction_tasks` | `public.extraction_tasks` | Unique identity over type, subject, fingerprint, contract, independence group. |
| 5.6 `task_dependencies` | `public.task_dependencies` | Primary key on both task ids. |
| 5.7 `agent_attempts` | `public.agent_attempts` | Unique `(task_id, attempt_no)`; one-to-one `ai_run_id`. |
| 5.8 `evidence_claims` | `public.evidence_claims` | |
| 5.9 `evidence_anchors` | `public.evidence_anchors` | Each `source_kind` must carry the reference it needs. |
| 5.10 `project_entities` | `public.project_entities` | Partial unique index on active identities. |
| 5.11 `entity_aliases` | `public.entity_aliases` | |
| 5.12 `entity_relations` | `public.entity_relations` | |
| 5.13 `claim_assessments` | `public.claim_assessments` | + `public.claim_assessment_anchors`, PK `(assessment_id, anchor_id)`. |
| 5.14 `disagreements` | `public.disagreements` | + `public.disagreement_claims`, PK `(disagreement_id, claim_id)`, with `position` and `role`. |
| 5.15 `decisions` | `public.decisions` | Includes `reject_all`; decided requires exactly one decider. |
| 5.16 `decision_evidence` | `public.decision_evidence` | `supports` / `contradicts` / `context`; closed once decided. |
| 5.17 `decision_actions` | `public.decision_actions` | |

Deferred to the PR that first needs them, per §21: §5.18 `agent_capability_scores`
(PR 4 / §18) and §5.19 – §5.22, the spatial frames, registrations, anchors and
tracks (PR 9).

## §2.1.1 — Tenant identity is a pair, not two labels

`core_v2_guard_tenancy` runs before insert and update on all nineteen tenant
tables, for every writer including the service role, and enforces three things:

1. the property named on the row really belongs to the organisation named on it —
   `properties.organization_id = NEW.organization_id`;
2. neither `organization_id` nor `property_id` ever changes afterwards;
3. every foreign key the row carries resolves to that same property.

Its two lookups (`core_v2_property_of`, `core_v2_organization_of_property`) are
`security definer`, so the guard answers "another project" rather than "no such
project" regardless of what the caller can see.

The tests attack all three with `reset role` — the service role, which bypasses
row-level security entirely. An authenticated insert failing for want of a write
policy proves nothing about a worker, so it is not used as proof anywhere.

`core_v2_source_set_fingerprint` now requires `is_org_member` on the property's
organisation, so it cannot be used as an existence oracle for another project's
documents. Anonymous execution is revoked.

## §2.1.2 — Indirect evidence links are normalized

`claim_assessments.anchor_ids` and `disagreements.claim_ids` are gone. In their
place:

- `claim_assessment_anchors(organization_id, property_id, assessment_id, anchor_id)`
- `disagreement_claims(organization_id, property_id, disagreement_id, claim_id, position, role)`

Both have real foreign keys (`on delete restrict` into evidence), RLS, the tenancy
guard, and indexes on the reverse direction. `disagreement_claims` additionally
proves that every claim belongs to the disagreement's **workflow**, not only its
property: a disagreement compares claims of one reading. `role` distinguishes
`candidate`, `missing_counterpart` and `context`, so an absent counterpart is a
row that says so rather than a borrowed or invented UUID. No array survives as a
second source of truth.

## §2.1.3 and §8.6.1 — The evidence chain is immutable after authority attaches

| Rule | How |
|---|---|
| Source pages are append-only | `core_v2_guard_source_page` refuses every update and every delete. A corrected render is a new page. |
| Accepted regions are frozen | `core_v2_guard_region` — a proposed region may still be refined; once accepted, rejected or superseded, every field is frozen and only the status may move along the `region` machine. |
| Anchors under authoritative claims are frozen | `core_v2_guard_anchor` refuses update and delete when the claim is `verified`, `accepted`, `rejected` or `superseded`. An anchor is never repointed at another claim, region or page. |
| Anchors cited by decided decisions are frozen | the same guard, via `decision_evidence` → `decisions`. |
| Evidence of a decided decision is closed | `core_v2_guard_decision_evidence` refuses insert, update, reassignment and delete once the decision is `machine_decided` or `human_decided`. More evidence produces a superseding decision. |
| A link naming both claim and anchor is honest | the anchor must be one of that claim's own anchors. |
| Superseding a supporting claim supersedes its decision | `core_v2_check_superseded_claim_decisions`, deferred: both move in one transaction, or neither does. |
| The source under an anchor cannot be deleted | anchor and page foreign keys are `on delete restrict`, so deleting a `project_document` that Core V2 anchored to is refused. |

The deferred checks fire from **both** sides. `core_v2_anchor_removal_check` runs
on anchor insert, update and delete; `core_v2_decision_evidence_link_check` runs
on evidence insert, update and delete. Validating only when the claim or decision
row changes would let the evidence be pulled out afterwards.

## §2.1.4 — Accepted claims and decided decisions are wholly immutable

`core_v2_frozen_except(old, new, allowed[])` diffs the two versions of a row as
JSON and returns the first business field that moved. Guards compare **every**
column rather than a list somebody remembered to write, so a column added in a
later migration is protected the day it exists.

| Record | May change | Everything else |
|---|---|---|
| Accepted or rejected claim | `status` (only to `superseded`), `updated_at` | frozen |
| Machine- or human-decided decision | `status` (only to `superseded`), `superseded_at`, `updated_at` | frozen |
| Terminal attempt | `updated_at` | frozen |
| Workflow | state, `temporal_run_id`, `cancel_requested_at`, the three unit counts, error code/message, `started_at`, `finished_at`, `updated_at` | intent frozen: organisation, property, type, engine version, requester, scope, both fingerprints, duplicate authorisation |
| Outbox row | `state`, `attempt_count`, `available_at`, `last_error`, `updated_at` | `workflow_id`, `command`, `payload` frozen |

## §2.1.5 and §2.1.6 — Provider facts are write-once, on one ledger key

`ai_runs_process_key_check` gains exactly one value: `core-v2`. Not one key per
task type — the task type stays on `extraction_tasks`, contract version and input
fingerprint distinguish the work, and `job_table`/`job_id` name the attempt. No V1
row is read, written or reinterpreted by that change.

Then, on `agent_attempts`:

- `ai_run_id` is unique where non-null — one attempt, one ledger row;
- a provider attempt (`openai`, `anthropic`, `google`) at `submitted` or later
  **requires** an `ai_run_id`;
- the ledger row must belong to the same organisation and property;
- `output_limited` requires a stored `raw_response_path` and both `received_at`
  and `finished_at` — an attempt that ran out of output with nothing kept cannot
  exist;
- `provider_request_id`, `ai_run_id`, model, `model_reported`, `output_limit`,
  raw-response path and hash, `duration_ms`, error code/message and all four
  timestamps are write-once from the moment each is recorded; `usage` and
  `reasoning_configuration` likewise once non-empty;
- a terminal attempt rejects changes to every business field.

## §2.1.7 and §2.1.8 — Two fingerprints, over identity that means something

`source_set_fingerprint` is SHA-256 over, per document in id order: the immutable
content identity, the storage provider, bucket and path, the byte size, the
revision label and the issue date.

The content identity (`core_v2_source_identity`) is either a whole-file digest —
`sha256` with `content_hash_algorithm` and `content_hash_scope = 'whole-file'` —
or the storage system's `object_version_id`. Path and byte size alone are not
accepted: re-uploading a different drawing to the same key at the same size would
leave both unchanged. A document with neither is **refused** as a Core V2 source,
naming the file.

`request_fingerprint` is SHA-256 over workflow type, the source-set fingerprint,
the canonical requested scope and the engine version. `core_v2_canonical_json`
sorts object keys and array members, so the same question written in another
order is the same question. **Duplicate-active protection uses the request
fingerprint**, so reading three sheets and reading the whole set are two requests
over the same documents and neither blocks the other.

Both columns already existed on `project_documents` (migrations 006 and 018), so
no V1 table was altered to make this work.

## §2.1.9, §2.1.10, §2.1.11 — The disagreement rulings

`core_v2_resolve_disagreement` takes four outcomes:

| Outcome | What happens |
|---|---|
| `accept_claim` | The named claim is accepted; every other competing claim is rejected and linked as `contradicts`; a human decision names all of them. |
| `correct` | None was right and a person read the source: a new human claim with a `human_record` anchor is accepted and supports the decision; the readings it replaces are rejected and kept. |
| `reject_all` | A real adjudication with a real burden. Every competing claim is rejected, kept and linked as `contradicts`; at least one source anchor must be supplied saying what the drawing does show; the decision type is `reject_all`; the disagreement resolves through it. |
| `needs_more_evidence` | **Not a resolution.** The disagreement moves to `needs_human`, no decision is created, and the audit event is `core_v2.disagreement.more_evidence_requested`. It never writes `core_v2.disagreement.resolved`. |

The deferred `core_v2_check_decision_evidence` enforces the `reject_all` burden
directly: contradiction links to every `candidate` claim of the disagreement it
settles, plus at least one anchor-bearing `context`/`supports` link.

**Roles.** Owner, admin and reviewer settle evidence disagreements. Contributors
cannot. Starting, cancelling, authorising a retry and stopping work remain owner
and admin. The narrower reading in the first draft is withdrawn.

Because a decided decision's evidence set is closed, the resolution writes the
decision as `proposed`, attaches its evidence, then moves it
`proposed -> needs_human -> human_decided` — the path §8.6 gives a decision a
person makes.

## §2.1 and §22 — Counted marks

An accepted `counted_marks` quantity must be a non-negative **integer**, and must
have, per unit counted:

- an anchor of kind `page_bbox` with a page and a normalised box;
- a non-empty `locator ->> 'mark'`;
- distinct marks **and** distinct boxes — a list of invented names hung on one
  general region is one piece of evidence wearing several labels, and is refused.

The rule is re-checked when an anchor is removed, so the marks cannot be taken
away after acceptance. Spatial alternatives can be added when the spatial schema
lands in PR 9.

## Row-level security

Nineteen tables, nineteen `select` policies for `is_org_member(organization_id)`,
and **no insert, update or delete policy anywhere** — not for members, not for
owners, not in their own project. The worker writes as the service role. People
act through four functions that check the asker:

| Function | Who | What it does |
|---|---|---|
| `core_v2_start_workflow` | owner, admin | Validates membership and role, that every named document belongs to that property and carries content identity, computes both fingerprints server-side, refuses a duplicate live request unless authorised, writes workflow **and** outbox row in one transaction. |
| `core_v2_cancel_workflow` | owner, admin | Stops unsent work, leaves sent work to reconcile, returns the three counts, audits. |
| `core_v2_authorize_task_retry` | owner, admin | The only path out of `outcome_unknown` / `failed_known`. |
| `core_v2_resolve_disagreement` | owner, admin, reviewer | The four outcomes above. |

Anonymous execution is revoked on all of them, and on the fingerprint helpers.

## State machines

`core_v2_transition_allowed(machine, from, to)` holds every legal move for the
seven machines — workflow, task, attempt, claim, region, disagreement, decision.
Guards refuse anything else. The tests attempt all 398 ordered state pairs and
compare each with the table.

That test proves the state machines and nothing more. The cross-table invariants
above are proved by their own tests; the size of the matrix is not evidence about
them.

Two moves the table permits are still refused, because the machine alone cannot
see why: `leased -> queued` and `* -> cancelled` when any attempt for that task
has reached `submitted` or beyond. Two more are refused unless a person authorised
them in this session: `outcome_unknown -> queued` and `failed_known -> queued`.

## Audit

`core_v2.workflow.started`, `core_v2.workflow.cancelled`,
`core_v2.task.retry_authorized`, `core_v2.disagreement.resolved`,
`core_v2.disagreement.more_evidence_requested`, `core_v2.decision.superseded` and
`core_v2.claim.superseded` are written into the existing `public.audit_events`.
The last two are triggers, so a supersession cannot happen without one.

## V1 is untouched

This migration contains no `alter` and no `update` against any V1 table except one
addition to `ai_runs_process_key_check`, which admits the value `core-v2` and
changes no row and no reader. The invariant suite fingerprints
`project_documents`, `document_baselines`, `plan_spaces`, `project_requirements`,
`material_takeoffs`, `plan_analysis_jobs`, `plan_analysis_chunks`,
`evidence_items`, `capture_tasks` and every non-Core-V2 row of `ai_runs` before
the Core V2 section, and compares the fingerprint afterwards. The §3.3 read-only
projections belong to PR 8.

## Choices the specification leaves to the implementation

These are implementation-level and change no product invariant. They are recorded
so the next reader knows they were choices.

- **`text` + `check` rather than Postgres enums.** Migrations 048–057 use this
  idiom; adding a value is one line and takes no exclusive lock, and
  `pg_get_constraintdef` makes the vocabulary directly testable.
- **`sha256()`, built in, rather than pgcrypto `digest()`.** No extension and no
  `search_path` question inside a `security definer` function.
- **Closed vocabularies where §5 ends a list with "etc."** — `subject_type`,
  `entity_type`, `region_kind`, `task_type`. A closed list is what makes "a
  component type is not an instance" testable. Widening one is a one-line
  migration.
- **A `region` state machine.** §5.4 names the four statuses and §8.6.1 says what
  an accepted region may no longer do; the transitions between them were not
  written down, so they are stated here and tested like the others.
- **Region and anchor boxes are normalised 0..1**, enforced by
  `core_v2_is_normalised_bbox`, so a box found at one rendering resolution means
  the same thing at another.
- **`supersede` is the administrative decision type** exempt from the accepted-
  evidence rule of §5.16; `reject_all` is exempt from *that* rule and subject to
  its own, stricter one.

Columns beyond the §5 tables, each because a rule in the specification had
nowhere else to live: `request_fingerprint` (§2.1.7 — also named in §5.1 of
v1.2), `duplicate_authorized_by` (§5.1 "unless explicitly forced"),
`retry_authorized_by` / `retry_authorized_at` (§8.2, §9.3),
`incomplete_source_attempt` (§8.3), `supersedes_decision_id` (§8.6), and
`organization_id` / `property_id` on the join tables (§5 preamble and §2.1.1).

## The Noble fixture

`supabase/fixtures/core_v2_noble.sql` builds S-2, S-3 and S-4 as V2 holds them:
three page identities and eight regions — schedules, plan views, a legend, general
notes, a title block — from invented geometry and invented hashes. It contains no
client drawing, no rendered page, no photograph and no provider response, and it
defines its function in `pg_temp` so it cannot be mistaken for data later.

    \ir supabase/fixtures/core_v2_noble.sql
    select pg_temp.core_v2_noble_fixture('<organisation>', '<property>', '<document>');

## Running the tests

    bash supabase/tests/run.sh
    bash studio/tests/run.sh

The Core V2 section is at the end of `supabase/tests/security_invariants.sql`.
