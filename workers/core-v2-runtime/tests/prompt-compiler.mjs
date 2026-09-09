/* THE INSTRUCTIONS SAY THE PACKET, AND THE PACKET ONLY.
 *
 * The compiler is the one place where a bounded packet becomes free text, so
 * it is the one place a leak the kernel spent the packet preventing could be
 * written back in. Nothing here is judged by reading the prose: every check
 * is a scan. Every version-5 uuid in the compiled text must appear in the
 * packet that produced it; the permitted asks in the text must be exactly the
 * packet's, taken from the kernel's own vocabulary; the provider words come
 * out of kernel/visibility.ts at run time so this file names none; the schema
 * is held against kernel/contracts.ts field for field, parsed from the
 * contract's own source.
 *
 * The packets are real: the synthetic-records pack is run through the kernel
 * twice on one seed, with a value disagreement so that the critic, the
 * verifier, the arbiter and the composer all run, and the packets the
 * registry handed out are compiled as they were handed out.
 *
 * Nothing here reaches a network, a provider or a database.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { harness, closeNetwork } from "../../core-v2/tests/harness.mjs";
import { syntheticRecordSet } from "../../core-v2/domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack } from "../../core-v2/domains/synthetic-records/pack.ts";
import { mockExecutors } from "../../core-v2/domains/synthetic-records/mocks.ts";
import { assemble, manualClock } from "../../core-v2/domains/simulate.ts";
import { RoleRegistry } from "../../core-v2/kernel/roles.ts";
import { AGENT_ACTION_TYPES } from "../../core-v2/kernel/contracts.ts";
import { AUTHORSHIP_WORDS } from "../../core-v2/kernel/visibility.ts";
import {
  ABSTENTION_RULE, AGREEMENT_IS_NOT_PROOF, BLIND_READING, CITE_ONLY_GIVEN_IDENTIFIERS, ENVELOPE_VOCABULARY,
  NOTHING_ABOUT_WHO_ELSE_READ, NOTHING_TO_READ, NO_FOLLOW_UP, NO_OTHER_AGENTS, compilePrompt,
} from "../prompt-compiler.ts";

const tripped = closeNetwork();
const t = harness("the compiled instructions say the packet, and the packet only");

const SEED = "prompt-compiler/1";
const V5 = /[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;

/* The kernel's own source, read at run time, so this file writes down neither
   a provider name nor a contract field. */
const kernelFile = (name) => readFileSync(fileURLToPath(new URL(`../../core-v2/kernel/${name}`, import.meta.url)), "utf8");
const visibilitySource = kernelFile("visibility.ts");
const contractsSource = kernelFile("contracts.ts");
const providerWords = JSON.parse(visibilitySource.match(/PROVIDER_WORDS\s*=\s*(\[.+?\]);/)[1]);

/* The fields of one type in the contract, in source order, with the optional
   ones marked — so "field for field" is a comparison, not an impression. Only
   the outermost fields count: a nested object literal is one field, not five. */
function contractFields(name) {
  const block = contractsSource.match(new RegExp(`export type ${name} = [^{]*\\{([\\s\\S]*?)\\n\\};`));
  if (!block) return null;
  const all = [];
  const required = [];
  let depth = 0;
  for (const raw of block[1].split("\n")) {
    const line = raw.trim();
    const opened = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0 && !line.startsWith("/*") && !line.startsWith("*") && !line.startsWith("//") && line !== "") {
      const m = line.match(/^([A-Za-z_]\w*)(\?)?\s*:/);
      if (m) { all.push(m[1]); if (!m[2]) required.push(m[1]); }
    }
    depth += opened;
  }
  return { all, required };
}

/* A phrase from the record, matched on word boundaries, so that a value that
   happens to be an English word cannot be "found" inside a field name. */
