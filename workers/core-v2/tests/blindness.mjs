/* A BLIND READER IS BLIND, AND A JUDGE DOES NOT KNOW WHO WROTE WHAT.
 *
 * Blindness is enforced in the packet, not asked for in a prompt (docs/core-v2.md
 * §1, visibility; §5, evidence scope; kernel/visibility.ts, packet-builder.ts).
 * The synthetic-records workflow is run with a value disagreement so that the
 * comparator, the critic, the verifier, the arbiter and the composer all run;
 * then every packet an executor was handed is read back and held to the rules.
 *
 * Nothing here reaches a network or a database; the network is sealed first.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { harness, closeNetwork } from "./harness.mjs";
import { syntheticRecordSet } from "../domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack } from "../domains/synthetic-records/pack.ts";
import { mockExecutors } from "../domains/synthetic-records/mocks.ts";
import { assemble, manualClock } from "../domains/simulate.ts";
import { RoleRegistry } from "../kernel/roles.ts";
import {
  AUTHORSHIP_WORDS, assertPacketRespectsVisibility, authorshipContent, forbiddenContent, scrubLocator, scrubScope,
} from "../kernel/visibility.ts";

const tripped = closeNetwork();
const t = harness("a blind reader is blind, and a judge does not know who wrote what");

const SEED = "blindness/1";

/* The kernel's own list of provider words, lifted from kernel/visibility.ts
   at run time so this file never writes one down. The first plain word is
   the one the leak probe below uses. */
const visibilitySource = readFileSync(fileURLToPath(new URL("../kernel/visibility.ts", import.meta.url)), "utf8");
const providerList = visibilitySource.match(/PROVIDER_WORDS\s*=\s*(\[.+?\]);/);
const providerWord = providerList ? JSON.parse(providerList[1]).find((w) => /^[a-z]+$/.test(w)) ?? null : null;
const LETTER = /^[A-Z]{1,3}$/;
const ANALYSTS = new Set(["table_reader", "note_reader"]);
const JUDGES = new Set(["evidence_critic", "disagreement_verifier", "evidence_arbiter"]);
const text = (packet) => JSON.stringify(packet);
const lower = (packet) => text(packet).toLowerCase();
const by = (packets, roleKey) => packets.filter((p) => p.roleKey === roleKey);

/* One workflow over one sheet of three entries, with the readers scripted as
   the caller says. Returns every packet handed out, and the record. */
async function run(script) {
  const truth = syntheticRecordSet({ seed: SEED, sources: 1, sheetsPerSource: 1, entriesPerTable: 3 });
  const pack = new SyntheticRecordsPack();
  const { registry, executors } = mockExecutors(truth, { scripts: { "reader-family-one": script, "reader-family-two": script, "reader-family-three": script } });
  const { scheduler, repo } = assemble({ manifest: truth.manifest, pack, executors: registry, clock: manualClock() });
  await scheduler.plan();
  const report = await scheduler.runUntilQuiescent();
  const workflowId = truth.manifest.workflowId;
  const tasks = await repo.listTasks(workflowId);
  const attemptIds = new Set();
  for (const task of tasks) for (const a of await repo.listAttempts(task.taskId)) attemptIds.add(a.attemptId);
  const claims = await repo.listClaims({ workflowId });
  return {
    truth, pack, repo, report, workflowId, tasks, claims,
    claimIds: new Set(claims.map((c) => c.claimId)),
    attemptIds,
    /* What the scripted (model) executors were handed, in order. */
    received: Object.values(executors).flatMap((e) => e.received),
    /* Everything the registry handed to any executor, code included. */
    seen: registry.packetsSeen,
    disagreements: await repo.listDisagreements(workflowId),
    registry: new RoleRegistry(pack),
  };
}

/* Run A — the assigned scenario. reader-b is wrong on E-001 by five; reader-a
   writes its own group name into every scope and every locator it returns. */
const wrongOnOne = (packet, base) => {
  if (packet.independenceGroup === "reader-a") {
    for (const c of base.claims) c.scope = { ...c.scope, author: "reader-a" };
    for (const a of base.anchors) a.locator = { ...a.locator, author: "reader-a" };
  }
  if (packet.roleKey === "table_reader" && packet.independenceGroup === "reader-b") {
    for (const c of base.claims) if (c.subjectKey === "entry/E-001") c.value = { ...c.value, quantity: c.value.quantity + 5, text: `${c.value.quantity + 5} ${c.unit}` };
  }
  return base;
};

