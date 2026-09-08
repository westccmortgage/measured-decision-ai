/* THE REGISTRY, AND WHAT IT REFUSES TO BE.
 *
 * docs/core-v2.md §1: the kernel ships six universal roles; a pack adds
 * analysts, discoverers and derivers under its own namespace and never
 * redefines the kernel's. kernel/roles.ts and kernel/router.ts: a role is
 * the work, never the provider; code is never routed to a model; blind
 * readings go to distinct executor domains, and the domain is the
 * registry's, not the table's.
 *
 * Every check below runs in memory. No network, no database, no provider.
 * The list of provider words this file tests against is read out of the
 * kernel's own source at run time, so nothing here names one.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { harness, closeNetwork } from "./harness.mjs";
import { AGENT_ACTION_TYPES, KERNEL_TASK_TYPES, TASK_PHASES } from "../kernel/contracts.ts";
import { KERNEL_ROLES, RoleRegistry } from "../kernel/roles.ts";
import { AgentRouter, DEFAULT_ROUTING_TABLE } from "../kernel/router.ts";
import { ExecutorRegistry } from "../kernel/executors.ts";
import { INDEPENDENCE_GROUPS } from "../kernel/domain.ts";
import { KernelDeterministicExecutor } from "../kernel/deterministic.ts";
import { SyntheticRecordsPack } from "../domains/synthetic-records/pack.ts";
import { SyntheticTranscriptsPack } from "../domains/synthetic-transcripts/pack.ts";
import { ScriptedExecutor } from "../domains/mock-executor.ts";

const attempts = closeNetwork();
const t = harness("the registry, and what it refuses to be");

/* The kernel's own list of provider words, lifted from kernel/roles.ts so
   this file never has to write one down. */
const rolesSource = readFileSync(fileURLToPath(new URL("../kernel/roles.ts", import.meta.url)), "utf8");
const providerMatch = rolesSource.match(/PROVIDER_WORDS\s*=\s*\/(.+?)\/i;/);
const providerPattern = providerMatch ? new RegExp(providerMatch[1], "i") : null;
const firstProviderWord = providerMatch ? providerMatch[1].split("|")[0] : null;

const recordsPack = new SyntheticRecordsPack();
const transcriptsPack = new SyntheticTranscriptsPack();

/* A pack that adds nothing, so the registry holds the kernel's roles alone;
   and a way to make a pack that adds exactly the roles a check needs. */
const packWith = (roles, id = "fake-pack") => ({ id, version: "0.0", roles });
const analystRole = (overrides = {}) => ({
  roleKey: "fake_reader", version: "1.0", kind: "analyst", phase: "analyze", taskTypes: ["fake-pack:read_thing"],
  description: "Reads one thing blind.", inputContract: "one thing", outputContract: "claims about the thing",
  maximumSources: 1, maximumClaims: 8, maximumFollowUpDepth: 1, requiresVisualInput: false, requiresIndependentReading: true,
  allowedActions: [], routingProfile: "general_analysis", executorKind: "model",
  producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: false, producesSegments: false,
  ...overrides,
});
const problemsOf = (roles, id) => new RoleRegistry(packWith(roles, id)).assertConsistent();

/* ───────────────────────────────────────────────── the kernel's own roles */
t.section("the kernel's own roles");

t.check("the provider-word list was read out of the kernel's source, so this file names no provider", providerPattern !== null && firstProviderWord !== null, providerMatch ? `${providerMatch[1].split("|").length} words` : "not found");

t.check("the kernel ships exactly six universal roles", KERNEL_ROLES.length === 6, KERNEL_ROLES.map((r) => r.roleKey).join(", "));

const expectedRoles = {
  source_ingestor: { phase: "ingest", executorKind: "deterministic" },
  claim_comparator: { phase: "compare", executorKind: "deterministic" },
  evidence_critic: { phase: "verify", executorKind: "model" },
  disagreement_verifier: { phase: "verify", executorKind: "model" },
  evidence_arbiter: { phase: "adjudicate", executorKind: "model" },
  decision_composer: { phase: "compose", executorKind: "model" },
};
for (const [key, expected] of Object.entries(expectedRoles)) {
  const role = KERNEL_ROLES.find((r) => r.roleKey === key);
  t.check(`the kernel role ${key} exists in the ${expected.phase} phase and is ${expected.executorKind}, as the design table says`,
    !!role && role.phase === expected.phase && role.executorKind === expected.executorKind,
    role ? `${role.phase}/${role.executorKind}` : "missing");
}

