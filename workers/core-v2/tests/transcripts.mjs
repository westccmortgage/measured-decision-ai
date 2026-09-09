/* A SECOND DOMAIN, SO THE KERNEL IS NOT SECRETLY THE FIRST.
 *
 * docs/core-v2.md §1: a domain pack is one optional, replaceable part among
 * equals — what a segment is, which analysts read it, what subjects and
 * predicates they report and how a quantity is derived are the pack's, and
 * the kernel neither knows nor enumerates them. This file drives the whole
 * engine on the second synthetic pack, whose sources declare nothing about
 * themselves, whose segments are time ranges rather than boxes, and whose
 * subjects and predicates share not one word with the first pack:
 *
 *   ingest → source-level discovery → two blind readings per part →
 *   comparison → criticism → acceptance → derived totals → composition.
 *
 * §5: an anchor is one consistent tuple, and its locator lies inside the
 * segment's own locator space — here a time range inside a time range
 * (kernel/locators.ts). §4: agreement is not acceptance; a disagreement is
 * verified, adjudicated and resolved on what the reopened source shows. §6:
 * an attempt keeps what the executor returned, verbatim.
 *
 * And the other half of the rule, statically: the kernel's own source says
 * nothing of either pack's vocabulary, its scheduler holds no branch for
 * either of them, the packs' task types are namespaced and the kernel's are
 * not, and neither pack knows the other exists.
 *
 * Everything runs in memory on scripted executors, with a manual clock. The
 * network is closed before the engine is used.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { harness, closeNetwork } from "./harness.mjs";
import { syntheticTranscriptSet } from "../domains/synthetic-transcripts/fixture.ts";
import { SyntheticTranscriptsPack, TASK } from "../domains/synthetic-transcripts/pack.ts";
import { mockExecutors } from "../domains/synthetic-transcripts/mocks.ts";
import { SyntheticRecordsPack, TASK as RECORD_TASK } from "../domains/synthetic-records/pack.ts";
import { assemble, manualClock } from "../domains/simulate.ts";
import { KERNEL_TASK_TYPES } from "../kernel/contracts.ts";
import { INDEPENDENCE_GROUPS } from "../kernel/domain.ts";
import { locatorInside } from "../kernel/locators.ts";
import { canonical } from "../kernel/ids.ts";
import { KERNEL_ROLES, RoleRegistry } from "../kernel/roles.ts";

const tripped = closeNetwork();
const t = harness("a second domain, so the kernel is not secretly the first");

/* ───────────────────────────────────────────────────────────── helpers */

const [READER_A, READER_B] = INDEPENDENCE_GROUPS;
const every = (xs, f) => xs.length > 0 && xs.every(f);
const sorted = (xs) => [...xs].sort();
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const kernelDir = fileURLToPath(new URL("../kernel/", import.meta.url));
const kernelFiles = readdirSync(kernelDir).filter((f) => f.endsWith(".ts")).sort();
const kernelSource = new Map(kernelFiles.map((f) => [f, readFileSync(`${kernelDir}${f}`, "utf8")]));

/* One assembled world on the transcripts pack: an invented set of
   recordings, scripted executors, an in-memory record and a manual clock. */
function world(seed, options = {}) {
  const truth = syntheticTranscriptSet({ seed, recordings: options.recordings ?? 2, scenesPerRecording: options.scenesPerRecording ?? 3 });
  const { registry, executors } = mockExecutors(truth, options.mocks ?? {});
  const parts = assemble({ manifest: truth.manifest, pack: new SyntheticTranscriptsPack(), executors: registry, clock: manualClock() });
  return { truth, wf: truth.manifest.workflowId, registry, executors, ...parts };
}

/* Tick by hand until nothing moves, keeping the workflow state each tick
   left behind, then let the scheduler settle. No sleeps anywhere. */
async function drive(scheduler, maxTicks = 200) {
  const states = [];
  for (let i = 0; i < maxTicks; i++) {
    const r = await scheduler.tick();
    states.push(r.workflowState);
    if (r.dispatched.length === 0 && r.released === 0 && r.stopped === 0 && r.reconciled === 0 && scheduler.inFlight.size === 0) break;
  }
  const report = await scheduler.runUntilQuiescent();
  return { states, report };
}

const readings = (claims) => claims.filter((c) => c.predicate === "speaker_turns");
const totals = (claims) => claims.filter((c) => c.predicate === "total_speaker_turns");
const packetsOf = (executor, roleKey) => executor.received.filter((p) => p.roleKey === roleKey);

/* ═══════════════════════════ (1) the whole workflow, on the second pack */

t.section("(1) ingest → discovery → two blind readings → compare → critic → derive → compose");

