import { createClient } from "npm:@supabase/supabase-js@2";
import { AGENT_CONTRACT_VERSION, FIELD_QC_WORKFLOW_INSTRUCTIONS } from "../_shared/agent-contracts.ts";
import { signedObjectReadUrl } from "../_shared/aws-object-store.ts";

const MODEL = Deno.env.get("OPENAI_FIELD_QC_MODEL") || "gpt-5-mini";
const STORAGE_BUCKET = "property-evidence";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function outputText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output as Array<Record<string, unknown>>) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (typeof part.text === "string") return part.text;
    }
  }
  throw new Error("AI returned no quality-check result");
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "retake_instruction", "checks"],
  properties: {
    verdict: { type: "string", enum: ["passed", "retake", "needs_review"] },
    summary: { type: "string" },
    retake_instruction: { type: ["string", "null"] },
    checks: {
      type: "array",
      minItems: 4,
      maxItems: 7,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "state", "note"],
        properties: {
          name: { type: "string", enum: ["task_match", "must_show", "coverage", "focus", "exposure", "orientation", "source_count"] },
          state: { type: "string", enum: ["pass", "fail", "uncertain"] },
          note: { type: "string" },
        },
      },
    },
  },
};

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const openAIKey = Deno.env.get("OPENAI_API_KEY");
  const authorization = request.headers.get("Authorization") || "";
  if (!supabaseUrl || !serviceKey) return json({ error: "Server configuration is incomplete" }, 500);
  if (authorization !== `Bearer ${serviceKey}`) return json({ error: "Internal authorization required" }, 401);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  let checkId = "";

  try {
    const body = await request.json();
    checkId = String(body?.quality_check_id || "");
    const { data: check } = await admin.from("field_quality_checks").select("*").eq("id", checkId).maybeSingle();
    if (!check) return json({ error: "Quality check not found" }, 404);
    if (!["queued", "failed"].includes(check.state)) return json({ quality_check_id: check.id, state: check.state, reused: true });

    const now = new Date().toISOString();
    await admin.from("field_quality_checks").update({ state: "processing", provider: openAIKey ? "openai" : null, model: openAIKey ? MODEL : null, started_at: now }).eq("id", check.id);
    const [{ data: assignment }, { data: task }, { data: evidence }, { data: documents }] = await Promise.all([
      admin.from("field_assignments").select("*").eq("id", check.assignment_id).single(),
      admin.from("capture_tasks").select("id, requirement_id, status").eq("id", check.capture_task_id).single(),
      admin.from("evidence_items")
        .select("id, storage_path, storage_provider, storage_bucket, original_filename, media_type, mime_type, byte_size, captured_at, source_metadata")
        .eq("field_assignment_id", check.assignment_id)
        .is("deleted_at", null)
        .in("id", check.evidence_ids),
      admin.from("project_documents")
        .select("id, storage_path, storage_provider, storage_bucket, original_filename, mime_type, byte_size, issued_at, source_metadata")
        .eq("field_assignment_id", check.assignment_id)
        .in("id", check.evidence_ids),
    ]);
    const sources = [...(evidence || []), ...(documents || [])];
    if (!assignment || !task || !sources.length) throw new Error("Quality-check sources are incomplete");
    const { data: requirement } = await admin.from("capture_requirements").select("*").eq("id", task.requirement_id).single();
    if (!requirement) throw new Error("Capture requirement not found");

    const images = sources.filter((item) => String(item.mime_type || "").startsWith("image/")).slice(0, 8);
    let result: Record<string, unknown>;
    if (!openAIKey || !images.length) {
      result = {
        verdict: "needs_review",
        summary: !openAIKey
          ? "The upload was saved, but automated visual checking is not configured. A project reviewer must inspect it."
          : "The upload contains no supported still image for automated visual checking. A project reviewer must inspect the video or document.",
        retake_instruction: null,
        checks: [
          { name: "source_count", state: sources.length ? "pass" : "fail", note: `${sources.length} source file${sources.length === 1 ? "" : "s"} received.` },
          { name: "task_match", state: "uncertain", note: "A person must confirm the task match." },
          { name: "must_show", state: "uncertain", note: "The required details could not be checked automatically." },
          { name: "coverage", state: "uncertain", note: "Coverage requires human review." },
        ],
      };
    } else {
      const content: Array<Record<string, unknown>> = [{
        type: "input_text",
        text: [
          `Assignment: ${requirement.title}`,
          `Capture method: ${requirement.capture_type}`,
          `Why: ${requirement.rationale}`,
          `Field instructions: ${JSON.stringify(requirement.instructions || [])}`,
          `Must show: ${JSON.stringify(requirement.must_show || [])}`,
          `Acceptance criteria: ${JSON.stringify(requirement.acceptance_criteria || [])}`,
          `Evidence manifest: ${JSON.stringify(sources.map((item) => ({ id: item.id, filename: item.original_filename, mime_type: item.mime_type, bytes: item.byte_size })))}`,
          "Determine only whether these captures are operationally usable for this assignment.",
        ].join("\n"),
      }];
      let signedCount = 0;
      for (const item of images) {
        let signedUrl = "";
        if (item.storage_provider === "aws-s3") {
          signedUrl = await signedObjectReadUrl(item.storage_path, 15 * 60).catch(() => "");
        } else {
          const { data: signed } = await admin.storage.from(item.storage_bucket || STORAGE_BUCKET).createSignedUrl(item.storage_path, 15 * 60);
          signedUrl = signed?.signedUrl || "";
        }
        if (!signedUrl) continue;
        content.push({ type: "input_text", text: `Evidence ${item.id} · ${item.original_filename}` });
        content.push({ type: "input_image", image_url: signedUrl, detail: "high" });
        signedCount += 1;
      }
      if (!signedCount) throw new Error("Evidence images could not be opened for quality checking");
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${openAIKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          store: false,
          instructions: FIELD_QC_WORKFLOW_INSTRUCTIONS,
          input: [{ role: "user", content }],
          text: { format: { type: "json_schema", name: "field_capture_quality_check", strict: true, schema } },
          max_output_tokens: 1500,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message || `AI quality check failed (${response.status})`);
      result = JSON.parse(outputText(payload));
    }

    const state = String(result.verdict || "needs_review");
    const assignmentStatus = state === "retake" ? "retake" : "ready_for_review";
    const taskStatus = state === "retake" ? "needs_more" : "submitted";
    const completedAt = new Date().toISOString();
    await Promise.all([
      admin.from("field_quality_checks").update({ state, result, completed_at: completedAt }).eq("id", check.id),
      admin.from("field_assignments").update({ status: assignmentStatus, updated_at: completedAt }).eq("id", assignment.id),
      admin.from("capture_tasks").update({ status: taskStatus, reviewer_note: state === "retake" ? String(result.retake_instruction || result.summary || "Retake requested") : null, updated_at: completedAt }).eq("id", task.id),
      admin.from("field_assignment_events").insert({ organization_id: check.organization_id, assignment_id: assignment.id, event_type: `quality_check.${state}`, detail: { quality_check_id: check.id, summary: result.summary } }),
      admin.from("audit_events").insert({ organization_id: check.organization_id, actor_id: null, action: `field_quality_check.${state}`, entity_type: "field_quality_check", entity_id: check.id, detail: { capture_task_id: task.id, evidence_ids: check.evidence_ids, agent_key: "field_qc", agent_contract_version: AGENT_CONTRACT_VERSION } }),
    ]);
    return json({ quality_check_id: check.id, state, result });
  } catch (error) {
    console.error("field-quality-check", error);
    if (checkId) {
      const { data: check } = await admin.from("field_quality_checks").select("assignment_id").eq("id", checkId).maybeSingle();
      await admin.from("field_quality_checks").update({ state: "failed", result: { error: error instanceof Error ? error.message : "Quality check failed" }, completed_at: new Date().toISOString() }).eq("id", checkId);
      if (check?.assignment_id) await admin.from("field_assignments").update({ status: "ready_for_review", updated_at: new Date().toISOString() }).eq("id", check.assignment_id);
    }
    return json({ error: error instanceof Error ? error.message : "Quality check failed" }, 500);
  }
});
