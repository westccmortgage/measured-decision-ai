import { createClient } from "npm:@supabase/supabase-js@2";
import {
  AGENT_CONTRACT_VERSION,
  PLAN_WORKFLOW_INSTRUCTIONS,
} from "../_shared/agent-contracts.ts";
import { buildFingerprint, claimAiRun, finishAiRun, outcomeForStatus, RunProgress, usageFrom } from "../_shared/ai-run-ledger.ts";
import { gatherReadingAssets, listPageTiles } from "../_shared/reading-assets.ts";
import { openAITransport } from "../_shared/openai-transport.ts";
import {
  DEFAULT_PROVIDER, isProviderKey, modelOptionOrUnknown, openAIRequestBody, PROVIDERS,
  ProviderNotConfigured, providerCatalogue, providerErrorMessage, providerTransport, readAnswer,
  readingEffort, readingImageBudget, readingRefusal, releaseGoogleFiles, syncRequest, uploadToGoogle, usageCost,
  verifyModelId, waitForGoogleFiles,
  type ProviderKey, type ProviderTransport, type ReadingContent, type UploadedAsset,
} from "../_shared/ai-providers.ts";
import { CHUNK_BYTE_LIMIT, chunkNote, chunkRegister, MAX_RENDER_IMAGES, mergeChunkAnalyses, orderForReading, planChunks, rebuildableFrom, retryableLaunchRefusal, tileCoverage, tileCoverageGaps, heldReadingVerdict, workerBudget } from "./chunking.js";

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
    "Access-Control-Allow-Origin": allowedOrigins.has(origin)
      ? origin
      : "https://measureddecision.ai",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

/* One reading's output ceiling, the same for every provider, so the task a
   reader is given does not differ between them. A reading stopped at this
   limit is an error with its reason on the screen, never a partial result
   presented as finished. */
/* THE CEILING HAS TO HOLD THE THINKING TOO.
 *
 * Thirty-two thousand was not enough. The first real Claude reading of three
 * structural sheets ran the full five and a half minutes and then stopped at
 * this limit with the answer unfinished — because on Claude Opus 5 max_tokens
 * is "a hard limit on total output (thinking plus response text)", and the
 * model thinks by default at high effort. The ceiling was being spent on
 * reasoning before the schedule was written.
 *
 * Sixty-four thousand is the largest number all three readers accept: Claude
 * Opus 5 and GPT-5.6 Sol both publish a 128k maximum output, and Gemini 3.1
 * Pro publishes 64k — the binding one. Google's own page could not be reached
 * from here to confirm it, so if that figure is wrong the request is rejected
 * before anything is generated, which costs nothing and says so. */
const MAX_READING_OUTPUT_TOKENS = 64000;

/* A SYNCHRONOUS READER DOES NOT FIT IN A REQUEST.
 *
 * The deployed edge function stops answering a request after 150 seconds of
 * idleness, and a worker is stopped altogether at its wall-clock limit —
 * 150 seconds free, 400 seconds paid. Claude and Gemini take longer than the
 * first of those to read a plan chunk. So a synchronous reading is never
 * awaited inside the request that starts it: the request claims the chunk,
 * hands the reading to `EdgeRuntime.waitUntil`, and answers immediately. The
 * reading then runs in the same worker until it writes its own result, and
 * the Studio's existing poll finds that result on the chunk row.
 *
 * What this does not do is make the reading unbounded. A worker still dies
 * at its wall clock, and a chunk still sitting at `processing` past the
 * deadline below is recorded as an unknown outcome — sent, possibly billed,
 * never silently retried. */
/* THE WORKER'S OWN CLOCK.
 *
 * Confirmed for this project on 2026-09-07: organisation Pegasus Lenders
 * Group LLC is on the Pro plan, and Supabase's published runtime limits give
 * a paid plan a 400 second wall clock — the time a worker stays alive, across
 * every request it serves and every `waitUntil` promise it holds. The
 * documentation is explicit that `waitUntil` prevents an idle worker being
 * retired early but does NOT extend that ceiling.
 *
 * Two consequences this file has to live with:
 *
 *   the clock starts when the worker boots, not when a reading starts, so a
 *   warm worker may have seconds left rather than minutes;
 *   a worker killed at the ceiling takes an unfinished reading with it, and
 *   that reading was still sent and may still be billed.
 *
 * So: a reading is never started on a worker without room to finish it, and
 * a reading that is started is cut off inside the worker's remaining life
 * rather than at a fixed number that might outlast it. */
const WORKER_WALL_CLOCK_MS = 400_000;
/* Left for the reading to record its own result after the answer arrives. */
const WORKER_SAFETY_MS = 25_000;
/* Below this much remaining life, nothing is bought: the chunk stays pending
   and the next poll lands on a worker with room. A reading cut off halfway
   costs exactly as much as one that finishes. */
const MIN_READING_MS = 150_000;
/* When the worker booted. Module scope, so this is the worker's own start. */
const WORKER_BOOTED_AT = Date.now();
/* The longest a single reading may run even on a fresh worker. */
const SYNC_READING_TIMEOUT_MS = 340_000;
/* Past this, no worker that could still be holding the reading is alive. */
const SYNC_CHUNK_DEADLINE_MS = 8 * 60 * 1000;

function workerRoom() {
  return workerBudget(WORKER_BOOTED_AT, Date.now(), WORKER_WALL_CLOCK_MS, WORKER_SAFETY_MS, MIN_READING_MS);
}
/* What stands in a chunk's provider_job_id while this worker holds the
   reading itself. There is no provider-side id to hold: the answer comes
   back into the same invocation that sent it. */
const INLINE_CHUNK_HANDLE = "inline";

/* Work that outlives the response. Supabase's runtime keeps the worker alive
   for a promise handed to `waitUntil`; anywhere else (a local run, a test)
   the promise simply runs. */
/* A CALL THAT FINISHED BADLY IS NOT A CALL THAT MIGHT HAVE RUN.
 *
 * The ledger's hardest distinction is between "we know this happened and how
 * it ended" and "we do not know whether this was billed". A provider that
 * answered — even with a truncated answer — is the first kind: the outcome is
 * a plain failure, the usage is the usage it reported, and a person deciding
 * whether to run it again is deciding about a known cost, not an unknown one. */
type StoppedReading = Error & {
  readingOutcome: "failed";
  providerUsage: Record<string, unknown>;
  /* The answer as it arrived — incomplete, paid for, and kept. Publishing it
     as a schedule would present a truncated reading as a finished one; losing
     it throws away the only record of what the money bought. */
  providerRaw: Record<string, unknown> | null;
  durationMs: number | null;
  modelReported: string | null;
};

function readingStopped(
  message: string,
  usage: Record<string, unknown>,
  raw: Record<string, unknown> | null = null,
  durationMs: number | null = null,
  modelReported: string | null = null,
): StoppedReading {
  const error = new Error(message) as StoppedReading;
  error.readingOutcome = "failed";
  error.providerUsage = usage || {};
  error.providerRaw = raw;
  error.durationMs = durationMs;
  error.modelReported = modelReported || null;
  return error;
}

function stoppedReading(error: unknown): StoppedReading | null {
  return (error as StoppedReading)?.readingOutcome === "failed" ? error as StoppedReading : null;
}

function runAfterResponse(work: Promise<unknown>) {
  const runtime = (globalThis as Record<string, any>).EdgeRuntime;
  const settled = work.catch((error) => {
    console.error("background reading failed", error instanceof Error ? error.message : String(error));
  });
  if (runtime && typeof runtime.waitUntil === "function") runtime.waitUntil(settled);
  return settled;
}