t.check("every kernel role is versioned and states an input and an output contract",
  KERNEL_ROLES.every((r) => typeof r.version === "string" && r.version.length > 0 && r.inputContract.length > 0 && r.outputContract.length > 0),
  KERNEL_ROLES.map((r) => `${r.roleKey}@${r.version}`).join(", "));

t.check("every kernel role serves at least one kernel task type and sits in a phase the kernel knows",
  KERNEL_ROLES.every((r) => r.taskTypes.length > 0 && r.taskTypes.every((tt) => Object.values(KERNEL_TASK_TYPES).includes(tt)) && TASK_PHASES.includes(r.phase)));

t.check("a role that is code routes to code and a role that is a model routes to a model — for every kernel role",
  KERNEL_ROLES.every((r) => (r.executorKind === "deterministic") === (r.routingProfile === "deterministic")),
  KERNEL_ROLES.map((r) => `${r.roleKey}:${r.executorKind}->${r.routingProfile}`).join(" "));

t.check("the kernel roles that create no claims — critic, arbiter, composer, comparator — have maximumClaims 0",
  ["evidence_critic", "evidence_arbiter", "decision_composer", "claim_comparator"].every((k) => KERNEL_ROLES.find((r) => r.roleKey === k)?.maximumClaims === 0));

t.check("the disagreement verifier also creates no claims: it assesses, it does not read for itself",
  KERNEL_ROLES.find((r) => r.roleKey === "disagreement_verifier")?.maximumClaims === 0);

t.check("only the roles the design says produce assessments, an adjudication or decisions do so",
  KERNEL_ROLES.every((r) =>
    r.producesAssessments === (r.kind === "critic" || r.kind === "verifier")
    && r.producesAdjudication === (r.kind === "arbiter")
    && r.producesDecisions === (r.kind === "composer")));

t.check("no kernel role names a provider in its key or description", KERNEL_ROLES.every((r) => !providerPattern.test(r.roleKey) && !providerPattern.test(r.description)));

/* ───────────────────────────────────────────── what an agent may ask for */
t.section("what an agent may ask for");

const agentLaunchWords = /launch|spawn|invoke|call|delegate|run_agent|start_agent|create_agent|execute/i;
t.check("no allowed action lets an agent launch, call or delegate to another agent — it can only ask the orchestrator",
  AGENT_ACTION_TYPES.every((a) => !agentLaunchWords.test(a)), AGENT_ACTION_TYPES.join(", "));

t.check("every action a kernel role is allowed sits in the closed action vocabulary",
  KERNEL_ROLES.every((r) => r.allowedActions.every((a) => AGENT_ACTION_TYPES.includes(a))));

t.check("the deterministic kernel roles may ask for nothing at all",
  KERNEL_ROLES.filter((r) => r.executorKind === "deterministic").every((r) => r.allowedActions.length === 0));

/* ────────────────────────────────────── the registry over the two packs */
t.section("the registry over both synthetic packs");

for (const pack of [recordsPack, transcriptsPack]) {
  const registry = new RoleRegistry(pack);
  const problems = registry.assertConsistent();
  t.check(`the ${pack.id} pack's registry is consistent: assertConsistent() reports nothing`, problems.length === 0, problems.join("; "));
  t.check(`the ${pack.id} registry holds every kernel role plus the pack's own`,
    KERNEL_ROLES.every((r) => registry.keys.includes(r.roleKey)) && pack.roles.every((r) => registry.keys.includes(r.roleKey))
    && registry.all().length === KERNEL_ROLES.length + pack.roles.length);
  t.check(`every ${pack.id} role's executorKind matches its routingProfile: code never routes to a model`,
    registry.all().every((r) => (r.executorKind === "deterministic") === (r.routingProfile === "deterministic")));
  t.check(`every ${pack.id} task type is namespaced "${pack.id}:" and is served by exactly one role`,
    pack.roles.every((r) => r.taskTypes.every((tt) => tt.startsWith(`${pack.id}:`) && registry.forTaskType(tt).roleKey === r.roleKey)));
  t.check(`every ${pack.id} role is an analyst, a discoverer or a deriver — never a kernel kind`,
    pack.roles.every((r) => ["analyst", "discoverer", "deriver"].includes(r.kind)));
}

