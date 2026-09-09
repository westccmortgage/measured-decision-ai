/* INDEPENDENCE FAILS CLOSED.
 *
 * docs/core-v2.md §3: every attempt records an independence domain — the
 * identity of the executor that will actually run it, assigned by the
 * registry from the executor instance, never from a label an envelope or a
 * routing table could spoof. Two families on one instance share one domain.
 * Two blind readers of one subject must run in two domains. When no distinct
 * domain is available the blind assignment is not executed: its attempt is
 * rejected_before_submission with reason independence_unavailable, the task
 * fails known, it is never counted as an independent reading, and the
 * subject is held for a person through a coverage disagreement. The same
 * check is made again, atomically, at submission. Within one tick the blind
 * readings of one subject are dispatched one after another. Critics,
 * verifiers and arbiters are never routed to a domain that authored what
 * they judge. §4: a critic in a domain that authored none of the
 * corroborated readings reopens the source; agreement is not acceptance.
 *
 * Everything runs in memory on the synthetic records pack with scripted
 * executors. The network is closed before the engine is used. No sleeps:
 * the clock is manual and the scheduler is ticked by hand.
 */
import { harness, closeNetwork } from "./harness.mjs";
import { syntheticRecordSet } from "../domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack, TASK } from "../domains/synthetic-records/pack.ts";
import { mockExecutors } from "../domains/synthetic-records/mocks.ts";
import { assemble, manualClock } from "../domains/simulate.ts";
import { ScriptedExecutor } from "../domains/mock-executor.ts";
import { KERNEL_TASK_TYPES } from "../kernel/contracts.ts";
import { INDEPENDENCE_GROUPS } from "../kernel/domain.ts";
import { ExecutorRegistry } from "../kernel/executors.ts";
import { AgentRouter, DEFAULT_ROUTING_TABLE } from "../kernel/router.ts";
import { RoleRegistry } from "../kernel/roles.ts";
import { SUBMITTED_ATTEMPT_STATES } from "../kernel/transitions.ts";

const tripped = closeNetwork();
const t = harness("independence fails closed");

/* ───────────────────────────────────────────────────────────── helpers */

const SEED = "independence/records";
const [READER_A, READER_B] = INDEPENDENCE_GROUPS;
const V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ANALYST_ROLES = new Set(["table_reader", "note_reader"]);

/* One assembled world: a fixture, a registry of scripted executors, a
   scheduler over an in-memory repository and a manual clock. */
function world(mockOptions = {}, extra = {}) {
  const truth = syntheticRecordSet({ seed: SEED, sources: 1, sheetsPerSource: 2, entriesPerTable: 3 });
  const { registry, executors } = mockExecutors(truth, mockOptions);
  const parts = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: registry, clock: manualClock(), ...extra });
  return { truth, wf: truth.manifest.workflowId, registry, executors, ...parts };
}

/* Tick by hand until nothing moves, keeping every tick's report and the
   workflow state it left; then let the scheduler settle the final state. */
async function drive(scheduler, maxTicks = 200) {
  const ticks = [];
  const states = [];
  for (let i = 0; i < maxTicks; i++) {
    const r = await scheduler.tick();
    ticks.push(r);
    states.push(r.workflowState);
    if (r.dispatched.length === 0 && r.released === 0 && r.stopped === 0 && r.reconciled === 0 && scheduler.inFlight.size === 0) break;
  }
  const report = await scheduler.runUntilQuiescent();
  return { ticks, states, report };
}

const blindTasks = (tasks) => tasks.filter((x) => x.independenceGroup !== null);
const blindSubjects = (tasks) => [...new Set(blindTasks(tasks).map((x) => x.subjectKey))].sort();
const readerOf = (tasks, subject, group) => tasks.find((x) => x.subjectKey === subject && x.independenceGroup === group);
const analystPackets = (executor) => executor.received.filter((p) => ANALYST_ROLES.has(p.roleKey));
const every = (xs, f) => xs.length > 0 && xs.every(f);

async function attemptsByTask(repo, tasks) {
  const out = new Map();
  for (const task of tasks) out.set(task.taskId, await repo.listAttempts(task.taskId));
  return out;
}

/* The coverage hold of one subject: the disagreement and its hold decision. */
function holdOf(disagreements, decisions, subject) {
  const dis = disagreements.find((d) => d.kind === "coverage" && d.subjectSignature.subject_key === subject);
  const decision = dis ? decisions.find((d) => d.disagreementId === dis.disagreementId && d.decisionType === "hold") : null;
  return { dis, decision };
}