const json = (request: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "project_summary", "source_register", "levels", "spaces", "space_links", "framing_walls", "framing_decks",
    "component_schedules", "structural_members", "framing_defaults", "systems", "phases", "capture_requirements", "gaps", "assumptions",
  ],
  properties: {
    project_summary: { type: "string" },
    source_register: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["document_id", "title", "document_type", "revision", "issued_date", "sheets", "notes"],
        properties: {
          document_id: { type: "string" },
          title: { type: "string" },
          document_type: { type: "string" },
          revision: { type: ["string", "null"] },
          issued_date: { type: ["string", "null"] },
          sheets: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
        },
      },
    },
    levels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["building", "name", "source_refs"],
        properties: {
          building: { type: "string" },
          name: { type: "string" },
          source_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    spaces: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["building", "level", "name", "classification", "source_refs"],
        properties: {
          building: { type: "string" },
          level: { type: "string" },
          name: { type: "string" },
          classification: { type: "string" },
          source_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    /* How the rooms connect, which is what makes a plan set a building rather
       than a list. Only openings a sheet actually draws: a door is a fact on
       the sheet, "these rooms are probably next to each other" is not. */
    space_links: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "from_building", "from_level", "from_space_name",
          "to_building", "to_level", "to_space_name",
          "connection", "source_refs",
        ],
        properties: {
          from_building: { type: "string" },
          from_level: { type: "string" },
          from_space_name: { type: "string" },
          to_building: { type: "string" },
          to_level: { type: "string" },
          to_space_name: { type: "string" },
          connection: {
            type: "string",
            enum: ["door", "opening", "stairs", "corridor", "exterior_door", "other"],
          },
          source_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    /* Framed walls with their PRINTED dimensions, for the takeoff draft. Only
       what a sheet actually states: a dimension string, a stud callout, an
       opening width from the schedule. Measuring by scale is forbidden — a
       guess that looks like a measurement — and a wall with no printed length
       is reported with length "" so it lands in the gaps, never invented. */
    framing_walls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "label", "building", "level", "length", "height", "stud_size",
          "stud_spacing_inches", "corners", "intersections", "openings", "source_refs",
        ],
        properties: {
          label: { type: "string" },
          building: { type: "string" },
          level: { type: "string" },
          length: { type: "string" },
          height: { type: "string" },
          stud_size: { type: "string" },
          stud_spacing_inches: { type: ["number", "null"] },
          corners: { type: "integer" },
          intersections: { type: "integer" },
          openings: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "width", "source_refs"],
              properties: {
                label: { type: "string" },
                width: { type: "string" },
                source_refs: { type: "array", items: { type: "string" } },
              },
            },
          },
          source_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    /* Exterior decks and similar framed platforms. A deck's lumber is joists
       over an area, beams and posts on a pile grid, and a walking surface —
       none of which is a framed wall, and a schema that only knows walls read
       a nine-sheet deck set as "no framing dimensions".
       Counts of labelled members (P1 piles, COL.2 posts, BM.1 beams) are read
       by counting the marks drawn on the plan — that is reading the drawing,
       like counting corners. Lengths and areas remain printed-only. */
    framing_decks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "label", "building", "level", "length", "width", "area_sqft",
          "joist_size", "joist_spacing", "joist_treatment", "decking", "sheathing",
          "beams", "columns", "piles", "guardrail", "guardrail_length", "source_refs",
        ],
        properties: {
          label: { type: "string" },
          building: { type: "string" },
          level: { type: "string" },
          length: { type: "string" },
          width: { type: "string" },
          area_sqft: { type: "string" },
          joist_size: { type: "string" },
          joist_spacing: { type: "string" },
          joist_treatment: { type: "string" },
          decking: { type: "string" },
          /* A diaphragm or sheathing note is a printed spec: "DECK DIAPHRAGM
             TO BE 19/32" PLYWOOD" in the framing notes belongs here verbatim.
             Empty string when the sheets specify none. */
          sheathing: { type: "string" },
          /* count_drawn is a count the AI is certain of — certain enough to
             stand as a line. When certainty is out of reach, the AI still
             proposes its best count with the confidence and what blocked
             certainty, so a person reviews a proposal instead of being asked
             to measure the plans themselves. count_proposed 0 means the AI
             could not even propose. */
          beams: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["mark", "description", "count_drawn", "count_proposed", "count_confidence", "count_note"],
              properties: {
                mark: { type: "string" },
                description: { type: "string" },
                count_drawn: { type: "integer" },
                count_proposed: { type: "integer" },
                count_confidence: { type: "string", enum: ["high", "medium", "low", "none"] },
                count_note: { type: "string" },
              },
            },
          },
          columns: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["mark", "description", "count_drawn", "count_proposed", "count_confidence", "count_note"],
              properties: {
                mark: { type: "string" },
                description: { type: "string" },
                count_drawn: { type: "integer" },
                count_proposed: { type: "integer" },
                count_confidence: { type: "string", enum: ["high", "medium", "low", "none"] },
                count_note: { type: "string" },
              },
            },
          },
          piles: {
            type: "object",
            additionalProperties: false,
            required: ["description", "count_drawn", "count_proposed", "count_confidence", "count_note"],
            properties: {
              description: { type: "string" },
              count_drawn: { type: "integer" },
              count_proposed: { type: "integer" },
              count_confidence: { type: "string", enum: ["high", "medium", "low", "none"] },
              count_note: { type: "string" },
            },
          },
          guardrail: { type: "string" },
          guardrail_length: { type: "string" },
          source_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    /* The countable scope an architectural set states in its printed
       schedules — doors, windows, plumbing and electrical fixtures,
       equipment, appliances — the way a framing set states it in beam and
       pile schedules. A schedule row is the requirement; marks counted
       drawn on the plans corroborate it. Nothing here is ever measured by
       scale or derived from area: a count that is not printed or drawn
       does not exist. */
    component_schedules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "mark", "category", "description", "unit",
          "count_scheduled", "count_drawn", "count_proposed", "count_confidence", "count_note", "source_refs",
        ],
        properties: {
          mark: { type: "string" },
          category: {
            type: "string",
            enum: ["door", "window", "plumbing_fixture", "electrical_fixture", "electrical_device", "mechanical_equipment", "appliance", "other"],
          },
          description: { type: "string" },
          unit: { type: "string" },
          count_scheduled: { type: "integer" },
          count_drawn: { type: "integer" },
          count_proposed: { type: "integer" },
          count_confidence: { type: "string", enum: ["high", "medium", "low", "none"] },
          count_note: { type: "string" },
          source_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    /* The structural vocabulary: what a framing set states in its beam,
       header, joist, rafter, post, footing and hold-down schedules, one row
       per scheduled member — the way an architectural set states doors and
       windows. A schedule row is the requirement; marks counted drawn on
       the plans corroborate it. Nothing here is measured by scale. */
    structural_members: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "mark", "member_type", "description", "size", "spacing", "material", "level", "location",
          "count_scheduled", "count_drawn", "count_proposed", "count_confidence", "count_note",
          "counted", "plies", "size_basis",
          "length_printed", "unit", "detail_refs", "source_refs",
        ],
        properties: {
          mark: { type: "string" },
          member_type: {
            type: "string",
            enum: [
              "beam", "header", "joist", "rafter", "ridge", "post", "column", "stud", "blocking", "ledger",
              "strap", "holdown", "anchor", "shear_wall", "footing", "grade_beam", "pier", "slab", "other",
            ],
          },
          description: { type: "string" },
          size: { type: "string" },
          spacing: { type: "string" },
          material: { type: "string" },
          level: { type: "string" },
          location: { type: "string" },
          count_scheduled: { type: "integer" },
          count_drawn: { type: "integer" },
          count_proposed: { type: "integer" },
          count_confidence: { type: "string", enum: ["high", "medium", "low", "none"] },
          count_note: { type: "string" },
          /* What the number counts. A label is not a member, a framing zone
             is not a rafter, an assembly of two plies is one member with
             two pieces — the count says which, and nobody multiplies. */
          counted: { type: "string", enum: ["members", "labels", "zones", "assemblies", "none"] },
          plies: { type: "integer" },
          /* How the mark on the plan reached its size: its own schedule
             row, a printed rule the sheet states, only the plan's callout,
             or not resolved at all. */
          size_basis: { type: "string", enum: ["schedule_row", "printed_rule", "plan_label", "not_resolved"] },
          length_printed: { type: "string" },
          unit: { type: "string" },
          detail_refs: { type: "array", items: { type: "string" } },
          source_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    /* The printed general rules for members not individually scheduled —
       "ALL STUDS 2x4 #2 @ 16'' O.C. U.N.O." — each with its exception
       clause copied verbatim. A printed rule is a project requirement with
       its exception, never an assumption of ours. */
    framing_defaults: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rule", "kind", "applies_to", "exception", "source_refs"],
        properties: {
          rule: { type: "string" },
          kind: { type: "string", enum: ["studs", "plates", "sheathing", "blocking", "nailing", "headers", "joists", "rafters", "connectors", "lumber", "other"] },
          applies_to: { type: "string" },
          exception: { type: "string" },
          source_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    systems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "scope", "source_refs"],
        properties: {
          name: { type: "string" },
          scope: { type: "string" },
          source_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    phases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "name", "sequence", "objective", "starts_when", "ends_when", "concealment_risk", "source_refs"],
        properties: {
          code: { type: "string" },
          name: { type: "string" },
          sequence: { type: "integer" },
          objective: { type: "string" },
          starts_when: { type: "string" },
          ends_when: { type: "string" },
          concealment_risk: { type: "string" },
          source_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    capture_requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "phase_code", "title", "building", "level", "space_name", "system",
          "priority", "capture_type", "why", "instructions", "must_show",
          "completion_criteria", "before_concealment", "plan_refs",
          "source_document_ids", "evidence_tags",
        ],
        properties: {
          phase_code: { type: "string" },
          title: { type: "string" },
          building: { type: ["string", "null"] },
          level: { type: ["string", "null"] },
          space_name: { type: ["string", "null"] },
          system: { type: "string" },
          priority: { type: "string", enum: ["critical", "high", "normal"] },
          capture_type: { type: "string", enum: ["360", "photo", "video", "closeup", "document"] },
          why: { type: "string" },
          instructions: { type: "array", items: { type: "string" } },
          must_show: { type: "array", items: { type: "string" } },
          completion_criteria: { type: "array", items: { type: "string" } },
          before_concealment: { type: "string" },
          plan_refs: { type: "array", items: { type: "string" } },
          source_document_ids: { type: "array", items: { type: "string" } },
          evidence_tags: { type: "array", items: { type: "string" } },
        },
      },
    },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "question", "source_refs", "blocks_activation"],
        properties: {
          severity: { type: "string", enum: ["critical", "important", "informational"] },
          question: { type: "string" },
          source_refs: { type: "array", items: { type: "string" } },
          blocks_activation: { type: "boolean" },
        },
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
  },
};

type DocumentRow = {
  source_metadata?: { derived_from?: Record<string, unknown> } | null;
  id: string;
  organization_id: string;
  property_id: string;
  storage_path: string;
  storage_provider: string;
  storage_bucket: string | null;
  original_filename: string;
  byte_size: number | null;
  document_type: string;
  revision_label: string | null;
  issued_at: string | null;
};

function responseText(payload: Record<string, unknown>) {
  const direct = payload.output_text;
  if (typeof direct === "string" && direct) return direct;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output as Array<Record<string, unknown>>) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  throw new Error("OpenAI returned no structured output text");
}

function safeText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

type PlanJob = {
  id: string;
  organization_id: string;
  property_id: string;
  document_ids: string[];
  state: string;
  requested_by: string;
  provider: string | null;
  provider_job_id: string | null;
  /* The digest of the pages and enlargements this reading carried, and how
     many of them, recorded when the request went out. */
  image_fingerprint?: string | null;
  images_sent?: number | null;
  ai_run_id: string | null;
  model: string | null;
  baseline_id: string | null;
  progress_stage: string;
  progress_percent: number;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
};

function sameIds(left: string[] = [], right: string[] = []) {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((id) => expected.has(id));
}

function providerError(payload: Record<string, unknown>, fallback: string) {
  const error = payload.error as Record<string, unknown> | null;
  const incomplete = payload.incomplete_details as Record<string, unknown> | null;
  return safeText(error?.message, safeText(incomplete?.reason, fallback));
}

async function markJobFailed(admin: ReturnType<typeof createClient>, job: PlanJob, message: string) {
  const completedAt = new Date().toISOString();
  await admin.from("plan_analysis_jobs").update({
    state: "failed",
    progress_stage: "failed",
    error_code: /quota|rate limit/i.test(message) ? "provider_capacity" : "plan_analysis_failed",
    error_message: message,
    completed_at: completedAt,
    last_heartbeat_at: completedAt,
  }).eq("id", job.id);
  const retryableInput = /49 MB|input limit/i.test(message);
  await admin.from("project_documents").update({
    status: retryableInput ? "uploaded" : "failed",
    processing_error: message,
    updated_at: completedAt,
  }).in("id", job.document_ids);
  await admin.from("properties").update({ workflow_state: "intake" }).eq("id", job.property_id);
}

async function completeSavedBaseline(
  admin: ReturnType<typeof createClient>,
  job: PlanJob,
  baseline: { id: string; version: number },
) {
  const completedAt = new Date().toISOString();
  await admin.from("plan_analysis_jobs").update({
    state: "completed",
    baseline_id: baseline.id,
    progress_stage: "completed",
    progress_percent: 100,
    error_code: null,
    error_message: null,
    completed_at: completedAt,
    last_heartbeat_at: completedAt,
  }).eq("id", job.id);
  await admin.from("project_documents").update({
    status: "ready",
    processing_error: null,
    updated_at: completedAt,
  }).in("id", job.document_ids);
  await admin.from("properties").update({ workflow_state: "baseline_review" }).eq("id", job.property_id);
  return { job_id: job.id, baseline_id: baseline.id, version: baseline.version, state: "completed", recovered: true };
}

async function recoverCompletedBaseline(admin: ReturnType<typeof createClient>, job: PlanJob) {
  if (!job.started_at) return null;
  const { data: candidates } = await admin
    .from("document_baselines")
    .select("id, version, source_document_ids, created_at")
    .eq("organization_id", job.organization_id)
    .eq("property_id", job.property_id)
    .gte("created_at", job.started_at)
    .order("version", { ascending: false })
    .limit(5);
  const baseline = (candidates || []).find((item) => sameIds(item.source_document_ids || [], job.document_ids));
  if (!baseline) return null;
  const [phaseCount, requirementCount, taskCount] = await Promise.all([
    admin.from("construction_phases").select("id", { count: "exact", head: true }).eq("baseline_id", baseline.id),
    admin.from("capture_requirements").select("id", { count: "exact", head: true }).eq("baseline_id", baseline.id),
    admin.from("capture_tasks").select("id", { count: "exact", head: true }).eq("baseline_id", baseline.id),
  ]);
  if (!phaseCount.count || !requirementCount.count || taskCount.count !== requirementCount.count) return null;
  return completeSavedBaseline(admin, job, baseline);
}