function carriesPhrase(text, phrase) {
  return new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\b`).test(text);
}

/* The literals of one string union in the contract. */
function contractUnion(name) {
  const block = contractsSource.match(new RegExp(`export type ${name} =([^;]*);`));
  return block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortedSet = (xs) => [...new Set(xs)].sort();

/* ─────────────────────────────────────────────────── real packets, twice */

/* reader-b reads E-001 five too high, so the comparator finds a value
   disagreement and the critic, verifier, arbiter and composer all run. */
const wrongOnOne = (packet, base) => {
  if (packet.roleKey === "table_reader" && packet.independenceGroup === "reader-b") {
    for (const c of base.claims) if (c.subjectKey === "entry/E-001") c.value = { ...c.value, quantity: c.value.quantity + 5, text: `${c.value.quantity + 5} ${c.unit}` };
  }
  return base;
};

async function run() {
  const truth = syntheticRecordSet({ seed: SEED, sources: 1, sheetsPerSource: 1, entriesPerTable: 3 });
  const pack = new SyntheticRecordsPack();
  const { registry } = mockExecutors(truth, { scripts: { "reader-family-one": wrongOnOne, "reader-family-two": wrongOnOne, "reader-family-three": wrongOnOne } });
  const { scheduler, repo } = assemble({ manifest: truth.manifest, pack, executors: registry, clock: manualClock() });
  await scheduler.plan();
  const report = await scheduler.runUntilQuiescent();
  const workflowId = truth.manifest.workflowId;
  const roles = new RoleRegistry(pack);
  const claims = await repo.listClaims({ workflowId });
  const anchors = await repo.listAnchors(claims.map((c) => c.claimId));
  const tasks = await repo.listTasks(workflowId);
  const attemptIds = new Set();
  for (const task of tasks) for (const a of await repo.listAttempts(task.taskId)) attemptIds.add(a.attemptId);
  return {
    truth, pack, repo, report, roles, claims, anchors, attemptIds,
    claimIds: new Set(claims.map((c) => c.claimId)),
    disagreements: await repo.listDisagreements(workflowId),
    seen: registry.packetsSeen,
  };
}

const A = await run();
const B = await run();

/* Every packet that a model role was handed, compiled. Code roles are never
   prompted, so they are never compiled. */
const modelPackets = A.seen.filter((p) => A.roles.role(p.roleKey).executorKind === "model");
const compiled = modelPackets.map((packet) => {
  const role = A.roles.role(packet.roleKey);
  const prompt = compilePrompt(packet, role);
  return { packet, role, prompt, text: `${prompt.system}\n${prompt.user}` };
});
const first = (roleKey) => compiled.find((c) => c.packet.roleKey === roleKey);
const analyst = compiled.find((c) => c.role.kind === "analyst" && c.packet.blindContext);
const critic = first("evidence_critic");
const verifier = first("disagreement_verifier");
const arbiter = first("evidence_arbiter");
const composer = first("decision_composer");
const discoverer = first("region_discoverer");

t.section("the run that produced the packets");

t.check("the workflow completes with its one value disagreement resolved by machine",
  A.report.workflow.state === "completed" && A.disagreements.length === 1 && A.disagreements[0].kind === "value",
  `${A.report.workflow.state}, ${A.disagreements.map((d) => d.kind).join(",")}`);
t.check("a blind analyst, a discoverer, a critic, a verifier, an arbiter and a composer were all compiled from real packets",
  [analyst, discoverer, critic, verifier, arbiter, composer].every(Boolean) && compiled.length >= 10,
  `${compiled.length} model packets compiled from ${A.seen.length} handed out`);
t.check("no packet of a code role was compiled — code is never prompted",
  A.seen.some((p) => A.roles.role(p.roleKey).executorKind === "deterministic") && compiled.every((c) => c.role.executorKind === "model"));

/* ───────────────────────────────── a blind reader's instructions are blind */
t.section("a blind reader's instructions carry nothing the blind reader's packet did not");

const packetText = (packet) => JSON.stringify(packet);
const uuidsOutsideThePacket = ({ packet, prompt, text }) => {
  const inPacket = packetText(packet);
  const everything = `${text}\n${JSON.stringify(prompt.schema)}`;
  return [...new Set(everything.match(V5) ?? [])].filter((id) => !inPacket.includes(id));
};

t.check("the blind reader's packet really is blind, with no claim and no dependency of its own",
  analyst.packet.blindContext === true && analyst.packet.context.claims.length === 0 && analyst.packet.dependencies.length === 0);
t.check("the blind reader's instructions say so, in the compiler's own words", analyst.text.includes(BLIND_READING));

t.check("every version-5 uuid in the blind reader's instructions and schema appears in its packet",
  uuidsOutsideThePacket(analyst).length === 0 && (analyst.text.match(V5) ?? []).length >= 2,
  `${(analyst.text.match(V5) ?? []).length} uuids in the text; outside the packet: ${uuidsOutsideThePacket(analyst).join(", ") || "none"}`);
t.check("no claim id of the record appears in the blind reader's instructions",
  A.claimIds.size >= 8 && ![...A.claimIds].some((id) => analyst.text.includes(id)), `${A.claimIds.size} claim ids searched`);
t.check("no attempt id of the record appears in the blind reader's instructions",
  A.attemptIds.size >= 10 && ![...A.attemptIds].some((id) => analyst.text.includes(id)), `${A.attemptIds.size} attempt ids searched`);
t.check("no disagreement id of the record appears in the blind reader's instructions",
  A.disagreements.length >= 1 && !A.disagreements.some((d) => analyst.text.includes(d.disagreementId)));

const readerPhrases = [
  ...A.claims.filter((c) => c.independenceGroup !== null).map((c) => c.value.text).filter(Boolean),
  ...A.anchors.map((a) => a.quotedText).filter(Boolean),
];
t.check("no reader's value text and no quoted text of the record appears in the blind reader's instructions",
  readerPhrases.length >= 8 && !readerPhrases.some((w) => carriesPhrase(analyst.text, w)), `${readerPhrases.length} phrases searched`);

const MAJORITY = /\b(majority|majorities|vote|votes|voted|voting|consensus|quorum|tally|tallies|ballot|plurality|outnumber\w*)\b/gi;
const majorityWords = (text) => [...new Set(text.match(MAJORITY) ?? [])];
t.check("the blind reader's instructions contain no word for counting agreement", majorityWords(analyst.text).length === 0,
  majorityWords(analyst.text).join(","));
t.check("and where such a word does appear, the packet put it there — the compiler writes none of its own",
  compiled.some((c) => majorityWords(c.text).length > 0)
    && compiled.every((c) => majorityWords(c.text).every((w) => majorityWords(packetText(c.packet)).includes(w))),
  compiled.filter((c) => majorityWords(c.text).length).map((c) => `${c.packet.roleKey}:${majorityWords(c.text).join("/")}`).join(" "));

const providerHit = (text) => providerWords.filter((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(text.toLowerCase()));
t.check("the provider words were read out of the kernel's source, so this test names no provider", providerWords.length >= 8, `${providerWords.length} words`);
t.check("the blind reader's instructions name no provider and never say model",
  providerHit(analyst.text).length === 0 && !/\bmodels?\b/i.test(analyst.text), providerHit(analyst.text).join(","));

const DECISION_LITERALS = [...new Set([...contractUnion("DecisionType"), ...contractUnion("AdjudicationOutcome")])];
const decisionHit = (text) => DECISION_LITERALS.filter((w) => new RegExp(`\\b${w}\\b`).test(text));
t.check("the blind reader's instructions contain no outcome word of a decision or an adjudication, taken from the contract's own unions",
  DECISION_LITERALS.length >= 9 && decisionHit(analyst.text).length === 0 && !/\b(decision|decisions|decide|decides|verdict|adjudicat\w*)\b/i.test(analyst.text),
  `${DECISION_LITERALS.length} literals searched; hit: ${decisionHit(analyst.text).join(",") || "none"}`);
t.check("the blind reader's instructions reach no conclusion about a disagreement — the word never appears",
  !/disagree\w*/i.test(analyst.text) && !/contradict\w*/i.test(analyst.text));

const authorshipHit = (text) => AUTHORSHIP_WORDS.filter((w) => text.toLowerCase().includes(w));
t.check("the blind reader's instructions carry none of the engine's authorship words",
  authorshipHit(analyst.text).length === 0, authorshipHit(analyst.text).join(","));
t.check("the blind reader's own group name is in its packet and in no line of its instructions",
  analyst.packet.independenceGroup !== null && !analyst.text.includes(analyst.packet.independenceGroup),
  `group ${analyst.packet.independenceGroup}`);
t.check("the source's uri never reaches the instructions — material travels as ids and hashes",
  A.truth.manifest.sources[0].uri.length > 0 && !analyst.text.includes(A.truth.manifest.sources[0].uri) && !/https?:\/\//.test(analyst.text));

t.check("no compiled text of any role carries an authorship word, a provider word, or a uuid its packet lacks",
  compiled.every((c) => authorshipHit(c.text).length === 0 && providerHit(c.text).length === 0 && uuidsOutsideThePacket(c).length === 0),
  compiled.filter((c) => authorshipHit(c.text).length || providerHit(c.text).length || uuidsOutsideThePacket(c).length).map((c) => c.packet.roleKey).join(",") || "all clean");

/* ───────────────────────────────────────────── exactly the packet's asks */
t.section("the permitted asks are exactly the packet's, and the role is stated once");

const actionsIn = (text) => AGENT_ACTION_TYPES.filter((a) => text.includes(a)).sort();
t.check("for every compiled packet, the action names in the text are exactly the packet's allowed actions",
  compiled.every((c) => same(actionsIn(c.text), [...c.packet.allowedActions].sort())),
  compiled.map((c) => `${c.packet.roleKey}:${actionsIn(c.text).length}/${c.packet.allowedActions.length}`).join(" "));
t.check("a role whose packet permits nothing is told so, and no ask is named at all",
  discoverer.packet.allowedActions.length === 0 && discoverer.text.includes(NO_FOLLOW_UP) && actionsIn(discoverer.text).length === 0);
t.check("a role whose packet permits asks is given the meaning of each and the depth it may ask from",
  verifier.packet.allowedActions.length >= 4 && !verifier.text.includes(NO_FOLLOW_UP)
    && verifier.packet.allowedActions.every((a) => verifier.text.includes(`${a} —`))
    && verifier.text.includes(`currentDepth for any request: ${verifier.packet.context.depth}`));
t.check("every compiled text states its own role key and its own task, and no other role's key",
  compiled.every((c) => c.text.includes(`role: ${c.packet.roleKey}`) && c.text.includes(c.packet.taskId)
    && A.roles.keys.filter((k) => k !== c.packet.roleKey).every((k) => !c.text.includes(k))));
t.check("every compiled text carries its packet's objective verbatim and states the output contract the packet asked for",
  compiled.every((c) => c.text.includes(c.packet.objective) && c.text.includes(c.packet.expectedOutputContract)));

/* ──────────────────────────────────────────── citation, and only of givens */
t.section("every claim must cite identifiers the packet itself supplied");

t.check("every compiled text carries the citation rule and the rule against inventing an identifier",
  compiled.every((c) => c.text.includes(CITE_ONLY_GIVEN_IDENTIFIERS)));
t.check("the blind reader is given the source and segment identifiers it must cite, and the content hash of the material",
  analyst.packet.sources.length === 1
    && analyst.text.includes(`sourceId: ${analyst.packet.sources[0].sourceId}`)
    && analyst.text.includes(`segmentId: ${analyst.packet.sources[0].segmentId}`)
    && analyst.text.includes(analyst.packet.sources[0].contentHash));
t.check("a judge is given the anchor identifier of every claim it was shown",
  critic.packet.context.claims.length >= 1
    && critic.packet.context.claims.every((c) => c.anchors.length > 0 && c.anchors.every((a) => critic.text.includes(`anchor ${a.anchorId}:`))));
t.check("every compiled text says that agreement is not proof and that nothing is known about who else read",
  compiled.every((c) => c.text.includes(AGREEMENT_IS_NOT_PROOF) && c.text.includes(NO_OTHER_AGENTS) && c.text.includes(NOTHING_ABOUT_WHO_ELSE_READ)));

/* ───────────────────────────────────────────────────────────── abstention */
t.section("abstention when the packet is not enough");

t.check("every compiled text requires abstention over guessing", compiled.every((c) => c.text.includes(ABSTENTION_RULE)));

const emptied = structuredClone(analyst.packet);
emptied.sources = [];
const emptyPrompt = compilePrompt(emptied, analyst.role);
t.check("a packet with no sources produces instructions that require abstention outright",
  `${emptyPrompt.system}\n${emptyPrompt.user}`.includes(NOTHING_TO_READ)
    && emptyPrompt.user.includes("nothing was supplied to read."));
t.check("the same packet with its source restored does not require abstention outright", !analyst.text.includes(NOTHING_TO_READ));
t.check("a packet with no sources but with claims to work from is not told to abstain outright",
  composer.packet.sources.length === 0 && composer.packet.context.claims.length > 0 && !composer.text.includes(NOTHING_TO_READ));

/* ─────────────────────────────────── the schema is the envelope contract */
t.section("the schema is the kernel's envelope, field for field");

const envelope = contractFields("AgentResultEnvelope");
const schema = analyst.prompt.schema;
t.check("the envelope's fields were parsed out of the contract's own source", envelope !== null && envelope.all.length === 16,
  envelope ? envelope.all.join(",") : "not parsed");
t.check("the schema's properties are exactly the envelope's fields, in the contract's own order",
  same(Object.keys(schema.properties), envelope.all), Object.keys(schema.properties).join(","));
t.check("the schema requires every field the envelope declares, and forbids any field it does not",
  same([...schema.required].sort(), [...envelope.required].sort()) && schema.additionalProperties === false);

const NESTED = ["ClaimValue", "ProposedClaim", "ProposedAnchor", "ProposedAssessment", "ProposedDisagreement", "RequestedAgentAction", "ProposedAdjudication", "ProposedCalculation", "ProposedDecision"];
const mismatched = NESTED.filter((name) => {
  const declared = contractFields(name);
  const node = schema.$defs[name];
  return !declared || !node || !same(sortedSet(Object.keys(node.properties)), sortedSet(declared.all)) || !same(sortedSet(node.required), sortedSet(declared.required));
});
t.check("every nested shape the envelope names matches the contract field for field, optionals included",
  mismatched.length === 0 && NESTED.every((n) => contractFields(n).all.length > 0), mismatched.join(",") || `${NESTED.length} shapes checked`);

const segmentFields = sortedSet([...contractFields("SegmentDescriptor").all, "segmentKey"]);
t.check("a proposed segment is the contract's segment descriptor plus its key, and nothing more",
  same(sortedSet(Object.keys(schema.$defs.ProposedSegment.properties)), segmentFields) && segmentFields.length === 8);

const driftedVocabulary = Object.keys(ENVELOPE_VOCABULARY).filter((name) => !same(ENVELOPE_VOCABULARY[name], contractUnion(name)));
t.check("every vocabulary the schema enumerates is the contract's union, literal for literal",
  driftedVocabulary.length === 0 && Object.keys(ENVELOPE_VOCABULARY).length === 9, driftedVocabulary.join(",") || `${Object.keys(ENVELOPE_VOCABULARY).length} vocabularies checked`);

t.check("the schema fixes the four fields the kernel already knows, so an answer cannot claim to be another task's",
  schema.properties.taskId.const === analyst.packet.taskId && schema.properties.roleKey.const === analyst.packet.roleKey
    && schema.properties.roleVersion.const === analyst.packet.roleVersion && schema.properties.packetVersion.const === analyst.packet.packetVersion);
t.check("the schema caps claims at the packet's own limit", schema.properties.claims.maxItems === analyst.packet.limits.maximumClaims && analyst.packet.limits.maximumClaims > 0);
t.check("a blind reader's schema permits no segment, no assessment, no disagreement, no adjudication, no decision and no calculation",
  [schema.properties.segments, schema.properties.assessments, schema.properties.disagreements, schema.properties.decisions, schema.properties.calculations].every((n) => n.maxItems === 0)
    && same(schema.properties.adjudication, { type: "null" }));
t.check("a critic's schema permits assessments and no claims; an arbiter's permits an adjudication and no assessments; a composer's permits decisions",
  critic.prompt.schema.properties.assessments.maxItems === undefined && critic.prompt.schema.properties.claims.maxItems === 0
    && arbiter.prompt.schema.properties.adjudication.oneOf !== undefined && arbiter.prompt.schema.properties.assessments.maxItems === 0
    && composer.prompt.schema.properties.decisions.maxItems === undefined);
t.check("the requested-action shape offers exactly the packet's allowed actions, and none where none are allowed",
  same(verifier.prompt.schema.$defs.RequestedAgentAction.properties.actionType.enum, verifier.packet.allowedActions)
    && discoverer.prompt.schema.properties.requestedActions.maxItems === 0
    && discoverer.prompt.schema.$defs.RequestedAgentAction.properties.actionType.enum === undefined);
t.check("a requested action may only name the task it came from, and may not exceed the packet's depth",
  schema.$defs.RequestedAgentAction.properties.parentTaskId.const === analyst.packet.taskId
    && schema.$defs.RequestedAgentAction.properties.currentDepth.maximum === analyst.packet.limits.maximumDepth);

/* ────────────────────────────────────────────────────────── determinism */
t.section("the same packet compiles to the same words");

const again = compilePrompt(analyst.packet, analyst.role);
t.check("compiling one packet twice gives the same system text, the same user text and the same schema",
  again.system === analyst.prompt.system && again.user === analyst.prompt.user && same(again.schema, analyst.prompt.schema));
const cloned = compilePrompt(structuredClone(analyst.packet), analyst.role);
t.check("a deep copy of the packet compiles identically — nothing is read from outside the packet",
  cloned.system === analyst.prompt.system && cloned.user === analyst.prompt.user && same(cloned.schema, analyst.prompt.schema));

const compiledB = B.seen.filter((p) => B.roles.role(p.roleKey).executorKind === "model")
  .map((packet) => compilePrompt(packet, B.roles.role(packet.roleKey)));
const compiledA = compiled.map((c) => c.prompt);
t.check("a second run of the same seed hands out the same packets and compiles them to the same text, byte for byte",
  compiledA.length === compiledB.length && compiledA.length >= 10
    && compiledA.every((p, i) => p.system === compiledB[i].system && p.user === compiledB[i].user && same(p.schema, compiledB[i].schema)),
  `${compiledA.length} prompts in run A, ${compiledB.length} in run B`);

/* ─────────────────────────────────── four judges, four texts, no author */
t.section("a critic, a verifier, an arbiter and a composer read differently and learn nothing about authorship");

const judges = [critic, verifier, arbiter, composer];
const judgeTexts = judges.map((c) => c.text);
t.check("the four texts are four different texts", new Set(judgeTexts).size === 4);
t.check("each names its own role and its own kind", judges.every((c) => c.text.includes(`role: ${c.packet.roleKey}`) && c.text.includes(`kind: ${c.role.kind}`)));
t.check("the four differ in what they may return: assessments, assessments, an adjudication, decisions",
  critic.role.producesAssessments && verifier.role.producesAssessments && arbiter.role.producesAdjudication && composer.role.producesDecisions
    && new Set(judges.map((c) => c.text.split("── the rules ──")[0])).size === 4);
t.check("the claims a judge is shown are shown under the letters the packet gave them, never under an id",
  [critic, verifier, arbiter].every((c) => c.packet.context.claims.length > 0
    && c.packet.context.claims.every((claim) => /^[A-Z]{1,3}$/.test(claim.ref) && c.text.includes(`claim ${claim.ref}\n`))));
t.check("the three anonymised judges are told no claim id and no attempt id of the record, and nothing about who read",
  [critic, verifier, arbiter].every((c) => authorshipHit(c.text).length === 0
    && ![...A.claimIds].some((id) => c.text.includes(id))
    && ![...A.attemptIds].some((id) => c.text.includes(id))));
t.check("the arbiter is shown the verifier's assessments and the contested subject, and is told no assessor and no count of its own",
  arbiter.packet.context.assessments.length === 2 && arbiter.packet.context.disagreements.length === 1
    && arbiter.packet.context.assessments.every((a) => arbiter.text.includes(`assessment of claim ${a.claimRef}: ${a.assessment}`))
    && arbiter.text.includes(`contested subject ${arbiter.packet.context.disagreements[0].disagreementId}`)
    && authorshipHit(arbiter.text).length === 0
    && majorityWords(arbiter.text).every((w) => majorityWords(arbiter.packet.objective).includes(w)));
t.check("the composer is shown only the accepted claims its packet carried, each under the id the packet used, and no id the packet lacks",
  composer.packet.context.claims.length > 0 && composer.packet.context.claims.every((c) => c.status === "accepted" && composer.text.includes(`claim ${c.ref}`))
    && authorshipHit(composer.text).length === 0 && uuidsOutsideThePacket(composer).length === 0
    && ![...A.attemptIds].some((id) => composer.text.includes(id)));
t.check("no judge's text carries a reading the record holds but its own packet does not",
  judges.every((c) => {
    const own = packetText(c.packet);
    return readerPhrases.filter((w) => !own.includes(w)).every((w) => !carriesPhrase(c.text, w));
  }),
  judges.map((c) => `${c.packet.roleKey}:${readerPhrases.filter((w) => !packetText(c.packet).includes(w) && carriesPhrase(c.text, w)).join("/")}`).filter((s) => !s.endsWith(":")).join(" ") || "none");

/* ─────────────────────────────────────────────────────────────── network */
t.section("identity");
t.check("the network was never touched", tripped() === 0, `${tripped()} attempts`);

t.finish();