/* What the one-available-domain outcome must look like, whatever made the
   domain the only one: the same checks for scenario (a) and scenario (b). */
async function checkSingleDomainOutcome(label, w, driven, readerExecutor) {
  const { repo, wf } = w;
  const tasks = await repo.listTasks(wf);
  const subjects = blindSubjects(tasks);
  const attempts = await attemptsByTask(repo, tasks);
  const claims = await repo.listClaims({ workflowId: wf });
  const disagreements = await repo.listDisagreements(wf);
  const decisions = await repo.listDecisions(wf);
  const readerBs = subjects.map((s) => readerOf(tasks, s, READER_B)).filter(Boolean);
  const readerAs = subjects.map((s) => readerOf(tasks, s, READER_A)).filter(Boolean);

  t.check(`${label}: the fixture has blind subjects and each has a ${READER_A} and a ${READER_B} task`, subjects.length >= 2 && readerAs.length === subjects.length && readerBs.length === subjects.length, `${subjects.length} subjects`);

  t.check(`${label}: the first blind reading of every subject ran and completed in the one available domain`,
    every(readerAs, (r) => r.state === "completed" && attempts.get(r.taskId).some((a) => a.state === "succeeded" && a.independenceDomain === w.registry.domainOf("reader-family-one"))));

  t.check(`${label}: the second blind reading of every subject is NOT executed — the executor received exactly one analyst packet per subject`,
    subjects.every((s) => analystPackets(readerExecutor).filter((p) => p.subjectKey === s).length === 1),
    analystPackets(readerExecutor).map((p) => `${p.subjectKey}:${p.independenceGroup}`).join(", "));

  t.check(`${label}: no ${READER_B} task has an attempt in a submitted state — nothing was sent`,
    every(readerBs, (r) => attempts.get(r.taskId).every((a) => !SUBMITTED_ATTEMPT_STATES.includes(a.state))));

  t.check(`${label}: every ${READER_B} attempt is rejected_before_submission with errorCode independence_unavailable`,
    every(readerBs, (r) => attempts.get(r.taskId).length === 1 && attempts.get(r.taskId).every((a) => a.state === "rejected_before_submission" && a.errorCode === "independence_unavailable")),
    readerBs.map((r) => attempts.get(r.taskId).map((a) => `${a.state}/${a.errorCode}`).join("+")).join(", "));

  t.check(`${label}: every ${READER_B} task ends failed_known with terminalReason independence_unavailable`,
    every(readerBs, (r) => r.state === "failed_known" && r.terminalReason === "independence_unavailable"),
    readerBs.map((r) => `${r.state}/${r.terminalReason}`).join(", "));

  t.check(`${label}: a coverage disagreement exists per subject, in state needs_human`,
    subjects.every((s) => holdOf(disagreements, decisions, s).dis?.state === "needs_human"),
    disagreements.map((d) => `${d.kind}:${d.state}`).join(", "));

  t.check(`${label}: each coverage disagreement carries a hold decision in status needs_human`,
    subjects.every((s) => holdOf(disagreements, decisions, s).decision?.status === "needs_human"));

  t.check(`${label}: the hold says why — the reason names independence_unavailable`,
    subjects.every((s) => holdOf(disagreements, decisions, s).dis?.subjectSignature.reason === "independence_unavailable"));

  t.check(`${label}: the workflow passed through needs_attention and ended partial`,
    driven.states.includes("needs_attention") && driven.report.workflow.state === "partial",
    `${driven.states.join(" > ")} > ${driven.report.workflow.state}`);

  const subjectClaims = claims.filter((c) => c.taskId && readerAs.some((r) => r.taskId === c.taskId));
  t.check(`${label}: the single reading's claims are never accepted and never corroborated — a subject read once is not called read`,
    subjectClaims.length > 0 && subjectClaims.every((c) => c.status !== "accepted" && c.status !== "corroborated" && c.status !== "verified"),
    [...new Set(subjectClaims.map((c) => c.status))].join(", "));

  t.check(`${label}: the single reading's claims stand disputed or unresolved, tied to the coverage dispute`,
    subjectClaims.every((c) => c.status === "disputed" || c.status === "unresolved"));

  t.check(`${label}: no comparison ran on a subject read once — every compare task was stopped, none completed`,
    every(tasks.filter((x) => x.taskType === KERNEL_TASK_TYPES.compare), (x) => x.state === "cancelled"));

  const audit = await repo.listAudit();
  t.check(`${label}: the audit trail records independence_unavailable on the task and needs_attention on the subject`,
    audit.some((a) => a.action === "core_v2.task.independence_unavailable")
    && subjects.every((s) => audit.some((a) => a.action === "core_v2.subject.needs_attention" && a.detail.subject === s)),
    `${audit.filter((a) => a.action === "core_v2.subject.needs_attention").length} needs_attention audits for ${subjects.length} subjects`);
}

