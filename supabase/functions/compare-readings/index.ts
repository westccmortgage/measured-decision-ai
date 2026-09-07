/* WHICH READER READ THIS SET BETTER — AND ON WHAT EVIDENCE.
 *
 * Three readers have read one plan set. A person now needs an answer they can
 * act on: who read it better, in which sections, and why. This function
 * produces that answer in four steps, and each step exists because skipping
 * it produces a confident wrong one.
 *
 *   1. Conditions. Two readings are only comparable when they covered the
 *      same documents, at the same enlargement budget, under the same task
 *      version. Where they did not, the difference is named on the screen and
 *      the result is never called a comparison of readers.
 *
 *   2. Code first. Agreements, differences, positions only one reader has,
 *      units that do not match, numbers that do not follow from their own
 *      row — all of it found mechanically, before anyone is paid to judge.
 *      Two readers agreeing is not evidence: they can be wrong together.
 *
 *   3. A blinded check against the drawings. The three answers go to one
 *      reader as A, B and C in a shuffled order, with the same sheets and the
 *      same enlargements the readers themselves had. Which provider wrote
 *      which answer stays on this server. Hiding the names reduces one bias;
 *      it does not make the check independent, and the screen says so.
 *
 *   4. Evidence or nothing. A finding must point at a place on a sheet, and a
 *      finding about a quantity must point at the individual marks counted. A
 *      sheet reference alone does not establish a number. Where the checker
 *      could not verify something, the status is "could not verify" — never
 *      an invented verdict, and never a percentage without a control markup
 *      to count against.
 *
 * What this never does: change the project's active baseline, or merge the
 * best rows of three answers into a fourth schedule. A comparison is a
 * finding about readers, not a new reading.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { AGENT_CONTRACT_VERSION } from "../_shared/agent-contracts.ts";
import { buildFingerprint, claimAiRun, finishAiRun, RunProgress } from "../_shared/ai-run-ledger.ts";
import {
  DEFAULT_PROVIDER, isProviderKey, modelOptionOrUnknown, openAIRequestBody, PROVIDERS,
  ProviderNotConfigured, providerCatalogue, providerErrorMessage, providerTransport, readAnswer,
  readingImageBudget, readingRefusal, releaseGoogleFiles, syncRequest, uploadToGoogle, usageCost,
  waitForGoogleFiles,
  type ProviderKey, type ProviderTransport, type UploadedAsset,
} from "../_shared/ai-providers.ts";
import { openAITransport } from "../_shared/openai-transport.ts";
import { gatherReadingAssets } from "../_shared/reading-assets.ts";
import { workerBudget } from "../plan-analyze/chunking.js";
import {
  againstTruth, compareReadings, conditionsVerdict, positionsOf, sanitiseVerdict, tallyFindings,
  type ReadingConditions, type TruthEntry,
} from "../_shared/reading-comparison.ts";

const allowedOrigins = new Set([
  "https://measureddecision.ai",
  "https://www.measureddecision.ai",
  "https://measureddecision.com",
  "https://www.measureddecision.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://measureddecision.ai",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

const json = (request: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const safeText = (value: unknown, fallback = "") =>
  (typeof value === "string" && value.trim() ? value.trim() : fallback);

/* The check is one long reading of its own, so it runs the same way: handed
   to the runtime, never awaited inside the request. */
const CHECK_TIMEOUT_MS = 340_000;
const CHECK_DEADLINE_MS = 8 * 60 * 1000;
const CHECK_OUTPUT_TOKENS = 16000;
/* The checker runs after its response like every long reading, so it lives
   under the same ceiling: the worker's wall clock — 400 seconds on this
   project's plan — counted from when the worker booted, which `waitUntil`
   holds open but does not extend. A check is not started on a worker without
   the life left to finish it, and nothing is bought when it is refused. */
const WORKER_WALL_CLOCK_MS = 400_000;
const WORKER_SAFETY_MS = 25_000;
const MIN_CHECK_MS = 150_000;
const WORKER_BOOTED_AT = Date.now();
const BLIND_LABELS = ["A", "B", "C", "D", "E", "F"];