const runOne = world("transcripts/end-to-end");
{
  const { truth, wf, repo, scheduler, executors } = runOne;

  t.check("the sources of this pack declare no segments at all — everything below them has to be discovered",
    every(truth.manifest.sources, (s) => s.declaredSegments.length === 0) && truth.manifest.sources.length === 2,
    `${truth.manifest.sources.length} sources, ${truth.manifest.sources.reduce((n, s) => n + s.declaredSegments.length, 0)} declared segments`);

  t.check("the fixture's two recordings hold different numbers of speaker turns, so a per-recording total cannot be right by accident",
    truth.totals["recording/0"].turns !== truth.totals["recording/1"].turns,
    `${truth.totals["recording/0"].turns} vs ${truth.totals["recording/1"].turns}`);

  await scheduler.plan();
  const driven = await drive(scheduler);
  const tasks = await repo.listTasks(wf);
  const claims = await repo.listClaims({ workflowId: wf });
  const segments = await repo.listSegments(wf);
  const decisions = await repo.listDecisions(wf);
  const segmentById = new Map(segments.map((s) => [s.segmentId, s]));
  const sourceOfOrdinal = (n) => truth.manifest.sources.find((s) => s.ordinal === n);

  t.check("the run walks the workflow machine to completion, through deciding, with nothing held for a person",
    driven.states.includes("running") && driven.states.includes("deciding") && driven.report.workflow.state === "completed"
    && (await repo.listDisagreements(wf)).length === 0,
    `${[...new Set(driven.states)].join(" > ")} > ${driven.report.workflow.state}`);

  t.check("every task of the run ended completed — no branch of this domain's graph failed or was left open",
    tasks.length > 0 && tasks.every((x) => x.state === "completed"), JSON.stringify(driven.report.tasks));

  t.check("the run used the seven phases this pack asks of the kernel: ingest, discover, analyze, compare, verify, derive, compose",
    driven.report.byPhase.ingest === 2 && driven.report.byPhase.discover === 2 && driven.report.byPhase.analyze === 12
    && driven.report.byPhase.compare === 6 && driven.report.byPhase.verify === 6 && driven.report.byPhase.derive === 2 && driven.report.byPhase.compose === 2,
    JSON.stringify(driven.report.byPhase));

  const packTypes = [...new Set(tasks.map((x) => x.taskType))].filter((x) => x.startsWith("synthetic-transcripts:"));
  const kernelTypes = [...new Set(tasks.map((x) => x.taskType))].filter((x) => !x.startsWith("synthetic-transcripts:"));
  t.check("the only pack task types in the run are this pack's three, and every other task type is one of the kernel's own",
    same(sorted(packTypes), sorted(Object.values(TASK))) && every(kernelTypes, (x) => Object.values(KERNEL_TASK_TYPES).includes(x)),
    `${packTypes.join(", ")} | ${kernelTypes.join(", ")}`);

  /* ── the segments a model found, where the source declared none ── */
  t.check("every scene the discoverer found is a top-level segment: no parent, so this pack's parts hang off the source itself",
    segments.length === 6 && every(segments, (s) => s.parentSegmentId === null && s.segmentKind === "scene"),
    `${segments.length} segments, kinds ${[...new Set(segments.map((s) => s.segmentKind))].join(",")}`);

  t.check("every discovered scene is accepted, found by a model, and carries the id of the attempt that found it",
    every(segments, (s) => s.status === "accepted" && s.discoveredBy === "model" && typeof s.discoveredByAttemptId === "string" && s.discoveredByAttemptId.length > 0));

  const discoveries = tasks.filter((x) => x.taskType === TASK.discoverScenes);
  const discoveryAttempts = (await Promise.all(discoveries.map((x) => repo.listAttempts(x.taskId)))).flat();
  t.check("each scene's discoveredByAttemptId is an attempt of the discovery of its own recording",
    every(segments, (s) => discoveryAttempts.some((a) => a.attemptId === s.discoveredByAttemptId && discoveries.some((d) => d.taskId === a.taskId && d.sources[0].sourceId === s.sourceId))));

  t.check("the persisted scenes are exactly the fixture's, time range for time range",
    every(truth.recordings, (r) => r.scenes.every((scene) => segments.some((s) => s.sourceId === r.sourceId && s.contentHash === scene.contentHash
      && s.locator.start_ms === scene.startMs && s.locator.end_ms === scene.endMs && s.ordinal === scene.ordinal))));

  t.check("every scene's time range lies inside the recording's own duration and runs forward",
    every(segments, (s) => {
      const source = truth.manifest.sources.find((x) => x.sourceId === s.sourceId);
      return s.locator.start_ms >= 0 && s.locator.end_ms > s.locator.start_ms && s.locator.end_ms <= source.media.duration_ms;
    }));

  /* ── two blind readings of every scene ── */
  const readerTasks = tasks.filter((x) => x.independenceGroup !== null);
  const sceneSubjects = [...new Set(readerTasks.map((x) => x.subjectKey))].sort();
  t.check("every scene became one subject with two blind readings, one per independence group",
    sceneSubjects.length === 6 && sceneSubjects.every((s) => same(sorted(readerTasks.filter((x) => x.subjectKey === s).map((x) => x.independenceGroup)), [READER_A, READER_B])),
    sceneSubjects.join(", "));

  const readerAttempts = (await Promise.all(readerTasks.map((x) => repo.listAttempts(x.taskId)))).flat();
  t.check("the two readings of each scene ran in two different executor domains",
    sceneSubjects.every((s) => {
      const domains = new Set(readerTasks.filter((x) => x.subjectKey === s).flatMap((x) => readerAttempts.filter((a) => a.taskId === x.taskId && a.state === "succeeded").map((a) => a.independenceDomain)));
      return domains.size === 2;
    }));

  t.check("a scene reader is handed its one scene as a segment, with the scene's own time range and nothing else of the recording",
    every(packetsOf(executors["reader-family-one"], "scene_reader"), (p) => p.sources.length === 1 && p.sources[0].kind === "segment"
      && p.sources[0].segmentKind === "scene" && typeof p.sources[0].locator.start_ms === "number" && typeof p.sources[0].locator.end_ms === "number"));

  /* ── anchors: a time range inside a time range ── */
  const sceneClaims = readings(claims);
  const sceneAnchors = await repo.listAnchors(sceneClaims.map((c) => c.claimId));
  t.check("every blind reading of a scene produced exactly one claim, and every claim exactly one anchor",
    sceneClaims.length === 12 && sceneAnchors.length === sceneClaims.length,
    `${sceneClaims.length} readings, ${sceneAnchors.length} anchors`);

  t.check("every anchor of a scene reading is a segment_locator naming a segment the record holds",
    every(sceneAnchors, (a) => a.sourceKind === "segment_locator" && a.segmentId !== null && segmentById.has(a.segmentId)),
    [...new Set(sceneAnchors.map((a) => a.sourceKind))].join(", "));

  t.check("every anchor's time range lies inside its scene's own time range — locatorInside against the persisted segments",
    every(sceneAnchors, (a) => typeof a.locator.start_ms === "number" && typeof a.locator.end_ms === "number"
      && locatorInside(a.locator, segmentById.get(a.segmentId).locator)));

  t.check("an anchor never combines a segment of one recording with another recording's id: source, segment and subject agree",
    every(sceneClaims, (c) => {
      const anchor = sceneAnchors.find((a) => a.claimId === c.claimId);
      const segment = segmentById.get(anchor.segmentId);
      const [, ordinal, , sceneOrdinal] = c.subjectKey.split("/");
      return anchor.sourceId === segment.sourceId && segment.sourceId === sourceOfOrdinal(Number(ordinal)).sourceId && segment.ordinal === Number(sceneOrdinal);
    }));

  /* ── what the readers said, and what made it evidence ── */
  t.check("every blind reading reports the fixture's own number of speaker turns, in turns, as something observed",
    every(sceneClaims, (c) => {
      const anchor = sceneAnchors.find((a) => a.claimId === c.claimId);
      const scene = truth.bySceneHash.get(segmentById.get(anchor.segmentId).contentHash);
      return c.value.known && c.value.quantity === scene.turns && c.unit === "turns" && c.observationBasis === "observed" && c.subjectType === "scene";
    }));

  t.check("each scene ends with one accepted reading; the reading that agreed with it stays corroborated, never accepted for agreeing",
    sceneSubjects.every((s) => {
      const mine = sceneClaims.filter((c) => c.subjectKey === s);
      return mine.length === 2 && mine.filter((c) => c.status === "accepted").length === 1 && mine.filter((c) => c.status === "corroborated").length === 1;
    }),
    [...new Set(sceneClaims.map((c) => c.status))].join(", "));

  const acceptances = decisions.filter((d) => d.decisionType === "accept_claim" && d.authority === "deterministic_rule");
  t.check("every accepted scene reading rests on a critic's support at its own anchor, by the kernel's rule and not by a count of readers",
    every(sceneClaims.filter((c) => c.status === "accepted"), (c) => acceptances.some((d) => d.rationale === "independent_verification_supports_anchor" && d.evidence.some((e) => e.claimId === c.claimId && e.link === "supports"))));

  /* ── the pack's own arithmetic ── */
  const derived = totals(claims);
  t.check("each recording ends with one derived total of its speaker turns, accepted",
    derived.length === 2 && every(derived, (c) => c.status === "accepted" && c.subjectType === "recording" && c.unit === "turns"));

  t.check("each recording's derived total equals the fixture's own sum for that recording",
    every(derived, (c) => c.value.quantity === truth.totals[c.subjectKey].turns),
    derived.map((c) => `${c.subjectKey}=${c.value.quantity} (fixture ${truth.totals[c.subjectKey].turns})`).join(", "));

  t.check("a derived total names every reading it was computed from, and each of those is an accepted reading of a scene of that same recording",
    every(derived, (c) => c.inputClaimIds.length === truth.totals[c.subjectKey].scenes
      && c.inputClaimIds.every((id) => {
        const input = claims.find((x) => x.claimId === id);
        return input && input.status === "accepted" && input.predicate === "speaker_turns" && input.subjectKey.startsWith(`${c.subjectKey}/scene/`);
      })));

  t.check("a derived total is accepted by the rule that names this pack's own derivation task type",
    every(derived, (c) => acceptances.some((d) => d.rationale === `derived:${TASK.sumTurns}` && d.evidence.some((e) => e.claimId === c.claimId && e.link === "supports"))));

  /* ── the decision for one recording rests on that recording alone ── */
  const compositions = decisions.filter((d) => d.decisionType === "proceed");
  t.check("one decision was composed per recording, from accepted evidence",
    compositions.length === 2 && same(sorted(compositions.map((d) => d.subjectKey)), ["recording/0", "recording/1"]));

  t.check("a recording's decision cites only claims about that recording — never a claim about the other one",
    every(compositions, (d) => d.evidence.length > 0 && d.evidence.every((e) => {
      const cited = claims.find((c) => c.claimId === e.claimId);
      return cited && (cited.subjectKey === d.subjectKey || cited.subjectKey.startsWith(`${d.subjectKey}/`));
    })),
    compositions.map((d) => `${d.subjectKey}: ${d.evidence.length} cited`).join(", "));

  t.check("a recording's decision cites its own derived total and every accepted reading beneath it",
    every(compositions, (d) => {
      const cited = new Set(d.evidence.map((e) => e.claimId));
      const own = claims.filter((c) => c.status === "accepted" && (c.subjectKey === d.subjectKey || c.subjectKey.startsWith(`${d.subjectKey}/`)));
      return own.length === 4 && own.every((c) => cited.has(c.claimId));
    }));

  t.check("the composer was never shown another recording's claims — the packet it was handed carries only its own subject",
    every(packetsOf(executors["arbiter-family-one"], "decision_composer"), (p) => p.context.claims.length > 0
      && p.context.claims.every((c) => c.subjectKey === p.subjectKey || c.subjectKey.startsWith(`${p.subjectKey}/`))),
    packetsOf(executors["arbiter-family-one"], "decision_composer").map((p) => `${p.subjectKey}:${p.context.claims.length}`).join(", "));
}