/* ═══════════════════════════ (a) one available reader family */
t.section("(a) one available reader family: the second blind reading is not executed");
{
  const w = world({ families: ["reader-family-one", "critic-family-one", "arbiter-family-one"] });
  await w.scheduler.plan();
  const driven = await drive(w.scheduler);
  await checkSingleDomainOutcome("one family", w, driven, w.executors["reader-family-one"]);

  const audits = await w.repo.listAudit();
  const subjects = blindSubjects(await w.repo.listTasks(w.wf));
  t.check("one family: the audit names each held subject under core_v2.subject.needs_attention",
    subjects.every((s) => audits.some((a) => a.action === "core_v2.subject.needs_attention" && a.detail.subject === s)));
}

/* ═══════════════════════════ (b) two aliases pointing at one executor */
t.section("(b) two family names on one executor instance are one domain");
{
  const w = world({ families: ["reader-family-one", "reader-family-two", "critic-family-one", "arbiter-family-one"], aliases: { "reader-family-two": "reader-family-one" } });
  t.check("two aliases: the registry gives both family names the same independence domain",
    w.registry.domainOf("reader-family-one") !== null && w.registry.domainOf("reader-family-one") === w.registry.domainOf("reader-family-two"),
    `${w.registry.domainOf("reader-family-one")} = ${w.registry.domainOf("reader-family-two")}`);
  t.check("two aliases: both family names resolve to one executor instance", w.executors["reader-family-one"] === w.executors["reader-family-two"]);
  await w.scheduler.plan();
  const driven = await drive(w.scheduler);
  await checkSingleDomainOutcome("two aliases", w, driven, w.executors["reader-family-one"]);
  t.check("two aliases: no attempt was ever submitted under the alias name — distinct family names are not independence",
    (await Promise.all((await w.repo.listTasks(w.wf)).map((x) => w.repo.listAttempts(x.taskId)))).flat().every((a) => !(a.executorFamily === "reader-family-two" && SUBMITTED_ATTEMPT_STATES.includes(a.state))));
}

/* ═══════════════════════════ (c) simultaneous blind dispatch, two real families */
t.section("(c) two real families: both blind readings of a subject dispatch in one tick, in two domains");
{
  /* Each reader notes, as it runs, how many domains had already submitted a
     reading of its subject — its own included — so the order inside the
     tick is visible afterwards. */
  let repoRef = null;
  const seen = [];
  const observe = async (packet) => {
    if (repoRef && packet.independenceGroup) seen.push({ subject: packet.subjectKey, group: packet.independenceGroup, domains: (await repoRef.independenceDomainsForSubject(packet.workflowId, packet.subjectKey)).length });
  };
  const w = world({ scripts: { "reader-family-one": async (p, base) => { await observe(p); return base; }, "reader-family-two": async (p, base) => { await observe(p); return base; } } });
  repoRef = w.repo;
  await w.scheduler.plan();
  const driven = await drive(w.scheduler);
  const tasks = await w.repo.listTasks(w.wf);
  const subjects = blindSubjects(tasks);
  const attempts = await attemptsByTask(w.repo, tasks);

  t.check("two families: the run completes with nothing held", driven.report.workflow.state === "completed" && !driven.report.disagreements.needs_human, `${driven.report.workflow.state} ${JSON.stringify(driven.report.disagreements)}`);

  const sameTick = subjects.map((s) => driven.ticks.find((r) => r.dispatched.includes(readerOf(tasks, s, READER_A).taskId) && r.dispatched.includes(readerOf(tasks, s, READER_B).taskId)));
  t.check("two families: for every subject, one TickReport.dispatched holds both of its blind reader task ids",
    sameTick.every(Boolean), `${sameTick.filter(Boolean).length} of ${subjects.length} subjects`);

  t.check("two families: the two attempts of each subject carry different independenceDomain values",
    subjects.every((s) => {
      const a = attempts.get(readerOf(tasks, s, READER_A).taskId).find((x) => x.state === "succeeded");
      const b = attempts.get(readerOf(tasks, s, READER_B).taskId).find((x) => x.state === "succeeded");
      return a && b && a.independenceDomain !== b.independenceDomain;
    }));

  t.check("two families: inside the tick the blind readings of one subject ran one after another — the second saw the first's domain already submitted",
    subjects.every((s) => { const counts = seen.filter((x) => x.subject === s).map((x) => x.domains).sort(); return counts.length === 2 && counts[0] === 1 && counts[1] === 2; }),
    seen.map((x) => `${x.group}:${x.domains}`).join(" "));

  t.check("two families: every submitted attempt's domain is the registry's domain for its family — persisted, not labelled",
    [...attempts.values()].flat().filter((a) => SUBMITTED_ATTEMPT_STATES.includes(a.state)).every((a) => a.independenceDomain === w.registry.domainOf(a.executorFamily)));

  t.check("two families: every claim from a blind reading carries its attempt's domain",
    (await w.repo.listClaims({ workflowId: w.wf })).filter((c) => c.independenceGroup !== null).every((c) => c.independenceDomain === attempts.get(c.taskId).find((a) => a.attemptId === c.attemptId)?.independenceDomain));

  /* (h) part one: critics never judge in a domain that authored the target. */
  const critics = tasks.filter((x) => x.taskType === KERNEL_TASK_TYPES.verifyClaim);
  const criticOk = await Promise.all(critics.map(async (c) => {
    const a = attempts.get(c.taskId).find((x) => SUBMITTED_ATTEMPT_STATES.includes(x.state));
    const targets = await Promise.all(c.targetClaimIds.map((id) => w.repo.getClaim(id)));
    return a && targets.length > 0 && targets.every((cl) => cl && cl.independenceDomain !== a.independenceDomain);
  }));
  t.check("two families: every verify_claim attempt runs in a domain different from that of every claim in its targetClaimIds", critics.length > 0 && criticOk.every(Boolean), `${critics.length} critic tasks`);
}