/* Run B — reader-b returns nothing at all for the note, and cannot read E-001
   in the table. The comparator must know the silent reader existed; the
   arbiter must be handed code's note about the unreadable value. */
const silentOnNote = (packet, base) => {
  if (packet.independenceGroup === "reader-b" && packet.roleKey === "note_reader") { base.claims = []; base.anchors = []; }
  if (packet.independenceGroup === "reader-b" && packet.roleKey === "table_reader") {
    for (const c of base.claims) if (c.subjectKey === "entry/E-001") c.value = { known: false, quantity: null, text: null, attributes: c.value.attributes };
  }
  return base;
};

const A = await run(wrongOnOne);
const B = await run(silentOnNote);

/* ───────────────────────────────────────────────────────────── the run */
t.section("the run that produced the packets");

t.check("the value-disagreement workflow completes with its one dispute resolved by machine",
  A.report.workflow.state === "completed" && A.report.disagreements.resolved === 1 && Object.keys(A.report.disagreements).length === 1,
  `state=${A.report.workflow.state} disagreements=${JSON.stringify(A.report.disagreements)}`);

const rolesRan = new Set(A.seen.map((p) => p.roleKey));
t.check("both analysts, the comparator, the critic, the verifier, the arbiter and the composer all ran",
  ["table_reader", "note_reader", "claim_comparator", "evidence_critic", "disagreement_verifier", "evidence_arbiter", "decision_composer"].every((r) => rolesRan.has(r)),
  [...rolesRan].join(", "));

const analystsA = A.received.filter((p) => ANALYSTS.has(p.roleKey));
t.check("each region was read twice, under two blind groups", analystsA.length === 4 && new Set(analystsA.map((p) => p.independenceGroup)).size === 2,
  analystsA.map((p) => `${p.roleKey}:${p.independenceGroup}`).join(" "));

/* ─────────────────────────────────────────────────── analysts are blind */
t.section("a blind reader is blind");

t.check("every analyst packet is marked blind", analystsA.every((p) => p.blindContext === true));
t.check("every analyst packet carries no claims in its context", analystsA.every((p) => p.context.claims.length === 0));
t.check("an analyst's dependencies name no blind group and no other reader's claims",
  analystsA.every((p) => p.dependencies.every((d) => d.independenceGroup === null && d.claimIds.length === 0)));
t.check("an analyst packet carries no assessments, no disagreements and no validation notes",
  analystsA.every((p) => p.context.assessments.length === 0 && p.context.disagreements.length === 0 && p.context.validation.length === 0));
t.check("no analyst packet contains any claim id of the record", analystsA.every((p) => ![...A.claimIds].some((id) => text(p).includes(id))));

const readerClaims = A.claims.filter((c) => c.independenceGroup !== null);
const readerAnchors = await A.repo.listAnchors(readerClaims.map((c) => c.claimId));
const readerWords = [
  ...readerClaims.map((c) => c.value.text).filter(Boolean),
  ...readerAnchors.map((a) => a.quotedText).filter(Boolean),
];
t.check("no analyst packet contains any reader's value text or quoted text — not another reader's, not its own",
  readerWords.length >= 8 && analystsA.every((p) => !readerWords.some((w) => text(p).includes(w))),
  `${readerWords.length} reader phrases searched`);

const tableReads = by(analystsA, "table_reader");
t.check("the second blind reader of a table is handed the same source as the first, and nothing the first said",
  tableReads.length === 2 && text(tableReads[0].sources) === text(tableReads[1].sources) && tableReads[0].independenceGroup !== tableReads[1].independenceGroup
    && tableReads.every((p) => p.dependencies.length === 0 && p.context.claims.length === 0));

/* ────────────────────────────────────────── the comparator knows who read */
t.section("the comparator alone is told which reader read under which group");