/* ═══════════════════════════ (2) a reading past the end of its scene */

t.section("(2) a scene reader that reports a range past the end of its scene is refused");

{
  const overrun = 60_000;
  const w = world("transcripts/overrun", {
    recordings: 1, scenesPerRecording: 2,
    mocks: { scripts: { "reader-family-two": (packet, base) => {
      if (packet.roleKey !== "scene_reader" || packet.subjectKey !== "recording/0/scene/0") return base;
      const envelope = structuredClone(base);
      envelope.anchors[0].locator = { start_ms: envelope.anchors[0].locator.start_ms, end_ms: envelope.anchors[0].locator.end_ms + overrun };
      return envelope;
    } } },
  });
  const { truth, wf, repo, scheduler } = w;
  await scheduler.plan();
  const driven = await drive(scheduler);
  const tasks = await repo.listTasks(wf);
  const claims = await repo.listClaims({ workflowId: wf });
  const scene = truth.recordings[0].scenes[0];
  const offender = tasks.find((x) => x.taskType === TASK.readScene && x.subjectKey === "recording/0/scene/0" && x.independenceGroup === READER_B);
  const attempts = await repo.listAttempts(offender.taskId);

  t.check("the second reader was told to claim a range running past the end of the scene it was handed",
    attempts.length === 1 && attempts[0].rawResult.anchors[0].locator.end_ms === scene.endMs + overrun,
    `scene ends ${scene.endMs}, the reading claims ${attempts[0].rawResult.anchors[0].locator.end_ms}`);

  t.check("the attempt is failed_known, its validation invalid, and the problem says the reading lies outside the segment it names",
    attempts[0].state === "failed_known" && attempts[0].validationState === "invalid"
    && attempts[0].validationProblems.some((p) => /lies outside the segment it names/.test(p)),
    `${attempts[0].state}/${attempts[0].validationState}: ${attempts[0].validationProblems.join("; ")}`);

  t.check("the task fails known, and its reason names the invalid envelope rather than blaming the source",
    offender.state === "failed_known" && /^invalid_envelope:/.test(offender.terminalReason ?? ""), `${offender.state}: ${offender.terminalReason}`);

  t.check("nothing from that answer entered the record: the refused reading produced no claim and no anchor",
    claims.every((c) => c.taskId !== offender.taskId) && (await repo.listAnchors(claims.map((c) => c.claimId))).every((a) => a.locator.end_ms !== scene.endMs + overrun));

  t.check("the attempt still keeps what the executor returned, verbatim — the over-long range is on the record as it was said",
    attempts[0].rawResult !== null && attempts[0].rawResult.anchors[0].locator.end_ms === scene.endMs + overrun
    && attempts[0].rawResult.claims[0].value.quantity === scene.turns && typeof attempts[0].rawResultHash === "string");

  const disagreements = await repo.listDisagreements(wf);
  const decisions = await repo.listDecisions(wf);
  const hold = disagreements.find((d) => d.kind === "coverage" && d.subjectSignature.subject_key === "recording/0/scene/0");
  t.check("the scene read only once is held for a person: a coverage disagreement in needs_human with its hold decision",
    hold?.state === "needs_human" && decisions.some((d) => d.disagreementId === hold.disagreementId && d.decisionType === "hold" && d.status === "needs_human"),
    disagreements.map((d) => `${d.kind}:${d.state}`).join(", "));

  t.check("the first reader's claim of that scene is never accepted — one reading is not a read scene",
    every(claims.filter((c) => c.subjectKey === "recording/0/scene/0"), (c) => c.status !== "accepted" && c.status !== "verified"),
    claims.filter((c) => c.subjectKey === "recording/0/scene/0").map((c) => `${c.independenceGroup}:${c.status}`).join(", "));

  t.check("the other scene of the same recording was read, compared and accepted all the same — one bad reading stops one subject",
    claims.some((c) => c.subjectKey === "recording/0/scene/1" && c.status === "accepted" && c.value.quantity === truth.recordings[0].scenes[1].turns));

  t.check("with a scene held, the recording's total is not computed behind the person's back",
    totals(claims).length === 0 && tasks.find((x) => x.taskType === TASK.sumTurns).state === "cancelled",
    tasks.find((x) => x.taskType === TASK.sumTurns).state);

  t.check("the workflow ends partial, because a subject waits for a person",
    driven.report.workflow.state === "partial", driven.report.workflow.state);

  /* The kernel's own geometry, on this pack's locator space alone. */
  const range = { start_ms: scene.startMs, end_ms: scene.endMs };
  t.check("locatorInside says a scene's own range is inside itself, an inner range is inside it, and a range past its end is not",
    locatorInside(range, range)
    && locatorInside({ start_ms: scene.startMs + 10, end_ms: scene.endMs - 10 }, range)
    && !locatorInside({ start_ms: scene.startMs, end_ms: scene.endMs + overrun }, range)
    && !locatorInside({ start_ms: scene.startMs - 1, end_ms: scene.endMs }, range));

  t.check("a locator with no time range at all is not judged against a scene's range — the kernel only compares geometries both sides have",
    locatorInside({}, range) && locatorInside(range, {}));
}

