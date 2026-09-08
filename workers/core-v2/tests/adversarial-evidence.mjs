/* What the evidence skeptics found: a correction that obeyed no rule, an
   anchor on a sheet nobody handed over, a reader counting, one mark reported
   twelve times, a reader corroborating itself, a majority hidden in a rationale.
   Each is refused now, and each refusal is a test. */
import { harness, closeNetwork } from "./harness.mjs";
import { validateEnvelope } from "../result-validator.ts";
import { PACKET_VERSION } from "../contracts.ts";
import { buildTaskGraph } from "../graph-builder.ts";
import { syntheticManifest } from "../fixtures/synthetic-project.ts";
import { DEFAULT_POLICY } from "../orchestration-policy.ts";
import { InMemoryOrchestrationRepository } from "../repository.ts";
import { AgentRouter } from "../router.ts";
import { Scheduler } from "../scheduler.ts";
import { simulate } from "../cli.ts";
import { MockAgentExecutor } from "../executors/mock-agent-executor.ts";
import { DeterministicExecutor, emptyEnvelope } from "../executors/deterministic-executor.ts";
import { ExecutorRegistry } from "../executors/executor.ts";
import { compareClaims } from "../comparison.ts";
import { planFollowUps } from "../follow-up-planner.ts";

const t = harness("what the evidence skeptics found");
const tripped = closeNetwork();
const manifest = syntheticManifest();
const opts = { owner: "w", leaseTtlMs: 60_000, now: () => 0 };
const families = ["reader-family-one", "reader-family-two", "reader-family-three", "critic-family-one", "critic-family-two", "arbiter-family-one"];
const withBehaviour = (override) => {
  const registry = new ExecutorRegistry();
  registry.register(new DeterministicExecutor(), ["deterministic"]);
  for (const family of families) {
    const mock = new MockAgentExecutor(family);
    const base = mock.execute.bind(mock);
    registry.register({ family, execute: async (packet) => override(packet, base) }, [family]);
  }
  return registry;
};
const runWith = async (registry, policy = DEFAULT_POLICY) => {
  const repo = new InMemoryOrchestrationRepository();
  const s = new Scheduler(repo, manifest, policy, new AgentRouter(), registry, opts);
  await s.plan();
  const run = await s.runUntilQuiescent();
  return { repo, run, registry };
};
const envelopeFor = (packet, over = {}) => ({ ...emptyEnvelope(packet), ...over });

/* Real packets from a real simulation, to write envelopes against. */
const sim = await simulate({ quiet: true });
const seen = sim.executors.packetsSeen;
const arbiterPacket = seen.find((p) => p.taskType === "adjudicate" && p.context.assessments.length && p.context.disagreements[0]?.kind === "value");
const supported = arbiterPacket.context.assessments.find((a) => a.assessment === "supports").claimRef;
const contradicted = arbiterPacket.context.assessments.find((a) => a.assessment === "contradicts").claimRef;
const supportingAnchors = arbiterPacket.context.assessments.filter((a) => a.claimRef === supported).flatMap((a) => a.anchorIds);
const ownAnchorsOf = (ref) => arbiterPacket.context.claims.find((c) => c.ref === ref).anchors.map((a) => a.anchorId);
const adjudicate = (over) => envelopeFor(arbiterPacket, { adjudication: { outcome: "accept_claim", disagreementId: arbiterPacket.context.disagreements[0].disagreementId, acceptedClaimRef: null, correctedValue: null, correctedUnit: null, rationale: "the reopened source reads so", evidenceAnchorIds: supportingAnchors, followUp: null, ...over } });

