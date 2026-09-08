import { harness, closeNetwork } from "./harness.mjs";
import { simulate } from "../cli.ts";
import { assertPacketRespectsVisibility, forbiddenContent } from "../visibility-policy.ts";
import { roleDefinition } from "../role-registry.ts";

const t = harness("a blind reader is blind");
const tripped = closeNetwork();
const { repo, executors } = await simulate({ quiet: true });
const packets = executors.packetsSeen;

t.section("every packet the engine produced respects the visibility policy");
const broken = packets.map((p) => ({ p, problems: assertPacketRespectsVisibility(p, roleDefinition(p.roleKey)) })).filter((x) => x.problems.length);
t.check(`all ${packets.length} packets pass the visibility check`, broken.length === 0, broken.slice(0, 3).map((b) => `${b.p.roleKey}: ${b.problems.join("; ")}`).join(" | "));
t.check("no packet carries a provider name, a URL, a credential, a cost, or a majority", packets.every((p) => forbiddenContent(p).length === 0));
t.check("no packet fingerprint or source carries a URL", packets.every((p) => !/https?:\/\//.test(JSON.stringify(p.sources)) && !/https?:\/\//.test(p.inputFingerprint)));

t.section("independent extractor B cannot receive extractor A's output");
const readerB = packets.filter((p) => p.independenceGroup === "reader-b");
const readerA = packets.filter((p) => p.independenceGroup === "reader-a");
t.check("reader-b packets exist for every blind subject", readerB.length >= 8, `${readerB.length}`);
t.check("every reader-b packet is marked blind", readerB.every((p) => p.blindContext));
const claimsOfA = new Set([...repo.claims.values()].filter((c) => c.independenceGroup === "reader-a").map((c) => c.claimId));
t.check("no reader-b packet carries a claim made by reader-a", readerB.every((p) => p.context.claims.every((c) => !claimsOfA.has(c.ref))));
t.check("and no reader-b packet carries reader-a's values anywhere in it", readerB.every((p) => !JSON.stringify(p.context).includes('"reader-a"')));
t.check("a reader-b packet carries no assessments, disagreements or validation notes", readerB.every((p) => p.context.assessments.length === 0 && p.context.disagreements.length === 0 && p.context.validation.length === 0));
t.check("a reader-a and reader-b packet for the same subject carry the same sources", readerA.every((a) => {
  const b = readerB.find((x) => x.subjectKey === a.subjectKey && x.taskType === a.taskType);
  return !b || JSON.stringify(a.sources.map((s) => s.contentHash)) === JSON.stringify(b.sources.map((s) => s.contentHash));
}));
t.check("the only claims an extractor sees are those of its declared dependencies (a legend, never a parallel reader)",
  [...readerA, ...readerB].every((p) => { const allowed = new Set(p.dependencies.flatMap((d) => d.claimIds)); return p.context.claims.every((c) => allowed.has(c.ref)); }));

t.section("critics and arbiters see letters, not authors");
const critics = packets.filter((p) => ["verify_disagreement", "verify_claim"].includes(p.taskType));
const arbiters = packets.filter((p) => p.taskType === "adjudicate");
t.check("verifier packets were produced", critics.length > 0, `${critics.length}`);
t.check("arbiter packets were produced", arbiters.length > 0, `${arbiters.length}`);
t.check("every claim in a critic packet is presented as a single letter", critics.every((p) => p.context.claims.every((c) => /^[A-Z]$/.test(c.ref))));
t.check("every claim in an arbiter packet is presented as a single letter", arbiters.every((p) => p.context.claims.every((c) => /^[A-Z]$/.test(c.ref))));
t.check("anonymised claims carry no independence group either", [...critics, ...arbiters].every((p) => p.context.claims.every((c) => c.independenceGroup === null)));
{
  /* Two blind readers of one subject are served by two families — even when
     both were dispatched in the same tick. */
  const familiesBySubject = new Map();
  for (const a of repo.attempts.values()) {
    const task = repo.tasks.get(a.taskId);
    if (!task || task.independenceGroup === null) continue;
    familiesBySubject.set(task.subjectKey, [...(familiesBySubject.get(task.subjectKey) ?? []), a.executorFamily]);
  }
  t.check("every blind pair was read by two different executor families", familiesBySubject.size > 0 && [...familiesBySubject.values()].every((f) => new Set(f).size === f.length), [...familiesBySubject].map(([k, v]) => `${k}: ${v.join("|")}`).join("; "));
  t.check("and the routing never had to record independence as not preserved", !(await repo.listAudit()).some((a) => a.action === "core_v2.routing.independence_not_preserved"));
}
t.check("no critic or arbiter packet names a provider or an executor family", [...critics, ...arbiters].every((p) => !/reader-family|critic-family|arbiter-family|openai|anthropic|google|claude|gemini|gpt/i.test(JSON.stringify(p))));
t.check("a verifier packet carries the disagreement and its disputed sources", critics.filter((p) => p.taskType === "verify_disagreement").every((p) => p.context.disagreements.length === 1 && p.sources.length > 0));
t.check("a verifier packet carries no assessments — it forms its own", critics.every((p) => p.context.assessments.length === 0));
t.check("an arbiter packet carries the assessments, under the same letters", arbiters.every((p) => p.context.assessments.every((a) => p.context.claims.some((c) => c.ref === a.claimRef))));
t.check("an arbiter packet carries no count of who agreed", arbiters.every((p) => !/majority|votes|agree/i.test(JSON.stringify(p.context.validation))));
t.check("no network call was attempted", tripped() === 0);
t.finish();