/* ═══════════════════════════ (3) two readers differ over one scene */

t.section("(3) a value disagreement is verified, adjudicated and resolved on what the source shows");

{
  const wrongBy = 3;
  const truthPeek = syntheticTranscriptSet({ seed: "transcripts/dispute", recordings: 1, scenesPerRecording: 2 });
  const disputed = truthPeek.recordings[0].scenes[0];
  const w = world("transcripts/dispute", {
    recordings: 1, scenesPerRecording: 2,
    mocks: { scripts: { "reader-family-two": (packet, base) => {
      if (packet.roleKey !== "scene_reader" || packet.subjectKey !== "recording/0/scene/0") return base;
      const envelope = structuredClone(base);
      const wrong = disputed.turns + wrongBy;
      envelope.claims[0].value = { known: true, quantity: wrong, text: `${wrong} turns`, attributes: { topic: disputed.topic } };
      return envelope;
    } } },
  });
  const { truth, wf, repo, scheduler } = w;
  await scheduler.plan();
  const driven = await drive(scheduler);
  const tasks = await repo.listTasks(wf);
  const claims = await repo.listClaims({ workflowId: wf });
  const decisions = await repo.listDecisions(wf);
  const disagreements = await repo.listDisagreements(wf);
  const mine = readings(claims).filter((c) => c.subjectKey === "recording/0/scene/0");
  const trueReading = mine.find((c) => c.value.quantity === disputed.turns);
  const falseReading = mine.find((c) => c.value.quantity === disputed.turns + wrongBy);

  t.check("the two blind readers of one scene reported two different numbers of speaker turns",
    !!trueReading && !!falseReading && trueReading.independenceGroup !== falseReading.independenceGroup,
    mine.map((c) => `${c.independenceGroup}=${c.value.quantity}`).join(", "));

  const dispute = disagreements.find((d) => d.kind === "value");
  t.check("the comparison recorded one value disagreement over that scene, holding both readings as candidates",
    disagreements.length === 1 && dispute && same(sorted(dispute.claimIds), sorted(mine.map((c) => c.claimId)))
    && dispute.subjectSignature.predicate === "speaker_turns",
    JSON.stringify(dispute?.subjectSignature ?? null));

  const compare = tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.compare && x.subjectKey === "recording/0/scene/0");
  const verify = tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.verifyDisagreement && x.disagreementId === dispute.disagreementId);
  const adjudicate = tasks.find((x) => x.taskType === KERNEL_TASK_TYPES.adjudicate && x.disagreementId === dispute.disagreementId);
  t.check("the kernel opened one verification and one adjudication of that disagreement, each one level deeper than the comparison that raised it",
    !!verify && !!adjudicate && verify.depth === compare.depth + 1 && adjudicate.depth === compare.depth + 1
    && verify.parentTaskId === compare.taskId && adjudicate.parentTaskId === compare.taskId);

  t.check("the arbiter waits for the verifier: it does not decide before the source has been reopened",
    (await repo.getDependencies(adjudicate.taskId)).some((d) => d.dependsOnTaskId === verify.taskId && d.kind === "requires_completion"));

  t.check("the verifier reopened the disputed scene: its packet carried that segment and the competing readings anonymised, without their groups",
    (() => {
      const packet = w.registry.packetsSeen.find((p) => p.taskId === verify.taskId);
      return packet && packet.sources.some((s) => s.segmentKind === "scene") && packet.context.claims.length === 2
        && packet.context.claims.every((c) => c.independenceGroup === null) && same(sorted(packet.context.claims.map((c) => c.ref)), ["A", "B"]);
    })());

  const resolution = decisions.find((d) => d.disagreementId === dispute.disagreementId && d.decisionType === "accept_claim");
  t.check("the disagreement ends resolved by a machine decision that accepts one reading",
    dispute.state === "resolved" && resolution?.status === "machine_decided" && resolution.authority === "adjudicator"
    && dispute.resolutionDecisionId === resolution.decisionId,
    `${dispute.state} / ${resolution?.status}`);

  t.check("the reading the source supports is the one accepted, and it carries the fixture's own number",
    (await repo.getClaim(trueReading.claimId)).status === "accepted" && trueReading.value.quantity === disputed.turns,
    `accepted ${disputed.turns}`);

  t.check("the reading the source contradicts ends rejected, cited by the decision as what it decided against",
    (await repo.getClaim(falseReading.claimId)).status === "rejected"
    && resolution.evidence.some((e) => e.claimId === falseReading.claimId && e.link === "contradicts")
    && resolution.evidence.some((e) => e.claimId === trueReading.claimId && e.link === "supports"));

  t.check("the adjudication rests on evidence the record holds, and on an attempt of the arbiter that made it",
    resolution.decidedByAttemptId !== null
    && (await repo.listAttempts(adjudicate.taskId)).some((a) => a.attemptId === resolution.decidedByAttemptId && a.state === "succeeded")
    && resolution.evidence.some((e) => e.anchorId !== null));

  t.check("the recording's derived total rests on the adjudicated value, so it still equals the fixture's sum",
    totals(claims).length === 1 && totals(claims)[0].value.quantity === truth.totals["recording/0"].turns
    && totals(claims)[0].inputClaimIds.includes(trueReading.claimId) && !totals(claims)[0].inputClaimIds.includes(falseReading.claimId),
    `${totals(claims)[0]?.value.quantity} of ${truth.totals["recording/0"].turns}`);

  t.check("a settled disagreement is not a held one: the run finishes completed with nothing waiting for a person",
    driven.report.workflow.state === "completed" && disagreements.every((d) => d.state !== "needs_human"),
    driven.report.workflow.state);
}

