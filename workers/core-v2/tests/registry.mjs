import { harness } from "./harness.mjs";
import { ROLE_REGISTRY, ROLE_KEYS, assertRegistryConsistent, roleForTaskType } from "../role-registry.ts";
import { AgentRouter } from "../router.ts";

const t = harness("the registry, and what it refuses to be");

t.section("roles are work, not providers");
t.check("the registry is internally consistent", assertRegistryConsistent().length === 0, assertRegistryConsistent().join("; "));
const required = ["workflow_planner","sheet_cartographer","schedule_reader","notes_reader","legend_reader","symbol_locator","dimension_reader",
  "relationship_builder","evidence_critic","disagreement_verifier","evidence_arbiter","deterministic_counter","assembly_calculator","decision_composer"];
t.check("all fourteen required roles are registered", required.every((r) => ROLE_KEYS.includes(r)), required.filter((r) => !ROLE_KEYS.includes(r)).join(", "));
t.check("no role is named after a provider", ROLE_KEYS.every((k) => !/claude|openai|gemini|gpt|anthropic|google/i.test(k)));
t.check("every role is versioned and carries a contract", ROLE_KEYS.every((k) => ROLE_REGISTRY[k].version && ROLE_REGISTRY[k].inputContract && ROLE_REGISTRY[k].outputContract));

t.section("code is code, models are models");
for (const k of ["deterministic_counter", "assembly_calculator", "deterministic_comparator", "deterministic_ingestor", "workflow_planner"]) {
  t.check(`${k} is a code executor`, ROLE_REGISTRY[k].executorKind === "deterministic" && ROLE_REGISTRY[k].routingProfile === "deterministic");
}
t.check("the counter and the calculator are not language-model roles", ROLE_REGISTRY.deterministic_counter.executorKind !== "agent" && ROLE_REGISTRY.assembly_calculator.executorKind !== "agent");
const router = new AgentRouter();
const counter = router.select({ roleKey: "deterministic_counter", taskType: "count_instances", requiresVisualInput: false, independenceGroup: "reader-b", previousExecutorFamilies: ["reader-family-one"], estimatedInputSize: 1 });
t.check("a code role routes to code whatever the table says", counter.executorFamily === "deterministic" && counter.modelConfiguration === "code");

t.section("what each role may and may not do");
t.check("extractors may not propose decisions", ["schedule_reader", "notes_reader", "legend_reader", "symbol_locator", "dimension_reader"].every((k) => !ROLE_REGISTRY[k].mayProposeDecision));
t.check("extractors do not see competing claims", ["schedule_reader", "symbol_locator"].every((k) => !ROLE_REGISTRY[k].maySeeCompetingClaims));
t.check("the critic assesses and does not assert", ROLE_REGISTRY.evidence_critic.producesAssessments && ROLE_REGISTRY.evidence_critic.maximumClaims === 0);
t.check("the arbiter proposes an adjudication, not claims", ROLE_REGISTRY.evidence_arbiter.producesAdjudication && ROLE_REGISTRY.evidence_arbiter.maximumClaims === 0);
t.check("the composer produces decisions and no claims", ROLE_REGISTRY.decision_composer.producesDecisions && ROLE_REGISTRY.decision_composer.maximumClaims === 0);
t.check("blind reading is required of schedules, notes and symbol families", ["schedule_reader", "notes_reader", "symbol_locator"].every((k) => ROLE_REGISTRY[k].requiresIndependentReading));
t.check("no role may launch another agent — the vocabulary has no such action", ROLE_KEYS.every((k) => ROLE_REGISTRY[k].allowedActions.every((a) => !/launch|call|spawn|invoke/.test(a))));
t.check("one task type resolves to exactly one role", (() => { try { return roleForTaskType("extract_schedule").roleKey === "schedule_reader" && roleForTaskType("adjudicate").roleKey === "evidence_arbiter"; } catch { return false; } })());

t.section("routing preserves independence");
const first = router.select({ roleKey: "schedule_reader", taskType: "extract_schedule", requiresVisualInput: true, independenceGroup: "reader-a", previousExecutorFamilies: [], estimatedInputSize: 1 });
const second = router.select({ roleKey: "schedule_reader", taskType: "extract_schedule", requiresVisualInput: true, independenceGroup: "reader-b", previousExecutorFamilies: [first.executorFamily], estimatedInputSize: 1 });
t.check("a second blind reading goes to a family that has not read the subject", second.executorFamily !== first.executorFamily && second.preservesIndependence);
t.check("and may never be served from a cached attempt", second.cacheReuseAllowed === false);
const exhausted = router.select({ roleKey: "schedule_reader", taskType: "extract_schedule", requiresVisualInput: true, independenceGroup: "reader-c", previousExecutorFamilies: ["reader-family-one", "reader-family-two"], estimatedInputSize: 1 });
t.check("when every family has read the subject, the loss of independence is recorded, not hidden", exhausted.preservesIndependence === false && /cannot be preserved/.test(exhausted.reason));
t.check("no routing family names a provider", [first, second, exhausted].every((s) => !/claude|openai|gemini|gpt|anthropic|google/i.test(s.executorFamily + s.modelConfiguration)));
t.finish();
