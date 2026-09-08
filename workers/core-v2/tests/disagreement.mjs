import { harness, closeNetwork } from "./harness.mjs";
import { compareClaims, normaliseUnit } from "../comparison.ts";
import { simulate } from "../cli.ts";
import { validateEnvelope } from "../result-validator.ts";
import { PACKET_VERSION } from "../contracts.ts";

const t = harness("where readers differ");
const tripped = closeNetwork();

const claim = (id, group, over = {}) => ({
  claimId: id, independenceGroup: group, subjectType: "component_type", subjectKey: "HDR-4", predicate: "scheduled_quantity",
  value: { known: true, quantity: 4, text: "4" }, unit: "each", observationBasis: "printed", scope: { sheet: "S-3" }, ...over,
});

t.section("what code decides before anyone is asked");
let r = compareClaims("wf", "s", [claim("a", "reader-a"), claim("b", "reader-b")]);
t.check("matching claims do not create a disagreement", r.disagreements.length === 0 && r.agreements.length === 1);
r = compareClaims("wf", "s", [claim("a", "reader-a"), claim("b", "reader-b", { subjectKey: "hdr 4", unit: "ea", scope: { Sheet: "s-3" } })]);
t.check("casing, mark punctuation, unit spelling and scope casing are normalised, not disputed", r.disagreements.length === 0);
r = compareClaims("wf", "s", [claim("a", "reader-a"), claim("b", "reader-b", { value: { known: true, quantity: 3, text: "3" } })]);
t.check("a different value creates a value disagreement", r.disagreements.length === 1 && r.disagreements[0].kind === "value");
r = compareClaims("wf", "s", [claim("a", "reader-a"), claim("b", "reader-b", { unit: "ft" })]);
t.check("a different unit creates a unit disagreement", r.disagreements[0]?.kind === "unit");
r = compareClaims("wf", "s", [claim("a", "reader-a"), claim("b", "reader-b", { scope: { sheet: "S-4" } })]);
t.check("a different scope is a different subject, so one reader is missing it", r.disagreements.length === 2 && r.disagreements.every((d) => d.kind === "missing"));
r = compareClaims("wf", "s", [claim("a", "reader-a"), claim("b", "reader-b", { observationBasis: "counted_marks" })]);
t.check("a different basis creates a critical count-basis disagreement", r.disagreements[0]?.kind === "count_basis" && r.disagreements[0]?.severity === "critical");
r = compareClaims("wf", "s", [claim("a", "reader-a"), claim("b", "reader-b", { value: { known: false, quantity: null, text: null } })]);
t.check("known against unknown is a value disagreement, not an agreement on nothing", r.disagreements[0]?.kind === "value");
r = compareClaims("wf", "s", [claim("a", "reader-a"), claim("b", "reader-b", { value: { known: true, quantity: 0, text: "0" } })]);
t.check("four against a measured zero is a value disagreement", r.disagreements[0]?.kind === "value");
t.check("the comparator returns no winner and no ranking", !("winner" in r) && !("ranking" in r) && !("score" in r));
t.check("units are normalised by a table, never by a model", normaliseUnit("ea") === "each" && normaliseUnit("EACH") === "each" && normaliseUnit("lf") === "ft");

t.section("a majority is not proof");
r = compareClaims("wf", "s", [claim("a", "reader-a"), claim("b", "reader-b"), claim("c", "reader-c", { value: { known: true, quantity: 3, text: "3" } })]);
t.check("two agreeing readers and one dissenter is a disagreement, not an acceptance", r.disagreements.length === 1 && r.disagreements[0].claimIds.length === 3);
const packet = {
  packetVersion: PACKET_VERSION, workflowId: "wf", taskId: "t", parentTaskId: null, roleKey: "evidence_arbiter", roleVersion: "1.0", taskType: "adjudicate",
  subjectKey: "s", objective: "", sources: [], dependencies: [], independenceGroup: null, blindContext: false, allowedActions: [],
  limits: { maximumSources: 8, maximumClaims: 0, maximumFollowUps: 4, maximumDepth: 1 }, expectedOutputContract: "adjudication@1", inputFingerprint: "fp",
  context: { claims: [{ ref: "A", anchors: [], value: {} }, { ref: "B", anchors: [], value: {} }, { ref: "C", anchors: [{ anchorId: "anchor-1", sourceKind: "page_bbox", documentId: "d", pageId: "p", regionId: "r", bbox: [0.1, 0.1, 0.2, 0.2], quotedText: "3", locator: {} }], value: {} }], assessments: [], disagreements: [], depth: 1, validation: [] },
};
const envelope = (adjudication) => ({ packetVersion: PACKET_VERSION, taskId: "t", roleKey: "evidence_arbiter", roleVersion: "1.0", outcome: "completed",
  claims: [], anchors: [], assessments: [], disagreements: [], requestedActions: [], limitations: [], rawResponseReference: null, adjudication, decisions: [], calculations: [] });
