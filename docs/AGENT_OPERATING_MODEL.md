# Measured Decision AI Agent Operating Model

## Operating shape

The product follows the AI4 operating pattern:

Case Intake → Specialist Agents → Evidence-Grounded Synthesis → Deterministic Router

The router has only three outcomes:

- **Autopilot** — deterministic administrative work that does not create or approve a project fact.
- **Copilot** — an evidence-cited AI proposal that remains separate from the verified record.
- **Escalation** — missing, conflicting, illegible, stale, or unsupported material requiring a person.

No agent may silently promote its own output from Copilot to a verified fact.

## Responsibility map

| Agent | Trigger | Owns | Output | Route | Pilot status |
|---|---|---|---|---|---|
| Executive Orchestrator | Any authenticated upload or workflow request | Case identity, state, routing, handoffs | Specialist assignment or escalation | Autopilot | Active, deterministic routing |
| Document Control Agent | PDF plan, specification, addendum, change order | Document identity, revision, discipline, source register | Controlled source set and conflicts | Copilot / Escalation | Active in plan worker |
| Plan Intelligence Agent | Selected controlled plan set | Building, level, room, system, supported phase structure | Versioned baseline proposal and gaps | Copilot | Active in plan worker |
| Capture Roadmap Agent | Baseline proposal | What, where, when, why, and how to capture | Field-ready capture requirements | Copilot | Active in plan worker |
| Evidence Inspector Agent | Photo, video, or 360 upload | Capture quality and directly visible conditions | Evidence-cited observations, unknowns, follow-up | Copilot / Escalation | Active in evidence worker |
| Verification Guard | Any specialist output | Source matching, stale analysis, conflicts, review readiness | Blocking reasons or ready-for-human-review state | Escalation | Active through hard gates and human approval |
| Spatial Publisher Agent | Human-approved release request | Approved-source packaging and provenance | Versioned Vision manifest | Autopilot | Contracted; release endpoint not active |

## Pilot execution model

The agents are separate responsibilities, not seven unnecessary model calls.
Document Control, Plan Intelligence, and Capture Roadmap run as one controlled
plan-analysis transaction because each step depends on the prior output. The
Evidence Inspector runs independently for visual uploads. The Orchestrator and
Verification Guard are primarily deterministic application and database gates.

Every model-produced record stores the responsible `agent_key` and
`agent_contract_version`. This makes each result attributable and allows one
agent contract to be evaluated and upgraded without silently changing the
authority of the others.

## Upload routing

### PDF plans and project documents

1. Orchestrator confirms authenticated organization and property.
2. Document Control validates type, revision metadata, file identity, and selected source set.
3. Plan Intelligence extracts only supported project structure and explicit gaps.
4. Capture Roadmap creates evidence gates and field instructions.
5. Verification Guard blocks activation when critical gaps remain.
6. Owner, admin, or reviewer approves the baseline.

### Photos, video, and 360 captures

1. Orchestrator confirms property, room, uploader, and optional capture-task link.
2. Evidence Inspector evaluates usable visual coverage and produces source-cited observations.
3. Verification Guard rejects stale output when the current evidence-ID set changes.
4. A reviewer confirms, edits, rejects, or requests more evidence.

### Vision package request

This route is contracted but not active in the pilot yet. Activation requires a
server-owned release endpoint rather than a browser-generated JSON download.

1. Verification Guard checks that the baseline and included room records are human approved.
2. Spatial Publisher builds a new immutable version with private, expiring media delivery.
3. Draft, stale, rejected, and unverified suggestions remain excluded.

## Agent training contract

Training in the pilot means versioned operating instructions, strict schemas,
deterministic graders, curated test cases, and human feedback—not silent model
fine-tuning on customer files.

Every production agent version is evaluated against:

1. **Deterministic graders**
   - output matches the JSON schema;
   - every observation cites a current evidence ID;
   - every plan task cites a selected document UUID;
   - no task activates before baseline approval;
   - no stale suggestion survives an evidence-set change.
2. **LLM-as-judge review**
   - no unsupported compliance, safety, completion, cost, schedule, or concealed-condition claim;
   - gaps are explicit rather than guessed;
   - field instructions are specific and executable.
3. **Human trend discovery**
   - reviewers label recurring false positives, missed details, confusing tasks, and bad escalations;
   - trends enter a controlled log;
   - contract changes receive a new version and repeat the evaluation set before production.

## Human authority

- Agents may organize, interpret, suggest, compare, and package.
- Agents may not approve a plan baseline, confirm a visible record, waive a task, or certify a release.
- An authorized human identity and timestamp are required for every transition into the verified record.