function runAfterResponse(work: Promise<unknown>) {
  const runtime = (globalThis as Record<string, any>).EdgeRuntime;
  const settled = work.catch((error) => {
    console.error("comparison failed", error instanceof Error ? error.message : String(error));
  });
  if (runtime && typeof runtime.waitUntil === "function") runtime.waitUntil(settled);
  return settled;
}

/* THE CHECKER'S TASK.
 *
 * Written once, here, so what the checker is held to is readable by a person
 * and cannot drift between runs. */
const CHECK_INSTRUCTIONS = [
  "You are checking three takeoff readings of one set of construction drawings against the drawings themselves.",
  "",
  "The three answers reach you as A, B and C. You are not told which system produced which, and you must not guess or speculate about it.",
  "",
  "WHAT YOU ARE JUDGING, in this order of importance:",
  "1. Correctness of materials, sections and sizes, quantities and units.",
  "2. Completeness against the sheets attached — including positions that ALL THREE answers missed. Finding those is the most valuable thing you can do here.",
  "3. Verifiability of sources: whether a row can be traced to a place on a sheet.",
  "4. Honest handling of uncertainty: a row that says it could not resolve a size, with the reason, is better work than a confident invented one.",
  "",
  "WHAT IS NOT A VIRTUE: a longer answer, more rows, or more filled fields. An answer with fewer, correct, sourced rows is better than a long one with invented rows.",
  "Equally, refusing to count anything is not caution — it is an answer with no content. Judge the work, not its volume.",
  "",
  "EVIDENCE. Every finding you report must name where on a sheet you saw it: the sheet name, the page number, and the tile you read it from.",
  "A sheet reference alone never establishes a quantity. To say a count is right or wrong you must identify the individual marks you counted — list them with where each one sits on the sheet.",
  "If you cannot do that for a quantity, the verdict for that quantity is could_not_verify. That is an acceptable and expected answer; an invented verdict is not.",
  "",
  "SCOPE. A count only means something together with what it counts. `counted` distinguishes framing zones from individual members from assemblies from the boards inside an assembly.",
  "Twelve zones and twelve members are not the same claim, and reading twelve zones as twelve rafters is a specific error to look for.",
  "The same mark appearing in two different schedules is two different positions; do not merge them.",
  "",
  "AGREEMENT IS NOT PROOF. Where two or three answers say the same thing, check it against the drawing anyway — they can be wrong together.",
  "",
  "Never measure a drawing by scale. Only printed dimensions, schedule rows and marks drawn on the sheet are evidence.",
  "Answer only in the JSON format requested.",
].join("\n");

const verdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["recommended_reader", "recommendation_reason", "confidence", "sections", "findings", "missed_by_all", "check_coverage"],
  properties: {
    /* "none" is a real answer, and the one to give whenever the evidence
       does not separate the readers. */
    recommended_reader: { type: "string", enum: ["A", "B", "C", "none"] },
    recommendation_reason: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section", "best", "why", "per_reader"],
        properties: {
          section: { type: "string" },
          /* Different readers may win different sections; that is a normal
             answer, not a failure to decide. */
          best: { type: "string", enum: ["A", "B", "C", "tie", "none"] },
          why: { type: "string" },
          per_reader: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["reader", "correctness", "completeness", "verifiability", "uncertainty", "note"],
              properties: {
                reader: { type: "string", enum: ["A", "B", "C"] },
                correctness: { type: "string", enum: ["strong", "mixed", "weak", "not_checked"] },
                completeness: { type: "string", enum: ["strong", "mixed", "weak", "not_checked"] },
                verifiability: { type: "string", enum: ["strong", "mixed", "weak", "not_checked"] },
                uncertainty: { type: "string", enum: ["strong", "mixed", "weak", "not_checked"] },
                note: { type: "string" },
              },
            },
          },
        },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["reader", "section", "mark", "claim", "verdict", "kind", "evidence", "why"],
        properties: {
          reader: { type: "string", enum: ["A", "B", "C", "all"] },
          section: { type: "string" },
          mark: { type: "string" },
          claim: { type: "string" },
          verdict: { type: "string", enum: ["verified", "wrong", "could_not_verify"] },
          /* A quantity verdict needs marks; a size or material verdict needs
             the schedule row it came from. The kind says which rule applies. */
          kind: { type: "string", enum: ["quantity", "size_or_material", "scope", "source", "requirement_from_notes", "other"] },
          evidence: {
            type: "object",
            additionalProperties: false,
            required: ["sheet", "page", "tile", "what_is_drawn", "marks"],
            properties: {
              sheet: { type: "string" },
              page: { type: ["integer", "null"] },
              tile: { type: "string" },
              what_is_drawn: { type: "string" },
              marks: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["label", "where"],
                  properties: { label: { type: "string" }, where: { type: "string" } },
                },
              },
            },
          },
          why: { type: "string" },
        },
      },
    },
    missed_by_all: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["mark", "section", "sheet", "page", "what_is_drawn"],
        properties: {
          mark: { type: "string" },
          section: { type: "string" },
          sheet: { type: "string" },
          page: { type: ["integer", "null"] },
          what_is_drawn: { type: "string" },
        },
      },
    },
    check_coverage: {
      type: "object",
      additionalProperties: false,
      required: ["positions_checked", "positions_not_checked", "what_stayed_unresolved"],
      properties: {
        positions_checked: { type: "integer" },
        positions_not_checked: { type: "integer" },
        what_stayed_unresolved: { type: "string" },
      },
    },
  },
} as const;

