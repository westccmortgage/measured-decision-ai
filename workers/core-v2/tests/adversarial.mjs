/* What six skeptics found when told to break the engine, kept as tests so it
   stays broken-proof. Each section names the attack; the fix lives in the
   engine. */
import { harness, closeNetwork } from "./harness.mjs";
import { buildTaskGraph, specToRecord } from "../graph-builder.ts";
import { syntheticManifest } from "../fixtures/synthetic-project.ts";
import { DEFAULT_POLICY, policyWith } from "../orchestration-policy.ts";
import { InMemoryOrchestrationRepository } from "../repository.ts";
import { AgentRouter } from "../router.ts";
import { Scheduler, normaliseEnvelope, withDeadline } from "../scheduler.ts";
import { mockExecutors, simulate } from "../cli.ts";
import { MockAgentExecutor } from "../executors/mock-agent-executor.ts";
import { emptyEnvelope } from "../executors/deterministic-executor.ts";
import { ExecutorRegistry } from "../executors/executor.ts";
import { DeterministicExecutor } from "../executors/deterministic-executor.ts";
import { anonymize, letterFor, forbiddenContent, authorshipContent, assertPacketRespectsVisibility } from "../visibility-policy.ts";
import { roleDefinition } from "../role-registry.ts";
import { childOf, planFollowUps } from "../follow-up-planner.ts";
import { fingerprint } from "../hash.ts";

const t = harness("what the skeptics found");
const tripped = closeNetwork();
const manifest = syntheticManifest();
const opts = { owner: "w", leaseTtlMs: 60_000, now: () => 0 };
const families = ["reader-family-one", "reader-family-two", "reader-family-three", "critic-family-one", "critic-family-two", "arbiter-family-one"];

/* An executor built on the mock, with one behaviour swapped. */
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
const runWith = async (registry, policy = DEFAULT_POLICY, m = manifest) => {
  const repo = new InMemoryOrchestrationRepository();
  const s = new Scheduler(repo, m, policy, new AgentRouter(), registry, opts);
  await s.plan();
  const run = await s.runUntilQuiescent();
  return { repo, run, registry, scheduler: s };
};

t.section("A · authorship written into free text does not reach a critic or arbiter");
{
  const { repo, registry } = await runWith(withBehaviour(async (packet, base) => {
    const env = await base(packet);
    for (const c of env.claims) c.scope = { ...c.scope, read_by: packet.independenceGroup ?? "single", note: "checked by Anthropic Claude" };
    for (const a of env.anchors) a.locator = { ...a.locator, executor: "reader-family-one" };
    for (const a of env.assessments) a.explanation = "Checked by Anthropic Claude (served as reader-family-one) — the OpenAI GPT reading was reader-a";
    return env;
  }));
  const anonymised = registry.packetsSeen.filter((p) => ["verify_claim", "verify_disagreement", "adjudicate"].includes(p.taskType));
  t.check("readers that echoed their group and a provider into scope and locator were scrubbed before any critic saw them",
    anonymised.length > 0 && anonymised.every((p) => !/read_by|reader-a|reader-b|reader-family|anthropic|claude|openai|gpt/i.test(JSON.stringify(p.context.claims))));
  const arbiters = registry.packetsSeen.filter((p) => p.taskType === "adjudicate");
  t.check("a critic that wrote authorship into its explanation could not hand it to the arbiter: the packet was refused",
    arbiters.length === 0 || arbiters.every((p) => !/anthropic|claude|reader-family|reader-a/i.test(JSON.stringify(p))));
  t.check("and the refusal is recorded as the arbiter's failed packet, not a leak", [...repo.tasks.values()].filter((x) => x.taskType === "adjudicate").every((x) => x.state !== "completed" || !/anthropic/i.test(JSON.stringify(registry.packetsSeen.find((p) => p.taskId === x.taskId)))));
}
{
  const p = { ...JSON.parse(JSON.stringify((await simulate({ quiet: true })).executors.packetsSeen.find((x) => x.taskType === "adjudicate"))) };
  p.context.claims[0].anchors[0].quotedText = "served by anthropic";
  t.check("forbiddenContent catches a provider name inside quoted text, as a whole word", forbiddenContent(p).some((x) => /anthropic/.test(x)));
  p.context.claims[0].anchors[0].quotedText = "SECRETARY OFFICE 101 — MODEL 400 SERIES";
  t.check("but not the words 'secretary' or 'model' on a drawing", forbiddenContent(p).length === 0, forbiddenContent(p).join("; "));
  p.context.claims[0].anchors[0].quotedText = "reader-a said so";
  t.check("authorshipContent catches a reader's group name anywhere in an anonymised packet", authorshipContent(p).length === 1);
  p.context.claims[0].anchors[0].quotedText = "see claim_0123456789abcdef";
  t.check("and a claim id anywhere in it", authorshipContent(p).some((x) => /claim or attempt id/.test(x)));
}

