/* WHAT THE WORK IS ACTUALLY FOR: TWO THINGS, COMPARED.
 *
 * A reader handed one page can say what is on it. The four things this suite
 * holds the product to are the four it could not do before pairs existed:
 *
 *   1  two sheets of one set that CONTRADICT each other, found from the pages'
 *      own text, with both lines quoted;
 *   2  a sampled frame that does NOT match the sheet it was read against, and
 *      one that does — from the same clip, in the same run;
 *   3  two readers agreeing while the check never finished: CONFIRMED IS
 *      EMPTY. Agreement is not acceptance;
 *   4  a run whose chain of passes is lost with no browser open, continued by
 *      the watchdog rather than by somebody opening a page.
 *
 * Real PostgreSQL with every migration, real Chromium opening the real
 * fixtures, and a local stand-in that answers only from the material in front
 * of it. Nothing is answered by fixture id.
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { harness } from "../../core-v2/tests/harness.mjs";
import { withThrowawayDatabase } from "../../core-v2/tests/postgres-harness.mjs";
import { LocalProviderTransport } from "../../core-v2-runtime/providers/local-answers.ts";
import { NetworkNotAuthorized } from "../../core-v2-runtime/transport/transport.ts";
import { answerFromRequest } from "../../core-v2-runtime/local-agent/reading-agent.ts";
import { SourceDocumentsPack } from "../../core-v2/domains/source-documents/pack.ts";
import { manifestOfAnalysis, readAnalysis, workflowIdForAnalysis } from "../analysis.ts";
import { decidePairing, sheetCodesIn } from "../pairing.ts";
import { questionFor } from "../world.ts";
import { invocationClock } from "../clock.ts";
import { PostgresContinuationStore } from "../continuations.ts";
import { startFromManifest } from "../start.ts";
import { tickOnce } from "../tick.ts";
import { isComparisonSubject, sectionFor } from "../sections.ts";
import { openBench, preparePdfInBrowser, prepareVideoInBrowser, REPO_ROOT } from "../../../studio/tests/analysis-browser.mjs";

let reachedOut = 0;
{
  const refuse = (door) => function () { reachedOut++; throw new Error(`this suite may not reach ${door}`); };
  const seal = (target, name, door) => {
    if (!(name in target)) return;
    const original = target[name];
    Object.defineProperty(target, name, {
      value: function (...args) {
        const address = String(args[0]?.url ?? args[0] ?? "");
        if (/^(https?:\/\/)?(127\.0\.0\.1|localhost)([:/]|$)/.test(address) || address.startsWith("/")) {
          return original.apply(this, args);
        }
        return refuse(door).apply(this, args);
      },
      writable: false, configurable: false, enumerable: true,
    });
  };
  seal(globalThis, "fetch", "fetch");
  seal(http, "request", "http.request"); seal(http, "get", "http.get");
  seal(https, "request", "https.request"); seal(https, "get", "https.get");
  seal(tls, "connect", "tls.connect");
}

const t = harness("two things, compared");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const n = (rows) => Number(rows[0].n);

/* ─────────────────────────────────────────── the operator, the gates, storage */

const CAPABLE = { forcedToolChoice: true, strictSchema: true, images: true, thinking: "none" };
function declaration() {
  const provider = (id, host, model, variable) => ({
    providerId: id, baseUrl: `https://${host}`, apiKeyEnvironmentVariable: variable,
    models: [model], defaultModel: model,
    maximumInputTokens: 60_000, maximumOutputTokens: 4_096, requestTimeoutMs: 30_000,
    maximumMaterialBytes: 512 * 1024, maximumMaterialBytesPerItem: 256 * 1024,
    supportedMediaTypes: ["text/plain; charset=utf-8", "image/png"],
    capabilities: { [model]: { ...CAPABLE } },
  });
  const price = (id, model) => ({
    providerId: id, model, effectiveFrom: "2026-01-01", currency: "USD",
    inputPerMillionTokens: 1, outputPerMillionTokens: 5, cacheWritePerMillionTokens: 1.25,
  });
  return JSON.stringify({
    declaredBy: "an operator under test", declaredAt: "2026-09-09",
    providers: [
      provider("anthropic", "alpha.operator-under-test.net", "operator-model-a", "OPERATOR_KEY_A"),
      provider("openai", "beta.operator-under-test.net", "operator-model-b", "OPERATOR_KEY_B"),
      provider("google", "gamma.operator-under-test.net", "operator-model-c", "OPERATOR_KEY_C"),
    ],
    pricing: [price("anthropic", "operator-model-a"), price("openai", "operator-model-b"), price("google", "operator-model-c")],
    roles: { readerA: "anthropic", readerB: "openai", critic: "google" },
    routing: {
      "reader-family-one": "anthropic", "reader-family-two": "openai",
      "critic-family-one": "google", "arbiter-family-one": "google",
    },
  });
}
const ENVIRONMENT = {
  CORE_V2_RUNNER_REGISTRY: declaration(),
  CORE_V2_RUNNER_CONCURRENT_ATTEMPTS: "6",
  OPERATOR_KEY_A: "not-a-key-and-never-sent-a",
  OPERATOR_KEY_B: "not-a-key-and-never-sent-b",
  OPERATOR_KEY_C: "not-a-key-and-never-sent-c",
};
const gates = { networkFlag: true, environment: (name) => ENVIRONMENT[name] };
const LIFE = { lifetimeMs: 60_000, safetyMs: 500, answerWithinMs: 10_000, settlementRoomMs: 1_000, graceMs: 1_000 };