t.section("D · a correction obeys every rule a claim obeys");
{
  let v = validateEnvelope(arbiterPacket, adjudicate({ outcome: "correct", correctedValue: { known: true, quantity: 0, text: null }, correctedUnit: "each" }));
  t.check("a correction to zero with no source text is refused", !v.ok && v.problems.some((p) => /zero/.test(p)), v.problems.join("; "));
  v = validateEnvelope(arbiterPacket, adjudicate({ outcome: "correct", correctedValue: { known: true, quantity: null, text: null }, correctedUnit: "each" }));
  t.check("a correction that knows the quantity but carries none is refused", !v.ok && v.problems.some((p) => /neither a quantity nor its text|no reading/.test(p)));
  v = validateEnvelope(arbiterPacket, adjudicate({ outcome: "correct", correctedValue: { known: true, quantity: 3, text: "3" }, correctedUnit: "each", evidenceAnchorIds: ["anchor_0000000000000000"] }));
  t.check("a correction resting on an anchor the packet never showed is refused", !v.ok && v.problems.some((p) => /did not present/.test(p)));
  v = validateEnvelope(arbiterPacket, adjudicate({ outcome: "correct", correctedValue: { known: true, quantity: 3, text: "3" }, correctedUnit: "each" }));
  t.check("a correction with a reading, a unit and the verifier's anchors is valid", v.ok, v.problems.join("; "));
}

t.section("D · E · an arbiter's evidence is what the packet showed, and never a majority");
{
  let v = validateEnvelope(arbiterPacket, adjudicate({ acceptedClaimRef: supported, evidenceAnchorIds: ["anchor_that_does_not_exist"] }));
  t.check("accepting on an anchor id the packet never presented is refused", !v.ok && v.problems.some((p) => /did not present/.test(p)));
  v = validateEnvelope(arbiterPacket, adjudicate({ outcome: "reject_all", evidenceAnchorIds: ["made-up-anchor"] }));
  t.check("rejecting every reading on a made-up anchor is refused", !v.ok && v.problems.some((p) => /did not present/.test(p)));
  v = validateEnvelope(arbiterPacket, adjudicate({ outcome: "reject_all", evidenceAnchorIds: ownAnchorsOf(contradicted) }));
  t.check("rejecting every reading on the readings' own anchors is valid", v.ok, v.problems.join("; "));
  const noted = { ...arbiterPacket, context: { ...arbiterPacket.context, validation: ["claim A: an anchor box lies outside the region it names"] } };
  v = validateEnvelope(noted, adjudicate({ acceptedClaimRef: supported, rationale: "the majority of readers agree" }));
  t.check("a majority rationale is refused even when code attached a validation note", !v.ok && v.problems.some((p) => /majority/.test(p)));
  v = validateEnvelope(arbiterPacket, adjudicate({ acceptedClaimRef: contradicted, evidenceAnchorIds: [...supportingAnchors, ...ownAnchorsOf(contradicted)] }));
  t.check("accepting a reading the verifier contradicted is refused — no wording required", !v.ok && v.problems.some((p) => /contradicts/.test(p)));
  v = validateEnvelope(arbiterPacket, adjudicate({ acceptedClaimRef: supported, evidenceAnchorIds: ownAnchorsOf(contradicted), rationale: "A and B concur; two readers against one settles it" }));
  t.check("accepting a reading on nothing but the losing reading's anchors is refused", !v.ok && v.problems.some((p) => /own anchor/.test(p)));
  v = validateEnvelope(arbiterPacket, adjudicate({ acceptedClaimRef: supported }));
  t.check("accepting the reading the verifier supported, on the verifier's anchors, is valid", v.ok, v.problems.join("; "));
}