/* A finished reading, put back together from its saved parts.
 *
 * The parts are the paid readings of each chunk, saved as they came back.
 * The baseline was made from them by one deterministic merge, and when that
 * merge is corrected — as it was when it stopped carrying the component
 * schedules — the same parts can be merged again without reading a page or
 * spending anything. The result is a new baseline version made by the very
 * finalize an ordinary reading ends with, under a job of its own that says
 * what it was rebuilt from. The original job and its parts are not touched:
 * they are the record of what the provider actually answered.
 *
 * Nothing here is a provider call, so nothing here goes through the ledger.
 * A failure marks only the rebuild's own job, never the reading it came from. */
async function rebuildFromSavedReadings(
  admin: ReturnType<typeof createClient>,
  userClient: ReturnType<typeof createClient>,
  source: PlanJob,
  userId: string,
  transport: ProviderTransport,
): Promise<{ body: Record<string, unknown>; status: number }> {
  const { data: chunks } = await admin.from("plan_analysis_chunks")
    .select("id, chunk_index, state, analysis, document_ids")
    .eq("job_id", source.id).order("chunk_index", { ascending: true });
  const verdict = rebuildableFrom(source, chunks || []);
  if (!verdict.ok) return { body: { error: verdict.reason, job_id: source.id }, status: 409 };

  const { data: documents, error: documentError } = await userClient
    .from("project_documents")
    .select("id, organization_id, property_id, storage_path, storage_provider, storage_bucket, original_filename, byte_size, document_type, revision_label, issued_at, source_metadata")
    .in("id", source.document_ids)
    .eq("organization_id", source.organization_id)
    .eq("property_id", source.property_id);
  if (documentError || !documents || documents.length !== source.document_ids.length) {
    return { body: { error: "One or more of the documents this reading was made from are no longer in this project; the saved parts cannot be placed.", job_id: source.id }, status: 409 };
  }
  const orderedDocuments = orderForReading(source.document_ids
    .map((id) => (documents as DocumentRow[]).find((row) => row.id === id))
    .filter(Boolean) as DocumentRow[]);
  const documentsById = new Map(orderedDocuments.map((row) => [row.id, row]));
  const chunkDocuments = (chunks || []).map((chunk) => ((chunk.document_ids || []) as string[]).map((id) => documentsById.get(id)).filter(Boolean) as DocumentRow[]);
  const merged = mergeChunkAnalyses(
    (chunks || []).map((chunk) => chunk.analysis),
    (chunks || []).map((chunk) => ({
      chunk_index: chunk.chunk_index,
      documents: ((chunk.document_ids || []) as string[]).map((id) => documentsById.get(id)).filter(Boolean)
        .map((row) => ({ id: row!.id, filename: row!.original_filename, part_of: row!.source_metadata?.derived_from || null })),
    })),
  );

  const startedAt = new Date().toISOString();
  const { data: rebuildJob, error: jobError } = await admin.from("plan_analysis_jobs").insert({
    organization_id: source.organization_id,
    property_id: source.property_id,
    document_ids: source.document_ids,
    state: "processing",
    requested_by: userId,
    provider: source.provider,
    model: source.model,
    progress_stage: "rebuilding",
    progress_percent: 80,
    started_at: startedAt,
    last_heartbeat_at: startedAt,
  }).select("id, organization_id, property_id, document_ids, state, requested_by, provider, provider_job_id, model, baseline_id, progress_stage, progress_percent, started_at, completed_at, error_code, error_message, ai_run_id, image_fingerprint, images_sent").single();
  if (jobError || !rebuildJob) return { body: { error: "The rebuild could not be recorded as a job", job_id: source.id }, status: 500 };

  try {
    const result = await finalizeAnalysis(
      admin, rebuildJob as PlanJob, orderedDocuments,
      withGaps(merged, await tileCoverageGapsFor(admin, chunkDocuments, readingImageBudget(transport.provider))),
      transport, userId,
      /* A rebuild reads the saved answers again; no provider call is made,
         so this one really did cost nothing. */
      { ...runMetrics(transport, {}, 0), cost_usd: 0, price_note: "Rebuilt from readings already paid for — no provider call was made.", rebuilt_from_job: source.id },
    );
    await admin.from("audit_events").insert({
      organization_id: source.organization_id,
      actor_id: userId,
      action: "document_baseline.rebuilt_from_saved_readings",
      entity_type: "document_baseline",
      entity_id: result.baseline_id,
      detail: {
        rebuilt_from_job_id: source.id,
        rebuild_job_id: rebuildJob.id,
        parts: verdict.parts,
        version: result.version,
        provider_calls: 0,
      },
    });
    return { body: { ...result, rebuilt_from_job_id: source.id, parts: verdict.parts, provider_calls: 0 }, status: 200 };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The saved parts could not be rebuilt";
    await markJobFailed(admin, rebuildJob as PlanJob, message);
    return { body: { error: message, job_id: source.id, rebuild_job_id: rebuildJob.id }, status: 500 };
  }
}

/* What one reading cost and how long it took, gathered from the chunks that
   made it. Cost is null — never zero — where the model's published price
   could not be confirmed or the provider reported no usage. */
async function chunkRunMetrics(
  admin: ReturnType<typeof createClient>,
  jobId: string,
  transport: ProviderTransport,
) {
  const { data: chunkRows } = await admin.from("plan_analysis_chunks")
    .select("id, chunk_index, image_fingerprint, images_sent")
    .eq("job_id", jobId).order("chunk_index", { ascending: true });
  const { data: runs } = await admin.from("ai_runs")
    .select("input_tokens, output_tokens, total_tokens, duration_ms, usage_available")
    .eq("job_table", "plan_analysis_chunks")
    .in("job_id", (chunkRows || []).map((row) => row.id));
  const usage = (runs || []).reduce((sum, run) => ({
    input_tokens: sum.input_tokens + (Number(run.input_tokens) || 0),
    output_tokens: sum.output_tokens + (Number(run.output_tokens) || 0),
  }), { input_tokens: 0, output_tokens: 0 });
  const durationMs = (runs || []).reduce((sum, run) => sum + (Number(run.duration_ms) || 0), 0);
  const reported = (runs || []).some((run) => run.usage_available);
  /* The kit of a chunked reading is the kits of its chunks in order. Two
     readings of one set carried the same drawings only if this matches. */
  return runMetrics(transport, reported ? usage : {}, durationMs, {
    fingerprint: (chunkRows || []).map((row) => row.image_fingerprint || "?").join("+"),
    images_sent: (chunkRows || []).reduce((sum, row) => sum + (Number(row.images_sent) || 0), 0),
    documents_sent: 0,
  });
}

function runMetrics(
  transport: ProviderTransport,
  usage: Record<string, unknown>,
  durationMs: number,
  manifest: ReadingManifestRecord | null = null,
) {
  const cost = usageCost(transport.model, usage);
  return {
    provider: transport.provider,
    provider_label: PROVIDERS[transport.provider].label,
    model: transport.model.id,
    model_label: transport.model.label,
    /* How many enlargements a reading carries — the same for every reader,
       so three readings of one set are three readings of the same drawings. */
    image_budget: readingImageBudget(transport.provider),
    /* Two readings asked to think differently are not the same reading, so
       what each was told is recorded beside what it cost. */
    reasoning_effort: readingEffort(transport.provider),
    max_output_tokens: MAX_READING_OUTPUT_TOKENS,
    agent_contract_version: AGENT_CONTRACT_VERSION,
    /* And the digest of the pages and enlargements this reading actually
       carried, so "they were given the same kit" can be checked against the
       record instead of assumed. */
    image_fingerprint: manifest?.fingerprint || null,
    images_sent: manifest?.images_sent ?? null,
    usage,
    duration_ms: durationMs || null,
    ...cost,
  };
}

