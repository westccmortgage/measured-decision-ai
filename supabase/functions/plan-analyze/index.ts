import { createClient } from "npm:@supabase/supabase-js@2";
import {
  AGENT_CONTRACT_VERSION,
  PLAN_WORKFLOW_INSTRUCTIONS,
} from "../_shared/agent-contracts.ts";
import { signedObjectReadUrl } from "../_shared/aws-object-store.ts";
import { openAITransport } from "../_shared/openai-transport.ts";

const allowedOrigins = new Set([
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
      : "https://measureddecision.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
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
    "project_summary", "source_register", "levels", "spaces", "space_links", "framing_walls", "systems",
    "phases", "capture_requirements", "gaps", "assumptions",
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

async function finalizeAnalysis(
  admin: ReturnType<typeof createClient>,
  job: PlanJob,
  documents: DocumentRow[],
  analysis: Record<string, any>,
  model: string,
  userId: string,
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
        model,
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
        model,
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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const model = Deno.env.get("OPENAI_PLAN_MODEL") || Deno.env.get("OPENAI_MODEL") || "gpt-5.6-sol";
  let aiTransport: ReturnType<typeof openAITransport>;
  try {
    aiTransport = openAITransport();
  } catch {
    return json(request, { error: "Server configuration is incomplete" }, 500);
  }
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
    if (!jobId) return json(request, { error: "job_id is required" }, 400);

    const { data: jobRow, error: jobError } = await userClient
      .from("plan_analysis_jobs")
      .select("id, organization_id, property_id, document_ids, state, requested_by, provider, provider_job_id, model, baseline_id, progress_stage, progress_percent, started_at, completed_at, error_code, error_message")
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

      const providerResponse = await fetch(`${aiTransport.baseUrl}/responses/${encodeURIComponent(job.provider_job_id)}`, {
        headers: aiTransport.headers,
      });
      const providerPayload = await providerResponse.json();
      if (!providerResponse.ok) throw new Error(providerError(providerPayload, `Could not read background response (${providerResponse.status})`));
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
        throw new Error(providerError(providerPayload, `Background response ended with ${providerPayload.status || "an unknown status"}`));
      }

      const { data: documents, error: documentError } = await userClient
        .from("project_documents")
        .select("id, organization_id, property_id, storage_path, storage_provider, storage_bucket, original_filename, byte_size, document_type, revision_label, issued_at")
        .in("id", job.document_ids)
        .eq("organization_id", job.organization_id)
        .eq("property_id", job.property_id);
      if (documentError || !documents || documents.length !== job.document_ids.length) {
        throw new Error("One or more project documents are missing or outside this project");
      }
      const analysis = JSON.parse(responseText(providerPayload));
      const result = await finalizeAnalysis(admin, job, documents as DocumentRow[], analysis, job.model || model, userData.user.id);
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
      .select("id, organization_id, property_id, storage_path, storage_provider, storage_bucket, original_filename, byte_size, document_type, revision_label, issued_at")
      .in("id", job.document_ids)
      .eq("organization_id", job.organization_id)
      .eq("property_id", job.property_id);
    if (documentError || !documents || documents.length !== job.document_ids.length) {
      throw new Error("One or more project documents are missing or outside this project");
    }
    const totalBytes = (documents as DocumentRow[]).reduce((sum, item) => sum + Number(item.byte_size || 0), 0);
    const oversized = (documents as DocumentRow[]).find((item) => Number(item.byte_size || 0) > 49 * 1024 * 1024);
    if (oversized || totalBytes > 49 * 1024 * 1024) {
      throw new Error(
        oversized
          ? `${oversized.original_filename} exceeds the 49 MB AI input limit. Keep the original in Studio and upload an optimized PDF copy for analysis.`
          : "The selected plan set exceeds the 49 MB combined AI input limit. Analyze smaller discipline sets or upload optimized PDF copies.",
      );
    }

    const startedAt = new Date().toISOString();
    await admin.from("plan_analysis_jobs").update({
      state: "processing", provider: "openai", provider_job_id: null, model,
      progress_stage: "securing_sources", progress_percent: 8,
      started_at: startedAt, completed_at: null, last_heartbeat_at: startedAt,
      error_code: null, error_message: null,
    }).eq("id", job.id);
    await admin.from("project_documents").update({
      status: "processing", processing_error: null, updated_at: new Date().toISOString(),
    }).in("id", job.document_ids);
    await admin.from("properties").update({ workflow_state: "analyzing_plans" }).eq("id", job.property_id);

    const signedDocuments: Array<{ row: DocumentRow; url: string }> = [];
    for (const row of documents as DocumentRow[]) {
      if (row.storage_provider === "aws-s3") {
        signedDocuments.push({ row, url: await signedObjectReadUrl(row.storage_path, 3600) });
      } else {
        const { data: signed, error: signedError } = await admin.storage
          .from(row.storage_bucket || "project-documents")
          .createSignedUrl(row.storage_path, 3600);
        if (signedError || !signed?.signedUrl) throw new Error(`Could not read ${row.original_filename}`);
        signedDocuments.push({ row, url: signed.signedUrl });
      }
    }

    const register = signedDocuments.map(({ row }) => ({
      id: row.id,
      filename: row.original_filename,
      document_type: row.document_type,
      revision: row.revision_label,
      issued_at: row.issued_at,
    }));
    const userContent: Array<Record<string, unknown>> = [
      {
        type: "input_text",
        text: `Analyze this project document set. Database source register:\n${JSON.stringify(register, null, 2)}`,
      },
      ...signedDocuments.map(({ url }) => ({
        type: "input_file",
        file_url: url,
      })),
    ];

    const openAIResponse = await fetch(`${aiTransport.baseUrl}/responses`, {
      method: "POST",
      headers: aiTransport.headers,
      body: JSON.stringify({
        model,
        background: true,
        store: true,
        input: [
          { role: "system", content: [{ type: "input_text", text: PLAN_WORKFLOW_INSTRUCTIONS }] },
          { role: "user", content: userContent },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "construction_plan_baseline",
            strict: true,
            schema,
          },
        },
      }),
    });
    const openAIPayload = await openAIResponse.json();
    if (!openAIResponse.ok) {
      const message = openAIPayload?.error?.message || `OpenAI request failed (${openAIResponse.status})`;
      throw new Error(message);
    }
    if (!openAIPayload?.id) throw new Error("OpenAI did not return a background response identifier");
    const acceptedAt = new Date().toISOString();
    await admin.from("plan_analysis_jobs").update({
      provider_job_id: openAIPayload.id,
      progress_stage: openAIPayload.status === "queued" ? "provider_queued" : "reading_documents",
      progress_percent: openAIPayload.status === "queued" ? 18 : 32,
      last_heartbeat_at: acceptedAt,
    }).eq("id", job.id);
    return json(request, {
      job_id: job.id,
      state: "processing",
      progress_stage: openAIPayload.status === "queued" ? "provider_queued" : "reading_documents",
      progress_percent: openAIPayload.status === "queued" ? 18 : 32,
    }, 202);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Plan analysis failed";
    if (job) await markJobFailed(admin, job, message);
    const status = /quota|rate limit/i.test(message) ? 429 : 500;
    return json(request, { error: message, job_id: job?.id || null }, status);
  }
});