function checkTaskText(
  readings: Array<{ blind: string; positions: unknown[]; gaps: unknown[]; assumptions: unknown[] }>,
  mechanical: Record<string, unknown>,
  truthEntries: TruthEntry[],
) {
  const parts = [
    "THREE ANSWERS, BLINDED. Each answer is given as the positions it reported — the structural members, the scheduled components and the printed rules it read out of the notes — with the counts, units, sizes, what each count counts, and the sources it cited.",
    ...readings.map((reading) => [
      `\n=== ANSWER ${reading.blind} ===`,
      JSON.stringify({ positions: reading.positions, gaps: reading.gaps, assumptions: reading.assumptions }),
    ].join("\n")),
    "\n=== WHAT CODE ALREADY FOUND, WITHOUT LOOKING AT THE DRAWINGS ===",
    "These are lined-up positions and the differences between the answers. They are a starting point for what to check, not a verdict, and agreement between answers is not evidence of correctness.",
    JSON.stringify(mechanical),
  ];
  if (truthEntries.length) {
    parts.push(
      "\n=== A CONTROL MARKUP READ OFF THESE SHEETS BY A PERSON ===",
      "Each entry names a mark and the page it was found on. Entries flagged disputed are not settled — report what you see for them and do not use them to decide between readers.",
      JSON.stringify(truthEntries),
    );
  }
  parts.push(
    "\n=== WHAT TO DO ===",
    "Go to the attached sheets and enlargements. Check the differences above, and look for positions no answer reported at all.",
    "Report each finding with the sheet, the page, the tile you read it from, and — for any finding about a quantity — the individual marks you counted and where each one sits.",
    "Where you cannot establish something from the drawings, say could_not_verify. Give a recommended reader only if the evidence separates them; otherwise answer none.",
  );
  return parts.join("\n");
}