const tableSubject = tableReads[0].subjectKey;
const comparatorA = by(A.seen, "claim_comparator").find((p) => p.subjectKey === tableSubject);
t.check("the comparator's packet carries the blind group of every dependency",
  !!comparatorA && comparatorA.dependencies.length === 2 && comparatorA.dependencies.every((d) => d.independenceGroup !== null)
    && new Set(comparatorA.dependencies.map((d) => d.independenceGroup)).size === 2,
  comparatorA ? JSON.stringify(comparatorA.dependencies.map((d) => [d.kind, d.claimIds.length, d.independenceGroup])) : "no comparator packet");
t.check("the comparator sees every reading of its subject with the group that made it",
  !!comparatorA && comparatorA.context.claims.length === 6 && comparatorA.context.claims.every((c) => c.independenceGroup !== null));

const noteSubject = by(analystsA, "note_reader")[0].subjectKey;
const comparatorB = by(B.seen, "claim_comparator").find((p) => p.subjectKey === noteSubject);
const silent = comparatorB?.dependencies.find((d) => d.claimIds.length === 0);
t.check("a reader that returned nothing is still named to the comparator, by its group, with no claims",
  !!silent && silent.independenceGroup === "reader-b" && comparatorB.dependencies.some((d) => d.claimIds.length === 1 && d.independenceGroup === "reader-a"),
  comparatorB ? JSON.stringify(comparatorB.dependencies.map((d) => [d.claimIds.length, d.independenceGroup])) : "no comparator packet");
t.check("and the comparator uses it: one reader's silence is recorded as a missing disagreement, not as agreement",
  B.disagreements.some((d) => d.kind === "missing" && d.subjectSignature.subject_key !== undefined),
  B.disagreements.map((d) => d.kind).join(","));

/* ─────────────────────────────────────────────── judges see letters only */
t.section("a judge is handed letters, never names");

const judgesA = A.received.filter((p) => JUDGES.has(p.roleKey));
const judgesB = B.received.filter((p) => JUDGES.has(p.roleKey));
const judges = [...judgesA.map((p) => ({ p, world: A })), ...judgesB.map((p) => ({ p, world: B }))];
t.check("a critic, a verifier and an arbiter ran in each run",
  ["evidence_critic", "disagreement_verifier", "evidence_arbiter"].every((r) => by(judgesA, r).length >= 1 && by(judgesB, r).length >= 1),
  `${judgesA.length} judge packets in run A, ${judgesB.length} in run B`);
t.check("every claim a judge sees is under a letter, never under its id",
  judges.every(({ p }) => p.context.claims.length > 0 && p.context.claims.every((c) => LETTER.test(c.ref))),
  judges.map(({ p }) => `${p.roleKey}:${p.context.claims.map((c) => c.ref).join("")}`).join(" "));
t.check("no claim a judge sees says which reader made it", judges.every(({ p }) => p.context.claims.every((c) => c.independenceGroup === null)));
t.check("no claim a judge sees names the claims it was computed from", judges.every(({ p }) => p.context.claims.every((c) => c.inputRefs.length === 0)));
t.check("a judge's dependencies carry no blind group and list no claim ids",
  judges.every(({ p }) => p.dependencies.every((d) => d.independenceGroup === null && d.claimIds.length === 0)));
t.check("a judge's packet contains none of the engine's own authorship words",
  judges.every(({ p }) => !AUTHORSHIP_WORDS.some((w) => lower(p).includes(w))));
t.check("a judge's packet contains no claim id of the record",
  judges.every(({ p, world }) => ![...world.claimIds].some((id) => text(p).includes(id))));
t.check("a judge's packet contains no attempt id of the record",
  judges.every(({ p, world }) => world.attemptIds.size >= 10 && ![...world.attemptIds].some((id) => text(p).includes(id))));
t.check("the kernel's own authorship check agrees: nothing in a judge's packet says who did the work",
  judges.every(({ p }) => authorshipContent(p).length === 0));

const criticA = by(judgesA, "evidence_critic");
t.check("the critic sees claims and their anchors, and no assessment, disagreement or validation note",
  criticA.length >= 1 && criticA.every((p) => p.context.claims.every((c) => c.anchors.length > 0) && p.context.assessments.length === 0 && p.context.disagreements.length === 0 && p.context.validation.length === 0));

const verifierA = by(judgesA, "disagreement_verifier")[0];
t.check("the verifier sees the disagreement with its claims under letters, and no assessment",
  !!verifierA && verifierA.context.disagreements.length === 1 && verifierA.context.disagreements[0].claimRefs.every((r) => LETTER.test(r))
    && verifierA.context.disagreements[0].claimRefs.length === verifierA.context.claims.length && verifierA.context.assessments.length === 0);