/* ═══════════════════════════ (d) exhausted visual families */
t.section("(d) exhausted visual families: a visual role with only non-visual families is refused before submission");
{
  const exhausted = { ...DEFAULT_ROUTING_TABLE, visual_analysis: [{ family: "reader-family-three", configuration: "reader-family-three/visual@2", visual: false }] };

  /* Through assemble({routing}): the pack's discoverer is the first visual
     role the scheduler meets, and it is refused with nothing sent. */
  const w = world({}, { routing: exhausted });
  await w.scheduler.plan();
  const driven = await drive(w.scheduler);
  const tasks = await w.repo.listTasks(w.wf);
  const visual = tasks.filter((x) => x.taskType === TASK.discoverRegions);
  const attempts = await attemptsByTask(w.repo, tasks);
  t.check("exhausted (table): the visual discovery tasks fail known with independence_unavailable, their attempts rejected before submission",
    every(visual, (x) => x.state === "failed_known" && x.terminalReason === "independence_unavailable" && attempts.get(x.taskId).every((a) => a.state === "rejected_before_submission" && a.errorCode === "independence_unavailable")));
  t.check("exhausted (table): no executor of any family received a visual packet — the non-visual family in the table was not used as a stand-in",
    Object.values(w.executors).every((e) => e.received.every((p) => p.roleKey !== "region_discoverer")));
  const disagreements = await w.repo.listDisagreements(w.wf);
  const decisions = await w.repo.listDecisions(w.wf);
  t.check("exhausted (table): each visual subject is held for a person by a coverage disagreement",
    every(visual, (x) => holdOf(disagreements, decisions, x.subjectKey).dis !== undefined),
    `${disagreements.filter((d) => d.kind === "coverage").length} coverage disagreements for ${visual.length} visual subjects`);
  t.check("exhausted (table): each visual subject's coverage disagreement is needs_human with a needs_human hold decision",
    every(visual, (x) => holdOf(disagreements, decisions, x.subjectKey).dis?.state === "needs_human" && holdOf(disagreements, decisions, x.subjectKey).decision?.status === "needs_human"));
  t.check("exhausted (table): the workflow ends partial", driven.report.workflow.state === "partial", driven.report.workflow.state);

  /* The same table, arriving after discovery: now the blind table readers
     are the visual role at hand, and every one is refused. */
  const w2 = world();
  await w2.scheduler.plan();
  const before = [];
  for (let i = 0; i < 2; i++) before.push((await w2.scheduler.tick()).workflowState);
  const discovered = (await w2.repo.listTasks(w2.wf)).filter((x) => x.taskType === TASK.discoverRegions);
  t.check("exhausted (after discovery): discovery completed under the full table before the visual families were withdrawn", every(discovered, (x) => x.state === "completed"), before.join(" > "));
  w2.scheduler.router = new AgentRouter(exhausted);
  const driven2 = await drive(w2.scheduler);
  const tasks2 = await w2.repo.listTasks(w2.wf);
  const tableReaders = tasks2.filter((x) => x.taskType === TASK.readTable);
  const attempts2 = await attemptsByTask(w2.repo, tasks2);
  t.check("exhausted (after discovery): every table_reader task, both blind groups, fails known with independence_unavailable",
    every(tableReaders, (x) => x.state === "failed_known" && x.terminalReason === "independence_unavailable"), tableReaders.map((x) => `${x.independenceGroup}:${x.state}`).join(", "));
  t.check("exhausted (after discovery): every table_reader attempt is rejected_before_submission — none reached a submitted state",
    every(tableReaders, (x) => attempts2.get(x.taskId).length === 1 && attempts2.get(x.taskId).every((a) => a.state === "rejected_before_submission" && !SUBMITTED_ATTEMPT_STATES.includes(a.state))));
  t.check("exhausted (after discovery): no executor received a table_reader packet",
    Object.values(w2.executors).every((e) => e.received.every((p) => p.roleKey !== "table_reader")));
  const dis2 = await w2.repo.listDisagreements(w2.wf);
  const dec2 = await w2.repo.listDecisions(w2.wf);
  const tableSubjects = [...new Set(tableReaders.map((x) => x.subjectKey))];
  t.check("exhausted (after discovery): each table subject is held — one coverage disagreement in needs_human with its hold decision",
    every(tableSubjects, (s) => holdOf(dis2, dec2, s).dis?.state === "needs_human" && holdOf(dis2, dec2, s).decision?.status === "needs_human"));
  t.check("exhausted (after discovery): the non-visual note readers still ran in two domains — only the visual work was refused",
    every(tasks2.filter((x) => x.taskType === TASK.readNote), (x) => x.state === "completed"));
  t.check("exhausted (after discovery): the workflow ends partial", driven2.report.workflow.state === "partial", driven2.report.workflow.state);
}