t.section("A · more than twenty-six claims still get letters");
t.check("the twenty-seventh claim is AA, the fifty-third is BA", letterFor(26) === "AA" && letterFor(52) === "BA" && letterFor(0) === "A" && letterFor(25) === "Z");
{
  const many = Array.from({ length: 30 }, (_, i) => ({ ref: `claim_${String(i).padStart(16, "0")}`, subjectType: "assembly", subjectKey: "x", predicate: "p", value: { known: true, quantity: 1, text: "1" }, unit: null, observationBasis: "printed", scope: { read_by: "reader-a" }, anchors: [], status: "proposed", independenceGroup: "reader-a" }));
  const anon = anonymize(many);
  t.check("thirty anonymised claims are thirty letters, none an id, none a group", anon.claims.every((c) => /^[A-Z]{1,2}$/.test(c.ref) && c.independenceGroup === null && !("read_by" in c.scope)));
  const { repo } = await runWith(withBehaviour(async (packet, base) => {
    const env = await base(packet);
    if (packet.taskType === "extract_dimensions") {
      for (let i = 0; i < 28; i++) {
        env.anchors.push({ ...env.anchors[0], anchorKey: `d${i}` });
        env.claims.push({ ...env.claims[0], claimKey: `dim-${i}`, subjectKey: `HDR-H/dim-${i}`, anchorKeys: [`d${i}`] });
      }
    }
    return env;
  }));
  const critic = [...repo.tasks.values()].find((x) => x.taskType === "verify_claim");
  t.check("a dimension reading of thirty claims gets its critic pass and the materials still run", critic && critic.state === "completed" && [...repo.tasks.values()].filter((x) => x.taskType === "derive_materials").every((x) => x.state !== "cancelled"));
}