const dispute = A.disagreements.find((d) => d.kind === "value");
const disputeValues = dispute ? new Set((await Promise.all(dispute.claimIds.map((id) => A.repo.getClaim(id)))).map((c) => c.value.quantity)) : new Set();
t.check("the verifier is shown both competing values of the dispute, with nothing that tells which reader read which",
  !!verifierA && disputeValues.size === 2 && text([...disputeValues].sort()) === text(verifierA.context.claims.map((c) => c.value.quantity).sort()),
  `dispute values ${[...disputeValues].join("/")} · verifier saw ${verifierA?.context.claims.map((c) => c.value.quantity).join("/")}`);

const arbiterA = by(judgesA, "evidence_arbiter")[0];
t.check("the arbiter sees the verifier's assessments, one per letter, with the values the verifier read instead",
  !!arbiterA && arbiterA.context.assessments.length === 2 && arbiterA.context.assessments.every((a) => LETTER.test(a.claimRef))
    && arbiterA.context.assessments.some((a) => a.assessment === "supports") && arbiterA.context.assessments.some((a) => a.assessment === "contradicts" && a.proposedValue?.known));
t.check("an assessment handed to the arbiter names no assessor and no domain",
  !!arbiterA && arbiterA.context.assessments.every((a) => !("independenceDomain" in a) && !("attemptId" in a) && !("assessmentId" in a) && !("taskId" in a)));
t.check("the arbiter sees the disagreement under letters and the validation field code may fill",
  !!arbiterA && arbiterA.context.disagreements.length === 1 && arbiterA.context.disagreements[0].claimRefs.every((r) => LETTER.test(r)) && Array.isArray(arbiterA.context.validation));

const valueDisputeB = B.disagreements.find((d) => d.kind === "value");
const arbiterB = by(judgesB, "evidence_arbiter").find((p) => p.context.claims.some((c) => !c.value.known));
const verifierB = by(judgesB, "disagreement_verifier").find((p) => p.context.claims.some((c) => !c.value.known));
t.check("when a competing reading is unknown, the arbiter is handed code's note saying so, under the letter",
  !!valueDisputeB && !!arbiterB && arbiterB.context.validation.length === 1 && /^claim [A-Z]{1,3}: the reader could not read a value$/.test(arbiterB.context.validation[0]),
  arbiterB ? JSON.stringify(arbiterB.context.validation) : "no arbiter packet with an unknown value");
t.check("the verifier of the same dispute is handed no validation note and no assessment",
  !!verifierB && verifierB.context.validation.length === 0 && verifierB.context.assessments.length === 0);

/* ─────────────────────────────────────────── the composer and its subject */
t.section("a composer sees only its own subject's accepted evidence");

const composers = by(A.received, "decision_composer");
const categoryTotals = A.claims.filter((c) => c.subjectType === "category" && c.status === "accepted");
t.check("one composer packet per subject with an accepted total", composers.length >= 2 && composers.length === categoryTotals.length,
  composers.map((p) => p.subjectKey).join(", "));
t.check("every claim in a composer packet is accepted", composers.every((p) => p.context.claims.length > 0 && p.context.claims.every((c) => c.status === "accepted")));

const composerCarriesOnlyItsSubject = composers.every((p) => {
  const own = p.context.claims.filter((c) => c.subjectKey === p.subjectKey);
  const inputs = new Set(own.flatMap((c) => c.inputRefs));
  return own.length === 1 && p.context.claims.every((c) => c.subjectKey === p.subjectKey || inputs.has(c.ref));
});
t.check("a composer packet carries its subject's claim and the claims that claim names as inputs, and nothing else", composerCarriesOnlyItsSubject);
t.check("no composer packet carries a claim of another category",
  composers.every((p) => p.context.claims.every((c) => c.subjectType !== "category" || c.subjectKey === p.subjectKey)));
t.check("a composer's claims say which reader made them to nobody", composers.every((p) => p.context.claims.every((c) => c.independenceGroup === null)));

const rejected = A.claims.filter((c) => c.status === "rejected");
t.check("the rejected reading appears in no composer packet", rejected.length === 1 && composers.every((p) => !p.context.claims.some((c) => c.ref === rejected[0].claimId)));

