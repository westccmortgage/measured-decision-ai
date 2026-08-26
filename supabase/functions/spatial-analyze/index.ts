import { createClient } from "npm:@supabase/supabase-js@2";
import {
  AGENT_CONTRACT_VERSION,
  EVIDENCE_WORKFLOW_INSTRUCTIONS,
} from "../_shared/agent-contracts.ts";
import { signedObjectReadUrl } from "../_shared/aws-object-store.ts";
import { openAITransport } from "../_shared/openai-transport.ts";

const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5.6-sol";
const STORAGE_BUCKET = "property-evidence";
const MAX_IMAGE_INPUTS = 20;
const MAX_VIDEO_FRAMES = 8;
const MAX_FRAME_BYTES = 1_500_000;

const allowedOrigins = new Set([
  "https://measureddecision.com",
  "https://www.measureddecision.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

type VideoFrame = {
  evidence_id: string;
  timestamp_seconds: number;
  data_url: string;
  equirectangular: boolean;
};

type AnalysisJob = {
  id: string;
  organization_id: string;
  property_id: string;
  space_id: string | null;
  state: "queued" | "processing" | "completed" | "failed" | "cancelled";
  profile: string;
  profile_version: string;
  evidence_ids: string[];
  requested_by: string;
};

type EvidenceItem = {
  id: string;
  storage_path: string;
  storage_provider: string;
  storage_bucket: string | null;
  original_filename: string;
  media_type: string;
  mime_type: string;
  byte_size: number;
  captured_at: string | null;
  source_metadata: Record<string, unknown> | null;
};

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin)
      ? origin
      : "https://measureddecision.com",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function jsonResponse(
  request: Request,
  body: Record<string, unknown>,
  status = 200,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function diagnosticCode(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function normalizeFrames(
  value: unknown,
  evidenceById: Map<string, EvidenceItem>,
): VideoFrame[] {
  if (!Array.isArray(value)) return [];
  const frames: VideoFrame[] = [];
  for (const candidate of value.slice(0, MAX_VIDEO_FRAMES)) {
    if (!candidate || typeof candidate !== "object") continue;
    const frame = candidate as Record<string, unknown>;
    const evidenceId = String(frame.evidence_id || "");
    const evidence = evidenceById.get(evidenceId);
    const timestampSeconds = Number(frame.timestamp_seconds);
    const dataUrl = String(frame.data_url || "");
    if (!evidence?.mime_type?.startsWith("video/")) continue;
    if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) continue;
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) continue;
    if (dataUrl.length > Math.ceil((MAX_FRAME_BYTES * 4) / 3) + 64) continue;
    frames.push({
      evidence_id: evidenceId,
      timestamp_seconds: timestampSeconds,
      data_url: dataUrl,
      equirectangular: frame.equirectangular === true,
    });
  }
  return frames;
}

/* The frame is the whole sphere, so a position inside it is a direction in the
   room. Saying that in the prompt is what turns a sentence into a place a
   person can look at, and the "leave it null" rule is what keeps a guessed
   position from becoming a pin pointing at nothing. */
const SPHERICAL_ANCHOR_INSTRUCTIONS = [
  "Some supplied frames are equirectangular 360 projections: one image holds the entire sphere around the camera.",
  "For an observation you can point at in such a frame, set frame_anchor to the position of that thing inside that frame:",
  "u is the horizontal fraction from the left edge (0) to the right edge (1); v is the vertical fraction from the top edge (0, straight up) to the bottom edge (1, straight down).",
  "Use the evidence_id and timestamp of the exact frame you are pointing at.",
  "Set frame_anchor to null when the observation covers the whole space, when it comes from a flat photo, or when you cannot point at it precisely. A wrong position is worse than none.",
].join(" ");

function outputText(payload: Record<string, unknown>) {
  for (const output of (payload.output as Array<Record<string, unknown>>) ||
    []) {
    if (output.type !== "message") continue;
    for (const content of (output.content as Array<Record<string, unknown>>) ||
      []) {
      if (content.type === "refusal") {
        fail("The model declined this evidence request.", 422);
      }
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  fail("The model returned no structured interpretation.", 502);
}

/* A 360 frame is a whole sphere flattened into one picture, so the model can
   say where in that picture a thing sits. That pair of fractions is all the
   viewer needs to put a marker on the thing itself — the reader stops reading
   about a wall-mounted enclosure and looks at it. When no spherical frame was
   supplied there is nothing to anchor to, and the field is left out entirely
   rather than inviting a guess. */
function frameAnchorSchema(evidenceIdSchema: Record<string, unknown>) {
  return {
    type: ["object", "null"],
    properties: {
      evidence_id: evidenceIdSchema,
      timestamp_seconds: { type: "number" },
      u: { type: "number" },
      v: { type: "number" },
    },
    required: ["evidence_id", "timestamp_seconds", "u", "v"],
    additionalProperties: false,
  };
}

/* Counting what the frames actually show, in the project's own component
   vocabulary. Strict; a count the model cannot make is simply absent —
   absence of evidence stays absent, it never becomes a zero claim. */
const componentCountsSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["component_key", "count_visible", "confidence", "note"],
    properties: {
      component_key: { type: "string" },
      count_visible: { type: "integer" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      note: { type: "string" },
    },
  },
};

function analysisSchema(evidenceIds: string[], anchorable: boolean) {
  const evidenceIdSchema = {
    type: "string",
    enum: evidenceIds,
  };
  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      capture_quality: {
        type: "string",
        enum: ["strong", "usable", "limited"],
      },
      visible_observations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            category: {
              type: "string",
              enum: [
                "space",
                "surface",
                "opening",
                "fixture",
                "system",
                "material",
                "condition",
                "other",
              ],
            },
            evidence_ids: {
              type: "array",
              minItems: 1,
              items: evidenceIdSchema,
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
            ...(anchorable
              ? { frame_anchor: frameAnchorSchema(evidenceIdSchema) }
              : {}),
          },
          required: [
            "text",
            "category",
            "evidence_ids",
            "confidence",
            ...(anchorable ? ["frame_anchor"] : []),
          ],
          additionalProperties: false,
        },
      },
      not_established: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            reason: { type: "string" },
          },
          required: ["question", "reason"],
          additionalProperties: false,
        },
      },
      follow_up_captures: {
        type: "array",
        items: {
          type: "object",
          properties: {
            request: { type: "string" },
            reason: { type: "string" },
            priority: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
          },
          required: ["request", "reason", "priority"],
          additionalProperties: false,
        },
      },
      limitations: {
        type: "array",
        items: { type: "string" },
      },
      component_counts: componentCountsSchema,
    },
    required: [
      "summary",
      "capture_quality",
      "visible_observations",
      "not_established",
      "follow_up_captures",
      "limitations",
      "component_counts",
    ],
    additionalProperties: false,
  };
}