/* ═══════════════════════════ (e) the domain cannot be spoofed by an envelope */
t.section("(e) non-spoofable domain: an envelope's own labels change nothing persisted");
{
  const spoof = (_packet, base) => ({ ...base, independenceDomain: "domain:spoofed", executorFamily: "reader-family-nine" });
  const w = world({ scripts: { "reader-family-one": spoof, "reader-family-two": spoof } });
  await w.scheduler.plan();
  const driven = await drive(w.scheduler);
  const tasks = await w.repo.listTasks(w.wf);
  const attempts = await attemptsByTask(w.repo, tasks);
  const readerAttempts = blindTasks(tasks).flatMap((x) => attempts.get(x.taskId)).filter((a) => a.state === "succeeded");
  t.check("spoof: the spoofing readers still completed the run — the extra fields were ignored, not fatal", driven.report.workflow.state === "completed" && readerAttempts.length === blindTasks(tasks).length, driven.report.workflow.state);
  t.check("spoof: every persisted reader attempt's independenceDomain equals registry.domainOf(its family), never the envelope's label",
    every(readerAttempts, (a) => a.independenceDomain === w.registry.domainOf(a.executorFamily) && a.independenceDomain !== "domain:spoofed"));
  t.check("spoof: every persisted reader attempt's executorFamily is a registered family, never the envelope's label",
    every(readerAttempts, (a) => w.registry.has(a.executorFamily) && a.executorFamily !== "reader-family-nine"));
  const claims = (await w.repo.listClaims({ workflowId: w.wf })).filter((c) => c.independenceGroup !== null);
  t.check("spoof: every blind claim's independenceDomain equals its attempt's, which is the registry's",
    every(claims, (c) => c.independenceDomain === readerAttempts.find((a) => a.attemptId === c.attemptId)?.independenceDomain && c.independenceDomain !== "domain:spoofed"));
  t.check("spoof: the raw envelope was kept on the attempt as it came, spoof fields and all — write-once evidence of what was said",
    every(readerAttempts, (a) => a.rawResult !== null && a.rawResult.independenceDomain === "domain:spoofed" && a.rawResult.executorFamily === "reader-family-nine"));
}