t.section("D · an anchor points at what the packet handed over");
{
  const packet = seen.find((p) => p.taskType === "extract_schedule" && p.independenceGroup === "reader-a");
  const region = packet.sources[0];
  const inside = [region.bbox[0] + 0.01, region.bbox[1] + 0.01, region.bbox[0] + 0.1, region.bbox[1] + 0.05];
  const anchor = (over = {}) => ({ anchorKey: "a", sourceKind: "page_bbox", documentId: region.documentId, pageId: region.pageId, regionId: region.regionId, bbox: inside, quotedText: "H9 4", locator: {}, ...over });
  const claim = { claimKey: "h9", subjectType: "component_type", subjectKey: "H9", predicate: "scheduled_quantity", value: { known: true, quantity: 4, text: "4" }, unit: "each", observationBasis: "printed", scope: {}, anchorKeys: ["a"], machineConfidence: 0.9 };
  let v = validateEnvelope(packet, envelopeFor(packet, { claims: [claim], anchors: [anchor()] }));
  t.check("a claim anchored inside the region it was handed is valid", v.ok, v.problems.join("; "));
  v = validateEnvelope(packet, envelopeFor(packet, { claims: [claim], anchors: [anchor({ sourceKind: "human_record", documentId: null, pageId: null, regionId: null, bbox: null })] }));
  t.check("a model role citing a human record is refused", !v.ok && v.problems.some((p) => /human record/.test(p)));
  v = validateEnvelope(packet, envelopeFor(packet, { claims: [claim], anchors: [anchor({ documentId: "doc_arch", pageId: "pg_y3", regionId: "rg_y3_notes", bbox: [0.1, 0.1, 0.2, 0.2] })] }));
  t.check("an anchor on another document's region is refused", !v.ok && v.problems.some((p) => /did not hand over/.test(p)));
  v = validateEnvelope(packet, envelopeFor(packet, { claims: [claim], anchors: [anchor({ documentId: "doc_nope", pageId: "pg_nope", regionId: "rg_nope" })] }));
  t.check("an anchor on a region that is not in the manifest is refused", !v.ok && v.problems.some((p) => /did not hand over/.test(p)));
  v = validateEnvelope(packet, envelopeFor(packet, { claims: [claim], anchors: [anchor({ bbox: [0, 0, 0.05, 0.05] })] }));
  t.check("a box outside the region it names is refused", !v.ok && v.problems.some((p) => /outside the region/.test(p)));
  v = validateEnvelope(packet, envelopeFor(packet, { claims: [{ ...claim, subjectKey: "PIER-P", predicate: "drawn_quantity", observationBasis: "counted_marks", value: { known: true, quantity: 100, text: "100" } }], anchors: [anchor()] }));
  t.check("a reader returning a counted total for a family is refused — only code counts", !v.ok && v.problems.some((p) => /only code/.test(p)));
  v = validateEnvelope(packet, envelopeFor(packet, { claims: [{ ...claim, value: { known: true, quantity: 0, text: "  " } }], anchors: [anchor()] }));
  t.check("whitespace is not source text for a zero", !v.ok && v.problems.some((p) => /zero/.test(p)));
  v = validateEnvelope(packet, envelopeFor(packet, { claims: [{ ...claim, value: { known: false, quantity: null, text: "0" } }], anchors: [anchor()] }));
  t.check("an unknown carrying a reading is refused", !v.ok && v.problems.some((p) => /unknown is null/.test(p)));
  v = validateEnvelope(packet, envelopeFor(packet, { claims: [{ ...claim, predicate: "qty", value: { known: true, quantity: null, text: null } }], anchors: [anchor()] }));
  t.check("a known value with no reading is refused whatever the predicate is called", !v.ok && v.problems.some((p) => /no reading|neither/.test(p)));
  v = validateEnvelope(packet, envelopeFor(packet, { claims: [{ ...claim, anchorKeys: ["a", "a", "a"] }], anchors: [anchor()] }));
  t.check("the same anchor named three times is refused", !v.ok && v.problems.some((p) => /more than once/.test(p)));
  let threw = false;
  try { v = validateEnvelope(packet, { ...envelopeFor(packet), claims: undefined }); } catch { threw = true; }
  t.check("an envelope without a claims array is refused, not thrown", !threw && !v.ok && v.problems.some((p) => /lacks a claims array/.test(p)));
  try { v = validateEnvelope(packet, envelopeFor(packet, { claims: [{ ...claim, anchorKeys: undefined }], anchors: [anchor()] })); } catch { threw = true; }
  t.check("a claim without an anchorKeys list is refused, not thrown", !threw && !v.ok);
}