t.check("the kernel's own task types resolve to kernel roles through either pack's registry",
  [recordsPack, transcriptsPack].every((pack) => {
    const registry = new RoleRegistry(pack);
    return registry.forTaskType(KERNEL_TASK_TYPES.ingest).roleKey === "source_ingestor"
      && registry.forTaskType(KERNEL_TASK_TYPES.compare).roleKey === "claim_comparator"
      && registry.forTaskType(KERNEL_TASK_TYPES.verifyClaim).roleKey === "evidence_critic"
      && registry.forTaskType(KERNEL_TASK_TYPES.verifyDisagreement).roleKey === "disagreement_verifier"
      && registry.forTaskType(KERNEL_TASK_TYPES.adjudicate).roleKey === "evidence_arbiter"
      && registry.forTaskType(KERNEL_TASK_TYPES.compose).roleKey === "decision_composer";
  }));

await t.refused("asking the registry for a role it does not hold is refused, not answered with nothing", async () => { new RoleRegistry(recordsPack).role("no_such_role"); });
await t.refused("asking the registry for a task type nobody serves is refused", async () => { new RoleRegistry(recordsPack).forTaskType("fake-pack:nothing"); });

/* ──────────────────────────────────────────── what a pack cannot do */
t.section("what a pack cannot do");

const kernelCritic = KERNEL_ROLES.find((r) => r.roleKey === "evidence_critic");
await t.refused("a pack cannot redefine a kernel role: a pack role keyed evidence_critic makes the constructor throw", async () => {
  new RoleRegistry(packWith([{ ...kernelCritic, description: "a pack's idea of a critic" }]));
});

await t.refused("a pack cannot serve one task type from two roles: the constructor throws", async () => {
  new RoleRegistry(packWith([analystRole({ roleKey: "reader_one" }), analystRole({ roleKey: "reader_two" })]));
});

await t.refused("a pack cannot serve a kernel task type from its own role: the constructor throws on the second server of verify_claim", async () => {
  new RoleRegistry(packWith([analystRole({ taskTypes: [KERNEL_TASK_TYPES.verifyClaim] })]));
});

t.check("an empty pack is a consistent registry of the kernel's roles alone", problemsOf([]).length === 0 && new RoleRegistry(packWith([])).all().length === KERNEL_ROLES.length);

t.check("a well-formed pack analyst is accepted without a problem", problemsOf([analystRole()]).length === 0, problemsOf([analystRole()]).join("; "));

for (const kind of ["critic", "arbiter", "composer", "comparator", "ingestor", "verifier"]) {
  const problems = problemsOf([analystRole({ kind })]);
  t.check(`a pack cannot add a role of kind ${kind}: the registry reports it`,
    problems.some((p) => /pack role of kind/.test(p) && p.includes(kind)), problems.join("; "));
}