/* ═══════════════════════════ (4) the kernel is shaped by neither pack */

t.section("(4) the kernel's own source knows nothing of either pack");

/* Comments blanked out, line structure kept, so a word used as prose can be
   told from a word the kernel's code actually says. */
function codeOnly(text) {
  let out = "", inBlock = false, inLine = false, quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } else out += " "; continue; }
    if (inBlock) { if (c === "*" && next === "/") { inBlock = false; out += "  "; i++; } else out += c === "\n" ? c : " "; continue; }
    if (quote) { if (c === "\\") { out += "  "; i++; continue; } if (c === quote) quote = null; out += c; continue; }
    if (c === "/" && next === "*") { inBlock = true; out += "  "; i++; continue; }
    if (c === "/" && next === "/") { inLine = true; out += "  "; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; continue; }
    out += c;
  }
  return out;
}

/* Every word either pack uses for its own parts, subjects and quantities. */
const PACK_WORDS = ["scene", "scenes", "recording", "recordings", "transcript", "transcripts", "sheet", "sheets", "entry", "entries",
  "category", "categories", "turn", "turns", "region", "regions", "table", "tables", "note", "notes"];

const hits = [];
for (const [file, text] of kernelSource) {
  const lines = text.split("\n");
  const code = codeOnly(text).split("\n");
  for (const word of PACK_WORDS) {
    const pattern = new RegExp(`\\b${word}\\b`, "gi");
    lines.forEach((line, i) => {
      if ((line.match(pattern) ?? []).length === 0) return;
      hits.push({ file, line: i + 1, word, inCode: (code[i].match(pattern) ?? []).length > 0, text: line.trim().slice(0, 96) });
    });
  }
}
console.log(`\n         every hit of a pack word in kernel/*.ts (${hits.length} lines; "code" means outside comments):`);
for (const h of hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.word.localeCompare(b.word))) {
  console.log(`         ${h.inCode ? "code   " : "comment"} kernel/${h.file}:${h.line}  ${h.word}  ·  ${h.text}`);
}

