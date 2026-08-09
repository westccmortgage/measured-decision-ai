# Measured Decision AI Agent Operating Model

## Operating shape

The product follows the AI4 operating pattern:

Case Intake → Six Specialist Responsibilities → Evidence-Grounded Synthesis → Deterministic Router

The router has only three outcomes:

- **Autopilot** — deterministic administrative work that does not create or approve a project fact.
- **Copilot** — an evidence-cited AI proposal that remains separate from the verified record.
- **Escalation** — missing, conflicting, illegible, stale, or unsupported material requiring a person.

No agent may silently promote its own output from Copilot to a verified fact.

## Responsibility map

| Agent | Trigger | Owns | Output | Route | Pilot status |
|---|---|---|---|---|---|
| Document Control Agent | PDF plan, specification, addendum, change order | Document identity, revision, discipline, source register | Controlled source set and conflicts | Copilot / Escalation | Active in plan worker |
| Plan Intelligence Agent | Selected controlled plan set | Building, level, room, system, supported phase structure | Versioned baseline proposal and gaps | Copilot | Active in plan worker |
| Capture Roadmap Agent | Baseline proposal | What, where, when, why, and how to capture | Field-ready capture requirements | Copilot | Active in plan worker |
| Field Quality Agent | Material uploaded from one private assignment | Task match, visibility, coverage, focus, exposure | Pass, retake, or ready-for-human-review | Copilot / Escalation | Active in field worker |
| Evidence Inspector Agent | Photo, video, or 360 upload | Capture quality and directly visible conditions | Evidence-cited observations, unknowns, follow-up | Copilot / Escalation | Active in evidence worker |
| Governance & Release Agent | Any specialist output or release request | Source matching, stale analysis, conflicts, review readiness, approved-source packaging | Blocking reasons, human-review route, immutable Vision release | Escalation / Autopilot | Active through hard gates and release worker |

## Pilot execution model

The product exposes exactly six specialist responsibilities, not six model calls
for every event. A deterministic orchestrator authenticates the case, selects
the correct specialist, and records the handoff; it is application logic, not a
seventh AI agent. Spatial packaging is a deterministic capability owned by the
sixth Governance & Release responsibility, not another autonomous agent.
Document Control, Plan Intelligence, and Capture Roadmap run as one controlled
plan-analysis transaction because each step depends on the prior output. The
Field Quality Agent performs the first usability check for assignment uploads.
The Evidence Inspector runs independently for visual interpretation. Governance
& Release is primarily deterministic application and database gates.

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

### Remote field assignment

1. A project manager sends one approved capture task to one worker.
2. The server creates an expiring, revocable bearer link and stores only its hash.
3. The worker opens four plain-language steps without a Studio account.
4. Files upload directly to private S3 and inherit the assignment, task, baseline, property, and room identity.
5. Field Quality checks operational usability and gives one concise retake instruction when a visible problem prevents review.
6. A named owner, admin, or reviewer completes the task or requests a retake. AI never completes it.

### Vision package request

This route is active through the server-owned `vision-release` endpoint.

1. Governance & Release checks that the baseline, field tasks, room record, current evidence set, and interpretation reviews are human approved.
2. The worker builds a versioned draft whose manifest contains stable private object references but no signed URLs.
3. Any blocker keeps the draft out of production and leaves the previous approved release live.
4. A named owner, admin, or reviewer approves the exact blocker-free version.
5. Approval atomically revokes the prior version; the Vision client receives a manifest plus separate one-hour media URLs.

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

- Agents may organize, interpret, suggest, compare, check capture usability, and package.
- Agents may not approve a plan baseline, confirm a visible record, waive a task, or certify a release.
- An authorized human identity and timestamp are required for every transition into the verified record.