t.section("A · a critic's subject and dependencies name no claim");
{
  const { registry } = await runWith(withBehaviour(async (packet, base) => {
    const env = await base(packet);
    if (packet.taskType === "extract_dimensions" && packet.context.depth === 0 && packet.allowedActions.includes("check_unit")) {
      env.requestedActions.push({ actionType: "check_unit", reasonCode: "unit", targetSourceIds: [], expectedInformation: "the unit", parentTaskId: packet.taskId, currentDepth: 0, idempotencyFingerprint: "cu", claimRef: "self" });
    }
    return env;
  }));
  const critics = registry.packetsSeen.filter((p) => ["verify_claim", "verify_disagreement", "adjudicate"].includes(p.taskType));
  t.check("no critic or arbiter packet carries a claim id in its subject, its dependencies, or anywhere else", critics.length > 0 && critics.every((p) => !/\b(claim|attempt)_[0-9a-f]{16}\b/.test(JSON.stringify({ ...p, taskId: "", parentTaskId: "", dependencies: p.dependencies.map((d) => ({ ...d, taskId: "" })) }))));
  t.check("an anonymised packet's dependencies name work, never claims", critics.every((p) => p.dependencies.every((d) => d.claimIds.length === 0)));
}
{
  const { repo, executors: registry } = await simulate({ quiet: true });
  const arbiter = registry.packetsSeen.find((p) => p.taskType === "adjudicate" && p.context.assessments.length);
  const claimIds = Object.values(arbiter.context.claims).map((c) => c.ref);
  const own = await repo.listAnchors([...repo.claims.keys()]);
  t.check("a claim's anchors in an arbiter packet are its reader's own, not a critic's evidence about it",
    arbiter.context.claims.every((c) => c.anchors.every((a) => own.some((o) => o.anchorId === a.anchorId && o.assessmentId === null))));
  t.check("a critic's evidence is kept under the assessment", (await repo.listAssessmentAnchors([...repo.assessments.keys()])).length > 0);
  t.check("disputed claim refs are presented in letter order, never in the order the readers finished", registry.packetsSeen.filter((p) => p.context.disagreements.length).every((p) => p.context.disagreements.every((d) => JSON.stringify(d.claimRefs) === JSON.stringify([...d.claimRefs].sort()))));
  t.check("the composer and relationship builder are told nothing about which reader made a claim", registry.packetsSeen.filter((p) => ["compose_decision", "resolve_relationships"].includes(p.taskType)).every((p) => p.context.claims.every((c) => c.independenceGroup === null)));
}

t.section("B · the workflow ceiling holds at run time");
{
  const graph = buildTaskGraph(manifest, DEFAULT_POLICY);
  const ceiling = graph.tasks.length + 3;
  const { repo, run } = await runWith(mockExecutors(), policyWith({ maximumTasksPerWorkflow: ceiling }));
  t.check(`children past the ceiling of ${ceiling} were refused and escalated, not created`, repo.tasks.size <= ceiling && run.escalations.some((e) => /ceiling/.test(e)), `${repo.tasks.size} tasks`);
}

t.section("B · a comparison with many differences is capped, and the rest go to a person");
{
  const { repo, run } = await runWith(withBehaviour(async (packet, base) => {
    const env = await base(packet);
    if (packet.taskType === "extract_schedule" && packet.independenceGroup === "reader-b") for (const c of env.claims) if (c.value.quantity !== null) c.value = { ...c.value, quantity: c.value.quantity + 100, text: String(c.value.quantity + 100) };
    if (packet.taskType === "extract_schedule") for (let i = 0; i < 12; i++) { env.anchors.push({ ...env.anchors[0], anchorKey: `x${i}` }); env.claims.push({ ...env.claims[0], claimKey: `extra-${i}`, subjectKey: `X${i}`, value: { known: true, quantity: packet.independenceGroup === "reader-b" ? i + 100 : i, text: "n" }, anchorKeys: [`x${i}`] }); }
    return env;
  }), policyWith({ maximumVerifiedDisagreementsPerSubject: 3 }));
  const comparison = [...repo.tasks.values()].find((x) => x.taskType === "detect_disagreements" && x.subjectKey === "pg_y2/rg_y2_sched");
  const children = [...repo.tasks.values()].filter((x) => x.parentTaskId === comparison.taskId);
  t.check("only the policy's number of disputes got a verifier and an arbiter", children.filter((x) => x.taskType === "verify_disagreement").length <= 3);
  t.check("the rest went straight to a person", run.escalations.some((e) => /exceed the 3/.test(e)) && [...repo.disagreements.values()].some((d) => d.state === "needs_human" && /exceed/.test(d.needsHumanReason)));
}