/* Three of the twenty words are ordinary English and ordinary JavaScript,
   and each is owned by one part of the kernel that predates both packs. */
const GENERIC = { entries: "JavaScript's own Object.entries and Map.entries", notes: "the validation notes an arbiter may be shown", table: "the router's routing table" };
const domainWordsInCode = hits.filter((h) => h.inCode && !(h.word in GENERIC));

/* The scan is only worth anything if it can tell a word the kernel says
   from a word a comment uses. Proved on a line of each, before it is used. */
const scannerProbe = codeOnly('/* alpha */ const beta = 1; // gamma\nconst delta = "epsilon";\n');
t.check("the scan can tell code from prose: it keeps what the kernel says and blanks what its comments say",
  !/alpha/.test(scannerProbe) && !/gamma/.test(scannerProbe) && /beta/.test(scannerProbe) && /delta/.test(scannerProbe) && /epsilon/.test(scannerProbe));

t.check("the twenty words are checked against the kernel as whole tokens, and the scan finds both kinds of hit to judge",
  hits.length > 0 && PACK_WORDS.length === 20 && hits.some((h) => h.inCode) && hits.some((h) => !h.inCode),
  `${hits.length} lines carry one: ${hits.filter((h) => h.inCode).length} in code, ${hits.filter((h) => !h.inCode).length} in comments`);

