import { createClient } from "npm:@supabase/supabase-js@2";
import {
  AGENT_CONTRACT_VERSION,
  EVIDENCE_WORKFLOW_INSTRUCTIONS,
} from "../_shared/agent-contracts.ts";

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
    });
  }
  return frames;
}

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

function analysisSchema(evidenceIds: string[]) {
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
          },
          required: ["text", "category", "evidence_ids", "confidence"],
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
    },
    required: [
      "summary",
      "capture_quality",
      "visible_observations",
      "not_established",
      "follow_up_captures",
      "limitations",
    ],
    additionalProperties: false,
  };
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
  const openAIKey = Deno.env.get("OPENAI_API_KEY");
  const authorization = request.headers.get("Authorization");
  if (
    !supabaseUrl ||
    !publishableKey ||
    !serviceRoleKey ||
    !openAIKey ||
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
          "id, storage_path, original_filename, media_type, mime_type, byte_size, captured_at, source_metadata",
        )
        .eq("organization_id", job.organization_id)
        .eq("property_id", job.property_id)
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
    content.push({
      type: "input_text",
      text: [
        `Property: ${property?.name || job.property_id}`,
        `Room: ${space?.name || "Unspecified space"}`,
        `Location: ${space?.building || "Property"} · ${space?.level || "Unspecified level"}`,
        `Processing profile: ${job.profile} v${job.profile_version}`,
        `Evidence manifest: ${JSON.stringify(evidenceManifest)}`,
        "Analyze only the visual material that follows. Every visible observation must cite one or more exact evidence IDs from the manifest.",
      ].join("\n"),
    });

    let imageCount = 0;
    for (const item of evidence) {
      if (!item.mime_type.startsWith("image/")) continue;
      if (imageCount >= MAX_IMAGE_INPUTS) break;
      const { data: signed, error: signedError } = await admin.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(item.storage_path, 15 * 60);
      if (signedError || !signed?.signedUrl) continue;
      content.push({
        type: "input_text",
        text: `Evidence image ${item.id} · ${item.original_filename}`,
      });
      content.push({
        type: "input_image",
        image_url: signed.signedUrl,
        detail: "high",
      });
      imageCount += 1;
    }
    for (const frame of videoFrames) {
      const source = evidenceById.get(frame.evidence_id);
      content.push({
        type: "input_text",
        text: `Video frame from evidence ${frame.evidence_id} · ${source?.original_filename || "video"} · ${frame.timestamp_seconds.toFixed(1)} seconds`,
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

    const openAIResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAIKey}`,
        "Content-Type": "application/json",
      },
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
            schema: analysisSchema(job.evidence_ids),
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
    const analysis = JSON.parse(outputText(openAIPayload)) as Record<
      string,
      unknown
    >;
    const observations =
      (analysis.visible_observations as Array<Record<string, unknown>>) || [];
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
        body: analysis,
        evidence_ids: job.evidence_ids,
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

    const finishedAt = new Date().toISOString();
    await Promise.all([
      admin
        .from("analysis_jobs")
        .update({
          state: "completed",
          finished_at: finishedAt,
          error_code: null,
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
          model: OPENAI_MODEL,
          profile: job.profile,
          profile_version: job.profile_version,
          evidence_count: evidence.length,
          image_count: imageCount,
          video_frame_count: videoFrames.length,
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
