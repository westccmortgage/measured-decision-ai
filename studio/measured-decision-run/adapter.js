/* THE ONE PLACE THE SCREEN TOUCHES THE ENGINE.
 *
 * Everything the demonstration shows is read back out of the Core V2 record
 * after the real scheduler has written it. Nothing here decides what is true,
 * what agrees, what is accepted, or what must go to a person — the engine
 * decides all of that, and this reads the answer.
 *
 * That boundary is the point of the screen. So the rules it keeps are:
 *
 *   · no result is invented. Every claim, disagreement, decision and anchor
 *     below comes from repo.listClaims / listDisagreements / listDecisions /
 *     listAnchors on a workflow the scheduler actually ran;
 *   · nothing is shown a moment before the engine has written it. The screen
 *     re-reads the record after each tick, so a reader's answer cannot appear
 *     on the page before the kernel has accepted it into the record;
 *   · a reader's answer is never carried between readers by this file. The
 *     engine builds every packet; this file builds none;
 *   · stopping means the engine's own cancellation, not a paused animation;
 *   · running again means a new workflow, not a re-render.
 *
 * It runs unchanged in a browser and in node, so the suite can prove the
 * screen's data against the same code the screen runs.
 */
import "./engine-shims/buffer.js";
import { syntheticRecordSet } from "./engine/domains/synthetic-records/fixture.js";
import { SyntheticRecordsPack } from "./engine/domains/synthetic-records/pack.js";
import { mockExecutors } from "./engine/domains/synthetic-records/mocks.js";
import { assemble, manualClock } from "./engine/domains/simulate.js";

/* ─────────────────────────────────────────── who the reader sees working

   The engine names roles for what they do to evidence. These are the same
   roles in the words somebody buying this would use. The mapping is the only
   translation in this file, and it is one-way: nothing is renamed on the way
   back in. */
const READER_LETTERS = ["A", "B", "C", "D"];

export function workerNameFor(roleKey, independenceGroup, groupOrder) {
  if (roleKey === "evidence_critic") return "Evidence Critic";
  if (roleKey === "disagreement_verifier") return "Reconciliation Agent";
  if (roleKey === "evidence_arbiter") return "Decision Arbiter";
  if (roleKey === "decision_composer") return "Decision Arbiter";
  if (independenceGroup) {
    const at = groupOrder.indexOf(independenceGroup);
    return `Independent Reader ${READER_LETTERS[at] ?? at + 1}`;
  }
  return "System check";
}

/* The seven things the person watching is told are happening, in order. Each
   is a phase of the engine's own progress, not a timer. */
export const STAGES = [
  { key: "preparing", label: "Preparing evidence" },
  { key: "assigning", label: "Assigning independent readers" },
  { key: "reading", label: "Independent readings" },
  { key: "comparing", label: "Comparing findings" },
  { key: "challenging", label: "Challenging unsupported claims" },
  { key: "resolving", label: "Resolving or escalating disagreements" },
  { key: "ready", label: "Decision ready" },
];

/* Which stage the run is in, decided from what the record holds rather than
   from how long it has been going. */
function stageOf(tasks, disagreements, finished) {
  if (finished) return "ready";
  const done = (t) => ["completed", "failed_known", "outcome_unknown", "cancelled", "superseded"].includes(t.state);
  const anyOf = (types) => tasks.some((t) => types.includes(t.taskType));
  const allDone = (types) => tasks.filter((t) => types.includes(t.taskType)).every(done);
  if (tasks.length === 0) return "preparing";
  if (anyOf(["verify_disagreement", "adjudicate"]) ) return "resolving";
  if (disagreements.length > 0) return "resolving";
  if (anyOf(["compare_claims"]) && !allDone(["compare_claims"])) return "comparing";
  if (anyOf(["verify_claim"])) return "challenging";
  if (tasks.some((t) => t.independenceGroup && !done(t))) return "reading";
  if (tasks.every((t) => t.state === "created" || t.state === "queued")) return "assigning";
  return "reading";
}

/* ───────────────────────────────────────────────── the demonstration run */

/* One reader misreads one row. Nothing else is scripted: the disagreement the
   screen shows is the engine noticing two independent readings that do not
   match, not a scene played out for the camera. */
function misreadOneRow(target) {
  return (packet, base) => {
    if (packet.roleKey === "table_reader") {
      for (const claim of base.claims) {
        if (claim.subjectKey === target && claim.predicate === "quantity") {
          const was = Number(claim.value?.quantity ?? 0);
          claim.value = { ...claim.value, quantity: was + 6, text: `${was + 6} each` };
        }
      }
    }
    return base;
  };
}