const majority = validateEnvelope(packet, envelope({ outcome: "accept_claim", disagreementId: "d", acceptedClaimRef: "A", correctedValue: null, correctedUnit: null,
  rationale: "the majority of readers agree on A", evidenceAnchorIds: [], followUp: null }));
t.check("an adjudication that rests on a majority is refused by validation", !majority.ok && majority.problems.some((p) => /majority/.test(p)));
const evidence = validateEnvelope(packet, envelope({ outcome: "accept_claim", disagreementId: "d", acceptedClaimRef: "C", correctedValue: null, correctedUnit: null,
  rationale: "the reopened schedule row prints 3; C is anchored to it and A and B are not", evidenceAnchorIds: ["anchor-1"], followUp: null }));
t.check("an adjudication that names the source and accepts the lone anchored reading is valid", evidence.ok, evidence.problems.join("; "));

t.section("in the simulation");
const { repo, executors } = await simulate({ quiet: true });
const dis = [...repo.disagreements.values()];
const h2 = dis.find((d) => d.subjectSignature.subject_key === "H2");
t.check("the planted H2 quantity conflict became a value disagreement", h2 && h2.kind === "value");
t.check("it was resolved by evidence: the reading that matched the source was accepted, the other rejected",
  h2?.state === "resolved" && (await Promise.all(h2.claimIds.map((id) => repo.getClaim(id)))).map((c) => c.status).sort().join(",") === "accepted,rejected");
const accepted = (await Promise.all(h2.claimIds.map((id) => repo.getClaim(id)))).find((c) => c.status === "accepted");
t.check("and the accepted reading is the one the source supports (3), not the first one read", accepted?.value.quantity === 3);
const decision = [...repo.decisions.values()].find((d) => d.decisionId === h2.resolutionDecisionId);
t.check("the decision that settled it names both claims and the source it rested on", decision && decision.evidence.some((e) => e.link === "supports") && decision.evidence.some((e) => e.link === "contradicts") && decision.evidence.some((e) => e.link === "context" && e.anchorId));
t.check("the disagreement points at that decision", h2.resolutionDecisionId === decision?.decisionId);
const critic = executors.packetsSeen.filter((p) => p.taskType === "verify_disagreement" && p.context.disagreements[0]?.subjectSignature.subject_key === "H2");
t.check("the verifier received only the disputed packet: two claims, one disagreement, the disputed sources", critic.length >= 1 && critic.every((p) => p.context.claims.length === 2 && p.context.disagreements.length === 1 && p.sources.length >= 1 && p.sources.length <= 6));
const p2 = dis.find((d) => d.subjectSignature.subject_key === "P2");
t.check("a dispute the verifier could not read twice went to a person", p2?.state === "needs_human" && /rounds of criticism/.test(p2.needsHumanReason));
t.check("its claims are unresolved — not accepted, not deleted", (await Promise.all(p2.claimIds.map((id) => repo.getClaim(id)))).every((c) => c && c.status === "unresolved"));
t.check("and a hold decision awaits that person", [...repo.decisions.values()].some((d) => d.disagreementId === p2.disagreementId && d.status === "needs_human" && d.decisionType === "hold"));
const win = dis.find((d) => String(d.subjectSignature.subject_key).startsWith("W"));
t.check("'ea' against 'each' created no disagreement at all", !win);
t.check("no network call was attempted", tripped() === 0);
t.finish();