const disputedCategory = `category/${A.truth.entries.find((e) => e.id === "E-001").category}`;
const disputedComposer = composers.find((p) => p.subjectKey === disputedCategory);
const otherComposers = composers.filter((p) => p.subjectKey !== disputedCategory);
t.check("the composer whose subject holds the disputed entry sees that one disagreement, its refs cut to the claims in the packet",
  !!disputedComposer && disputedComposer.context.disagreements.length === 1
    && disputedComposer.context.disagreements[0].claimRefs.every((r) => disputedComposer.context.claims.some((c) => c.ref === r))
    && disputedComposer.context.disagreements[0].claimRefs.length === 1,
  disputedComposer ? JSON.stringify(disputedComposer.context.disagreements.map((d) => d.claimRefs.length)) : `no composer for ${disputedCategory}`);
t.check("a composer whose claims the dispute does not touch sees no disagreement at all",
  otherComposers.length >= 1 && otherComposers.every((p) => p.context.disagreements.length === 0));

/* ────────────────────────────────────── the guard refuses a leaking packet */
t.section("the kernel's own guard refuses a packet that leaks");

const analystRole = A.registry.role("table_reader");
const criticRole = A.registry.role("evidence_critic");
const cleanAnalyst = tableReads[0];
const cleanCritic = criticA[0];
const someClaim = comparatorA.context.claims[0];
const has = (problems, pattern) => problems.some((p) => pattern.test(p));

t.check("control: a real analyst packet passes the guard", assertPacketRespectsVisibility(cleanAnalyst, analystRole).length === 0, assertPacketRespectsVisibility(cleanAnalyst, analystRole).join("; "));
t.check("control: a real critic packet passes the guard", assertPacketRespectsVisibility(cleanCritic, criticRole).length === 0, assertPacketRespectsVisibility(cleanCritic, criticRole).join("; "));

const leakedClaim = structuredClone(cleanAnalyst);
leakedClaim.context.claims.push({ ...someClaim, independenceGroup: null });
t.check("an analyst packet with a claim in its context is refused as carrying a claim that is not its own dependency",
  has(assertPacketRespectsVisibility(leakedClaim, analystRole), /not one of its dependencies/));

const leakedGroup = structuredClone(cleanAnalyst);
leakedGroup.dependencies.push({ taskId: tableReads[1].taskId, kind: "requires_claims", claimIds: [], independenceGroup: "reader-b" });
t.check("an analyst packet whose dependency names a blind group is refused",
  has(assertPacketRespectsVisibility(leakedGroup, analystRole), /which blind group/));

const leakedId = structuredClone(cleanCritic);
leakedId.context.claims[0].ref = someClaim.ref;
t.check("an anonymised packet that shows a claim under a uuid instead of a letter is refused",
  has(assertPacketRespectsVisibility(leakedId, criticRole), /rather than a letter/));

const leakedQuote = structuredClone(cleanCritic);
leakedQuote.context.claims[0].anchors[0].quotedText = `see ${someClaim.ref}`;
t.check("an anonymised packet that smuggles a claim id inside a quoted text is refused",
  has(assertPacketRespectsVisibility(leakedQuote, criticRole), /carries an id that is not an anchor/));

const leakedGroupWord = structuredClone(cleanCritic);
leakedGroupWord.objective = `${leakedGroupWord.objective} (reader-b disagrees)`;
t.check("an anonymised packet that names a reader group anywhere in its text is refused",
  has(assertPacketRespectsVisibility(leakedGroupWord, criticRole), /carries authorship/));

t.check("the provider-word list was read out of the kernel's source, so this file names no provider", providerWord !== null,
  providerList ? `${JSON.parse(providerList[1]).length} words` : "not found");
const leakedProvider = structuredClone(cleanAnalyst);
leakedProvider.objective = `${leakedProvider.objective} Answer as ${providerWord} would.`;
t.check("a packet that names a provider is refused", has(assertPacketRespectsVisibility(leakedProvider, analystRole), /names a provider/));

const leakedUrl = structuredClone(cleanAnalyst);
leakedUrl.sources[0].locator = { ...leakedUrl.sources[0].locator, label: "https://example.invalid/sheet.png" };
t.check("a packet that carries a URL is refused", has(assertPacketRespectsVisibility(leakedUrl, analystRole), /carries a URL/));