/* One row the critic cannot confirm at its anchor.
 *
 * Without this the demonstration is misleading by being too tidy: every fact
 * either gets verified or becomes the disagreement, and "Needs more proof"
 * stays empty — so the screen never shows the case the whole system exists
 * for. Two readers agreeing on a value that nothing could confirm is the most
 * important thing this engine does differently, and a person should see it.
 *
 * So the critic withholds support for one reading. It is a mock declining to
 * confirm, through the same scripts seam the misreading reader uses; the
 * engine's own rule then does the rest, and the rule is the point: a
 * corroborated claim with no verification is NOT accepted. */
function withholdOneVerification() {
  return (packet, base) => {
    if (packet.roleKey === "evidence_critic" && Array.isArray(base.assessments) && base.assessments.length > 1) {
      base.assessments = base.assessments.slice(0, -1);
    }
    return base;
  };
}

export function newRunId() {
  /* A different seed every time, so "Run again" is a different workflow with
     different ids — never the same run re-rendered. */
  const bytes = new Uint8Array(6);
  (globalThis.crypto ?? { getRandomValues: () => {} }).getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createRun(options = {}) {
  const seed = options.seed ?? `demonstration-${newRunId()}`;
  const truth = syntheticRecordSet({
    seed,
    sources: options.sources ?? 1,
    sheetsPerSource: options.sheetsPerSource ?? 1,
    entriesPerTable: options.entriesPerTable ?? 3,
  });
  /* The row the second reader gets wrong — chosen from the fixture's own
     entries so the misreading is about real material. */
  const contested = options.contested ?? `entry/${truth.entries[0].id}`;
  const { registry, executors } = mockExecutors(truth, {
    scripts: {
      "reader-family-two": misreadOneRow(contested),
      "critic-family-one": withholdOneVerification(),
    },
  });
  const world = assemble({
    manifest: truth.manifest,
    pack: new SyntheticRecordsPack(),
    executors: registry,
    clock: manualClock(),
  });
  return { seed, truth, registry, executors, contested, ...world, workflowId: truth.manifest.workflowId };
}

/* ─────────────────────────────────────────── one fact, however many rows

   The record keeps a claim per reader, which is right: two readers reading the
   same row are two independent readings and the engine must be able to tell
   them apart. But a PERSON looking at the screen sees one fact. Showing
   "Row E-002 · 22 each" as an accepted finding and again as an unproved one —
   because Reader A's claim was accepted and Reader B's identical claim is
   recorded as corroborated — makes the system look as though it cannot make up
   its mind, when in truth it did exactly the right thing.

   So the screen groups claims into FINDINGS by what the fact is: its subject,
   what is being said about it, and the value said. The readers behind a
   finding become part of the finding rather than separate cards, and the
   individual claims stay reachable inside View evidence, which is where
   somebody who wants the rows should find them. */
function dedupeEvidence(pieces) {
  const seen = new Set();
  const out = [];
  for (const piece of pieces) {
    const key = `${piece.sourceId}|${piece.segmentId}|${piece.contentHash}|${JSON.stringify(piece.locator ?? {})}|${piece.quotedText ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(piece);
  }
  return out;
}

export function canonicalKey(claim) {
  const value = claim?.value ?? {};
  const said = value.quantity !== null && value.quantity !== undefined
    ? `q:${value.quantity}`
    : value.known === false
      ? "unreadable"
      : `t:${String(value.text ?? "").trim().toLowerCase()}`;
  return `${claim.subjectKey}|${claim.predicate}|${said}`;
}

/* Why the engine has not accepted a claim, in the words a buyer would use.
   The status is the engine's; only the sentence is ours. */
const WHY_NOT_ACCEPTED = {
  proposed: "one reader said so, and nothing has checked it yet",
  corroborated: "two readers agreed — which is agreement, not proof, so it is not accepted",
  disputed: "readers disagree, and it is being settled",
  verified: "checked, and waiting on the decision that would accept it",
  rejected: "checked against the evidence and refused",
  unresolved: "nobody could settle it, so it is held rather than guessed",
};

const FINISHED = ["completed", "settled", "partial", "needs_attention", "failed", "cancelled"];

/* Drive the engine one tick at a time, handing the caller a fresh reading of
   the record after each. The caller renders what it is given and nothing
   else. */
export async function driveRun(run, { onProgress, maxTicks = 80, shouldStop } = {}) {
  await run.scheduler.plan();
  let report = null;
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (shouldStop?.()) break;
    report = await run.scheduler.tick();
    const view = await readRun(run, report);
    await onProgress?.(view);
    if (FINISHED.includes(report.workflowState)) break;
  }
  return readRun(run, report);
}

/* THE ENGINE'S OWN CANCELLATION, called by its own name.
 *
 * scheduler.cancel() is the kernel's routine for this and it does the whole
 * job: it records the request, aborts what is in flight, cancels what was
 * never sent, leaves what WAS sent as unresolved rather than pretending it
 * did not happen, preserves completed work, and moves the workflow to
 * cancelled. The screen calls it and shows what came back. There is no
 * separate "stop the animation" path, because there is no animation to stop —
 * what the screen draws is the record. */
export async function stopRun(run, reason = "stopped by the person watching") {
  const outcome = await run.scheduler.cancel(reason);
  const view = await readRun(run);
  return { ...view, cancellation: outcome };
}

/* ─────────────────────────────────── reading the record back out, as it is */

export async function readRun(run, report = null) {
  const { repo, workflowId } = run;
  const workflow = await repo.getWorkflow(workflowId);
  const tasks = await repo.listTasks(workflowId);
  const claims = await repo.listClaims({ workflowId });
  const disagreements = await repo.listDisagreements(workflowId);
  const decisions = await repo.listDecisions(workflowId);
  const segments = await repo.listSegments(workflowId);
  const anchors = await repo.listAnchors(claims.map((c) => c.claimId));
  const assessments = await repo.listAssessments(claims.map((c) => c.claimId));

  const attempts = [];
  for (const task of tasks) attempts.push(...await repo.listAttempts(task.taskId));

  const groupOrder = [...new Set(tasks.map((t) => t.independenceGroup).filter(Boolean))].sort();
  const taskById = new Map(tasks.map((t) => [t.taskId, t]));
  const attemptById = new Map(attempts.map((a) => [a.attemptId, a]));
  const segmentById = new Map(segments.map((s) => [s.segmentId, s]));
  const sourceById = new Map(run.truth.manifest.sources.map((s) => [s.sourceId, s]));
  const anchorsByClaim = new Map();
  for (const anchor of anchors) {
    if (!anchor.claimId) continue;
    if (!anchorsByClaim.has(anchor.claimId)) anchorsByClaim.set(anchor.claimId, []);
    anchorsByClaim.get(anchor.claimId).push(anchor);
  }
  const assessmentsByClaim = new Map();
  for (const assessment of assessments) {
    if (!assessmentsByClaim.has(assessment.claimId)) assessmentsByClaim.set(assessment.claimId, []);
    assessmentsByClaim.get(assessment.claimId).push(assessment);
  }

  const whoMade = (claim) => {
    const attempt = claim.attemptId ? attemptById.get(claim.attemptId) : null;
    const task = attempt ? taskById.get(attempt.taskId) : null;
    return workerNameFor(task?.roleKey ?? claim.roleKey, claim.independenceGroup, groupOrder);
  };

  const evidenceFor = (claim) => (anchorsByClaim.get(claim.claimId) ?? []).map((anchor) => {
    const segment = anchor.segmentId ? segmentById.get(anchor.segmentId) : null;
    const source = anchor.sourceId ? sourceById.get(anchor.sourceId) : null;
    const hash = segment?.contentHash ?? source?.contentHash ?? null;
    const material = hash ? run.truth.material.get(hash) : null;
    return {
      anchorId: anchor.anchorId,
      sourceId: anchor.sourceId,
      sourceLabel: source?.label ?? anchor.sourceId ?? "source",
      segmentId: anchor.segmentId,
      segmentLabel: segment?.label ?? null,
      locator: anchor.locator,
      quotedText: anchor.quotedText,
      mediaKind: material?.mediaKind ?? null,
      mimeType: material?.mimeType ?? null,
      /* The material itself, so "View evidence" shows the thing rather than a
         description of it. */
      bytes: material?.bytes ?? null,
      contentHash: hash,
    };
  });

  const shaped = claims.map((claim) => ({
    claimId: claim.claimId,
    subjectKey: claim.subjectKey,
    predicate: claim.predicate,
    value: claim.value,
    status: claim.status,
    madeBy: whoMade(claim),
    independenceGroup: claim.independenceGroup,
    independenceDomain: claim.independenceDomain,
    evidence: evidenceFor(claim),
    assessments: (assessmentsByClaim.get(claim.claimId) ?? []).map((a) => ({
      kind: a.assessment, reasonCode: a.reasonCode, explanation: a.explanation,
      madeBy: workerNameFor(taskById.get(a.taskId)?.roleKey ?? null, null, groupOrder),
    })),
  }));

  /* A disagreement names its claims outright. Matching on a subject STRING
     would be wrong: the engine normalises a subject signature ("ENTRYE001")
     and a claim keeps its own key ("entry/E-001"), so a string match silently
     finds nothing and the screen would show a disagreement with no sides. */
  const byClaimId = new Map(shaped.map((c) => [c.claimId, c]));
  const contestedClaimIds = new Set(disagreements.flatMap((d) => d.claimIds ?? []));

  /* Group the rows into facts. A fact contested by a disagreement belongs to
     the disagreement and to nothing else, so it cannot appear twice. */
  const groups = new Map();
  for (const claim of shaped) {
    const key = canonicalKey(claim);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(claim);
  }
  const READER = /^Independent Reader /;
  const findings = [...groups.entries()].map(([key, group]) => {
    const accepted = group.find((c) => c.status === "accepted") ?? null;
    const lead = accepted ?? group[0];
    const contested = group.some((c) => contestedClaimIds.has(c.claimId));
    const supporters = [...new Set(group.map((c) => c.madeBy))];
    const readers = supporters.filter((who) => READER.test(who));
    const verification = group.flatMap((c) => c.assessments)
      .find((a) => typeof a.explanation === "string" && a.explanation.length > 0) ?? null;
    return {
      key,
      subjectKey: lead.subjectKey,
      predicate: lead.predicate,
      value: lead.value,
      status: lead.status,
      madeBy: lead.madeBy,
      supporters,
      readers,
      /* Every row behind the fact, so View evidence can show the workings. */
      claims: group,
      /* Two readers reading the same row anchor at the same place, so the
         same piece of evidence would otherwise be listed once per reader. It
         is one piece of evidence; who relied on it is on the finding. */
      evidence: dedupeEvidence(group.flatMap((c) => c.evidence)),
      assessments: group.flatMap((c) => c.assessments),
      verification,
      outcome: contested ? "contested" : accepted ? "verified" : "needs_more_proof",
      why: accepted ? null : (WHY_NOT_ACCEPTED[lead.status] ?? `recorded as ${lead.status}`),
    };
  });

  const finished = report ? FINISHED.includes(report.workflowState) : FINISHED.includes(workflow?.state);

  return {
    workflowId,
    seed: run.seed,
    state: workflow?.state ?? "created",
    stage: stageOf(tasks, disagreements, finished),
    finished,
    /* VERIFIED — one card per fact the engine accepted, naming the readers
       behind it. */
    verified: findings.filter((f) => f.outcome === "verified"),
    /* Kept under its old name so nothing else has to change at once; the
       screen reads `verified`. */
    agreed: findings.filter((f) => f.outcome === "verified"),
    /* DISAGREEMENT — the engine's own disagreement rows, each side with its
       evidence, plus how it ended. The sides are the claims the disagreement
       itself names. */
    disagreements: disagreements.map((d) => ({
      disagreementId: d.disagreementId,
      subjectKey: (d.claimIds ?? []).map((id) => byClaimId.get(id)?.subjectKey).find(Boolean)
        ?? d.subjectSignature?.subject_key ?? null,
      kind: d.kind,
      state: d.state,
      needsHumanReason: d.needsHumanReason ?? null,
      sides: (d.claimIds ?? []).map((id) => byClaimId.get(id)).filter(Boolean),
    })),
    /* NEEDS MORE PROOF — facts where NO claim was accepted, no decision
       established them, and the evidence burden is still unmet. A fact two
       readers agreed on but nothing verified lives here, which is the whole
       point: agreement is not proof. A fact that WAS accepted does not appear
       here at all, even though a corroborated sibling row exists in the
       record. */
    needsMoreProof: findings.filter((f) => f.outcome === "needs_more_proof"),
    unproved: findings.filter((f) => f.outcome === "needs_more_proof"),
    /* DECISION — what the engine decided, and on whose authority. */
    decisions: decisions.map((d) => ({
      decisionId: d.decisionId,
      subjectKey: d.subjectKey,
      decisionType: d.decisionType,
      title: d.title,
      status: d.status,
      authority: d.authority,
      rationale: d.rationale,
    })),
    workers: [...new Set(tasks.map((t) => workerNameFor(t.roleKey, t.independenceGroup, groupOrder)))],
    facts: {
      state: workflow?.state ?? "created",
      completedAssignments: tasks.filter((t) => t.state === "completed").length,
      refusedAssignments: tasks.filter((t) => ["failed_known", "cancelled", "outcome_unknown"].includes(t.state)).length,
      totalAssignments: tasks.length,
      externalCost: "$0.00",
      providerNetwork: "sealed",
      humanReviewRequired: disagreements.some((d) => d.state === "needs_human")
        || (workflow?.state === "needs_attention"),
    },
  };
}