t.section("D · one mark is one box");
{
  const packet = seen.find((p) => p.taskType === "locate_symbol_family" && p.independenceGroup === "reader-a");
  const region = packet.sources.find((s) => s.regionKind === "plan_view");
  const box = (i) => [region.bbox[0] + 0.05 * (i + 1), region.bbox[1] + 0.05, region.bbox[0] + 0.05 * (i + 1) + 0.02, region.bbox[1] + 0.07];
  const anchor = (key, b) => ({ anchorKey: key, sourceKind: "page_bbox", documentId: region.documentId, pageId: region.pageId, regionId: region.regionId, bbox: b, quotedText: null, locator: {} });
  const instance = (mark, keys) => ({ claimKey: mark, subjectType: "component_instance", subjectKey: `${packet.subjectKey.split("/").pop()}/${mark}`, predicate: "located_at", value: { known: true, quantity: null, text: mark, attributes: { mark_type: "P1" } }, unit: null, observationBasis: "printed", scope: {}, anchorKeys: keys, machineConfidence: 0.9 });
  let v = validateEnvelope(packet, envelopeFor(packet, { claims: [instance("P-1", ["one"]), instance("P-2", ["one"])], anchors: [anchor("one", box(0))] }));
  t.check("two instances on one anchor are refused", !v.ok && v.problems.some((p) => /shares its box/.test(p)));
  v = validateEnvelope(packet, envelopeFor(packet, { claims: [instance("P-1", ["one"]), instance("P-2", ["two"])], anchors: [anchor("one", box(0)), anchor("two", box(0))] }));
  t.check("two instances on the same box under two keys are refused", !v.ok && v.problems.some((p) => /same box/.test(p)));
  v = validateEnvelope(packet, envelopeFor(packet, { claims: [instance("P-1", ["one"]), instance("P-2", ["two"])], anchors: [anchor("one", box(0)), anchor("two", box(1))] }));
  t.check("two instances, two boxes — valid", v.ok, v.problems.join("; "));
}

t.section("D · code names inputs the packet presented");
{
  const packet = seen.find((p) => p.taskType === "count_instances" && p.context.claims.length);
  const first = packet.context.claims[0];
  const a = first.anchors[0];
  const anchor = { anchorKey: "m", sourceKind: a.sourceKind, documentId: a.documentId, pageId: a.pageId, regionId: a.regionId, bbox: a.bbox, quotedText: null, locator: {} };
  const count = (inputs) => envelopeFor(packet, { claims: [{ claimKey: "drawn", subjectType: "component_type", subjectKey: packet.subjectKey, predicate: "drawn_quantity", value: { known: true, quantity: 999, text: "999" }, unit: "each", observationBasis: "counted_marks", scope: {}, anchorKeys: ["m"], machineConfidence: null, inputClaimIds: inputs }], anchors: [anchor] });
  let v = validateEnvelope(packet, count(["claim_invented_1"]));
  t.check("a count computed from a claim the packet never presented is refused", !v.ok && v.problems.some((p) => /did not present/.test(p)));
  v = validateEnvelope(packet, count([first.ref]));
  t.check("a count computed from a presented claim is valid", v.ok, v.problems.join("; "));
  const comparator = seen.find((p) => p.taskType === "detect_disagreements" && p.context.claims.length);
  v = validateEnvelope(comparator, envelopeFor(comparator, { calculations: [{ calculationKey: "agreement-0", formula: "x", inputClaimIds: ["claim_that_does_not_exist"], unit: null, wasteAssumption: null, rounding: null, result: 1 }] }));
  t.check("an agreement group over a claim the packet never presented is refused", !v.ok && v.problems.some((p) => /did not present/.test(p)));
}