const store = fs.mkdtempSync(path.join(os.tmpdir(), "mdai-compare-"));
const safe = (p) => path.join(store, p.replace(/[^A-Za-z0-9._/-]/g, "_"));
const put = (p, bytes) => { fs.mkdirSync(path.dirname(safe(p)), { recursive: true }); fs.writeFileSync(safe(p), bytes); };
const readObject = async (p) => {
  if (!fs.existsSync(safe(p))) throw new Error(`no object at ${p}`);
  return new Uint8Array(fs.readFileSync(safe(p)));
};

/* The wire, answered locally. `refuse` is how a proof makes one role fail
   without touching anything else: the critic that never comes back. */
function sealedTransport(seen, refuse = () => false) {
  return () => new LocalProviderTransport({
    onRequest: (question) => {
      const text = question.parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n");
      seen?.push({
        providerId: question.providerId,
        subject: (text.match(/^subject: (\S+)$/m) ?? [])[1] ?? null,
        role: (text.match(/^roleKey: (\S+)$/m) ?? [])[1] ?? null,
        materialCount: [...text.matchAll(/^ {2}material \d+ — .*$/gm)].length,
        hashes: [...text.matchAll(/^ {4}contentHash: (\S+)$/gm)].map((m) => m[1]),
        text,
      });
    },
    answer: (question) => {
      const text = question.parts.find((p) => p.kind === "text" && p.text.includes("roleKey: "));
      const role = text ? (text.text.match(/^roleKey: (\S+)$/m) ?? [])[1] : null;
      if (refuse(role)) return new Error("this executor is not answering in this proof");
      try { return answerFromRequest(question); }
      catch (error) { return new Error(`the stand-in could not answer: ${error.message}`); }
    },
  });
}

function tickVia(client, options = {}) {
  const clock = invocationClock({ ...LIFE, ...(options.life ?? {}) });
  const startedAt = options.startedAt ?? Date.now();
  return tickOnce({
    runner: options.runner ?? "core-v2-runner-tick",
    client, store: new PostgresContinuationStore(client), clock, gates,
    transport: options.transport ?? sealedTransport(),
    readObject, startedAt,
    deadlineAt: options.deadlineAt ?? (startedAt + clock.deadlineMs),
  });
}
const dueNow = (client, id) => client.query(
  `update public.workflow_continuations set due_at = now() - interval '1 minute' where workflow_id = $1`, [id]);

/* ───────────────────────────────────────────────────── seeding an analysis */

