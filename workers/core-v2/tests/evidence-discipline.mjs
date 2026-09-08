import { harness, closeNetwork } from "./harness.mjs";
import { validateEnvelope } from "../result-validator.ts";
import { PACKET_VERSION } from "../contracts.ts";
import { buildTaskGraph } from "../graph-builder.ts";
import { syntheticManifest } from "../fixtures/synthetic-project.ts";
import { DEFAULT_POLICY } from "../orchestration-policy.ts";
import { simulate } from "../cli.ts";
import { DeterministicExecutor } from "../executors/deterministic-executor.ts";
import { InMemoryOrchestrationRepository } from "../repository.ts";
import { specToRecord } from "../graph-builder.ts";
import { planFollowUps } from "../follow-up-planner.ts";

const t = harness("what an envelope must be");
const tripped = closeNetwork();

const packetFor = (roleKey, taskType, over = {}) => ({
  packetVersion: PACKET_VERSION, workflowId: "wf", taskId: "t", parentTaskId: null, roleKey, roleVersion: "1.0", taskType, subjectKey: "s", objective: "",
  sources: [{ sourceId: "r", kind: "region", documentId: "d", pageId: "p", regionId: "r", regionKind: "schedule", label: "S", bbox: [0, 0, 1, 1], contentHash: "h", locator: { sheet: "S-3" } }],
  dependencies: [], independenceGroup: null, blindContext: true, allowedActions: [],
  limits: { maximumSources: 3, maximumClaims: 200, maximumFollowUps: 4, maximumDepth: 2 }, expectedOutputContract: "x", inputFingerprint: "fp",
  context: { claims: [], assessments: [], disagreements: [], depth: 0, validation: [] }, ...over,
});
const envelopeFor = (roleKey, over = {}) => ({
  packetVersion: PACKET_VERSION, taskId: "t", roleKey, roleVersion: "1.0", outcome: "completed", claims: [], anchors: [], assessments: [],
  disagreements: [], requestedActions: [], limitations: [], rawResponseReference: null, adjudication: null, decisions: [], calculations: [], ...over,
});
const anchor = { anchorKey: "a1", sourceKind: "page_bbox", documentId: "d", pageId: "p", regionId: "r", bbox: [0.1, 0.1, 0.2, 0.2], quotedText: "4", locator: { sheet: "S-3" } };
const claim = (over = {}) => ({ claimKey: "c1", subjectType: "component_type", subjectKey: "HDR-4", predicate: "scheduled_quantity",
  value: { known: true, quantity: 4, text: "4" }, unit: "each", observationBasis: "printed", scope: {}, anchorKeys: ["a1"], machineConfidence: 0.9, ...over });

t.section("a claim without an anchor is not a claim");
let v = validateEnvelope(packetFor("schedule_reader", "extract_schedule"), envelopeFor("schedule_reader", { claims: [claim({ anchorKeys: [] })], anchors: [] }));
t.check("no anchor → rejected", !v.ok && v.problems.some((p) => /no anchor/.test(p)));
v = validateEnvelope(packetFor("schedule_reader", "extract_schedule"), envelopeFor("schedule_reader", { claims: [claim({ anchorKeys: ["missing"] })], anchors: [anchor] }));
t.check("an anchor the envelope does not carry → rejected", !v.ok);
v = validateEnvelope(packetFor("schedule_reader", "extract_schedule"), envelopeFor("schedule_reader", { claims: [claim()], anchors: [{ ...anchor, bbox: [10, 20, 300, 400] }] }));
t.check("a box in pixels rather than 0..1 → rejected", !v.ok && v.problems.some((p) => /normalised/.test(p)));
v = validateEnvelope(packetFor("schedule_reader", "extract_schedule"), envelopeFor("schedule_reader", { claims: [claim()], anchors: [{ ...anchor, locator: { url: "https://x/y" } }] }));
t.check("an anchor carrying a URL → rejected", !v.ok && v.problems.some((p) => /URL/.test(p)));
v = validateEnvelope(packetFor("schedule_reader", "extract_schedule"), envelopeFor("schedule_reader", { claims: [claim()], anchors: [anchor] }));
t.check("an anchored, typed, based claim → accepted", v.ok, v.problems.join("; "));