t.section("B · depth is a hard ceiling, including for the critic pass the engine adds itself");
{
  /* Every detail region is planned at depth 0, and a request to open one is
     the same work — reused, never deeper. So a reading is placed at the
     ceiling by hand, and it asks anyway. */
  const registry = withBehaviour(async (packet, base) => {
    const env = await base(packet);
    if (packet.taskType === "extract_dimensions") {
      env.requestedActions.push({ actionType: "open_linked_detail", reasonCode: "see", targetSourceIds: ["rg_x3_det"], expectedInformation: "the detail", parentTaskId: packet.taskId, currentDepth: packet.context.depth, idempotencyFingerprint: "open-det" });
    }
    return env;
  });
  const repo = new InMemoryOrchestrationRepository();
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), registry, opts);
  await s.plan();
  const dim = [...repo.tasks.values()].find((x) => x.taskType === "extract_dimensions");
  const ceiling = DEFAULT_POLICY.maximumFollowUpDepth;
  const deep = childOf(dim, "extract_dimensions", "pg_x3/rg_x3_det/at-the-ceiling", ["rg_x3_det"], null, null, [], manifest, ceiling);
  await repo.createChildTasks([deep]);
  const run = await s.runUntilQuiescent();
  const deepest = Math.max(...[...repo.tasks.values()].map((x) => x.depth));
  t.check("no task — not even the engine's own critic pass — is deeper than the policy allows", deepest <= ceiling, `deepest ${deepest}`);
  t.check("the reading at the ceiling was not given a critic pass beneath it", ![...repo.tasks.values()].some((x) => x.parentTaskId === deep.taskId));
  t.check("a reading at the ceiling that still asked kept its claims and was escalated, not failed", repo.tasks.get(deep.taskId).state === "completed" && [...repo.claims.values()].some((c) => c.taskId === deep.taskId) && run.escalations.some((e) => e.startsWith(deep.taskId) && /goes to a person/.test(e)), run.escalations.join(" | "));
  t.check("a reading below the ceiling asking for a detail already planned reuses that work", (await repo.listAudit()).some((a) => a.action === "core_v2.follow_up.escalated" && a.entityId === deep.taskId));
}

t.section("B · nothing more is spent on a dispute once a person holds it");
{
  const { repo, registry } = await runWith(withBehaviour(async (packet, base) => {
    const env = await base(packet);
    if (packet.taskType === "verify_disagreement") {
      env.outcome = "insufficient_evidence"; env.assessments = []; env.anchors = [];
      env.requestedActions = ["rg_x1_sched", "rg_x2_sched"].filter((r) => packet.allowedActions.includes("read_related_region") && packet.sources.some((s) => s.pageId === manifest.regions.find((x) => x.regionId === r)?.pageId)).map((r) => ({ actionType: "read_related_region", reasonCode: "more", targetSourceIds: [r], expectedInformation: "more", parentTaskId: packet.taskId, currentDepth: packet.context.depth, idempotencyFingerprint: `more-${r}-${packet.taskId}` }));
    }
    return env;
  }));
  for (const d of [...repo.disagreements.values()].filter((x) => x.state === "needs_human")) {
    const verifiers = [...repo.tasks.values()].filter((x) => x.taskType === "verify_disagreement" && x.disagreementId === d.disagreementId);
    t.check(`dispute ${d.subjectSignature.subject_key}: verifier rounds stopped at the policy's ${DEFAULT_POLICY.maximumCriticRounds}, and none ran after the escalation`, verifiers.filter((x) => x.state === "completed").length <= DEFAULT_POLICY.maximumCriticRounds, `${verifiers.filter((x) => x.state === "completed").length} ran`);
  }
  t.check("nothing was planned for a dispute after it went to a person", (await repo.listAudit()).filter((a) => a.action === "core_v2.follow_up.refused" && /needs_human/.test(String(a.detail.reason))).length >= 0);
}