t.check("not one of this pack's words — scene, scenes, recording, recordings, transcript, transcripts, turn, turns — appears in kernel code at all",
  !hits.some((h) => h.inCode && ["scene", "scenes", "recording", "recordings", "transcript", "transcripts", "turn", "turns"].includes(h.word)),
  hits.filter((h) => ["scene", "scenes", "recording", "recordings", "transcript", "transcripts", "turn", "turns"].includes(h.word)).map((h) => `${h.file}:${h.line}(${h.inCode ? "code" : "comment"})`).join(", ") || "no hit anywhere");

t.check("nor does any of the other pack's words — sheet, sheets, entry, category, categories, region, regions, tables, note — appear in kernel code",
  !hits.some((h) => h.inCode && ["sheet", "sheets", "entry", "category", "categories", "region", "regions", "tables", "note"].includes(h.word)),
  hits.filter((h) => h.inCode && ["sheet", "sheets", "entry", "category", "categories", "region", "regions", "tables", "note"].includes(h.word)).map((h) => `${h.file}:${h.line}`).join(", ") || "none in code");

t.check("the only pack words the kernel's code says at all are the three that are ordinary English and ordinary JavaScript",
  domainWordsInCode.length === 0 && new Set(hits.filter((h) => h.inCode).map((h) => h.word)).size === 3,
  [...new Set(hits.filter((h) => h.inCode).map((h) => `${h.word}: ${GENERIC[h.word]}`))].join("; "));

t.check("each of those three stays in the part of the kernel that owns it, and nowhere else",
  same(sorted([...new Set(hits.filter((h) => h.inCode && h.word === "entries").map((h) => h.file))]), ["memory-repository.ts", "packet-builder.ts", "planning.ts", "visibility.ts"])
  && same(sorted([...new Set(hits.filter((h) => h.inCode && h.word === "notes").map((h) => h.file))]), ["packet-builder.ts", "roles.ts", "visibility.ts"])
  && same(sorted([...new Set(hits.filter((h) => h.inCode && h.word === "table").map((h) => h.file))]), ["router.ts"]),
  [...new Set(hits.filter((h) => h.inCode).map((h) => `${h.word}→${h.file}`))].join(", "));

t.check("no kernel file holds a pack word as a string literal of its own — nothing there can be compared against \"scene\" or \"table\"",
  ![...kernelSource.values()].some((text) => PACK_WORDS.some((word) => new RegExp(`(["'\`])${word}\\1`, "i").test(text))));

const packNames = [
  new SyntheticTranscriptsPack().id, ...new SyntheticTranscriptsPack().roles.map((r) => r.roleKey), ...Object.values(TASK),
  new SyntheticRecordsPack().id, ...new SyntheticRecordsPack().roles.map((r) => r.roleKey), ...Object.values(RECORD_TASK),
];
const named = [];
for (const [file, text] of kernelSource) for (const name of packNames) if (text.includes(name)) named.push(`${file}:${name}`);
t.check("no kernel file names either pack, any of its roles or any of its task types",
  named.length === 0 && packNames.length >= 14, named.join(", ") || `${packNames.length} pack names checked`);

t.check("the scheduler — the largest thing in the kernel — holds no branch for a pack: not one occurrence of the word both packs are named with",
  !/synthetic/i.test(kernelSource.get("scheduler.ts")) && kernelSource.get("scheduler.ts").length > 50_000,
  `${kernelSource.get("scheduler.ts").split("\n").length} lines`);

t.check("and neither does any other kernel file",
  [...kernelSource.entries()].every(([, text]) => !/synthetic/i.test(text)), `${kernelSource.size} files`);

t.section("(4b) both packs are packs on the same terms");

for (const pack of [new SyntheticTranscriptsPack(), new SyntheticRecordsPack()]) {
  const registry = new RoleRegistry(pack);
  const problems = registry.assertConsistent();
  t.check(`the ${pack.id} pack passes RoleRegistry.assertConsistent() with nothing to report`, problems.length === 0, problems.join("; "));
  t.check(`the ${pack.id} registry is the kernel's six roles plus the pack's own, and the pack's are analysts, discoverers and derivers only`,
    registry.all().length === KERNEL_ROLES.length + pack.roles.length
    && KERNEL_ROLES.every((r) => registry.role(r.roleKey).version === r.version)
    && pack.roles.every((r) => ["analyst", "discoverer", "deriver"].includes(r.kind)),
    registry.keys.join(", "));
  t.check(`every task type of the ${pack.id} pack is namespaced with the pack's own id`,
    every(pack.roles.flatMap((r) => r.taskTypes), (tt) => tt.startsWith(`${pack.id}:`)),
    pack.roles.flatMap((r) => r.taskTypes).join(", "));
}

/* The consistency check has teeth: the same pack, with one task type
   stripped of its namespace, is reported — so the two passes above are
   passes and not silence. */