{
  const problems = problemsOf([analystRole({ taskTypes: ["other-pack:read_thing"] })]);
  t.check("a pack cannot serve a task type that is not namespaced to its own id", problems.some((p) => /not namespaced/.test(p)), problems.join("; "));
}
{
  const problems = problemsOf([analystRole({ taskTypes: ["read_thing"] })]);
  t.check("a pack cannot serve an un-namespaced task type either", problems.some((p) => /not namespaced/.test(p)), problems.join("; "));
}
{
  const problems = problemsOf([analystRole({ roleKey: `${firstProviderWord}_reader` })]);
  t.check("a pack cannot name a provider in a role key", problems.some((p) => /names a provider/.test(p)), problems.map((p) => p.replace(firstProviderWord, "<provider>")).join("; "));
}
{
  const problems = problemsOf([analystRole({ description: `Reads one thing with ${firstProviderWord}.` })]);
  t.check("a pack cannot name a provider in a role description", problems.some((p) => /names a provider/.test(p)), problems.join("; "));
}
{
  const problems = problemsOf([analystRole({ roleKey: "fake_totaliser", kind: "deriver", phase: "derive", taskTypes: ["fake-pack:total"], routingProfile: "general_analysis", executorKind: "model", requiresIndependentReading: false })]);
  t.check("a pack cannot ship a deriver that is a model: a deriver is deterministic code", problems.some((p) => /deriver that is not deterministic code/.test(p)), problems.join("; "));
}
{
  const problems = problemsOf([analystRole({ roleKey: "fake_totaliser", kind: "deriver", phase: "analyze", taskTypes: ["fake-pack:total"], routingProfile: "deterministic", executorKind: "deterministic", requiresIndependentReading: false })]);
  t.check("a pack cannot ship a deriver outside the derive phase", problems.some((p) => /deriver that is not deterministic code in the derive phase/.test(p)), problems.join("; "));
}
{
  const problems = problemsOf([analystRole({ roleKey: "fake_totaliser", kind: "deriver", phase: "derive", taskTypes: ["fake-pack:total"], routingProfile: "deterministic", executorKind: "deterministic", requiresIndependentReading: false, producesCalculations: true })]);
  t.check("a deriver that is deterministic code in the derive phase is accepted", problems.length === 0, problems.join("; "));
}
{
  const problems = problemsOf([analystRole({ routingProfile: "deterministic" })]);
  t.check("a pack role that is a model but routes to code is reported", problems.some((p) => /model but routes to code/.test(p)), problems.join("; "));
}
{
  const problems = problemsOf([analystRole({ executorKind: "deterministic" })]);
  t.check("a pack role that is code but routes to a model is reported", problems.some((p) => /code but routes to a model/.test(p)), problems.join("; "));
}
{
  const problems = problemsOf([analystRole({ producesAssessments: true })]);
  t.check("a pack analyst cannot claim a kernel role's output: producing assessments is reported", problems.some((p) => /claims a kernel role's output/.test(p)), problems.join("; "));
}
{
  const problems = problemsOf([analystRole({ producesDecisions: true })]);
  t.check("a pack analyst cannot produce decisions: that is the composer's", problems.some((p) => /claims a kernel role's output/.test(p)), problems.join("; "));
}
{
  const problems = problemsOf([analystRole({ phase: "verify" })]);
  t.check("a pack analyst outside the analyze phase is reported", problems.some((p) => /analyst outside the analyze phase/.test(p)), problems.join("; "));
}
{
  const problems = problemsOf([analystRole({ roleKey: "fake_finder", kind: "discoverer", phase: "discover", taskTypes: ["fake-pack:find"], producesSegments: false, requiresIndependentReading: false })]);
  t.check("a pack discoverer that may not produce segments is reported", problems.some((p) => /discovers but may not produce segments/.test(p)), problems.join("; "));
}
{
  const problems = problemsOf([analystRole({ maximumClaims: -1 })]);
  t.check("a limit that is not a limit — a negative maximum — is reported", problems.some((p) => /negative limit/.test(p)), problems.join("; "));
}
{
  const problems = problemsOf([analystRole({ taskTypes: [] })]);
  t.check("a pack role that serves no task type is reported", problems.some((p) => /serves no task type/.test(p)), problems.join("; "));
}

/* ─────────────────────────────────────────────────────────── the router */
t.section("the router: families are abstract, domains are the registry's");

const tableFamilies = Object.values(DEFAULT_ROUTING_TABLE).flat();
t.check("no family or configuration in the default routing table names a provider",
  tableFamilies.every((c) => !providerPattern.test(c.family) && !providerPattern.test(c.configuration)),
  tableFamilies.map((c) => c.configuration).join(", "));

t.check("the default routing table covers every routing profile a role can declare",
  ["general_analysis", "visual_analysis", "evidence_criticism", "high_reasoning_arbitration", "deterministic"].every((p) => (DEFAULT_ROUTING_TABLE[p] ?? []).length > 0));

t.check("the deterministic profile's only family is the deterministic one, configured as code",
  DEFAULT_ROUTING_TABLE.deterministic.length === 1 && DEFAULT_ROUTING_TABLE.deterministic[0].family === "deterministic" && DEFAULT_ROUTING_TABLE.deterministic[0].configuration === "code");

const roles = new RoleRegistry(recordsPack);

{
  /* A table that lies: it says code goes to a model family. */
  const lyingTable = { ...DEFAULT_ROUTING_TABLE, deterministic: [{ family: "reader-family-one", configuration: "reader-family-one/general@2", visual: true }] };
  const executors = new ExecutorRegistry();
  executors.register(new ScriptedExecutor("reader-family-one", {}), ["reader-family-one"]);
  const codeDomain = executors.register(new KernelDeterministicExecutor(recordsPack), ["deterministic"]);
  const router = new AgentRouter(lyingTable);
  for (const roleKey of ["source_ingestor", "claim_comparator", "category_totaliser"]) {
    const outcome = router.select({ roleKey, requiresVisualInput: false, independenceGroup: null, usedDomains: [] }, roles, executors);
    t.check(`the router routes ${roleKey} to the deterministic family whatever the table says`,
      outcome.ok && outcome.selection.executorFamily === "deterministic" && outcome.selection.independenceDomain === codeDomain && outcome.selection.modelConfiguration === "code",
      outcome.ok ? `${outcome.selection.executorFamily} / ${outcome.selection.modelConfiguration}` : outcome.reason);
  }
  const noCode = new ExecutorRegistry();
  noCode.register(new ScriptedExecutor("reader-family-one", {}), ["reader-family-one"]);
  const outcome = router.select({ roleKey: "source_ingestor", requiresVisualInput: false, independenceGroup: null, usedDomains: [] }, roles, noCode);
  t.check("with no deterministic executor registered, a code role is refused rather than sent to the model family the table names",
    !outcome.ok && /deterministic/.test(outcome.reason), outcome.ok ? "routed" : outcome.reason);
}

{
  const router = new AgentRouter();
  const executors = new ExecutorRegistry();
  executors.register(new ScriptedExecutor("reader-family-one", {}), ["reader-family-one"]);
  const outcome = router.select({ roleKey: "evidence_critic", requiresVisualInput: true, independenceGroup: null, usedDomains: [] }, roles, executors);
  t.check("the router refuses (ok:false) when no registered family serves the role's profile", !outcome.ok && /no registered executor family/.test(outcome.reason), outcome.ok ? "routed" : outcome.reason);
  const empty = router.select({ roleKey: "table_reader", requiresVisualInput: true, independenceGroup: "reader-a", usedDomains: [] }, roles, new ExecutorRegistry());
  t.check("the router refuses when the executor registry is empty", !empty.ok, empty.ok ? "routed" : empty.reason);
}

{
  /* Only the non-visual family of the general profile is registered. */
  const router = new AgentRouter();
  const executors = new ExecutorRegistry();
  executors.register(new ScriptedExecutor("reader-family-three", {}), ["reader-family-three"]);
  const visual = router.select({ roleKey: "note_reader", requiresVisualInput: true, independenceGroup: "reader-a", usedDomains: [] }, roles, executors);
  t.check("a role that needs visual input is refused when only non-visual families are registered", !visual.ok && /visual input/.test(visual.reason), visual.ok ? "routed" : visual.reason);
  const textual = router.select({ roleKey: "note_reader", requiresVisualInput: false, independenceGroup: "reader-a", usedDomains: [] }, roles, executors);
  t.check("the same role without the visual requirement is routed to that non-visual family", textual.ok && textual.selection.executorFamily === "reader-family-three", textual.ok ? textual.selection.executorFamily : textual.reason);
}

/* ─────────────────────────────────── independence: two instances, two domains */
t.section("independence: domains come from executor instances, not names");

{
  const executors = new ExecutorRegistry();
  const one = new ScriptedExecutor("reader-family-one", {});
  const two = new ScriptedExecutor("reader-family-two", {});
  const d1 = executors.register(one, ["reader-family-one"]);
  const d2 = executors.register(two, ["reader-family-two"]);
  t.check("two distinct executor instances receive two distinct independence domains", d1 !== d2 && /^domain:/.test(d1) && /^domain:/.test(d2), `${d1} ${d2}`);
  t.check("domainOf answers the registry's domain, and null for a family nobody serves", executors.domainOf("reader-family-one") === d1 && executors.domainOf("reader-family-two") === d2 && executors.domainOf("reader-family-nine") === null);

  const router = new AgentRouter();
  const first = router.select({ roleKey: "table_reader", requiresVisualInput: true, independenceGroup: INDEPENDENCE_GROUPS[0], usedDomains: [] }, roles, executors);
  t.check("the first blind reader of a subject is routed", first.ok, first.ok ? first.selection.executorFamily : first.reason);
  const second = first.ok
    ? router.select({ roleKey: "table_reader", requiresVisualInput: true, independenceGroup: INDEPENDENCE_GROUPS[1], usedDomains: [first.selection.independenceDomain] }, roles, executors)
    : { ok: false, reason: "first was not routed" };
  t.check("the second blind reader is routed to a different domain than the first when two instances exist",
    first.ok && second.ok && second.selection.independenceDomain !== first.selection.independenceDomain,
    second.ok ? `${first.selection.independenceDomain} then ${second.selection.independenceDomain}` : second.reason);
  t.check("both blind readings forbid cache reuse: a blind reading is never served from memory", first.ok && second.ok && first.selection.cacheReuseAllowed === false && second.selection.cacheReuseAllowed === false);
  t.check("the domain the router returns is the one the registry assigned to that family, not a label from the table",
    first.ok && second.ok && executors.domainOf(first.selection.executorFamily) === first.selection.independenceDomain && executors.domainOf(second.selection.executorFamily) === second.selection.independenceDomain);
  t.check("two blind groups dispatched in one tick, before any attempt exists, start the table at different positions and land on different families",
    (() => {
      const a = router.select({ roleKey: "table_reader", requiresVisualInput: true, independenceGroup: INDEPENDENCE_GROUPS[0], usedDomains: [] }, roles, executors);
      const b = router.select({ roleKey: "table_reader", requiresVisualInput: true, independenceGroup: INDEPENDENCE_GROUPS[1], usedDomains: [] }, roles, executors);
      return a.ok && b.ok && a.selection.executorFamily !== b.selection.executorFamily && a.selection.independenceDomain !== b.selection.independenceDomain;
    })());
  const third = router.select({ roleKey: "table_reader", requiresVisualInput: true, independenceGroup: INDEPENDENCE_GROUPS[2], usedDomains: [d1, d2] }, roles, executors);
  t.check("a third blind reader with both domains already used is refused: independence fails closed", !third.ok && /independence cannot be preserved/.test(third.reason), third.ok ? "routed" : third.reason);
  const critic = router.select({ roleKey: "evidence_critic", requiresVisualInput: true, independenceGroup: null, usedDomains: [d1] }, roles, executors);
  t.check("a critic whose only serving domain made the claim it would judge is refused",
    (() => { const only = new ExecutorRegistry(); only.register(one, ["critic-family-one"]); const o = router.select({ roleKey: "evidence_critic", requiresVisualInput: true, independenceGroup: null, usedDomains: [only.domainOf("critic-family-one")] }, roles, only); return !o.ok && /took part in what it would judge/.test(o.reason); })());
  t.check("a critic with no serving family registered is refused, not sent to a reader family", !critic.ok, critic.ok ? critic.selection.executorFamily : critic.reason);
}

{
  const executors = new ExecutorRegistry();
  const one = new ScriptedExecutor("reader-family-one", {});
  const d1 = executors.register(one, ["reader-family-one"]);
  const d2 = executors.register(one, ["reader-family-two"]);
  t.check("one instance registered under two family names is one domain", d1 === d2 && executors.domainOf("reader-family-one") === executors.domainOf("reader-family-two"), `${d1} ${d2}`);
  t.check("both family names resolve to the same executor", executors.resolve("reader-family-one").executor === executors.resolve("reader-family-two").executor);
  const router = new AgentRouter();
  const first = router.select({ roleKey: "table_reader", requiresVisualInput: true, independenceGroup: INDEPENDENCE_GROUPS[0], usedDomains: [] }, roles, executors);
  const second = first.ok
    ? router.select({ roleKey: "table_reader", requiresVisualInput: true, independenceGroup: INDEPENDENCE_GROUPS[1], usedDomains: [first.selection.independenceDomain] }, roles, executors)
    : { ok: false, reason: "first was not routed" };
  t.check("a second blind reader is refused when the only other family is an alias of the same instance: names are not independence",
    first.ok && !second.ok && /1 distinct/.test(second.reason), second.ok ? "routed" : second.reason);
  await t.refused("a family already served by one executor cannot be re-registered against another instance", async () => {
    executors.register(new ScriptedExecutor("reader-family-one", {}), ["reader-family-one"]);
  });
  t.check("re-registering the same instance under a family it already serves is harmless and keeps its domain", executors.register(one, ["reader-family-one"]) === d1);
}

/* ───────────────────────────────────────────────────────────── the doors */
t.section("every door stayed closed");
t.check("nothing in this file tried the network", attempts() === 0, `${attempts()} attempts`);

t.finish();