t.section("a count is marks, not a total");
const locatorPacket = packetFor("symbol_locator", "locate_symbol_family");
v = validateEnvelope(locatorPacket, envelopeFor("symbol_locator", { claims: [claim({ predicate: "drawn_quantity", observationBasis: "counted_marks", value: { known: true, quantity: 12, text: "12" } })], anchors: [anchor] }));
t.check("a locator returning one total is rejected", !v.ok && v.problems.some((p) => /total/.test(p)));
v = validateEnvelope(locatorPacket, envelopeFor("symbol_locator", { claims: [claim({ subjectType: "component_instance", subjectKey: "HDR-H/H-1", predicate: "located_at", value: { known: true, quantity: null, text: "H-1" }, unit: null })], anchors: [{ ...anchor, sourceKind: "page_region", bbox: null }] }));
t.check("an instance with no bounding box of its own is rejected", !v.ok && v.problems.some((p) => /bounding box/.test(p)));
v = validateEnvelope(locatorPacket, envelopeFor("symbol_locator", { claims: [claim({ subjectType: "component_instance", subjectKey: "HDR-H/H-1", predicate: "located_at", value: { known: true, quantity: null, text: "H-1" }, unit: null })], anchors: [anchor] }));
t.check("one instance, one box → accepted", v.ok, v.problems.join("; "));
{
  const graph = buildTaskGraph(syntheticManifest(), DEFAULT_POLICY);
  const target = graph.tasks.find((x) => x.taskType === "locate_symbol_family" && x.independenceGroup === "reader-a").taskId;
  const { repo } = await simulate({ quiet: true, behaviour: { totalOnlyTaskIds: [target] } });
  const task = repo.tasks.get(target);
  const attempt = (await repo.listAttempts(target))[0];
  t.check("in a run, a locator that answered with a total ended failed_known and its raw answer was kept", task.state === "failed_known" && attempt.rawEnvelope !== null && attempt.validationErrors.some((p) => /total/.test(p)));
  t.check("and none of that answer entered the evidence", ![...repo.claims.values()].some((c) => c.taskId === target));
}

t.section("unknown is not zero");
v = validateEnvelope(packetFor("schedule_reader", "extract_schedule"), envelopeFor("schedule_reader", { claims: [claim({ value: { known: false, quantity: 0, text: null } })], anchors: [anchor] }));
t.check("an unknown carrying a zero is rejected", !v.ok && v.problems.some((p) => /unknown is null/.test(p)));
v = validateEnvelope(packetFor("schedule_reader", "extract_schedule"), envelopeFor("schedule_reader", { claims: [claim({ value: { known: true, quantity: 0, text: null } })], anchors: [anchor] }));
t.check("a zero with no source text is rejected — a measurement has a reading", !v.ok && v.problems.some((p) => /zero/.test(p)));
v = validateEnvelope(packetFor("schedule_reader", "extract_schedule"), envelopeFor("schedule_reader", { claims: [claim({ value: { known: false, quantity: null, text: null } })], anchors: [anchor] }));
t.check("an honest unknown — null, anchored to where it could not be read — is accepted", v.ok, v.problems.join("; "));
{
  const det = new DeterministicExecutor();
  const env = await det.execute(packetFor("deterministic_counter", "count_instances", { subjectKey: "HDR-H", context: { claims: [], assessments: [], disagreements: [], depth: 0, validation: [] } }));
  t.check("a counter with nothing accepted returns insufficient evidence, not a count of zero", env.outcome === "insufficient_evidence" && env.claims.length === 0 && /unknown, not zero/.test(env.limitations[0]));
  const calc = await det.execute(packetFor("assembly_calculator", "derive_materials", { subjectKey: "PIER-P", context: { claims: [], assessments: [], disagreements: [], depth: 0, validation: [] } }));
  t.check("a calculator with a missing input invents nothing", calc.outcome === "insufficient_evidence" && calc.claims.length === 0);
}

t.section("roles stay in their lane");
v = validateEnvelope(packetFor("schedule_reader", "extract_schedule"), envelopeFor("schedule_reader", { claims: [claim()], anchors: [anchor],
  decisions: [{ decisionType: "release_for_ordering", title: "order 4", summary: { known: "x", conflicts: "x", canProceed: "x", mustWait: "x", supportingEvidence: "x" }, supportingClaimIds: [], contradictingClaimIds: [], riskLevel: "normal", actions: [] }] }));
t.check("an extractor returning a decision is rejected", !v.ok && v.problems.some((p) => /extractors do not decide/.test(p)));
v = validateEnvelope(packetFor("schedule_reader", "extract_schedule"), envelopeFor("schedule_reader", { claims: [claim()], anchors: [anchor],
  adjudication: { outcome: "accept_claim", disagreementId: "d", acceptedClaimRef: "A", correctedValue: null, correctedUnit: null, rationale: "x", evidenceAnchorIds: [], followUp: null } }));