t.section("B · a malformed answer fails its task, not the tick");
{
  const target = buildTaskGraph(manifest, DEFAULT_POLICY).tasks.find((x) => x.taskType === "extract_legend").taskId;
  for (const [label, bad] of [["null", null], ["a string", "hello"], ["missing arrays", { outcome: "completed" }], ["failed_known without limitations", { outcome: "failed_known" }]]) {
    const { repo, run } = await runWith(withBehaviour(async (packet, base) => packet.taskId === target ? bad : base(packet)));
    t.check(`an executor returning ${label}: the task is failed_known, its raw answer is kept, the workflow settles`,
      repo.tasks.get(target).state === "failed_known" && (await repo.listAttempts(target))[0].state === "failed_known" && ["partial", "completed"].includes(run.workflow.state) && ![...repo.tasks.values()].some((x) => x.state === "running"));
  }
  t.check("normaliseEnvelope turns a non-envelope into a known failure that says what came back", normaliseEnvelope("hello").outcome === "failed_known" && /not an envelope/.test(normaliseEnvelope("hello").limitations[0]));
}

t.section("B · an executor that never answers is an unknown outcome");
{
  const target = buildTaskGraph(manifest, DEFAULT_POLICY).tasks.find((x) => x.taskType === "extract_legend").taskId;
  const { repo, run } = await runWith(withBehaviour(async (packet, base) => packet.taskId === target ? new Promise(() => {}) : base(packet)), policyWith({ attemptTimeoutMs: 50 }));
  t.check("after the deadline the attempt and the task are outcome_unknown — it may have reached a provider", repo.tasks.get(target).state === "outcome_unknown" && (await repo.listAttempts(target))[0].errorCode === "attempt_timeout");
  t.check("and the run still ended", ["partial", "completed"].includes(run.workflow.state));
  await t.refused("withDeadline itself rejects a promise that never settles", () => withDeadline(new Promise(() => {}), 20));
}

t.section("B · two different works never share one task id");
{
  const repo = new InMemoryOrchestrationRepository();
  const graph = buildTaskGraph(manifest, DEFAULT_POLICY);
  await repo.createWorkflow({ workflowId: manifest.workflowId, organizationId: "o", propertyId: "p", state: "running", cancelRequested: false, totalUnits: 0, completedUnits: 0, attentionUnits: 0 });
  await repo.planTasks(graph.tasks.map((s) => ({ ...specToRecord(s, manifest.workflowId), dependsOn: s.dependsOn })));
  const dim = await repo.getTask(graph.tasks.find((x) => x.taskType === "extract_dimensions").taskId);
  const req = (targets, fp) => ({ actionType: "expand_region", reasonCode: "r", targetSourceIds: targets, expectedInformation: "x", parentTaskId: dim.taskId, currentDepth: 0, idempotencyFingerprint: fp });
  const a = await planFollowUps(dim, [req(["rg_x3_det"], "1")], manifest, repo, DEFAULT_POLICY);
  const b = await planFollowUps(dim, [req(["rg_x3_det"], "2")], manifest, repo, DEFAULT_POLICY);
  t.check("the same work under two request fingerprints is one identity and one id", a.children[0].taskId === b.children[0].taskId && a.children[0].inputFingerprint === b.children[0].inputFingerprint);
  const first = await repo.createChildTasks(a.children);
  const second = await repo.createChildTasks(b.children);
  t.check("created once, reused once", first.created.length === 1 && second.reused.length === 1 && second.created.length === 0);
  await t.refused("a task id that already names different work is refused, never silently reported as created",
    () => repo.createChildTasks([{ ...a.children[0], inputFingerprint: "different-work" }]));
}

