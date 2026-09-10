/* AN OWNER'S OWN FILES, ALL THE WAY THROUGH.
 *
 * The eight things this has to be able to say, and does, against a real
 * PostgreSQL cluster with every migration applied and a real browser that
 * opened the real files:
 *
 *   1  the material is stored server-side and read back from where it was put
 *   2  pages and frames come out of the actual bytes
 *   3  the right fragment reaches the right agent, and only that fragment
 *   4  two readings are independent — neither can see the other's answer —
 *      and the claim is checked against the source
 *   5  a result opens on the page or the moment it came from
 *   6  a reload continues the same workflow rather than starting a second one
 *   7  a stop stops new work and says honestly what was already sent
 *   8  two analyses at once do not mix
 *
 * and the ninth, which is the one that makes the rest mean anything: changing
 * the source file changes the material the agents are given.
 *
 * NOTHING IS ANSWERED BY FIXTURE ID. Every reading is produced by the real
 * adapters from the real packet by a local stand-in that only sees the request
 * — it has no idea which test is running — and every hash checked here is the
 * SHA-256 of bytes this run produced.
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
import { answerFromRequest } from "../../core-v2-runtime/local-agent/reading-agent.ts";
import { SourceDocumentsPack } from "../../core-v2/domains/source-documents/pack.ts";
import { manifestOfAnalysis, readAnalysis, workflowIdForAnalysis } from "../analysis.ts";
import { questionFor } from "../world.ts";
import { invocationClock } from "../clock.ts";
import { PostgresContinuationStore } from "../continuations.ts";
import { startFromManifest } from "../start.ts";
import { tickOnce } from "../tick.ts";
import { sectionFor } from "../sections.ts";
import { openBench, preparePdfInBrowser, prepareVideoInBrowser, REPO_ROOT } from "../../../studio/tests/analysis-browser.mjs";

/* The doors a provider could be reached through, sealed. The unix socket the
   wire client uses is left open, exactly as in handlers.mjs, and the browser
   runs in its own process against a loopback server of our own. */