t.check("an extractor returning an adjudication is rejected", !v.ok);
const criticPacket = packetFor("evidence_critic", "verify_claim", { blindContext: false, context: { claims: [{ ref: "A", anchors: [], value: {} }], assessments: [], disagreements: [], depth: 1, validation: [] } });
v = validateEnvelope(criticPacket, envelopeFor("evidence_critic", { claims: [claim()], anchors: [anchor] }));
t.check("a critic that creates a project fact is rejected", !v.ok && v.problems.some((p) => /critic assesses/.test(p)));
v = validateEnvelope(criticPacket, envelopeFor("evidence_critic", { assessments: [{ claimRef: "A", assessment: "supports", reasonCode: "ok", explanation: "x", anchorKeys: [] }] }));
t.check("an assessment that cites no evidence is an opinion, and is rejected", !v.ok && v.problems.some((p) => /opinion/.test(p)));
v = validateEnvelope(criticPacket, envelopeFor("evidence_critic", { assessments: [{ claimRef: "Q", assessment: "supports", reasonCode: "ok", explanation: "x", anchorKeys: ["a1"] }], anchors: [anchor] }));
t.check("an assessment of a claim the packet never presented is rejected", !v.ok);
const composerPacket = packetFor("decision_composer", "compose_decision", { blindContext: false, context: { claims: [{ ref: "claim_1", anchors: [], value: {} }], assessments: [], disagreements: [], depth: 0, validation: [] } });
v = validateEnvelope(composerPacket, envelopeFor("decision_composer", { claims: [claim()], anchors: [anchor] }));
t.check("a composer that introduces a technical claim is rejected", !v.ok && v.problems.some((p) => /creates no technical fact/.test(p)));
v = validateEnvelope(composerPacket, envelopeFor("decision_composer", { decisions: [{ decisionType: "release_for_pricing", title: "x", summary: { known: "x", conflicts: "x", canProceed: "x", mustWait: "x", supportingEvidence: "x" }, supportingClaimIds: ["claim_invented"], contradictingClaimIds: [], riskLevel: "normal", actions: [] }] }));
t.check("a decision citing a claim the packet never presented is rejected", !v.ok && v.problems.some((p) => /never presented|did not present/.test(p)));
v = validateEnvelope(composerPacket, envelopeFor("decision_composer", { decisions: [{ decisionType: "release_for_pricing", title: "x", summary: { known: "x", conflicts: "x", canProceed: "x", mustWait: "", supportingEvidence: "x" }, supportingClaimIds: ["claim_1"], contradictingClaimIds: [], riskLevel: "normal", actions: [] }] }));
t.check("a decision that does not say what must wait is rejected", !v.ok && v.problems.some((p) => /mustWait/.test(p)));
v = validateEnvelope(packetFor("deterministic_counter", "count_instances"), envelopeFor("deterministic_counter", { claims: [claim({ predicate: "drawn_quantity", observationBasis: "counted_marks", inputClaimIds: [] })], anchors: [anchor] }));
t.check("a deterministic result that names no inputs is rejected — code does not invent", !v.ok && v.problems.some((p) => /does not invent/.test(p)));
v = validateEnvelope(packetFor("schedule_reader", "extract_schedule", { allowedActions: [] }), envelopeFor("schedule_reader", { claims: [claim()], anchors: [anchor], requestedActions: [{ actionType: "read_legend", reasonCode: "x", targetSourceIds: [], expectedInformation: "", parentTaskId: "t", currentDepth: 0, idempotencyFingerprint: "f" }] }));
t.check("a request the packet did not permit does not cost the reading its claims", v.ok, v.problems.join("; "));
{
  /* The request itself is refused where requests are decided: by the planner, with an audit line. */
  const repo = new InMemoryOrchestrationRepository();
  const graph = buildTaskGraph(syntheticManifest(), DEFAULT_POLICY);
  await repo.createWorkflow({ workflowId: "wf_synthetic_0001", organizationId: "o", propertyId: "p", state: "running", cancelRequested: false, totalUnits: 0, completedUnits: 0, attentionUnits: 0 });
  await repo.planTasks(graph.tasks.map((s) => ({ ...specToRecord(s, "wf_synthetic_0001"), dependsOn: s.dependsOn })));
  const reader = await repo.getTask(graph.tasks.find((x) => x.taskType === "extract_schedule").taskId);
  const plan = await planFollowUps(reader, [{ actionType: "request_disagreement_verification", reasonCode: "x", targetSourceIds: [], expectedInformation: "", parentTaskId: reader.taskId, currentDepth: 0, idempotencyFingerprint: "f" }], syntheticManifest(), repo, DEFAULT_POLICY);
  t.check("a request the role may not make is refused by the planner and makes no task", plan.children.length === 0 && plan.refused.length === 1 && /does not permit|may not|not allowed|allowed/.test(plan.refused[0].reason), plan.refused[0]?.reason);
}

t.section("invalid output is kept, and kept out");
{
  const graph = buildTaskGraph(syntheticManifest(), DEFAULT_POLICY);
  const target = graph.tasks.find((x) => x.taskType === "extract_schedule" && x.independenceGroup === "reader-a").taskId;
  const { repo } = await simulate({ quiet: true, behaviour: { invalidEnvelopeTaskIds: [target] } });
  const attempt = (await repo.listAttempts(target))[0];
  t.check("the invalid envelope is stored on the attempt in full", attempt.rawEnvelope && attempt.rawEnvelope.claims.length === 1 && attempt.state === "failed_known");
  t.check("its problems are recorded", attempt.validationErrors.length > 0);
  t.check("nothing from it entered the evidence", ![...repo.claims.values()].some((c) => c.taskId === target));
  t.check("and the task is failed_known, not retried", repo.tasks.get(target).state === "failed_known" && (await repo.listAttempts(target)).length === 1);
}
t.check("no network call was attempted", tripped() === 0);
t.finish();