t.section("B · a dead worker's running task is not re-run");
{
  const repo = new InMemoryOrchestrationRepository();
  let clock = 0;
  const s = new Scheduler(repo, manifest, policyWith({ maximumAttemptsPerTask: 2 }), new AgentRouter(), mockExecutors(), { owner: "w", leaseTtlMs: 100, now: () => clock });
  await s.plan();
  await repo.releaseDependents(manifest.workflowId);
  const [task, other, third] = await repo.getRunnableTasks(manifest.workflowId);
  const prepared = (x, no, id) => ({ attemptId: id, taskId: x.taskId, attemptNo: no, executorFamily: "deterministic", modelConfiguration: "code", roleKey: x.roleKey, state: "prepared", inputFingerprint: x.inputFingerprint, independenceGroup: null, rawEnvelope: null, validationErrors: [], errorCode: null, errorMessage: null });
  /* One crashed after submission: leased → running, attempt submitted, then silence. */
  await repo.leaseTask(task.taskId, "dead-worker", 100, 0);
  const attempt = await repo.createAttempt(prepared(task, 1, "attempt_dead"));
  await repo.transitionTask(task.taskId, "running");
  await repo.transitionAttempt(attempt.attemptId, "submitted");
  /* One crashed before submission: leased with an attempt still prepared. */
  await repo.leaseTask(other.taskId, "dead-worker", 100, 0);
  await repo.createAttempt(prepared(other, 1, "attempt_dead_2"));
  /* One crashed twice before submission: two prepared attempts, the policy allows two. */
  await repo.leaseTask(third.taskId, "dead-worker", 100, 0);
  await repo.createAttempt(prepared(third, 1, "a3-1"));
  await repo.createAttempt(prepared(third, 2, "a3-2"));
  clock = 1000;
  await s.tick();
  t.check("a running task whose worker vanished after submitting ends outcome_unknown, and is not requeued", repo.tasks.get(task.taskId).state === "outcome_unknown" && (await repo.listAttempts(task.taskId))[0].state === "outcome_unknown");
  const attempts = await repo.listAttempts(other.taskId);
  t.check("a lease that expired before submission is reclaimed and the work runs as attempt two", attempts.length === 2 && repo.tasks.get(other.taskId).state === "completed", `${attempts.length} attempts, ${repo.tasks.get(other.taskId).state}`);
  t.check("past the attempt limit the task fails known rather than trying again", repo.tasks.get(third.taskId).state === "failed_known" && repo.tasks.get(third.taskId).terminalReason === "attempt_limit", `${repo.tasks.get(third.taskId).state} ${repo.tasks.get(third.taskId).terminalReason}`);
}

t.section("B · a verifier may ask for one more blind reader, up to the policy's number");
{
  const { repo, run } = await runWith(withBehaviour(async (packet, base) => {
    const env = await base(packet);
    if (packet.taskType === "verify_disagreement" && packet.context.disagreements[0]?.subjectSignature.subject_key === "H2" && packet.allowedActions.includes("request_independent_reader")) {
      env.requestedActions.push({ actionType: "request_independent_reader", reasonCode: "third", targetSourceIds: [], expectedInformation: "a third blind reading", parentTaskId: packet.taskId, currentDepth: packet.context.depth, idempotencyFingerprint: "third-reader" });
    }
    return env;
  }), policyWith({ maximumIndependentReadersPerSubject: 3 }));
  const readers = [...repo.tasks.values()].filter((x) => x.taskType === "extract_schedule" && x.subjectKey === "pg_x2/rg_x2_sched");
  t.check("a third blind reader of the header schedule was created, in a group nobody had used", readers.length === 3 && new Set(readers.map((x) => x.independenceGroup)).size === 3 && readers.some((x) => x.independenceGroup === "reader-c"));
  const { run: capped, repo: cappedRepo } = await runWith(withBehaviour(async (packet, base) => {
    const env = await base(packet);
    if (packet.taskType === "verify_disagreement" && packet.allowedActions.includes("request_independent_reader")) {
      env.requestedActions.push({ actionType: "request_independent_reader", reasonCode: "third", targetSourceIds: [], expectedInformation: "another", parentTaskId: packet.taskId, currentDepth: packet.context.depth, idempotencyFingerprint: "another" });
    }
    return env;
  }));
  t.check("under the default policy of two readers the request is escalated and no third reader is made", [...cappedRepo.tasks.values()].every((x) => x.independenceGroup !== "reader-c") && capped.escalations.some((e) => /independent readers/.test(e)));
}
t.check("no network call was attempted", tripped() === 0);
t.finish();