async function finalizeAnalysis(
  admin: ReturnType<typeof createClient>,
  job: PlanJob,
  documents: DocumentRow[],
  analysis: Record<string, any>,
  transport: ProviderTransport,
  userId: string,
  metrics: Record<string, unknown>,
) {
  if (!Array.isArray(analysis.phases) || !analysis.phases.length) {
    throw new Error("The supplied documents did not support a construction evidence phase. Add the governing plan sheets and retry.");
  }
  if (!Array.isArray(analysis.capture_requirements) || !analysis.capture_requirements.length) {
    throw new Error("The supplied documents did not support an actionable capture roadmap. Add the governing plan sheets and retry.");
  }

  const validDocumentIds = new Set(documents.map((item) => item.id));
  for (const requirement of analysis.capture_requirements) {
    requirement.source_document_ids = (requirement.source_document_ids || []).filter((id: string) => validDocumentIds.has(id));
    if (!requirement.source_document_ids.length) requirement.source_document_ids = [...validDocumentIds];
  }

  const { data: claimed } = await admin.from("plan_analysis_jobs").update({
    progress_stage: "finalizing",
    progress_percent: 90,
    last_heartbeat_at: new Date().toISOString(),
  }).eq("id", job.id).eq("state", "processing").neq("progress_stage", "finalizing").select("id").maybeSingle();
  if (!claimed) return { job_id: job.id, state: "processing", progress_stage: "finalizing", progress_percent: 90 };

  let createdBaselineId = "";
  try {
    const { data: versionRows } = await admin
      .from("document_baselines")
      .select("version")
      .eq("property_id", job.property_id)
      .order("version", { ascending: false })
      .limit(1);
    const version = (versionRows?.[0]?.version || 0) + 1;
    const { data: baseline, error: baselineError } = await admin
      .from("document_baselines")
      .insert({
        organization_id: job.organization_id,
        property_id: job.property_id,
        version,
        state: "review",
        source_document_ids: job.document_ids,
        project_summary: analysis.project_summary,
        analysis,
        gaps: analysis.gaps,
        model: transport.model.id,
        provider: transport.provider,
        analysis_run: metrics,
        agent_key: "plan_interpreter",
        agent_contract_version: AGENT_CONTRACT_VERSION,
        created_by: userId,
      })
      .select("id")
      .single();
    if (baselineError || !baseline) throw baselineError || new Error("Could not create baseline");
    createdBaselineId = baseline.id;

    const spaceRows = analysis.spaces.map((space: Record<string, unknown>) => ({
      organization_id: job.organization_id,
      property_id: job.property_id,
      baseline_id: baseline.id,
      building: safeText(space.building, "Main Building"),
      level: safeText(space.level, "Unassigned level"),
      name: safeText(space.name, "Unassigned space"),
      classification: safeText(space.classification, "room"),
      source_refs: space.source_refs,
    }));
    const { data: insertedSpaces, error: spacesError } = spaceRows.length
      ? await admin.from("plan_spaces").insert(spaceRows).select("id, building, level, name")
      : { data: [], error: null };
    if (spacesError) throw spacesError;

    /* How the rooms connect. The pair is the identity of an opening, so it is
       normalised here rather than trusted: the smaller id first, and a door
       named twice from either side is one row. A link naming a room that is
       not in this baseline is dropped — silently connecting it to the nearest
       similar name is exactly the believable wrong this product refuses. */
    const spaceKeyOf = (building: unknown, level: unknown, name: unknown) =>
      `${safeText(building, "").toLowerCase()}|${safeText(level, "").toLowerCase()}|${safeText(name, "").toLowerCase()}`;
    const idByKey = new Map(
      (insertedSpaces || []).map((space) => [spaceKeyOf(space.building, space.level, space.name), space.id]),
    );
    const linkRows: Array<Record<string, unknown>> = [];
    const seenLinks = new Set<string>();
    const rawLinks = Array.isArray(analysis.space_links) ? analysis.space_links : [];
    let unresolvedLinks = 0;
    for (const link of rawLinks as Array<Record<string, unknown>>) {
      const fromId = idByKey.get(spaceKeyOf(link.from_building, link.from_level, link.from_space_name));
      const toId = idByKey.get(spaceKeyOf(link.to_building, link.to_level, link.to_space_name));
      if (!fromId || !toId || fromId === toId) { unresolvedLinks += 1; continue; }
      const low = fromId < toId ? fromId : toId;
      const high = fromId < toId ? toId : fromId;
      const connection = safeText(link.connection, "opening");
      const key = `${low}|${high}|${connection}`;
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
      linkRows.push({
        organization_id: job.organization_id,
        property_id: job.property_id,
        baseline_id: baseline.id,
        from_plan_space_id: low,
        to_plan_space_id: high,
        connection,
        source_refs: Array.isArray(link.source_refs) ? link.source_refs : [],
      });
    }
    if (linkRows.length) {
      const { error: linksError } = await admin.from("plan_space_links").insert(linkRows);
      if (linksError) throw linksError;
    }

    const phaseRows = analysis.phases.map((phase: Record<string, unknown>) => ({
      organization_id: job.organization_id,
      property_id: job.property_id,
      baseline_id: baseline.id,
      code: phase.code,
      name: phase.name,
      sequence: phase.sequence,
      objective: phase.objective,
      starts_when: phase.starts_when,
      ends_when: phase.ends_when,
      concealment_risk: phase.concealment_risk,
      source_refs: phase.source_refs,
    }));
    const { data: insertedPhases, error: phasesError } = await admin
      .from("construction_phases")
      .insert(phaseRows)
      .select("id, code");
    if (phasesError || !insertedPhases) throw phasesError || new Error("Could not create phases");

    const phaseByCode = new Map(insertedPhases.map((phase) => [phase.code, phase.id]));

    const requirementRows = analysis.capture_requirements.flatMap((requirement: Record<string, unknown>) => {
      const phaseId = phaseByCode.get(requirement.phase_code);
      if (!phaseId) return [];
      const planSpaceId = requirement.space_name
        ? idByKey.get(spaceKeyOf(requirement.building, requirement.level, requirement.space_name)) || null
        : null;
      return [{
        organization_id: job.organization_id,
        property_id: job.property_id,
        baseline_id: baseline.id,
        phase_id: phaseId,
        plan_space_id: planSpaceId,
        title: requirement.title,
        system: requirement.system,
        priority: requirement.priority,
        capture_type: requirement.capture_type,
        rationale: requirement.why,
        instructions: requirement.instructions,
        must_show: requirement.must_show,
        acceptance_criteria: requirement.completion_criteria,
        before_concealment: requirement.before_concealment,
        plan_refs: requirement.plan_refs,
        source_document_ids: requirement.source_document_ids,
        evidence_tags: requirement.evidence_tags,
      }];
    });
    const { data: insertedRequirements, error: requirementError } = requirementRows.length
      ? await admin.from("capture_requirements").insert(requirementRows).select("id")
      : { data: [], error: null };
    if (requirementError) throw requirementError;

    if (insertedRequirements?.length) {
      const { error: tasksError } = await admin.from("capture_tasks").insert(
        insertedRequirements.map((requirement) => ({
          organization_id: job.organization_id,
          property_id: job.property_id,
          baseline_id: baseline.id,
          requirement_id: requirement.id,
          status: "blocked",
        })),
      );
      if (tasksError) throw tasksError;
    }

    const result = await completeSavedBaseline(admin, job, { id: baseline.id, version });
    await admin.from("audit_events").insert({
      organization_id: job.organization_id,
      actor_id: userId,
      action: "plan_analysis.completed",
      entity_type: "document_baseline",
      entity_id: baseline.id,
      detail: {
        property_id: job.property_id,
        version,
        document_ids: job.document_ids,
        provider: transport.provider,
        model: transport.model.id,
        space_links: linkRows.length,
        space_links_unresolved: unresolvedLinks,
        agent_key: "plan_interpreter",
        collaborating_agents: ["document_controller", "capture_planner", "verification_guard"],
        agent_contract_version: AGENT_CONTRACT_VERSION,
        decision_route: "copilot",
        execution: "background_polling",
      },
    });
    createdBaselineId = "";
    return { ...result, recovered: false };
  } catch (error) {
    if (createdBaselineId) await admin.from("document_baselines").delete().eq("id", createdBaselineId);
    throw error;
  }
}

/* What each reading of this job could not see at drawing-desk resolution,
   as gaps the result keeps. Computed the same way the request was composed,
   per reading, so a rebuild from saved readings says it too — the saved
   readings were made with the same budget. */
async function tileCoverageGapsFor(
  admin: ReturnType<typeof createClient>,
  readings: DocumentRow[][],
  imageBudget = MAX_RENDER_IMAGES,
) {
  const gaps: Array<Record<string, unknown>> = [];
  for (const documents of readings) {
    const withTiles: Array<{ id: string; filename: string; tiles: Array<{ name: string; page: number }> }> = [];
    for (const row of documents) withTiles.push({ id: row.id, filename: row.original_filename, tiles: await listPageTiles(admin, row) });
    gaps.push(...tileCoverageGaps(tileCoverage(withTiles, imageBudget).coverage, imageBudget));
  }
  return gaps;
}
function withGaps(analysis: Record<string, any>, gaps: Array<Record<string, unknown>>) {
  if (!gaps.length) return analysis;
  return { ...analysis, gaps: [...(Array.isArray(analysis.gaps) ? analysis.gaps : []), ...gaps] };
}

/* One provider reading: sign the given documents, gather their high-res
   tiles, compose the request, launch it as a background response. Shared by
   the single-shot path and by every chunk of a large set — a chunk is not a
   different kind of analysis, it is the same reading over fewer files. */
/* Every reader gets the same reading.
 *
 * The pages, the enlargements in their order, the register, the task and the
 * result schema are assembled once, here, and handed to whichever provider
 * was chosen. What differs downstream is only the envelope each API wants. */
async function buildReadingContent(
  admin: ReturnType<typeof createClient>,
  documents: DocumentRow[],
  registerText: string,
  chunkNote: string | null,
  /* Each reader's own limit on enlargements, recorded with the reading so
     two readings taken under different budgets are never called equal. */
  imageBudget = MAX_RENDER_IMAGES,
): Promise<{ content: ReadingContent; unseen: string[]; manifest: ReadingManifestRecord }> {
  /* The pages and the enlargements come from the one place that gathers
     them, so a later check of this reading looks at exactly what the reader
     looked at — and the fingerprint of what was sent travels with it. */
  const assets = await gatherReadingAssets(admin, documents, imageBudget);
  return {
    manifest: {
      fingerprint: assets.fingerprint,
      images_sent: assets.imagesSent,
      documents_sent: assets.documents.length,
    },
    content: {
      instructions: PLAN_WORKFLOW_INSTRUCTIONS,
      taskText: `Analyze this project document set. Database source register:\n${registerText}`,
      registerText,
      chunkNote,
      imageNote: assets.imageNote,
      documents: assets.documents,
      images: assets.images,
      schema,
      maxOutputTokens: MAX_READING_OUTPUT_TOKENS,
    },
    unseen: assets.unseen,
  };
}

/* One reading, launched or run.
 *
 * A background provider answers with an identifier and is retrieved later.
 * A synchronous provider answers here, inside this invocation — so its
 * answer, its usage and its raw payload come back together. */
type ReadingManifestRecord = { fingerprint: string; images_sent: number; documents_sent: number };

type ProviderReading =
  | { kind: "background"; id: string; status: string; manifest: ReadingManifestRecord }
  | {
    manifest: ReadingManifestRecord;
    kind: "sync";
    analysis: Record<string, unknown>;
    raw: Record<string, unknown>;
    usage: Record<string, unknown>;
    modelReported: string;
    durationMs: number;
  };

async function createProviderReading(
  admin: ReturnType<typeof createClient>,
  transport: ProviderTransport,
  documents: DocumentRow[],
  registerText: string,
  chunkNote: string | null,
  /* Marked as the request moves, so the caller's catch can tell a launch that
     never left the building from one that may have created — and started
     billing — a reading we then lost the handle to. */
  progress?: RunProgress,
): Promise<ProviderReading> {
  const { content, manifest } = await buildReadingContent(
    admin, documents, registerText, chunkNote, readingImageBudget(transport.provider));

  /* A reading this reader cannot be asked for honestly is refused before it
     is bought, with the reason and the way round it. */
  const refusal = readingRefusal(transport, content);
  if (refusal) throw new Error(refusal);

  if (transport.mode === "background") {
    progress?.sent();
    const response = await fetch(`${transport.baseUrl}/responses`, {
      method: "POST",
      headers: transport.headers,
      body: JSON.stringify(openAIRequestBody(transport, content)),
    });
    const payload = await response.json();
    if (!response.ok) {
      /* A rejected request created nothing. A 5xx or a rate limit may have
         created a background response whose id we never saw. */
      if (outcomeForStatus(response.status) === "failed") progress?.refused();
      throw new Error(payload?.error?.message || `${PROVIDERS[transport.provider].label} request failed (${response.status})`);
    }
    if (!payload?.id) throw new Error(`${PROVIDERS[transport.provider].label} did not return a background response identifier`);
    return { kind: "background", id: String(payload.id), status: String(payload.status || ""), manifest };
  }

  /* Synchronous readers. Neither is given the bytes in the request: Claude
     is given the signed URLs and fetches them itself; Gemini, which will not
     fetch a URL, gets a copy of each asset uploaded to its file store first
     and deleted again below. Both mean the request body is small and this
     function never holds a chunk in memory.

     The deadline is the worker's, not the request's — this runs after the
     response has already gone back — and a request cut off at the deadline
     may already have run and been billed, which is why it is reported as an
     unknown outcome and never quietly retried. */
  /* A reading is never started on a worker without the life left to finish
     it. Half a reading costs what a whole one costs. */
  const room = workerRoom();
  if (!room.enough) {
    throw new Error(
      `NOT_ENOUGH_WORKER_TIME: this worker has ${Math.round(room.remaining_ms / 1000)} seconds of its `
      + `${Math.round(WORKER_WALL_CLOCK_MS / 1000)} second life left, which is not enough to finish a reading. `
      + "Nothing was sent and nothing was bought; the next poll starts it on a worker with room.",
    );
  }
  const uploads: UploadedAsset[] = [];
  const startedAt = Date.now();
  const controller = new AbortController();
  /* Bounded by whichever runs out first: the reading's own ceiling, or this
     worker's remaining life. `waitUntil` holds the worker open; it does not
     make it immortal. */
  const deadlineMs = Math.min(SYNC_READING_TIMEOUT_MS, room.remaining_ms);
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    if (transport.provider === "google") {
      for (const asset of [...content.documents, ...content.images]) {
        uploads.push(await uploadToGoogle(transport, asset));
      }
      await waitForGoogleFiles(transport, uploads);
    }
    const request = syncRequest(transport, content, uploads);
    progress?.sent();
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: "POST",
        headers: transport.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `${PROVIDERS[transport.provider].label} did not answer within ${Math.round(deadlineMs / 1000)} seconds. `
          + "The request was sent, so it may already have run and been billed — running it again needs confirmation.",
        );
      }
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (outcomeForStatus(response.status) === "failed") progress?.refused();
      throw new Error(providerErrorMessage(transport.provider, payload, `${PROVIDERS[transport.provider].label} request failed (${response.status})`));
    }
    const answer = readAnswer(transport.provider, payload);
    if (/max_tokens|MAX_TOKENS|length/i.test(answer.stopReason || "")) {
      /* This is a finished call, not a lost one. The provider answered, we
         hold the answer and its usage, and we know exactly why it is short.
         Calling that an unknown outcome would put a warning on the screen
         about a billing question nobody has — and hide the real cause. */
      /* WHERE THE CEILING WENT.
       *
       * Anthropic bills thinking as output and counts it against max_tokens,
       * but reports no separate thinking count — so the only way to see the
       * split is to measure it: the billed output tokens against the answer
       * text that actually arrived. A reading that spent 32,000 tokens and
       * produced 6,000 tokens of JSON spent the rest reasoning, and that is
       * a measurement from this call, not a claim from a document. */
      const produced = String(answer.text || "");
      const spent = Number(answer.usage?.output_tokens);
      throw readingStopped(
        `${PROVIDERS[transport.provider].label} reached this reading's output limit of `
        + `${MAX_READING_OUTPUT_TOKENS.toLocaleString("en-US")} tokens before the answer was complete `
        + `(${Number.isFinite(spent) ? spent.toLocaleString("en-US") : "an unreported number of"} output tokens billed, `
        + `thinking included, against ${produced.length.toLocaleString("en-US")} characters of answer text). `
        + "The incomplete answer is kept with this reading so it can be examined; it is not a schedule and was not saved as one. "
        + "This is a limit of how the reading was asked for, not a judgement of how the plans were read.",
        answer.usage,
        payload as Record<string, unknown>,
        Date.now() - startedAt,
        answer.modelReported,
      );
    }
    let analysis: Record<string, unknown>;
    try {
      analysis = JSON.parse(answer.text);
    } catch {
      throw new Error(
        `${PROVIDERS[transport.provider].label} answered with something that is not the agreed result format. `
        + "The raw answer is kept with the run so it can be read.",
      );
    }
    return {
      kind: "sync",
      manifest,
      analysis,
      raw: payload as Record<string, unknown>,
      usage: answer.usage,
      modelReported: answer.modelReported,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    /* The copies exist only for the length of the reading. Google deletes an
       undeleted file after 48 hours; this is what makes that irrelevant. */
    if (uploads.length) await releaseGoogleFiles(transport, uploads);
  }
}