const leakedLink = structuredClone(cleanAnalyst);
leakedLink.sources[0].locator = { ...leakedLink.sources[0].locator, label: "sheet.png?X-Amz-Signature=abc" };
t.check("a packet that carries a signed-link pattern is refused", has(assertPacketRespectsVisibility(leakedLink, analystRole), /credential or signed link/));

const leakedCost = structuredClone(cleanAnalyst);
leakedCost.limits = { ...leakedCost.limits, cost_usd: 0.02 };
t.check("a packet that carries a cost_usd key is refused", has(assertPacketRespectsVisibility(leakedCost, analystRole), /cost or a majority/));

const leakedMajority = structuredClone(cleanCritic);
leakedMajority.context = { ...leakedMajority.context, majority: "B" };
t.check("a packet that carries a majority as proof is refused", has(assertPacketRespectsVisibility(leakedMajority, criticRole), /cost or a majority/));

/* ────────────────────────────────── a reader's own marks travel to nobody */
t.section("what a reader writes into a scope or a locator reaches nobody");

t.check("scrubScope keeps the kernel's scope keys and drops everything else",
  text(scrubScope({ segment: "table 1", author: "reader-a", note: "x", unit_system: "si" })) === text({ segment: "table 1", unit_system: "si" }));
t.check("scrubLocator keeps geometry and drops unknown keys",
  text(scrubLocator({ bbox: [0, 0, 1, 1], author: "reader-a", model: "y", start_ms: 1, end_ms: 2 })) === text({ bbox: [0, 0, 1, 1], start_ms: 1, end_ms: 2 }));

const readerAClaims = A.claims.filter((c) => c.independenceGroup === "reader-a");
const readerAAnchors = await A.repo.listAnchors(readerAClaims.map((c) => c.claimId));
t.check("the record keeps what reader-a wrote: its group name sits in the scope of every claim it made",
  readerAClaims.length === 4 && readerAClaims.every((c) => c.scope.author === "reader-a"));
t.check("and in the locator of every anchor it made", readerAAnchors.length === 4 && readerAAnchors.every((a) => a.locator.author === "reader-a"));

const afterReaders = A.seen.filter((p) => !ANALYSTS.has(p.roleKey) && p.roleKey !== "region_discoverer" && p.roleKey !== "source_ingestor");
t.check("no packet built from the record — comparator, critic, verifier, arbiter, totaliser, composer — carries the author key reader-a wrote",
  afterReaders.length >= 8 && afterReaders.every((p) => !text(p).includes('"author"')),
  `${afterReaders.length} packets searched`);
t.check("the critic saw reader-a's claims with the scope cut to the kernel's keys",
  criticA.every((p) => p.context.claims.every((c) => Object.keys(c.scope).every((k) => k === "segment") && c.anchors.every((a) => Object.keys(a.locator).every((k) => k === "bbox")))));
t.check("the comparator lined the two readers up despite the mark: one value disagreement, no scope disagreement",
  A.disagreements.length === 1 && A.disagreements[0].kind === "value");

/* ───────────────────────────── no packet carries a URL, a link, a provider */
t.section("nothing that could reach outside is in any packet");

const everyPacket = [...A.seen, ...B.seen];
t.check("forbiddenContent() finds nothing in any packet handed to any executor in either run",
  everyPacket.length >= 30 && everyPacket.every((p) => forbiddenContent(p).length === 0),
  `${everyPacket.length} packets checked`);
t.check("the manifest's source uri appears in no packet — sources travel as ids and hashes", everyPacket.every((p) => !text(p).includes("fixture://")));
t.check("no packet names an executor family or an independence domain", everyPacket.every((p) => !lower(p).includes("-family-") && !lower(p).includes("domain:")));

/* ─────────────────────────────────────────────────────────── identity */
t.section("identity");

const analystIds = (world) => world.tasks.filter((x) => ANALYSTS.has(x.roleKey)).map((x) => x.taskId).sort().join(",");
t.check("the same seed plans the same analyst task ids in both runs", analystIds(A) === analystIds(B) && analystIds(A).length > 0);
t.check("the network was never touched", tripped() === 0, `${tripped()} attempts`);

t.finish();