async function runCheck(
  transport: ProviderTransport,
  assets: Awaited<ReturnType<typeof gatherReadingAssets>>,
  taskText: string,
  progress: RunProgress,
) {
  const content = {
    instructions: CHECK_INSTRUCTIONS,
    taskText,
    registerText: "",
    chunkNote: null,
    imageNote: assets.imageNote,
    documents: assets.documents,
    images: assets.images,
    schema: verdictSchema as unknown as Record<string, unknown>,
    maxOutputTokens: CHECK_OUTPUT_TOKENS,
  };
  const refusal = readingRefusal(transport, content);
  if (refusal) throw new Error(refusal);

  const room = workerBudget(WORKER_BOOTED_AT, Date.now(), WORKER_WALL_CLOCK_MS, WORKER_SAFETY_MS, MIN_CHECK_MS);
  if (!room.enough) {
    throw new Error(
      `NOT_ENOUGH_WORKER_TIME: this worker has ${Math.round(room.remaining_ms / 1000)} seconds left of its `
      + `${Math.round(WORKER_WALL_CLOCK_MS / 1000)} second life, which is not enough to finish a check. `
      + "Nothing was sent and nothing was bought; pressing Compare again starts it on a worker with room.",
    );
  }
  const startedAt = Date.now();
  const uploads: UploadedAsset[] = [];
  const controller = new AbortController();
  /* Whichever runs out first: the check's own ceiling, or this worker's
     remaining life. */
  const deadlineMs = Math.min(CHECK_TIMEOUT_MS, room.remaining_ms);
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const abortMessage = () => new Error(
    `${PROVIDERS[transport.provider].label} did not answer within ${Math.round(deadlineMs / 1000)} seconds. `
    + "The request was sent, so it may already have run and been billed — running it again needs confirmation.");

  if (transport.mode === "background") {
    /* One check, not a background job: the answer is wanted here, and this
       whole function already runs on after its response. `store: false`
       because nothing needs to be retrieved later. */
    progress.sent();
    try {
      const created = await fetch(`${transport.baseUrl}/responses`, {
        method: "POST", headers: transport.headers, signal: controller.signal,
        body: JSON.stringify({ ...openAIRequestBody(transport, content), background: false, store: false }),
      });
      const payload = await created.json();
      if (!created.ok) throw new Error(providerErrorMessage(transport.provider, payload, `The checker refused the request (${created.status})`));
      return { answer: readAnswer(transport.provider, payload), payload, durationMs: Date.now() - startedAt };
    } catch (error) {
      if (controller.signal.aborted) throw abortMessage();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    if (transport.provider === "google") {
      for (const asset of [...content.documents, ...content.images]) uploads.push(await uploadToGoogle(transport, asset));
      await waitForGoogleFiles(transport, uploads);
    }
    const request = syncRequest(transport, content, uploads);
    progress.sent();
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: "POST", headers: transport.headers,
        body: JSON.stringify(request.body), signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw abortMessage();
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(providerErrorMessage(transport.provider, payload, `The checker refused the request (${response.status})`));
    return { answer: readAnswer(transport.provider, payload), payload, durationMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
    if (uploads.length) await releaseGoogleFiles(transport, uploads);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return json(request, { error: "Server configuration is incomplete" }, 500);

  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json(request, { error: "Authentication required" }, 401);
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json(request, { error: "Invalid session" }, 401);

  try {
    const body = await request.json();
    const action = safeText(body?.action, "status");
    const propertyId = safeText(body?.property_id);
    if (!propertyId) return json(request, { error: "property_id is required" }, 400);

    const { data: property } = await userClient.from("properties")
      .select("id, organization_id").eq("id", propertyId).maybeSingle();
    if (!property) return json(request, { error: "Project not found" }, 404);
    const { data: membership } = await userClient.from("organization_members")
      .select("role").eq("organization_id", property.organization_id)
      .eq("user_id", userData.user.id).maybeSingle();
    if (!membership) return json(request, { error: "Not authorized for this project" }, 403);
    const maySpend = ["owner", "admin"].includes(membership.role);

    const requestedIds: string[] = Array.isArray(body?.baseline_ids)
      ? body.baseline_ids.map((id: unknown) => safeText(id)).filter(Boolean) : [];

    /* The readings being compared, always read fresh: a comparison of a
       stale copy of an answer is a comparison of nothing. */
    const { data: baselineRows } = await admin.from("document_baselines")
      .select("id, version, state, provider, model, analysis, source_document_ids, agent_contract_version, analysis_run, created_at")
      .eq("property_id", propertyId)
      .in("id", requestedIds.length ? requestedIds : ["00000000-0000-0000-0000-000000000000"]);
    const baselines = requestedIds
      .map((id) => (baselineRows || []).find((row) => row.id === id))
      .filter(Boolean) as Array<Record<string, any>>;

    if (action === "attach_truth") {
      if (!maySpend) return json(request, { error: "Not authorized to attach a control markup" }, 403);
      const entries: TruthEntry[] = Array.isArray(body?.entries) ? body.entries : [];
      const documentIds: string[] = Array.isArray(body?.source_document_ids) ? body.source_document_ids.map(safeText).filter(Boolean) : [];
      if (!entries.length) return json(request, { error: "A control markup with no entries is not a control markup" }, 400);
      if (!documentIds.length) return json(request, { error: "Name the plan documents this markup was read from" }, 400);
      /* A markup belongs to the file it was read from, and to no other. The
         document's own size and page count are stored with it so it can
         never be quietly applied to a different revision of the drawings. */
      const { data: documents } = await userClient.from("project_documents")
        .select("id, original_filename, byte_size, page_count, revision_label")
        .in("id", documentIds).eq("property_id", propertyId);
      if (!documents || documents.length !== documentIds.length) {
        return json(request, { error: "One or more of those plan documents are not in this project" }, 400);
      }
      const { data: saved, error: saveError } = await admin.from("reading_ground_truth").insert({
        organization_id: property.organization_id,
        property_id: propertyId,
        label: safeText(body?.label, "Control markup"),
        source_document_ids: documentIds,
        verified_against: {
          checked_at: new Date().toISOString(),
          documents: documents.map((row) => ({
            id: row.id, filename: row.original_filename, byte_size: row.byte_size,
            page_count: row.page_count, revision: row.revision_label,
          })),
        },
        entries,
        created_by: userData.user.id,
      }).select("id, label, source_document_ids, verified_against, created_at").single();
      if (saveError) throw saveError;
      return json(request, { ground_truth: saved, entries: entries.length });
    }

    if (requestedIds.length < 2) {
      return json(request, { error: "A comparison needs at least two readings", code: "not_enough_readings" }, 400);
    }
    if (baselines.length !== requestedIds.length) {
      return json(request, { error: "One or more of those readings are not in this project", code: "reading_not_found" }, 404);
    }

    const blinds = baselines.map((_, index) => BLIND_LABELS[index]);
    const provider: ProviderKey = isProviderKey(body?.provider) ? body.provider : DEFAULT_PROVIDER;
    const modelId = safeText(body?.model) || null;
    const model = modelOptionOrUnknown(provider, modelId);
    /* One comparison of these readings, under this task version, by this
       checker. Reopening it costs nothing because it is the same row. */
    const fingerprint = buildFingerprint({
      organizationId: property.organization_id,
      propertyId,
      processKey: "compare-readings",
      model: model.id,
      contractVersion: AGENT_CONTRACT_VERSION,
      inputs: [...requestedIds].sort(),
      settings: { provider },
    });

    const { data: existing } = await admin.from("reading_comparisons")
      .select("*").eq("fingerprint", fingerprint).maybeSingle();

    if (action === "status") {
      /* Reopening shows what was saved, and never buys anything. */
      return json(request, { comparison: existing || null, saved: Boolean(existing) });
    }
    if (action !== "run") return json(request, { error: "Unknown action" }, 400);
    if (!maySpend) return json(request, { error: "Not authorized to run a comparison" }, 403);
    if (existing && !body?.force) {
      return json(request, { comparison: existing, saved: true, skipped: "already_compared" });
    }

    /* CONDITIONS, before anything is bought. */
    const conditions = conditionsVerdict(baselines.map((row) => ({
      id: row.id,
      provider: row.provider || row.analysis_run?.provider || "",
      model: row.model || row.analysis_run?.model || "",
      version: row.version,
      source_document_ids: row.source_document_ids || [],
      agent_contract_version: row.agent_contract_version || "",
      image_budget: row.analysis_run?.image_budget ?? null,
      image_fingerprint: row.analysis_run?.image_fingerprint ?? null,
      images_sent: row.analysis_run?.images_sent ?? null,
      reasoning_effort: row.analysis_run?.reasoning_effort ?? null,
      state: row.state,
    } as ReadingConditions)));

    /* A reading that is not there is not a reading. The comparison still
       runs on the ones that are, and says on its face that it is incomplete
       — and nothing reruns the failed reader on its own. */
    const unusable = baselines.filter((row) => !row.analysis || !Object.keys(row.analysis || {}).length);
    const incompleteReason = unusable.length
      ? `${unusable.length} of ${baselines.length} readings has no saved answer, so this comparison covers the rest. The missing reading was not run again — that is a decision for a person.`
      : "";

    const blinded = baselines.map((row, index) => ({ id: row.id, blind: blinds[index], analysis: row.analysis || {} }));
    /* Shuffled, so the checker's A is not systematically the first reader a
       person happened to run. Which is which stays here. */
    for (let index = blinded.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      const label = blinded[index].blind;
      blinded[index].blind = blinded[swap].blind;
      blinded[swap].blind = label;
    }
    const blindMap = Object.fromEntries(blinded.map((item) => [item.blind, item.id]));

    const mechanical = compareReadings(blinded.filter((item) => Object.keys(item.analysis).length));

    /* A control markup, only if it was read from the same documents. */
    const planDocumentIds: string[] = [...new Set(baselines.flatMap((row) => row.source_document_ids || []))] as string[];
    const { data: truthRows } = await admin.from("reading_ground_truth")
      .select("id, label, source_document_ids, entries, verified_against, created_at")
      .eq("property_id", propertyId).order("created_at", { ascending: false }).limit(10);
    const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
    const truthRow = (truthRows || []).find((row) => sameSet(row.source_document_ids || [], planDocumentIds)) || null;
    const truthEntries: TruthEntry[] = truthRow ? (truthRow.entries as TruthEntry[]) : [];
    const truth = truthRow
      ? {
        id: truthRow.id,
        label: truthRow.label,
        verified_against: truthRow.verified_against,
        ...againstTruth(mechanical, truthEntries, blinded.map((item) => item.blind)),
      }
      : {
        /* Without a markup checked against the real sheets there is no
           denominator, so there is no accuracy — only a reader's opinion,
           named as one. */
        absent: true,
        note: "This project has no control markup matching these plan documents, so nothing here is measured accuracy. The result is a reader's recommendation.",
      };

    const resolveTransport = (): ProviderTransport => {
      if (provider === "openai") {
        const legacy = openAITransport({ preferDirect: true });
        return {
          provider: "openai", mode: "background", baseUrl: legacy.baseUrl, headers: legacy.headers,
          model: modelOptionOrUnknown("openai", modelId || Deno.env.get("OPENAI_PLAN_MODEL") || "gpt-5.6-sol"),
          transport: legacy.transport,
        };
      }
      return providerTransport(provider, modelId);
    };
    let transport: ProviderTransport;
    try {
      transport = resolveTransport();
    } catch (error) {
      if (error instanceof ProviderNotConfigured) {
        return json(request, {
          error: `Checker not configured — ${PROVIDERS[provider].label} has no key in this project's secrets.`,
          code: "provider_not_configured", provider,
        }, 400);
      }
      throw error;
    }

    const { data: documents } = await userClient.from("project_documents")
      .select("id, organization_id, storage_path, storage_provider, storage_bucket, original_filename")
      .in("id", planDocumentIds).eq("property_id", propertyId);
    if (!documents || !documents.length) {
      return json(request, { error: "The plan documents these readings were made from are no longer in this project" }, 400);
    }

    const ledger = await claimAiRun(admin, {
      organizationId: property.organization_id,
      propertyId,
      processKey: "compare-readings",
      model: transport.model.id,
      contractVersion: AGENT_CONTRACT_VERSION,
      inputs: [...requestedIds].sort(),
      settings: { provider },
      jobTable: "reading_comparisons",
      jobId: null,
      transport: transport.transport,
      force: Boolean(body?.force),
    });
    if (ledger.verdict !== "CLAIMED") {
      return json(request, {
        comparison: existing || null,
        skipped: ledger.verdict.toLowerCase(),
        code: ledger.verdict === "RUNNING" ? "comparison_in_flight" : "already_compared",
      });
    }

    const progress = new RunProgress();
    const work = (async () => {
      const assets = await gatherReadingAssets(admin, documents as never, readingImageBudget(provider));
      const taskText = checkTaskText(
        blinded.filter((item) => Object.keys(item.analysis).length).map((item) => ({
          blind: item.blind,
          positions: positionsOf(item.analysis),
          gaps: Array.isArray(item.analysis.gaps) ? item.analysis.gaps : [],
          assumptions: Array.isArray(item.analysis.assumptions) ? item.analysis.assumptions : [],
        })),
        { sections: mechanical.sections, summary: mechanical.summary, rows: mechanical.rows.filter((row) => row.differences.length || row.flags.length || row.agreement !== "all") },
        truthEntries,
      );
      const { answer, payload, durationMs } = await runCheck(transport, assets, taskText, progress);
      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(answer.text);
      } catch {
        throw new Error("The checker answered with something that is not the agreed result format.");
      }
      const { verdict, downgraded } = sanitiseVerdict(parsed);
      const usage = answer.usage;
      const cost = usageCost(transport.model, usage);
      /* Marks the control markup itself does not settle are kept out of the
         count entirely. A reader cannot be credited or faulted on a number
         nobody has established. */
      const disputedMarks = truthEntries.filter((entry) => entry?.disputed).map((entry) => String(entry.mark || ""));
      const tally = tallyFindings(verdict, blinded.map((item) => item.blind), disputedMarks);

      await finishAiRun(admin, ledger.runId, "succeeded", usage, null);
      const { data: saved, error: saveError } = await admin.from("reading_comparisons").upsert({
        organization_id: property.organization_id,
        property_id: propertyId,
        baseline_ids: requestedIds,
        plan_document_ids: planDocumentIds,
        agent_contract_version: baselines[0]?.agent_contract_version || AGENT_CONTRACT_VERSION,
        fingerprint,
        comparable: conditions.comparable,
        conditions,
        mechanical: mechanical as unknown as Record<string, unknown>,
        judge_provider: transport.provider,
        judge_model: transport.model.id,
        judge_model_reported: answer.modelReported || null,
        blind_map: blindMap,
        verdict: {
          ...verdict,
          /* What the application refused to accept from the checker, kept
             where a person can read it. */
          evidence_downgrades: downgraded,
          tally,
          run: {
            provider: transport.provider,
            provider_label: PROVIDERS[transport.provider].label,
            model: transport.model.id,
            duration_ms: durationMs,
            usage,
            ...cost,
          },
          raw_stop_reason: answer.stopReason,
        },
        truth,
        ai_run_id: ledger.runId,
        state: incompleteReason ? "incomplete" : "complete",
        incomplete_reason: incompleteReason || null,
        created_by: userData.user.id,
      }, { onConflict: "fingerprint" }).select("*").single();
      if (saveError) throw saveError;
      /* The raw answer is kept beside the parsed one, so a reading mistake
         stays separable from a processing mistake. */
      await admin.from("ai_runs").update({ usage_detail: { provider_raw_stop: answer.stopReason, payload_keys: Object.keys(payload || {}) } })
        .eq("id", ledger.runId);
      return saved;
    })().catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      /* A check refused before a request was built cost nothing. It is a
         failure that can simply be pressed again, not an unknown outcome. */
      const outcome = /^NOT_ENOUGH_WORKER_TIME/.test(message)
        ? "failed"
        : /may already have run and been billed/i.test(message) ? "outcome_unknown" : progress.outcome();
      await finishAiRun(admin, ledger.runId, outcome, {}, message.slice(0, 200));
      await admin.from("reading_comparisons").upsert({
        organization_id: property.organization_id,
        property_id: propertyId,
        baseline_ids: requestedIds,
        plan_document_ids: planDocumentIds,
        agent_contract_version: baselines[0]?.agent_contract_version || AGENT_CONTRACT_VERSION,
        fingerprint,
        comparable: conditions.comparable,
        conditions,
        mechanical: mechanical as unknown as Record<string, unknown>,
        judge_provider: transport.provider,
        judge_model: transport.model.id,
        blind_map: blindMap,
        truth,
        ai_run_id: ledger.runId,
        state: "incomplete",
        incomplete_reason: `${incompleteReason ? `${incompleteReason} ` : ""}The check itself did not finish: ${message.slice(0, 400)}`,
        created_by: userData.user.id,
      }, { onConflict: "fingerprint" });
      throw error;
    });

    runAfterResponse(work);
    return json(request, {
      state: "running",
      fingerprint,
      /* The mechanical half is already done and costs nothing, so it is on
         the screen while the check runs. */
      preview: {
        comparable: conditions.comparable,
        conditions,
        mechanical: { sections: mechanical.sections, summary: mechanical.summary, caveat: mechanical.caveat },
        truth,
        incomplete_reason: incompleteReason || null,
        judge_provider: transport.provider,
        judge_model: transport.model.id,
        deadline_ms: CHECK_DEADLINE_MS,
      },
    }, 202);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "The comparison failed";
    return json(request, { error: message }, 500);
  }
});