/* ═══════════════════════════ (f) the router's domain is the registry's */
t.section("(f) the router selects the registry's domain; instances, not names, make domains");
{
  const roles = new RoleRegistry(new SyntheticRecordsPack());
  const registry = new ExecutorRegistry();
  const one = new ScriptedExecutor("reader-family-one", {});
  const two = new ScriptedExecutor("reader-family-two", {});
  const d1 = registry.register(one, ["reader-family-one"]);
  const d1again = registry.register(one, ["reader-family-one"]);
  const d1alias = registry.register(one, ["critic-family-one"]);
  const d2 = registry.register(two, ["reader-family-two"]);
  t.check("registering the same executor instance twice returns the same domain string", d1 === d1again, `${d1} / ${d1again}`);
  t.check("registering the same instance under another family name keeps its one domain", d1 === d1alias && registry.domainOf("critic-family-one") === d1);
  t.check("two executor instances receive two different domains", d1 !== d2 && typeof d1 === "string" && typeof d2 === "string" && d1.length > 0 && d2.length > 0, `${d1} / ${d2}`);
  const router = new AgentRouter();
  const first = router.select({ roleKey: "table_reader", requiresVisualInput: true, independenceGroup: READER_A, usedDomains: [] }, roles, registry);
  const second = router.select({ roleKey: "table_reader", requiresVisualInput: true, independenceGroup: READER_B, usedDomains: first.ok ? [first.selection.independenceDomain] : [] }, roles, registry);
  t.check("the router's selection domain equals the registry's domain for the family it chose",
    first.ok && second.ok && first.selection.independenceDomain === registry.domainOf(first.selection.executorFamily) && second.selection.independenceDomain === registry.domainOf(second.selection.executorFamily),
    first.ok && second.ok ? `${first.selection.executorFamily}→${first.selection.independenceDomain}, ${second.selection.executorFamily}→${second.selection.independenceDomain}` : "not routed");
  t.check("the two blind selections land in the two different domains", first.ok && second.ok && first.selection.independenceDomain !== second.selection.independenceDomain);
  const third = router.select({ roleKey: "table_reader", requiresVisualInput: true, independenceGroup: READER_B, usedDomains: [d1, d2] }, roles, registry);
  t.check("with both domains used, a blind selection is refused rather than reusing a domain under a new name", !third.ok && /independence/.test(third.reason), third.ok ? "routed" : third.reason);
  await t.refused("the registry refuses to run a selection whose domain label does not match the family's real domain", async () => {
    await registry.run({ executorFamily: "reader-family-one", independenceDomain: d2, modelConfiguration: "x", reason: "a lying label", cacheReuseAllowed: false }, { taskId: "t", roleKey: "table_reader", workflowId: "w" }, { attemptId: "a", taskId: "t", signal: new AbortController().signal });
  });
  t.check("a lying selection never reached the executor", one.received.length === 0);
}

/* ═══════════════════════════ (g) independenceDomainsForSubject counts submitted attempts only */
t.section("(g) independenceDomainsForSubject reports only domains of attempts that reached a submitted state");
{
  const w = world({ families: ["reader-family-one", "critic-family-one", "arbiter-family-one"] });
  await w.scheduler.plan();
  await drive(w.scheduler);
  const tasks = await w.repo.listTasks(w.wf);
  const subject = blindSubjects(tasks)[0];
  const readerB = readerOf(tasks, subject, READER_B);
  const d1 = w.registry.domainOf("reader-family-one");
  const listed = await w.repo.independenceDomainsForSubject(w.wf, subject);
  t.check("after one reading and one refused reading, the subject lists exactly the one domain that submitted", listed.length === 1 && listed[0] === d1, listed.join(", "));
  t.check("the rejected_before_submission attempt's placeholder domain is not listed", !listed.includes("none") && (await w.repo.listAttempts(readerB.taskId)).every((a) => !listed.includes(a.independenceDomain)));
  const prepared = { attemptId: "00000000-0000-5000-8000-00000000c0de", workflowId: w.wf, taskId: readerB.taskId, attemptNo: 2, roleKey: readerB.roleKey, roleVersion: readerB.roleVersion, executorKind: "model", executorFamily: "reader-family-nine", independenceDomain: "domain:prepared-only", modelConfiguration: "x", state: "prepared", leaseToken: null, packetFingerprint: "", packetBytes: 0, providerRequestId: null, modelReported: null, usage: {}, rawResult: null, rawResultHash: null, validationState: "pending", validationProblems: [], errorCode: null, errorMessage: null, reconciliationOutcome: null };
  await w.repo.createAttempt(prepared);
  const afterPrepared = await w.repo.independenceDomainsForSubject(w.wf, subject);
  t.check("an attempt that is only prepared does not add its domain — nothing was sent, so nothing read", afterPrepared.length === 1 && afterPrepared[0] === d1, afterPrepared.join(", "));

  const w2 = world();
  await w2.scheduler.plan();
  await drive(w2.scheduler);
  const subject2 = blindSubjects(await w2.repo.listTasks(w2.wf))[0];
  const both = await w2.repo.independenceDomainsForSubject(w2.wf, subject2);
  t.check("after two independent readings the subject lists exactly two domains, the registry's two",
    both.length === 2 && both.includes(w2.registry.domainOf("reader-family-one")) && both.includes(w2.registry.domainOf("reader-family-two")), both.join(", "));
  const noSuch = await w2.repo.independenceDomainsForSubject(w2.wf, "no/such/subject");
  t.check("a subject nobody read lists no domain", noSuch.length === 0);
}