t.section("D · a critic's evidence points where the claim points, once");
{
  const packet = {
    packetVersion: PACKET_VERSION, workflowId: "wf", taskId: "t", parentTaskId: null, roleKey: "evidence_critic", roleVersion: "1.0", taskType: "verify_claim", subjectKey: "s", objective: "",
    sources: [
      { sourceId: "r1", kind: "region", documentId: "d", pageId: "p1", regionId: "r1", regionKind: "schedule", label: null, bbox: [0, 0, 1, 1], contentHash: "h1", locator: {} },
      { sourceId: "r2", kind: "region", documentId: "d", pageId: "p2", regionId: "r2", regionKind: "schedule", label: null, bbox: [0, 0, 1, 1], contentHash: "h2", locator: {} },
    ],
    dependencies: [], independenceGroup: null, blindContext: false, allowedActions: [],
    limits: { maximumSources: 4, maximumClaims: 0, maximumFollowUps: 4, maximumDepth: 2 }, expectedOutputContract: "x", inputFingerprint: "fp",
    context: { claims: [{ ref: "A", subjectType: "component_type", subjectKey: "H1", predicate: "member_size", value: { known: true, quantity: null, text: "(2) 2x10" }, unit: null, observationBasis: "printed", scope: {}, anchors: [{ anchorId: "anchor_a", sourceKind: "page_bbox", documentId: "d", pageId: "p1", regionId: "r1", bbox: [0.1, 0.1, 0.2, 0.2], quotedText: "x", locator: {} }], status: "proposed", independenceGroup: null }], assessments: [], disagreements: [], depth: 1, validation: [] },
  };
  const ev = (region, page) => ({ anchorKey: "ev", sourceKind: "page_bbox", documentId: "d", pageId: page, regionId: region, bbox: [0.1, 0.1, 0.2, 0.2], quotedText: "x", locator: {} });
  const assess = (kind = "supports") => ({ claimRef: "A", assessment: kind, reasonCode: "r", explanation: "e", anchorKeys: ["ev"] });
  let v = validateEnvelope(packet, envelopeFor(packet, { assessments: [assess()], anchors: [ev("r2", "p2")] }));
  t.check("a supporting assessment anchored on a sheet the claim never pointed at is refused", !v.ok && v.problems.some((p) => /not where the claim/.test(p)));
  v = validateEnvelope(packet, envelopeFor(packet, { assessments: [assess("contradicts"), assess("supports")], anchors: [ev("r1", "p1")] }));
  t.check("two verdicts on one claim in one answer are refused", !v.ok && v.problems.some((p) => /assessed twice/.test(p)));
  v = validateEnvelope(packet, envelopeFor(packet, { assessments: [assess()], anchors: [ev("r1", "p1")] }));
  t.check("one verdict, anchored where the claim is anchored — valid", v.ok, v.problems.join("; "));
}

t.section("E · agreement is between readers");
{
  const claim = (id, group, q) => ({ claimId: id, independenceGroup: group, subjectType: "component_type", subjectKey: "H1", predicate: "scheduled_quantity", value: { known: true, quantity: q, text: String(q) }, unit: "each", observationBasis: "printed", scope: {} });
  let r = compareClaims("wf", "s", [claim("a1", "reader-a", 2), claim("a2", "reader-a", 2)]);
  t.check("one reader saying a thing twice is not an agreement", r.agreements.length === 0);
  r = compareClaims("wf", "s", [claim("a1", "reader-a", 2), claim("a2", "reader-a", 2)], ["reader-a", "reader-b"]);
  t.check("told that a second reader read and saw nothing, the comparator records the thing as missing", r.disagreements.length === 1 && r.disagreements[0].kind === "missing");
  const { repo } = await runWith(withBehaviour(async (packet, base) => {
    if (packet.taskType === "extract_schedule" && packet.independenceGroup === "reader-b" && packet.sources[0].regionId === "rg_x2_sched") return emptyEnvelope(packet);
    return base(packet);
  }));
  const headers = [...repo.claims.values()].filter((c) => c.subjectKey === "H1" && c.independenceGroup === "reader-a");
  const adjudicated = new Set([...repo.decisions.values()].filter((d) => d.authority === "adjudicator" && d.disagreementId).flatMap((d) => d.evidence.filter((e) => e.link === "supports").map((e) => e.claimId)));
  t.check("when the second reader returned nothing, the first reader's claims were never corroborated, and any acceptance came through a verifier and an arbiter", headers.length > 0 && headers.every((c) => c.status !== "corroborated" && (c.status !== "accepted" || adjudicated.has(c.claimId))), headers.map((c) => c.status).join(","));
  t.check("every one of them is recorded as seen by one reader only", [...repo.disagreements.values()].filter((d) => d.kind === "missing" && d.subjectSignature.subject_key === "H1").length >= 2);
  t.check("no rule accepted a reading of that schedule on one reader's word", ![...repo.decisions.values()].some((d) => d.rationale === "corroborated_by_independent_anchored_readings" && d.evidence.some((e) => headers.some((h) => h.claimId === e.claimId))));
}

