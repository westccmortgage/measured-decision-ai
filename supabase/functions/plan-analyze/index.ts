import { createClient } from "npm:@supabase/supabase-js@2";
import {
  AGENT_CONTRACT_VERSION,
  PLAN_WORKFLOW_INSTRUCTIONS,
} from "../_shared/agent-contracts.ts";

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
    "project_summary", "source_register", "levels", "spaces", "systems",
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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const openAIKey = Deno.env.get("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_PLAN_MODEL") || Deno.env.get("OPENAI_MODEL") || "gpt-5.6-sol";
  if (!supabaseUrl || !anonKey || !serviceKey || !openAIKey) {
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

  let jobId = "";
  let createdBaselineId = "";
  try {
    const body = await request.json();
    jobId = safeText(body?.job_id, "");
    if (!jobId) return json(request, { error: "job_id is required" }, 400);

    const { data: job, error: jobError } = await userClient
      .from("plan_analysis_jobs")
      .select("id, organization_id, property_id, document_ids, state, requested_by")
      .eq("id", jobId)
      .single();
    if (jobError || !job) return json(request, { error: "Analysis job not found" }, 404);
    if (!["queued", "failed"].includes(job.state)) {
      return json(request, { error: `Job cannot run from state ${job.state}` }, 409);
    }

    const { data: membership } = await userClient
      .from("organization_members")
      .select("role")
      .eq("organization_id", job.organization_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!membership || !["owner", "admin", "reviewer", "contributor"].includes(membership.role)) {
      return json(request, { error: "Not authorized for plan analysis" }, 403);
    }

    const { data: documents, error: documentError } = await userClient
      .from("project_documents")
      .select("id, organization_id, property_id, storage_path, original_filename, byte_size, document_type, revision_label, issued_at")
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

    await admin.from("plan_analysis_jobs").update({
      state: "processing", provider: "openai", model, started_at: new Date().toISOString(),
      error_code: null, error_message: null,
    }).eq("id", jobId);
    await admin.from("project_documents").update({
      status: "processing", processing_error: null, updated_at: new Date().toISOString(),
    }).in("id", job.document_ids);
    await admin.from("properties").update({ workflow_state: "analyzing_plans" }).eq("id", job.property_id);

    const signedDocuments: Array<{ row: DocumentRow; url: string }> = [];
    for (const row of documents as DocumentRow[]) {
      const { data: signed, error: signedError } = await admin.storage
        .from("project-documents")
        .createSignedUrl(row.storage_path, 900);
      if (signedError || !signed?.signedUrl) throw new Error(`Could not read ${row.original_filename}`);
      signedDocuments.push({ row, url: signed.signedUrl });
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

    const openAIResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${openAIKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
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
    const analysis = JSON.parse(responseText(openAIPayload));
    if (!Array.isArray(analysis.phases) || !analysis.phases.length) {
      throw new Error("The supplied documents did not support a construction evidence phase. Add the governing plan sheets and retry.");
    }
    if (!Array.isArray(analysis.capture_requirements) || !analysis.capture_requirements.length) {
      throw new Error("The supplied documents did not support an actionable capture roadmap. Add the governing plan sheets and retry.");
    }

    const validDocumentIds = new Set((documents as DocumentRow[]).map((item) => item.id));
    for (const requirement of analysis.capture_requirements) {
      requirement.source_document_ids = requirement.source_document_ids.filter((id: string) => validDocumentIds.has(id));
      if (!requirement.source_document_ids.length) requirement.source_document_ids = [...validDocumentIds];
    }

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
        created_by: userData.user.id,
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
    const spaceKey = (building: unknown, level: unknown, name: unknown) =>
      `${safeText(building, "").toLowerCase()}|${safeText(level, "").toLowerCase()}|${safeText(name, "").toLowerCase()}`;
    const spaceByKey = new Map((insertedSpaces || []).map((space) => [spaceKey(space.building, space.level, space.name), space.id]));

    const requirementRows = analysis.capture_requirements.flatMap((requirement: Record<string, unknown>) => {
      const phaseId = phaseByCode.get(requirement.phase_code);
      if (!phaseId) return [];
      const planSpaceId = requirement.space_name
        ? spaceByKey.get(spaceKey(requirement.building, requirement.level, requirement.space_name)) || null
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

    const completedAt = new Date().toISOString();
    await admin.from("plan_analysis_jobs").update({
      state: "completed", baseline_id: baseline.id, completed_at: completedAt,
    }).eq("id", jobId);
    await admin.from("project_documents").update({ status: "ready", updated_at: completedAt }).in("id", job.document_ids);
    await admin.from("properties").update({ workflow_state: "baseline_review" }).eq("id", job.property_id);
    await admin.from("audit_events").insert({
      organization_id: job.organization_id,
      actor_id: userData.user.id,
      action: "plan_analysis.completed",
      entity_type: "document_baseline",
      entity_id: baseline.id,
      detail: {
        property_id: job.property_id,
        version,
        document_ids: job.document_ids,
        model,
        agent_key: "plan_interpreter",
        collaborating_agents: ["document_controller", "capture_planner", "verification_guard"],
        agent_contract_version: AGENT_CONTRACT_VERSION,
        decision_route: "copilot",
      },
    });
    createdBaselineId = "";
    return json(request, { job_id: jobId, baseline_id: baseline.id, version, state: "completed" });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Plan analysis failed";
    if (jobId) {
      if (createdBaselineId) {
        await admin.from("document_baselines").delete().eq("id", createdBaselineId);
      }
      await admin.from("plan_analysis_jobs").update({
        state: "failed", error_code: "plan_analysis_failed", error_message: message,
        completed_at: new Date().toISOString(),
      }).eq("id", jobId);
      const { data: failedJob } = await admin.from("plan_analysis_jobs").select("property_id, document_ids").eq("id", jobId).maybeSingle();
      if (failedJob) {
        const retryableInput = /49 MB|input limit/i.test(message);
        await admin.from("project_documents").update({
          status: retryableInput ? "uploaded" : "failed",
          processing_error: message,
          updated_at: new Date().toISOString(),
        }).in("id", failedJob.document_ids);
        await admin.from("properties").update({ workflow_state: "intake" }).eq("id", failedJob.property_id);
      }
    }
    const status = /quota|rate limit/i.test(message) ? 429 : 500;
    return json(request, { error: message, job_id: jobId || null }, status);
  }
});