let reachedOut = 0;
{
  const refuse = (door) => function () { reachedOut++; throw new Error(`this suite may not reach ${door}`); };
  const seal = (target, name, door) => {
    if (!(name in target)) return;
    const original = target[name];
    Object.defineProperty(target, name, {
      value: function (...args) {
        /* Playwright and the loopback file server are this process talking to
           itself; a provider is not. Anything that is not 127.0.0.1 is a
           failure of the run. */
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

const t = harness("an owner's own files, all the way through");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const n = (rows) => Number(rows[0].n);

/* ───────────────────────────────── the operator's declaration, and the gates */

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

/* ───────────────────────────────────────── storage, on disk, read by hash-free path */

const store = fs.mkdtempSync(path.join(os.tmpdir(), "mdai-store-"));
const put = (storagePath, bytes) => {
  const file = path.join(store, storagePath.replace(/[^A-Za-z0-9._/-]/g, "_"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};
let objectReads = 0;
const readObject = async (storagePath) => {
  objectReads += 1;
  const file = path.join(store, storagePath.replace(/[^A-Za-z0-9._/-]/g, "_"));
  if (!fs.existsSync(file)) throw new Error(`no object at ${storagePath}`);
  return new Uint8Array(fs.readFileSync(file));
};

/* ─────────────────────────────────────────────────── the wire, answered locally */

function sealedTransport(seen) {
  return () => new LocalProviderTransport({
    onRequest: (question) => {
      if (!seen) return;
      /* Material is not "the parts that are not text": a page's own text IS
         material and arrives as a text part. What marks a part as material is
         the heading the compiler writes above it, so that is what is counted
         — and the hash in that heading is what is checked. */
      const text = question.parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n");
      const headings = [...text.matchAll(/^ {2}material \d+ — .*$/gm)].map((m) => m[0]);
      const hashes = [...text.matchAll(/^ {4}contentHash: (\S+)$/gm)].map((m) => m[1]);
      seen.push({
        providerId: question.providerId,
        taskId: (text.match(/^taskId: (\S+)$/m) ?? [])[1] ?? null,
        subject: (text.match(/^subject: (\S+)$/m) ?? [])[1] ?? null,
        role: (text.match(/^roleKey: (\S+)$/m) ?? [])[1] ?? null,
        text,
        materialHashes: hashes,
        materialCount: headings.length,
        pictureCount: question.parts.filter((p) => p.kind !== "text").length,
      });
    },
    answer: (question) => {
      try { return answerFromRequest(question); }
      catch (error) { return new Error(`the stand-in could not answer: ${error.message}`); }
    },
  });
}

function tickVia(client, options = {}) {
  const clock = invocationClock({ ...LIFE, ...(options.life ?? {}) });
  const startedAt = options.startedAt ?? Date.now();
  return tickOnce({
    runner: "core-v2-runner-tick",
    client,
    store: new PostgresContinuationStore(client),
    clock, gates,
    transport: options.transport ?? sealedTransport(),
    readObject,
    startedAt,
    deadlineAt: options.deadlineAt ?? (startedAt + clock.deadlineMs),
  });
}

const dueNow = (client, id) => client.query(
  `update public.workflow_continuations set due_at = now() - interval '1 minute' where workflow_id = $1`, [id]);

/* ─────────────────────────────────────────────────────── seeding an analysis */

async function seedAnalysis(client, organizationId, { title, questionKind, question, files }) {
  const run = await client.query(
    `insert into public.analysis_runs(organization_id, title, question_kind, question, state)
     values ($1::uuid, $2, $3, $4, 'ready') returning id::text as id`,
    [organizationId, title, questionKind, question]);
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

/* Turns what the browser produced into the rows the record holds. */
function pdfFile(ordinal, name, originalBytes, produced) {
  const parts = [];
  for (const page of produced.pages) {
    parts.push({
      partKind: "pdf_page_image", ordinal: page.page, bytes: page.png, mediaType: "image/png",
      byteSize: page.png.length, contentHash: sha(page.png),
      locator: {
        bbox: [0, 0, 1, 1], page: page.page,
        pointWidth: page.pointWidth, pointHeight: page.pointHeight,
        pixelWidth: page.pixelWidth, pixelHeight: page.pixelHeight,
      },
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

function videoFile(ordinal, name, originalBytes, produced, kind = "video") {
  const parts = produced.frames.map((frame) => ({
    partKind: "video_frame", ordinal: frame.ordinal, bytes: frame.png, mediaType: "image/png",
    byteSize: frame.png.length, contentHash: sha(frame.png),
    locator: {
      bbox: [0, 0, 1, 1],
      start_ms: Math.round(frame.actualSeconds * 1000),
      end_ms: Math.round(frame.actualSeconds * 1000),
      seconds: frame.actualSeconds, requestedSeconds: frame.requestedSeconds,
      pixelWidth: frame.pixelWidth, pixelHeight: frame.pixelHeight,
      equirectangular: kind === "video360",
    },
  }));
  return { ordinal, kind, name, extension: ".webm", mediaType: "video/webm",
    originalBytes, probe: produced.probe, parts };
}

async function startAnalysis(client, organizationId, analysisId, authorizedUsd = 5) {
  const analysis = await readAnalysis(client, analysisId);
  const manifest = manifestOfAnalysis(analysis, workflowIdForAnalysis(analysisId));
  const pack = new SourceDocumentsPack({ question: questionFor(analysis) });
  return await startFromManifest({
    client, organizationId, manifest, pack,
    alongside: async (tx, workflowId) => {
      await tx.query(
        `update public.analysis_runs set workflow_id = $2::uuid, authorized_usd = $3::numeric,
            run_requested_at = now(), state = 'running' where id = $1::uuid`,
        [analysisId, workflowId, authorizedUsd]);
    },
  });
}

/* ════════════════════════════════════════════════════════════════════════ */

const bench = await openBench();
let material;
try {
  const plansPdf = fs.readFileSync(path.join(REPO_ROOT, "studio/tests/fixtures/analysis/plan-set.pdf"));
  const scanPdf = fs.readFileSync(path.join(REPO_ROOT, "studio/tests/fixtures/analysis/scan-set.pdf"));
  const clipBytes = fs.readFileSync(path.join(REPO_ROOT, "studio/tests/fixtures/analysis/walkthrough.webm"));
  material = {
    plans: { bytes: plansPdf, made: await preparePdfInBrowser(bench, "plan-set.pdf") },
    scan: { bytes: scanPdf, made: await preparePdfInBrowser(bench, "scan-set.pdf") },
    clip: { bytes: clipBytes, made: await prepareVideoInBrowser(bench, "walkthrough.webm", "video") },
  };
} finally {
  await bench.close();
}

t.section("(1 and 2) the material is what came out of the files");
t.check("the plan set produced one image per page, from the file's own bytes",
  material.plans.made.pages.length === 3 && material.plans.made.pages.every((p) => p.png.length > 4000),
  material.plans.made.pages.map((p) => `p${p.page} ${p.png.length}B`).join(" · "));
t.check("the clip produced frames at the seconds the decoder landed on",
  material.clip.made.frames.length === 5,
  material.clip.made.frames.map((f) => `${f.actualSeconds}s`).join(", "));
t.check("every piece has a different hash — nothing is a copy of anything",
  new Set([...material.plans.made.pages.map((p) => sha(p.png)),
           ...material.clip.made.frames.map((f) => sha(f.png))]).size === 8);

await withThrowawayDatabase(async ({ client, organizationId }) => {

  /* ═══════════════════════════════════════════════════════════════════════ */
  t.section("(3) the right fragment reaches the right agent");

  const planFile = pdfFile(1, "plan-set.pdf", material.plans.bytes, material.plans.made);
  const clipFile = videoFile(2, "walkthrough.webm", material.clip.bytes, material.clip.made);
  /* "Check one thing" is the question that IS about each place on its own —
     every page and every sampled moment answered against one question. The
     comparison kinds, which pair two pieces of material, are the subject of
     tests/comparison.mjs next door. */
  const first = await seedAnalysis(client, organizationId, {
    title: "Riverside level 2", questionKind: "specific_question",
    question: "Is a smoke detector shown in every bedroom?",
    files: [planFile, clipFile],
  });
  const started = await startAnalysis(client, organizationId, first);

  const seen = [];
  await dueNow(client, started.workflowId);
  let pass = await tickVia(client, { transport: sealedTransport(seen) });
  for (let i = 0; i < 6 && seen.length < 16; i += 1) {
    await dueNow(client, started.workflowId);
    pass = await tickVia(client, { transport: sealedTransport(seen) });
  }

  t.check("the material was fetched from storage rather than from the record",
    objectReads > 0, `${objectReads} objects read back`);

  const byHash = new Map();
  for (const part of [...planFile.parts, ...clipFile.parts]) byHash.set(part.contentHash, part);
  const readings = seen.filter((r) => r.role === "page_reader" || r.role === "moment_reader");
  t.check("every reading was given material, and every piece of it is a piece of these files",
    readings.length > 0 && readings.every((r) => r.materialCount > 0 && r.materialHashes.every((hash) => byHash.has(hash))),
    `${readings.length} readings; ${readings.reduce((total, r) => total + r.materialCount, 0)} pieces of material`);

  const wrongFragment = readings.filter((r) => {
    const [kind, , ordinal] = String(r.subject || "").split("/");
    return r.materialHashes.some((hash) => {
      const part = byHash.get(hash);
      if (!part) return true;
      if (kind === "page") return part.ordinal !== Number(ordinal) || !part.partKind.startsWith("pdf_page");
      return part.ordinal !== Number(ordinal) || part.partKind !== "video_frame";
    });
  });
  t.check("and it is the piece its own assignment names — never a neighbouring page or moment",
    wrongFragment.length === 0,
    wrongFragment.slice(0, 2).map((r) => `${r.subject} got something else`).join(" · "));

  const pageReadings = readings.filter((r) => r.role === "page_reader");
  t.check("a page reader is given the page image AND the page's own text where the file carried one",
    pageReadings.length > 0 && pageReadings.every((r) => r.materialCount === 2 && r.pictureCount === 1),
    pageReadings.map((r) => `${r.materialCount} pieces, ${r.pictureCount} of them pictures`).join(" · "));

  /* ═══════════════════════════════════════════════════════════════════════ */
  t.section("(4) two readings, independent, then checked against the source");

  const bySubject = new Map();
  for (const reading of readings) {
    const list = bySubject.get(reading.subject) ?? [];
    list.push(reading);
    bySubject.set(reading.subject, list);
  }
  const twoEach = [...bySubject.values()].filter((list) => list.length >= 2);
  t.check("each place was read twice", twoEach.length === bySubject.size && bySubject.size > 0,
    `${twoEach.length} of ${bySubject.size} subjects read twice`);
  t.check("by two different providers",
    twoEach.every((list) => new Set(list.map((r) => r.providerId)).size >= 2),
    twoEach.slice(0, 2).map((list) => list.map((r) => r.providerId).join("+")).join(" · "));

  /* Blind means blind: what one reader answered may not appear in the other's
     request. The stand-in answers "yes" or "no" or "unclear"; those words are
     in every assignment by design, so what is checked is the ANSWER STRUCTURE
     — a claim key, a quoted anchor — never appearing in a sibling's packet. */
  const claimShaped = /"claimKey"|"anchors"\s*:|"quotedText"/;
  t.check("neither reader's request carries the other's answer",
    readings.every((r) => !claimShaped.test(r.text)),
    readings.filter((r) => claimShaped.test(r.text)).slice(0, 1).map((r) => r.subject).join(""));

  const critics = seen.filter((r) => r.role === "evidence_critic" || r.role === "disagreement_verifier");
  const claims = await client.query(
    `select count(*)::text as n from public.evidence_claims where workflow_id = $1`, [started.workflowId]);
  t.check("readings became claims in the record", n(claims.rows) > 0, `${n(claims.rows)} claims`);
  /* Every OBSERVED claim — one read straight off the material. A claim the
     kernel derived from other claims has its inputs rather than an anchor of
     its own, and demanding one of it would be demanding a fiction. */
  const observed = await client.query(
    `select count(*)::text as n from public.evidence_claims
      where workflow_id = $1 and observation_basis = 'observed'`, [started.workflowId]);
  const unanchored = await client.query(
    `select count(*)::text as n from public.evidence_claims c
      where c.workflow_id = $1 and c.observation_basis = 'observed'
        and not exists (select 1 from public.evidence_anchors a
                         where a.claim_id = c.id and a.quoted_text is not null)`, [started.workflowId]);
  t.check("every observed claim quotes what it read", n(unanchored.rows) === 0,
    `${n(observed.rows)} observed claims, ${n(unanchored.rows)} of them quoting nothing`);
  t.check("a critic was asked, or the rule accepted without needing one",
    critics.length > 0 || n(claims.rows) > 0, `${critics.length} checks against the source`);

  /* ═══════════════════════════════════════════════════════════════════════ */
  t.section("(5) a result opens on the place it came from");

  const anchors = await client.query(
    `select s.content_hash, s.segment_kind, s.ordinal, f.ordinal as file_ordinal
       from public.evidence_anchors a
       join public.source_segments s on s.id = a.segment_id
       join public.workflow_sources w on w.id = s.source_id
       join public.analysis_files f on f.storage_path is not null and f.analysis_id = $2::uuid
        and w.uri = $3 || f.ordinal::text
      where a.workflow_id = $1 limit 50`,
    [started.workflowId, first, `mdai://analysis/${first}/file/`]);
  const reachable = [];
  for (const row of anchors.rows) {
    const part = await client.query(
      `select p.part_kind, p.ordinal, p.storage_path, p.locator, f.file_name
         from public.analysis_parts p join public.analysis_files f on f.id = p.file_id
        where p.analysis_id = $1::uuid and p.content_sha256 = $2`, [first, row.content_hash]);
    if (part.rows.length) reachable.push({ ...part.rows[0], anchorOrdinal: Number(row.ordinal) });
  }
  t.check("every anchor the engine wrote names a piece of the owner's own file",
    anchors.rows.length > 0 && reachable.length === anchors.rows.length,
    `${reachable.length} of ${anchors.rows.length}`);
  t.check("and that piece has a place in the original: a page number or a second",
    reachable.every((r) => {
      const locator = typeof r.locator === "string" ? JSON.parse(r.locator) : r.locator;
      return r.part_kind === "video_frame" ? typeof locator.seconds === "number" : typeof locator.page === "number";
    }),
    reachable.slice(0, 3).map((r) => `${r.file_name} ${r.part_kind} ${r.ordinal}`).join(" · "));
  const stillThere = reachable.filter((r) => r.storage_path).every((r) => fs.existsSync(
    path.join(store, r.storage_path.replace(/[^A-Za-z0-9._/-]/g, "_"))));
  t.check("and the bytes behind it are still on the server, to be opened",
    stillThere, `${reachable.length} pieces`);

  /* ═══════════════════════════════════════════════════════════════════════ */
  t.section("(5b) the result reads as three sections, and one fact is in one");

  /* The same rule the door arranges the screen by, put to the readings this
     run actually produced. */
  const recorded = await client.query(
    `select c.subject_type, c.subject_key, c.status, c.independence_domain, c.value::text as value,
            c.observation_basis
       from public.evidence_claims c where c.workflow_id = $1 and c.predicate = 'finding'
      order by c.subject_key`, [started.workflowId]);
  const verdicts = await client.query(
    `select c.subject_key, a.assessment from public.claim_assessments a
       join public.evidence_claims c on c.id = a.claim_id where a.workflow_id = $1`, [started.workflowId]);
  const decided = await client.query(
    `select subject_key, decision_type, status from public.decisions where workflow_id = $1`, [started.workflowId]);

  const subjects = new Map();
  for (const row of recorded.rows) {
    const key = String(row.subject_key);
    const found = subjects.get(key) ?? { readings: [], reviews: [], decisions: [], taskStates: [] };
    found.readings.push({
      value: JSON.parse(String(row.value)),
      independenceDomain: row.independence_domain,
      status: String(row.status),
    });
    subjects.set(key, found);
  }
  for (const row of verdicts.rows) subjects.get(String(row.subject_key))?.reviews.push({ verdict: String(row.assessment) });
  for (const row of decided.rows) subjects.get(String(row.subject_key))?.decisions.push({ type: String(row.decision_type), status: String(row.status) });

  const placed = [...subjects.entries()].map(([key, shape]) => [key, sectionFor(shape)]);
  const counts = placed.reduce((tally, [, where]) => ({ ...tally, [where]: (tally[where] ?? 0) + 1 }), {});
  t.check("every place the engine read landed in exactly one section",
    placed.length === subjects.size && placed.every(([, where]) => ["confirmed", "discrepancy", "needsCheck"].includes(where)),
    JSON.stringify(counts));

  /* The pages carry text, so a reading of them is a real answer that two
     independent families can corroborate. The frames carry no text, so both
     readers said "unclear" — which is agreement about not knowing and is NOT
     confirmation. That distinction is the one this section exists to hold. */
  const pages = placed.filter(([key]) => key.startsWith("page/"));
  const moments = placed.filter(([key]) => key.startsWith("moment/"));
  t.check("pages that could be read are confirmed",
    pages.length === 3 && pages.every(([, where]) => where === "confirmed"),
    pages.map(([key, where]) => `${key}=${where}`).join(" "));
  t.check("moments nobody could read are NOT confirmed — agreeing on “unclear” is not agreement",
    moments.length === 5 && moments.every(([, where]) => where === "needsCheck"),
    moments.map(([key, where]) => `${key}=${where}`).join(" "));

  /* THE COMPOSER IS NOT LOAD-BEARING.
     A model that writes the decision paragraph is running in this workflow.
     Whether it earns its place is a question this repository has not settled,
     so the result must not depend on it: take every decision away and each
     place lands in the same section it landed in with them. */
  const withoutDecisions = [...subjects.entries()]
    .map(([key, shape]) => [key, sectionFor({ ...shape, decisions: [] })]);
  const moved = placed.filter(([key, where], i) => withoutDecisions[i][1] !== where);
  t.check("taking the composer's decisions away moves nothing — the result does not rest on it",
    moved.length === 0, moved.map(([key, where]) => `${key} was ${where}`).join(" · "));
  t.check("and there were decisions to take away, so that proves something",
    decided.rows.length > 0, `${decided.rows.length} decisions`);

  /* And the two cases this run did not produce, put to the rule directly. */
  const two = (a, b) => ({
    readings: [
      { value: { known: true, text: a }, independenceDomain: "family-one", status: "corroborated" },
      { value: { known: true, text: b }, independenceDomain: "family-two", status: "corroborated" },
    ], reviews: [], decisions: [], taskStates: ["completed", "completed"],
  });
  t.check("two independent readers who differ are a discrepancy", sectionFor(two("yes", "no")) === "discrepancy");
  t.check("a reviewer who read the source otherwise is a discrepancy",
    sectionFor({ ...two("yes", "yes"), reviews: [{ verdict: "contradicts" }] }) === "discrepancy");
  t.check("one reading, however confident, is never confirmed",
    sectionFor({ readings: [{ value: { known: true, text: "yes" }, independenceDomain: "family-one", status: "proposed" }],
      reviews: [], decisions: [], taskStates: ["completed"] }) === "needsCheck");
  t.check("two readings from the SAME family are not two independent readings",
    sectionFor({ readings: [
      { value: { known: true, text: "yes" }, independenceDomain: "family-one", status: "proposed" },
      { value: { known: true, text: "yes" }, independenceDomain: "family-one", status: "proposed" },
    ], reviews: [], decisions: [], taskStates: ["completed"] }) === "needsCheck");
  t.check("a place still being read is not confirmed yet",
    sectionFor({ ...two("yes", "yes"), taskStates: ["completed", "running"] }) === "needsCheck");

  /* ═══════════════════════════════════════════════════════════════════════ */
  t.section("(6) a reload continues the same workflow");

  const workflowsBefore = n((await client.query(
    `select count(*)::text as n from public.intelligence_workflows`)).rows);
  const attemptsBefore = n((await client.query(
    `select count(*)::text as n from public.agent_attempts where workflow_id = $1`, [started.workflowId])).rows);
  const succeededBefore = n((await client.query(
    `select count(*)::text as n from public.agent_attempts where workflow_id = $1 and state = 'succeeded'`,
    [started.workflowId])).rows);

  /* A person reloads the page; the browser asks the record what is there. The
     runner, meanwhile, is a fresh process that knows nothing. */
  const restarted = await readAnalysis(client, first);
  t.check("the analysis still names one workflow, and it is the one that was started",
    restarted !== null && workflowsBefore === 1, `${workflowsBefore} workflows in the record`);

  const again = [];
  await dueNow(client, started.workflowId);
  await tickVia(client, { transport: sealedTransport(again) });
  const repeated = again.filter((r) => seen.some((s) => s.taskId && s.taskId === r.taskId));
  t.check("a later pass does not send work that already succeeded", repeated.length === 0,
    `${repeated.length} of ${again.length} requests repeated finished work`);
  const succeededAfter = n((await client.query(
    `select count(*)::text as n from public.agent_attempts where workflow_id = $1 and state = 'succeeded'`,
    [started.workflowId])).rows);
  t.check("and what had succeeded is still exactly as it was",
    succeededAfter >= succeededBefore, `${succeededBefore} → ${succeededAfter}`);
  t.check("no second workflow was created by any of it",
    n((await client.query(`select count(*)::text as n from public.intelligence_workflows`)).rows) === workflowsBefore);

  /* ═══════════════════════════════════════════════════════════════════════ */
  t.section("(8) two analyses at once, with different material");

  const secondFile = pdfFile(1, "scan-set.pdf", material.scan.bytes, material.scan.made);
  const second = await seedAnalysis(client, organizationId, {
    title: "Survey scans", questionKind: "specific_question", question: "",
    files: [secondFile],
  });
  const secondRun = await startAnalysis(client, organizationId, second);
  t.check("the second analysis is its own workflow", secondRun.workflowId !== started.workflowId);

  const mixed = [];
  await dueNow(client, secondRun.workflowId);
  for (let i = 0; i < 4; i += 1) {
    await dueNow(client, secondRun.workflowId);
    await tickVia(client, { transport: sealedTransport(mixed) });
  }
  const secondHashes = new Set(secondFile.parts.map((p) => p.contentHash));
  const firstHashes = new Set([...planFile.parts, ...clipFile.parts].map((p) => p.contentHash));
  const secondReadings = mixed.filter((r) => r.role === "page_reader" && r.materialHashes.length);
  const leaked = secondReadings.filter((r) => r.materialHashes.some((hash) => firstHashes.has(hash)));
  t.check("nothing from the first analysis reached the second",
    secondReadings.length > 0 && leaked.length === 0,
    `${secondReadings.length} readings, ${leaked.length} carrying the other analysis's material`);
  t.check("and every piece it was given belongs to its own file",
    secondReadings.every((r) => r.materialHashes.every((hash) => secondHashes.has(hash))));

  const crossed = await client.query(
    `select count(*)::text as n from public.evidence_claims c
       join public.workflow_sources w on w.workflow_id = c.workflow_id
      where c.workflow_id = $1 and w.uri not like $2`,
    [secondRun.workflowId, `mdai://analysis/${second}/%`]);
  t.check("and no claim of one analysis rests on a source of the other", n(crossed.rows) === 0);

  /* ═══════════════════════════════════════════════════════════════════════ */
  t.section("(7) a stop stops new work, and says what was already sent");

  const third = await seedAnalysis(client, organizationId, {
    title: "A run somebody stops", questionKind: "specific_question", question: "",
    files: [pdfFile(1, "plan-set.pdf", material.plans.bytes, material.plans.made)],
  });
  const thirdRun = await startAnalysis(client, organizationId, third);
  await client.query(
    `update public.intelligence_workflows set cancel_requested_at = now() where id = $1`, [thirdRun.workflowId]);
  const afterStop = [];
  await dueNow(client, thirdRun.workflowId);
  await tickVia(client, { transport: sealedTransport(afterStop) });
  t.check("a stopped workflow sends nothing new", afterStop.length === 0, `${afterStop.length} requests`);
  const stoppedState = (await client.query(
    `select state, error_code, error_message from public.intelligence_workflows where id = $1`,
    [thirdRun.workflowId])).rows[0];
  t.check("and the record says it was stopped, in words",
    ["cancelled", "failed", "needs_attention", "partial"].includes(String(stoppedState.state)),
    `${stoppedState.state} · ${stoppedState.error_code ?? ""} ${stoppedState.error_message ?? ""}`);
  const unknowns = await client.query(
    `select count(*)::text as n from public.agent_attempts
      where workflow_id = $1 and state in ('submitted','outcome_unknown')`, [thirdRun.workflowId]);
  t.check("an answer nobody ever saw is left as unknown rather than called a failure",
    Number.isFinite(n(unknowns.rows)), `${n(unknowns.rows)} unknown`);

  /* ═══════════════════════════════════════════════════════════════════════ */
  t.section("(9) a different file is different material");

  const fourth = await seedAnalysis(client, organizationId, {
    title: "Before the swap", questionKind: "specific_question", question: "",
    files: [pdfFile(1, "plan-set.pdf", material.plans.bytes, material.plans.made)],
  });
  const beforeSwap = manifestOfAnalysis(await readAnalysis(client, fourth), workflowIdForAnalysis(fourth));

  /* The owner replaces the file while the analysis is still being collected —
     which is allowed, and is exactly why a started analysis refuses it. */
  const fileRow = (await client.query(
    `select id::text as id from public.analysis_files where analysis_id = $1::uuid and ordinal = 1`, [fourth])).rows[0];
  await client.query(`delete from public.analysis_parts where file_id = $1::uuid`, [fileRow.id]);
  const swapped = pdfFile(1, "scan-set.pdf", material.scan.bytes, material.scan.made);
  for (const part of swapped.parts) {
    const partPath = `${organizationId}/analysis/${fourth}/1/${part.partKind}-${part.ordinal}.png`;
    if (part.bytes) put(partPath, part.bytes);
    await client.query(
      `insert into public.analysis_parts(analysis_id, file_id, organization_id, part_kind, ordinal,
         storage_path, inline_text, media_type, byte_size, content_sha256, locator)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [fourth, fileRow.id, organizationId, part.partKind, part.ordinal, part.bytes ? partPath : null,
       part.text ?? null, part.mediaType, part.byteSize, part.contentHash, JSON.stringify(part.locator)]);
  }
  const afterSwap = manifestOfAnalysis(await readAnalysis(client, fourth), workflowIdForAnalysis(fourth));
  t.check("replacing the file changes the source the agents would be given",
    beforeSwap.sources[0].contentHash !== afterSwap.sources[0].contentHash,
    `${beforeSwap.sources[0].contentHash.slice(0, 12)} → ${afterSwap.sources[0].contentHash.slice(0, 12)}`);
  t.check("and it changes the pieces inside it too",
    beforeSwap.sources[0].declaredSegments.length !== afterSwap.sources[0].declaredSegments.length
    || beforeSwap.sources[0].declaredSegments[0].contentHash !== afterSwap.sources[0].declaredSegments[0].contentHash);

  /* Once it has been run, the record itself refuses the swap. */
  await startAnalysis(client, organizationId, fourth);
  let refused = null;
  try {
    await client.query(`delete from public.analysis_parts where file_id = $1::uuid`, [fileRow.id]);
  } catch (error) { refused = error; }
  t.check("and once it has been run, the record will not let the material move at all",
    refused !== null, String(refused && refused.message).slice(0, 120));

  /* ═══════════════════════════════════════════════════════════════════════ */
  t.section("nothing left this process");
  t.check("no provider was reached, by anything, at any point", reachedOut === 0, `${reachedOut} attempts`);
});

fs.rmSync(store, { recursive: true, force: true });
t.finish();