/* A conclusion can only be re-derived if we know what was asked, not just which
   model was called. This is the digest of the instruction text and the exact
   response schema used for one run — change either and the fingerprint changes,
   so an old finding can never be silently attributed to today's prompt. */
async function promptFingerprint(instructions: string, schema: unknown) {
  const material = `${instructions}\u0000${JSON.stringify(schema)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey =
    Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = request.headers.get("Authorization");
  let aiTransport: ReturnType<typeof openAITransport>;
  try {
    aiTransport = openAITransport({ zeroDataRetention: true });
  } catch {
    return jsonResponse(
      request,
      { error: "Worker configuration incomplete" },
      500,
    );
  }
  if (
    !supabaseUrl ||
    !publishableKey ||
    !serviceRoleKey ||
    !authorization
  ) {
    return jsonResponse(
      request,
      { error: "Worker configuration incomplete" },
      500,
    );
  }

  let jobId = "";
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  try {
    const body = (await request.json()) as Record<string, unknown>;
    jobId = String(body.job_id || "");
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) fail("A valid job_id is required.");

    const userClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();
    if (userError || !user) fail("Authentication required.", 401);

    const { data: jobData, error: jobError } = await userClient
      .from("analysis_jobs")
      .select(
        "id, organization_id, property_id, space_id, state, profile, profile_version, evidence_ids, requested_by",
      )
      .eq("id", jobId)
      .single();
    if (jobError || !jobData) fail("Analysis job not found.", 404);
    const job = jobData as AnalysisJob;

    const { data: membership } = await userClient
      .from("organization_members")
      .select("role")
      .eq("organization_id", job.organization_id)
      .eq("user_id", user.id)
      .single();
    if (
      !membership ||
      !["owner", "admin", "reviewer", "contributor"].includes(membership.role)
    ) {
      fail("You do not have permission to request analysis.", 403);
    }

    if (job.state === "completed") {
      const { data: existing } = await userClient
        .from("ai_suggestions")
        .select("id, body, confidence")
        .eq("job_id", job.id)
        .eq("suggestion_type", "room_interpretation")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing) {
        return jsonResponse(request, {
          job_id: job.id,
          suggestion_id: existing.id,
          analysis: existing.body,
          model: OPENAI_MODEL,
          reused: true,
        });
      }
    }
    if (!["queued", "failed"].includes(job.state)) {
      fail(`Job cannot be processed while ${job.state}.`, 409);
    }
    if (!job.evidence_ids?.length) fail("The job contains no evidence.");

    const [
      { data: evidenceData, error: evidenceError },
      { data: space },
      { data: property },
    ] = await Promise.all([
      admin
        .from("evidence_items")
        .select(
          "id, storage_path, storage_provider, storage_bucket, original_filename, media_type, mime_type, byte_size, captured_at, source_metadata",
        )
        .eq("organization_id", job.organization_id)
        .eq("property_id", job.property_id)
        /* Deleted evidence never reaches a model. A conclusion drawn from a file
           the record no longer shows cannot be explained to anyone later. */
        .is("deleted_at", null)
        .in("id", job.evidence_ids),
      admin
        .from("spaces")
        .select("id, name, building, level")
        .eq("id", job.space_id)
        .maybeSingle(),
      admin
        .from("properties")
        .select("id, name, address")
        .eq("id", job.property_id)
        .single(),
    ]);
    if (evidenceError) fail("Evidence could not be loaded.", 500);
    const evidence = (evidenceData || []) as EvidenceItem[];
    if (evidence.length !== job.evidence_ids.length) {
      fail("One or more evidence records are unavailable.", 409);
    }
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const videoFrames = normalizeFrames(body.video_frames, evidenceById);
    const sphericalFrames = videoFrames.filter((frame) => frame.equirectangular);
    const sphericalEvidenceIds = new Set(
      sphericalFrames.map((frame) => frame.evidence_id),
    );

    await admin
      .from("analysis_jobs")
      .update({
        state: "processing",
        provider: "openai",
        model: OPENAI_MODEL,
        error_code: null,
        started_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    const content: Array<Record<string, unknown>> = [];
    const evidenceManifest = evidence.map((item) => ({
      id: item.id,
      filename: item.original_filename,
      media_type: item.media_type,
      mime_type: item.mime_type,
      captured_at: item.captured_at,
      subject: item.source_metadata?.subject || null,
      context: item.source_metadata?.context || null,
    }));
    /* The project's component vocabulary, if the technical channel has
       written one. With it the inspector also counts what it can actually
       SEE — installed components only, never delivery paperwork, never a
       guess. Without it, component_counts simply stays empty. */
    const { data: vocabularyRows } = await admin
      .from("project_requirements")
      .select("component_key, description")
      .eq("property_id", job.property_id)
      .eq("state", "active");
    const componentVocabulary = (vocabularyRows || [])
      .map((row) => `${row.component_key} — ${row.description}`.trim())
      .slice(0, 40);

    content.push({
      type: "input_text",
      text: [
        `Property: ${property?.name || job.property_id}`,
        `Room: ${space?.name || "Unspecified space"}`,
        `Location: ${space?.building || "Property"} · ${space?.level || "Unspecified level"}`,
        `Processing profile: ${job.profile} v${job.profile_version}`,
        `Evidence manifest: ${JSON.stringify(evidenceManifest)}`,
        "Analyze only the visual material that follows. Every visible observation must cite one or more exact evidence IDs from the manifest.",
        ...(componentVocabulary.length ? [
          `Component counting. This project's technical documents require these components:\n${componentVocabulary.join("\n")}\nIn component_counts, report each of these components you can ACTUALLY SEE INSTALLED in the frames, with the count you can verify by looking. Count only what is visible: absence from view is not absence from the site, and you never report a zero. If you cannot identify or count a component with confidence, omit it entirely — the record treats a missing count as not-yet-evidenced, which is the honest state. Use note for what limited the count (angle, occlusion, distance).`,
        ] : []),
        ...(sphericalFrames.length ? [SPHERICAL_ANCHOR_INSTRUCTIONS] : []),
      ].join("\n"),
    });

    let imageCount = 0;
    for (const item of evidence) {
      if (!item.mime_type.startsWith("image/")) continue;
      if (imageCount >= MAX_IMAGE_INPUTS) break;
      let signedUrl = "";
      if (item.storage_provider === "aws-s3") {
        signedUrl = await signedObjectReadUrl(item.storage_path, 15 * 60).catch(() => "");
      } else {
        const { data: signed, error: signedError } = await admin.storage
          .from(item.storage_bucket || STORAGE_BUCKET)
          .createSignedUrl(item.storage_path, 15 * 60);
        if (!signedError) signedUrl = signed?.signedUrl || "";
      }
      if (!signedUrl) continue;
      content.push({
        type: "input_text",
        text: `Evidence image ${item.id} · ${item.original_filename}`,
      });
      content.push({
        type: "input_image",
        image_url: signedUrl,
        detail: "high",
      });
      imageCount += 1;
    }
    for (const frame of videoFrames) {
      const source = evidenceById.get(frame.evidence_id);
      content.push({
        type: "input_text",
        text: `${frame.equirectangular ? "Equirectangular 360 frame" : "Video frame"} from evidence ${frame.evidence_id} · ${source?.original_filename || "video"} · ${frame.timestamp_seconds.toFixed(1)} seconds`,
      });
      content.push({
        type: "input_image",
        image_url: frame.data_url,
        detail: "high",
      });
    }
    if (imageCount + videoFrames.length === 0) {
      fail("No supported image or video-frame input was available.", 422);
    }

    const responseSchema = analysisSchema(job.evidence_ids, sphericalFrames.length > 0);
    const runFingerprint = await promptFingerprint(EVIDENCE_WORKFLOW_INSTRUCTIONS, responseSchema);
    const openAIResponse = await fetch(`${aiTransport.baseUrl}/responses`, {
      method: "POST",
      headers: aiTransport.headers,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        store: false,
        instructions: EVIDENCE_WORKFLOW_INSTRUCTIONS,
        input: [{ role: "user", content }],
        text: {
          format: {
            type: "json_schema",
            name: "property_evidence_interpretation",
            strict: true,
            schema: responseSchema,
          },
        },
        max_output_tokens: 3500,
      }),
    });
    const openAIPayload = (await openAIResponse.json()) as Record<
      string,
      unknown
    >;
    if (!openAIResponse.ok) {
      const apiError = openAIPayload.error as
        Record<string, unknown> | undefined;
      const providerCode = diagnosticCode(apiError?.code || apiError?.type);
      const message =
        typeof apiError?.message === "string"
          ? apiError.message
          : `OpenAI request failed (${openAIResponse.status}).`;
      throw Object.assign(new Error(message), {
        status: 502,
        errorCode: ["openai", String(openAIResponse.status), providerCode]
          .filter(Boolean)
          .join("_"),
      });
    }
    if (openAIPayload.status === "incomplete") {
      throw Object.assign(new Error("OpenAI response was incomplete."), {
        status: 502,
        errorCode: "openai_incomplete",
      });
    }
    /* The model we asked for and the model that answered are different facts.
       Only the second one explains a finding a year from now. */
    const servedModel = typeof openAIPayload.model === "string" ? openAIPayload.model : null;
    const usage = (openAIPayload.usage as Record<string, unknown>) || {};
    const analysis = JSON.parse(outputText(openAIPayload)) as Record<
      string,
      unknown
    >;
    const observations =
      (analysis.visible_observations as Array<Record<string, unknown>>) || [];
    /* An anchor is only meaningful on the sphere it was read from. Anything
       pointing at a flat photo, or off the edge of the frame, is dropped rather
       than stored: the marker layer must never place a pin the evidence does
       not support. */
    for (const observation of observations) {
      const anchor = observation.frame_anchor as
        | Record<string, unknown>
        | null
        | undefined;
      if (!anchor) {
        observation.frame_anchor = null;
        continue;
      }
      const u = Number(anchor.u);
      const v = Number(anchor.v);
      const anchorEvidenceId = String(anchor.evidence_id || "");
      if (
        !sphericalEvidenceIds.has(anchorEvidenceId) ||
        !Number.isFinite(u) ||
        !Number.isFinite(v) ||
        u < 0 ||
        u > 1 ||
        v < 0 ||
        v > 1
      ) {
        observation.frame_anchor = null;
        continue;
      }
      observation.frame_anchor = {
        evidence_id: anchorEvidenceId,
        timestamp_seconds: Number(anchor.timestamp_seconds) || 0,
        u,
        v,
      };
    }
    const confidence = observations.length
      ? observations.reduce(
          (sum, item) => sum + Number(item.confidence || 0),
          0,
        ) / observations.length
      : null;

    const { data: suggestion, error: suggestionError } = await admin
      .from("ai_suggestions")
      .insert({
        organization_id: job.organization_id,
        job_id: job.id,
        property_id: job.property_id,
        space_id: job.space_id,
        suggestion_type: "room_interpretation",
        /* What the model believes the evidence may support. It is not a decision
           and cannot become one here: a decision is a row in suggestion_reviews,
           whose reviewed_by is a real account this function does not have. */
        layer: "interpretation",
        body: analysis,
        evidence_ids: job.evidence_ids,
        /* Which files actually carry each claim, separated from the files that
           were merely in the request. */
        supporting_evidence_ids: Array.from(new Set(
          observations.flatMap((observation) =>
            ((observation.evidence_ids as string[]) || []).filter((id) => typeof id === "string")),
        )),
        /* Nothing in this workflow detects contradiction between two captures
           yet, so this stays empty rather than being filled with a guess. */
        conflicting_evidence_ids: [],
        missing_evidence: (analysis.not_established as unknown[]) || [],
        confidence,
        agent_key: "evidence_inspector",
        agent_contract_version: AGENT_CONTRACT_VERSION,
      })
      .select("id")
      .single();
    if (suggestionError || !suggestion) {
      throw Object.assign(new Error("AI suggestion could not be stored."), {
        status: 500,
        errorCode: "suggestion_write_failed",
      });
    }

    /* Counted components enter the record through record_vision_counts — the
       one door that enforces replace-per-room, sum-across-rooms — as the
       caller, so their project role gates the write. A failure here never
       fails the analysis: the interpretation stands, the counts retry on the
       next run. */
    const componentCounts = Array.isArray((analysis as Record<string, unknown>).component_counts)
      ? (analysis as Record<string, unknown>).component_counts
      : [];
    if ((componentCounts as unknown[]).length) {
      const { error: countsError } = await userClient.rpc("record_vision_counts", {
        p_property_id: job.property_id,
        p_space_id: job.space_id,
        p_evidence_ids: job.evidence_ids,
        p_counts: componentCounts,
      });
      if (countsError) console.error("vision counts not recorded", countsError.message);
    }

    const finishedAt = new Date().toISOString();
    await Promise.all([
      admin
        .from("analysis_jobs")
        .update({
          state: "completed",
          finished_at: finishedAt,
          error_code: null,
          model_version: servedModel,
          prompt_fingerprint: runFingerprint,
          input_evidence_count: evidence.length,
          usage,
        })
        .eq("id", job.id),
      admin.from("audit_events").insert({
        organization_id: job.organization_id,
        actor_id: user.id,
        action: "analysis.completed",
        entity_type: "analysis_job",
        entity_id: job.id,
        detail: {
          provider: "openai",
          transport: aiTransport.transport,
          model: OPENAI_MODEL,
          model_version: servedModel,
          prompt_fingerprint: runFingerprint,
          profile: job.profile,
          profile_version: job.profile_version,
          evidence_count: evidence.length,
          image_count: imageCount,
          video_frame_count: videoFrames.length,
          spherical_frame_count: sphericalFrames.length,
          anchored_observation_count: observations.filter(
            (observation) => observation.frame_anchor,
          ).length,
          suggestion_id: suggestion.id,
          agent_key: "evidence_inspector",
          collaborating_agents: ["verification_guard"],
          agent_contract_version: AGENT_CONTRACT_VERSION,
          decision_route: "copilot",
        },
      }),
    ]);

    return jsonResponse(request, {
      job_id: job.id,
      suggestion_id: suggestion.id,
      analysis,
      model: OPENAI_MODEL,
      transport: aiTransport.transport,
      analyzed_images: imageCount,
      analyzed_video_frames: videoFrames.length,
    });
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status: number }).status)
        : 500;
    const errorCode =
      typeof error === "object" && error && "errorCode" in error
        ? String((error as { errorCode: string }).errorCode)
        : status >= 500
          ? "worker_error"
          : "request_error";
    if (jobId) {
      await admin
        .from("analysis_jobs")
        .update({
          state: "failed",
          error_code: errorCode,
          finished_at: new Date().toISOString(),
        })
        .eq("id", jobId);
    }
    console.error("spatial-analyze", error);
    return jsonResponse(
      request,
      {
        error: error instanceof Error ? error.message : "Analysis failed.",
        code: errorCode,
      },
      Number.isFinite(status) ? status : 500,
    );
  }
});