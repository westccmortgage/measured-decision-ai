import { createClient } from "npm:@supabase/supabase-js@2";
import { AGENT_CONTRACT_VERSION, FIELD_QC_WORKFLOW_INSTRUCTIONS } from "../_shared/agent-contracts.ts";
import { claimAiRun, finishAiRun, RunProgress, outcomeForStatus, usageFrom } from "../_shared/ai-run-ledger.ts";
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
  let runId: string | null = null;
  /* Nothing sent yet, so a failure so far costs nothing. */
  const progress = new RunProgress();
  let runUsage: Record<string, unknown> = {};

  try {
    const body = await request.json();
    checkId = String(body?.quality_check_id || "");
    const { data: check } = await admin.from("field_quality_checks").select("*").eq("id", checkId).maybeSingle();
    if (!check) return json({ error: "Quality check not found" }, 404);
    /* 'outcome_unknown' is re-enterable on purpose: this is the door a
       reviewer's confirmation comes through. Whether the reading may actually
       be bought again is decided below by the ledger, never here. */
    if (!["queued", "failed", "outcome_unknown"].includes(check.state)) {
      return json({ quality_check_id: check.id, state: check.state, reused: true });
    }

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

    /* What a finished check does to the assignment and the task — one place,
       because a result that was already bought for these exact files must do
       exactly what a fresh one would. */
    async function applyResult(verdictResult: Record<string, unknown>, options: { reusedFrom: string | null }) {
      const state = String(verdictResult.verdict || "needs_review");
      const assignmentStatus = state === "retake" ? "retake" : "ready_for_review";
      const taskStatus = state === "retake" ? "needs_more" : "submitted";
      const completedAt = new Date().toISOString();
      await Promise.all([
        admin.from("field_quality_checks").update({ state, result: verdictResult, completed_at: completedAt }).eq("id", check.id),
        admin.from("field_assignments").update({ status: assignmentStatus, updated_at: completedAt }).eq("id", assignment.id),
        admin.from("capture_tasks").update({ status: taskStatus, reviewer_note: state === "retake" ? String(verdictResult.retake_instruction || verdictResult.summary || "Retake requested") : null, updated_at: completedAt }).eq("id", task.id),
        admin.from("field_assignment_events").insert({ organization_id: check.organization_id, assignment_id: assignment.id, event_type: `quality_check.${state}`, detail: { quality_check_id: check.id, summary: verdictResult.summary, reused_from: options.reusedFrom } }),
        admin.from("audit_events").insert({ organization_id: check.organization_id, actor_id: null, action: `field_quality_check.${state}`, entity_type: "field_quality_check", entity_id: check.id, detail: { capture_task_id: task.id, evidence_ids: check.evidence_ids, agent_key: "field_qc", agent_contract_version: AGENT_CONTRACT_VERSION, reused_from: options.reusedFrom } }),
      ]);
      return state;
    }

    /* The three ways a check ends without a reading, each with a row state a
       person can read and a way forward. None of them leaves the row in
       'processing', and none of them queues anything. */
    async function settleWithoutReading(rowState: "outcome_unknown" | "failed" | "needs_review", summary: string, aiRunId: string | null) {
      const completedAt = new Date().toISOString();
      await Promise.all([
        admin.from("field_quality_checks").update({
          state: rowState,
          result: { verdict: rowState === "needs_review" ? "needs_review" : null, summary, retake_instruction: null, checks: [] },
          ai_run_id: aiRunId,
          completed_at: completedAt,
        }).eq("id", check.id),
        /* A person can always review by eye. What they cannot do is wait on a
           check that will never finish. */
        admin.from("field_assignments").update({ status: "ready_for_review", updated_at: completedAt }).eq("id", assignment.id),
        admin.from("field_assignment_events").insert({ organization_id: check.organization_id, assignment_id: assignment.id, event_type: `quality_check.${rowState}`, detail: { quality_check_id: check.id, summary, ai_run_id: aiRunId } }),
      ]);
    }

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
      /* This worker talks to OpenAI directly rather than through the shared
         transport, so its transport is named here by hand — a ledger that
         guessed the wire would reconcile against the wrong invoice. */
      const claim = await claimAiRun(admin, {
        organizationId: check.organization_id,
        propertyId: assignment?.property_id || null,
        processKey: "field-quality-check",
        model: MODEL,
        contractVersion: AGENT_CONTRACT_VERSION,
        inputs: (evidence || []).map((item: { id: string; byte_size?: number | null }) => `${item.id}@${item.byte_size ?? ""}`),
        requirements: [task?.requirement_id ? String(task.requirement_id) : ""],
        settings: { assignment: check.assignment_id, capture_task: check.capture_task_id },
        jobTable: "field_quality_checks",
        jobId: check.id,
        transport: "openai_direct",
      });
      if (claim.verdict === "RUNNING") {
        /* Another instance holds this exact check and will finish the row.
           Leaving 'processing' is correct here and only here. */
        return json({ quality_check_id: check.id, state: "processing", skipped: "running" });
      }
      if (claim.verdict === "REUSED") {
        /* Bought already, for these exact files. Use that answer — as the
           row's own result, with the assignment moved exactly as a fresh
           result would move it. */
        const { data: earlier } = await admin.from("field_quality_checks")
          .select("id, state, result, evidence_ids")
          .eq("assignment_id", check.assignment_id)
          .in("state", ["passed", "retake", "needs_review"])
          .neq("id", check.id)
          .order("completed_at", { ascending: false })
          .limit(5);
        const sameFiles = (earlier || []).find((row) =>
          JSON.stringify([...(row.evidence_ids || [])].sort()) === JSON.stringify([...(check.evidence_ids || [])].sort()));
        if (sameFiles?.result && typeof sameFiles.result === "object") {
          await admin.from("field_quality_checks").update({ ai_run_id: claim.previousRunId }).eq("id", check.id);
          const state = await applyResult(sameFiles.result as Record<string, unknown>, { reusedFrom: sameFiles.id });
          return json({ quality_check_id: check.id, state, result: sameFiles.result, reused_from: sameFiles.id });
        }
        /* The ledger says a reading was bought, and its saved copy is not on
           file. That is a lost SAVE, not a lost reading — so it is not bought
           again; a person inspects instead. */
        await settleWithoutReading("needs_review",
          "An earlier automated check of these files completed, but its result is not on file. A project reviewer must inspect the upload.",
          claim.previousRunId);
        return json({ quality_check_id: check.id, state: "needs_review", skipped: "reused" });
      }
      if (claim.verdict === "UNKNOWN") {
        /* An earlier attempt at this exact check went out and nobody can say
           what happened to it. It is not queued, not retried, not hidden: the
           row says so, the assignment goes to a person, and the reviewer can
           authorise one repeat from the field screen. */
        await settleWithoutReading("outcome_unknown",
          "An earlier automated check of these files may have run and been billed, and its answer was not received. A reviewer can confirm a repeat, or review the upload by eye.",
          claim.previousRunId);
        return json({ quality_check_id: check.id, state: "outcome_unknown", skipped: "outcome_unknown", unresolved_run_id: claim.previousRunId });
      }
      runId = claim.runId;
      /* Recorded before the call, so a worker that dies mid-flight still
         leaves the row pointing at the run a reviewer would decide about. */
      await admin.from("field_quality_checks").update({ ai_run_id: runId }).eq("id", check.id);
      progress.sent();
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
      runUsage = usageFrom(payload);
      if (!response.ok) {
        /* A rejected request cost nothing; a 5xx or a rate limit may have
           arrived after the reading was made. */
        if (outcomeForStatus(response.status) === "failed") progress.refused();
        throw new Error(payload?.error?.message || `AI quality check failed (${response.status})`);
      }
      result = JSON.parse(outputText(payload));
      /* Bought and in hand. Everything after this is recording, and a failure
         to record must never license a second purchase. */
      progress.answered();
    }

    const state = await applyResult(result, { reusedFrom: null });
    await finishAiRun(admin, runId, progress.outcome(), runUsage, null);
    return json({ quality_check_id: check.id, state, result });
  } catch (error) {
    console.error("field-quality-check", error);
    await finishAiRun(admin, runId, progress.outcome(), runUsage,
      String(error instanceof Error ? error.message : error).slice(0, 200));
    if (checkId) {
      const { data: check } = await admin.from("field_quality_checks").select("assignment_id").eq("id", checkId).maybeSingle();
      /* Same distinction as the ledger's: a request that never got its answer
         may have been billed, and the row must say so rather than 'failed' —
         because 'failed' is free to repeat and this is not. */
      const lost = progress.outcome() === "outcome_unknown";
      const message = error instanceof Error ? error.message : "Quality check failed";
      await admin.from("field_quality_checks").update({
        state: lost ? "outcome_unknown" : "failed",
        result: lost
          ? { verdict: null, summary: `The automated check was sent and its answer was not received (${message}). It may have run and been billed; a reviewer can confirm a repeat or review the upload by eye.`, retake_instruction: null, checks: [] }
          : { error: message },
        ai_run_id: runId,
        completed_at: new Date().toISOString(),
      }).eq("id", checkId);
      if (check?.assignment_id) await admin.from("field_assignments").update({ status: "ready_for_review", updated_at: new Date().toISOString() }).eq("id", check.assignment_id);
    }
    return json({ error: error instanceof Error ? error.message : "Quality check failed" }, 500);
  }
});