t.section("E · two readers agreeing that a value is unreadable is not a fact");
{
  const { repo } = await runWith(withBehaviour(async (packet, base) => {
    const env = await base(packet);
    if (packet.taskType === "extract_schedule" && packet.sources[0].regionId === "rg_y2_sched") for (const c of env.claims) if (c.subjectKey === "W1" && c.predicate === "scheduled_quantity") c.value = { known: false, quantity: null, text: null };
    return env;
  }));
  const w1 = [...repo.claims.values()].filter((c) => c.subjectKey === "W1" && c.predicate === "scheduled_quantity");
  t.check("the two unknowns are corroborated, and neither is accepted", w1.length === 2 && w1.every((c) => c.status === "corroborated"), w1.map((c) => c.status).join(","));
  t.check("no decision rests on them", ![...repo.decisions.values()].some((d) => d.evidence.some((e) => w1.some((c) => c.claimId === e.claimId))));
}

t.section("E · a critic may ask about what it saw, and a blind reading is not accepted on a critic's word");
{
  const builder = [...sim.repo.tasks.values()].find((x) => x.taskType === "resolve_relationships");
  const accepted = [...sim.repo.claims.values()].find((c) => c.status === "accepted" && c.subjectType === "component_instance");
  const unseen = [...sim.repo.claims.values()].find((c) => c.status === "rejected");
  const ask = (claimId) => ({ actionType: "request_evidence_critic", reasonCode: "doubt", targetSourceIds: [], expectedInformation: "a check", parentTaskId: builder.taskId, currentDepth: 0, idempotencyFingerprint: `critic-${claimId}`, claimRef: claimId });
  const a = await planFollowUps(builder, [ask(accepted.claimId)], manifest, sim.repo, DEFAULT_POLICY);
  const b = await planFollowUps(builder, [ask(unseen.claimId)], manifest, sim.repo, DEFAULT_POLICY);
  t.check("the relationship builder may ask for a critic on an accepted claim it was handed", a.children.length === 1 && a.children[0].taskType === "verify_claim");
  t.check("and not on a rejected claim it was never shown", b.children.length === 0 && b.refused.length === 1 && /produced or was handed/.test(b.refused[0].reason), b.refused[0]?.reason);
  const blind = [...sim.repo.claims.values()].filter((c) => c.independenceGroup !== null && c.status === "accepted");
  t.check("no blind reading in the simulation was accepted by a critic alone — agreement or adjudication did it", blind.length > 0 && ![...sim.repo.decisions.values()].some((d) => d.rationale === "critic_supports_anchor" && d.evidence.some((e) => e.link === "supports" && blind.some((c) => c.claimId === e.claimId))));
}