/* ═══════════════════════════ the second check, at submission */
t.section("the same check is made again at submission, whatever the router believed");
{
  /* A router that forgets what already read the subject: the repository
     must refuse the blind attempt at submitAttempt on its own. */
  const w = world({ families: ["reader-family-one", "critic-family-one", "arbiter-family-one"] });
  const honest = w.scheduler.router;
  w.scheduler.router = { table: honest.table, select: (request, roles, executors) => honest.select({ ...request, usedDomains: [] }, roles, executors) };
  await w.scheduler.plan();
  const driven = await drive(w.scheduler);
  const tasks = await w.repo.listTasks(w.wf);
  const subjects = blindSubjects(tasks);
  const readerBs = subjects.map((s) => readerOf(tasks, s, READER_B));
  const attempts = await attemptsByTask(w.repo, tasks);
  const d1 = w.registry.domainOf("reader-family-one");
  t.check("forgetful router: the second reading was prepared for the same domain the router wrongly chose", every(readerBs, (r) => attempts.get(r.taskId).length === 1 && attempts.get(r.taskId)[0].independenceDomain === d1 && attempts.get(r.taskId)[0].executorFamily === "reader-family-one"));
  t.check("forgetful router: submitAttempt refused it — the attempt is rejected_before_submission with errorCode independence_unavailable",
    every(readerBs, (r) => attempts.get(r.taskId)[0].state === "rejected_before_submission" && attempts.get(r.taskId)[0].errorCode === "independence_unavailable" && /independence/.test(attempts.get(r.taskId)[0].errorMessage ?? "")),
    readerBs.map((r) => attempts.get(r.taskId)[0].errorMessage).join(" | ").slice(0, 120));
  t.check("forgetful router: the audit says the refusal happened at submission", (await w.repo.listAudit()).some((a) => a.action === "core_v2.task.independence_unavailable" && a.detail.at === "submission"));
  t.check("forgetful router: the executor still received exactly one analyst packet per subject", subjects.every((s) => analystPackets(w.executors["reader-family-one"]).filter((p) => p.subjectKey === s).length === 1));
  t.check("forgetful router: the tasks fail known, the subjects are held, the workflow ends partial",
    every(readerBs, (r) => r.state === "failed_known" && r.terminalReason === "independence_unavailable") && driven.report.workflow.state === "partial",
    driven.report.workflow.state);
  const disagreements = await w.repo.listDisagreements(w.wf);
  const decisions = await w.repo.listDecisions(w.wf);
  t.check("forgetful router: each subject carries its coverage disagreement in needs_human", subjects.every((s) => holdOf(disagreements, decisions, s).dis?.state === "needs_human"));
}

/* ═══════════════════════════ deterministic ids */
t.section("deterministic ids: the same seed names the same tasks");
{
  const w1 = world({ families: ["reader-family-one", "critic-family-one", "arbiter-family-one"] });
  const w2 = world({ families: ["reader-family-one", "critic-family-one", "arbiter-family-one"] });
  await w1.scheduler.plan(); await w2.scheduler.plan();
  await drive(w1.scheduler); await drive(w2.scheduler);
  const ids = async (w) => (await w.repo.listTasks(w.wf)).filter((x) => x.independenceGroup === READER_B).map((x) => x.taskId).sort();
  const a = await ids(w1), b = await ids(w2);
  t.check("the refused reader-b tasks have the same ids in two runs of the same fixture", a.length > 0 && a.length === b.length && a.every((id, i) => id === b[i]), a.map((x) => x.slice(0, 8)).join(", "));
  t.check("those ids are version-5 UUIDs", a.every((id) => V5.test(id)));
}