/* One reading of one set of documents. A chunk is the same reading over
   fewer files, so the chunk index belongs in the fingerprint: chunk 2 is not
   a duplicate of chunk 1, and paying for both is correct. */
function planFingerprintParts(
  job: { organization_id: string; property_id: string },
  provider: ProviderKey,
  model: string,
  documents: DocumentRow[],
  chunkIndex: number | null,
) {
  return {
    organizationId: job.organization_id,
    propertyId: job.property_id,
    processKey: "plan-analyze" as const,
    model,
    contractVersion: AGENT_CONTRACT_VERSION,
    inputs: documents.map((row) => `${row.id}@${row.revision_label || ""}@${row.issued_at || ""}`),
    /* The provider is part of what was bought: the same files read by two
       providers are two readings, and neither is a duplicate of the other. */
    settings: { chunk: chunkIndex === null ? "single" : String(chunkIndex), provider },
  };
}

/* The next pending chunk starts, claimed atomically so two concurrent polls
   never buy the same reading twice. Returns the launched chunk row or null
   when another poll got there first (or nothing is pending). */
async function launchNextPendingChunk(
  admin: ReturnType<typeof createClient>,
  transport: ProviderTransport,
  job: PlanJob,
  orderedDocuments: DocumentRow[],
  chunkTotal: number,
) {
  const documentsById = new Map(orderedDocuments.map((row) => [row.id, row]));
  const { data: pending } = await admin.from("plan_analysis_chunks")
    .select("id, chunk_index, document_ids")
    .eq("job_id", job.id).eq("state", "pending")
    .order("chunk_index", { ascending: true }).limit(1).maybeSingle();
  if (!pending) return null;
  const { data: claimed } = await admin.from("plan_analysis_chunks")
    .update({ state: "processing", updated_at: new Date().toISOString() })
    .eq("id", pending.id).eq("state", "pending").select("id, chunk_index, document_ids").maybeSingle();
  if (!claimed) return null;
  const chunkDocuments = (claimed.document_ids as string[]).map((id) => documentsById.get(id)).filter(Boolean) as DocumentRow[];
  const attachedIds = new Set(chunkDocuments.map((row) => row.id));
  /* Each chunk is told which documents it holds and which are being read by
     the other chunks of this same reading — so a file it cannot see is a
     file being read, not a file to ask for. */
  const registerText = JSON.stringify(chunkRegister(orderedDocuments, claimed.document_ids as string[], claimed.chunk_index, chunkTotal), null, 2);
  const note = chunkNote(claimed.chunk_index, chunkTotal, chunkDocuments,
    orderedDocuments.filter((row) => !attachedIds.has(row.id)));
  const ledger = await claimAiRun(admin, {
    ...planFingerprintParts(job, transport.provider, transport.model.id, chunkDocuments, claimed.chunk_index),
    jobTable: "plan_analysis_chunks",
    jobId: claimed.id,
    transport: transport.transport,
    /* A chunk relaunched after a failure is the same purchase the person
       already asked for, so it is allowed through rather than refused as a
       duplicate of the failed one. */
    force: true,
  });

  /* Two attempts at most, and the second only when the provider refused
     the first before reading anything because it could not fetch our
     files in time — a refusal, not a lost answer, so nothing was billed. */
  const readChunk = async () => {
    let attempt = 0;
    let progress = new RunProgress();
    let lastError: unknown = null;
    while (attempt < 2) {
      attempt += 1;
      progress = new RunProgress();
      try {
        const reading = await createProviderReading(
          admin, transport, chunkDocuments, registerText, note, progress);
        if (reading.kind === "background") {
          await admin.from("plan_analysis_chunks").update({
            provider_job_id: reading.id,
            ai_run_id: ledger.runId,
            image_fingerprint: reading.manifest.fingerprint,
            images_sent: reading.manifest.images_sent,
            updated_at: new Date().toISOString(),
          }).eq("id", claimed.id);
          return;
        }
        /* A synchronous provider has already answered. The chunk is a
           checkpoint the moment its reading is saved — raw payload included,
           so what the model returned and what this app made of it stay
           separable. */
        await finishAiRun(admin, ledger.runId, "succeeded", reading.usage, null);
        await admin.from("plan_analysis_chunks").update({
          state: "complete",
          analysis: reading.analysis,
          provider_raw: reading.raw,
          provider_job_id: null,
          ai_run_id: ledger.runId,
          image_fingerprint: reading.manifest.fingerprint,
          images_sent: reading.manifest.images_sent,
          duration_ms: reading.durationMs,
          model_reported: reading.modelReported || null,
          error_message: null,
          updated_at: new Date().toISOString(),
        }).eq("id", claimed.id);
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (retryableLaunchRefusal(message, progress.outcome(), attempt)) {
          console.warn(`Chunk ${claimed.chunk_index + 1}: the provider could not fetch the files in time; trying once more`, message.slice(0, 120));
          await new Promise((resolve) => setTimeout(resolve, 4000));
          continue;
        }
        break;
      }
    }
    const error = lastError;
    const message = String(error instanceof Error ? error.message : error);
    /* A reading refused because this worker was too near the end of its own
       life was never sent. Nothing was bought, so the chunk simply goes back
       to pending and the next poll starts it on a worker with room. */
    if (/^NOT_ENOUGH_WORKER_TIME/.test(message)) {
      await finishAiRun(admin, ledger.runId, "failed", {}, "worker_out_of_time");
      await admin.from("plan_analysis_chunks").update({
        state: "pending", provider_job_id: null, error_message: null,
        updated_at: new Date().toISOString(),
      }).eq("id", claimed.id);
      console.warn(`Chunk ${claimed.chunk_index + 1}: ${message}`);
      return;
    }
    /* A reading that timed out mid-flight was sent and may be billed, even
       though nothing came back. It is an unknown outcome, not a free retry.
       A reading that answered and was cut short by its own output ceiling is
       neither: it is a known failure with known usage. */
    const stopped = stoppedReading(error);
    const outcome = stopped
      ? stopped.readingOutcome
      : /may already have run and been billed/i.test(message) ? "outcome_unknown" : progress.outcome();
    await finishAiRun(admin, ledger.runId, outcome, stopped?.providerUsage || {}, message.slice(0, 200));
    /* A launch that never left the building costs nothing, so the chunk goes
       back to pending and a later poll retries it. A launch whose answer was
       lost may already have created a billed reading — requeueing that would
       buy the same chunk twice, which is the whole point of this state. */
    await admin.from("plan_analysis_chunks").update({
      /* A stopped reading stays failed with its evidence attached; only a
         launch that never left the building goes back to pending. */
      state: outcome === "outcome_unknown" || stopped ? "failed" : "pending",
      provider_job_id: null,
      ...(stopped
        ? {
          provider_raw: stopped.providerRaw,
          duration_ms: stopped.durationMs,
          model_reported: stopped.modelReported,
        }
        : {}),
      error_message: (outcome === "outcome_unknown"
        ? "This chunk was sent to the provider and its answer was lost. It may already have run and been billed — confirm before running it again. "
        : "") + message.slice(0, 600),
      updated_at: new Date().toISOString(),
    }).eq("id", claimed.id);
    throw error;
  };

  if (transport.mode === "sync") {
    /* Claude and Gemini answer in minutes, and no HTTP request lives that
       long here. The chunk is marked as held by this worker and the reading
       runs on after the response has gone back; the Studio's poll reads the
       result off the chunk row when it lands. Nothing is awaited that the
       gateway would cut. */
    await admin.from("plan_analysis_chunks").update({
      provider_job_id: INLINE_CHUNK_HANDLE,
      ai_run_id: ledger.runId,
      updated_at: new Date().toISOString(),
    }).eq("id", claimed.id);
    runAfterResponse(readChunk());
    return claimed;
  }
  await readChunk();
  return claimed;
}

/* One poll of a chunked job: read where the chunks stand, advance exactly
   one step (poll the running chunk, launch the next, or merge and finalize),
   and answer with honest progress. Every step is idempotent and every
   finished chunk is a checkpoint that survives a failure. */