t.section("E · correct and reject_all, end to end");
{
  const isH2 = (packet) => packet.taskType === "adjudicate" && packet.context.disagreements[0]?.subjectSignature.subject_key === "H2" && packet.context.assessments.length > 0;
  const { repo } = await runWith(withBehaviour(async (packet, base) => {
    const env = await base(packet);
    if (isH2(packet)) {
      const supports = packet.context.assessments.filter((a) => a.assessment === "supports").flatMap((a) => a.anchorIds);
      env.adjudication = { outcome: "correct", disagreementId: packet.context.disagreements[0].disagreementId, acceptedClaimRef: null, correctedValue: { known: true, quantity: 3, text: "3" }, correctedUnit: "each", rationale: "the reopened row prints 3", evidenceAnchorIds: supports, followUp: null };
    }
    return env;
  }));
  const dis = [...repo.disagreements.values()].find((d) => d.subjectSignature.subject_key === "H2" && d.kind === "value");
  const corrected = [...repo.claims.values()].find((c) => c.subjectKey === "H2" && c.predicate === "scheduled_quantity" && c.taskId === repo.tasks.get([...repo.tasks.values()].find((x) => x.taskType === "adjudicate" && x.disagreementId === dis.disagreementId && x.state === "completed").taskId).taskId);
  t.check("the arbiter's correction resolved the dispute", dis.state === "resolved");
  t.check("the corrected claim is accepted, anchored on the verifier's evidence, with its anchors distinct", corrected && corrected.status === "accepted" && corrected.value.quantity === 3 && corrected.anchorIds.length >= 1 && new Set(corrected.anchorIds).size === corrected.anchorIds.length, corrected?.status);
  t.check("both readings were rejected", dis.claimIds.every((id) => repo.claims.get(id).status === "rejected"));
  const { repo: rejected } = await runWith(withBehaviour(async (packet, base) => {
    const env = await base(packet);
    if (isH2(packet)) {
      const own = packet.context.claims.flatMap((c) => c.anchors.map((a) => a.anchorId));
      env.adjudication = { outcome: "reject_all", disagreementId: packet.context.disagreements[0].disagreementId, acceptedClaimRef: null, correctedValue: null, correctedUnit: null, rationale: "the row is struck through on the sheet", evidenceAnchorIds: own, followUp: null };
    }
    return env;
  }));
  const d2 = [...rejected.disagreements.values()].find((d) => d.subjectSignature.subject_key === "H2" && d.kind === "value");
  const decision = rejected.decisions.get(d2.resolutionDecisionId);
  t.check("rejecting every reading on the readings' own anchors resolves the dispute with a machine decision", d2.state === "resolved" && decision && decision.decisionType === "reject_all" && decision.status === "machine_decided" && d2.claimIds.every((id) => rejected.claims.get(id).status === "rejected"));
  const { repo: bogus, run } = await runWith(withBehaviour(async (packet, base) => {
    const env = await base(packet);
    if (isH2(packet)) env.adjudication = { outcome: "reject_all", disagreementId: packet.context.disagreements[0].disagreementId, acceptedClaimRef: null, correctedValue: null, correctedUnit: null, rationale: "trust me", evidenceAnchorIds: ["anchor_0000000000000000"], followUp: null };
    return env;
  }));
  const d3 = [...bogus.disagreements.values()].find((d) => d.subjectSignature.subject_key === "H2" && d.kind === "value");
  t.check("rejecting on an anchor nobody presented is refused, the arbiter's task fails known, and the dispute goes to a person", d3.state === "needs_human" && [...bogus.tasks.values()].some((x) => x.taskType === "adjudicate" && x.disagreementId === d3.disagreementId && x.state === "failed_known" && /invalid_envelope/.test(x.terminalReason)), `${d3.state}; ${run.escalations.join(" | ")}`);
}

t.section("D · a reading cut short is kept, compared, and never accepted");
{
  const { repo } = await runWith(withBehaviour(async (packet, base) => {
    const env = await base(packet);
    if (packet.taskType === "extract_schedule" && packet.sources[0].regionId === "rg_y2_sched") { env.outcome = "insufficient_evidence"; env.limitations.push("the lower rows were cut off"); }
    return env;
  }));
  const windows = [...repo.claims.values()].filter((c) => ["W1", "W2"].includes(c.subjectKey));
  t.check("the claims of a reading that said it could not finish are marked as such", windows.length > 0 && windows.every((c) => c.incompleteSourceAttempt));
  t.check("they were compared, and none was accepted", windows.some((c) => c.status === "corroborated") && windows.every((c) => c.status !== "accepted"), windows.map((c) => c.status).join(","));
}
t.check("no network call was attempted", tripped() === 0);
t.finish();