async function seedAnalysis(client, organizationId, { title, questionKind, question, files, pairing = {} }) {
  const run = await client.query(
    `insert into public.analysis_runs(organization_id, title, question_kind, question, state, pairing)
     values ($1::uuid, $2, $3, $4, 'ready', $5::jsonb) returning id::text as id`,
    [organizationId, title, questionKind, question, JSON.stringify(pairing)]);
  const analysisId = run.rows[0].id;
  for (const file of files) {
    const storagePath = `${organizationId}/analysis/${analysisId}/${file.ordinal}-source${file.extension}`;
    put(storagePath, file.originalBytes);
    const row = await client.query(
      `insert into public.analysis_files(analysis_id, organization_id, ordinal, kind, file_name,
         media_type, byte_size, storage_path, upload_state, probe, preparation_state, prepared_units, total_units)
       values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, 'stored', $9::jsonb, 'prepared', $10, $10)
       returning id::text as id`,
      [analysisId, organizationId, file.ordinal, file.kind, file.name, file.mediaType,
       file.originalBytes.length, storagePath, JSON.stringify(file.probe ?? {}), file.parts.length]);
    const fileId = row.rows[0].id;
    for (const part of file.parts) {
      let partPath = null;
      if (part.bytes) {
        partPath = `${organizationId}/analysis/${analysisId}/${file.ordinal}/${part.partKind}-${part.ordinal}.png`;
        put(partPath, part.bytes);
      }
      await client.query(
        `insert into public.analysis_parts(analysis_id, file_id, organization_id, part_kind, ordinal,
           storage_path, inline_text, media_type, byte_size, content_sha256, locator)
         values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [analysisId, fileId, organizationId, part.partKind, part.ordinal, partPath,
         part.text ?? null, part.mediaType, part.byteSize, part.contentHash, JSON.stringify(part.locator)]);
    }
  }
  return analysisId;
}

function pdfFile(ordinal, name, originalBytes, produced) {
  const parts = [];
  for (const page of produced.pages) {
    parts.push({
      partKind: "pdf_page_image", ordinal: page.page, bytes: page.png, mediaType: "image/png",
      byteSize: page.png.length, contentHash: sha(page.png),
      locator: { bbox: [0, 0, 1, 1], page: page.page, pointWidth: page.pointWidth, pointHeight: page.pointHeight,
        pixelWidth: page.pixelWidth, pixelHeight: page.pixelHeight },
    });
    if (page.text) {
      parts.push({
        partKind: "pdf_page_text", ordinal: page.page, text: page.text,
        mediaType: "text/plain; charset=utf-8", byteSize: Buffer.byteLength(page.text),
        contentHash: sha(Buffer.from(page.text, "utf8")), locator: { page: page.page, kind: "text" },
      });
    }
  }
  return { ordinal, kind: "pdf", name, extension: ".pdf", mediaType: "application/pdf",
    originalBytes, probe: produced.probe, parts };
}

function videoFile(ordinal, name, originalBytes, produced) {
  const parts = produced.frames.map((frame) => ({
    partKind: "video_frame", ordinal: frame.ordinal, bytes: frame.png, mediaType: "image/png",
    byteSize: frame.png.length, contentHash: sha(frame.png),
    locator: {
      bbox: [0, 0, 1, 1],
      start_ms: Math.round(frame.actualSeconds * 1000), end_ms: Math.round(frame.actualSeconds * 1000),
      seconds: frame.actualSeconds, requestedSeconds: frame.requestedSeconds,
    },
  }));
  return { ordinal, kind: "video", name, extension: ".webm", mediaType: "video/webm",
    originalBytes, probe: produced.probe, parts };
}

/* The same three steps the door takes: decide the pairs, build the manifest
   over them, start the workflow in one commit. */
async function startAnalysis(client, organizationId, analysisId) {
  const analysis = await readAnalysis(client, analysisId);
  const pairing = decidePairing(analysis, analysis.chosenPairing, { maximumPairs: 120 });
  const manifest = manifestOfAnalysis(analysis, workflowIdForAnalysis(analysisId), pairing);
  const pack = new SourceDocumentsPack({ question: questionFor(analysis), pairs: pairing.pairs });
  const created = await startFromManifest({
    client, organizationId, manifest, pack,
    alongside: async (tx, workflowId) => {
      await tx.query(
        `update public.analysis_runs set workflow_id = $2::uuid, authorized_usd = 5,
            run_requested_at = now(), state = 'running' where id = $1::uuid`, [analysisId, workflowId]);
    },
  });
  return { ...created, pairing };
}

/* Passes until the workflow is over or the record says it wants no more. A
   pass that claims nothing is not the end of the story: a workflow whose
   sources have just been ingested is expanded on the NEXT pass, and stopping
   at the first quiet one leaves an analysis that never began. */
/* KEEP TICKING UNTIL THE RECORD IS FINISHED WITH IT, AND SAY SO IF IT IS NOT.
 *
 * This used to stop after twelve passes and return quietly, which made a
 * machine that was merely SLOW look like an engine that was wrong: the run
 * would be half done, and five assertions downstream would report missing
 * readings without one of them saying "it never got that far". That is the
 * failure this repository has a rule about — a cap that truncates silently
 * reads as "covered everything" when it did not.
 *
 * So the cap is a safety net rather than a schedule. What ends the loop is
 * the record: a settled continuation or a terminal workflow. What ends it
 * otherwise is a run of passes that moved NOTHING, which is the engine's own
 * definition of stuck rather than a guess at how many passes enough is. And
 * exhausting the net is reported, in words, to whoever called. */
async function drain(client, workflowId, options = {}, passes = 40) {
  const attempts = async () => Number((await client.query(
    `select count(*)::text as n from public.agent_attempts where workflow_id = $1`,
    [workflowId])).rows[0].n);

  let quiet = 0;
  let before = await attempts();
  for (let i = 0; i < passes; i += 1) {
    const settled = (await client.query(
      `select state from public.workflow_continuations where workflow_id = $1`, [workflowId])).rows[0];
    const over = (await client.query(
      `select state from public.intelligence_workflows where id = $1`, [workflowId])).rows[0];
    if (String(settled?.state) === "settled") return { finished: true, why: "the record settled it", passes: i };
    if (["completed", "partial", "failed", "cancelled"].includes(String(over?.state))) {
      return { finished: true, why: `the workflow reached ${over.state}`, passes: i };
    }
    await dueNow(client, workflowId);
    await tickVia(client, options);

    const after = await attempts();
    quiet = after > before ? 0 : quiet + 1;
    before = after;
    /* Five passes in a row that added no attempt is the same fuse the record
       itself uses. Past that, more passes are not going to help. */
    if (quiet >= 5) return { finished: false, why: `five passes in a row moved nothing (${after} attempts)`, passes: i + 1 };
  }
  return { finished: false, why: `gave up after ${passes} passes with the workflow still unfinished`, passes };
}

/* Everything the screen would arrange, from the record. */
async function sectionsOf(client, workflowId) {
  const claims = (await client.query(
    `select subject_type, subject_key, status, independence_domain, value::text as value
       from public.evidence_claims where workflow_id = $1 and predicate = 'finding' order by subject_key`,
    [workflowId])).rows;
  const verdicts = (await client.query(
    `select c.subject_key, a.assessment from public.claim_assessments a
       join public.evidence_claims c on c.id = a.claim_id where a.workflow_id = $1`, [workflowId])).rows;
  const decisions = (await client.query(
    `select subject_key, decision_type, status from public.decisions where workflow_id = $1`, [workflowId])).rows;
  const tasks = (await client.query(
    `select subject_key, state from public.workflow_tasks where workflow_id = $1 and subject_key <> ''`,
    [workflowId])).rows;

  /* The same two rules the door applies: the ingest's own subject is not a
     finding, and a subject that extends another is that other one. */
  const taskKeys = tasks.map((r) => String(r.subject_key)).filter((k) => !k.startsWith("source:"));
  const placeOf = (key) => taskKeys.filter((other) => other !== key && key.startsWith(`${other}/`))
    .sort((a, b) => b.length - a.length)[0] ?? key;

  const subjects = new Map();
  const slot = (raw) => {
    const key = placeOf(String(raw));
    const found = subjects.get(key) ?? {
      readings: [], reviews: [], decisions: [], taskStates: [], comparison: isComparisonSubject(key),
    };
    subjects.set(key, found);
    return found;
  };
  for (const row of tasks) {
    if (String(row.subject_key).startsWith("source:")) continue;
    slot(row.subject_key).taskStates.push(String(row.state));
  }
  for (const row of claims) {
    slot(row.subject_key).readings.push({
      value: JSON.parse(String(row.value)),
      independenceDomain: row.independence_domain, status: String(row.status),
    });
  }
  for (const row of verdicts) slot(row.subject_key).reviews.push({ verdict: String(row.assessment) });
  for (const row of decisions) {
    const key = String(row.subject_key ?? "");
    if (!key) continue;
    /* THE SAME RULE, AT THE THIRD DOOR A SUBJECT CAN COME IN BY. The ingest's
       statement about a file's bytes is filtered out of the tasks and out of
       the claims, and it walks in here as a DECISION. This helper used to
       drop such a decision on the floor — it only ever attached to a slot
       that already existed — and so it agreed with itself while the shipping
       door put `source:1` under Confirmed. What follows is the door's own
       shape, fallback included, so the two cannot drift apart again. */
    if (key.startsWith("source:")) continue;
    const owner = subjects.has(key)
      ? key
      : [...subjects.keys()].filter((x) => key.startsWith(`${x}/`)).sort((a, b) => b.length - a.length)[0] ?? key;
    slot(owner).decisions.push({ type: String(row.decision_type), status: String(row.status) });
  }
  const placed = new Map();
  for (const [key, shape] of subjects) placed.set(key, sectionFor(shape));
  return { placed, subjects };
}

/* ════════════════════════════════════════════════════════════════════════ */

const bench = await openBench();
let material;
try {
  const read = (name) => fs.readFileSync(path.join(REPO_ROOT, "studio/tests/fixtures/analysis", name));
  material = {
    plans: { bytes: read("plan-set.pdf"), made: await preparePdfInBrowser(bench, "plan-set.pdf") },
    corridor: { bytes: read("corridor-plan.pdf"), made: await preparePdfInBrowser(bench, "corridor-plan.pdf") },
    clip: { bytes: read("walkthrough.webm"), made: await prepareVideoInBrowser(bench, "walkthrough.webm", "video") },
  };
} finally {
  await bench.close();
}

t.section("the sheets say which sheets they are about");
{
  const codes = material.plans.made.pages.map((p) => sheetCodesIn(p.text));
  t.check("every sheet carries its own number, read out of the page's own text",
    codes[0][0] === "A-101" && codes[1][0] === "A-102" && codes[2][0] === "A-501",
    codes.map((c, i) => `p${i + 1}: ${c.join(" ")}`).join(" · "));
  t.check("and two of them name a third, which is the correspondence nobody had to invent",
    codes[0].includes("A-501") && codes[1].includes("A-501"));
}

await withThrowawayDatabase(async ({ client, organizationId }) => {

  /* ═══════════════════════════════════════════════════════════════════════ */
  t.section("(1) two sheets that contradict each other");

  const planSet = pdfFile(1, "plan-set.pdf", material.plans.bytes, material.plans.made);
  const consistency = await seedAnalysis(client, organizationId, {
    title: "Does this set agree with itself?", questionKind: "plan_consistency",
    question: "Do these two sheets state the same ceiling height?",
    files: [planSet],
  });
  const first = await startAnalysis(client, organizationId, consistency);

  t.check("the pairs came from the sheets themselves, not from a guess",
    first.pairing.pairs.length === 2 && first.pairing.pairs.every((p) => p.kind === "pages"),
    first.pairing.pairs.map((p) => `${p.a.ordinal}↔${p.b.ordinal} (${p.why})`).join(" · "));
  t.check("no sheet was left without a partner", first.pairing.unpaired.length === 0);

  const seen = [];
  const firstRun = await drain(client, first.workflowId, { transport: sealedTransport(seen) });
  t.check("the run finished rather than running out of passes", firstRun.finished, firstRun.why);

  const pairReadings = seen.filter((r) => r.role === "page_pair_reader");
  t.check("every pair was read twice, and each reading was given BOTH sheets",
    pairReadings.length === 4 && pairReadings.every((r) => r.materialCount >= 2),
    pairReadings.map((r) => `${r.subject} ${r.materialCount} pieces`).join(" · "));
  const bySubject = new Map();
  for (const r of pairReadings) bySubject.set(r.subject, [...(bySubject.get(r.subject) ?? []), r]);
  t.check("both blind readers of a pair were given the SAME two pieces of material",
    [...bySubject.values()].every((rs) => rs.length === 2
      && JSON.stringify([...rs[0].hashes].sort()) === JSON.stringify([...rs[1].hashes].sort())),
    [...bySubject.entries()].map(([k, rs]) => `${k}: ${rs.length}`).join(" · "));
  t.check("and by two different providers",
    [...bySubject.values()].every((rs) => new Set(rs.map((r) => r.providerId)).size === 2));

  const said = (await client.query(
    `select c.subject_key, c.value->>'text' as answer, an.quoted_text
       from public.evidence_claims c
       join public.evidence_anchors an on an.claim_id = c.id
      where c.workflow_id = $1 and c.predicate = 'finding' order by c.subject_key`, [first.workflowId])).rows;
  const disagreeing = said.filter((r) => r.answer === "no");
  t.check("the pair that disagrees was answered no", disagreeing.length > 0,
    [...new Set(said.map((r) => `${r.subject_key}=${r.answer}`))].join(" · "));
  const quotes = disagreeing.map((r) => String(r.quoted_text));
  t.check("and BOTH contradicting lines are quoted, verbatim, out of the owner's own file",
    quotes.some((q) => /CEILING HEIGHT 2700/.test(q)) && quotes.some((q) => /CEILING HEIGHT 2400/.test(q)),
    [...new Set(quotes)].join(" | ").slice(0, 160));

  const consistencySections = await sectionsOf(client, first.workflowId);
  const contradicted = [...consistencySections.placed.entries()].filter(([, where]) => where === "discrepancy");
  t.check("the screen puts that pair under Discrepancy found",
    contradicted.length >= 1 && contradicted.every(([key]) => key.startsWith("pages/")),
    [...consistencySections.placed.entries()].map(([k, v]) => `${k}=${v}`).join(" · "));

  /* ═══════════════════════════════════════════════════════════════════════ */
  t.section("(2) a frame that does not match the sheet it was read against");

  const corridor = pdfFile(1, "corridor-plan.pdf", material.corridor.bytes, material.corridor.made);
  const clip = videoFile(2, "walkthrough.webm", material.clip.bytes, material.clip.made);
  const against = await seedAnalysis(client, organizationId, {
    title: "Does the walkthrough match the corridor sheet?", questionKind: "video_against_plans",
    question: "Is the red extinguisher cabinet the sheet calls for visible in this moment?",
    files: [corridor, clip],
  });
  const second = await startAnalysis(client, organizationId, against);
  t.check("every sampled moment was paired with the one sheet in the analysis",
    second.pairing.pairs.length === 5 && second.pairing.pairs.every((p) => p.kind === "moment_page"),
    second.pairing.note);

  const watched = [];
  const secondRun = await drain(client, second.workflowId, { transport: sealedTransport(watched) });
  t.check("the run finished rather than running out of passes", secondRun.finished, secondRun.why);

  const momentReadings = watched.filter((r) => r.role === "moment_page_reader");
  t.check("each moment was read against the sheet, twice, with the frame AND the sheet in hand",
    momentReadings.length === 10 && momentReadings.every((r) => r.materialCount >= 2),
    `${momentReadings.length} readings`);

  /* What the record SETTLED on for each moment — the answer the screen shows,
     not every proposal made along the way. */
  const answers = (await client.query(
    `select c.subject_key, c.value->>'text' as answer, count(*)::text as n
       from public.evidence_claims c
      where c.workflow_id = $1 and c.predicate = 'finding'
        and c.status in ('accepted', 'verified')
      group by 1, 2 order by 1`, [second.workflowId])).rows;
  const byMoment = new Map();
  for (const row of answers) byMoment.set(String(row.subject_key), String(row.answer));
  const matching = [...byMoment.entries()].filter(([, a]) => a === "yes");
  const mismatching = [...byMoment.entries()].filter(([, a]) => a === "no");
  t.check("exactly one moment matches the sheet, and it is the one where the thing is really there",
    matching.length === 1 && /^moment\/2\/3\/page\//.test(matching[0][0]),
    [...byMoment.entries()].map(([k, v]) => `${k.split("/").slice(1).join("/")}=${v}`).join(" · "));
  t.check("the other moments do not match it, which is the discrepancy this analysis exists to find",
    mismatching.length === 4);

  const evidence = (await client.query(
    `select an.quoted_text from public.evidence_anchors an
       join public.evidence_claims c on c.id = an.claim_id
      where c.workflow_id = $1 and c.value->>'text' = 'no'
        and c.status in ('accepted', 'verified')`, [second.workflowId])).rows
    .map((r) => String(r.quoted_text));
  t.check("a mismatch quotes the line on the sheet AND what was measured in the frame",
    evidence.some((q) => /RED EXTINGUISHER CABINET/.test(q))
    && evidence.some((q) => /% of it red|0\.00% of it red|picture/.test(q)),
    [...new Set(evidence)].slice(0, 2).join(" | ").slice(0, 180));

  const againstSections = await sectionsOf(client, second.workflowId);
  t.check("and the screen puts the mismatching moments under Discrepancy found",
    [...againstSections.placed.entries()].filter(([, where]) => where === "discrepancy").length >= 4,
    [...againstSections.placed.entries()].map(([k, v]) => `${k.split("/").slice(1).join("/")}=${v}`).join(" · "));

  /* ═══════════════════════════════════════════════════════════════════════ */
  t.section("(3) the readers agreed and the check never finished");

  const unchecked = await seedAnalysis(client, organizationId, {
    title: "A run whose critic never came back", questionKind: "plan_consistency",
    question: "Do these two sheets state the same ceiling height?",
    files: [pdfFile(1, "plan-set.pdf", material.plans.bytes, material.plans.made)],
  });
  const third = await startAnalysis(client, organizationId, unchecked);
  const silent = [];
  /* The critic is the only thing that does not answer. Everything else — the
     readers, the comparison, the composer — runs exactly as it always does. */
  await drain(client, third.workflowId, {
    transport: sealedTransport(silent, (role) => role === "evidence_critic" || role === "disagreement_verifier"),
  });

  const readAnyway = silent.filter((r) => r.role === "page_pair_reader");
  t.check("the readers still read, and still agreed with each other", readAnyway.length === 4);
  const statuses = (await client.query(
    `select status, count(*)::text as n from public.evidence_claims
      where workflow_id = $1 and predicate = 'finding' group by 1 order by 1`, [third.workflowId])).rows;
  t.check("their findings stand at corroborated, which is what agreement is",
    statuses.some((r) => String(r.status) === "corroborated"),
    statuses.map((r) => `${r.status}: ${r.n}`).join(" · "));
  t.check("and NOT ONE of them reached accepted",
    !statuses.some((r) => String(r.status) === "accepted" || String(r.status) === "verified"),
    statuses.map((r) => `${r.status}: ${r.n}`).join(" · "));

  const uncheckedSections = await sectionsOf(client, third.workflowId);
  const confirmed = [...uncheckedSections.placed.entries()].filter(([, where]) => where === "confirmed");
  t.check("CONFIRMED IS EMPTY — agreement is not acceptance",
    confirmed.length === 0,
    [...uncheckedSections.placed.entries()].map(([k, v]) => `${k}=${v}`).join(" · "));
  t.check("and the agreed findings are shown as needing a check, which is what they need",
    [...uncheckedSections.placed.values()].some((where) => where === "needsCheck"));

  /* ═══════════════════════════════════════════════════════════════════════ */
  t.section("(4) the chain is lost, and nobody opens a page");

  /* A run big enough that one pass cannot finish it — which is every real
     analysis, and is the only shape in which "what continues it" is a
     question at all. */
  const abandoned = await seedAnalysis(client, organizationId, {
    title: "A run nobody is watching", questionKind: "video_against_plans",
    question: "Is the red extinguisher cabinet the sheet calls for visible in this moment?",
    files: [
      pdfFile(1, "corridor-plan.pdf", material.corridor.bytes, material.corridor.made),
      videoFile(2, "walkthrough.webm", material.clip.bytes, material.clip.made),
    ],
  });
  const fourth = await startAnalysis(client, organizationId, abandoned);

  /* ONE pass runs, in a container whose life runs out part way through — which
     is what an Edge Function pass IS. Then the process that would have knocked
     on the next one dies: no chain, no browser, nothing. The record is all
     that is left. */
  await dueNow(client, fourth.workflowId);
  await tickVia(client, { runner: "the-pass-that-died", deadlineAt: Date.now() + 1500 });

  const stranded = (await client.query(
    `select state, held_by, continuations from public.workflow_continuations where workflow_id = $1`,
    [fourth.workflowId])).rows[0];
  const workflowNow = (await client.query(
    `select state from public.intelligence_workflows where id = $1`, [fourth.workflowId])).rows[0];
  t.check("the workflow is unfinished and the record still says it is owed another pass",
    stranded && stranded.state === "due" && !["completed", "partial", "failed", "cancelled"].includes(String(workflowNow.state)),
    `continuation ${stranded?.state}, workflow ${workflowNow?.state}`);

  const before = n((await client.query(
    `select count(*)::text as n from public.agent_attempts where workflow_id = $1`, [fourth.workflowId])).rows);

  /* Time passes. Nobody opens anything. */
  await client.query(
    `update public.workflow_continuations set due_at = now() - interval '5 minutes' where workflow_id = $1`,
    [fourth.workflowId]);

  const due = (await client.query(`select w from public.core_v2_due_continuations(10) w`)).rows.map((r) => String(r.w));
  t.check("the watchdog's own question finds it, with nobody having pressed anything",
    due.includes(fourth.workflowId), `${due.length} due`);

  /* And the knock the watchdog sends is this tick — the same handler the Edge
     Function runs — so what follows is what an armed watchdog actually
     causes, not a description of it. */
  await tickVia(client, { runner: "core-v2-watchdog" });
  const after = n((await client.query(
    `select count(*)::text as n from public.agent_attempts where workflow_id = $1`, [fourth.workflowId])).rows);
  t.check("the run moved on, without a browser and without the chain",
    after > before, `${before} → ${after} attempts`);

  const fourthRun = await drain(client, fourth.workflowId, { runner: "core-v2-watchdog" });
  t.check("the watchdog carried it to the end rather than running out of passes",
    fourthRun.finished, fourthRun.why);
  const ended = (await client.query(
    `select state from public.intelligence_workflows where id = $1`, [fourth.workflowId])).rows[0];
  t.check("and it reached an end on its own",
    ["completed", "partial", "needs_attention", "failed"].includes(String(ended.state)), String(ended.state));

  const findings = n((await client.query(
    `select count(*)::text as n from public.evidence_claims
      where workflow_id = $1 and predicate = 'finding' and status in ('accepted','verified')`,
    [fourth.workflowId])).rows);
  t.check("with findings the owner can read, produced while nobody was looking", findings > 0, `${findings} settled findings`);

  /* ───────────────────────────────────────────────────────────────────────
     (5) THE DEPLOYMENT IS DORMANT, WHICH IS NOT THE SAME AS BROKEN.

     This repository ships with the paid gates shut, and the transport a real
     deployment builds REFUSES TO EXIST until every authorization is in
     place. The promise the runner makes about that state is written at the
     top of world.ts: the world is still built, the pass still runs, and the
     refusal is what ends up in the record — because a runner that crashes
     when it cannot spend tells an operator nothing.

     It did crash. On the deployed test platform every pass died with
     `unhandled`, the workflow sat at `created` forever, and the watchdog
     re-claimed it every three minutes with nothing to show. This is that,
     reproduced: a transport factory that refuses in exactly the way the real
     one does.  */
  t.section("(5) the deployment cannot spend, and says so instead of dying");
  {
    const dormant = await seedAnalysis(client, organizationId, {
      title: "A deployment with its gates shut", questionKind: "plan_consistency",
      question: "Do these two sheets state the same ceiling height?",
      files: [planSet],
    });
    const fifth = await startAnalysis(client, organizationId, dormant);

    const outcome = await tickVia(client, {
      runner: "core-v2-runner-tick",
      transport: () => {
        throw new NetworkNotAuthorized(
          "core-v2: a transport that can reach a provider may not be built until every authorization is in place",
          ["CORE_V2_ALLOW_PAID_CALLS is not set to true", "no provider network flag on this invocation"]);
      },
    });

    t.check("the pass ran rather than throwing", outcome.kind === "ran", String(outcome.kind));
    t.check("and the workflow left `created` under its own steam",
      outcome.kind === "ran" && outcome.outcome.state !== "created",
      outcome.kind === "ran" ? String(outcome.outcome.state) : "it never ran");

    /* The deterministic work — reading a file into the record — needs no
       provider and still happens. It is the MODEL attempts, the only ones
       that could have cost anything, that must every one be a door that was
       never opened. */
    const refusals = (await client.query(
      `select executor_kind, state, coalesce(error_code, '—') as error_code, count(*)::text as n
         from public.agent_attempts where workflow_id = $1
        group by 1, 2, 3 order by 4 desc`, [fifth.workflowId])).rows;
    const model = refusals.filter((r) => String(r.executor_kind) === "model");
    t.check("every attempt that could have cost anything is written down as a door that was never opened",
      model.length > 0 && model.every((r) =>
        String(r.state) === "failed_known" && String(r.error_code) === "network_not_authorized"),
      refusals.map((r) => `${r.executor_kind}:${r.state}/${r.error_code}×${r.n}`).join(" · ") || "no attempts at all");
    t.check("and the work that needed no provider still happened",
      refusals.some((r) => String(r.executor_kind) !== "model" && String(r.state) === "succeeded"));

    const said = (await client.query(
      `select coalesce(error_message, '') as said from public.agent_attempts
        where workflow_id = $1 and error_message is not null limit 1`, [fifth.workflowId])).rows[0];
    t.check("and it names the authorization that was missing, where an operator reads it",
      Boolean(said) && /CORE_V2_ALLOW_PAID_CALLS|authorization|provider-network/.test(String(said.said)),
      String(said?.said ?? "nothing was written down").slice(0, 160));

    /* AND THE OWNER'S SCREEN DOES NOT OVERSTATE IT. Not one word was read
       about these drawings, so Confirmed has to be empty. The only decision
       this run produced is the ingest's — the bytes are the bytes the
       manifest named — and a bookkeeping fact about a file is not a finding
       about anybody's plans. The shipping door put it under Confirmed. */
    const dormantScreen = await sectionsOf(client, fifth.workflowId);
    const dormantSections = [...dormantScreen.placed.entries()];
    t.check("CONFIRMED IS EMPTY — nothing was read, so nothing is confirmed",
      dormantSections.every(([, section]) => section !== "confirmed"),
      dormantSections.map(([k, v]) => `${k}=${v}`).join(" · ") || "no places at all");
    t.check("and no card is about a file's own bytes",
      dormantSections.every(([key]) => !key.startsWith("source:")),
      dormantSections.map(([k]) => k).join(" · "));
  }

  t.section("nothing left this process");
  t.check("no provider was reached, by anything, at any point", reachedOut === 0, `${reachedOut} attempts`);
});

fs.rmSync(store, { recursive: true, force: true });
t.finish();