async function advanceChunkedJob(
  admin: ReturnType<typeof createClient>,
  userClient: ReturnType<typeof createClient>,
  transport: ProviderTransport,
  job: PlanJob,
  userId: string,
  chunks: Array<Record<string, any>>,
) {
  const total = chunks.length;
  const completeCount = chunks.filter((chunk) => chunk.state === "complete").length;
  const progress = () => ({
    job_id: job.id,
    state: "processing",
    progress_stage: "reading_documents",
    progress_percent: 20 + Math.floor(60 * (completeCount / total)),
    chunks: total,
    chunks_complete: completeCount,
  });

  const { data: documents, error: documentError } = await userClient
    .from("project_documents")
    .select("id, organization_id, property_id, storage_path, storage_provider, storage_bucket, original_filename, byte_size, document_type, revision_label, issued_at, source_metadata")
    .in("id", job.document_ids)
    .eq("organization_id", job.organization_id)
    .eq("property_id", job.property_id);
  if (documentError || !documents || documents.length !== job.document_ids.length) {
    throw new Error("One or more project documents are missing or outside this project");
  }
  const orderedDocuments = orderForReading(job.document_ids
    .map((id) => (documents as DocumentRow[]).find((row) => row.id === id))
    .filter(Boolean) as DocumentRow[]);
  const documentsById = new Map(orderedDocuments.map((row) => [row.id, row]));

  const finalizeIfDone = async () => {
    const { data: freshChunks } = await admin.from("plan_analysis_chunks")
      .select("chunk_index, state, analysis, document_ids")
      .eq("job_id", job.id).order("chunk_index", { ascending: true });
    if (!(freshChunks || []).length || (freshChunks || []).some((chunk) => chunk.state !== "complete")) return null;
    /* The merge is told which documents each chunk held, so it can tell a
       file read elsewhere from a file that is missing. */
    const merged = mergeChunkAnalyses(
      (freshChunks || []).map((chunk) => chunk.analysis),
      (freshChunks || []).map((chunk) => ({
        chunk_index: chunk.chunk_index,
        documents: ((chunk.document_ids || []) as string[]).map((id) => documentsById.get(id)).filter(Boolean)
          .map((row) => ({ id: row!.id, filename: row!.original_filename, part_of: row!.source_metadata?.derived_from || null })),
      })),
    );
    const chunkDocuments = (freshChunks || []).map((chunk) => ((chunk.document_ids || []) as string[]).map((id) => documentsById.get(id)).filter(Boolean) as DocumentRow[]);
    return await finalizeAnalysis(admin, job, orderedDocuments, withGaps(merged, await tileCoverageGapsFor(admin, chunkDocuments, readingImageBudget(transport.provider))), transport, userId, await chunkRunMetrics(admin, job.id, transport));
  };

  /* `outcome` is the honest half of this: 'failed' where the provider told us
     the reading did not happen, 'outcome_unknown' where we are walking away
     from a job that may have run and been billed. Only the first may be
     resumed by pressing Analyze. */
  const failChunk = async (
    chunk: Record<string, any>,
    message: string,
    outcome: "failed" | "outcome_unknown" = "failed",
  ) => {
    await finishAiRun(admin, chunk.ai_run_id || null, outcome, {}, message.slice(0, 200));
    await admin.from("plan_analysis_chunks").update({
      state: "failed", error_message: message.slice(0, 800), updated_at: new Date().toISOString(),
    }).eq("id", chunk.id);
    const resumeMessage =
      `Chunk ${chunk.chunk_index + 1} of ${total} failed: ${message} ` +
      `${completeCount} finished chunk${completeCount === 1 ? "" : "s"} stay${completeCount === 1 ? "s" : ""} saved — ` +
      (outcome === "outcome_unknown"
        ? "this chunk may already have run and been billed, so running it again needs confirmation."
        : "press Analyze to resume from where it stopped.");
    await markJobFailed(admin, job, resumeMessage);
    return {
      job_id: job.id, state: "failed", progress_stage: "failed",
      progress_percent: 20 + Math.floor(60 * (completeCount / total)),
      error: resumeMessage, code: "chunk_failed",
    };
  };

  const processing = chunks.find((chunk) => chunk.state === "processing");
  if (processing && processing.provider_job_id === INLINE_CHUNK_HANDLE) {
    /* A synchronous reading is held by the worker that started it, which
       writes the result onto this row when it lands. So a poll has nothing
       to ask the provider: either the row has moved on, or the reading is
       still running. It is only past the deadline — longer than any worker
       lives — that we know no one is still holding it, and then the reading
       was sent and may have been billed, so it is an unknown outcome a
       person decides about, never a silent retry. */
    const held = heldReadingVerdict(
      processing.updated_at ? new Date(processing.updated_at).valueOf() : Date.now(),
      Date.now(), SYNC_CHUNK_DEADLINE_MS);
    if (held.state === "outcome_unknown") {
      return await failChunk(processing, held.message, "outcome_unknown");
    }
    await admin.from("plan_analysis_jobs").update({
      progress_stage: "reading_documents",
      progress_percent: 20 + Math.floor(60 * (completeCount / total)),
      last_heartbeat_at: new Date().toISOString(),
    }).eq("id", job.id);
    return progress();
  }
  if (processing && !processing.provider_job_id) {
    /* The worker died between claiming the chunk and launching it. Requeue
       and relaunch — nothing was bought, nothing is lost. */
    await admin.from("plan_analysis_chunks").update({
      state: "pending", updated_at: new Date().toISOString(),
    }).eq("id", processing.id).eq("state", "processing");
    await launchNextPendingChunk(admin, transport, job, orderedDocuments, total);
    return progress();
  }
  if (processing) {
    const providerResponse = await fetch(
      `${transport.baseUrl}/responses/${encodeURIComponent(processing.provider_job_id)}`,
      { headers: transport.headers },
    );
    const providerPayload = await providerResponse.json();
    if (providerResponse.status === 404) {
      /* Not recognised is not the same as not run: the job may have executed
         and been billed under an identity we can no longer read it from. */
      return await failChunk(processing,
        "the provider no longer recognises this chunk's background job.", "outcome_unknown");
    }
    if (!providerResponse.ok) {
      throw new Error(providerError(providerPayload, `Could not read chunk response (${providerResponse.status})`));
    }
    if (providerPayload.status === "queued") {
      const queuedAge = processing.updated_at ? Date.now() - new Date(processing.updated_at).valueOf() : 0;
      if (queuedAge > 15 * 60 * 1000) {
        /* We walk away while the provider still holds the job. Whether it
           later runs and bills is exactly what we cannot establish. */
        return await failChunk(processing,
          "the provider accepted this chunk but never started it in 15 minutes.", "outcome_unknown");
      }
    }
    if (["queued", "in_progress"].includes(providerPayload.status)) {
      await admin.from("plan_analysis_jobs").update({
        progress_stage: "reading_documents",
        progress_percent: 20 + Math.floor(60 * (completeCount / total)),
        last_heartbeat_at: new Date().toISOString(),
      }).eq("id", job.id);
      return progress();
    }
    if (providerPayload.status !== "completed") {
      return await failChunk(processing,
        `the chunk's background response ended with ${providerPayload.status || "an unknown status"}.`, "failed");
    }
    const chunkAnalysis = JSON.parse(responseText(providerPayload));
    /* The background response carries its usage only here, at retrieval —
       the call that created it returned nothing but an id. */
    await finishAiRun(admin, processing.ai_run_id || null, "succeeded", usageFrom(providerPayload), null);
    await admin.from("plan_analysis_chunks").update({
      state: "complete", analysis: chunkAnalysis, error_message: null,
      updated_at: new Date().toISOString(),
    }).eq("id", processing.id);
    await launchNextPendingChunk(admin, transport, job, orderedDocuments, total);
    const done = await finalizeIfDone();
    if (done) return done;
    return { ...progress(), chunks_complete: completeCount + 1, progress_percent: 20 + Math.floor(60 * ((completeCount + 1) / total)) };
  }

  const done = await finalizeIfDone();
  if (done) return done;

  /* A CHUNK THAT FAILED AND A JOB THAT NEVER HEARD ABOUT IT.
   *
   * A synchronous chunk records its own failure on its own row and then
   * throws — into a background task whose only listener writes a log line.
   * Nothing touched the job. So every later poll found no chunk processing,
   * none pending, not all complete, and answered "still reading" forever:
   * a screen that could not be left, for a reading that had been over for
   * twenty minutes. The failure was on the chunk the whole time; nothing
   * was carrying it up to the job. This does. */
  const failed = chunks.filter((chunk) => chunk.state === "failed");
  const pending = chunks.filter((chunk) => chunk.state === "pending");
  if (failed.length && !pending.length) {
    const worst = failed[0];
    const reason = String(worst.error_message || "the reading did not finish.");
    const resumeMessage = `Chunk ${worst.chunk_index + 1} of ${total} did not finish: ${reason} `
      + `${completeCount} finished chunk${completeCount === 1 ? "" : "s"} stay${completeCount === 1 ? "s" : ""} saved.`;
    await markJobFailed(admin, job, resumeMessage);
    return {
      job_id: job.id, state: "failed", progress_stage: "failed",
      progress_percent: 20 + Math.floor(60 * (completeCount / total)),
      error: resumeMessage, code: "chunk_failed",
    };
  }

  /* Nothing processing, something pending — a poll after a restart. */
  await launchNextPendingChunk(admin, transport, job, orderedDocuments, total);
  return progress();
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const defaultOpenAiModel = Deno.env.get("OPENAI_PLAN_MODEL") || Deno.env.get("OPENAI_MODEL") || PROVIDERS.openai.models[0].id;

  /* One reading, one reader. OpenAI keeps the transport it has always used —
     direct when a key is configured, the Cloudflare gateway otherwise —
     because plan analysis is a background response created once and retrieved
     by id, and both calls must land on the same billing identity. The other
     two providers are their own direct wires. */
  const resolveTransport = (provider: ProviderKey, modelId: string | null): ProviderTransport => {
    if (provider === "openai") {
      const legacy = openAITransport({ preferDirect: true });
      return {
        provider: "openai",
        mode: "background",
        baseUrl: legacy.baseUrl,
        headers: legacy.headers,
        model: modelOptionOrUnknown("openai", modelId || defaultOpenAiModel),
        transport: legacy.transport,
      };
    }
    return providerTransport(provider, modelId);
  };
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(request, { error: "Server configuration is incomplete" }, 500);
  }

  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json(request, { error: "Authentication required" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json(request, { error: "Invalid session" }, 401);

  let job: PlanJob | null = null;
  try {
    const body = await request.json();
    const jobId = safeText(body?.job_id, "");
    const action = safeText(body?.action, "start");

    /* Which readers this project can use, and which have a key. The answer
       carries no secret — only a yes or no per provider — and it is the only
       thing the browser ever learns about the keys. */
    if (action === "providers") {
      const organizationId = safeText(body?.organization_id, "");
      if (!organizationId) return json(request, { error: "organization_id is required" }, 400);
      const { data: membership } = await userClient
        .from("organization_members")
        .select("role")
        .eq("organization_id", organizationId)
        .eq("user_id", userData.user.id)
        .maybeSingle();
      /* Choosing the reader is an owner's or an administrator's decision. */
      if (!membership || !["owner", "admin"].includes(membership.role)) {
        return json(request, { error: "Not authorized to choose a reader" }, 403);
      }
      return json(request, { providers: providerCatalogue(), default_provider: DEFAULT_PROVIDER });
    }

    if (!jobId) return json(request, { error: "job_id is required" }, 400);

    const { data: jobRow, error: jobError } = await userClient
      .from("plan_analysis_jobs")
      .select("id, organization_id, property_id, document_ids, state, requested_by, provider, provider_job_id, model, baseline_id, progress_stage, progress_percent, started_at, completed_at, error_code, error_message, ai_run_id, image_fingerprint, images_sent")
      .eq("id", jobId)
      .single();
    if (jobError || !jobRow) return json(request, { error: "Analysis job not found" }, 404);
    job = jobRow as PlanJob;

    const { data: membership } = await userClient
      .from("organization_members")
      .select("role")
      .eq("organization_id", job.organization_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!membership || !["owner", "admin", "reviewer", "contributor"].includes(membership.role)) {
      return json(request, { error: "Not authorized for plan analysis" }, 403);
    }

    /* The reader for this job. A running job keeps the one it started with;
       a new run may name another, and only owners and administrators may. */
    const requestedProvider = isProviderKey(body?.provider) ? (body.provider as ProviderKey) : null;
    const requestedModel = safeText(body?.model, "") || null;
    if (requestedProvider && action === "start" && !["owner", "admin"].includes(membership.role)) {
      return json(request, { error: "Not authorized to choose a reader" }, 403);
    }
    const provider: ProviderKey = action === "start"
      ? (requestedProvider || (isProviderKey(job.provider) ? job.provider : DEFAULT_PROVIDER))
      : (isProviderKey(job.provider) ? job.provider : DEFAULT_PROVIDER);
    const modelId = action === "start" ? (requestedModel || job.model || null) : (job.model || null);
    let transport: ProviderTransport;
    try {
      transport = resolveTransport(provider, modelId);
    } catch (error) {
      if (error instanceof ProviderNotConfigured) {
        return json(request, {
          error: `Provider not configured — ${PROVIDERS[provider].label} has no key in this project's secrets.`,
          code: "provider_not_configured",
          provider,
        }, 400);
      }
      return json(request, { error: "Server configuration is incomplete" }, 500);
    }

    /* STOP WAITING.
     *
     * A person watching a reading must always be able to leave. This is not a
     * recall: a request already sent to a provider cannot be taken back, and
     * whatever it does next it may still bill for. What stopping does is end
     * the waiting honestly — the job is cancelled, a chunk this worker was
     * holding becomes an unknown outcome because that is exactly what it is,
     * a chunk not yet sent is simply dropped, and finished chunks stay saved
     * so nothing already paid for is thrown away. */
    if (action === "cancel") {
      if (!["owner", "admin", "contributor"].includes(membership.role)) {
        return json(request, { error: "Not authorized to stop this reading" }, 403);
      }
      if (!["queued", "processing"].includes(job.state)) {
        return json(request, { job_id: job.id, state: job.state, already_finished: true });
      }
      const { data: liveChunks } = await admin.from("plan_analysis_chunks")
        .select("id, chunk_index, state, provider_job_id, ai_run_id")
        .eq("job_id", job.id);
      let unknown = 0;
      let dropped = 0;
      for (const chunk of liveChunks || []) {
        if (chunk.state === "processing") {
          /* Sent, and we are walking away from it. Whether it runs and bills
             is precisely what we cannot establish, so the ledger says so. */
          await finishAiRun(admin, chunk.ai_run_id || null, "outcome_unknown", {}, "stopped_by_person");
          await admin.from("plan_analysis_chunks").update({
            state: "failed",
            provider_job_id: null,
            error_message: "Stopped while this chunk was with the provider. It may already have run and been billed — confirm before running it again.",
            updated_at: new Date().toISOString(),
          }).eq("id", chunk.id).eq("state", "processing");
          unknown += 1;
        } else if (chunk.state === "pending") {
          await admin.from("plan_analysis_chunks").update({
            state: "failed",
            error_message: "Stopped before this chunk was sent. Nothing was bought for it.",
            updated_at: new Date().toISOString(),
          }).eq("id", chunk.id).eq("state", "pending");
          dropped += 1;
        }
      }
      if (!(liveChunks || []).length && job.provider_job_id) {
        await finishAiRun(admin, job.ai_run_id || null, "outcome_unknown", {}, "stopped_by_person");
        unknown += 1;
      }
      const stoppedMessage = "Stopped by a person. "
        + (unknown
          ? `${unknown} reading${unknown === 1 ? " was" : "s were"} already with the provider and may still run and be billed — confirm before running ${unknown === 1 ? "it" : "them"} again. `
          : "Nothing had been sent, so nothing was bought. ")
        + (dropped ? `${dropped} part${dropped === 1 ? "" : "s"} had not been sent and ${dropped === 1 ? "was" : "were"} dropped. ` : "")
        + "Finished parts stay saved.";
      await admin.from("plan_analysis_jobs").update({
        state: "cancelled",
        progress_stage: "failed",
        error_code: "stopped_by_person",
        error_message: stoppedMessage,
        completed_at: new Date().toISOString(),
      }).eq("id", job.id).in("state", ["queued", "processing"]);
      await admin.from("audit_events").insert({
        organization_id: job.organization_id,
        actor_id: userData.user.id,
        action: "plan_analysis.stopped",
        entity_type: "plan_analysis_job",
        entity_id: job.id,
        detail: { property_id: job.property_id, provider: job.provider, unknown_outcome_chunks: unknown, dropped_chunks: dropped },
      });
      return json(request, {
        job_id: job.id, state: "cancelled", progress_stage: "failed",
        error: stoppedMessage, code: "stopped_by_person",
        unknown_outcome_chunks: unknown, dropped_chunks: dropped,
      });
    }

    if (action === "rebuild") {
      const rebuilt = await rebuildFromSavedReadings(admin, userClient, job, userData.user.id, transport);
      return json(request, rebuilt.body, rebuilt.status);
    }

    if (action === "status") {
      if (job.state === "completed") {
        return json(request, {
          job_id: job.id, baseline_id: job.baseline_id, state: "completed",
          progress_stage: "completed", progress_percent: 100,
        });
      }
      const recovered = await recoverCompletedBaseline(admin, job);
      if (recovered) return json(request, recovered);
      if (job.state === "failed" || job.state === "cancelled") {
        return json(request, {
          job_id: job.id, state: job.state, progress_stage: "failed",
          progress_percent: job.progress_percent || 0,
          error: job.error_message || "Plan analysis failed",
          code: job.error_code || "plan_analysis_failed",
        });
      }

      if (job.state === "queued") {
        return json(request, { job_id: job.id, state: "queued", progress_stage: "queued", progress_percent: 4 });
      }
      /* A chunked large set carries its provider ids on the chunk rows, not
         on the job — its polling has its own driver. This must run before the
         legacy no-provider-id check, which would otherwise declare a healthy
         chunked run abandoned. */
      const { data: chunkRows } = await admin.from("plan_analysis_chunks")
        .select("id, chunk_index, document_ids, provider_job_id, state, updated_at, ai_run_id, error_message")
        .eq("job_id", job.id).order("chunk_index", { ascending: true });
      if (chunkRows && chunkRows.length) {
        return json(request, await advanceChunkedJob(admin, userClient, transport, job, userData.user.id, chunkRows));
      }
      if (!job.provider_job_id) {
        const legacyAge = job.started_at ? Date.now() - new Date(job.started_at).valueOf() : 0;
        if (legacyAge > 5 * 60 * 1000) {
          const message = "The previous synchronous worker ended before saving a complete roadmap. The plan files are safe; start a new background analysis.";
          await markJobFailed(admin, job, message);
          return json(request, {
            job_id: job.id, state: "failed", progress_stage: "failed",
            progress_percent: job.progress_percent || 0,
            error: message, code: "legacy_worker_interrupted",
          });
        }
        return json(request, {
          job_id: job.id, state: "processing", progress_stage: job.progress_stage || "legacy_processing",
          progress_percent: Math.max(18, job.progress_percent || 0), legacy: true,
        });
      }
      if (job.progress_stage === "finalizing") {
        return json(request, { job_id: job.id, state: "processing", progress_stage: "finalizing", progress_percent: 90 });
      }

      const providerResponse = await fetch(`${transport.baseUrl}/responses/${encodeURIComponent(job.provider_job_id)}`, {
        headers: transport.headers,
      });
      const providerPayload = await providerResponse.json();
      if (providerResponse.status === 404) {
        /* The provider does not recognise this job id — it was created under a
           different billing identity (a gateway job read directly, or the
           reverse), or it expired. Nothing will ever finish it. Leaving the row
           in "processing" is a progress bar frozen at 18% until somebody gives
           up — the job is failed now, with the way forward in the message. */
        /* It may have run. It may be on the invoice. What is certain is only
           that we can no longer read it — so this is not a free retry. */
        const message = "The provider no longer recognises this background job. The plan files are safe. This reading may already have run and been billed, so starting a fresh one needs confirmation.";
        await finishAiRun(admin, job.ai_run_id || null, "outcome_unknown", {}, "provider_job_lost");
        await markJobFailed(admin, job, message);
        return json(request, {
          job_id: job.id, state: "failed", progress_stage: "failed",
          progress_percent: job.progress_percent || 0,
          error: message, code: "provider_job_lost",
        });
      }
      if (!providerResponse.ok) throw new Error(providerError(providerPayload, `Could not read background response (${providerResponse.status})`));
      if (providerPayload.status === "queued") {
        /* Accepted but never started. A legitimate queue clears in minutes; a
           job that has sat unstarted for a quarter of an hour is not late, it
           is abandoned — and the screen must say so instead of showing 18%
           until the end of time. This is exactly what a background job created
           through a billing identity that will not schedule it looks like. */
        const queuedAge = job.started_at ? Date.now() - new Date(job.started_at).valueOf() : 0;
        if (queuedAge > 15 * 60 * 1000) {
          const message = "The provider accepted this analysis but never started it in 15 minutes. The plan files are safe. The provider still holds the job, so starting a fresh one needs confirmation.";
          await finishAiRun(admin, job.ai_run_id || null, "outcome_unknown", {}, "provider_never_started");
          await markJobFailed(admin, job, message);
          return json(request, {
            job_id: job.id, state: "failed", progress_stage: "failed",
            progress_percent: job.progress_percent || 0,
            error: message, code: "provider_never_started",
          });
        }
      }
      if (["queued", "in_progress"].includes(providerPayload.status)) {
        const percent = providerPayload.status === "queued" ? 18 : 68;
        await admin.from("plan_analysis_jobs").update({
          progress_stage: providerPayload.status === "queued" ? "provider_queued" : "reading_documents",
          progress_percent: percent,
          last_heartbeat_at: new Date().toISOString(),
        }).eq("id", job.id);
        return json(request, {
          job_id: job.id, state: "processing",
          progress_stage: providerPayload.status === "queued" ? "provider_queued" : "reading_documents",
          progress_percent: percent,
        });
      }
      if (providerPayload.status !== "completed") {
        await finishAiRun(admin, job.ai_run_id || null, "failed", usageFrom(providerPayload),
          String(providerPayload.status || "unknown_status").slice(0, 200));
        throw new Error(providerError(providerPayload, `Background response ended with ${providerPayload.status || "an unknown status"}`));
      }
      /* Retrieval is where a background reading reports what it consumed. */
      await finishAiRun(admin, job.ai_run_id || null, "succeeded", usageFrom(providerPayload), null);

      const { data: documents, error: documentError } = await userClient
        .from("project_documents")
        .select("id, organization_id, property_id, storage_path, storage_provider, storage_bucket, original_filename, byte_size, document_type, revision_label, issued_at, source_metadata")
        .in("id", job.document_ids)
        .eq("organization_id", job.organization_id)
        .eq("property_id", job.property_id);
      if (documentError || !documents || documents.length !== job.document_ids.length) {
        throw new Error("One or more project documents are missing or outside this project");
      }
      const analysis = JSON.parse(responseText(providerPayload));
      const result = await finalizeAnalysis(
        admin, job, documents as DocumentRow[],
        withGaps(analysis, await tileCoverageGapsFor(admin, [documents as DocumentRow[]], readingImageBudget(transport.provider))),
        transport, userData.user.id,
        runMetrics(transport, usageFrom(providerPayload), job.started_at ? Date.now() - new Date(job.started_at).valueOf() : 0,
          job.image_fingerprint ? { fingerprint: job.image_fingerprint, images_sent: Number(job.images_sent) || 0, documents_sent: 0 } : null),
      );
      return json(request, result);
    }

    if (action !== "start") return json(request, { error: "Unsupported action" }, 400);
    if (job.state === "processing") {
      return json(request, {
        job_id: job.id, state: "processing", progress_stage: job.progress_stage,
        progress_percent: job.progress_percent || 18,
      }, 202);
    }
    if (!["queued", "failed"].includes(job.state)) {
      return json(request, { error: `Job cannot run from state ${job.state}` }, 409);
    }

    const { data: documents, error: documentError } = await userClient
      .from("project_documents")
      .select("id, organization_id, property_id, storage_path, storage_provider, storage_bucket, original_filename, byte_size, document_type, revision_label, issued_at, source_metadata")
      .in("id", job.document_ids)
      .eq("organization_id", job.organization_id)
      .eq("property_id", job.property_id);
    if (documentError || !documents || documents.length !== job.document_ids.length) {
      throw new Error("One or more project documents are missing or outside this project");
    }
    const totalBytes = (documents as DocumentRow[]).reduce((sum, item) => sum + Number(item.byte_size || 0), 0);
    /* One file over the provider's input limit cannot be split here — it
       still needs an optimized copy. A SET over the limit no longer fails:
       it partitions into chunks that each fit, below. */
    const oversized = (documents as DocumentRow[]).find((item) => Number(item.byte_size || 0) > CHUNK_BYTE_LIMIT);
    if (oversized) {
      throw new Error(
        `${oversized.original_filename} exceeds the AI provider's 49 MB per-file limit. Split it for analysis in Studio — the original stays untouched and its parts are read as one set.`,
      );
    }

    /* Free, and before any money moves: the provider must list the model we
       are about to buy a reading under. A rename shows up here as an error,
       never as a charge under a name nobody checked. */
    const modelCheck = await verifyModelId(transport);
    if (!modelCheck.ok) {
      const message = `${PROVIDERS[provider].label} does not offer ${transport.model.id} to this key. ${modelCheck.detail}`;
      await markJobFailed(admin, job, message);
      return json(request, { error: message, code: "model_not_available", provider, model: transport.model.id, job_id: job.id }, 400);
    }
    /* And the ceiling this reading would ask for, checked against the number
       the provider itself publishes for this model — not against a figure
       copied from a page. A provider that reports no limit leaves this
       unknown, and unknown is not permission: the reading proceeds, because
       an over-large ceiling is refused by the provider before it generates
       anything, and that refusal costs nothing and names the real number. */
    if (modelCheck.outputLimit !== null && MAX_READING_OUTPUT_TOKENS > modelCheck.outputLimit) {
      const message = `${PROVIDERS[provider].label} publishes an output limit of `
        + `${modelCheck.outputLimit.toLocaleString("en-US")} tokens for ${transport.model.id}, and this reading asks for `
        + `${MAX_READING_OUTPUT_TOKENS.toLocaleString("en-US")}. Nothing was sent. `
        + "Lower the reading's output ceiling to that number or below.";
      await markJobFailed(admin, job, message);
      return json(request, { error: message, code: "output_limit_too_high", provider, model: transport.model.id, provider_output_limit: modelCheck.outputLimit, job_id: job.id }, 400);
    }

    const startedAt = new Date().toISOString();
    await admin.from("plan_analysis_jobs").update({
      state: "processing", provider, provider_job_id: null, model: transport.model.id,
      agent_contract_version: AGENT_CONTRACT_VERSION,
      progress_stage: "securing_sources", progress_percent: 8,
      started_at: startedAt, completed_at: null, last_heartbeat_at: startedAt,
      error_code: null, error_message: null,
    }).eq("id", job.id);
    await admin.from("project_documents").update({
      status: "processing", processing_error: null, updated_at: new Date().toISOString(),
    }).in("id", job.document_ids);
    await admin.from("properties").update({ workflow_state: "analyzing_plans" }).eq("id", job.property_id);

    const orderedDocuments = orderForReading(job.document_ids
      .map((id) => (documents as DocumentRow[]).find((row) => row.id === id))
      .filter(Boolean) as DocumentRow[]);
    const register = orderedDocuments.map((row) => ({
      id: row.id,
      filename: row.original_filename,
      document_type: row.document_type,
      revision: row.revision_label,
      issued_at: row.issued_at,
      /* A part of a larger file says so: which file, which pages. Its tiles
         are numbered by the original set, so page references stay true. */
      part_of: row.source_metadata?.derived_from || null,
    }));
    const registerText = JSON.stringify(register, null, 2);

    /* A synchronous reader always goes through the chunk table, even for a
       set that fits one request. Not because the set needs splitting, but
       because a chunk row is where a reading that outlives its request
       writes its result and where a poll finds it. One chunk of one is that
       row; the note it gets says nothing about chunks. */
    if (totalBytes <= CHUNK_BYTE_LIMIT && transport.mode === "background") {
      /* Nothing reaches the provider until the ledger has claimed this exact
         reading. Two Analyze presses on an unchanged plan set both arrive
         here; one is claimed and one is told the reading already exists. */
      const ledger = await claimAiRun(admin, {
        ...planFingerprintParts(job, transport.provider, transport.model.id, orderedDocuments, null),
        jobTable: "plan_analysis_jobs",
        jobId: job.id,
        transport: transport.transport,
        force: Boolean(body?.force),
      });
      if (ledger.verdict !== "CLAIMED") {
        await markJobFailed(admin, job,
          ledger.verdict === "RUNNING"
            ? "This exact plan set is already being read. Open the run that is in progress."
            : "This exact plan set has already been read. Open the baseline, or choose Reanalyze to buy a new reading.");
        return json(request, {
          job_id: job.id,
          state: "failed",
          skipped: ledger.verdict === "UNKNOWN" ? "outcome_unknown" : ledger.verdict.toLowerCase(),
          previous_run_id: ledger.previousRunId,
          unresolved_run_id: ledger.verdict === "UNKNOWN" ? ledger.previousRunId : null,
          code: ledger.verdict === "RUNNING"
            ? "duplicate_in_flight"
            : ledger.verdict === "UNKNOWN"
              ? "outcome_unknown"
              : "identical_reading_exists",
        }, 200);
      }
      let reading;
      const launchProgress = new RunProgress();
      try {
        reading = await createProviderReading(
          admin, transport, orderedDocuments, registerText, null, launchProgress);
      } catch (launchError) {
        const launchMessage = String(launchError instanceof Error ? launchError.message : launchError);
        const launchStopped = stoppedReading(launchError);
        await finishAiRun(admin, ledger.runId,
          launchStopped
            ? launchStopped.readingOutcome
            : /may already have run and been billed/i.test(launchMessage) ? "outcome_unknown" : launchProgress.outcome(),
          launchStopped?.providerUsage || {}, launchMessage.slice(0, 200));
        throw launchError;
      }
      if (reading.kind === "sync") {
        /* The reader has already answered. Its usage closes the ledger row,
           its raw payload is kept beside the parsed result, and the baseline
           is created here rather than on a later poll. */
        await finishAiRun(admin, ledger.runId, "succeeded", reading.usage, null);
        await admin.from("plan_analysis_jobs").update({
          ai_run_id: ledger.runId,
          provider_raw: reading.raw,
          progress_stage: "finalizing",
          progress_percent: 90,
          last_heartbeat_at: new Date().toISOString(),
        }).eq("id", job.id);
        const result = await finalizeAnalysis(
          admin, job, orderedDocuments,
          withGaps(reading.analysis as Record<string, any>, await tileCoverageGapsFor(admin, [orderedDocuments], readingImageBudget(transport.provider))),
          transport, userData.user.id,
          runMetrics(transport, reading.usage, reading.durationMs, reading.manifest),
        );
        return json(request, result);
      }
      const acceptedAt = new Date().toISOString();
      await admin.from("plan_analysis_jobs").update({
        provider_job_id: reading.id,
        ai_run_id: ledger.runId,
        image_fingerprint: reading.manifest.fingerprint,
        images_sent: reading.manifest.images_sent,
        progress_stage: reading.status === "queued" ? "provider_queued" : "reading_documents",
        progress_percent: reading.status === "queued" ? 18 : 32,
        last_heartbeat_at: acceptedAt,
      }).eq("id", job.id);
      return json(request, {
        job_id: job.id,
        state: "processing",
        progress_stage: reading.status === "queued" ? "provider_queued" : "reading_documents",
        progress_percent: reading.status === "queued" ? 18 : 32,
      }, 202);
    }

    /* Chunked mode: a set over one reading's limit partitions into chunks
       that each fit, run one after another as separate provider jobs. Every
       finished chunk is a checkpoint; a rerun after a failure keeps the
       finished readings and requeues only the rest — a 200-sheet set never
       depends on one context window or one uninterrupted run. */
    /* Chunked mode splits on tiles as well as bytes. A set uploaded whole
       carries more enlargements than one reading may hold, and splitting on
       bytes alone would leave the later sheets without their tiles — the
       coverage cut this budget must never cause. Split on tiles and the
       sheets that no longer fit this chunk are read whole in the next one,
       at the same resolution. */
    const tilesByDocument = new Map<string, number>();
    for (const row of orderedDocuments) {
      tilesByDocument.set(row.id, (await listPageTiles(admin, row)).length);
    }
    const partition = planChunks(orderedDocuments, CHUNK_BYTE_LIMIT, MAX_RENDER_IMAGES, tilesByDocument);
    if (!partition.length) throw new Error("No readable plan documents were selected.");
    const { data: existingChunks } = await admin.from("plan_analysis_chunks")
      .select("id, chunk_index, document_ids, state")
      .eq("job_id", job.id).order("chunk_index", { ascending: true });
    /* A resumed job keeps its finished readings when its chunks hold the
       same document sets — in any order, so a change in reading order
       between two runs never throws away a chunk that was paid for. */
    const partitionMatches = (existingChunks || []).length === partition.length
      && (existingChunks || []).every((row) => partition.some((chunk) => sameIds(row.document_ids || [], chunk.document_ids)));
    if (!partitionMatches) {
      const activeJob = job;
      await admin.from("plan_analysis_chunks").delete().eq("job_id", activeJob.id);
      const { error: chunkInsertError } = await admin.from("plan_analysis_chunks").insert(
        partition.map((chunk, index) => ({
          job_id: activeJob.id,
          organization_id: activeJob.organization_id,
          chunk_index: index,
          document_ids: chunk.document_ids,
        })),
      );
      if (chunkInsertError) throw chunkInsertError;
    } else {
      for (const row of existingChunks || []) {
        if (row.state !== "complete") {
          await admin.from("plan_analysis_chunks").update({
            state: "pending", provider_job_id: null, error_message: null,
            updated_at: new Date().toISOString(),
          }).eq("id", row.id);
        }
      }
    }
    await launchNextPendingChunk(admin, transport, job, orderedDocuments, partition.length);
    const resumedComplete = partitionMatches
      ? (existingChunks || []).filter((row) => row.state === "complete").length
      : 0;
    const percent = 20 + Math.floor(60 * (resumedComplete / partition.length));
    await admin.from("plan_analysis_jobs").update({
      progress_stage: "reading_documents",
      progress_percent: percent,
      last_heartbeat_at: new Date().toISOString(),
    }).eq("id", job.id);
    return json(request, {
      job_id: job.id,
      state: "processing",
      progress_stage: "reading_documents",
      progress_percent: percent,
      chunks: partition.length,
      chunks_complete: resumedComplete,
    }, 202);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Plan analysis failed";
    if (job) await markJobFailed(admin, job, message);
    const status = /quota|rate limit/i.test(message) ? 429 : 500;
    return json(request, { error: message, job_id: job?.id || null }, status);
  }
});