const sceneReader = new SyntheticTranscriptsPack().roles.find((r) => r.roleKey === "scene_reader");
const looseProblems = new RoleRegistry({ id: "synthetic-transcripts", version: "1.0", objectives: {}, roles: [{ ...sceneReader, taskTypes: ["read_scene"] }] }).assertConsistent();
t.check("assertConsistent notices a pack task type that has lost its namespace — the two passes above are not silence",
  looseProblems.length === 1 && /not namespaced to synthetic-transcripts/.test(looseProblems[0]), looseProblems.join("; "));

await t.refused("a pack may not take over a kernel task type: a role of its own serving compare_claims is refused when the registry is built",
  async () => new RoleRegistry({ id: "synthetic-transcripts", version: "1.0", objectives: {}, roles: [{ ...sceneReader, taskTypes: [KERNEL_TASK_TYPES.compare] }] }));

await t.refused("a pack that names a discoverer which is not one of its discoverer roles is refused at planning, before any work is admitted",
  async () => {
    const pack = new SyntheticTranscriptsPack();
    const confused = Object.assign(Object.create(Object.getPrototypeOf(pack)), pack, { discovererFor: () => "scene_reader" });
    const truth = syntheticTranscriptSet({ seed: "transcripts/confused", recordings: 1, scenesPerRecording: 2 });
    const { registry } = mockExecutors(truth);
    await assemble({ manifest: truth.manifest, pack: confused, executors: registry, clock: manualClock() }).scheduler.plan();
  });

t.check("no kernel task type is namespaced to a pack — the kernel's own vocabulary carries no owner",
  every(Object.values(KERNEL_TASK_TYPES), (tt) => !tt.includes(":")), Object.values(KERNEL_TASK_TYPES).join(", "));

t.check("the two packs share no task type and no role key, so neither could be mistaken for the other",
  Object.values(TASK).every((tt) => !Object.values(RECORD_TASK).includes(tt))
  && new SyntheticTranscriptsPack().roles.every((r) => !new SyntheticRecordsPack().roles.some((x) => x.roleKey === r.roleKey)));

const packDir = (name) => fileURLToPath(new URL(`../domains/${name}/`, import.meta.url));
const packSources = (name) => readdirSync(packDir(name)).filter((f) => f.endsWith(".ts")).map((f) => ({ file: `${name}/${f}`, text: readFileSync(`${packDir(name)}${f}`, "utf8") }));
const crossImports = [
  ...packSources("synthetic-transcripts").filter((s) => /synthetic-records/.test(s.text)).map((s) => s.file),
  ...packSources("synthetic-records").filter((s) => /synthetic-transcripts/.test(s.text)).map((s) => s.file),
];
t.check("neither pack imports, mentions or otherwise reaches the other — a pack is optional, and nothing depends on which one is installed",
  crossImports.length === 0 && packSources("synthetic-transcripts").length === 3 && packSources("synthetic-records").length === 3,
  crossImports.join(", ") || "no cross-reference in either direction");

t.check("every import a pack file makes goes to the kernel, to the shared scripted executor, or to its own directory",
  [...packSources("synthetic-transcripts"), ...packSources("synthetic-records")].every((s) =>
    (s.text.match(/from "([^"]+)"/g) ?? []).every((m) => /"\.\.\/\.\.\/kernel\/|"\.\.\/mock-executor\.ts"|"\.\/[a-z-]+\.ts"/.test(m))));

/* ═══════════════════════════ (5) the fixture invents the same world twice */

t.section("(5) the fixture is deterministic in its seed");

{
  const one = syntheticTranscriptSet({ seed: "transcripts/determinism", recordings: 2, scenesPerRecording: 3 });
  const two = syntheticTranscriptSet({ seed: "transcripts/determinism", recordings: 2, scenesPerRecording: 3 });
  const other = syntheticTranscriptSet({ seed: "transcripts/determinism-2", recordings: 2, scenesPerRecording: 3 });

  t.check("the same seed invents the same manifest, byte for byte", canonical(one.manifest) === canonical(two.manifest));
  t.check("the same seed invents the same recordings: identities, durations, scene ranges, topics and speaker turns",
    canonical(one.recordings) === canonical(two.recordings) && one.recordings.length === 2);
  t.check("the same seed gives the same content hashes, which is what makes a task id the same across runs",
    same(sorted([...one.bySceneHash.keys()]), sorted([...two.bySceneHash.keys()])) && one.bySceneHash.size === 6);
  t.check("the same seed gives the same totals", canonical(one.totals) === canonical(two.totals));
  t.check("a different seed invents a different world: another workflow, other recordings, other scenes",
    other.manifest.workflowId !== one.manifest.workflowId && canonical(other.recordings) !== canonical(one.recordings)
    && [...other.bySceneHash.keys()].every((h) => !one.bySceneHash.has(h)));
  t.check("the shape asked for is the shape returned, whatever the seed",
    every(other.recordings, (r) => r.scenes.length === 3) && other.recordings.length === 2 && Object.keys(other.totals).length === 2);
}

/* ═══════════════════════════ every door stayed closed */

t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