/* ═══════════════════════════ (h) critics and the domains that authored what they judge */
t.section("(h) a critic is never routed to a domain that authored what it judges");
{
  /* The only critic family is the first reader's own instance: for every
     corroborated reading it would judge, its domain took part. */
  const w = world({ families: ["reader-family-one", "reader-family-two", "critic-family-one", "arbiter-family-one"], aliases: { "critic-family-one": "reader-family-one" } });
  t.check("one shared critic: the critic family's domain is the first reader's domain", w.registry.domainOf("critic-family-one") === w.registry.domainOf("reader-family-one"));
  await w.scheduler.plan();
  const driven = await drive(w.scheduler);
  const tasks = await w.repo.listTasks(w.wf);
  const critics = tasks.filter((x) => x.taskType === KERNEL_TASK_TYPES.verifyClaim);
  const attempts = await attemptsByTask(w.repo, tasks);
  t.check("one shared critic: every verify_claim task is refused before submission with independence_unavailable",
    every(critics, (c) => c.state === "failed_known" && c.terminalReason === "independence_unavailable" && attempts.get(c.taskId).every((a) => a.state === "rejected_before_submission" && a.errorCode === "independence_unavailable")),
    critics.map((c) => `${c.state}/${c.terminalReason}`).join(", "));
  t.check("one shared critic: the shared instance never received a critic packet", w.executors["reader-family-one"].received.every((p) => p.roleKey !== "evidence_critic"));
  const claims = await w.repo.listClaims({ workflowId: w.wf });
  const blind = claims.filter((c) => c.independenceGroup !== null);
  t.check("one shared critic: the readings stay corroborated — agreement is not acceptance, and no accepted claim came from a blind reading",
    blind.length > 0 && blind.every((c) => c.status !== "accepted") && blind.some((c) => c.status === "corroborated"), [...new Set(blind.map((c) => c.status))].join(", "));
  const disagreements = await w.repo.listDisagreements(w.wf);
  const decisions = await w.repo.listDecisions(w.wf);
  t.check("one shared critic: each corroborated subject is held for a person and the workflow ends partial",
    every(critics, (c) => holdOf(disagreements, decisions, c.subjectKey).dis?.state === "needs_human" && holdOf(disagreements, decisions, c.subjectKey).decision?.status === "needs_human") && driven.report.workflow.state === "partial",
    driven.report.workflow.state);

  /* Both critic families are the two readers' instances: every critic
     domain authored one of the corroborated readings it would judge. */
  const w2 = world({ aliases: { "critic-family-one": "reader-family-one", "critic-family-two": "reader-family-two" } });
  t.check("both critics shared: each critic family's domain is one of the two readers' domains",
    w2.registry.domainOf("critic-family-one") === w2.registry.domainOf("reader-family-one") && w2.registry.domainOf("critic-family-two") === w2.registry.domainOf("reader-family-two"));
  await w2.scheduler.plan();
  const driven2 = await drive(w2.scheduler);
  const tasks2 = await w2.repo.listTasks(w2.wf);
  const critics2 = tasks2.filter((x) => x.taskType === KERNEL_TASK_TYPES.verifyClaim);
  const attempts2 = await attemptsByTask(w2.repo, tasks2);
  const subjectOf = (c) => c.subjectKey.replace(/\/corroborated$/, "");
  const criticDomainsUsed = await Promise.all(critics2.map(async (c) => {
    const a = attempts2.get(c.taskId).find((x) => SUBMITTED_ATTEMPT_STATES.includes(x.state));
    const readers = await w2.repo.independenceDomainsForSubject(w2.wf, subjectOf(c));
    return { critic: c, submitted: a ?? null, tookPart: a ? readers.includes(a.independenceDomain) : false };
  }));
  t.check("both critics shared: no verify_claim attempt is submitted in a domain that authored one of the corroborated readings it judges",
    critics2.length > 0 && criticDomainsUsed.every((x) => !x.tookPart),
    criticDomainsUsed.map((x) => `${x.submitted ? x.submitted.executorFamily : "none"}:${x.tookPart ? "took part" : "independent"}`).join(", "));
  const blind2 = (await w2.repo.listClaims({ workflowId: w2.wf })).filter((c) => c.independenceGroup !== null);
  const dis2 = await w2.repo.listDisagreements(w2.wf);
  const dec2 = await w2.repo.listDecisions(w2.wf);
  t.check("both critics shared: the corroborated claims are not accepted and each subject is held for a person",
    blind2.length > 0 && blind2.every((c) => c.status !== "accepted") && every(critics2, (c) => holdOf(dis2, dec2, c.subjectKey).dis?.state === "needs_human" || holdOf(dis2, dec2, subjectOf(c)).dis?.state === "needs_human"),
    `claims ${[...new Set(blind2.map((c) => c.status))].join("/")}; workflow ${driven2.report.workflow.state}; holds ${dis2.filter((d) => d.state === "needs_human").length}`);
}

/* ═══════════════════════════ every door stayed closed */
t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
